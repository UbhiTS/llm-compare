// ---------------------------------------------------------------------------
// appSettings.js - admin-editable app settings (the Settings modal), persisted
// as settings.json next to users.json (AUTH_DATA_DIR: /data/auth on Cloud Run,
// i.e. the mounted GCS bucket, so settings survive restarts and deploys).
//
// limits.<provider>: runs per user per UTC day on the GLOBAL (shared) keys,
// for every user (@google.com and external alike; admins are exempt):
//   openai    (3)  - OpenAI text models + GPT Image
//   anthropic (3)  - direct Anthropic API
//   moonshot  (3)  - direct Moonshot API
//   vertex    (10) - everything on Vertex AI (Gemini, Claude, partner models, Nano Banana)
//   0 turns that global key off for non-admins (they must bring their own key).
// A run is one Run click in either arena and counts once per provider it
// touches, however many models it compares. Runs on a user's own key never count.
//
// adminEmails: internal (Google sign-in) admins added in the UI. ADMIN_EMAILS
// (env) are bootstrap admins: always admin and can't be removed from the UI,
// so a bad edit can never lock the owner out.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', '.auth');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const PROVIDERS = Object.freeze(['openai', 'anthropic', 'moonshot', 'vertex']);
const PROVIDER_LABELS = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', moonshot: 'Moonshot', vertex: 'Vertex AI' });
const DEFAULT_LIMITS = Object.freeze({ openai: 3, anthropic: 3, moonshot: 3, vertex: 10 });
const MAX_LIMIT = 10000;
const MAX_ADMIN_EMAILS = 200;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const BOOTSTRAP_ADMIN_EMAILS = Object.freeze(Array.from(new Set(
  String(process.env.ADMIN_EMAILS || 'ubhi@google.com,admin@ubhi.altostrat.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
)));

function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }

function sanitizeLimits(raw) {
  const out = { ...DEFAULT_LIMITS };
  if (raw && typeof raw === 'object') {
    for (const p of PROVIDERS) {
      const n = Number(raw[p]);
      if (raw[p] !== undefined && raw[p] !== null && raw[p] !== '' && Number.isFinite(n) && n >= 0 && n <= MAX_LIMIT) {
        out[p] = Math.floor(n);
      }
    }
  }
  return out;
}

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const admins = Array.isArray(obj && obj.adminEmails) ? obj.adminEmails.map(normEmail).filter((e) => EMAIL_RE.test(e)) : [];
    return {
      limits: sanitizeLimits(obj && obj.limits),
      adminEmails: Array.from(new Set(admins)).slice(0, MAX_ADMIN_EMAILS),
      updatedAt: (obj && obj.updatedAt) || null,
      updatedBy: (obj && obj.updatedBy) || null,
    };
  } catch (_) {
    return { limits: { ...DEFAULT_LIMITS }, adminEmails: [], updatedAt: null, updatedBy: null };
  }
}

let settings = load();

// Same write strategy as users.json: atomic rename where supported, direct
// write on gcsfuse (whose rename is a copy+delete).
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(settings, null, 2);
  const tmp = SETTINGS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    fs.writeFileSync(SETTINGS_FILE, payload);
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
  }
}

function get() {
  return {
    limits: { ...settings.limits },
    adminEmails: settings.adminEmails.slice(),
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
}

function limitFor(provider) {
  const v = settings.limits[provider];
  return Number.isFinite(v) ? v : DEFAULT_LIMITS[provider];
}

function isBootstrapAdmin(email) { return BOOTSTRAP_ADMIN_EMAILS.includes(normEmail(email)); }
function isAdminEmail(email) {
  const e = normEmail(email);
  return !!e && (BOOTSTRAP_ADMIN_EMAILS.includes(e) || settings.adminEmails.includes(e));
}

// Validate + persist an admin edit. `limits` and/or `adminEmails` may be omitted
// (left unchanged). `allowedDomains` (Google sign-in domains) restricts which
// emails can be made admins; `actor` is recorded for the audit trail.
function update({ limits, adminEmails } = {}, { actor = null, allowedDomains = [] } = {}) {
  const next = get();
  if (limits !== undefined) {
    if (!limits || typeof limits !== 'object') throw new Error('Limits must be an object.');
    for (const p of PROVIDERS) {
      if (limits[p] === undefined) continue;
      const n = Number(limits[p]);
      if (limits[p] === '' || limits[p] === null || !Number.isFinite(n) || n < 0 || n > MAX_LIMIT || Math.floor(n) !== n) {
        throw new Error(`${PROVIDER_LABELS[p]} limit must be a whole number from 0 to ${MAX_LIMIT}.`);
      }
      next.limits[p] = n;
    }
  }
  if (adminEmails !== undefined) {
    if (!Array.isArray(adminEmails)) throw new Error('Admin emails must be a list.');
    const domains = (allowedDomains || []).map((d) => String(d).toLowerCase());
    const clean = [];
    for (const raw of adminEmails) {
      const e = normEmail(raw);
      if (!e) continue;
      if (!EMAIL_RE.test(e)) throw new Error(`"${String(raw).slice(0, 80)}" is not a valid email address.`);
      const domain = e.split('@')[1];
      if (domains.length && !domains.includes(domain)) {
        throw new Error(`${e} can't be an internal admin: only ${domains.map((d) => '@' + d).join(', ')} Google sign-in accounts are allowed.`);
      }
      if (!BOOTSTRAP_ADMIN_EMAILS.includes(e) && !clean.includes(e)) clean.push(e);
    }
    if (clean.length > MAX_ADMIN_EMAILS) throw new Error(`At most ${MAX_ADMIN_EMAILS} internal admins.`);
    next.adminEmails = clean;
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = actor ? String(actor).slice(0, 120) : null;
  settings = next;
  save();
  return get();
}

module.exports = {
  PROVIDERS, PROVIDER_LABELS, DEFAULT_LIMITS, MAX_LIMIT, BOOTSTRAP_ADMIN_EMAILS,
  get, limitFor, update, isAdminEmail, isBootstrapAdmin, SETTINGS_FILE,
};
