// ---------------------------------------------------------------------------
// verify-byok-strict.js: offline tests for strict bring-your-own-key (BYOK).
//
// RULE (src/byok.js): when a user supplies the credential that covers a model,
// every request for that model uses ONLY the user's credential, paired with the
// user's own GCP project - never a shared key, shared project or the server's
// service-account token, not even as a retry/fallback after a 401/403/404.
// Without the covering credential the model runs on the shared credential +
// shared project (a user-supplied project is ignored) and counts toward caps.
//
// Covers: byok family mapping + modelUsesOwnKey (incl. partner MaaS models,
// which a Gemini API key does NOT cover), text adapters (OpenAI, Gemini direct,
// Vertex Gemini, Claude on Vertex, MaaS, streaming variants) and the Image
// Arena (Vertex + OpenAI GPT Image). No network: global fetch is mocked.
// ---------------------------------------------------------------------------

// Shared ("global") credentials + projects, set BEFORE any module loads.
process.env.OPENAI_API_KEY = 'GLOBAL_OPENAI_KEY';
process.env.AGENT_PLATFORM_API_KEY = 'GLOBAL_VERTEX_KEY';
process.env.GEMINI_API_KEY = 'GLOBAL_GEMINI_KEY';
process.env.ANTHROPIC_API_KEY = 'GLOBAL_ANTHROPIC_KEY';
process.env.MOONSHOT_API_KEY = 'GLOBAL_MOONSHOT_KEY';
process.env.AGENT_PLATFORM_PROJECT_NUMBER = '111111111111';
process.env.GCP_PROJECT_ID = 'shared-oauth-project';
process.env.PROVIDER_MAX_RETRIES = '0';

const assert = require('assert');

// The server's service-account token (shared credential for Claude / MaaS).
const gcloudToken = require('../src/gcloudToken');
let adcCalls = 0;
gcloudToken.getClaudeToken = async () => { adcCalls++; return 'GLOBAL_ADC_TOKEN'; };

const byok = require('../src/byok');
const { complete } = require('../src/providers');
const { runImageArenaComparison } = require('../src/imageArena');

const GLOBAL_SECRETS = ['GLOBAL_OPENAI_KEY', 'GLOBAL_VERTEX_KEY', 'GLOBAL_GEMINI_KEY', 'GLOBAL_ANTHROPIC_KEY', 'GLOBAL_MOONSHOT_KEY', 'GLOBAL_ADC_TOKEN'];
const SHARED_PROJECTS = ['111111111111', '419460847694', 'shared-oauth-project'];

// ---- fetch mock --------------------------------------------------------------
const calls = [];
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let responder = () => jsonResponse(401, { error: { message: 'invalid credentials (mock)' } });
global.fetch = async (url, init = {}) => {
  const h = init.headers || {};
  const headers = {};
  if (typeof h.entries === 'function' && typeof h.get === 'function') {
    for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
  } else {
    for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
  }
  const call = { url: String(url), headers, credential: headers.authorization || headers['x-goog-api-key'] || headers['x-api-key'] || '' };
  calls.push(call);
  return responder(call);
};

// Every upstream call used ONLY the user's credential and never touched a shared project.
function assertOnlyUserCredential(expectedCredential, { allowNoCalls = false } = {}) {
  if (!allowNoCalls) assert.ok(calls.length > 0, 'expected at least one upstream call');
  for (const c of calls) {
    assert.ok(c.credential.includes(expectedCredential), `call to ${c.url} used credential "${c.credential}", expected "${expectedCredential}"`);
    for (const g of GLOBAL_SECRETS) assert.ok(!c.credential.includes(g), `call to ${c.url} leaked shared credential ${g}`);
    for (const p of SHARED_PROJECTS) assert.ok(!c.url.includes(`/projects/${p}/`), `call used shared project ${p}: ${c.url}`);
  }
  assert.strictEqual(adcCalls, 0, 'server service-account token must never be minted for an own-credential request');
}

const MSGS = [{ role: 'user', content: 'Say hi.' }];
const noop = () => {};

// ---- runner -----------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- 1. family mapping + quota decision ----------------------------------------
const GEMINI_VERTEX = { provider: 'agentplatform', publisher: 'google', model: 'gemini-4-argon', region: 'global' };
const CLAUDE_VERTEX = { provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-5-5' };
const QWEN_MAAS = { provider: 'agentplatform', publisher: 'qwen', endpointType: 'openai-maas', model: 'qwen/qwen3-235b-a22b-instruct-2507-maas', region: 'global' };
const GPT = { provider: 'openai', model: 'gpt-5.4' };

test('credentialFamily maps every catalog shape to the right credential', () => {
  assert.strictEqual(byok.credentialFamily(GEMINI_VERTEX), 'vertexKey');
  assert.strictEqual(byok.credentialFamily({ provider: 'agentplatform' }), 'vertexKey');
  assert.strictEqual(byok.credentialFamily(CLAUDE_VERTEX), 'vertexOAuth');
  assert.strictEqual(byok.credentialFamily(QWEN_MAAS), 'vertexOAuth');
  assert.strictEqual(byok.credentialFamily(GPT), 'openai');
  assert.strictEqual(byok.credentialFamily({ provider: 'gemini' }), 'gemini');
  assert.strictEqual(byok.credentialFamily({ provider: 'moonshot' }), 'moonshot');
  assert.strictEqual(byok.credentialFamily({ provider: 'anthropic' }), 'anthropic');
});

test('modelUsesOwnKey: a Gemini/Vertex API key does NOT cover partner MaaS or Claude (they need the OAuth token)', () => {
  const geminiKeyOnly = { agentplatform: 'USER_VERTEX_KEY', gemini: 'USER_VERTEX_KEY' };
  assert.strictEqual(byok.modelUsesOwnKey(GEMINI_VERTEX, geminiKeyOnly), true);
  assert.strictEqual(byok.modelUsesOwnKey(QWEN_MAAS, geminiKeyOnly), false, 'MaaS on a Gemini key must count as shared (it runs on the shared token)');
  assert.strictEqual(byok.modelUsesOwnKey(CLAUDE_VERTEX, geminiKeyOnly), false);
  const token = { claudeBearerToken: 'USER_OAUTH_TOKEN', gcpProject: 'user-proj' };
  assert.strictEqual(byok.modelUsesOwnKey(QWEN_MAAS, token), true);
  assert.strictEqual(byok.modelUsesOwnKey(CLAUDE_VERTEX, token), true);
  assert.strictEqual(byok.modelUsesOwnKey(GPT, { openai: 'USER_OPENAI_KEY' }), true);
  assert.strictEqual(byok.modelUsesOwnKey(GPT, { openai: '   ' }), false, 'whitespace is not a key');
  assert.strictEqual(byok.modelUsesOwnKey(GPT, {}), false);
  assert.strictEqual(byok.modelUsesOwnKey(GPT, null), false);
});

// ---- 2. text adapters -------------------------------------------------------
test('OpenAI: own key is the only key used, even after a 401 (no shared-key fallback)', async () => {
  await assert.rejects(complete({ ...GPT, messages: MSGS, keys: { openai: 'USER_OPENAI_KEY' } }));
  assertOnlyUserCredential('Bearer USER_OPENAI_KEY');
});

test('OpenAI streaming (Responses + chat paths): own key only', async () => {
  await assert.rejects(complete({ ...GPT, messages: MSGS, onDelta: noop, keys: { openai: 'USER_OPENAI_KEY' } }));
  assertOnlyUserCredential('Bearer USER_OPENAI_KEY');
});

test('OpenAI without an own key still runs on the shared key (unchanged)', async () => {
  await assert.rejects(complete({ ...GPT, messages: MSGS, keys: {} }));
  assert.ok(calls.length > 0 && calls.every((c) => c.credential === 'Bearer GLOBAL_OPENAI_KEY'));
});

test('Gemini direct (AI Studio): own key only', async () => {
  responder = () => jsonResponse(403, { error: { message: 'API key not valid (mock)' } });
  await assert.rejects(complete({ provider: 'gemini', model: 'gemini-3.8-flash', messages: MSGS, keys: { gemini: 'USER_GEMINI_KEY' } }));
  assertOnlyUserCredential('USER_GEMINI_KEY');
});

test('Vertex Gemini: own key + no project -> projectless path (never the shared project) + actionable hint', async () => {
  responder = () => jsonResponse(404, { error: { message: 'Publisher model not found (mock)' } });
  await assert.rejects(
    complete({ ...GEMINI_VERTEX, messages: MSGS, keys: { agentplatform: 'USER_VERTEX_KEY', gemini: 'USER_VERTEX_KEY' } }),
    /GCP project ID/
  );
  assertOnlyUserCredential('USER_VERTEX_KEY');
  assert.ok(calls.every((c) => c.url.startsWith('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon')), calls.map((c) => c.url).join('\n'));
});

test('Vertex Gemini: own key + own project -> the user project only', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  await assert.rejects(complete({ ...GEMINI_VERTEX, messages: MSGS, keys: { agentplatform: 'USER_VERTEX_KEY', gcpProject: 'user-proj' } }));
  assertOnlyUserCredential('USER_VERTEX_KEY');
  assert.ok(calls.every((c) => c.url.includes('/v1/projects/user-proj/locations/global/')), calls.map((c) => c.url).join('\n'));
});

test('Vertex Gemini streaming: own key only, never the shared project', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  await assert.rejects(complete({ ...GEMINI_VERTEX, messages: MSGS, onDelta: noop, keys: { agentplatform: 'USER_VERTEX_KEY' } }), /GCP project ID/);
  assertOnlyUserCredential('USER_VERTEX_KEY');
});

test('Vertex Gemini: a user project without an own key is ignored (shared key stays on the shared project)', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  await assert.rejects(complete({ ...GEMINI_VERTEX, messages: MSGS, keys: { gcpProject: 'user-proj' } }));
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.strictEqual(c.credential, 'GLOBAL_VERTEX_KEY');
    assert.ok(c.url.includes('/projects/111111111111/') && !c.url.includes('user-proj'), c.url);
  }
});

test('Claude on Vertex: own token without a project fails fast (no request, no shared token, no shared project)', async () => {
  await assert.rejects(complete({ ...CLAUDE_VERTEX, messages: MSGS, keys: { claudeBearerToken: 'USER_OAUTH_TOKEN' } }), /GCP project ID/);
  assert.strictEqual(calls.length, 0, 'no upstream request may be made');
  assert.strictEqual(adcCalls, 0);
});

test('Claude on Vertex: own token + project -> own token & project only, no service-account refresh on 401', async () => {
  await assert.rejects(complete({ ...CLAUDE_VERTEX, messages: MSGS, keys: { claudeBearerToken: 'USER_OAUTH_TOKEN', gcpProject: 'user-proj' } }));
  assertOnlyUserCredential('Bearer USER_OAUTH_TOKEN');
  assert.ok(calls.every((c) => c.url.includes('/v1/projects/user-proj/locations/global/publishers/anthropic/')));
});

test('Claude on Vertex streaming: own token + project only', async () => {
  await assert.rejects(complete({ ...CLAUDE_VERTEX, messages: MSGS, onDelta: noop, keys: { claudeBearerToken: 'USER_OAUTH_TOKEN', gcpProject: 'user-proj' } }));
  assertOnlyUserCredential('Bearer USER_OAUTH_TOKEN');
});

test('Claude on Vertex without an own token: shared token on the shared project (user project ignored)', async () => {
  await assert.rejects(complete({ ...CLAUDE_VERTEX, messages: MSGS, keys: { gcpProject: 'user-proj' } }));
  assert.ok(adcCalls >= 1);
  assert.ok(calls.length > 0 && calls.every((c) => c.credential === 'Bearer GLOBAL_ADC_TOKEN' && c.url.includes('/projects/shared-oauth-project/')));
});

test('Partner MaaS (Qwen): own token + project only, no service-account refresh on 401', async () => {
  await assert.rejects(complete({ ...QWEN_MAAS, messages: MSGS, keys: { claudeBearerToken: 'USER_OAUTH_TOKEN', gcpProject: 'user-proj' } }));
  assertOnlyUserCredential('Bearer USER_OAUTH_TOKEN');
  assert.ok(calls.every((c) => c.url.includes('/projects/user-proj/locations/global/endpoints/openapi/chat/completions')));
});

test('Partner MaaS streaming: own token + project only', async () => {
  await assert.rejects(complete({ ...QWEN_MAAS, messages: MSGS, onDelta: noop, keys: { claudeBearerToken: 'USER_OAUTH_TOKEN', gcpProject: 'user-proj' } }));
  assertOnlyUserCredential('Bearer USER_OAUTH_TOKEN');
});

test('Partner MaaS with only a Gemini key runs on the shared token AND counts as shared for caps', async () => {
  const keys = { agentplatform: 'USER_VERTEX_KEY', gemini: 'USER_VERTEX_KEY' };
  await assert.rejects(complete({ ...QWEN_MAAS, messages: MSGS, keys }));
  assert.ok(calls.every((c) => c.credential === 'Bearer GLOBAL_ADC_TOKEN'));
  assert.strictEqual(byok.modelUsesOwnKey(QWEN_MAAS, keys), false);
});

// ---- 3. Image Arena ------------------------------------------------------------
const imgRun = (catalogId, keys) => runImageArenaComparison({
  slots: [{ slot: 'A', catalogId }], prompt: 'a red cube', aspectRatio: '1:1', imageSize: '1K', attachments: [], keys,
});

test('Image Arena (Vertex): own key + no project -> projectless path only, never a shared project', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  const out = await imgRun('gemini-nano-banana-2.1', { agentplatform: 'USER_VERTEX_KEY' });
  assert.strictEqual(out.results[0].ok, false);
  assertOnlyUserCredential('USER_VERTEX_KEY');
  assert.ok(calls.every((c) => c.url.includes('/v1beta1/publishers/google/models/')), calls.map((c) => c.url).join('\n'));
});

test('Image Arena (Vertex): own key + own project -> user project, then projectless; never shared', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  const out = await imgRun('gemini-nano-banana-2.1', { agentplatform: 'USER_VERTEX_KEY', gcpProject: 'user-proj' });
  assert.strictEqual(out.results[0].ok, false);
  assertOnlyUserCredential('USER_VERTEX_KEY');
  assert.ok(calls[0].url.includes('/projects/user-proj/locations/global/'));
});

test('Image Arena (Vertex): shared key ignores a user project', async () => {
  responder = () => jsonResponse(403, { error: { message: 'denied (mock)' } });
  await imgRun('gemini-nano-banana-2.1', { gcpProject: 'user-proj' });
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.strictEqual(c.credential, 'GLOBAL_VERTEX_KEY');
    assert.ok(!c.url.includes('user-proj'), c.url);
  }
  assert.ok(calls[0].url.includes('/projects/111111111111/'));
});

test('Image Arena (OpenAI GPT Image): own key is the only key used', async () => {
  const out = await imgRun('gpt-image-2', { openai: 'USER_OPENAI_KEY' });
  assert.strictEqual(out.results[0].ok, false);
  assertOnlyUserCredential('Bearer USER_OPENAI_KEY');
});

// ---- run ------------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    calls.length = 0;
    adcCalls = 0;
    responder = () => jsonResponse(401, { error: { message: 'invalid credentials (mock)' } });
    try {
      await t.fn();
      passed++;
      console.log(`✓ ${t.name}`);
    } catch (e) {
      failed++;
      process.exitCode = 1;
      console.error(`✗ ${t.name}\n  ${(e && e.message) || e}`);
    }
  }
  console.log(`\nverify-byok-strict: ${passed} passed, ${failed} failed`);
})();
