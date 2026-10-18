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
// Optional monthly budget (USD, calendar month UTC) per global key, for the
// "remaining of budget" view in Settings. null = no budget set.
const EMPTY_BUDGETS = Object.freeze({ openai: null, anthropic: null, moonshot: null, vertex: null });
const MAX_BUDGET = 1000000;
const MAX_ADMIN_EMAILS = 200;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Which daily budget / spend bucket a model belongs to (by its provider).
function budgetBucket(m) {
  const p = m && m.provider;
  return (p === 'openai' || p === 'anthropic' || p === 'moonshot') ? p : 'vertex'; // agentplatform, gemini -> vertex
}

const BOOTSTRAP_ADMIN_EMAILS = Object.freeze(Array.from(new Set(
  String(process.env.ADMIN_EMAILS || 'ubhi@google.com,admin@ubhi.altostrat.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
)));
// Say so at boot (3.10): these accounts are admin on every deployment and cannot be removed
// in Settings, and the built-in default is the author's own addresses.
if (process.env.ADMIN_EMAILS) {
  console.warn(`[appSettings] WARNING: bootstrap admins (ADMIN_EMAILS, always admin, not removable in Settings): ${BOOTSTRAP_ADMIN_EMAILS.join(', ') || '(none)'}`);
} else {
  console.warn(`[appSettings] WARNING: ADMIN_EMAILS is not set, so the BUILT-IN default bootstrap admins are in effect: ${BOOTSTRAP_ADMIN_EMAILS.join(', ')}. Set ADMIN_EMAILS to your own admin address(es) on any deployment that is not the author's.`);
}

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

function sanitizeBudgets(raw) {
  const out = { ...EMPTY_BUDGETS };
  if (raw && typeof raw === 'object') {
    for (const p of PROVIDERS) {
      const n = Number(raw[p]);
      if (raw[p] !== undefined && raw[p] !== null && raw[p] !== '' && Number.isFinite(n) && n >= 0 && n <= MAX_BUDGET) {
        out[p] = Math.round(n * 100) / 100;
      }
    }
  }
  return out;
}

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const admins = Array.isArray(obj && obj.adminEmails) ? obj.adminEmails.map(normEmail).filter((e) => EMAIL_RE.test(e)) : [];
    // Legacy "+tag" entries never matched a Google sign-in; drop them so they can't make
    // every later Settings edit fail the +tag check in update().
    const tagged = admins.filter((e) => e.split('@')[0].includes('+'));
    if (tagged.length) console.warn(`[appSettings] ignoring internal admin entries with a "+tag" (they never match Google sign-in): ${tagged.join(', ')}`);
    return {
      limits: sanitizeLimits(obj && obj.limits),
      budgets: sanitizeBudgets(obj && obj.budgets),
      adminEmails: Array.from(new Set(admins.filter((e) => !tagged.includes(e)))).slice(0, MAX_ADMIN_EMAILS),
      updatedAt: (obj && obj.updatedAt) || null,
      updatedBy: (obj && obj.updatedBy) || null,
    };
  } catch (_) {
    return { limits: { ...DEFAULT_LIMITS }, budgets: { ...EMPTY_BUDGETS }, adminEmails: [], updatedAt: null, updatedBy: null };
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
    budgets: { ...settings.budgets },
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

// Validate + persist an admin edit. `limits`, `budgets` and/or `adminEmails` may be
// omitted (left unchanged). `allowedDomains` (Google sign-in domains) restricts which
// emails can be made admins; `actor` is recorded for the audit trail.
function update({ limits, budgets, adminEmails } = {}, { actor = null, allowedDomains = [] } = {}) {
  const next = get();
  if (budgets !== undefined) {
    if (!budgets || typeof budgets !== 'object') throw new Error('Budgets must be an object.');
    for (const p of PROVIDERS) {
      if (budgets[p] === undefined) continue;
      if (budgets[p] === null || budgets[p] === '') { next.budgets[p] = null; continue; }
      const n = Number(budgets[p]);
      if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET) {
        throw new Error(`${PROVIDER_LABELS[p]} monthly budget must be a dollar amount from 0 to ${MAX_BUDGET}, or blank for none.`);
      }
      next.budgets[p] = Math.round(n * 100) / 100;
    }
  }
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
      // Google's ID token carries the canonical address: a "+tag" admin entry would be
      // stored but never match a real sign-in (3.19), so refuse it instead of silently
      // granting nothing.
      if (e.split('@')[0].includes('+')) {
        throw new Error(`${e} can't be an internal admin: use the account's canonical address without a "+tag" (Google sign-in never reports the tagged form).`);
      }
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
  PROVIDERS, PROVIDER_LABELS, DEFAULT_LIMITS, MAX_LIMIT, MAX_BUDGET, BOOTSTRAP_ADMIN_EMAILS,
  get, limitFor, update, isAdminEmail, isBootstrapAdmin, budgetBucket, SETTINGS_FILE,
};
