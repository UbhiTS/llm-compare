// ---------------------------------------------------------------------------
// verify-spend-budgets.js: spend on the global keys this month vs monthly budgets.
//
// Rules under test (v1.0.41):
//   - Settings stores an optional monthly USD budget per provider (blank = none).
//   - The app adds what every model call on a GLOBAL key cost to the current UTC
//     month, per provider (own-key calls never count), and persists it next to
//     settings.json so it survives deploys.
//   - Provider numbers where an API exists: OpenAI Costs API and Anthropic cost
//     report (admin keys, month to date), Moonshot live balance; Vertex AI has none.
//     Cached 10 min, a forced refresh at most once a minute, errors scrubbed, never throws.
//   - Remaining = budget minus the provider's month-to-date spend when its spend API
//     answered, else budget minus the app-tracked spend.
// Offline: provider HTTP is mocked in-process (global.fetch) and, in the spawned
// server, by a --require preload that answers Vertex Gemini calls and blocks every
// other external host.
//   node test/verify-spend-budgets.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-spend-'));
process.env.AUTH_DATA_DIR = path.join(tmp, 'auth-unit');
process.env.APP_DATA_DIR = path.join(tmp, 'data-unit');
delete process.env.ADMIN_EMAILS;
for (const k of ['OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY', 'MOONSHOT_API_KEY', 'GCP_PROJECT_ID']) delete process.env[k];

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; process.exitCode = 1; console.error(`✗ ${name}\n  ${(e && e.stack) || e}`); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || 'value'}: ${a} != ${b}`);

const appSettings = require('../src/appSettings');
const globalKeys = require('../src/globalKeys');
const providerBilling = require('../src/providerBilling');
const LEDGER_MODULE = require.resolve('../src/spendLedger');
let spendLedger = require('../src/spendLedger');

// providerBilling reads globalKeys.get() at call time, so the unit tests can hand it keys.
const fakeKeys = {};
globalKeys.get = (name) => fakeKeys[name] || '';

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

(async () => {
  // ---- 1. Monthly budgets in Settings ---------------------------------------------
  await check('budgets default to none for every provider', () => {
    assert.deepStrictEqual(appSettings.get().budgets, { openai: null, anthropic: null, moonshot: null, vertex: null });
  });
  await check('budgets: dollars from 0 to 1,000,000, rounded to cents; bad input changes nothing', () => {
    for (const bad of [-1, 1000001, 'abc', NaN, Infinity]) {
      assert.throws(() => appSettings.update({ budgets: { openai: bad } }), /monthly budget/, `accepted ${String(bad)}`);
    }
    assert.throws(() => appSettings.update({ budgets: 5 }), /Budgets must be an object/);
    assert.strictEqual(appSettings.get().budgets.openai, null, 'a rejected update must not change anything');
    const s = appSettings.update({ budgets: { openai: 12.3456, vertex: '250', anthropic: 0 } }, { actor: 'ubhi@google.com' });
    assert.deepStrictEqual(s.budgets, { openai: 12.35, anthropic: 0, moonshot: null, vertex: 250 });
    assert.strictEqual(s.updatedBy, 'ubhi@google.com');
  });
  await check('blank or null clears one budget; other budgets and the daily limits are untouched', () => {
    let s = appSettings.update({ budgets: { openai: '' } });
    assert.strictEqual(s.budgets.openai, null);
    assert.strictEqual(s.budgets.vertex, 250);
    s = appSettings.update({ budgets: { anthropic: null } });
    assert.strictEqual(s.budgets.anthropic, null);
    s = appSettings.update({ limits: { openai: 3 } });
    assert.strictEqual(s.budgets.vertex, 250, 'saving limits keeps the budgets');
    assert.deepStrictEqual(s.limits, { openai: 3, anthropic: 3, moonshot: 3, vertex: 10 });
    const onDisk = JSON.parse(fs.readFileSync(appSettings.SETTINGS_FILE, 'utf8'));
    assert.strictEqual(onDisk.budgets.vertex, 250, 'budgets persist in settings.json');
  });
  await check('spend buckets: OpenAI, Anthropic and Moonshot direct; everything on Vertex AI (Gemini, Claude, partner MaaS) is vertex', () => {
    assert.strictEqual(appSettings.budgetBucket({ provider: 'openai' }), 'openai');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'anthropic' }), 'anthropic');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'moonshot' }), 'moonshot');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'agentplatform', publisher: 'google' }), 'vertex');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'agentplatform', publisher: 'anthropic' }), 'vertex');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'agentplatform', endpointType: 'openai-maas' }), 'vertex');
    assert.strictEqual(appSettings.budgetBucket({ provider: 'gemini' }), 'vertex');
    assert.strictEqual(appSettings.budgetBucket(undefined), 'vertex');
  });

  // ---- 2. App-tracked spend ledger --------------------------------------------------
  const month = spendLedger.monthKey();
  await check('global-key calls add to this month per provider; own-key calls never do', () => {
    assert.strictEqual(spendLedger.monthToDate().since, null, 'nothing tracked yet');
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'openai' }, {}, 0.0125), true);
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'openai', publisher: 'openai' }, null, 0.5), true, 'image results carry provider + publisher');
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'agentplatform', publisher: 'anthropic' }, { agentplatform: 'own-vertex-key' }, 2), true,
      'Claude on Vertex runs on OAuth, so an own Gemini key does not cover it');
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'agentplatform', publisher: 'google' }, { agentplatform: 'own-vertex-key' }, 9), false, 'own Vertex key');
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'openai' }, { openai: 'sk-own' }, 9), false, 'own OpenAI key');
    assert.strictEqual(spendLedger.recordModelCost({ provider: 'agentplatform', publisher: 'anthropic' }, { claudeBearerToken: 'own-vertex-oauth-token' }, 9), false, 'own Vertex OAuth token');
    for (const bad of [0, -1, NaN, 'x', undefined]) assert.strictEqual(spendLedger.recordModelCost({ provider: 'openai' }, {}, bad), false, `cost ${String(bad)}`);
    assert.strictEqual(spendLedger.recordModelCost(null, {}, 1), false, 'no model');
    const m = spendLedger.monthToDate();
    assert.strictEqual(m.month, month);
    assert.deepStrictEqual(m.providers.openai, { usd: 0.5125, calls: 2 });
    assert.deepStrictEqual(m.providers.vertex, { usd: 2, calls: 1 });
    assert.deepStrictEqual(m.providers.anthropic, { usd: 0, calls: 0 });
    assert.ok(m.since && !Number.isNaN(Date.parse(m.since)), 'tracking start time is recorded');
  });
  await check('the ledger persists in AUTH_DATA_DIR and reloads after a restart (survives deploys)', () => {
    const file = path.join(process.env.AUTH_DATA_DIR, 'spend-ledger.json');
    assert.strictEqual(spendLedger.LEDGER_FILE, file);
    spendLedger.flushSync(); // writes are debounced (one per 2 s); flush the trailing write before reading the file
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.months[month].openai.calls, 2);
    delete require.cache[LEDGER_MODULE];
    spendLedger = require('../src/spendLedger');
    assert.deepStrictEqual(spendLedger.monthToDate().providers.openai, { usd: 0.5125, calls: 2 });
  });
  await check('the ledger keeps the last 13 months and ignores junk on disk', () => {
    const file = spendLedger.LEDGER_FILE;
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i < 15; i++) obj.months[new Date(Date.UTC(2001, i, 1)).toISOString().slice(0, 7)] = { openai: { usd: 1, calls: 1 } };
    obj.months.garbage = { openai: { usd: 5, calls: 5 } };
    obj.months['2002-06'] = { vertex: { usd: -4, calls: 'x' } };
    fs.writeFileSync(file, JSON.stringify(obj));
    delete require.cache[LEDGER_MODULE];
    spendLedger = require('../src/spendLedger');
    assert.deepStrictEqual(spendLedger.monthToDate('2002-06').providers.vertex, { usd: 0, calls: 0 }, 'negative / non-numeric values read as 0');
    spendLedger.recordModelCost({ provider: 'moonshot' }, {}, 0.25);
    spendLedger.flushSync();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(after.months).sort();
    assert.strictEqual(keys.length, 13);
    assert.ok(!keys.includes('garbage'));
    assert.ok(!keys.includes('2001-01'), 'oldest months are dropped first');
    assert.strictEqual(keys[keys.length - 1], month, 'the current month is kept');
    assert.deepStrictEqual(after.months[month].moonshot, { usd: 0.25, calls: 1 });
  });

  // ---- 3. Provider-reported numbers (mocked HTTP) -------------------------------------
  const NOW = new Date('2026-10-15T12:00:00Z');
  await check('OpenAI Costs API: admin key as Bearer, from the 1st of the month, sums every daily bucket across pages', async () => {
    calls.length = 0;
    routes = {
      'https://api.openai.com/v1/organization/costs': (u) => (new URL(u).searchParams.get('page') === 'p2'
        ? json(200, { data: [{ results: [{ amount: { value: 3, currency: 'usd' } }] }], has_more: false, next_page: null })
        : json(200, { data: [{ results: [{ amount: { value: 1.25 } }, { amount: { value: 0.75 } }] }, { results: [] }], has_more: true, next_page: 'p2' })),
    };
    const usd = await providerBilling.openaiMonthToDate('sk-admin-unit-test-key-0123456789', NOW);
    near(usd, 5, 'OpenAI month to date');
    assert.strictEqual(calls.length, 2);
    const q = new URL(calls[0].url).searchParams;
    assert.strictEqual(q.get('start_time'), String(Date.UTC(2026, 9, 1) / 1000));
    assert.strictEqual(q.get('bucket_width'), '1d');
    assert.strictEqual(q.get('page'), null);
    assert.strictEqual(new URL(calls[1].url).searchParams.get('page'), 'p2');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer sk-admin-unit-test-key-0123456789');
  });
  await check('Anthropic cost report: x-api-key + anthropic-version, amounts are cents as decimal strings', async () => {
    calls.length = 0;
    routes = { 'https://api.anthropic.com/v1/organizations/cost_report': () => json(200, { data: [{ results: [{ amount: '123.45', currency: 'USD' }, { amount: '76.55' }] }], has_more: false }) };
    const usd = await providerBilling.anthropicMonthToDate('sk-ant-admin01-unit', NOW);
    near(usd, 2, 'Anthropic month to date');
    assert.strictEqual(new URL(calls[0].url).searchParams.get('starting_at'), '2026-10-01T00:00:00.000Z');
    assert.strictEqual(calls[0].headers['x-api-key'], 'sk-ant-admin01-unit');
    assert.strictEqual(calls[0].headers['anthropic-version'], '2023-06-01');
  });
  await check('Moonshot balance API: available, voucher and cash from the normal key', async () => {
    routes = { 'https://api.moonshot.ai/v1/users/me/balance': () => json(200, { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true }) };
    assert.deepStrictEqual(await providerBilling.moonshotBalance('sk-moonshot-unit'), { available: 49.58894, voucher: 46.58893, cash: 3.00001 });
    routes = { 'https://api.moonshot.ai/v1/users/me/balance': () => json(200, { code: 0, data: {} }) };
    await assert.rejects(() => providerBilling.moonshotBalance('sk-moonshot-unit'), /no balance/);
  });
  await check('provider views: Vertex has no API (app spend only); a missing admin key names the key to add; no HTTP made', async () => {
    calls.length = 0;
    providerBilling.invalidate();
    const v = await providerBilling.providerView('vertex');
    assert.strictEqual(v.kind, 'none');
    assert.strictEqual(v.ok, false);
    assert.match(v.note, /BigQuery/);
    const o = await providerBilling.providerView('openai');
    assert.strictEqual(o.kind, 'spend');
    assert.strictEqual(o.ok, false);
    assert.strictEqual(o.needsKey, 'OPENAI_ADMIN_KEY');
    assert.strictEqual((await providerBilling.providerView('anthropic')).needsKey, 'ANTHROPIC_ADMIN_KEY');
    const m = await providerBilling.providerView('moonshot');
    assert.strictEqual(m.kind, 'balance');
    assert.match(m.note, /No global Moonshot key/);
    assert.strictEqual(calls.length, 0);
  });
  await check('provider views: cached 10 min; a forced refresh at most once a minute; invalidate() drops the cache', async () => {
    fakeKeys.OPENAI_ADMIN_KEY = 'sk-admin-unit-test-key-0123456789';
    routes = { 'https://api.openai.com/v1/organization/costs': () => json(200, { data: [{ results: [{ amount: { value: 7.5 } }] }], has_more: false }) };
    let v = await providerBilling.providerView('openai');
    assert.strictEqual(v.needsKey, 'OPENAI_ADMIN_KEY', 'the no-key answer stays cached until invalidated');
    providerBilling.invalidate('openai');
    calls.length = 0;
    v = await providerBilling.providerView('openai');
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.usd, 7.5);
    assert.strictEqual(v.cached, false);
    assert.match(v.source, /OpenAI Costs API/);
    v = await providerBilling.providerView('openai', { force: true });
    assert.strictEqual(v.cached, true, 'a forced refresh inside a minute is served from cache');
    assert.strictEqual(calls.length, 1);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61 * 1000;
      assert.strictEqual((await providerBilling.providerView('openai')).cached, true, 'without force it is still fresh after a minute');
      assert.strictEqual((await providerBilling.providerView('openai', { force: true })).cached, false, 'a forced refresh after a minute re-queries');
      Date.now = () => realNow() + 72 * 60 * 1000;
      assert.strictEqual((await providerBilling.providerView('openai')).cached, false, 'stale after 10 minutes');
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(calls.length, 3);
  });
  await check('provider errors are scrubbed (the key is never echoed back) and never throw', async () => {
    providerBilling.invalidate();
    routes = { 'https://api.openai.com/v1/organization/costs': () => json(401, { error: { message: 'Incorrect API key provided: sk-admin-unit-test-key-0123456789. See https://platform.openai.com/account/api-keys?x=1', type: 'invalid_request_error' } }) };
    const v = await providerBilling.providerView('openai');
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /^401: Incorrect API key/);
    assert.ok(!v.error.includes('sk-admin-unit-test-key-0123456789'), v.error);
    routes = {}; // network down: every fetch throws
    fakeKeys.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-unit-test-key-0123456789';
    const a = await providerBilling.providerView('anthropic');
    assert.strictEqual(a.ok, false);
    assert.match(a.error, /unexpected fetch/);
  });
  await check('remaining = budget minus the provider month-to-date spend when it answered, else minus the app spend', () => {
    const app = { usd: 12.5, calls: 3 };
    let r = providerBilling.summarize({ id: 'openai', label: 'OpenAI', app, view: { kind: 'spend', ok: true, usd: 40 }, budgetUsd: 100, globalKey: true });
    assert.strictEqual(r.basis, 'provider');
    assert.strictEqual(r.spentUsd, 40);
    assert.strictEqual(r.remainingUsd, 60);
    assert.strictEqual(r.usedPct, 40);
    assert.strictEqual(r.globalKey, true);
    r = providerBilling.summarize({ id: 'openai', label: 'OpenAI', app, view: { kind: 'spend', ok: false, needsKey: 'OPENAI_ADMIN_KEY' }, budgetUsd: 100 });
    assert.strictEqual(r.basis, 'app');
    assert.strictEqual(r.remainingUsd, 87.5);
    assert.strictEqual(r.usedPct, 12.5);
    r = providerBilling.summarize({ id: 'moonshot', label: 'Moonshot', app, view: { kind: 'balance', ok: true, usd: 49.5 }, budgetUsd: 20 });
    assert.strictEqual(r.basis, 'app', 'a balance is shown as is, never treated as spend');
    assert.strictEqual(r.remainingUsd, 7.5);
    r = providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app, view: { kind: 'none', ok: false }, budgetUsd: null });
    assert.strictEqual(r.remainingUsd, null);
    assert.strictEqual(r.usedPct, null);
    r = providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app, view: { kind: 'none', ok: false }, budgetUsd: 10 });
    assert.strictEqual(r.remainingUsd, -2.5, 'over budget goes negative');
    assert.strictEqual(r.usedPct, 125);
    r = providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app, view: null, budgetUsd: 0 });
    assert.strictEqual(r.remainingUsd, -12.5);
    assert.strictEqual(r.usedPct, 100, 'a $0 budget is used up by any spend');
    assert.strictEqual(providerBilling.summarize({ id: 'vertex', label: 'Vertex AI', app: { usd: 0, calls: 0 }, view: null, budgetUsd: 0 }).usedPct, 0);
  });
  global.fetch = realFetch;

  // ---- 4. HTTP contract + end-to-end metering (spawned server) ------------------------
  // The preload answers Vertex Gemini streaming calls with a fixed token usage and
  // blocks every other external host, so the run below never leaves the machine.
  const preload = path.join(tmp, 'mock-upstream.js');
  fs.writeFileSync(preload, `
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
      if (/(^|\\.)aiplatform\\.googleapis\\.com$/.test(u.hostname) && u.pathname.includes(':streamGenerateContent')) {
        const chunk = { candidates: [{ content: { parts: [{ text: 'Mock answer.' }] } }], usageMetadata: { promptTokenCount: 400000, candidatesTokenCount: 200000 } };
        return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('blocked in test: ' + u.hostname);
    };
  `);
  const authDir = path.join(tmp, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  // Spend recorded before a deploy must still be there after it.
  fs.writeFileSync(path.join(authDir, 'spend-ledger.json'), JSON.stringify({
    since: '2026-10-01T00:00:00.000Z', months: { [month]: { anthropic: { usd: 1.5, calls: 2 } } },
  }));
  const PORT = Number(process.env.SPEND_TEST_PORT || 18898);
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SECONDARY_PORT: '0',
    APP_DATA_DIR: path.join(tmp, 'data'), AUTH_DATA_DIR: authDir,
    ENABLE_CODE_EXEC: '0', GCLOUD_TOKEN_AUTOMINT: '0',
    // Hermetic: no Secret Manager, and blank values so a local .env can't add real keys.
    GLOBAL_KEYS_ENABLED: '0', GCP_PROJECT_ID: '',
    OPENAI_ADMIN_KEY: '', ANTHROPIC_ADMIN_KEY: '', MOONSHOT_API_KEY: '', ANTHROPIC_API_KEY: '',
    AGENT_PLATFORM_API_KEY: 'vertex-spend-canary-0123', OPENAI_API_KEY: 'sk-spendcanary0123456789',
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
  const spendRow = async (id) => (await req('GET', '/api/admin/spend')).json.providers.find((p) => p.id === id);
  const runLines = async (body) => (await req('POST', '/api/run', { body })).text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // A normal (non-admin) account for the access check.
  let r = await req('POST', '/api/auth/users', { body: { username: 'spend.user', password: 'SpendPassw0rd!', role: 'user', mustChangePassword: false } });
  assert.ok(r.status === 200, 'create test user: ' + JSON.stringify(r.json));
  r = await req('POST', '/api/auth/login', { body: { username: 'spend.user', password: 'SpendPassw0rd!' } });
  userCookie = (r.setCookie || '').split(';')[0];
  assert.ok(userCookie, 'login cookie');

  await check('/api/admin/spend is admin-only', async () => {
    assert.strictEqual((await req('GET', '/api/admin/spend', { as: 'user' })).status, 403);
  });
  await check('/api/admin/spend: 4 providers, this month, spend from before the restart, provider hints', async () => {
    const s = await req('GET', '/api/admin/spend');
    assert.strictEqual(s.status, 200, JSON.stringify(s.json));
    assert.strictEqual(s.json.month, month);
    assert.deepStrictEqual(s.json.providers.map((p) => p.id), ['openai', 'anthropic', 'moonshot', 'vertex']);
    const by = Object.fromEntries(s.json.providers.map((p) => [p.id, p]));
    assert.deepStrictEqual(by.anthropic.app, { usd: 1.5, calls: 2 }, 'the persisted ledger survives a restart');
    assert.strictEqual(s.json.trackingSince, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(by.openai.provider.needsKey, 'OPENAI_ADMIN_KEY');
    assert.strictEqual(by.vertex.provider.kind, 'none');
    assert.strictEqual(by.openai.globalKey, true);
    assert.strictEqual(by.moonshot.globalKey, false);
    assert.strictEqual(by.vertex.budgetUsd, null);
    assert.strictEqual(by.vertex.remainingUsd, null);
  });
  await check('budgets save through Settings (validated) and drive Remaining', async () => {
    const bad = await req('POST', '/api/admin/settings', { body: { budgets: { openai: -5 } } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /monthly budget/);
    assert.strictEqual((await req('POST', '/api/admin/settings', { as: 'user', body: { budgets: { openai: 5 } } })).status, 403);
    const ok = await req('POST', '/api/admin/settings', { body: { budgets: { openai: 50, anthropic: 10, vertex: 75.256 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    assert.deepStrictEqual(ok.json.settings.budgets, { openai: 50, anthropic: 10, moonshot: null, vertex: 75.26 });
    assert.deepStrictEqual(ok.json.settings.limits, { openai: 3, anthropic: 3, moonshot: 3, vertex: 10 }, 'limits untouched');
    const s = await req('GET', '/api/admin/spend');
    const by = Object.fromEntries(s.json.providers.map((p) => [p.id, p]));
    assert.strictEqual(by.openai.remainingUsd, 50);
    assert.strictEqual(by.openai.basis, 'app', 'no admin key: app-tracked spend');
    assert.strictEqual(by.anthropic.remainingUsd, 8.5);
    assert.strictEqual(by.anthropic.usedPct, 15);
    assert.strictEqual(by.vertex.remainingUsd, 75.26);
    assert.strictEqual(by.moonshot.remainingUsd, null);
  });
  let runCost = 0;
  await check('a text run on the global Vertex key adds exactly the per-slot cost the UI showed', async () => {
    const before = (await spendRow('vertex')).app;
    const lines = await runLines({ taskId: 'custom', customPrompt: 'Say hi.', models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }] });
    const done = lines.find((l) => l.type === 'done');
    assert.ok(done, 'run finished: ' + JSON.stringify(lines.slice(-3)) + '\n' + out.slice(-1500));
    runCost = done.result.costUsd;
    assert.ok(runCost > 0, 'the mocked usage has a cost');
    const after = (await spendRow('vertex')).app;
    assert.strictEqual(after.calls, before.calls + 1);
    assert.ok(Math.abs(after.usd - before.usd - runCost) < 1e-6, `ledger +${after.usd - before.usd} vs slot cost ${runCost}`);
  });
  await check("the same run on the user's own Vertex key is not counted", async () => {
    const before = (await spendRow('vertex')).app;
    const lines = await runLines({ taskId: 'custom', customPrompt: 'Say hi.', models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }], keys: { agentplatform: 'own-vertex-key-unit' } });
    assert.ok(lines.find((l) => l.type === 'done'), 'own-key run finished: ' + JSON.stringify(lines.slice(-3)));
    assert.deepStrictEqual((await spendRow('vertex')).app, before);
  });
  await check('Remaining reflects the run, and the ledger file in AUTH_DATA_DIR has it', async () => {
    const v = await spendRow('vertex');
    assert.strictEqual(v.remainingUsd, Math.round((75.26 - v.app.usd) * 100) / 100);
    const onDisk = JSON.parse(fs.readFileSync(path.join(authDir, 'spend-ledger.json'), 'utf8'));
    assert.strictEqual(onDisk.months[month].vertex.calls, 1);
    assert.strictEqual(onDisk.months[month].anthropic.calls, 2, 'earlier spend is kept');
  });
  await check('Global API keys list the two spend-only admin keys (values never returned)', async () => {
    const g = await req('GET', '/api/global-keys');
    assert.strictEqual(g.status, 200);
    const names = g.json.keys.map((k) => k.name);
    for (const n of ['OPENAI_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY']) assert.ok(names.includes(n), n);
    const oa = g.json.keys.find((k) => k.name === 'OPENAI_ADMIN_KEY');
    assert.strictEqual(oa.present, false);
    assert.match(oa.hint, /Read only/);
    assert.ok(!g.text.includes('sk-spendcanary0123456789'), 'no raw key in the response');
    assert.strictEqual((await req('GET', '/api/global-keys', { as: 'user' })).status, 403);
  });

  try { srv.kill('SIGTERM'); } catch (_) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`\nverify-spend-budgets: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
