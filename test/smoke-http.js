// ---------------------------------------------------------------------------
// smoke-http.js — black-box HTTP smoke + regression test for the real server.
//
// Spawns `node server.js` on a throwaway port with an isolated data dir, then
// exercises every main endpoint and records status codes + response shapes so a
// before/after comparison proves there are no functional regressions.
//
//   node test/smoke-http.js               # functional checks + security probes
//   SMOKE_LIVE=1 node test/smoke-http.js  # also runs one REAL compare + judge
//                                         # (Gemini 3.5 Flash / Flash-Lite on Vertex AI)
//   SMOKE_JSON=out.json node test/smoke-http.js   # also write results as JSON
//
// Functional checks FAIL the process (exit 1). Security probes are informational
// (they report VULNERABLE / PROTECTED) and never fail the run, so the same script
// can be run on the pre-fix baseline and on the hardened code.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 18765);
const LIVE = process.env.SMOKE_LIVE === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-smoke-'));

const results = [];   // functional
const probes = [];    // security (informational)
let failed = 0;

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

function shape(v) {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().join(',') + '}';
  return typeof v;
}

async function req(method, p, { body, headers = {}, host = '127.0.0.1', raw } = {}) {
  const url = `http://${host}:${PORT}${p}`;
  const h = { ...headers };
  let payload;
  if (raw != null) { payload = raw; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const t0 = Date.now();
  const r = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, headers: r.headers, text, json, ms: Date.now() - t0 };
}

function check(name, cond, info) {
  const ok = !!cond;
  if (!ok) failed++;
  results.push({ name, ok, ...info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info && info.status != null ? `  [${info.status}]` : ''}${info && info.shape ? '  ' + info.shape : ''}`);
}
function probe(name, vulnerable, detail) {
  probes.push({ name, result: vulnerable ? 'VULNERABLE' : 'PROTECTED', detail });
  console.log(`  ${vulnerable ? '!! VULNERABLE' : '   PROTECTED '}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- tiny fixture builders (no deps) ----
function zipOf(entries) {
  // entries: [{ name, data:Buffer, method:0|8 }]
  const locals = [];
  for (const e of entries) {
    const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const hdr = Buffer.alloc(30);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(0, 6);
    hdr.writeUInt16LE(e.method, 8);
    hdr.writeUInt32LE(0, 14);                // crc (unused by our extractor)
    hdr.writeUInt32LE(comp.length, 18);
    hdr.writeUInt32LE(e.data.length, 22);
    hdr.writeUInt16LE(nameBuf.length, 26);
    hdr.writeUInt16LE(0, 28);
    locals.push(hdr, nameBuf, comp);
  }
  return Buffer.concat(locals);
}
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function tinyPdf(text) {
  const content = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`); if (r.ok) return true; } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '0.0.0.0',                // so the LAN-IP auth probe can reach it
    APP_DATA_DIR: tmp,
    AUTH_DATA_DIR: path.join(tmp, 'auth'),
    ENABLE_WEB_GAME: '0',
    SMOKE_CANARY_SECRET_TOKEN: 'canary-should-not-leak',
  };
  delete env.K_SERVICE;
  delete env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch (_) { /* ignore */ } };
  process.on('exit', stop);

  if (!(await waitUp())) { console.error('server did not start\n' + srvLog); process.exit(1); }

  // ---------------- FUNCTIONAL ----------------
  let r = await req('GET', '/login');
  check('GET /login serves HTML', r.status === 200 && /<html|<!doctype/i.test(r.text), { status: r.status });

  r = await req('GET', '/api/auth/status');
  check('GET /api/auth/status', r.status === 200 && r.json && 'authenticated' in r.json && 'setupRequired' in r.json, { status: r.status, shape: shape(r.json) });

  r = await req('POST', '/api/auth/login', { body: { username: 'nobody', password: 'wrong-password-123' } });
  check('POST /api/auth/login bad creds -> 401 generic', r.status === 401 && r.json && /Invalid username or password/.test(r.json.error), { status: r.status, shape: shape(r.json) });

  r = await req('GET', '/');
  check('GET / (index, loopback auto-auth)', r.status === 200 && /app\.js/.test(r.text), { status: r.status });
  const csp = r.headers.get('content-security-policy') || '';
  check('Security headers on /', /default-src 'self'/.test(csp) && r.headers.get('x-content-type-options') === 'nosniff', { status: r.status });

  r = await req('GET', '/app.js');
  check('GET /app.js', r.status === 200 && r.text.length > 10000, { status: r.status });

  r = await req('GET', '/api/config');
  const cfgKeys = ['catalog', 'codeExec', 'keysPresent', 'me', 'models', 'tasks', 'webGame'];
  check('GET /api/config', r.status === 200 && r.json && cfgKeys.every((k) => k in r.json) && r.json.catalog.length > 5 && r.json.tasks.length > 5, { status: r.status, shape: shape(r.json) });
  const cfg = r.json || {};

  r = await req('GET', '/api/history');
  check('GET /api/history', r.status === 200 && r.json && Array.isArray(r.json.runs), { status: r.status, shape: shape(r.json) });

  r = await req('GET', '/api/history/doesnotexist');
  check('GET /api/history/:id unknown -> 404', r.status === 404, { status: r.status, shape: shape(r.json) });

  r = await req('GET', '/api/history/..%2F..%2Fetc%2Fpasswd');
  check('GET /api/history/:id traversal -> 404', r.status === 404, { status: r.status });

  r = await req('POST', '/api/run', { raw: '{bad json' });
  check('Invalid JSON -> 400 {type:error}', r.status === 400 && r.json && r.json.type === 'error', { status: r.status, shape: shape(r.json) });

  const txt = Buffer.from('hello,world\n1,2\n').toString('base64');
  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'a.csv', mimeType: 'text/csv', data: txt }] } });
  const a0 = r.json && r.json.attachments && r.json.attachments[0];
  check('inspect: CSV -> text', r.status === 200 && a0 && a0.kind === 'text' && a0.extractedChars > 0 && /^[0-9a-f]{40}$/.test(a0.sha1), { status: r.status, shape: shape(a0) });
  const csvSha1 = a0 && a0.sha1;

  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'p.png', mimeType: 'image/png', data: PNG_1x1 }] } });
  check('inspect: PNG -> image', r.status === 200 && r.json.attachments[0].kind === 'image', { status: r.status });

  const docZip = zipOf([
    { name: 'notes.txt', data: Buffer.from('stored entry text'), method: 0 },
    { name: 'word/document.xml', data: Buffer.from('<w:document><w:p>Deflated DOCX paragraph</w:p></w:document>'), method: 8 },
  ]);
  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'x.zip', mimeType: 'application/zip', data: docZip.toString('base64') }] } });
  check('inspect: ZIP (stored+deflate) -> text', r.status === 200 && r.json.attachments[0].kind === 'text' && r.json.attachments[0].extractedChars > 20, { status: r.status, shape: `extractedChars=${r.json && r.json.attachments[0].extractedChars}` });

  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'd.pdf', mimeType: 'application/pdf', data: tinyPdf('Quarterly revenue grew twelve percent').toString('base64') }] } });
  const pdf0 = r.json && r.json.attachments[0];
  check('inspect: PDF -> pdf w/ text', r.status === 200 && pdf0.kind === 'pdf' && pdf0.pageCount === 1 && pdf0.extractedChars > 20, { status: r.status, shape: `pages=${pdf0 && pdf0.pageCount} chars=${pdf0 && pdf0.extractedChars}` });

  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'e.txt', data: '' }] } });
  check('inspect: empty file -> empty', r.status === 200 && r.json.attachments[0].kind === 'empty', { status: r.status });

  r = await req('POST', '/api/judge', { body: { judge: 'not-a-model', entries: [] } });
  check('judge: bad judge -> 400', r.status === 400 && r.json && r.json.error, { status: r.status });

  const judgeId = (cfg.catalog || []).find((c) => c.id === 'gemini-3.5-flash-lite') ? 'gemini-3.5-flash-lite' : (cfg.catalog || [])[0] && cfg.catalog[0].id;
  r = await req('POST', '/api/judge', { body: { judge: judgeId, entries: [{ slot: 'A', label: 'x', text: 'only one' }] } });
  check('judge: <2 entries -> 400', r.status === 400 && /two/.test((r.json && r.json.error) || ''), { status: r.status });

  r = await req('POST', '/api/execute', { body: { language: 'python', code: 'print("hi from python")', taskId: 'hanoi-python' } });
  check('execute: python program', r.status === 200 && r.json && r.json.kind === 'program' && /hi from python/.test(r.json.stdout), { status: r.status, shape: shape(r.json) });

  r = await req('POST', '/api/execute', { body: { language: 'javascript', taskId: 'lis', code: 'function lengthOfLIS(a){const t=[];for(const x of a){let l=0,h=t.length;while(l<h){const m=(l+h)>>1;if(t[m]<x)l=m+1;else h=m;}t[l]=x;}return t.length;}' } });
  check('execute: javascript tests (correct LIS)', r.status === 200 && r.json && r.json.kind === 'tests' && r.json.passed === r.json.total && r.json.total === 10, { status: r.status, shape: `passed=${r.json && r.json.passed}/${r.json && r.json.total}` });

  r = await req('POST', '/api/execute', { body: { language: 'ruby', code: 'x' } });
  check('execute: unsupported language -> 400', r.status === 400, { status: r.status });

  r = await req('GET', '/games/zzzz/');
  check('GET /games/<bad id>/ -> 404', r.status === 404, { status: r.status });

  // ---------------- LIVE (optional, costs a few cents) ----------------
  if (LIVE) {
    const run = await req('POST', '/api/run', { body: { taskId: 'custom', customPrompt: 'Reply with exactly: OK', models: [{ slot: 'A', catalogId: 'gemini-3.5-flash' }] } });
    const lines = run.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const types = [...new Set(lines.map((l) => l.type))];
    const done = lines.find((l) => l.type === 'done');
    check('LIVE /api/run (Gemini 3.5 Flash, NDJSON)', run.status === 200 && types.includes('all_done') && done && !done.result.error, { status: run.status, shape: `events=${types.join(',')}` });
    const out = done && done.result && (done.result.code || done.result.text || '');
    const j = await req('POST', '/api/judge', { body: { judge: 'gemini-3.5-flash-lite', taskId: 'custom', prompt: 'Name the capital of France.', entries: [{ slot: 'A', label: 'M1', text: 'Paris is the capital of France.' }, { slot: 'B', label: 'M2', text: 'Lyon.' }] } });
    check('LIVE /api/judge (Gemini 3.5 Flash-Lite)', j.status === 200 && j.json && j.json.ok && Array.isArray(j.json.results) && j.json.results.length === 2, { status: j.status, shape: shape(j.json) + (out ? '' : '') });
    const csvRun = await req('POST', '/api/run', { body: { taskId: 'custom', customPrompt: 'How many data rows are in the attached CSV? Answer with a number.', models: [{ slot: 'A', catalogId: 'gemini-3.5-flash' }], attachments: [{ sha1: csvSha1, name: 'a.csv', mimeType: 'text/csv' }] } });
    check('LIVE /api/run with cached sha1 attachment', csvRun.status === 200 && /"all_done"/.test(csvRun.text), { status: csvRun.status });
  }

  // ---------------- SECURITY PROBES (informational) ----------------
  console.log('\nSecurity probes:');
  const ip = lanIp();
  if (ip) {
    try {
      const plain = await req('GET', '/api/config', { host: ip });
      // fetch() drops a custom Host header, so use the raw http client here.
      const spoofStatus = await new Promise((resolve) => {
        const hr = require('http').request({ host: ip, port: PORT, path: '/api/config', method: 'GET', headers: { Host: `localhost:${PORT}` } }, (res) => { res.resume(); resolve(res.statusCode); });
        hr.on('error', (e) => resolve('error:' + e.message));
        hr.end();
      });
      const spoof = { status: spoofStatus };
      probe('SEC-01 LAN client spoofs "Host: localhost" to get auto-admin', spoof.status === 200, `LAN-IP plain=${plain.status}, spoofed Host=${spoof.status}`);
      const xff = await req('GET', '/api/config', { host: ip, headers: { 'X-Forwarded-For': '127.0.0.1' } });
      probe('SEC-01b LAN client spoofs X-Forwarded-For: 127.0.0.1', xff.status === 200, `status=${xff.status}`);
    } catch (e) { probe('SEC-01 LAN probe', false, 'skipped: ' + e.message); }
  } else probe('SEC-01 LAN probe', false, 'skipped (no LAN IPv4)');

  // DNS rebinding: loopback TCP peer but a foreign Host header (attacker domain → 127.0.0.1).
  const rebindStatus = await new Promise((resolve) => {
    const hr = require('http').request({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET', headers: { Host: 'rebind.attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    hr.on('error', (e) => resolve('error:' + e.message));
    hr.end();
  });
  probe('SEC-01c DNS-rebinding (loopback peer, foreign Host) gets auto-admin', rebindStatus === 200, `status=${rebindStatus}`);
  const bigLogin = await req('POST', '/api/auth/login', { raw: JSON.stringify({ username: 'x', password: 'y', pad: 'A'.repeat(8 * 1024 * 1024) }) });
  probe('SEC-06 unauthenticated 8 MB JSON body parsed pre-auth (/api/auth/login)', bigLogin.status !== 413, `status=${bigLogin.status}`);

  r = await req('POST', '/api/execute', { body: { language: 'javascript', taskId: 'lis', code: 'var __esc; try { __esc = typeof this.constructor.constructor("return process")().pid; } catch (e) { __esc = "blocked"; } function lengthOfLIS(){ return __esc; }' } });
  const got = r.json && r.json.failing && r.json.failing[0] && r.json.failing[0].gotStr;
  probe('SEC-02 vm sandbox escape to host `process` via /api/execute', got === '"number"', `gotStr=${got}`);

  r = await req('POST', '/api/execute', { body: { language: 'python', taskId: 'hanoi-python', code: 'import os\nprint(sorted(k for k in os.environ if any(s in k for s in ("KEY","TOKEN","SECRET","PASSWORD"))))' } });
  const leaked = (r.json && r.json.stdout) || '';
  probe('SEC-03 secrets visible in /api/execute python env', /KEY|TOKEN|SECRET|PASSWORD/.test(leaked), `env names=${leaked.trim().slice(0, 160)}`);

  const bombRaw = Buffer.alloc(200 * 1024 * 1024, 0x41);   // 200 MB of 'A' → ~200 KB deflated
  const bomb = zipOf([{ name: 'bomb.txt', data: bombRaw, method: 8 }]);
  const tb = Date.now();
  r = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'bomb.zip', mimeType: 'application/zip', data: bomb.toString('base64') }] } });
  const bombMs = Date.now() - tb;
  const bombChars = r.json && r.json.attachments && r.json.attachments[0] && r.json.attachments[0].extractedChars;
  // Output is sliced to 2.5M chars either way, so the observable signal over HTTP is
  // latency; the memory impact (≈ +850 MB RSS pre-fix vs ≈ 0 post-fix) is measured
  // in-process by the differential test documented in SECURITY_AUDIT.md.
  probes.push({ name: 'SEC-04 ZIP bomb (200 MB from ' + Math.round(bomb.length / 1024) + ' KB) — informational', result: 'INFO', detail: `status=${r.status} ${bombMs}ms extractedChars=${bombChars}` });
  console.log(`     INFO        SEC-04 ZIP bomb — status=${r.status} ${bombMs}ms extractedChars=${bombChars}`);

  stop();
  const summary = { when: new Date().toISOString(), live: LIVE, functional: { passed: results.filter((x) => x.ok).length, failed }, results, probes };
  if (process.env.SMOKE_JSON) fs.writeFileSync(process.env.SMOKE_JSON, JSON.stringify(summary, null, 2));
  console.log(`\nFUNCTIONAL: ${summary.functional.passed} passed, ${failed} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
