// ---------------------------------------------------------------------------
// secrets.js — keep credentials out of anything that leaves the server.
//
//   maskKnown(str, extra)   exact-value masking of every configured secret
//                           (secret-named env vars, Secret-Manager-managed keys,
//                           plus per-request BYOK keys passed in `extra`).
//   scrubError(msg, extra)  for error text shown to the browser / logs: maskKnown
//                           + generic key/token patterns + upstream URLs reduced
//                           to their host (no path/query can carry a key).
//
// Body-wide response filtering (server.js) uses maskKnown only, so legitimate
// model output (URLs, code samples) is never rewritten.
// ---------------------------------------------------------------------------

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|PRIVATE/i;
const MIN_LEN = 12; // don't mask short/non-secret values like "1" or "true"

let baseCache = { at: 0, vals: [] };
function baseSecretValues() {
  if (Date.now() - baseCache.at < 5000) return baseCache.vals;
  const vals = new Set();
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) && typeof v === 'string' && v.trim().length >= MIN_LEN) vals.add(v.trim());
  }
  try {
    const gk = require('./globalKeys');
    for (const m of gk.MANAGED) { const v = gk.get(m.name); if (v && v.length >= MIN_LEN) vals.add(v); }
  } catch (_) { /* globalKeys unavailable (tests) */ }
  baseCache = { at: Date.now(), vals: [...vals] };
  return baseCache.vals;
}

function knownSecretValues(extra) {
  const vals = new Set(baseSecretValues());
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= MIN_LEN) vals.add(v.trim()); };
  if (Array.isArray(extra)) extra.forEach(add);
  else if (extra && typeof extra === 'object') Object.values(extra).forEach(add);
  // Longest first so a secret containing another is masked whole.
  return [...vals].sort((a, b) => b.length - a.length);
}

function maskKnown(str, extra) {
  let out = String(str);
  for (const v of knownSecretValues(extra)) {
    if (out.includes(v)) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

const UPSTREAM_HOST = /(?:[a-z0-9-]+\.)*(?:googleapis\.com|openai\.com|anthropic\.com|moonshot\.(?:ai|cn))/i;
const PATTERNS = [
  [/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"'\\]+/gi, '$1[REDACTED]'],
  [/((?:x-goog-api-key|authorization|x-api-key)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]'],
  [/\bAQ\.[0-9A-Za-z_.-]{20,}/g, '[REDACTED_KEY]'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]'],
  [/\bya29\.[0-9A-Za-z._-]{10,}/g, '[REDACTED_TOKEN]'],
];

function scrubError(msg, extra) {
  let out = maskKnown(msg, extra);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  // Upstream API URLs → host only (the path/query of a provider call is never
  // useful to the user and is where keys historically lived).
  out = out.replace(/https?:\/\/[^\s"'<>\\)]+/gi, (u) => {
    try {
      const p = new URL(u);
      if (UPSTREAM_HOST.test(p.hostname)) return `${p.protocol}//${p.hostname}`;
      return `${p.protocol}//${p.host}${p.pathname}`; // other URLs: drop query/fragment
    } catch (_) { return '[url]'; }
  });
  return out;
}

module.exports = { maskKnown, scrubError, knownSecretValues };
