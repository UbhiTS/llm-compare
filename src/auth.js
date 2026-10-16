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
// Admin-editable daily run limits + internal (Google sign-in) admin list.
const appSettings = require('./appSettings');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', '.auth');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COOKIE_NAME = 'sid';

const ADMIN_USERNAME = normalize(process.env.ADMIN_USERNAME || 'admin');
const MIN_PASSWORD_LEN = Math.max(8, Number(process.env.MIN_PASSWORD_LEN) || 10);
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 8) * 3600 * 1000;           // idle (sliding) timeout
const SESSION_ABSOLUTE_TTL_MS = (Number(process.env.SESSION_ABSOLUTE_TTL_HOURS) || 24) * 3600 * 1000; // hard cap regardless of activity
const MAX_SESSIONS_PER_USER = Math.max(1, Number(process.env.MAX_SESSIONS_PER_USER) || 10);  // bounds memory + stale tokens
// Per-user daily OpenAI / external comparison-run quota (protects personal OpenAI API key).
// Vertex AI (Agent Platform: Gemini & Claude) runs are org-sponsored and do not consume this 3/day budget.
const MAX_OPENAI_RUNS_PER_DAY = Math.max(0, Number(process.env.MAX_OPENAI_RUNS_PER_DAY) === 0 ? 0 : (Number(process.env.MAX_OPENAI_RUNS_PER_DAY) || 3));
const MAX_RUNS_PER_DAY = MAX_OPENAI_RUNS_PER_DAY;
// Separate daily budget for re-running a SINGLE OpenAI model (the per-column "Run again").
const MAX_SINGLE_RUNS_PER_DAY = Math.max(0, Number(process.env.MAX_OPENAI_SINGLE_RUNS_PER_DAY) === 0 ? 0 : (Number(process.env.MAX_OPENAI_SINGLE_RUNS_PER_DAY) || 3));
// Legacy name kept for older call sites: the DEFAULT per-user daily Vertex AI budget. Since
// v1.0.40 it applies to every user (not just external accounts) and is editable in Settings.
const MAX_EXTERNAL_VERTEX_RUNS_PER_DAY = appSettings.DEFAULT_LIMITS.vertex;
const RATE_EXEMPT_ADMINS = process.env.RATE_LIMIT_EXEMPT_ADMINS !== '0';

// scrypt cost params. N=2^15 ⇒ ~32MB per hash; bump maxmem so it doesn't throw.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

// Brute-force policy.
const RL_MAX_FAILS = Math.max(3, Number(process.env.LOGIN_MAX_FAILS) || 5);
const RL_BASE_LOCK_MS = 30 * 1000;
const RL_MAX_LOCK_MS = 15 * 60 * 1000;

const USERNAME_RE = /^(?:[a-z0-9._-]{3,32}|(?=.{3,128}$)[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;
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

// Returns true for non-@google.com username/password external accounts (false for Google OIDC sessions).
function isExternalAccount(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.external === true) return false;
  const uname = normalize(user.username);
  if (!uname || /@google\.com$/i.test(uname)) return false;
  return true;
}

function normalizeExpiresAt(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('Invalid expiration date format (use YYYY-MM-DD or ISO-8601).');
  return new Date(ms).toISOString();
}

function normalizeDailyVertexLimit(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 10000) {
    throw new Error('Daily Vertex AI run limit must be between 0 and 10000 (or blank for default).');
  }
  return Math.floor(n);
}

function isAccountExpired(u, nowMs = Date.now()) {
  if (!u || !u.expiresAt) return false;
  const expMs = Date.parse(u.expiresAt);
  return Number.isFinite(expMs) && nowMs > expMs;
}

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
        clean[k] = {
          username: k,
          role: v.role === 'admin' ? 'admin' : 'user',
          hash: v.hash,
          createdAt: v.createdAt || new Date().toISOString(),
          mustChangePassword: !!v.mustChangePassword,
          passwordChangedAt: v.passwordChangedAt || null,
          expiresAt: v.expiresAt || null,
          dailyVertexLimit: (typeof v.dailyVertexLimit === 'number' && Number.isFinite(v.dailyVertexLimit) && v.dailyVertexLimit >= 0) ? Math.floor(v.dailyVertexLimit) : null,
        };
      }
    }
    return clean;
  } catch (e) { return {}; }
}

// In the cloud DATA_DIR points at the mounted GCS bucket so accounts survive a
// restart. gcsfuse doesn't honour POSIX modes and its rename is a copy+delete,
// so fall back to a direct write if the atomic swap isn't supported — losing
// atomicity there is far better than losing the ability to add a user.
function saveUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(users, null, 2);
  const tmp = USERS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, USERS_FILE); // atomic replace on a normal filesystem
  } catch (e) {
    fs.writeFileSync(USERS_FILE, payload);
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
  }
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
    if (existing && existing.role === 'admin' && existing.hash) {
      // Verify asynchronously so startup is never blocked by a second 32 MB scryptSync
      verifyHash(String(pw), existing.hash).then(async (match) => {
        if (!match) {
          const freshHash = await hashPassword(String(pw));
          users[uname] = {
            username: uname, role: 'admin', hash: freshHash,
            createdAt: existing.createdAt || new Date().toISOString(),
            mustChangePassword: false,
            passwordChangedAt: existing.passwordChangedAt || null,
          };
        }
      }).catch(() => {});
      console.log(`[auth] break-glass admin "${uname}" ensured from ADMIN_BOOTSTRAP_PASSWORD.`);
      return;
    }
    users[uname] = {
      username: uname, role: 'admin', hash: hashPasswordSync(String(pw)),
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      mustChangePassword: false,
      passwordChangedAt: null,
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
  if (!USERNAME_RE.test(u)) return 'Enter a valid email address (up to 128 chars) or a 3-32 char username (letters, digits, dot, dash or underscore).';
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

async function createUser(username, password, role, opts = {}) {
  const uname = normalize(username);
  const uErr = validateUsername(uname); if (uErr) throw new Error(uErr);
  const pErr = validatePassword(password, uname); if (pErr) throw new Error(pErr);
  if (ownUser(uname)) throw new Error('That username already exists.');
  const expiresAt = (opts && opts.expiresAt !== undefined) ? normalizeExpiresAt(opts.expiresAt) : null;
  const dailyVertexLimit = (opts && opts.dailyVertexLimit !== undefined) ? normalizeDailyVertexLimit(opts.dailyVertexLimit) : null;
  const hash = await hashPassword(password);
  const mustChangePassword = Boolean(opts && opts.mustChangePassword);
  users[uname] = {
    username: uname,
    role: role === 'admin' ? 'admin' : 'user',
    hash,
    createdAt: new Date().toISOString(),
    mustChangePassword,
    passwordChangedAt: null,
    expiresAt,
    dailyVertexLimit,
  };
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
    users[ADMIN_USERNAME] = {
      username: ADMIN_USERNAME,
      role: 'admin',
      hash,
      createdAt: new Date().toISOString(),
      mustChangePassword: false,
      passwordChangedAt: null,
    };
    saveUsers();
    SETUP_CODE = null; // burn the one-time code
    return publicUser(users[ADMIN_USERNAME]);
  } finally {
    setupInProgress = false;
  }
}

async function authenticate(username, password, opts = {}) {
  const u = ownUser(normalize(username));
  if (!u) { await verifyHash(String(password || ''), DUMMY_HASH); return null; } // equalise timing
  const ok = await verifyHash(String(password || ''), u.hash);
  if (!ok) return null;
  if (isAccountExpired(u)) {
    if (opts && opts.includeExpired) return { ...publicUser(u), expired: true };
    return null;
  }
  return publicUser(u);
}

async function changePassword(username, currentPassword, newPassword) {
  const u = ownUser(normalize(username));
  if (!u) throw new Error('User not found.');
  const ok = await verifyHash(String(currentPassword || ''), u.hash);
  if (!ok) throw new Error('Current password is incorrect.');
  if (String(newPassword || '') === String(currentPassword || '')) {
    throw new Error('New password must be different from your current password.');
  }
  const pErr = validatePassword(newPassword, u.username); if (pErr) throw new Error(pErr);
  u.hash = await hashPassword(newPassword);
  u.mustChangePassword = false;
  u.passwordChangedAt = new Date().toISOString();
  saveUsers();
  destroyUserSessions(u.username); // a password change revokes every existing session (incl. any stolen one)
  return publicUser(u);
}

function setMustChangePassword(target, mustChange = true) {
  const t = normalize(target);
  const tu = ownUser(t);
  if (!tu) throw new Error('User not found.');
  tu.mustChangePassword = !!mustChange;
  saveUsers();
  for (const [, s] of sessions) {
    if (!s.external && s.username === t) {
      s.mustChangePassword = !!tu.mustChangePassword;
    }
  }
  return publicUser(tu);
}

async function adminResetPassword(target, newTempPassword, mustChange = true) {
  const t = normalize(target);
  const tu = ownUser(t);
  if (!tu) throw new Error('User not found.');
  const pErr = validatePassword(newTempPassword, tu.username);
  if (pErr) throw new Error(pErr);
  tu.hash = await hashPassword(newTempPassword);
  tu.mustChangePassword = mustChange !== false;
  tu.passwordChangedAt = new Date().toISOString();
  saveUsers();
  destroyUserSessions(t); // revoke existing sessions so user must sign in with the temp password
  return publicUser(tu);
}

function updateUserLimits(target, { expiresAt, dailyVertexLimit } = {}) {
  const t = normalize(target);
  const tu = ownUser(t);
  if (!tu) throw new Error('User not found.');
  if (expiresAt !== undefined) {
    tu.expiresAt = normalizeExpiresAt(expiresAt);
  }
  if (dailyVertexLimit !== undefined) {
    tu.dailyVertexLimit = normalizeDailyVertexLimit(dailyVertexLimit);
  }
  saveUsers();
  if (isAccountExpired(tu)) {
    destroyUserSessions(t);
  } else {
    for (const [, s] of sessions) {
      if (!s.external && s.username === t) {
        s.accountExpiresAt = tu.expiresAt || null;
        s.dailyVertexLimit = tu.dailyVertexLimit != null ? tu.dailyVertexLimit : null;
      }
    }
  }
  return publicUser(tu);
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

function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    mustChangePassword: !!u.mustChangePassword,
    passwordChangedAt: u.passwordChangedAt || null,
    expiresAt: u.expiresAt || null,
    expired: isAccountExpired(u),
    dailyVertexLimit: (typeof u.dailyVertexLimit === 'number' && Number.isFinite(u.dailyVertexLimit)) ? u.dailyVertexLimit : null,
  };
}
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
  const isExternal = !!user.external;
  sessions.set(token, {
    username: user.username,
    role: user.role,
    external: isExternal,
    mustChangePassword: !isExternal && !!user.mustChangePassword,
    name: user.name || null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
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
    if (!u || isAccountExpired(u)) { sessions.delete(token); return null; } // local user was deleted or expired
    s.role = u.role;                                 // reflect current role
    s.mustChangePassword = !!u.mustChangePassword;   // reflect forced password change flag
    s.accountExpiresAt = u.expiresAt || null;
    s.dailyVertexLimit = (typeof u.dailyVertexLimit === 'number' && Number.isFinite(u.dailyVertexLimit)) ? u.dailyVertexLimit : null;
  } else {
    s.mustChangePassword = false;                    // never applies to Google OIDC sessions
    // Internal admins are editable in Settings: re-evaluate on every request so adding or
    // removing an admin takes effect immediately, without a sign-out.
    s.role = appSettings.isAdminEmail(s.username) ? 'admin' : 'user';
  }
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

// ---------- per-user daily run budgets on the GLOBAL keys (abuse + cost guardrail) ----------
// One budget per provider (openai, anthropic, moonshot, vertex), counted in RUNS: one Run
// click in either arena = 1 run per budget it touches, however many models/slots it
// compares. A single-model re-run, a crash fix or a Blind Judge call is a run too.
// Limits come from the admin Settings (src/appSettings.js; defaults openai 3, anthropic 3,
// moonshot 3, vertex 10) and apply to EVERY user, @google.com and external alike. Admins are
// exempt unless RATE_LIMIT_EXEMPT_ADMINS=0. An external account may carry its own Vertex
// override (`dailyVertexLimit`, set in Manage external users). Runs on the user's own key
// never reach here (strict BYOK, src/byok.js). A limit of 0 turns that global key off.
//
// Counters persist to run-budgets.json when AUTH_DATA_DIR is set (Cloud Run: the GCS
// bucket) so a redeploy doesn't hand everyone a fresh day; otherwise in memory only.
const BUDGET_PROVIDERS = appSettings.PROVIDERS;
const BUDGETS_FILE = path.join(DATA_DIR, 'run-budgets.json');
const PERSIST_BUDGETS = !!process.env.AUTH_DATA_DIR;
const runCounts = new Map(); // `${provider}|${username}|${utcDay}` -> count
function utcDay() { return new Date().toISOString().slice(0, 10); }
function nextUtcMidnightISO() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}
(function loadBudgets() {
  if (!PERSIST_BUDGETS) return;
  try {
    const obj = JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf8'));
    const today = utcDay();
    if (obj && obj.day === today && obj.counts && typeof obj.counts === 'object') {
      for (const [k, v] of Object.entries(obj.counts)) {
        if (typeof k === 'string' && k.endsWith('|' + today) && Number.isFinite(v) && v > 0) runCounts.set(k, Math.floor(v));
      }
    }
  } catch (_) { /* no file yet */ }
})();
function saveBudgets() {
  if (!PERSIST_BUDGETS) return;
  const today = utcDay();
  const counts = {};
  for (const [k, v] of runCounts) if (k.endsWith('|' + today)) counts[k] = v;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(BUDGETS_FILE, JSON.stringify({ day: today, counts }));
  } catch (e) {
    console.warn('[auth] could not persist run budgets:', e && e.message);
  }
}

function exemptFromBudgets(user) { return !!(RATE_EXEMPT_ADMINS && user && user.role === 'admin'); }
function dailyLimitFor(user, provider) {
  if (provider === 'vertex' && user) {
    const u = ownUser(normalize(user.username));
    if (u && typeof u.dailyVertexLimit === 'number' && Number.isFinite(u.dailyVertexLimit) && u.dailyVertexLimit >= 0) {
      return Math.floor(u.dailyVertexLimit);
    }
  }
  return appSettings.limitFor(provider);
}
const bKey = (user, provider) => provider + '|' + normalize(user.username) + '|' + utcDay();

// Peek at one budget without consuming it.
function providerQuota(user, provider) {
  const limit = dailyLimitFor(user, provider);
  if (!user || exemptFromBudgets(user)) return { limited: false, provider, limit, used: 0, remaining: Infinity };
  const used = runCounts.get(bKey(user, provider)) || 0;
  return { limited: true, provider, limit, used, remaining: Math.max(0, limit - used), resetAt: nextUtcMidnightISO() };
}
// Consume one run of a budget; { ok:false, ... } when that daily limit is reached.
function consumeProviderRun(user, provider) {
  const q = providerQuota(user, provider);
  if (!q.limited) return { ok: true, ...q };
  if (q.used >= q.limit) return { ok: false, ...q, remaining: 0 };
  runCounts.set(bKey(user, provider), q.used + 1);
  saveBudgets();
  return { ok: true, ...q, used: q.used + 1, remaining: Math.max(0, q.limit - q.used - 1) };
}
// Give a run back (the client abandoned it before it finished, or a later budget in
// the same run was exhausted), so a discarded run doesn't burn the day's allowance.
function refundProviderRun(user, provider) {
  if (!user || exemptFromBudgets(user)) return;
  const key = bKey(user, provider);
  const used = runCounts.get(key) || 0;
  if (used > 0) { runCounts.set(key, used - 1); saveBudgets(); }
}
// Every budget for this user (shown in both arenas' badges).
function quotaSnapshot(user) {
  const out = {};
  for (const p of BUDGET_PROVIDERS) out[p] = providerQuota(user, p);
  return out;
}

// Back-compat wrappers for older call sites/tests: the OpenAI and Vertex budgets.
// (`kind` is ignored: a single-model re-run is a run like any other.)
function runQuota(user, _kind) { return providerQuota(user, 'openai'); }
function consumeRun(user, _kind) { return consumeProviderRun(user, 'openai'); }
function refundRun(user, _kind) { return refundProviderRun(user, 'openai'); }
function vertexRunQuota(user) { return providerQuota(user, 'vertex'); }
function consumeVertexRun(user) { return consumeProviderRun(user, 'vertex'); }
function refundVertexRun(user) { return refundProviderRun(user, 'vertex'); }

// ---------- periodic cleanup (bounds memory; never blocks shutdown) ----------
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (now > s.expiresAt || (now - s.createdAt > SESSION_ABSOLUTE_TTL_MS)) sessions.delete(t);
  }
  for (const [k, e] of loginAttempts) if (e.lockedUntil < now && now - e.last > 60 * 60 * 1000) loginAttempts.delete(k);
  const today = utcDay();
  for (const k of runCounts.keys()) if (!k.endsWith('|' + today)) runCounts.delete(k); // drop prior days
}, 5 * 60 * 1000).unref();

module.exports = {
  COOKIE_NAME, ADMIN_USERNAME, MIN_PASSWORD_LEN,
  // users
  setupRequired, userExists, createUser, setupAdmin, authenticate, changePassword, setMustChangePassword, adminResetPassword, updateUserLimits, deleteUser, listUsers,
  isExternalAccount, isAccountExpired,
  // sessions
  createSession, getSession, destroySession, destroyUserSessions,
  // cookies + middleware
  cookieParser, setSessionCookie, clearSessionCookie,
  // brute force
  isLocked, lockRemainingMs, recordFailure, recordSuccess,
  // per-user daily run budgets on the global keys (one per provider; limits from Settings)
  runQuota, consumeRun, refundRun, MAX_RUNS_PER_DAY, MAX_SINGLE_RUNS_PER_DAY, MAX_OPENAI_RUNS_PER_DAY,
  vertexRunQuota, consumeVertexRun, refundVertexRun, MAX_EXTERNAL_VERTEX_RUNS_PER_DAY,
  providerQuota, consumeProviderRun, refundProviderRun, quotaSnapshot, BUDGET_PROVIDERS,
  // admins skip the daily limits AND the monthly budgets (unless RATE_LIMIT_EXEMPT_ADMINS=0)
  exemptFromBudgets,
  // setup code
  ensureSetupCode, getSetupCode, verifySetupCode,
  // validation (exposed for reuse/tests)
  validateUsername, validatePassword,
};
