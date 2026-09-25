// ---------------------------------------------------------------------------
// smoke-secrets.js — R6 black-box leak test. Spawns the real server with
// canary credentials and a HOSTILE upstream mock preloaded
// (test/fixtures/mock-upstream.js) that echoes keys, bearer tokens, URLs and
// headers back through every error path (bad key 400, 401, 429, network
// failure with undici cause, header timeout). Asserts that no client response
// (JSON, NDJSON stream, judge) and no server log line contains a canary, the
// minted bearer token, or "key=" — and that upstream URLs never carry a key.
// Also confirms the admin keys endpoint returns presence only. Offline.
//   node test/smoke-secrets.js
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_SECRETS_PORT || 18767);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-secrets-'));
const CANARY_VERTEX = 'AQ.CanaryVertexKey_' + 'x'.repeat(30);
const CANARY_OPENAI = 'sk-proj-CanaryOpenAIKey' + 'y'.repeat(30);
const CANARY_BYOK = 'AIzaCanaryByokKey' + 'z'.repeat(22);
const CANARY_BEARER = 'ya29.CanaryBearerToken' + 'w'.repeat(30);
const CANARIES = [CANARY_VERTEX, CANARY_OPENAI, CANARY_BYOK, CANARY_BEARER];
let failed = 0;
const check = (name, cond, extra) => { if (!cond) failed++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };
const leaks = (s) => {
  const found = CANARIES.filter((c) => s.includes(c)).map((c) => c.slice(0, 10) + '…');
  if (/[?&]key=/i.test(s)) found.push('key=');
  // also partial canary fragments (e.g. truncated at 400 chars)
  if (/CanaryVertexKey|CanaryOpenAIKey|CanaryByokKey|CanaryBearerToken/.test(s)) found.push('canary-fragment');
  return [...new Set(found)];
};

async function post(p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SECONDARY_PORT: '0',
    APP_DATA_DIR: tmp, AUTH_DATA_DIR: path.join(tmp, 'auth'),
    AGENT_PLATFORM_API_KEY: CANARY_VERTEX, GEMINI_API_KEY: CANARY_VERTEX, OPENAI_API_KEY: CANARY_OPENAI,
    CLAUDE_BEARER_TOKEN: CANARY_BEARER, GCLOUD_TOKEN_CMD: '', GLOBAL_KEYS_ENABLED: '0',
    PROVIDER_TIMEOUT_MS: '300', PROVIDER_MAX_RETRIES: '1', PROVIDER_RETRY_BASE_MS: '1', PROVIDER_RETRY_MAX_MS: '5',
    LOG_FORMAT: process.env.SMOKE_SECRETS_LOG_FORMAT || 'json',
  };
  delete env.K_SERVICE; delete env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const srv = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'mock-upstream.js'), 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  srv.stdout.on('data', (d) => { logs += d; });
  srv.stderr.on('data', (d) => { logs += d; });
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (_) { /* ignore */ } });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch (_) { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { console.error('server did not start\n' + logs); process.exit(1); }

  // 1) Full compare: every slot hits a different hostile failure mode.
  const slots = [
    ['A', 'gemini-3.5-flash-lite', 'network failure (undici cause w/ URL+headers)'],
    ['B', 'gemini-3.7-flash', 'header timeout'],
    ['C', 'gemini-3.8-flash', 'bad key 400 echoing key + URL'],
    ['D', 'claude-opus-5-5', '429 echoing bearer token'],
    ['E', 'gpt-6-sol', '401 echoing Authorization'],
  ];
  const run = await post('/api/run', { taskId: 'custom', customPrompt: 'hi', models: slots.map(([slot, catalogId]) => ({ slot, catalogId })) });
  const events = run.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  check('/api/run streams to all_done despite every upstream failing', run.status === 200 && events.some((e) => e.type === 'all_done'), `[${run.status}]`);
  for (const [slot, id, mode] of slots) {
    const ev = events.find((e) => e.type === 'model_error' && e.slot === slot);
    check(`slot ${slot} ${id}: labelled model_error (${mode})`, !!ev, ev ? ev.message.slice(0, 110).replace(/\s+/g, ' ') : 'missing');
  }
  const done = events.find((e) => e.type === 'all_done');
  check('failed slots are not priced', done && done.results.every((r) => r.error && r.costUsd == null));
  check('NDJSON stream contains no key / token / key=', leaks(run.text).length === 0, leaks(run.text).join(','));

  // 2) BYOK key in the request body must not be echoed back either.
  const byok = await post('/api/run', { taskId: 'custom', customPrompt: 'hi', models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }], keys: { agentplatform: CANARY_BYOK } });
  check('BYOK run: error returned, BYOK key not echoed', byok.status === 200 && /model_error/.test(byok.text) && leaks(byok.text).length === 0, leaks(byok.text).join(','));

  // 3) Judge path (non-streamed JSON error).
  const judge = await post('/api/judge', { judge: 'gemini-3.8-flash', taskId: 'custom', prompt: 'x', entries: [{ slot: 'A', text: 'a' }, { slot: 'B', text: 'b' }] });
  check('/api/judge upstream failure → error JSON without key / key=', judge.status >= 400 && leaks(judge.text).length === 0, `[${judge.status}] ${leaks(judge.text).join(',')}`);

  // 4) Admin "Your API keys" endpoint: presence only, never values.
  const cfg = await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.text());
  const ks = await fetch(`http://127.0.0.1:${PORT}/api/global-keys`).then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => ({ status: 0, text: '' }));
  check('/api/config keysPresent is booleans only, no values', leaks(cfg).length === 0 && /"keysPresent":\{[^}]*\}/.test(cfg) && !/"keysPresent":\{[^}]*"[a-z]+":"/.test(cfg));
  check('admin keys status endpoint returns no key values', ks.status !== 200 || leaks(ks.text).length === 0, `[${ks.status}]`);

  // 5) Upstream URLs never carried a key; logs clean.
  await new Promise((r) => setTimeout(r, 300));
  check('no upstream request URL carried a key query parameter', !/MOCK_VIOLATION/.test(logs));
  check('server logs contain no key / token / key=', leaks(logs).length === 0, leaks(logs).join(','));

  srv.kill('SIGTERM');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`\nSECRETS SMOKE: ${failed ? failed + ' FAILED' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
