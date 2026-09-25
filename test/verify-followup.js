// ---------------------------------------------------------------------------
// verify-followup.js — offline regression tests for the security follow-up:
//   D4  no silent OpenAI model substitution (404/429 → labelled slot error)
//   O1  providerFetch timeouts + retries (429/5xx/network only, never 4xx)
//   O2  expired attachment cache references are flagged, never sent empty
//   O4  worker-thread extraction parity + multipart parser
// All network is mocked; nothing here calls a real provider.
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-followup-'));
process.env.APP_DATA_DIR = tmpDir;
process.env.AUTH_DATA_DIR = path.join(tmpDir, 'auth');
process.env.OPENAI_API_KEY = 'sk-test-followup';
process.env.AGENT_PLATFORM_API_KEY = 'test-followup-vertex-key';
process.env.GCP_PROJECT_ID = 'llm-compare-ubhits';
// Fast retries for the test run.
process.env.PROVIDER_RETRY_BASE_MS = '1';
process.env.PROVIDER_RETRY_MAX_MS = '5';

const realFetch = global.fetch;
let calls = [];
let handler = null;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = null; }
  calls.push({ url: u, model: body && body.model, body });
  return handler(u, opts, body);
};
function sse(lines) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < lines.length) c.enqueue(enc.encode(lines[i++] + '\n\n')); else c.close(); } });
}
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const { complete } = require('../src/providers');
const { runComparison } = require('../src/orchestrator');
const { modelFromCatalog } = require('../src/pricing');
const { providerFetch, ProviderTimeoutError } = require('../src/providerFetch');
const { TASKS } = require('../src/tasks');

const ok = (m) => console.log('✓ ' + m);

(async () => {
  // ------------------------------------------------------------------ D4
  for (const status of [429, 404]) {
    for (const model of ['gpt-6-sol', 'gpt-6-terra']) {
      calls = [];
      handler = () => json(status, { error: { message: `mock ${status}` } });
      let err = null;
      try {
        await complete({ provider: 'openai', model, messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
      } catch (e) { err = e; }
      assert(err, `D4: ${model} ${status} must throw, not succeed via another model`);
      assert(err.message.includes(`"${model}"`) && /not re-routed/.test(err.message), `D4: error must name ${model}: ${err.message}`);
      const otherModels = calls.filter((c) => c.model && c.model !== model).map((c) => c.model);
      assert.deepStrictEqual(otherModels, [], `D4: no request may target another model (saw ${otherModels})`);
      assert(!calls.some((c) => c.url.includes('aiplatform.googleapis.com')), 'D4: no re-route to gpt-oss MaaS on Vertex');
      // non-streaming path too
      calls = [];
      let err2 = null;
      try { await complete({ provider: 'openai', model, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err2 = e; }
      assert(err2 && err2.message.includes(`"${model}"`), 'D4: non-stream path labelled error');
      assert(!calls.some((c) => c.model && c.model !== model), 'D4: non-stream path no substitution');
    }
  }
  ok('D4 OpenAI 404/429 → labelled error for the requested model; no gpt-6-astra/gpt-6-sol/gpt-oss substitution (stream + non-stream)');

  // Orchestrator: OpenAI slot fails with a labelled model_error, Gemini slot still finishes and is priced.
  const task = TASKS.find((t) => t.id === 'meeting-rooms');
  handler = (u) => {
    if (u.includes('api.openai.com')) return json(429, { error: { message: 'quota' } });
    if (u.includes(':streamGenerateContent')) {
      return new Response(sse(['data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '```javascript\nfunction minMeetingRooms(){return 0;}\n```' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json(500, { error: 'unexpected ' + u });
  };
  const events = [];
  const results = await runComparison({ task, models: [modelFromCatalog('A', 'gemini-3.8-flash'), modelFromCatalog('D', 'gpt-6-sol')], maxIterations: 1, emit: (e) => events.push(e) });
  const errEv = events.find((e) => e.type === 'model_error' && e.slot === 'D');
  assert(errEv && /gpt-6-sol/.test(errEv.message) && /not re-routed/.test(errEv.message), 'D4: slot D gets a labelled model_error');
  const d = results.find((r) => r.slot === 'D');
  assert(d.error && d.costUsd == null, 'D4: failed slot is not priced');
  const a = results.find((r) => r.slot === 'A');
  assert(!a.error && a.costUsd >= 0, 'D4: other slot keeps working');
  ok('D4 orchestrator: failed OpenAI slot → model_error (unpriced), Gemini slot unaffected');

  // ------------------------------------------------ D4 universal: every provider
  // Each provider gets 429 / 403 / 404 from upstream. It must throw a labelled
  // error naming the requested model, and every upstream request must target
  // that same model (no claude-opus-5-5 / gpt-oss / other substitution).
  process.env.CLAUDE_BEARER_TOKEN = 'test-bearer-token-followup';
  process.env.MOONSHOT_API_KEY = 'test-moonshot-key-followup';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-followup';
  process.env.GEMINI_API_KEY = 'test-gemini-key-followup';
  const modelInReq = (c) => {
    const m = c.url.match(/\/models\/([^/:?]+)[:?]/);
    return (c.body && c.body.model) || (m && decodeURIComponent(m[1])) || null;
  };
  const cases = [
    { name: 'Vertex Claude (stream)', call: { provider: 'agentplatform', publisher: 'anthropic', model: 'claude-fable-5-1', onDelta: () => {} } },
    { name: 'Vertex Claude (non-stream)', call: { provider: 'agentplatform', publisher: 'anthropic', model: 'claude-mythos-5' } },
    { name: 'Vertex Gemini (stream)', call: { provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash', onDelta: () => {} } },
    { name: 'Vertex Gemini (non-stream)', call: { provider: 'agentplatform', publisher: 'google', model: 'gemini-3.6-flash' } },
    { name: 'Gemini API (generativelanguage)', call: { provider: 'gemini', model: 'gemini-3.5-flash' } },
    { name: 'Vertex MaaS (stream)', call: { provider: 'agentplatform', endpointType: 'openai-maas', model: 'deepseek-ai/deepseek-v3.2-maas', region: 'global', onDelta: () => {} } },
    { name: 'Vertex MaaS (non-stream)', call: { provider: 'agentplatform', endpointType: 'openai-maas', model: 'xai/grok-4.6', region: 'global' } },
    { name: 'OpenAI (stream)', call: { provider: 'openai', model: 'gpt-6-terra', onDelta: () => {} } },
    { name: 'Moonshot (stream)', call: { provider: 'moonshot', model: 'kimi-k3', onDelta: () => {} } },
    { name: 'Anthropic direct', call: { provider: 'anthropic', model: 'claude-sonnet-5' } },
  ];
  for (const status of [429, 403, 404]) {
    for (const c of cases) {
      calls = [];
      handler = () => json(status, { error: { code: status, message: `mock ${status}` } }, { 'Retry-After': '0' });
      let err = null;
      try { await complete({ ...c.call, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
      assert(err, `D4-all: ${c.name} ${status} must throw (not succeed via another model)`);
      assert(err.message.includes(`"${c.call.model}"`) && err.message.includes(String(status)), `D4-all: ${c.name} ${status} error must name the model + status: ${err.message.slice(0, 160)}`);
      const targets = [...new Set(calls.map(modelInReq).filter(Boolean))];
      assert.deepStrictEqual(targets, [c.call.model], `D4-all: ${c.name} ${status} requested other models: ${targets}`);
    }
  }
  ok(`D4 universal: ${cases.length} provider paths × 429/403/404 → labelled error, only the requested model is ever called`);

  // Orchestrator with Claude-quota-0 + a working Gemini: Claude slot fails, unpriced; Gemini + judge unaffected.
  handler = (u) => {
    if (u.includes('publishers/anthropic')) return json(429, { error: { message: 'quota 0' } }, { 'Retry-After': '0' });
    if (u.includes(':streamGenerateContent')) return new Response(sse(['data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '```javascript\nfunction minMeetingRooms(){return 0;}\n```' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })]), { status: 200 });
    if (u.includes(':generateContent')) return json(200, { candidates: [{ content: { parts: [{ text: '{"scores":[]}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });
    return json(500, {});
  };
  const ev2 = [];
  const res2 = await runComparison({ task, models: [modelFromCatalog('A', 'gemini-3.8-flash'), modelFromCatalog('C', 'claude-fable-5-1')], maxIterations: 1, emit: (e) => ev2.push(e) });
  const cErr = ev2.find((e) => e.type === 'model_error' && e.slot === 'C');
  assert(cErr && /claude-fable-5-1/.test(cErr.message) && !/claude-opus-5-5/.test(JSON.stringify(ev2)), 'D4-all: Fable slot fails labelled, Opus 5.5 never appears');
  assert(res2.find((r) => r.slot === 'C').costUsd == null && !res2.find((r) => r.slot === 'A').error, 'D4-all: failed slot unpriced; Gemini slot fine');
  ok('D4 universal orchestrator: quota-0 Claude slot → labelled unpriced error; no Opus 5.5 substitution; other slot fine');

  // ------------------------------------------------------------------ R6
  // Gemini keys travel in x-goog-api-key, never in the URL (all 3 Gemini paths).
  for (const c of cases.filter((x) => /Gemini/.test(x.name))) {
    calls = []; const seen = [];
    handler = (u, o) => { seen.push({ u, h: o.headers || {} }); return json(400, { error: { message: 'bad' } }); };
    try { await complete({ ...c.call, messages: [{ role: 'user', content: 'hi' }] }); } catch (_) { /* expected */ }
    assert(seen.length && seen.every((x) => !/[?&]key=/.test(x.u) && x.h['x-goog-api-key']), `R6: ${c.name} must send key via header only`);
  }
  // Errors that echo keys / URLs / tokens are scrubbed before reaching the client.
  const { scrubError } = require('../src/secrets');
  const dirty = `bad ${process.env.AGENT_PLATFORM_API_KEY} https://aiplatform.googleapis.com/v1/x:gen?key=${process.env.AGENT_PLATFORM_API_KEY} Authorization: Bearer ya29.abcdefghijklmnop sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ x-goog-api-key: AQ.Abcdefghijklmnopqrstuvwxyz0123`;
  const clean = scrubError(dirty, { agentplatform: 'AIzaBYOKabcdefghijklmnopqrstu' });
  assert(!clean.includes(process.env.AGENT_PLATFORM_API_KEY) && !/key=/.test(clean) && !/ya29\.a|sk-proj-A|AQ\.A/.test(clean), 'R6: scrubError removes keys, key=, tokens: ' + clean);
  // Network errors are re-thrown without the undici cause / URL.
  handler = (u) => { throw new TypeError(`fetch failed ${u}`, { cause: Object.assign(new Error(`connect ECONNREFUSED ${u}?key=SECRETSECRETSECRET`), { code: 'ECONNREFUSED' }) }); };
  let netErr = null;
  try { await providerFetch('https://aiplatform.googleapis.com/v1/x:gen?key=SECRETSECRETSECRET', { method: 'POST' }); } catch (e) { netErr = e; }
  assert(netErr && /ECONNREFUSED/.test(netErr.message) && !/SECRET|key=|googleapis/.test(netErr.message + String(netErr.cause || '')), 'R6: network error sanitized: ' + (netErr && netErr.message));
  ok('R6: Gemini keys header-only on all paths; scrubError + sanitized network errors');

  // ------------------------------------------------------------------ O1
  const U = 'https://api.openai.com/v1/chat/completions';
  let n = 0;
  handler = () => (++n < 3 ? json(503, {}) : json(200, { ok: true }));
  let r = await providerFetch(U, { method: 'POST', body: '{}' });
  assert(r.status === 200 && n === 3, 'O1: 503,503,200 → retried to success');
  n = 0; handler = () => { n++; return json(400, {}); };
  r = await providerFetch(U, { method: 'POST', body: '{}' });
  assert(r.status === 400 && n === 1, 'O1: 400 is not retried');
  n = 0; handler = () => { n++; return json(404, {}); };
  r = await providerFetch(U, { method: 'POST', body: '{}' });
  assert(r.status === 404 && n === 1, 'O1: 404 is not retried');
  n = 0; handler = () => { n++; return json(429, {}, { 'Retry-After': '0' }); };
  r = await providerFetch(U, { method: 'POST', body: '{}' });
  assert(r.status === 429 && n === 3, 'O1: persistent 429 → returned after max retries (3 attempts)');
  n = 0; handler = () => { if (++n === 1) throw new TypeError('fetch failed'); return json(200, {}); };
  r = await providerFetch(U, { method: 'POST', body: '{}' });
  assert(r.status === 200 && n === 2, 'O1: network error retried');
  // client abort → never retried
  n = 0; const ac = new AbortController();
  handler = (u, o) => { n++; return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); };
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(providerFetch(U, { method: 'POST', body: '{}', signal: ac.signal }));
  assert(n === 1, 'O1: client abort is not retried');
  // header timeout → retried, then ProviderTimeoutError
  process.env.PROVIDER_TIMEOUT_MS_OPENAI = '30';
  n = 0;
  await assert.rejects(providerFetch(U, { method: 'POST', body: '{}' }), (e) => e instanceof ProviderTimeoutError);
  assert(n === 3, 'O1: header timeout retried up to max');
  // streaming body is NOT subject to the header timeout
  handler = () => {
    const enc = new TextEncoder(); let i = 0;
    const body = new ReadableStream({ async pull(c) { await new Promise((s) => setTimeout(s, 25)); if (i++ < 4) c.enqueue(enc.encode('chunk' + i + '\n')); else c.close(); } });
    return new Response(body, { status: 200 });
  };
  r = await providerFetch(U, { method: 'POST', body: '{}' });
  const text = await r.text();
  assert(/chunk4/.test(text), 'O1: streamed body (100ms) outlives a 30ms header timeout');
  delete process.env.PROVIDER_TIMEOUT_MS_OPENAI;
  ok('O1 providerFetch: retries 429/5xx/network, not 4xx/abort; header timeout only; stream unaffected');

  // ------------------------------------------------------------------ O2
  const att = require('../src/attachments');
  const csv = Buffer.from('a,b\n1,2\n');
  const inspected = att.inspectAttachments([{ name: 'a.csv', mimeType: 'text/csv', data: csv.toString('base64') }]);
  const i0 = inspected[0];
  assert(/^[0-9a-f]{40}$/.test(i0.sha1) && /^[0-9a-f]{64}$/.test(i0.sha256), 'O2: inspect returns sha1 (legacy) + sha256');
  // legacy sha1 reference still resolves
  let norm = att.normalizeAttachments([{ sha1: i0.sha1, name: 'a.csv', mimeType: 'text/csv' }]);
  assert(norm[0].size === csv.length && !norm[0].isEmpty, 'O2: legacy sha1 cache reference resolves');
  norm = att.normalizeAttachments([{ sha256: i0.sha256, name: 'a.csv', mimeType: 'text/csv' }]);
  assert(norm[0].size === csv.length, 'O2: sha256 cache reference resolves');
  // expired / unknown reference → typed error, never an empty file
  assert.throws(() => att.normalizeAttachments([{ sha256: 'f'.repeat(64), name: 'gone.csv' }]), (e) => e.code === 'ATTACHMENT_EXPIRED' && e.expired && e.expired[0].name === 'gone.csv');
  assert.throws(() => att.normalizeAttachments([{ sha1: 'e'.repeat(40), name: 'gone.csv' }]), (e) => e.code === 'ATTACHMENT_EXPIRED');
  ok('O2 cache: sha1 + sha256 keys resolve; expired reference → ATTACHMENT_EXPIRED (no empty file)');

  // ------------------------------------------------------------------ O4
  const { extractInWorker } = require('../src/attachmentWorker');
  const zlib = require('zlib');
  const content = 'BT /F1 12 Tf 72 712 Td (Worker parity check text) Tj ET';
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n4 0 obj << /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), stream, Buffer.from('\nendstream endobj\n%%EOF\n', 'latin1')]);
  const inline = att.inspectAttachments([{ name: 'd.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') }])[0];
  const viaWorker = (await att.inspectAttachmentsAsync([{ name: 'd.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') }]))[0];
  assert.deepStrictEqual(viaWorker, inline, 'O4: worker-thread extraction output identical to inline');
  assert(typeof extractInWorker === 'function', 'O4: worker entry exported');
  const { parseMultipart } = require('../src/multipart');
  const boundary = '----llmcBoundary123';
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n`), csv,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`),
  ]);
  const parts = parseMultipart(mp, `multipart/form-data; boundary=${boundary}`, { maxFiles: 5, maxFileBytes: 1024 });
  assert(parts.files.length === 1 && parts.files[0].filename === 'a.csv' && parts.files[0].data.equals(csv) && parts.fields.note === 'hello', 'O4: multipart parsed');
  assert.throws(() => parseMultipart(mp, `multipart/form-data; boundary=${boundary}`, { maxFiles: 5, maxFileBytes: 4 }), /too large/i, 'O4: per-file limit enforced');
  ok('O4 worker extraction parity + multipart parser (limits enforced)');

  global.fetch = realFetch;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log('\nALL FOLLOW-UP CHECKS PASSED ✓');
  process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
