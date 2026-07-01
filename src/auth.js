// ---------------------------------------------------------------------------
// auth.js — username/password authentication, hardened for internet exposure.
//
// Design (dependency-free; uses only Node's built-in `crypto` + `fs`):
//   • Passwords  : scrypt (memory-hard KDF) + per-user 16-byte random salt;
//                  params are stored in the hash string so they can evolve.
//   • Sessions   : opaque 256-bit random tokens, stored SERVER-SIDE in memory
//                  (no JWT, no signing secret to leak). Sliding expiry.
//   • Cookies    : HttpOnly, SameSite=Strict, Secure (when behind HTTPS).
//   • Brute force: per-IP and per-IP+username lockout with exponential backoff.
//   • First run  : a one-time SETUP CODE is printed to the server console and
//                  required to create the first admin — so an attacker who can
//                  reach the public URL still cannot seize the empty instance.
//   • Enumeration: login is timing-equalised (a dummy hash runs when the user
//                  is unknown) and always returns the same generic error.
//
// Users persist to a gitignored JSON file; sessions are in-memory (a restart
// logs everyone out, which is acceptable and arguably safer for a demo).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', '.auth');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COOKIE_NAME = 'sid';

const ADMIN_USERNAME = normalize(process.env.ADMIN_USERNAME || 'admin');
const MIN_PASSWORD_LEN = Math.max(8, Number(process.env.MIN_PASSWORD_LEN) || 10);
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 8) * 3600 * 1000;           // idle (sliding) timeout
const SESSION_ABSOLUTE_TTL_MS = (Number(process.env.SESSION_ABSOLUTE_TTL_HOURS) || 24) * 3600 * 1000; // hard cap regardless of activity
const MAX_SESSIONS_PER_USER = Math.max(1, Number(process.env.MAX_SESSIONS_PER_USER) || 10);  // bounds memory + stale tokens
// Per-user daily comparison-run quota (abuse guardrail). 0 = unlimited. Admins exempt by default.
const MAX_RUNS_PER_DAY = Math.max(0, Number(process.env.MAX_RUNS_PER_DAY) === 0 ? 0 : (Number(process.env.MAX_RUNS_PER_DAY) || 20));
const RATE_EXEMPT_ADMINS = process.env.RATE_LIMIT_EXEMPT_ADMINS !== '0';

// scrypt cost params. N=2^15 ⇒ ~32MB per hash; bump maxmem so it doesn't throw.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

// Brute-force policy.
const RL_MAX_FAILS = Math.max(3, Number(process.env.LOGIN_MAX_FAILS) || 5);
const RL_BASE_LOCK_MS = 30 * 1000;
const RL_MAX_LOCK_MS = 15 * 60 * 1000;

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
// Reserved names that would collide with Object internals (prototype pollution).
const RESERVED_USERNAMES = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'toString', 'valueof']);
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'iloveyou', 'admin123', 'administrator', 'letmein123',
  'welcome1', 'changeme', 'password123', 'adminadmin',
]);

let users = loadUsers();                 // { [username]: { username, role, hash, createdAt } }
// Safe own-property lookup (never walks the prototype chain → no '__proto__' games).
function ownUser(uname) { return Object.prototype.hasOwnProperty.call(users, uname) ? users[uname] : undefined; }
const sessions = new Map();              // token -> { username, role, createdAt, expiresAt }
const loginAttempts = new Map();         // key -> { fails, lockedUntil, last }

// A real scrypt hash of a random string, so authenticate() does equal work when
// the username is unknown (defeats timing-based user enumeration).
const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(24).toString('hex'));

// First-run setup code (printed to console by server.js). Required to create the
// first admin. An operator-supplied SETUP_CODE env takes precedence.
let SETUP_CODE = process.env.SETUP_CODE ? String(process.env.SETUP_CODE) : null;

// ---------- helpers ----------
function normalize(u) { return String(u == null ? '' : u).trim().toLowerCase(); }

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    // Rebuild from own keys only, skipping anything that isn't a valid, non-reserved
    // username with a hash — defends against a tampered file (e.g. a "__proto__" key).
    const clean = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (USERNAME_RE.test(k) && !RESERVED_USERNAMES.has(k) && v && typeof v.hash === 'string') {
        clean[k] = { username: k, role: v.role === 'admin' ? 'admin' : 'user', hash: v.hash, createdAt: v.createdAt || new Date().toISOString() };
      }
    }
    return clean;
  } catch (e) { return {}; }
}

function saveUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE); // atomic replace
}

// ---------- password hashing (scrypt) ----------
function scryptSync(password, salt, keylen) {
  return crypto.scryptSync(password, salt, keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
}
function scryptAsync(password, salt, keylen, params) {
  const p = params || SCRYPT;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem }, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const dk = scryptSync(password, salt, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(password, salt, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}
async function verifyHash(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = await scryptAsync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch (e) { return false; }
}

// ---------- break-glass bootstrap admin ----------
// If ADMIN_BOOTSTRAP_PASSWORD is set (e.g. injected from Secret Manager on Cloud
// Run), (re)create a durable admin account on EVERY startup. Because it is
// re-seeded from the secret each boot, it survives the ephemeral container
// filesystem — so there is always a username/password way in even if Google
// sign-in is unavailable or your account is locked out. Dormant (no effect)
// unless the env var is set, so local dev / the first-run setup flow is unchanged.
(function ensureBootstrapAdmin() {
  const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!pw) return;
  const uname = normalize(process.env.ADMIN_BOOTSTRAP_USERNAME || ADMIN_USERNAME);
  if (!USERNAME_RE.test(uname) || RESERVED_USERNAMES.has(uname)) {
    console.warn('[auth] ADMIN_BOOTSTRAP_USERNAME is invalid — break-glass admin skipped.');
    return;
  }
  if (String(pw).length < MIN_PASSWORD_LEN) {
    console.warn(`[auth] ADMIN_BOOTSTRAP_PASSWORD is shorter than ${MIN_PASSWORD_LEN} chars — break-glass admin skipped.`);
    return;
  }
  try {
    const existing = ownUser(uname);
    users[uname] = {
      username: uname, role: 'admin', hash: hashPasswordSync(String(pw)),
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    };
    console.log(`[auth] break-glass admin "${uname}" ensured from ADMIN_BOOTSTRAP_PASSWORD.`);
  } catch (e) {
    console.warn('[auth] break-glass admin seeding failed:', (e && e.message) || e);
  }
})();

// ---------- validation ----------
function validateUsername(username) {
  const u = normalize(username);
  if (!u) return 'Username is required.';
  if (!USERNAME_RE.test(u)) return 'Username must be 3–32 chars: letters, digits, dot, dash or underscore.';
  if (RESERVED_USERNAMES.has(u)) return 'That username is reserved. Choose another.';
  return null;
}
function validatePassword(password, username) {
  const pw = String(password == null ? '' : password);
  if (pw.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  if (pw.length > 200) return 'Password is too long (max 200).';
  if (username && pw.toLowerCase() === normalize(username)) return 'Password must not equal the username.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common. Choose a stronger one.';
  return null;
}

// ---------- users ----------
function setupRequired() { return Object.keys(users).length === 0; }
function userExists(username) { return !!ownUser(normalize(username)); }

async function createUser(username, password, role) {
  const uname = normalize(username);
  const uErr = validateUsername(uname); if (uErr) throw new Error(uErr);
  const pErr = validatePassword(password, uname); if (pErr) throw new Error(pErr);
  if (ownUser(uname)) throw new Error('That username already exists.');
  const hash = await hashPassword(password);
  users[uname] = { username: uname, role: role === 'admin' ? 'admin' : 'user', hash, createdAt: new Date().toISOString() };
  saveUsers();
  return publicUser(users[uname]);
}

let setupInProgress = false;
async function setupAdmin(password) {
  // Synchronous TOCTOU guard: set before the first await so two concurrent setup
  // requests can't both slip past the setupRequired() check and create an admin.
  if (!setupRequired() || setupInProgress) throw new Error('Setup already completed.');
  const pErr = validatePassword(password, ADMIN_USERNAME); if (pErr) throw new Error(pErr);
  setupInProgress = true;
  try {
    const hash = await hashPassword(password);
    users[ADMIN_USERNAME] = { username: ADMIN_USERNAME, role: 'admin', hash, createdAt: new Date().toISOString() };
    saveUsers();
    SETUP_CODE = null; // burn the one-time code
    return publicUser(users[ADMIN_USERNAME]);
  } finally {
    setupInProgress = false;
  }
}

async function authenticate(username, password) {
  const u = ownUser(normalize(username));
  if (!u) { await verifyHash(String(password || ''), DUMMY_HASH); return null; } // equalise timing
  const ok = await verifyHash(String(password || ''), u.hash);
  return ok ? publicUser(u) : null;
}

async function changePassword(username, currentPassword, newPassword) {
  const u = ownUser(normalize(username));
  if (!u) throw new Error('User not found.');
  const ok = await verifyHash(String(currentPassword || ''), u.hash);
  if (!ok) throw new Error('Current password is incorrect.');
  const pErr = validatePassword(newPassword, u.username); if (pErr) throw new Error(pErr);
  u.hash = await hashPassword(newPassword);
  saveUsers();
  destroyUserSessions(u.username); // a password change revokes every existing session (incl. any stolen one)
  return true;
}

function deleteUser(target, actorUsername) {
  const t = normalize(target);
  const tu = ownUser(t);
  if (!tu) throw new Error('User not found.');
  if (t === normalize(actorUsername)) throw new Error('You cannot delete your own account.');
  const admins = Object.values(users).filter((x) => x.role === 'admin');
  if (tu.role === 'admin' && admins.length <= 1) throw new Error('Cannot delete the last admin.');
  delete users[t];
  saveUsers();
  destroyUserSessions(t); // log the deleted user out everywhere
  return true;
}

function publicUser(u) { return { username: u.username, role: u.role, createdAt: u.createdAt }; }
function listUsers() {
  return Object.values(users)
    .map(publicUser)
    .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1));
}

// ---------- sessions ----------
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // `external` sessions are for OAuth (Google) users who have no local users.json
  // record — the session carries their identity + role directly.
  sessions.set(token, { username: user.username, role: user.role, external: !!user.external, name: user.name || null, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  // Cap concurrent sessions per user (bounds memory + limits stale-token blast radius): evict oldest.
  const mine = [];
  for (const [t, s] of sessions) if (s.username === user.username) mine.push([t, s.createdAt]);
  if (mine.length > MAX_SESSIONS_PER_USER) {
    mine.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < mine.length - MAX_SESSIONS_PER_USER; i++) sessions.delete(mine[i][0]);
  }
  return token;
}
function getSessionByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }                  // idle (sliding) timeout
  if (Date.now() - s.createdAt > SESSION_ABSOLUTE_TTL_MS) { sessions.delete(token); return null; } // hard lifetime cap
  if (!s.external) {
    const u = ownUser(s.username);
    if (!u) { sessions.delete(token); return null; } // local user was deleted
    s.role = u.role;                                 // reflect current role
  } // OAuth sessions have no local record; trust the role captured at login
  s.expiresAt = Date.now() + SESSION_TTL_MS;         // sliding expiry on activity
  return s;
}
function getSession(req) { return getSessionByToken(req && req.cookies && req.cookies[COOKIE_NAME]); }
function destroySession(token) { if (token) sessions.delete(token); }
function destroyUserSessions(username) {
  const u = normalize(username);
  for (const [t, s] of sessions) if (s.username === u) sessions.delete(t);
}

// ---------- cookies ----------
function cookieParser(req, res, next) {
  req.cookies = {};
  const header = req.headers && req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && !(k in req.cookies)) { try { req.cookies[k] = decodeURIComponent(v); } catch (e) { req.cookies[k] = v; } }
      }
    }
  }
  next();
}
function isSecureReq(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  // req.secure already incorporates the trust-proxy setting (so X-Forwarded-Proto is
  // only honored when TRUST_PROXY is enabled — never trusted on direct exposure).
  return !!req.secure;
}
function setSessionCookie(req, res, token) {
  const attrs = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isSecureReq(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureReq(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// ---------- brute-force lockout ----------
function rlEntry(key) {
  let e = loginAttempts.get(key);
  if (!e) { e = { fails: 0, lockedUntil: 0, last: Date.now() }; loginAttempts.set(key, e); }
  return e;
}
function isLocked(key) { const e = loginAttempts.get(key); return !!(e && e.lockedUntil > Date.now()); }
function lockRemainingMs(key) { const e = loginAttempts.get(key); return e ? Math.max(0, e.lockedUntil - Date.now()) : 0; }
function recordFailure(key) {
  const e = rlEntry(key);
  e.fails += 1; e.last = Date.now();
  if (e.fails >= RL_MAX_FAILS) {
    const over = e.fails - RL_MAX_FAILS;
    e.lockedUntil = Date.now() + Math.min(RL_MAX_LOCK_MS, RL_BASE_LOCK_MS * Math.pow(2, over));
  }
}
function recordSuccess(key) { loginAttempts.delete(key); }

// ---------- first-run setup code ----------
function ensureSetupCode() {
  if (setupRequired() && !SETUP_CODE) {
    const hex = crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 hex chars = 64 bits
    SETUP_CODE = hex.replace(/(.{4})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4');
  }
  return setupRequired() ? SETUP_CODE : null;
}
function getSetupCode() { return setupRequired() ? SETUP_CODE : null; }
function verifySetupCode(code) {
  if (!SETUP_CODE) return false; // setup must always be gated by a code on first run
  const a = Buffer.from(String(code || '').trim().toUpperCase());
  const b = Buffer.from(SETUP_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- per-user daily run quota (abuse guardrail) ----------
const runCounts = new Map(); // `${username}|${utcDay}` -> count
function utcDay() { return new Date().toISOString().slice(0, 10); }
function nextUtcMidnightISO() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}
function exemptFromQuota(user) {
  return !MAX_RUNS_PER_DAY || (RATE_EXEMPT_ADMINS && user && user.role === 'admin');
}
// Peek at the caller's remaining quota without consuming it.
function runQuota(user) {
  if (exemptFromQuota(user)) return { limited: false, limit: MAX_RUNS_PER_DAY, remaining: Infinity };
  const used = runCounts.get(user.username + '|' + utcDay()) || 0;
  return { limited: true, limit: MAX_RUNS_PER_DAY, used, remaining: Math.max(0, MAX_RUNS_PER_DAY - used), resetAt: nextUtcMidnightISO() };
}
// Consume one run; returns {ok:false,...} when the daily limit is already reached.
function consumeRun(user) {
  if (exemptFromQuota(user)) return { ok: true, limited: false, remaining: Infinity };
  const key = user.username + '|' + utcDay();
  const used = runCounts.get(key) || 0;
  if (used >= MAX_RUNS_PER_DAY) return { ok: false, limited: true, limit: MAX_RUNS_PER_DAY, used, remaining: 0, resetAt: nextUtcMidnightISO() };
  runCounts.set(key, used + 1);
  return { ok: true, limited: true, limit: MAX_RUNS_PER_DAY, used: used + 1, remaining: MAX_RUNS_PER_DAY - (used + 1), resetAt: nextUtcMidnightISO() };
}

// ---------- periodic cleanup (bounds memory; never blocks shutdown) ----------
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expiresAt) sessions.delete(t);
  for (const [k, e] of loginAttempts) if (e.lockedUntil < now && now - e.last > 60 * 60 * 1000) loginAttempts.delete(k);
  const today = utcDay();
  for (const k of runCounts.keys()) if (!k.endsWith('|' + today)) runCounts.delete(k); // drop prior days
}, 5 * 60 * 1000).unref();

module.exports = {
  COOKIE_NAME, ADMIN_USERNAME, MIN_PASSWORD_LEN,
  // users
  setupRequired, userExists, createUser, setupAdmin, authenticate, changePassword, deleteUser, listUsers,
  // sessions
  createSession, getSession, destroySession, destroyUserSessions,
  // cookies + middleware
  cookieParser, setSessionCookie, clearSessionCookie,
  // brute force
  isLocked, lockRemainingMs, recordFailure, recordSuccess,
  // per-user daily run quota
  runQuota, consumeRun, MAX_RUNS_PER_DAY,
  // setup code
  ensureSetupCode, getSetupCode, verifySetupCode,
  // validation (exposed for reuse/tests)
  validateUsername, validatePassword,
};
