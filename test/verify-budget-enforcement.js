// ---------------------------------------------------------------------------
// verify-budget-enforcement.js: tiered pricing (Claude Haiku 5.5) + enforced monthly
// budgets on the global keys.
//
// Rules under test (v1.0.43):
//   - Claude Haiku 5.5 bills $0.10 / $0.50 per 1M tokens for prompts under 100K tokens
//     and $0.50 / $2.50 at 100K+, per provider request (that request's input AND output).
//     Models without priceTiers are priced exactly as before.
//   - A run's cost is the sum of its calls' costs, each call at its own prompt tier; the
//     live streaming estimate uses the current call's tier; the Blind Judge too.
//   - Spend counted against a monthly budget = max(app-tracked spend, the provider's own
//     month-to-date spend when its spend API answered). Settings and enforcement agree.
//   - Once a provider's month-to-date spend reaches its monthly budget, a run that needs
//     that provider's GLOBAL key gets a 429 (monthlyBudgetExhausted) before anything is
//     charged or called: text runs, the judge, image reserve and stand-alone image runs.
//     Own-key runs and admins are not affected; raising or clearing the budget unblocks
//     right away; a $0 budget blocks the key; ticketed image slots approved at reserve
//     are not re-blocked (a top-up budget is).
// Offline: provider HTTP is mocked in-process (global.fetch) and, in the spawned server,
// by a --require preload that answers Vertex Gemini / Claude Haiku 5.5 calls and the
// OpenAI Costs API, and blocks every other external host.
//   node test/verify-budget-enforcement.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-budget-enforce-'));
process.env.AUTH_DATA_DIR = path.join(tmp, 'auth-unit');
process.env.APP_DATA_DIR = path.join(tmp, 'data-unit');
delete process.env.ADMIN_EMAILS;
for (const k of ['OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY', 'MOONSHOT_API_KEY', 'GCP_PROJECT_ID', 'CLAUDE_BEARER_TOKEN']) delete process.env[k];

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; process.exitCode = 1; console.error(`✗ ${name}\n  ${(e && e.stack) || e}`); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || 'value'}: ${a} != ${b}`);

const pricing = require('../src/pricing');
const globalKeys = require('../src/globalKeys');
const providerBilling = require('../src/providerBilling');
const { runAgent } = require('../src/agent');
const { judgeOutputs } = require('../src/judge');

// In-process fetch mock: URL-prefix routes; anything else throws (no real network).
const calls = [];
let routes = {};
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, headers: init.headers || {} });
  for (const [prefix, handler] of Object.entries(routes)) if (u.startsWith(prefix)) return handler(u, init);
  throw new Error('unexpected fetch in test: ' + u);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events) => new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

// Claude on Vertex (streamRawPredict for runs, rawPredict for the judge) answers from a queue.
const VERTEX = 'https://aiplatform.googleapis.com/';
let claudeQueue = [];
const claudeRoute = (u) => {
  const next = claudeQueue.shift();
  if (!next) throw new Error('no queued Claude reply for ' + u);
  if (u.includes(':streamRawPredict')) {
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: next.input } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: next.text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: next.output } },
    ]);
  }
  return json(200, { content: next.text ? [{ type: 'text', text: next.text }] : [], stop_reason: next.stopReason || 'end_turn', usage: { input_tokens: next.input, output_tokens: next.output } });
};
const OWN_CLAUDE = { claudeBearerToken: 'unit-test-oauth-token-0123', gcpProject: 'unit-test-project' };

(async () => {
  const haiku = pricing.modelFromCatalog('A', 'claude-haiku-5-5');
  const HAIKU_TIERS = [{ minPromptTokens: 100000, input: 0.50, output: 2.50 }];

  // ---- 1. Tiered pricing helpers ------------------------------------------------------
  await check('catalog: Claude Haiku 5.5 is 1M context, $0.10 / $0.50 base, $0.50 / $2.50 at 100K+; the only tiered model', () => {
    const entry = pricing.MODEL_CATALOG.find((m) => m.id === 'claude-haiku-5-5');
    assert.deepStrictEqual(entry.price, { input: 0.10, output: 0.50 });
    assert.deepStrictEqual(entry.priceTiers, HAIKU_TIERS);
    assert.strictEqual(entry.context, 1000000);
    assert.deepStrictEqual(pricing.MODEL_CATALOG.filter((m) => m.priceTiers).map((m) => m.id), ['claude-haiku-5-5']);
    assert.deepStrictEqual(haiku.priceTiers, HAIKU_TIERS, 'resolved slot configs carry the tiers');
    assert.notStrictEqual(haiku.priceTiers, entry.priceTiers, 'a copy, never the shared catalog array');
    assert.deepStrictEqual(haiku.price, { input: 0.10, output: 0.50 });
    const resolved = pricing.resolveModels([{ slot: 'A', catalogId: 'claude-haiku-5-5', price: { input: 0, output: 0 }, priceTiers: [] }])[0];
    assert.deepStrictEqual(resolved.priceTiers, HAIKU_TIERS, 'client-posted tiers / prices are ignored');
    assert.deepStrictEqual(resolved.price, { input: 0.10, output: 0.50 });
  });
  await check('priceForPrompt: base below 100K prompt tokens, the tier at exactly 100K and above', () => {
    for (const n of [0, 1, 50000, 99999, undefined, null, NaN, 'x']) assert.deepStrictEqual(pricing.priceForPrompt(haiku, n), { input: 0.10, output: 0.50 }, `prompt ${String(n)}`);
    for (const n of [100000, 100001, 150000, 1000000, '120000']) assert.deepStrictEqual(pricing.priceForPrompt(haiku, n), { input: 0.50, output: 2.50 }, `prompt ${String(n)}`);
  });
  await check('callCostUsd: a 100K+ prompt bills that call\'s input AND output at the tier rate', () => {
    near(pricing.callCostUsd(haiku, 50000, 2000), (0.10 * 50000 + 0.50 * 2000) / 1e6, '50K prompt');
    near(pricing.callCostUsd(haiku, 99999, 1000), (0.10 * 99999 + 0.50 * 1000) / 1e6, '99,999 prompt');
    near(pricing.callCostUsd(haiku, 100000, 1000), 0.0525, 'exactly 100K prompt');
    near(pricing.callCostUsd(haiku, 150000, 2000), 0.08, '150K prompt');
    near(pricing.callCostUsd(haiku, 0, 0), 0, 'nothing used');
  });
  await check('models without priceTiers are priced exactly as before (any prompt size)', () => {
    for (const id of ['gemini-3.8-flash', 'gemini-4-argon', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'gpt-6-sol', 'glm-5-maas']) {
      const m = pricing.modelFromCatalog('A', id);
      assert.ok(!('priceTiers' in m), `${id} has no priceTiers key`);
      for (const pt of [0, 1000, 100000, 900000]) {
        assert.deepStrictEqual(pricing.priceForPrompt(m, pt), pricing.priceFor(m), `${id} @ ${pt}`);
        near(pricing.callCostUsd(m, pt, 777), (m.price.input * pt + m.price.output * 777) / 1e6, `${id} @ ${pt}`);
      }
    }
    near(pricing.callCostUsd({ price: { input: 1, output: 2 } }, 1e6, 1e6), 3, 'a hand-built config with only a price');
    assert.deepStrictEqual(pricing.priceForPrompt({ provider: 'openai' }, 500000), pricing.PRICING.openai, 'no price at all: provider fallback');
    const multi = { price: { input: 1, output: 2 }, priceTiers: [{ minPromptTokens: 200000, input: 4, output: 8 }, { minPromptTokens: 100000, input: 2, output: 4 }] };
    assert.deepStrictEqual(pricing.priceForPrompt(multi, 150000), { input: 2, output: 4 });
    assert.deepStrictEqual(pricing.priceForPrompt(multi, 250000), { input: 4, output: 8 }, 'the highest matching tier wins');
  });

  // ---- 2. Agent + judge cost (mocked Vertex Claude / Gemini) ---------------------------
  routes = { [VERTEX]: (u) => claudeRoute(u) };
  const runOnce = async (modelConfig, task, keys, maxIterations = 1) => {
    const events = [];
    const result = await runAgent({ modelConfig, task, maxIterations, emit: (e) => events.push(e), keys });
    return { result, events };
  };
  const proseTask = { id: 'custom', title: 'Custom prompt', prompt: 'Summarize the attached report.', testCases: [], attachments: [] };
  await check('agent: one Haiku 5.5 call with a 150K-token prompt costs (150K x $0.50 + 2K x $2.50) / 1M = $0.08', async () => {
    claudeQueue = [{ input: 150000, output: 2000, text: 'Long-context summary.' }];
    const { result, events } = await runOnce(haiku, proseTask, OWN_CLAUDE);
    assert.strictEqual(result.promptTokens, 150000);
    assert.strictEqual(result.completionTokens, 2000);
    assert.strictEqual(result.costUsd, 0.08, 'flat base pricing would be $0.016');
    assert.deepStrictEqual(result.price, { input: 0.10, output: 0.50 }, 'the result keeps the base price');
    assert.strictEqual(events.find((e) => e.type === 'metrics').costUsd, 0.08);
    const delta = events.find((e) => e.type === 'delta');
    assert.ok(delta, 'a live delta was emitted');
    assert.ok(delta.costUsd >= 0.075 && delta.costUsd <= 0.08, `live estimate prices the known 150K prompt at the tier: ${delta.costUsd}`);
  });
  await check('agent: the same call with a 50K-token prompt stays on the base rate ($0.006)', async () => {
    claudeQueue = [{ input: 50000, output: 2000, text: 'Short summary.' }];
    const { result } = await runOnce(haiku, proseTask, OWN_CLAUDE);
    assert.strictEqual(result.costUsd, 0.006);
  });
  await check('agent: a multi-round task sums per-call costs, each call at its own prompt tier', async () => {
    const task = {
      id: 't-add', title: 'add', prompt: 'Write add(a, b).', language: 'javascript', functionName: 'add', attachments: [],
      testCases: [{ input: [1, 2], expected: 3 }, { input: [5, 5], expected: 10 }],
    };
    claudeQueue = [
      { input: 90000, output: 1000, text: '```javascript\nfunction add(a, b) { return a - b; }\n```' },
      { input: 120000, output: 1500, text: '```javascript\nfunction add(a, b) { return a + b; }\n```' },
    ];
    const { result, events } = await runOnce(haiku, task, OWN_CLAUDE, 3);
    assert.strictEqual(result.iterations, 2);
    assert.strictEqual(result.solved, true);
    assert.strictEqual(result.promptTokens, 210000);
    // call 1: 90K prompt (base) $0.0095; call 2: 120K prompt (tier) $0.06375.
    // Pricing the summed tokens at one rate would give $0.02225 (base) or $0.11125 (tier).
    assert.strictEqual(result.costUsd, 0.07325);
    assert.deepStrictEqual(events.filter((e) => e.type === 'metrics').map((e) => e.costUsd), [0.0095, 0.07325], 'cumulative per-call cost after each round');
    const deltas = events.filter((e) => e.type === 'delta');
    const d1 = deltas.find((e) => e.iteration === 1);
    const d2 = deltas.find((e) => e.iteration === 2);
    assert.ok(d1 && d2, 'a live delta in each round');
    assert.ok(d1.costUsd >= 0.009 && d1.costUsd < 0.0095, `round 1 live: 90K prompt at the base rate: ${d1.costUsd}`);
    assert.ok(d2.costUsd >= 0.0095 + 0.06 && d2.costUsd < 0.07325, `round 2 live: prior call + 120K prompt at the tier: ${d2.costUsd}`);
  });
  await check('agent: before the provider reports the prompt size, our estimate picks the live tier (input lands later)', async () => {
    // A test-only tiered config on Gemini's stream, whose first chunk carries no usage.
    const tiered = { ...pricing.modelFromCatalog('A', 'gemini-3.8-flash'), priceTiers: [{ minPromptTokens: 10, input: 10, output: 100 }] };
    const savedRoutes = routes;
    routes = {
      [VERTEX]: () => sse([
        { candidates: [{ content: { parts: [{ text: 'Hello there, this is a mock answer.' }] } }] },
        { candidates: [{ content: { parts: [{ text: '' }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } },
      ]),
    };
    try {
      const { result, events } = await runOnce(tiered, proseTask, { agentplatform: 'own-vertex-key-unit' });
      const delta = events.find((e) => e.type === 'delta');
      assert.ok(delta, 'a live delta was emitted without a prompt count');
      near(delta.costUsd, +((100 * delta.estOutTokens) / 1e6).toFixed(6), 'live = output tokens at the estimated tier, no input yet');
      assert.strictEqual(result.costUsd, +((10 * 40 + 100 * 9) / 1e6).toFixed(6), 'final cost uses the reported prompt size');
    } finally {
      routes = savedRoutes;
    }
  });
  await check('judge: per-call usage is reported, so a safety retry is priced call by call', async () => {
    const score = (id, v) => ({ id, completeness: v, accuracy: v, structure: v, actionability: v, cost: v, speed: v, note: 'ok' });
    claudeQueue = [
      { input: 60000, output: 100, text: '', stopReason: 'refusal' },
      { input: 60000, output: 900, text: JSON.stringify({ scores: [score('A', 8), score('B', 6)], winner: 'A', why: 'A is more complete.' }) },
    ];
    const verdict = await judgeOutputs({
      task: { id: 'custom', title: 'Custom prompt', prompt: 'Compare the plans.', testCases: [] },
      entries: [{ slot: 'A', label: 'Model A', text: 'Plan A in detail.' }, { slot: 'B', label: 'Model B', text: 'Plan B in brief.' }],
      judge: haiku,
      keys: OWN_CLAUDE,
    });
    assert.deepStrictEqual(verdict.usage.calls, [{ promptTokens: 60000, completionTokens: 100 }, { promptTokens: 60000, completionTokens: 900 }]);
    assert.strictEqual(verdict.usage.promptTokens, 120000, 'the summed totals are unchanged');
    const perCall = verdict.usage.calls.reduce((s, c) => s + pricing.callCostUsd(haiku, c.promptTokens, c.completionTokens), 0);
    near(perCall, 0.0125, 'two 60K-prompt calls stay on the base rate');
    near(pricing.callCostUsd(haiku, verdict.usage.promptTokens, verdict.usage.completionTokens), 0.0625, 'pricing the summed tokens would wrongly hit the 100K+ tier');
  });

  // ---- 3. Spend basis: peek / spentFor / summarize ------------------------------------
  const fakeKeys = {};
  globalKeys.get = (name) => fakeKeys[name] || '';
  await check('spentFor = max(app spend, provider month-to-date spend when its spend API answered)', () => {
    assert.strictEqual(providerBilling.spentFor(null, 5), 5);
    assert.strictEqual(providerBilling.spentFor({ kind: 'spend', ok: true, usd: 3 }, 5), 5, 'provider below app: app');
    assert.strictEqual(providerBilling.spentFor({ kind: 'spend', ok: true, usd: 9 }, 5), 9, 'provider above app: provider');
    assert.strictEqual(providerBilling.spentFor({ kind: 'spend', ok: false, usd: 99, error: 'x' }, 5), 5, 'a failed provider read is ignored');
    assert.strictEqual(providerBilling.spentFor({ kind: 'balance', ok: true, usd: 99 }, 5), 5, 'a balance is never spend');
    assert.strictEqual(providerBilling.spentFor({ kind: 'none', ok: false }, 0), 0);
    assert.strictEqual(providerBilling.spentFor(undefined, undefined), 0);
  });
  await check('summarize uses the same max: basis = provider only when its number is the larger one; budgetUsedUp at spend >= budget', () => {
    const app = { usd: 12.5, calls: 3 };
    let r = providerBilling.summarize({ id: 'openai', label: 'OpenAI', app, view: { kind: 'spend', ok: true, usd: 4 }, budgetUsd: 100 });
    assert.strictEqual(r.basis, 'app');
    assert.strictEqual(r.spentUsd, 12.5);
    assert.strictEqual(r.remainingUsd, 87.5);
    assert.strictEqual(r.budgetUsedUp, false);
    r = providerBilling.summarize({ id: 'openai', label: 'OpenAI', app, view: { kind: 'spend', ok: true, usd: 12.5 }, budgetUsd: 12.5 });
    assert.strictEqual(r.basis, 'app', 'a tie reads as app spend');
    assert.strictEqual(r.budgetUsedUp, true, 'reaching the budget exactly uses it up');
    r = providerBilling.summarize({ id: 'openai', label: 'OpenAI', app, view: { kind: 'spend', ok: true, usd: 40 }, budgetUsd: 30 });
    assert.strictEqual(r.basis, 'provider');
    assert.strictEqual(r.spentUsd, 40);
    assert.strictEqual(r.remainingUsd, -10);
    assert.strictEqual(r.budgetUsedUp, true);
    r = providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app: { usd: 0, calls: 0 }, view: null, budgetUsd: 0 });
    assert.strictEqual(r.budgetUsedUp, true, 'a $0 budget is used up even with no spend');
    assert.strictEqual(providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app, view: null, budgetUsd: null }).budgetUsedUp, false, 'no budget, nothing to use up');
  });
  await check('peek: sync, no network; the cached view only while it is under an hour old', async () => {
    providerBilling.invalidate();
    assert.strictEqual(providerBilling.peek('openai'), null, 'nothing cached yet');
    fakeKeys.OPENAI_ADMIN_KEY = 'sk-admin-unit-test-key-0123456789';
    routes = { 'https://api.openai.com/v1/organization/costs': () => json(200, { data: [{ results: [{ amount: { value: 42.5 } }] }], has_more: false }) };
    calls.length = 0;
    await providerBilling.providerView('openai');
    assert.strictEqual(calls.length, 1);
    const p = providerBilling.peek('openai');
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.kind, 'spend');
    assert.strictEqual(p.usd, 42.5);
    assert.strictEqual(p.cached, true);
    assert.strictEqual(providerBilling.spentFor(p, 10), 42.5);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 59 * 60 * 1000;
      assert.ok(providerBilling.peek('openai'), 'still usable after 59 minutes');
      Date.now = () => realNow() + 61 * 60 * 1000;
      assert.strictEqual(providerBilling.peek('openai'), null, 'too old after an hour');
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(calls.length, 1, 'peek never fetches');
    await providerBilling.providerView('vertex');
    assert.strictEqual(providerBilling.peek('vertex').kind, 'none');
    assert.strictEqual(providerBilling.spentFor(providerBilling.peek('vertex'), 3), 3);
  });
  global.fetch = realFetch;

  // ---- 4. HTTP enforcement (spawned server) --------------------------------------------
  const preload = path.join(tmp, 'mock-upstream.js');
  const costsLog = path.join(tmp, 'openai-costs-calls.log');
  // Runs inside the spawned server (via NODE_OPTIONS=--require), so it must be self-contained.
  function mockUpstream() {
    const fsx = require('fs');
    const nativeFetch = globalThis.fetch;
    const reply = (body, type) => new Response(body, { status: 200, headers: { 'Content-Type': type } });
    const events = (list) => reply(list.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), 'text/event-stream');
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return nativeFetch(url, init);
      if (u.hostname === 'api.openai.com' && u.pathname === '/v1/organization/costs') {
        if (process.env.LLMC_TEST_COSTS_LOG) fsx.appendFileSync(process.env.LLMC_TEST_COSTS_LOG, 'x');
        return reply(JSON.stringify({ data: [{ results: [{ amount: { value: 60, currency: 'usd' } }] }], has_more: false }), 'application/json');
      }
      if (u.hostname === 'aiplatform.googleapis.com') {
        if (u.pathname.includes(':streamGenerateContent')) {
          return events([{ candidates: [{ content: { parts: [{ text: 'Mock answer.' }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } }]);
        }
        if (u.pathname.endsWith('/claude-haiku-5-5:streamRawPredict')) {
          return events([
            { type: 'message_start', message: { usage: { input_tokens: 150000 } } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Mock Haiku answer.' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2000 } },
          ]);
        }
        if (u.pathname.endsWith('/claude-haiku-5-5:rawPredict')) {
          const score = (id, v) => ({ id, completeness: v, accuracy: v, structure: v, actionability: v, cost: v, speed: v, note: 'mock' });
          const verdict = { scores: [score('A', 8), score('B', 6)], winner: 'A', why: 'Mock verdict.' };
          return reply(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn', usage: { input_tokens: 150000, output_tokens: 1000 } }), 'application/json');
        }
      }
      throw new Error('blocked in test: ' + u.hostname);
    };
  }
  fs.writeFileSync(preload, `(${mockUpstream.toString()})();\n`);
  const authDir = path.join(tmp, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  // $5 already spent on the global Vertex key this month.
  fs.writeFileSync(path.join(authDir, 'spend-ledger.json'), JSON.stringify({
    since: `${month}-01T00:00:00.000Z`, months: { [month]: { vertex: { usd: 5, calls: 3 } } },
  }));
  const PORT = Number(process.env.BUDGET_ENFORCE_TEST_PORT || 18901);
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SECONDARY_PORT: '0',
    APP_DATA_DIR: path.join(tmp, 'data'), AUTH_DATA_DIR: authDir,
    ENABLE_CODE_EXEC: '0', GCLOUD_TOKEN_AUTOMINT: '0',
    // Hermetic: no Secret Manager, and blank values so a local .env can't add real keys.
    GLOBAL_KEYS_ENABLED: '0', GCP_PROJECT_ID: '',
    ANTHROPIC_ADMIN_KEY: '', MOONSHOT_API_KEY: '', ANTHROPIC_API_KEY: '',
    AGENT_PLATFORM_API_KEY: 'vertex-enforce-canary-0123', OPENAI_API_KEY: 'sk-enforcecanary0123456789',
    OPENAI_ADMIN_KEY: 'sk-admin-enforce-unit-test-0123456789', // answered by the preload ($60 org spend)
    CLAUDE_BEARER_TOKEN: 'unit-test-claude-token-0123',        // shared Claude credential (mocked upstream)
    RATE_LIMIT_EXEMPT_ADMINS: '1',
    LLMC_TEST_COSTS_LOG: costsLog,
    NODE_OPTIONS: `--require ${preload}`,
  };
  delete env.K_SERVICE; delete env.ANTIGRAVITY_SIDECAR_WEB_PORT; delete env.ADMIN_EMAILS;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (_) { /* ignore */ } });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch (_) { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { console.error('server did not start\n' + out); process.exit(1); }

  let userCookie = '';
  const req = async (method, p, { body, as = 'admin' } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (as === 'user' && userCookie) headers.Cookie = userCookie;
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie');
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, json: parsed, text, setCookie };
  };
  const ndjson = (r) => r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spendRow = async (id) => (await req('GET', '/api/admin/spend')).json.providers.find((p) => p.id === id);
  const quotasToday = async () => (await req('GET', '/api/config', { as: 'user' })).json.me.quotas;
  const setBudgets = async (budgets) => {
    const r = await req('POST', '/api/admin/settings', { body: { budgets } });
    assert.strictEqual(r.status, 200, 'save budgets: ' + JSON.stringify(r.json));
    return r.json.settings.budgets;
  };
  const GEMINI = [{ slot: 'A', catalogId: 'gemini-3.8-flash' }];
  const textRun = (as, models, keys) => req('POST', '/api/run', { as, body: { taskId: 'custom', customPrompt: 'Say hi.', models, ...(keys ? { keys } : {}) } });
  const expectMonthlyBlock = (r, provider) => {
    assert.strictEqual(r.status, 429, `expected a 429, got ${r.status}: ${r.text.slice(0, 300)}`);
    const b = r.json;
    assert.strictEqual(b.monthlyBudgetExhausted, true);
    assert.strictEqual(b.quotaExhausted, true);
    assert.strictEqual(b.provider, provider);
    assert.strictEqual(b.openaiQuotaExhausted, provider === 'openai');
    assert.strictEqual(b.externalQuotaExhausted, provider !== 'vertex');
    assert.strictEqual(b.vertexQuotaExhausted, provider === 'vertex');
    assert.ok(b.quotas && b.quotas.vertex && b.quotas.openai, 'quota snapshot included (same shape as the daily limits)');
    assert.ok(typeof b.budgetUsd === 'number' && typeof b.spentUsd === 'number' && b.spentUsd >= b.budgetUsd, JSON.stringify(b));
    assert.ok(!/\u2014/.test(b.error), 'no em dash in the error text');
    return b;
  };

  // A normal (non-admin) account; loopback requests without a cookie are the admin.
  let r = await req('POST', '/api/auth/users', { body: { username: 'enforce.user', password: 'EnforcePassw0rd!', role: 'user', mustChangePassword: false } });
  assert.ok(r.status === 200, 'create test user: ' + JSON.stringify(r.json));
  r = await req('POST', '/api/auth/login', { body: { username: 'enforce.user', password: 'EnforcePassw0rd!' } });
  userCookie = (r.setCookie || '').split(';')[0];
  assert.ok(userCookie, 'login cookie');

  await check('a $0 budget blocks a global key even with no spend this month (OpenAI text run -> 429, nothing charged)', async () => {
    assert.deepStrictEqual(await setBudgets({ openai: 0 }), { openai: 0, anthropic: null, moonshot: null, vertex: null });
    const b = expectMonthlyBlock(await textRun('user', [{ slot: 'A', catalogId: 'gpt-5.4' }]), 'openai');
    assert.strictEqual(b.budgetUsd, 0);
    assert.strictEqual(b.spentUsd, 0);
    assert.match(b.error, /^The shared OpenAI key has a \$0 monthly budget, so runs on it are turned off\. Add your own OpenAI key under Your API keys to keep going, or ask an admin to raise the budget in Settings\.$/);
    assert.strictEqual((await quotasToday()).openai.used, 0, 'the daily OpenAI run was not consumed');
    await setBudgets({ openai: null });
  });
  await check('/api/config: the browser catalog carries Haiku 5.5\'s priceTiers and 1M context (other models have none)', async () => {
    const c = (await req('GET', '/api/config', { as: 'user' })).json;
    const h = c.catalog.find((m) => m.id === 'claude-haiku-5-5');
    assert.deepStrictEqual(h.priceTiers, HAIKU_TIERS);
    assert.strictEqual(h.context, 1000000);
    assert.ok(!c.catalog.find((m) => m.id === 'gemini-3.8-flash').priceTiers);
  });
  await check('Settings: seeded Vertex spend, no budget = nothing used up', async () => {
    const v = await spendRow('vertex');
    assert.deepStrictEqual(v.app, { usd: 5, calls: 3 });
    assert.strictEqual(v.budgetUsedUp, false);
  });
  await check('a used-up Vertex budget: non-admin global-key text run -> 429 before anything is charged or run', async () => {
    await setBudgets({ vertex: 5 });
    const v = await spendRow('vertex');
    assert.strictEqual(v.budgetUsedUp, true, 'Settings shows it used up');
    assert.strictEqual(v.remainingUsd, 0);
    const b = expectMonthlyBlock(await textRun('user', GEMINI), 'vertex');
    assert.strictEqual(b.budgetUsd, 5);
    assert.strictEqual(b.spentUsd, 5);
    assert.match(b.error, /^The shared Vertex AI key has used this month's budget \(\$5\.00 of \$5\.00\)\. Add your own Vertex AI key or token under Your API keys to keep going, or ask an admin to raise the budget in Settings\.$/);
    assert.strictEqual(b.quotas.vertex.used, 0);
    assert.strictEqual((await quotasToday()).vertex.used, 0, 'the daily Vertex run was not consumed');
    assert.deepStrictEqual((await spendRow('vertex')).app, { usd: 5, calls: 3 }, 'no model was called');
    assert.match(out, /\[budget\] blocked a text run for enforce\.user: the Vertex AI monthly budget is used up/, 'a NOTICE line is logged');
  });
  await check("the same run on the user's own Vertex key is not blocked (and not counted)", async () => {
    const res = await textRun('user', GEMINI, { agentplatform: 'own-vertex-key-unit' });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.ok(ndjson(res).find((l) => l.type === 'done'), 'own-key run finished');
    assert.strictEqual((await quotasToday()).vertex.used, 0);
    assert.deepStrictEqual((await spendRow('vertex')).app, { usd: 5, calls: 3 });
  });
  await check('admins are exempt (same rule as the daily limits)', async () => {
    const res = await textRun('admin', GEMINI);
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.ok(ndjson(res).find((l) => l.type === 'done'), 'admin run finished');
    const app = (await spendRow('vertex')).app;
    assert.strictEqual(app.calls, 4);
    near(app.usd, 5.002625, 'the admin run on the global key still adds to the spend');
  });
  await check('the Blind Judge, image reserve and a stand-alone image run are blocked the same way', async () => {
    const judge = await req('POST', '/api/judge', { as: 'user', body: {
      taskId: 'custom', prompt: 'Compare.', judge: 'gemini-3.8-flash',
      entries: [{ slot: 'A', label: 'A', text: 'Answer A.' }, { slot: 'B', label: 'B', text: 'Answer B.' }],
    } });
    expectMonthlyBlock(judge, 'vertex');
    const reserve = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'gemini-nano-banana-2.1' }] } });
    expectMonthlyBlock(reserve, 'vertex');
    assert.strictEqual(reserve.json.ok, false);
    expectMonthlyBlock(await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'zz-unknown-1' }], prompt: 'x' } }), 'vertex');
    assert.strictEqual((await quotasToday()).vertex.used, 0, 'nothing was charged');
  });
  await check('image: an own-key reserve passes; its slot sent without the key needs a top-up and is blocked', async () => {
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'zz-unknown-1' }], keys: { agentplatform: 'own-key' } } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.charged, []);
    const slot = await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'zz-unknown-1' }], prompt: 'x', ticket: res.json.ticket } });
    expectMonthlyBlock(slot, 'vertex');
    assert.strictEqual((await quotasToday()).vertex.used, 0);
  });
  await check('raising the budget unblocks right away', async () => {
    await setBudgets({ vertex: 6 });
    assert.strictEqual((await spendRow('vertex')).budgetUsedUp, false);
    const res = await textRun('user', GEMINI);
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.ok(ndjson(res).find((l) => l.type === 'done'));
    assert.strictEqual((await quotasToday()).vertex.used, 1, 'a normal run again: one daily Vertex run');
  });
  await check('a ticketed image slot approved at reserve is not re-blocked if the budget runs out meanwhile', async () => {
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'zz-unknown-1' }] } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.charged, ['vertex']);
    await setBudgets({ vertex: 0 });
    const slot = await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [{ slot: 'A', catalogId: 'zz-unknown-1' }], prompt: 'x', ticket: res.json.ticket } });
    assert.strictEqual(slot.status, 200, slot.text.slice(0, 300));
    assert.strictEqual(slot.json.results[0].ok, false, 'unknown model fails on its own slot (no upstream call)');
    assert.strictEqual((await quotasToday()).vertex.used, 2);
  });
  await check('budget 0 blocks the key (with spend on it)', async () => {
    const b = expectMonthlyBlock(await textRun('user', GEMINI), 'vertex');
    assert.strictEqual(b.budgetUsd, 0);
    assert.match(b.error, /^The shared Vertex AI key has a \$0 monthly budget, so runs on it are turned off\. Add your own Vertex AI key or token/);
    assert.strictEqual((await spendRow('vertex')).budgetUsedUp, true);
  });
  await check('clearing the budget (blank) unblocks right away', async () => {
    assert.strictEqual((await setBudgets({ vertex: null })).vertex, null);
    const res = await textRun('user', GEMINI);
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.ok(ndjson(res).find((l) => l.type === 'done'));
    assert.strictEqual((await quotasToday()).vertex.used, 3);
  });
  await check('provider-reported org spend above the app spend counts too, from the cached view (no provider call on the run path)', async () => {
    let o = await spendRow('openai');
    assert.strictEqual(o.provider.ok, true);
    assert.strictEqual(o.provider.usd, 60);
    assert.strictEqual(o.basis, 'provider');
    await setBudgets({ openai: 50 });
    o = await spendRow('openai');
    assert.strictEqual(o.spentUsd, 60);
    assert.strictEqual(o.remainingUsd, -10);
    assert.strictEqual(o.budgetUsedUp, true);
    const b = expectMonthlyBlock(await textRun('user', [{ slot: 'A', catalogId: 'gpt-5.4' }, { slot: 'B', catalogId: 'gemini-3.8-flash' }]), 'openai');
    assert.strictEqual(b.spentUsd, 60, 'the app has tracked $0 on OpenAI: the provider number decided');
    assert.strictEqual(b.budgetUsd, 50);
    assert.match(b.error, /^The shared OpenAI key has used this month's budget \(\$60\.00 of \$50\.00\)\. Add your own OpenAI key under Your API keys to keep going/);
    const q = await quotasToday();
    assert.strictEqual(q.openai.used, 0);
    assert.strictEqual(q.vertex.used, 3, 'the Vertex slot was not charged either (all or nothing)');
    assert.strictEqual(fs.readFileSync(costsLog, 'utf8').length, 1, 'only the first Settings view called the OpenAI Costs API');
    await setBudgets({ openai: 100 });
    assert.strictEqual((await spendRow('openai')).budgetUsedUp, false, 'raised: no longer used up');
  });
  await check('a Claude Haiku 5.5 text run with a 150K-token prompt is billed at the 100K+ rate (result + ledger)', async () => {
    const before = (await spendRow('vertex')).app;
    const res = await textRun('admin', [{ slot: 'A', catalogId: 'claude-haiku-5-5' }]);
    const done = ndjson(res).find((l) => l.type === 'done');
    assert.ok(done, 'Haiku run finished: ' + res.text.slice(-400) + '\n' + out.slice(-1500));
    assert.strictEqual(done.result.costUsd, 0.08);
    assert.deepStrictEqual(done.result.price, { input: 0.10, output: 0.50 });
    const after = (await spendRow('vertex')).app;
    assert.strictEqual(after.calls, before.calls + 1);
    near(after.usd - before.usd, 0.08, 'ledger delta');
  });
  await check('the Blind Judge on Claude Haiku 5.5 is billed per call at its prompt tier', async () => {
    const before = (await spendRow('vertex')).app;
    const res = await req('POST', '/api/judge', { body: {
      taskId: 'custom', prompt: 'Compare.', judge: 'claude-haiku-5-5',
      entries: [{ slot: 'A', label: 'A', text: 'Answer A.' }, { slot: 'B', label: 'B', text: 'Answer B.' }],
    } });
    assert.strictEqual(res.status, 200, res.text.slice(0, 400));
    assert.strictEqual(res.json.winnerSlot !== undefined, true);
    assert.deepStrictEqual(res.json.usage.calls, [{ promptTokens: 150000, completionTokens: 1000 }]);
    const after = (await spendRow('vertex')).app;
    assert.strictEqual(after.calls, before.calls + 1);
    near(after.usd - before.usd, 0.0775, '150K x $0.50 + 1K x $2.50 per 1M (flat would be $0.0155)');
  });

  try { srv.kill('SIGTERM'); } catch (_) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`\nverify-budget-enforcement: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
