// ---------------------------------------------------------------------------
// byok.js - strict bring-your-own-key (BYOK) credential resolution.
//
// RULE: if a user supplied the credential that covers a model, every request
// for that model uses ONLY the user's credential (paired with the user's own
// GCP project where one is needed). The server's global/shared credentials and
// shared GCP projects are never used for it: not as a default, not as a retry,
// and not as a fallback after a 401/403/404. A bad or expired user key simply
// fails that slot with the provider's error.
//
// If the user did NOT supply the covering credential, the model runs on the
// shared credential + shared project and counts against the daily caps. A
// user-supplied GCP project is never paired with a shared credential.
//
// Credential families (one per field in "Your API keys"):
//   vertexKey   - Gemini on Vertex AI (Agent Platform)          keys.agentplatform || keys.gemini
//   vertexOAuth - Claude + partner MaaS models on Vertex AI      keys.claudeBearerToken (+ keys.gcpProject)
//   gemini      - Gemini direct (AI Studio)                     keys.gemini
//   openai      - OpenAI (text + GPT Image)                     keys.openai
//   moonshot    - Moonshot direct                               keys.moonshot
//   anthropic   - Anthropic direct                              keys.anthropic
//
// public/app.js keySourceFor() mirrors credentialFamily() so the "your keys ·
// no limit" badge always matches what the server will actually do.
// ---------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Which credential authenticates this model? `m` is a catalog entry (or any
// object with provider / publisher / endpointType).
function credentialFamily(m) {
  const prov = m && m.provider;
  if (prov === 'agentplatform') {
    const pub = (m && m.publisher) || 'google';
    // Claude and partner MaaS models (Grok, Qwen, DeepSeek, Llama, GLM, GPT-OSS,
    // Kimi on Vertex) authenticate with an OAuth bearer token, not an API key.
    if (pub === 'anthropic' || (m && m.endpointType === 'openai-maas')) return 'vertexOAuth';
    return 'vertexKey';
  }
  if (prov === 'gemini' || prov === 'openai' || prov === 'moonshot' || prov === 'anthropic') return prov;
  return 'unknown';
}

// The user's own credential for a family, or '' when they didn't supply one.
function userCredential(family, keys) {
  if (!keys || typeof keys !== 'object') return '';
  switch (family) {
    case 'vertexKey': return str(keys.agentplatform) || str(keys.gemini);
    case 'vertexOAuth': return str(keys.claudeBearerToken);
    case 'gemini': return str(keys.gemini);
    case 'openai': return str(keys.openai);
    case 'moonshot': return str(keys.moonshot);
    case 'anthropic': return str(keys.anthropic);
    default: return '';
  }
}

// The user's own GCP project (only ever paired with the user's own credential).
// Validated against the GCP grammar (3.22): a project ID is 6-30 chars, lowercase letter
// first, letters/digits/hyphens, no trailing hyphen; a project NUMBER is all digits. It is
// interpolated into Vertex URL paths, so anything else is rejected up front with a
// slot-level 400 instead of a confusing upstream error.
const GCP_PROJECT_RE = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d{6,})$/;
function userProject(keys) {
  const raw = keys && typeof keys === 'object' ? str(keys.gcpProject) : '';
  if (!raw) return '';
  const p = raw.toLowerCase();
  if (!GCP_PROJECT_RE.test(p)) {
    throw byokError(`"${raw.slice(0, 40)}" is not a valid GCP project ID (6-30 lowercase letters, digits or hyphens, starting with a letter) or project number - fix it under "Your API keys".`);
  }
  return p;
}

// Does this model run on the user's own credential? Decides whether a run
// counts against the daily caps (server.js) and is the single source of truth
// for "your keys · no limit".
function modelUsesOwnKey(m, keys) {
  return !!userCredential(credentialFamily(m), keys);
}

// Thrown when a user's own credential can't be used on its own (e.g. an OAuth
// token without a project). Carries status 400 so it is never retried and is
// shown on the slot verbatim.
function byokError(message) {
  const err = new Error(message);
  err.status = 400;
  err.byok = true;
  return err;
}

module.exports = { credentialFamily, userCredential, userProject, modelUsesOwnKey, byokError };
