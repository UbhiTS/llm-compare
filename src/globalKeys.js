// ---------------------------------------------------------------------------
// globalKeys.js — shared ("global") provider API keys that an admin can set
// from inside the app, without a redeploy.
//
// WHERE THEY LIVE: Google Secret Manager, not this app's storage. Setting a key
// adds a new SECRET VERSION; reading pulls the latest. That keeps spending
// credentials in their proper home — versioned, IAM-controlled and visible in
// GCP's audit log — instead of sitting in the run-history bucket.
//
// HOW THEY'RE USED: providers fall back to these when a user hasn't supplied
// their own key. A run on shared keys is rate-limited (see auth.js); a run where
// every model uses the caller's OWN key is unlimited.
//
// The values are NEVER returned to the browser — the admin UI only ever sees
// presence + a masked tail (see status()).
//
// Auth: the runtime service account's ADC token (same minting path as Vertex).
// It needs roles/secretmanager.secretAccessor (read) and .secretVersionAdder
// (write) on each secret. Falls back to process.env when Secret Manager is
// unreachable, so local dev and the pre-existing --set-secrets deploy still work.
// ---------------------------------------------------------------------------

const { getClaudeToken } = require('./gcloudToken');

// The shared keys an admin may manage. Vertex-Claude isn't here: it authenticates
// with the runtime service account itself, so there is no key to store.
const MANAGED = [
  { name: 'AGENT_PLATFORM_API_KEY', label: 'Gemini / Agent Platform', hint: 'Gemini models on Vertex' },
  { name: 'OPENAI_API_KEY',         label: 'OpenAI',                  hint: 'GPT-5.6 Luna (external)' },
  { name: 'MOONSHOT_API_KEY',       label: 'Moonshot',                hint: 'Kimi K3 (external)' },
];
const MANAGED_NAMES = new Set(MANAGED.map((m) => m.name));

const PROJECT = () => process.env.GCP_PROJECT_ID || '';
const TTL_MS = Math.max(15, Number(process.env.GLOBAL_KEYS_TTL_SEC) || 60) * 1000;
const enabled = () => !!PROJECT() && process.env.GLOBAL_KEYS_ENABLED !== '0';

const cache = new Map();      // name -> { value, at }
const meta = new Map();       // name -> { source, updatedAt }

function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 8 ? '••••' : '••••' + s.slice(-4);
}

async function smFetch(path, init) {
  const token = await getClaudeToken();
  if (!token) throw new Error('No ADC token available for Secret Manager.');
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT()}/secrets/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return j;
}

// Pull one secret's latest version into the cache. Never throws.
async function refreshOne(name) {
  if (!enabled()) return;
  try {
    const j = await smFetch(`${encodeURIComponent(name)}/versions/latest:access`);
    const b64 = j && j.payload && j.payload.data;
    if (typeof b64 === 'string') {
      // trim: a placeholder version created from an empty stdin can hold just a
      // newline, which would otherwise read as a "present" (but broken) key.
      const value = Buffer.from(b64, 'base64').toString('utf8').trim();
      cache.set(name, { value, at: Date.now() });
      meta.set(name, { source: value ? 'secret-manager' : 'empty', updatedAt: Date.now() });
    }
  } catch (e) {
    // 404 = secret not created yet; anything else = permissions/network. Either
    // way we silently keep using the env value.
    if (e.status !== 404 && e.status !== 403) console.warn(`[globalKeys] ${name}: ${e.message}`);
    if (e.status === 404) meta.set(name, { source: 'env', updatedAt: 0 });
  }
}

async function refreshAll() { await Promise.all(MANAGED.map((m) => refreshOne(m.name))); }

// SYNC read used on the hot path by the provider adapters: the Secret Manager
// value if we have one cached, else the deploy-time env var.
function get(name) {
  const c = cache.get(name);
  if (c && c.value) return c.value;
  return (process.env[name] || '').trim();
}
function has(name) { return !!get(name); }

// Admin view: presence + masked tail only. The real values never leave the server.
function status() {
  return MANAGED.map((m) => {
    const v = get(m.name);
    const c = cache.get(m.name);
    return {
      name: m.name, label: m.label, hint: m.hint,
      present: !!v,
      masked: mask(v),
      source: (c && c.value) ? 'secret-manager' : (process.env[m.name] ? 'deploy env' : 'unset'),
      updatedAt: (meta.get(m.name) || {}).updatedAt || null,
    };
  });
}

// Add a new secret version. Creates the secret first if it doesn't exist yet.
async function set(name, value) {
  if (!MANAGED_NAMES.has(name)) throw new Error('Unknown key.');
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new Error('Value is empty.');
  if (!enabled()) throw new Error('Global keys need GCP_PROJECT_ID set on the server.');

  try {
    await smFetch(`${encodeURIComponent(name)}`); // exists?
  } catch (e) {
    if (e.status !== 404) throw e;
    // create with automatic replication
    const token = await getClaudeToken();
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT()}/secrets?secretId=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error((j && j.error && j.error.message) || `Could not create secret (HTTP ${r.status})`);
    }
  }

  await smFetch(`${encodeURIComponent(name)}:addVersion`, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: Buffer.from(v, 'utf8').toString('base64') } }),
  });
  cache.set(name, { value: v, at: Date.now() });
  meta.set(name, { source: 'secret-manager', updatedAt: Date.now() });
  return status();
}

// Warm at startup and keep fresh, so a key rotated in the console (or by another
// instance) is picked up without a restart.
function start() {
  if (!enabled()) return;
  refreshAll();
  const t = setInterval(refreshAll, TTL_MS);
  if (t.unref) t.unref();
}

module.exports = { MANAGED, get, has, status, set, refreshAll, start, enabled };
