// ---------------------------------------------------------------------------
// Obtain a Google Cloud OAuth access token for the Vertex Claude path, from the
// best source available, cached until shortly before expiry:
//
//   1. GCP metadata server  — the runtime service account on Cloud Run / GCE
//      (the DURABLE path: no CLI, no interactive reauth, ever). Used automatically
//      when running on Google Cloud.
//   2. gcloud CLI           — `gcloud auth print-access-token`, for LOCAL dev.
//   3. static CLAUDE_BEARER_TOKEN — last-resort fallback.
//
// On Cloud Run, give the service the "Vertex AI User" role and #1 just works.
// Locally, stay logged in with `gcloud auth login`. Refreshes reactively on 401.
// Opt out of the gcloud path with GCLOUD_TOKEN_AUTOMINT=0.
// ---------------------------------------------------------------------------

const { exec } = require('child_process');

const TOKEN_CMD = process.env.GCLOUD_TOKEN_CMD || 'CLOUDSDK_ACTIVE_CONFIG_NAME=argolis CLOUDSDK_CORE_ACCOUNT=admin@ubhi.altostrat.com gcloud auth print-access-token || gcloud auth print-access-token';
const GCLOUD_TTL_MS = (parseInt(process.env.GCLOUD_TOKEN_TTL_SEC, 10) || 3000) * 1000;
const MINT_TIMEOUT_MS = 30000;
const METADATA_HOST = process.env.GCE_METADATA_HOST || 'metadata.google.internal';
const METADATA_PROBE_TIMEOUT_MS = 5000;   // one slow first probe must not disable the durable path (5.5)
const METADATA_REPROBE_MS = 60 * 1000;    // after a timeout / 5xx, try the metadata server again this much later
// The extra gcloud configs (corp account, ADC) are personal to the author's machine and a
// silent hop onto a different billing identity (3.13): opt in with GCLOUD_TOKEN_FALLBACKS=1.
const GCLOUD_FALLBACKS = process.env.GCLOUD_TOKEN_FALLBACKS === '1';
// Fixed message for callers (it can end up on a slot in the browser); the shell detail
// (command line with account emails and local paths) goes to the server log only.
const UNAVAILABLE_MSG = 'Vertex OAuth credential unavailable';

let cached = { token: null, expiresAt: 0 };
let inflight = null;
let metadataAvailable = null;   // null = unknown, true/false once probed
let metadataRetryAt = 0;        // when false for a transient reason, re-probe after this time

function autoMintEnabled() { return process.env.GCLOUD_TOKEN_AUTOMINT !== '0'; }

// Hard "not on GCP" signals: the hostname does not resolve or nothing listens. Anything
// else (timeout, 5xx, malformed body) is treated as transient.
function isDefinitelyNotOnGcp(e) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  return code === 'ENOTFOUND' || code === 'ECONNREFUSED';
}

// 1. Metadata server (Cloud Run / GCE). Returns { token, ttlMs } or throws quickly.
async function mintFromMetadata() {
  const url = `http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), METADATA_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('metadata token HTTP ' + r.status);
    const j = await r.json();
    if (!j.access_token) throw new Error('metadata response had no access_token');
    const ttlMs = Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000; // refresh 5 min early
    return { token: j.access_token, ttlMs };
  } finally { clearTimeout(timer); }
}

// 2. gcloud CLI (local dev). The error carries the shell detail for the server log only.
function execTokenCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: MINT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gcloud token mint failed (\`${cmd}\`): ${String(stderr || err.message).trim().slice(0, 300)}`));
      const lines = String(stdout || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const token = lines[lines.length - 1] || '';
      if (!token) return reject(new Error('gcloud returned an empty access token (is gcloud authenticated?)'));
      resolve(token);
    });
  });
}

// A short, token-free label for a mint command (which gcloud config / account it used).
function describeCmd(cmd) {
  const m = /CLOUDSDK_ACTIVE_CONFIG_NAME=([^\s]+)/.exec(cmd);
  const a = /CLOUDSDK_CORE_ACCOUNT=([^\s]+)/.exec(cmd);
  if (m || a) return `config ${m ? m[1] : 'default'}${a ? ' (' + a[1] + ')' : ''}`;
  return /application-default/.test(cmd) ? 'application-default credentials' : 'default gcloud config';
}

async function mintFromGcloud() {
  const candidates = [TOKEN_CMD];
  // Extra configs are opt-in (GCLOUD_TOKEN_FALLBACKS=1) and only when GCLOUD_TOKEN_CMD was
  // not overridden to a custom test stub.
  if (GCLOUD_FALLBACKS && (!process.env.GCLOUD_TOKEN_CMD || process.env.GCLOUD_TOKEN_CMD.includes('gcloud'))) {
    const fallbacks = [
      'CLOUDSDK_ACTIVE_CONFIG_NAME=argolis CLOUDSDK_CORE_ACCOUNT=admin@ubhi.altostrat.com gcloud auth print-access-token',
      'CLOUDSDK_ACTIVE_CONFIG_NAME=corp-bhi CLOUDSDK_CORE_ACCOUNT=ubhi@google.com gcloud auth print-access-token',
      'gcloud auth print-access-token',
      'gcloud auth application-default print-access-token',
    ];
    for (const fb of fallbacks) {
      if (!candidates.includes(fb)) candidates.push(fb);
    }
  }
  let lastErr = null;
  for (const cmd of candidates) {
    try {
      const token = await execTokenCmd(cmd);
      // Which identity minted (never the token itself), so a fallback hop is visible in the log.
      console.log(`[gcloudToken] minted a Vertex OAuth token via ${describeCmd(cmd)}${cmd !== candidates[0] ? ' (fallback)' : ''}.`);
      return token;
    } catch (e) {
      lastErr = e;
      console.error(`[gcloudToken] ${e.message}`);
    }
  }
  throw lastErr || new Error('gcloud token mint failed');
}

async function acquire() {
  // 1. metadata server. Skipped only while we believe we're not on GCP: permanently after a
  //    hard "no such host / connection refused", temporarily (METADATA_REPROBE_MS) after a
  //    timeout or 5xx, so one slow first probe can't disable the durable path until restart.
  if (metadataAvailable !== false || Date.now() >= metadataRetryAt) {
    try {
      const m = await mintFromMetadata();
      metadataAvailable = true;
      return m;
    } catch (e) {
      if (isDefinitelyNotOnGcp(e)) {
        metadataAvailable = false; metadataRetryAt = Infinity; // not on GCP; don't probe again
      } else {
        metadataAvailable = false; metadataRetryAt = Date.now() + METADATA_REPROBE_MS;
        console.warn(`[gcloudToken] metadata server probe failed transiently (${String((e && e.message) || e).slice(0, 120)}); retrying in ${METADATA_REPROBE_MS / 1000}s.`);
      }
    }
  }
  // 2. gcloud CLI (local dev)
  if (autoMintEnabled()) {
    try {
      return { token: await mintFromGcloud(), ttlMs: GCLOUD_TTL_MS };
    } catch (e) {
      const fallback = process.env.CLAUDE_BEARER_TOKEN;
      if (fallback) { console.error('[gcloudToken] mint failed; using static CLAUDE_BEARER_TOKEN.'); return { token: fallback, ttlMs: 0 }; }
      // Detail already logged by mintFromGcloud; callers (and the browser) get the fixed text.
      throw new Error(UNAVAILABLE_MSG);
    }
  }
  // 3. static token
  const fallback = process.env.CLAUDE_BEARER_TOKEN;
  if (fallback) return { token: fallback, ttlMs: 0 };
  console.error('[gcloudToken] no credential source: no GCP metadata server, gcloud auto-mint disabled, and no CLAUDE_BEARER_TOKEN.');
  throw new Error(UNAVAILABLE_MSG);
}

// Returns a usable bearer token, cached until shortly before expiry. Pass
// { forceRefresh:true } after a 401 to mint a fresh one.
async function getClaudeToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (forceRefresh) cached = { token: null, expiresAt: 0 };
  if (!inflight) {
    inflight = acquire()
      .then(({ token, ttlMs }) => {
        cached = ttlMs > 0 ? { token, expiresAt: Date.now() + ttlMs } : { token: null, expiresAt: 0 };
        return token;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = { getClaudeToken, autoMintEnabled };
