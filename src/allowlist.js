// ---------------------------------------------------------------------------
// allowlist.js — durable, admin-managed list of individually invited emails.
//
// Google sign-in normally admits anyone whose email domain is in
// ALLOWED_EMAIL_DOMAINS. That list is baked in at deploy time, so inviting one
// guest outside the domain used to mean editing a GitHub variable + redeploying.
// This module lets an admin add a single address from inside the app instead:
// an email on this list may sign in even if its domain isn't allowed.
//
// Stored as one small JSON file under APP_DATA_DIR (a GCS bucket mounted as a
// Cloud Run volume in production, so it survives restarts; ./.data locally) —
// the same durability story as run history.
//
// NOTE ON SCOPE: this controls who this APP admits. It cannot add anyone to the
// GCP OAuth consent screen's "test users" list — Google exposes no API for that
// (console-only). While that consent screen is in Testing mode, an invited user
// must ALSO be a test user there; publishing the consent screen removes that
// requirement and makes this list the effective gate.
// ---------------------------------------------------------------------------

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const BASE_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'access')
  : path.join(__dirname, '..', '.data', 'access');
const FILE = path.join(BASE_DIR, 'allowlist.json');

const MAX_ENTRIES = 500; // sanity bound; this is an invite list, not a user directory

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
// Deliberately permissive but structural: one @, no whitespace, a dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
function validEmail(e) { const v = norm(e); return EMAIL_RE.test(v) && v.length <= 254 ? v : null; }

// In-memory mirror so the sign-in path never does disk I/O (gcsfuse reads are
// network round-trips). Loaded once at startup, updated on every write.
let cache = null;

function readFileSync() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj && obj.entries) ? obj.entries : [];
    return list
      .map((e) => ({ email: norm(e && e.email), addedBy: String((e && e.addedBy) || ''), at: Number((e && e.at) || 0) }))
      .filter((e) => EMAIL_RE.test(e.email));
  } catch (e) {
    return []; // missing / unreadable / corrupt ⇒ empty list (fail closed, never throw)
  }
}

function load() {
  if (!cache) cache = readFileSync();
  return cache;
}

async function persist(entries) {
  await fsp.mkdir(BASE_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, entries }));
  await fsp.rename(tmp, FILE); // atomic swap so a crash can't leave a half file
}

/** Every invited entry, newest first. */
function list() {
  return load().slice().sort((a, b) => b.at - a.at);
}

/** True if this exact email was individually invited. */
function isAllowed(email) {
  const v = norm(email);
  return !!v && load().some((e) => e.email === v);
}

/** Invite one email. Returns the stored entry. Throws on a bad/duplicate address. */
async function add(email, addedBy) {
  const v = validEmail(email);
  if (!v) throw new Error('Enter a valid email address.');
  const entries = load();
  if (entries.some((e) => e.email === v)) throw new Error(`${v} already has access.`);
  if (entries.length >= MAX_ENTRIES) throw new Error(`The invite list is full (${MAX_ENTRIES} max).`);
  const entry = { email: v, addedBy: norm(addedBy) || 'admin', at: Date.now() };
  const next = entries.concat([entry]);
  await persist(next);
  cache = next;
  return entry;
}

/** Revoke one invite. Returns true if it was present. */
async function remove(email) {
  const v = norm(email);
  const entries = load();
  const next = entries.filter((e) => e.email !== v);
  if (next.length === entries.length) return false;
  await persist(next);
  cache = next;
  return true;
}

module.exports = { list, isAllowed, add, remove, FILE };
