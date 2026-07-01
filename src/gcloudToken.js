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

const TOKEN_CMD = process.env.GCLOUD_TOKEN_CMD || 'gcloud auth print-access-token';
const GCLOUD_TTL_MS = (parseInt(process.env.GCLOUD_TOKEN_TTL_SEC, 10) || 3000) * 1000;
const MINT_TIMEOUT_MS = 30000;
const METADATA_HOST = process.env.GCE_METADATA_HOST || 'metadata.google.internal';

let cached = { token: null, expiresAt: 0 };
let inflight = null;
let metadataAvailable = null; // null = unknown, true/false once probed

function autoMintEnabled() { return process.env.GCLOUD_TOKEN_AUTOMINT !== '0'; }

// 1. Metadata server (Cloud Run / GCE). Returns { token, ttlMs } or throws quickly.
async function mintFromMetadata() {
  const url = `http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('metadata token HTTP ' + r.status);
    const j = await r.json();
    if (!j.access_token) throw new Error('metadata response had no access_token');
    const ttlMs = Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000; // refresh 5 min early
    return { token: j.access_token, ttlMs };
  } finally { clearTimeout(timer); }
}

// 2. gcloud CLI (local dev).
function mintFromGcloud() {
  return new Promise((resolve, reject) => {
    exec(TOKEN_CMD, { timeout: MINT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gcloud token mint failed (\`${TOKEN_CMD}\`): ${String(stderr || err.message).trim().slice(0, 300)}`));
      const token = String(stdout || '').trim();
      if (!token) return reject(new Error('gcloud returned an empty access token (is gcloud authenticated?)'));
      resolve(token);
    });
  });
}

async function acquire() {
  // 1. metadata server (skip only if we already proved we're not on GCP)
  if (metadataAvailable !== false) {
    try {
      const m = await mintFromMetadata();
      metadataAvailable = true;
      return m;
    } catch (e) {
      if (metadataAvailable === null) metadataAvailable = false; // not on GCP; don't probe again
    }
  }
  // 2. gcloud CLI (local dev)
  if (autoMintEnabled()) {
    try {
      return { token: await mintFromGcloud(), ttlMs: GCLOUD_TTL_MS };
    } catch (e) {
      const fallback = process.env.CLAUDE_BEARER_TOKEN;
      if (fallback) { console.error(`[gcloudToken] mint failed; using static CLAUDE_BEARER_TOKEN. ${e.message}`); return { token: fallback, ttlMs: 0 }; }
      throw e;
    }
  }
  // 3. static token
  const fallback = process.env.CLAUDE_BEARER_TOKEN;
  if (fallback) return { token: fallback, ttlMs: 0 };
  throw new Error('No Claude credential available (no GCP metadata server, gcloud, or CLAUDE_BEARER_TOKEN).');
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
