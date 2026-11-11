// ---------------------------------------------------------------------------
// vertexGeminiAuth.js - which credential and GCP project a Gemini-on-Vertex
// request runs on. Shared by the text adapters (src/providers.js) and the Image
// Arena (src/imageArena.js) so both always agree.
//
//   own key   The user supplied their own Vertex key (strict BYOK, src/byok.js):
//             that key only, paired with the user's own project or the
//             projectless alias. Never a shared credential or shared project.
//
//   shared    No own key. AGENT_PLATFORM_GEMINI_AUTH picks one of two modes:
//
//     apikey  (default) The shared AGENT_PLATFORM_API_KEY. A Vertex API key only
//             works on the project it was created in, so that project goes in
//             AGENT_PLATFORM_PROJECT_NUMBER (GCP_PROJECT_ID is tried second).
//             The key's project is then a hard dependency of every Gemini call.
//
//     oauth   The runtime service account's token on GCP_PROJECT_ID: the same
//             identity and project as Claude / partner MaaS. No API key at all,
//             so Gemini depends on nothing outside the project the app runs in.
//             Needs roles/aiplatform.user on GCP_PROJECT_ID (already required
//             for Claude).
// ---------------------------------------------------------------------------

const byok = require('./byok');
const globalKeys = require('./globalKeys');
// Kept as the module object (not destructured) so the token source is looked up
// at call time.
const gcloudToken = require('./gcloudToken');

const env = (name) => String(process.env[name] || '').trim();

// 'apikey' | 'oauth' | 'invalid'. Read on every call so a changed env is honoured.
// A typo must not silently mean "apikey": that is the mode with an external
// project dependency, so anything unrecognised is an error (see resolve()).
function sharedMode() {
  const raw = env('AGENT_PLATFORM_GEMINI_AUTH').toLowerCase();
  if (!raw || raw === 'apikey') return 'apikey';
  if (raw === 'oauth') return 'oauth';
  return 'invalid';
}

function sharedKey() {
  return globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY');
}

// Is a shared credential for Gemini on Vertex configured? Drives keysPresent in
// /api/config (whether the UI offers these models without the user's own key).
function sharedConfigured() {
  const mode = sharedMode();
  if (mode === 'oauth') return !!env('GCP_PROJECT_ID');
  if (mode === 'apikey') return !!sharedKey();
  return false;
}

// Resolve the credential for one request.
//   -> { own, kind: 'apikey' | 'oauth', key?, project, projects }
// `projects` are the project-scoped endpoints worth trying, in order; `project`
// is the first of them ('' = none, use the projectless alias). Throws when the
// selected shared mode is not usable, before any upstream request is made.
function resolve(keys) {
  const ownKey = byok.userCredential('vertexKey', keys);
  if (ownKey) {
    const projects = [byok.userProject(keys)].filter(Boolean);
    return { own: true, kind: 'apikey', key: ownKey, project: projects[0] || '', projects };
  }

  const mode = sharedMode();
  if (mode === 'oauth') {
    const project = env('GCP_PROJECT_ID');
    if (!project) {
      throw new Error('AGENT_PLATFORM_GEMINI_AUTH=oauth needs GCP_PROJECT_ID (the project the service account runs Gemini in).');
    }
    return { own: false, kind: 'oauth', project, projects: [project] };
  }
  if (mode !== 'apikey') {
    throw new Error(`AGENT_PLATFORM_GEMINI_AUTH must be "oauth" or "apikey" (got "${env('AGENT_PLATFORM_GEMINI_AUTH').slice(0, 24)}").`);
  }

  const key = sharedKey();
  if (!key) {
    const err = new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env) or Settings (or set AGENT_PLATFORM_GEMINI_AUTH=oauth to run Gemini on the service account).');
    err.missingSharedKey = true;
    throw err;
  }
  // The key's own project first; never a project number baked into the code.
  const projects = Array.from(new Set([env('AGENT_PLATFORM_PROJECT_NUMBER'), env('GCP_PROJECT_ID')].filter(Boolean)));
  return { own: false, kind: 'apikey', key, project: projects[0] || '', projects };
}

// Request headers for a resolved credential. Pass { forceRefresh: true } after a
// 401 to mint a fresh service-account token (never applies to an API key).
async function headers(auth, { forceRefresh = false } = {}) {
  if (auth.kind === 'oauth') {
    const token = await gcloudToken.getClaudeToken({ forceRefresh });
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }
  // SECURITY: the API key travels in the x-goog-api-key header, never in the URL.
  return { 'Content-Type': 'application/json', 'x-goog-api-key': auth.key };
}

module.exports = { sharedMode, sharedConfigured, resolve, headers };
