// ---------------------------------------------------------------------------
// verify-run-budgets.js: per-run daily budgets on the global keys + admin Settings.
//
// Rules under test (v1.0.40):
//   - One budget per provider (OpenAI 3, Anthropic 3, Moonshot 3, Vertex AI 10 by
//     default), per user per UTC day, for EVERY user (@google.com and external);
//     admins exempt; limits editable in Settings (0 turns a global key off).
//   - A run (one Run click, text or image) counts ONCE per provider it touches,
//     however many models/slots it has. The Image Arena reserves a run once and its
//     per-slot requests present a ticket (no re-charge, no ticket reuse, top-up if a
//     slot needs a budget the reservation didn't cover).
//   - Internal (Google sign-in) admins are editable in Settings and apply per request.
// Offline: no model provider is ever called (unknown image models fail before any
// upstream call; text runs are checked on the 429 path, which returns before streaming).
//   node test/verify-run-budgets.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-budgets-'));
process.env.AUTH_DATA_DIR = path.join(tmp, 'auth-unit');
process.env.APP_DATA_DIR = path.join(tmp, 'data-unit');
delete process.env.ADMIN_EMAILS; // default bootstrap admins

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; process.exitCode = 1; console.error(`✗ ${name}\n  ${(e && e.stack) || e}`); }
}

const appSettings = require('../src/appSettings');
const auth = require('../src/auth');
const runTickets = require('../src/runTickets');

const GOOG = { username: 'someone@google.com', role: 'user', external: true };
const EXT = { username: 'ext.partner', role: 'user' };
const ADMIN = { username: 'ubhi@google.com', role: 'admin', external: true };

(async () => {
  // ---- 1. Settings store -------------------------------------------------------
  await check('defaults: OpenAI 3, Anthropic 3, Moonshot 3, Vertex AI 10', () => {
    assert.deepStrictEqual(appSettings.get().limits, { openai: 3, anthropic: 3, moonshot: 3, vertex: 10 });
  });
  await check('limits must be whole numbers 0..10000', () => {
    for (const bad of [-1, 1.5, 10001, 'abc', '']) {
      assert.throws(() => appSettings.update({ limits: { openai: bad } }), /whole number/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(appSettings.get().limits.openai, 3, 'a rejected update must not change anything');
  });
  await check('internal admins: valid email in an allowed domain only; built-ins are not duplicated', () => {
    const allowedDomains = ['google.com', 'ubhi.altostrat.com'];
    assert.throws(() => appSettings.update({ adminEmails: ['not-an-email'] }, { allowedDomains }), /valid email/);
    assert.throws(() => appSettings.update({ adminEmails: ['eve@evil.com'] }, { allowedDomains }), /can't be an internal admin/);
    const s = appSettings.update({ adminEmails: ['New.Admin@google.com', 'ubhi@google.com', 'new.admin@google.com'] }, { allowedDomains, actor: 'ubhi@google.com' });
    assert.deepStrictEqual(s.adminEmails, ['new.admin@google.com']);
    assert.strictEqual(s.updatedBy, 'ubhi@google.com');
    assert.ok(appSettings.isAdminEmail('NEW.ADMIN@google.com') && appSettings.isAdminEmail('ubhi@google.com'));
    assert.ok(fs.existsSync(appSettings.SETTINGS_FILE), 'settings.json must be persisted');
    appSettings.update({ adminEmails: [] }, { allowedDomains });
    assert.ok(!appSettings.isAdminEmail('new.admin@google.com'));
    assert.ok(appSettings.isBootstrapAdmin('ubhi@google.com'), 'built-in admins stay admins');
  });

  // ---- 2. Budget engine ----------------------------------------------------------
  await check('@google.com and external users get the same budgets; admins are exempt', () => {
    for (const u of [GOOG, EXT]) {
      const snap = auth.quotaSnapshot(u);
      assert.strictEqual(snap.openai.limit, 3);
      assert.strictEqual(snap.vertex.limit, 10);
      assert.strictEqual(snap.vertex.limited, true);
    }
    assert.strictEqual(auth.providerQuota(ADMIN, 'vertex').limited, false);
    assert.strictEqual(auth.consumeProviderRun(ADMIN, 'openai').ok, true);
  });
  await check('10 Vertex runs then blocked (@google.com user); OpenAI budget is separate', () => {
    for (let i = 1; i <= 10; i++) assert.strictEqual(auth.consumeProviderRun(GOOG, 'vertex').ok, true, `vertex run ${i}`);
    assert.strictEqual(auth.consumeProviderRun(GOOG, 'vertex').ok, false, '11th vertex run must be blocked');
    assert.strictEqual(auth.providerQuota(GOOG, 'openai').remaining, 3);
    auth.refundProviderRun(GOOG, 'vertex');
    assert.strictEqual(auth.providerQuota(GOOG, 'vertex').remaining, 1, 'refund restores one run');
  });
  await check('Settings changes apply immediately; 0 turns a global key off', () => {
    appSettings.update({ limits: { openai: 1 } });
    assert.strictEqual(auth.consumeProviderRun(EXT, 'openai').ok, true);
    assert.strictEqual(auth.consumeProviderRun(EXT, 'openai').ok, false);
    appSettings.update({ limits: { anthropic: 0 } });
    const a = auth.consumeProviderRun(EXT, 'anthropic');
    assert.strictEqual(a.ok, false);
    assert.strictEqual(a.limit, 0);
    appSettings.update({ limits: { openai: 3, anthropic: 3 } });
  });
  await check('per-account Vertex override (external accounts) beats the global default', async () => {
    await auth.createUser('ext.custom', 'TempPassw0rd!x', 'user', { mustChangePassword: false, dailyVertexLimit: 2 });
    const u = { username: 'ext.custom', role: 'user' };
    assert.strictEqual(auth.providerQuota(u, 'vertex').limit, 2);
    auth.updateUserLimits('ext.custom', { dailyVertexLimit: null });
    assert.strictEqual(auth.providerQuota(u, 'vertex').limit, 10, 'blank override = Settings default');
    auth.deleteUser('ext.custom', 'admin');
  });
  await check('legacy wrappers map to the provider budgets (single re-runs share the OpenAI budget)', () => {
    const u = { username: 'legacy.user@google.com', role: 'user', external: true };
    assert.strictEqual(auth.consumeRun(u, 'single').ok, true);
    assert.strictEqual(auth.runQuota(u, 'compare').used, 1);
    assert.strictEqual(auth.consumeVertexRun(u).ok, true);
    assert.strictEqual(auth.vertexRunQuota(u).used, 1);
  });
  await check('counters are persisted (survive a redeploy) when AUTH_DATA_DIR is set', () => {
    auth.flushSync(); // writes are debounced (one per 2 s); flush the trailing write before reading the file
    const f = path.join(process.env.AUTH_DATA_DIR, 'run-budgets.json');
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(obj.counts[`vertex|someone@google.com|${obj.day}`] >= 9);
  });
  await check('Google sign-in sessions pick up admin changes on the next request', () => {
    const token = auth.createSession({ username: 'new.admin@google.com', role: 'user', external: true });
    const req = { cookies: { [auth.COOKIE_NAME]: token } };
    assert.strictEqual(auth.getSession(req).role, 'user');
    appSettings.update({ adminEmails: ['new.admin@google.com'] }, { allowedDomains: ['google.com'] });
    assert.strictEqual(auth.getSession(req).role, 'admin', 'added admin applies without a new sign-in');
    appSettings.update({ adminEmails: [] }, { allowedDomains: ['google.com'] });
    assert.strictEqual(auth.getSession(req).role, 'user', 'removed admin applies without a sign-out');
  });

  // ---- 3. Image Arena run tickets --------------------------------------------------
  await check('tickets: owner-only, slot+model must match, each slot once, refund only when every slot was abandoned', () => {
    const t = runTickets.create({ username: 'a@google.com', slots: [{ slot: 'A', id: 'm1' }, { slot: 'B', id: 'm2' }], charged: ['vertex'] });
    assert.deepStrictEqual(t.charged, ['vertex'], 'charged budgets are kept as a list (server tops up / refunds from it)');
    assert.strictEqual(runTickets.get(t.id, 'b@google.com'), null, "someone else's ticket");
    assert.ok(runTickets.get(t.id, 'a@google.com'));
    assert.strictEqual(runTickets.claimSlot(t, 'A', 'm2'), false, 'wrong model');
    assert.strictEqual(runTickets.claimSlot(t, 'C', 'm1'), false, 'unreserved slot');
    assert.strictEqual(runTickets.claimSlot(t, 'A', 'm1'), true);
    assert.strictEqual(runTickets.claimSlot(t, 'A', 'm1'), false, 'no double claim');
    assert.strictEqual(runTickets.settleSlot(t, 'A', { abandoned: true }), false, 'B still pending');
    assert.strictEqual(runTickets.settleSlot(t, 'B', { abandoned: true }), true, 'all abandoned -> refund');
    assert.strictEqual(runTickets.settleSlot(t, 'B', { abandoned: true }), false, 'refund only once');
    const t2 = runTickets.create({ username: 'a@google.com', slots: [{ slot: 'A', id: 'm1' }, { slot: 'B', id: 'm2' }], charged: ['vertex'] });
    runTickets.settleSlot(t2, 'A', { abandoned: false });
    assert.strictEqual(runTickets.settleSlot(t2, 'B', { abandoned: true }), false, 'a completed slot means no refund');
    assert.strictEqual(runTickets.get('not-a-ticket', 'a@google.com'), null);
  });

  // ---- 4. HTTP contract (spawned server; admin = loopback auto-auth, user = session cookie) ----
  const PORT = Number(process.env.BUDGETS_TEST_PORT || 18897);
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SECONDARY_PORT: '0',
    APP_DATA_DIR: path.join(tmp, 'data'), AUTH_DATA_DIR: path.join(tmp, 'auth'),
    ENABLE_CODE_EXEC: '0', GCLOUD_TOKEN_AUTOMINT: '0',
    OPENAI_API_KEY: 'sk-budgetcanary0123456789', AGENT_PLATFORM_API_KEY: 'vertex-budget-canary',
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
    let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, json, setCookie };
  };

  // A normal (non-admin) external account to run as.
  let r = await req('POST', '/api/auth/users', { body: { username: 'budget.user', password: 'BudgetPassw0rd!', role: 'user', mustChangePassword: false } });
  assert.ok(r.status === 200, 'create test user: ' + JSON.stringify(r.json));
  r = await req('POST', '/api/auth/login', { body: { username: 'budget.user', password: 'BudgetPassw0rd!' } });
  userCookie = (r.setCookie || '').split(';')[0];
  assert.ok(userCookie, 'login cookie');

  await check('/api/config exposes the limits and the caller\'s per-provider budgets', async () => {
    const c = await req('GET', '/api/config', { as: 'user' });
    assert.deepStrictEqual(c.json.limits, { openai: 3, anthropic: 3, moonshot: 3, vertex: 10 });
    assert.strictEqual(c.json.me.quotas.vertex.remaining, 10);
    assert.strictEqual(c.json.me.quotas.openai.remaining, 3);
  });
  await check('Settings API is admin-only and validates input', async () => {
    assert.strictEqual((await req('GET', '/api/admin/settings', { as: 'user' })).status, 403);
    const g = await req('GET', '/api/admin/settings');
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual(g.json.defaults, { openai: 3, anthropic: 3, moonshot: 3, vertex: 10 });
    assert.ok(g.json.bootstrapAdmins.includes('ubhi@google.com'));
    assert.strictEqual((await req('POST', '/api/admin/settings', { body: { limits: { vertex: -3 } } })).status, 400);
    assert.strictEqual((await req('POST', '/api/admin/settings', { body: { adminEmails: ['eve@evil.com'] } })).status, 400);
    const ok = await req('POST', '/api/admin/settings', { body: { adminEmails: ['teammate@google.com'] } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.settings.adminEmails, ['teammate@google.com']);
  });

  const imgSlot = (slot, catalogId) => ({ slot, catalogId });
  const vertexUsed = async () => (await req('GET', '/api/config', { as: 'user' })).json.me.quotas.vertex.used;
  let ticket = '';
  await check('Image run: a 2-slot Vertex run is charged ONCE at reserve', async () => {
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [imgSlot('A', 'zz-unknown-1'), imgSlot('B', 'zz-unknown-2')] } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.charged, ['vertex']);
    assert.strictEqual(res.json.quotas.vertex.used, 1);
    ticket = res.json.ticket;
  });
  await check('Image run: slot requests that present the ticket are not charged again', async () => {
    for (const s of ['A', 'B']) {
      const res = await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [imgSlot(s, s === 'A' ? 'zz-unknown-1' : 'zz-unknown-2')], prompt: 'x', ticket } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.strictEqual(res.json.results[0].ok, false, 'unknown model fails on its own slot (no upstream call)');
    }
    assert.strictEqual(await vertexUsed(), 1);
  });
  await check('Image run: re-using a claimed slot, or no ticket at all, is charged as its own run', async () => {
    await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [imgSlot('A', 'zz-unknown-1')], prompt: 'x', ticket } });
    assert.strictEqual(await vertexUsed(), 2);
    await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [imgSlot('A', 'zz-unknown-1')], prompt: 'x' } });
    assert.strictEqual(await vertexUsed(), 3);
  });
  await check('Image run: reserved on an own key but sent without it -> topped up once (no free global run)', async () => {
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [imgSlot('A', 'zz-unknown-1')], keys: { agentplatform: 'own-key' } } });
    assert.deepStrictEqual(res.json.charged, [], 'own-key run is not charged');
    assert.strictEqual(await vertexUsed(), 3);
    await req('POST', '/api/image-arena/run', { as: 'user', body: { slots: [imgSlot('A', 'zz-unknown-1')], prompt: 'x', ticket: res.json.ticket } });
    assert.strictEqual(await vertexUsed(), 4);
  });
  await check('Image run: GPT Image on the global key counts toward the OpenAI budget (once per run)', async () => {
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [imgSlot('A', 'gpt-image-2'), imgSlot('B', 'gpt-image-2.5-flare'), imgSlot('C', 'zz-unknown-1')] } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(res.json.charged, ['openai', 'vertex']);
    assert.strictEqual(res.json.quotas.openai.used, 1, 'two GPT Image slots = one OpenAI run');
    assert.strictEqual(res.json.quotas.vertex.used, 5);
  });
  await check('Image run: a used-up budget rejects the whole run up front (429, nothing charged)', async () => {
    await req('POST', '/api/admin/settings', { body: { limits: { vertex: 5 } } });
    const res = await req('POST', '/api/image-arena/reserve', { as: 'user', body: { slots: [imgSlot('A', 'gpt-image-2'), imgSlot('B', 'zz-unknown-1')] } });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.json.vertexQuotaExhausted, true);
    assert.strictEqual(res.json.quotas.openai.used, 1, 'the OpenAI charge is rolled back');
  });
  await check('Text run: a used-up budget returns 429 before anything runs, with the same flags', async () => {
    await req('POST', '/api/admin/settings', { body: { limits: { openai: 1 } } });
    const models = [{ slot: 'A', catalogId: 'gpt-5.4' }];
    const res = await req('POST', '/api/run', { as: 'user', body: { taskId: 'custom', customPrompt: 'hi', models } });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.json.openaiQuotaExhausted, true);
    assert.strictEqual(res.json.provider, 'openai');
    await req('POST', '/api/admin/settings', { body: { limits: { openai: 3 } } });
    const mixed = await req('POST', '/api/run', { as: 'user', body: { taskId: 'custom', customPrompt: 'hi', models: [{ slot: 'A', catalogId: 'gpt-5.4' }, { slot: 'B', catalogId: 'gemini-3.8-flash' }] } });
    assert.strictEqual(mixed.status, 429, 'Vertex budget (5/5) is used up');
    assert.strictEqual(mixed.json.vertexQuotaExhausted, true);
    assert.strictEqual(mixed.json.quotas.openai.used, 1, 'OpenAI charge rolled back when Vertex is exhausted');
  });
  await check('Settings persist to settings.json in AUTH_DATA_DIR (survives deploys)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(tmp, 'auth', 'settings.json'), 'utf8'));
    assert.strictEqual(s.limits.vertex, 5);
    assert.deepStrictEqual(s.adminEmails, ['teammate@google.com']);
  });

  try { srv.kill('SIGTERM'); } catch (_) { /* ignore */ }
  console.log(`\nverify-run-budgets: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
