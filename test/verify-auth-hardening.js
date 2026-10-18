// ---------------------------------------------------------------------------
// verify-auth-hardening.js: behavioural tests for the controls the threat model
// depends on (2026-10-17 adversarial review, findings 8.1, 3.4, 3.5, 3.7, 3.8,
// 3.2, 4.1, 4.14, 12.1). Everything runs offline:
//   - unit tests in this process (resolveModels, googleAuth, app.js esc/imgHistRowHtml)
//   - a spawned server on a free port (18910-18930) with LOCAL_AUTO_AUTH=0, so every
//     admin call goes through a real ADMIN_BOOTSTRAP_PASSWORD login, not the
//     loopback backdoor, and a --require preload that answers Vertex Gemini
//     streaming calls (delayed chunks for SLOW / STALL prompts) and blocks every
//     other external host.
//   node test/verify-auth-hardening.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-authhard-'));
// Hermetic in-process env (set BEFORE any src/* require): no real .auth, no real keys.
process.env.AUTH_DATA_DIR = path.join(tmp, 'auth-unit');
process.env.APP_DATA_DIR = path.join(tmp, 'data-unit');
process.env.GOOGLE_CLIENT_ID = 'unit-test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'unit-test-client-secret-0123456789';
process.env.OAUTH_REDIRECT_BASE = 'https://llm-compare.example.test';
process.env.COOKIE_SECURE = '0';
delete process.env.ADMIN_EMAILS;
delete process.env.K_SERVICE;
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MOONSHOT_API_KEY', 'GEMINI_API_KEY', 'AGENT_PLATFORM_API_KEY', 'CLAUDE_BEARER_TOKEN', 'GCP_PROJECT_ID']) delete process.env[k];

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) {
    failed++; process.exitCode = 1; failures.push(name);
    console.error(`✗ ${name}\n  ${(e && e.stack) || e}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Unit: resolveModels slot de-dupe (4.1) and slot sanitising
// ---------------------------------------------------------------------------
(async () => {
  const { resolveModels } = require('../src/pricing');
  await check('resolveModels: two models sent with the same client slot letter get DISTINCT slots (4.1)', () => {
    const out = resolveModels([{ catalogId: 'gpt-6-astra', slot: 'B' }, { catalogId: 'kimi-k2-thinking-maas', slot: 'B' }]);
    assert.strictEqual(out.length, 2, 'both catalog models resolve');
    assert.strictEqual(out[0].catalogId, 'gpt-6-astra');
    assert.strictEqual(out[1].catalogId, 'kimi-k2-thinking-maas');
    assert.notStrictEqual(out[0].slot, out[1].slot, `slots collapsed: ${out.map((m) => m.slot + ':' + m.catalogId).join(', ')}`);
    assert.ok(/^[A-Z]$/.test(out[0].slot) && /^[A-Z]$/.test(out[1].slot), 'slots are single capital letters');
  });
  await check('resolveModels: a non-letter client slot ("<img>") is replaced by the next free letter (A)', () => {
    const out = resolveModels([{ catalogId: 'gemini-3.8-flash', slot: '<img>' }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].slot, 'A', `got slot ${JSON.stringify(out[0].slot)}`);
    const three = resolveModels([{ catalogId: 'gemini-3.8-flash', slot: '__proto__' }, { catalogId: 'gemini-3.5-flash', slot: 'A' }, { catalogId: 'gemini-3.5-flash-lite' }]);
    assert.deepStrictEqual(three.map((m) => m.slot).slice().sort(), ['A', 'B', 'C'], `got ${three.map((m) => m.slot).join(',')}`);
  });
  await check('resolveModels: unknown ids never resolve to themselves (only catalog models can run)', () => {
    const { MODEL_CATALOG } = require('../src/pricing');
    const inCatalog = (m) => MODEL_CATALOG.some((c) => c.id === m.catalogId);
    const unknown = resolveModels([{ catalogId: 'no-such-model-xyz', slot: 'A' }, { id: 'gpt-99-nope', slot: 'B' }]);
    assert.ok(unknown.every(inCatalog), 'nothing outside the catalog comes back');
    assert.ok(!unknown.some((m) => /no-such-model|gpt-99/.test(m.catalogId + m.model)), 'the bogus ids are dropped');
    assert.ok(resolveModels(undefined).every(inCatalog));
  });

  // -------------------------------------------------------------------------
  // 2. Unit: Google OIDC login is bound to the browser (3.4)
  // -------------------------------------------------------------------------
  const googleAuth = require('../src/googleAuth');
  const fakeRes = () => {
    const r = { headers: {}, cookies: [], location: null, statusCode: 200 };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; if (k.toLowerCase() === 'set-cookie') r.cookies.push(...(Array.isArray(v) ? v : [v])); };
    r.getHeader = (k) => r.headers[k.toLowerCase()];
    r.append = (k, v) => { if (k.toLowerCase() === 'set-cookie') r.cookies.push(...(Array.isArray(v) ? v : [v])); else r.headers[k.toLowerCase()] = v; };
    r.cookie = (name, value, opts = {}) => {
      const attrs = [`${name}=${encodeURIComponent(value)}`];
      if (opts.httpOnly) attrs.push('HttpOnly');
      if (opts.path) attrs.push(`Path=${opts.path}`);
      if (opts.sameSite) attrs.push(`SameSite=${opts.sameSite}`);
      if (opts.maxAge != null) attrs.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
      if (opts.secure) attrs.push('Secure');
      r.cookies.push(attrs.join('; '));
    };
    r.redirect = (a, b) => { r.location = b === undefined ? a : b; r.statusCode = b === undefined ? 302 : a; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };
  // A request carrying `cookies` both parsed (req.cookies) and raw (Cookie header), so the
  // test does not care which one the implementation reads.
  const fakeReq = (over = {}) => {
    const cookies = over.cookies || {};
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    return {
      headers: { host: 'llm-compare.example.test', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      secure: true, query: {}, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' },
      ...over, cookies,
    };
  };
  const startLogin = () => {
    assert.strictEqual(typeof googleAuth.startLogin, 'function', 'googleAuth.startLogin(req, res) must exist (sets the oauth_state cookie and redirects)');
    const res = fakeRes();
    // Either contract works: startLogin redirects itself, or returns the URL for the route to redirect to.
    const returned = googleAuth.startLogin(fakeReq(), res);
    const location = (typeof returned === 'string' && returned) || res.location;
    const cookie = res.cookies.find((c) => /^oauth_state=/.test(String(c)));
    assert.ok(cookie, `startLogin must set an oauth_state cookie; Set-Cookie seen: ${JSON.stringify(res.cookies)}`);
    assert.match(String(cookie), /HttpOnly/i, 'oauth_state cookie must be HttpOnly');
    assert.ok(location, 'startLogin must redirect to Google (or return the URL to redirect to)');
    const state = new URL(location).searchParams.get('state');
    assert.ok(state, 'redirect carries a state parameter');
    let cookieValue = String(cookie).split(';')[0].slice('oauth_state='.length);
    try { cookieValue = decodeURIComponent(cookieValue); } catch (_) { /* keep raw */ }
    assert.ok(cookieValue, 'oauth_state cookie has a value');
    return { state, cookieValue, cookie: String(cookie), location };
  };
  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (url) => { fetchCalls++; throw new Error('NETWORK_REACHED ' + String(url)); };
  try {
    await check('OIDC: startLogin sets an HttpOnly oauth_state cookie and a nonce, scoped to the callback path', () => {
      const { cookie, location } = startLogin();
      assert.match(cookie, /SameSite=(Lax|Strict)/i, 'oauth_state cookie must be SameSite Lax or Strict');
      assert.match(cookie, /Max-Age=\d+/i, 'oauth_state cookie must expire (Max-Age)');
      assert.match(cookie, /Path=\/auth\/google/i, 'oauth_state cookie must be scoped to Path=/auth/google');
      const u = new URL(location);
      assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.ok(u.searchParams.get('nonce'), 'auth URL must carry a nonce (replay protection)');
      assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://llm-compare.example.test/auth/google/callback');
    });
    await check('OIDC: callback with NO oauth_state cookie is rejected before any network call', async () => {
      const { state } = startLogin();
      fetchCalls = 0;
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: {}, query: { code: 'code-1', state } }), 'code-1', state), /sign-in|state|expired|try again/i);
      assert.strictEqual(fetchCalls, 0, 'token endpoint must not be called when the browser has no oauth_state cookie');
    });
    await check('OIDC: callback with a MISMATCHED oauth_state cookie is rejected before any network call', async () => {
      const { state } = startLogin();
      fetchCalls = 0;
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: { oauth_state: 'not-the-cookie-that-was-set-0123' }, query: { code: 'code-2', state } }), 'code-2', state), /sign-in|state|expired|try again/i);
      assert.strictEqual(fetchCalls, 0, 'token endpoint must not be called when the cookie does not match the state');
    });
    await check('OIDC: an attacker-supplied state (never issued to this browser) is rejected even with the cookie present', async () => {
      const { cookieValue } = startLogin();
      fetchCalls = 0;
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: { oauth_state: cookieValue }, query: { code: 'code-3', state: 'deadbeefdeadbeefdeadbeefdeadbeef' } }), 'code-3', 'deadbeefdeadbeefdeadbeefdeadbeef'));
      assert.strictEqual(fetchCalls, 0);
    });
    await check('OIDC: control - matching cookie + state reaches the token exchange (the fetch mock is hit), and the mock failure is surfaced', async () => {
      const { state, cookieValue } = startLogin();
      fetchCalls = 0;
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: { oauth_state: cookieValue }, query: { code: 'code-4', state } }), 'code-4', state));
      assert.strictEqual(fetchCalls, 1, 'with a valid cookie/state pair the token endpoint IS called exactly once');
    });
    await check('OIDC: a state cannot be consumed twice (replay)', async () => {
      const { state, cookieValue } = startLogin();
      fetchCalls = 0;
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: { oauth_state: cookieValue }, query: { code: 'code-5', state } }), 'code-5', state));
      await assert.rejects(() => googleAuth.handleCallback(fakeReq({ cookies: { oauth_state: cookieValue }, query: { code: 'code-5', state } }), 'code-5', state));
      assert.strictEqual(fetchCalls, 1, 'the second use of the same state must be rejected before the network');
    });
  } finally {
    global.fetch = realFetch;
  }

  // -------------------------------------------------------------------------
  // 3. Unit: XSS sinks in public/app.js executed in a vm (3.2)
  // -------------------------------------------------------------------------
  await check('app.js: esc() and imgHistRowHtml() never emit an unescaped thumbDataUrl and drop non data:/vault thumbnails', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const grab = (re) => { const m = src.match(re); assert.ok(m, `missing ${re}`); return m[0]; };
    const grabOpt = (re) => { const m = src.match(re); return m ? m[0] : ''; };
    const code = [
      grab(/const esc = \(s\) =>\n[^\n]*\n/),
      // The thumbnail allow-list helper (3.2) and its regex, when present; the row renderer must call it.
      grabOpt(/const SAFE_IMG_SRC_RE = [^\n]*\n/),
      grabOpt(/function safeImageSrc\([\s\S]*?\n\}\n/),
      grab(/function imgHistRowHtml\(r\) \{[\s\S]*?\n\}\n/),
      'this.esc = esc; this.imgHistRowHtml = imgHistRowHtml;',
    ].join('\n');
    const ctx = {
      ME: { username: 'viewer@example.com' },
      IMG_CONFIG: null,
      ICON_STAR_ON: '<svg class="on"></svg>', ICON_STAR_OFF: '<svg class="off"></svg>', ICON_TRASH: '<svg class="trash"></svg>',
      isCurrentImageModel: () => true,
      fmtCost: (n) => '$' + Number(n || 0).toFixed(4),
      fmtWhen: (ms) => new Date(ms || 0).toISOString(),
      fmtInt: (n) => String(n || 0),
      encodeURIComponent,
      String, Number, Boolean, Array, Math, Date, JSON, RegExp, Object,
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    assert.strictEqual(ctx.esc('<img src=x onerror=alert(1)>"&'), '&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');

    const payload = '"><img src=x onerror=alert(1)>';
    const row = (thumb) => ctx.imgHistRowHtml({
      id: 'img_test_1', at: 1760000000000, title: 'Hijack <b>row</b>', imageSize: '2K', aspectRatio: '16:9',
      results: [{ slot: 'A', catalogId: 'nano-banana-2.1', label: 'Nano Banana 2.1', shortLabel: 'NB 2.1', thumbDataUrl: thumb, costUsd: 0.1 }],
    });
    const html1 = row(payload);
    assert.ok(!html1.includes(payload), 'raw payload must never appear in the row HTML');
    assert.ok(!/onerror=/i.test(html1), 'no onerror attribute may survive');
    assert.ok(!/<img src="">/.test(html1), 'an invalid thumbnail must be dropped, not rendered as an empty img');
    assert.ok(html1.includes('Hijack &lt;b&gt;row&lt;/b&gt;'), 'title is escaped');

    const html2 = row('https://attacker.example/x.png');
    assert.ok(!html2.includes('attacker.example'), 'a non data:/vault thumbnail src must be dropped');
    const html3 = row('javascript:alert(1)');
    assert.ok(!/javascript:/i.test(html3), 'javascript: URLs must be dropped');
    const html4 = row('/api/me/vault/abc"><script>alert(1)</script>');
    assert.ok(!html4.includes('<script>'), 'a vault path with an injected tag must be escaped or dropped');

    const good = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const html5 = row(good);
    assert.ok(html5.includes(`src="${good}"`), 'a real base64 PNG data URL still renders');
    const html6 = ctx.imgHistRowHtml({ id: 'img_test_2', at: 1, results: [{ slot: 'A', catalogId: 'x', label: 'x', imageVaultRef: 'sha256abc' }] });
    assert.ok(html6.includes('src="/api/me/vault/sha256abc"'), 'a vault reference still renders through /api/me/vault/');
  });

  // -------------------------------------------------------------------------
  // 4. Spawned server (LOCAL_AUTO_AUTH=0, bootstrap admin login, mocked Vertex)
  // -------------------------------------------------------------------------
  const freePort = async () => {
    for (let p = 18910; p <= 18930; p++) {
      const ok = await new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
      });
      if (ok) return p;
    }
    throw new Error('no free port in 18910-18930');
  };
  const PORT = Number(process.env.AUTH_HARDENING_PORT) || await freePort();
  const SLOW_MS = 1500;
  const preload = path.join(tmp, 'mock-upstream.js');
  fs.writeFileSync(preload, `
    // Vertex Gemini SSE mock. SLOW = first chunk now, final chunk after ${SLOW_MS} ms;
    // STALL = nothing until ${SLOW_MS} ms. Both honour the abort signal like a real fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
      if (/(^|\\.)aiplatform\\.googleapis\\.com$/.test(u.hostname) && u.pathname.includes(':streamGenerateContent')) {
        let text = '';
        try { text = JSON.stringify(JSON.parse((init && init.body) || '{}').contents || []); } catch (_) { text = ''; }
        const slow = /SLOW/.test(text);
        const stall = /STALL/.test(text);
        const signal = init && init.signal;
        const wait = (ms) => new Promise((resolve, reject) => {
          if (signal && signal.aborted) return reject(new DOMException('This operation was aborted', 'AbortError'));
          const t = setTimeout(resolve, ms);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
        });
        const enc = new TextEncoder();
        const first = { candidates: [{ content: { parts: [{ text: 'Mock answer, part one of two. ' }] } }] };
        const last = { candidates: [{ content: { parts: [{ text: 'Done.' }] } }], usageMetadata: { promptTokenCount: 400000, candidatesTokenCount: 200000 } };
        const stream = new ReadableStream({
          async start(controller) {
            try {
              if (stall) await wait(${SLOW_MS});
              controller.enqueue(enc.encode('data: ' + JSON.stringify(first) + '\\n\\n'));
              if (slow) await wait(${SLOW_MS});
              controller.enqueue(enc.encode('data: ' + JSON.stringify(last) + '\\n\\n'));
              controller.close();
            } catch (e) { controller.error(e); }
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('blocked in test: ' + u.hostname);
    };
  `);
  const authDir = path.join(tmp, 'auth');
  const ADMIN_PW = 'BreakGlass#Admin-2026!';
  const SEEDED_SECRET = 'sk-test-SECRETVALUE123456789abcdef';
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SECONDARY_PORT: '0', LOG_FORMAT: 'text',
    APP_DATA_DIR: path.join(tmp, 'data'), AUTH_DATA_DIR: authDir,
    LOCAL_AUTO_AUTH: '0', LOCAL_AUTO_AUTH_HOSTS: '',
    ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PW,
    ENABLE_CODE_EXEC: '0', ENABLE_WEB_GAME: '0', GCLOUD_TOKEN_AUTOMINT: '0',
    GLOBAL_KEYS_ENABLED: '0', GCP_PROJECT_ID: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    OPENAI_ADMIN_KEY: '', ANTHROPIC_ADMIN_KEY: '', MOONSHOT_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', CLAUDE_BEARER_TOKEN: '',
    AGENT_PLATFORM_API_KEY: 'vertex-authhard-canary-0123456',
    OPENAI_API_KEY: SEEDED_SECRET,
    NODE_OPTIONS: `--require ${preload}`,
  };
  delete env.K_SERVICE; delete env.ANTIGRAVITY_SIDECAR_WEB_PORT; delete env.ADMIN_EMAILS; delete env.COOKIE_SECURE;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const stop = () => { try { srv.kill('SIGKILL'); } catch (_) { /* ignore */ } };
  process.on('exit', stop);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch (_) { await sleep(250); } }
  if (!up) { console.error('server did not start\n' + out); process.exit(1); }

  const cookies = {};
  const req = async (method, p, { body, as = null, headers = {}, rawBody } = {}) => {
    const h = { ...headers };
    let payload;
    if (rawBody !== undefined) { payload = rawBody; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    if (as && cookies[as]) h.Cookie = cookies[as];
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie');
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, json, text, setCookie, headers: r.headers };
  };
  const login = async (name, username, password) => {
    const r = await req('POST', '/api/auth/login', { body: { username, password } });
    assert.strictEqual(r.status, 200, `login ${username}: ${r.status} ${r.text.slice(0, 200)}`);
    cookies[name] = (r.setCookie || '').split(';')[0];
    assert.ok(/^sid=/.test(cookies[name]), 'login cookie');
    return r;
  };
  const vertexUsed = async (as) => {
    const r = await req('GET', '/api/config', { as });
    assert.strictEqual(r.status, 200, `/api/config as ${as}: ${r.status}`);
    const q = (r.json.me.quotas && r.json.me.quotas.vertex) || r.json.me.vertexQuota;
    assert.ok(q && typeof q.used === 'number', 'config exposes me.quotas.vertex.used');
    return q.used;
  };
  const vertexSpend = async () => {
    const r = await req('GET', '/api/admin/spend', { as: 'admin' });
    assert.strictEqual(r.status, 200, `/api/admin/spend: ${r.status} ${r.text.slice(0, 200)}`);
    return r.json.providers.find((p) => p.id === 'vertex').app;
  };
  // Stream /api/run as a user; destroy the socket when `stopOn(event)` is true. Resolves with the events seen.
  const runAndDestroy = (as, body, stopOn) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const events = [];
    let buf = '';
    let done = false;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/run', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: cookies[as] },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events }); }
      res.on('data', (chunk) => {
        if (done) return;
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
          events.push(ev);
          if (stopOn(ev)) {
            done = true;
            res.destroy();
            r.destroy();
            return resolve({ status: 200, events, destroyed: true });
          }
        }
      });
      res.on('end', () => { if (!done) { done = true; resolve({ status: 200, events, destroyed: false }); } });
      res.on('error', () => { if (!done) { done = true; resolve({ status: 200, events, destroyed: true }); } });
    });
    r.on('error', (e) => { if (!done) { done = true; reject(e); } });
    r.end(payload);
  });

  // Accounts: break-glass admin (ADMIN_BOOTSTRAP_PASSWORD) + two normal users + one forced-change user.
  await check('admin signs in with the break-glass password (no loopback auto-admin: an anonymous /api/config is 401)', async () => {
    const anon = await req('GET', '/api/config');
    assert.strictEqual(anon.status, 401, 'LOCAL_AUTO_AUTH=0 must disable the loopback auto-admin');
    const r = await login('admin', 'admin', ADMIN_PW);
    assert.strictEqual(r.json.user.role, 'admin');
    const cfg = await req('GET', '/api/config', { as: 'admin' });
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.json.me.username, 'admin');
    assert.strictEqual(cfg.json.me.role, 'admin');
  });
  await check('admin creates two normal users and one forced-change user over HTTP (admin-only route)', async () => {
    for (const [u, pw] of [['alice.user', 'AlicePassw0rd!'], ['bob.user', 'BobPassw0rd!!']]) {
      const r = await req('POST', '/api/auth/users', { as: 'admin', body: { username: u, password: pw, role: 'user', mustChangePassword: false } });
      assert.strictEqual(r.status, 200, `create ${u}: ${r.text.slice(0, 200)}`);
    }
    const f = await req('POST', '/api/auth/users', { as: 'admin', body: { username: 'forced.user', password: 'TempForced#2026', role: 'user' } });
    assert.strictEqual(f.status, 200, f.text.slice(0, 200));
    assert.strictEqual(f.json.user.mustChangePassword, true, 'new accounts default to a forced password change');
    await login('alice', 'alice.user', 'AlicePassw0rd!');
    await login('bob', 'bob.user', 'BobPassw0rd!!');
    await login('forced', 'forced.user', 'TempForced#2026');
    const denied = await req('POST', '/api/auth/users', { as: 'alice', body: { username: 'mallory', password: 'MalloryPassw0rd!', role: 'admin' } });
    assert.strictEqual(denied.status, 403, 'a normal user cannot create accounts');
  });

  // ---- (3) zero / unknown models: 400 and no quota consumed (4.14) ----
  await check('/api/run with models: [] returns 400 and consumes no quota', async () => {
    const before = await vertexUsed('alice');
    const r = await req('POST', '/api/run', { as: 'alice', body: { taskId: 'custom', customPrompt: 'hi', models: [] } });
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert.ok(r.json && r.json.type === 'error' && r.json.error, 'JSON error body');
    assert.strictEqual(await vertexUsed('alice'), before, 'no quota consumed');
    const hist = await req('GET', '/api/history', { as: 'alice' });
    assert.strictEqual(hist.json.runs.length, 0, 'no history record written for a run with zero models');
  });
  await check('/api/run with only unknown catalog ids returns 400 and consumes no quota', async () => {
    const before = await vertexUsed('alice');
    const r = await req('POST', '/api/run', { as: 'alice', body: { taskId: 'custom', customPrompt: 'hi', models: [{ slot: 'A', catalogId: 'gpt-99-nope' }, { slot: 'B', id: 'gemini-0.1-nope' }] } });
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert.strictEqual(await vertexUsed('alice'), before, 'no quota consumed');
  });

  // ---- (1) abort after output: no refund, spend recorded (8.1) ----
  await check('abort after the first delta: the Vertex daily run is NOT refunded and the spend ledger records the partial cost (8.1)', async () => {
    const before = await vertexUsed('alice');
    const spendBefore = await vertexSpend();
    const run = await runAndDestroy('alice', {
      taskId: 'custom', customPrompt: 'SLOW: write two sentences.',
      models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }, { slot: 'B', catalogId: 'gemini-3.5-flash-lite' }],
    }, (ev) => ev.type === 'delta');
    assert.strictEqual(run.status, 200, 'run streamed');
    assert.ok(run.destroyed && run.events.some((e) => e.type === 'delta'), `destroyed after a delta; events=${run.events.map((e) => e.type).join(',')}`);
    assert.strictEqual(run.events.find((e) => e.type === 'quota').quotas.vertex.used, before + 1, 'the run was charged once on the Vertex budget');
    await sleep(300);
    assert.strictEqual(await vertexUsed('alice'), before + 1, 'quota must NOT be refunded right after the client disconnects (output was already streamed)');
    await sleep(SLOW_MS + 700); // let the aborted upstream calls settle
    assert.strictEqual(await vertexUsed('alice'), before + 1, 'quota must still not be refunded once the aborted run has settled');
    const spendAfter = await vertexSpend();
    assert.ok(spendAfter.usd > spendBefore.usd, `vertex app spend must increase for the streamed part (before ${spendBefore.usd}, after ${spendAfter.usd})`);
    assert.ok(spendAfter.calls >= spendBefore.calls + 1, 'the aborted calls are counted in the ledger');
  });
  await check('control: a run destroyed BEFORE any model output IS refunded', async () => {
    const before = await vertexUsed('alice');
    const run = await runAndDestroy('alice', {
      taskId: 'custom', customPrompt: 'STALL: write two sentences.',
      models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }],
    }, (ev) => ev.type === 'start');
    assert.ok(run.destroyed, 'destroyed after start');
    assert.ok(!run.events.some((e) => e.type === 'delta'), 'no output was streamed');
    await sleep(SLOW_MS + 700);
    assert.strictEqual(await vertexUsed('alice'), before, 'a run with no output is handed back');
  });
  await check('a completed run keeps its charge and records its cost once', async () => {
    const before = await vertexUsed('bob');
    const spendBefore = await vertexSpend();
    const r = await req('POST', '/api/run', { as: 'bob', body: { taskId: 'custom', customPrompt: 'Say hi.', models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }] } });
    assert.strictEqual(r.status, 200);
    const lines = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = lines.find((l) => l.type === 'done');
    assert.ok(done && done.result && done.result.costUsd > 0, 'run finished with a cost: ' + JSON.stringify(lines.slice(-2)) + '\n' + out.slice(-800));
    assert.ok(lines.some((l) => l.type === 'all_done'));
    assert.strictEqual(await vertexUsed('bob'), before + 1);
    const spendAfter = await vertexSpend();
    assert.ok(Math.abs(spendAfter.usd - spendBefore.usd - done.result.costUsd) < 1e-6, `ledger +${spendAfter.usd - spendBefore.usd} vs cost ${done.result.costUsd}`);
    assert.strictEqual(spendAfter.calls, spendBefore.calls + 1);
  });

  // ---- (2) case-variant paths and the forced-change gate (3.8) ----
  await check('POST /API/run (uppercase) is not routed to the run handler', async () => {
    const before = await vertexUsed('alice');
    const r = await req('POST', '/API/run', { as: 'alice', body: { taskId: 'custom', customPrompt: 'hi', models: [{ slot: 'A', catalogId: 'gemini-3.8-flash' }] } });
    assert.strictEqual(r.status, 404, `expected 404, got ${r.status}: ${r.text.slice(0, 120)}`);
    assert.ok(!/"type":"(quota|start|all_done)"/.test(r.text), 'no NDJSON run events on a case-variant path');
    assert.strictEqual(await vertexUsed('alice'), before, 'no quota consumed');
  });
  await check('forced-change user: 403 PASSWORD_CHANGE_REQUIRED on /api/history, and /API/history is not a bypass', async () => {
    const r = await req('GET', '/api/history', { as: 'forced' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json && r.json.code, 'PASSWORD_CHANGE_REQUIRED');
    const up = await req('GET', '/API/history', { as: 'forced' });
    assert.ok(up.status === 403 || up.status === 404, `case-variant path must not bypass the gate: got ${up.status}`);
    assert.ok(!up.json || !Array.isArray(up.json.runs), 'no history returned on the case-variant path');
    const mixed = await req('GET', '/Api/history', { as: 'forced' });
    assert.ok(mixed.status === 403 || mixed.status === 404, `mixed-case path must not bypass the gate: got ${mixed.status}`);
    const cfg = await req('GET', '/api/config', { as: 'forced' });
    assert.strictEqual(cfg.status, 200, '/api/config stays reachable during a forced change');
  });

  // ---- (7) image-run record hijack by client-chosen id (3.5) ----
  const hijackId = 'img_' + Date.now().toString(36) + '_hjk1';
  await check('image history: user A cannot take over user B\'s run by posting B\'s run id; B\'s record is unchanged', async () => {
    const b = await req('POST', '/api/image-arena/history', { as: 'bob', body: { run: {
      id: hijackId, at: Date.now(), prompt: 'Bob private prompt: a lighthouse at dusk', title: 'Bob lighthouse', imageSize: '1K', aspectRatio: '1:1',
      results: [{ slot: 'A', catalogId: 'nano-banana-2.1', label: 'Nano Banana 2.1', shortLabel: 'NB 2.1', model: 'nano-banana-2.1', imageSize: '1K', costUsd: 0.05 }],
    } } });
    assert.strictEqual(b.status, 200, b.text.slice(0, 200));
    assert.ok(b.json.saved && b.json.saved.id === hijackId, 'Bob saved his run under his client-minted id');
    const bobSees = await req('GET', `/api/image-arena/history/${hijackId}`, { as: 'bob' });
    assert.strictEqual(bobSees.status, 200);
    assert.strictEqual(bobSees.json.run.prompt, 'Bob private prompt: a lighthouse at dusk');

    const a = await req('POST', '/api/image-arena/history', { as: 'alice', body: { run: { id: hijackId, at: Date.now() + 86400000, title: 'Alice takeover' } } });
    const rejected = a.status >= 400 || (a.json && !a.json.saved && (a.json.savedCount || 0) === 0);
    assert.ok(rejected, `A's post for B's id must be rejected: ${a.status} ${a.text.slice(0, 200)}`);
    const aliceSees = await req('GET', `/api/image-arena/history/${hijackId}`, { as: 'alice' });
    assert.strictEqual(aliceSees.status, 404, 'Alice must not be able to read the run');
    const aliceList = await req('GET', '/api/image-arena/history', { as: 'alice' });
    assert.ok(!aliceList.json.runs.some((r) => r.id === hijackId), 'the run must not appear in Alice\'s list');
    const bobAgain = await req('GET', `/api/image-arena/history/${hijackId}`, { as: 'bob' });
    assert.strictEqual(bobAgain.status, 200, 'Bob still owns the run');
    assert.strictEqual(bobAgain.json.run.prompt, 'Bob private prompt: a lighthouse at dusk', 'prompt unchanged');
    assert.strictEqual(bobAgain.json.run.title, 'Bob lighthouse', 'title unchanged');
    assert.strictEqual(bobAgain.json.run.user, 'bob.user', 'owner unchanged');
    const bobList = await req('GET', '/api/image-arena/history', { as: 'bob' });
    assert.ok(bobList.json.runs.some((r) => r.id === hijackId), 'the run is still in Bob\'s list');
  });
  await check('image history: a stored thumbDataUrl must be a data:image/... URL (markup is not persisted)', async () => {
    const id = 'img_' + Date.now().toString(36) + '_xss1';
    const payload = '"><img src=x onerror=alert(1)>';
    const r = await req('POST', '/api/image-arena/history', { as: 'alice', body: { run: {
      id, at: Date.now(), prompt: 'p', results: [{ slot: 'A', catalogId: 'nano-banana-2.1', label: 'x', thumbDataUrl: payload, mimeType: 'text/html<script>' }],
    } } });
    if (r.status === 200 && r.json && r.json.saved) {
      const back = await req('GET', `/api/image-arena/history/${id}`, { as: 'alice' });
      assert.strictEqual(back.status, 200);
      const res0 = (back.json.run.results || [])[0] || {};
      assert.ok(!String(res0.thumbDataUrl || '').includes('onerror'), 'thumbDataUrl markup must not be stored');
      assert.ok(!String(res0.mimeType || '').includes('<'), 'mimeType must be allow-listed');
      assert.ok(!back.text.includes(payload), 'the payload must not come back from the server');
    } else {
      assert.ok(r.status >= 400 || !r.json.saved, 'rejected outright is also fine');
    }
  });

  // ---- (8) /api/cad-mcp/push must not fetch a client-supplied URL (3.7) ----
  await check('/api/cad-mcp/push with endpointUrl pointing at this server returns pushed:false and the route is never hit', async () => {
    const countHits = () => (out.match(/\[http\] POST \/api\/auth\/users \d+/g) || []).length;
    const hitsBefore = countHits();
    const r = await req('POST', '/api/cad-mcp/push', { as: 'alice', body: {
      code: 'function buildModel(THREE, CAD, params) { return new THREE.Group(); }',
      slot: 'A', modelLabel: 'x', taskTitle: 'ssrf',
      endpointUrl: `http://127.0.0.1:${PORT}/api/auth/users`,
    } });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.strictEqual(r.json.pushed, false, 'pushed must be false');
    await sleep(400);
    assert.strictEqual(countHits(), hitsBefore, 'the server must not POST to its own /api/auth/users on behalf of a user');
    const echoed = String(r.json.bridgeResponse || '');
    assert.ok(!/"users"\s*:/.test(echoed) && !/Authentication required/.test(echoed), 'no server-side response body is echoed back');
  });
  await check('/api/cad-mcp/push with an external endpointUrl is not fetched either', async () => {
    const r = await req('POST', '/api/cad-mcp/push', { as: 'alice', body: { code: 'x', endpointUrl: 'http://169.254.169.254/computeMetadata/v1/' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.pushed, false);
    assert.ok(!/blocked in test/.test(String(r.json.bridgeResponse || '')), 'the preload would have thrown "blocked in test" had the server fetched it');
  });

  // ---- (9) gzip scrub (3.8) ----
  await check('a configured secret value is masked in a gzipped /api/config body', async () => {
    const pref = await req('POST', '/api/me/preferences', { as: 'alice', body: { taskId: SEEDED_SECRET } });
    assert.strictEqual(pref.status, 200);
    const got = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET', headers: { Cookie: cookies.alice, 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.encoding, 'gzip', '/api/config (> 1 KB) is served gzipped when the client accepts gzip');
    const text = zlib.gunzipSync(got.body).toString('utf8');
    assert.ok(!text.includes(SEEDED_SECRET), 'the seeded OPENAI_API_KEY value leaked through the gzip path');
    assert.ok(text.includes('[REDACTED]'), 'the value is masked, not dropped');
    const plain = await req('GET', '/api/config', { as: 'alice', headers: { 'Accept-Encoding': 'identity' } });
    assert.ok(!plain.text.includes(SEEDED_SECRET) && plain.text.includes('[REDACTED]'), 'control: the identity path is scrubbed too');
    assert.strictEqual((await req('POST', '/api/me/preferences', { as: 'alice', body: { taskId: 'custom' } })).status, 200);
  });

  // ---- cross-user history PDF (12.4) ----
  await check('a non-owner non-admin cannot export another user\'s run as PDF (404), the owner and an admin can', async () => {
    const bobHist = await req('GET', '/api/history', { as: 'bob' });
    const runId = bobHist.json.runs[0] && bobHist.json.runs[0].id;
    assert.ok(runId, 'Bob has a completed run');
    const other = await req('GET', `/api/history/${encodeURIComponent(runId)}/pdf`, { as: 'alice' });
    assert.ok(other.status === 403 || other.status === 404, `expected 403/404, got ${other.status}`);
    assert.ok(!/^%PDF/.test(other.text), 'no PDF bytes for a non-owner');
    const owner = await req('GET', `/api/history/${encodeURIComponent(runId)}/pdf`, { as: 'bob' });
    assert.strictEqual(owner.status, 200);
    assert.ok(/^%PDF-1\.4/.test(owner.text), 'owner gets the PDF');
    const admin = await req('GET', `/api/history/${encodeURIComponent(runId)}/pdf`, { as: 'admin' });
    assert.strictEqual(admin.status, 200, 'admin can export any run');
  });

  stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`\nverify-auth-hardening: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log('failing: ' + failures.map((f) => `\n  - ${f}`).join(''));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
