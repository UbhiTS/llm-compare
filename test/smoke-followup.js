// ---------------------------------------------------------------------------
// smoke-followup.js — black-box HTTP checks for the security follow-up, run
// against the real server in production-like mode:
//   ENABLE_CODE_EXEC=0 (D1), LOG_FORMAT=json (O5), ENABLE_WEB_GAME=1 (no build).
// Covers /healthz + /api/health, exec disabled but GUI tasks still runnable,
// multipart upload parity with base64 inspect (O4), expired-cache 409 with no
// quota consumed (O2), structured logs without secrets, SIGTERM drain.
// Offline: never calls a model provider.
//   node test/smoke-followup.js
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_FOLLOWUP_PORT || 18766);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-smoke2-'));
let failed = 0;
const check = (name, cond, extra) => { if (!cond) failed++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };

async function req(method, p, { body, headers = {}, raw } = {}) {
  const h = { ...headers };
  let payload;
  if (raw != null) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, text, json };
}

(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', APP_DATA_DIR: tmp, AUTH_DATA_DIR: path.join(tmp, 'auth'),
    ENABLE_CODE_EXEC: '0', ENABLE_WEB_GAME: '1', LOG_FORMAT: 'json', SHUTDOWN_DRAIN_MS: '5000',
    OPENAI_API_KEY: 'sk-smokecanary0123456789abcdef',
  };
  delete env.K_SERVICE; delete env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => srv.on('exit', (code, sig) => r({ code, sig })));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (_) { /* ignore */ } });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch (_) { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { console.error('server did not start\n' + out); process.exit(1); }

  // O5 health
  let r = await req('GET', '/healthz');
  check('GET /healthz → 200 {ok:true} (unauthenticated)', r.status === 200 && r.json && r.json.ok === true);
  r = await req('GET', '/api/health');
  check('GET /api/health alias → 200', r.status === 200 && r.json && r.json.ok === true);

  // D1: exec off, GUI tasks still runnable (WASM path), non-GUI tasks not
  r = await req('GET', '/api/config');
  const tasks = (r.json && r.json.tasks) || [];
  const gui = tasks.filter((t) => t.gui);
  const nonGuiExec = tasks.filter((t) => !t.gui && t.executable);
  check('config: codeExec=false, webGame=true', r.json && r.json.codeExec === false && r.json.webGame === true);
  check('config: GUI game tasks keep Run (executable) with exec off', gui.length >= 3 && gui.every((t) => t.executable), `gui=${gui.map((t) => t.id).join(',')}`);
  check('config: non-GUI tasks not executable with exec off', nonGuiExec.length === 0);
  r = await req('POST', '/api/execute', { body: { language: 'python', code: 'print(1)', taskId: 'hanoi-python' } });
  check('/api/execute refused when ENABLE_CODE_EXEC=0', r.status === 400 && /disabled/i.test((r.json && r.json.error) || ''), `[${r.status}]`);

  // O4 multipart parity with base64 JSON inspect
  const csv = Buffer.from('region,revenue\nwest,10\neast,12\n');
  const j = await req('POST', '/api/attachments/inspect', { body: { attachments: [{ name: 'r.csv', mimeType: 'text/csv', data: csv.toString('base64') }] } });
  const boundary = '----smokeBoundary' + Date.now();
  const mp = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="r.csv"\r\nContent-Type: text/csv\r\n\r\n`), csv, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const m = await req('POST', '/api/attachments/upload', { raw: mp, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  check('multipart /api/attachments/upload → same result as base64 inspect', m.status === 200 && j.status === 200 && JSON.stringify(m.json) === JSON.stringify(j.json), `[${m.status}]`);
  const a0 = j.json && j.json.attachments[0];
  check('inspect returns sha1 (legacy) + sha256', a0 && /^[0-9a-f]{40}$/.test(a0.sha1) && /^[0-9a-f]{64}$/.test(a0.sha256));
  r = await req('POST', '/api/attachments/upload', { raw: Buffer.from('garbage'), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  check('multipart malformed → 400', r.status === 400);

  // O2: cached references (sha256 + legacy sha1) and expired → 409, quota untouched
  const before = await req('GET', '/api/config');
  const expiredRef = [{ sha256: 'a'.repeat(64), name: 'gone.csv', mimeType: 'text/csv' }];
  r = await req('POST', '/api/run', { body: { taskId: 'custom', customPrompt: 'x', models: [{ slot: 'D', catalogId: 'gpt-6-sol' }], attachments: expiredRef } });
  check('/api/run with expired cached attachment → 409 ATTACHMENT_EXPIRED', r.status === 409 && r.json && r.json.code === 'ATTACHMENT_EXPIRED' && r.json.expired[0].name === 'gone.csv', `[${r.status}]`);
  r = await req('POST', '/api/run', { body: { taskId: 'custom', customPrompt: 'x', models: [{ slot: 'D', catalogId: 'gpt-6-sol' }], attachments: [{ sha1: 'b'.repeat(40), name: 'old.csv' }] } });
  check('/api/run with expired legacy sha1 reference → 409', r.status === 409 && r.json.code === 'ATTACHMENT_EXPIRED');
  const after = await req('GET', '/api/config');
  check('409 consumed no OpenAI quota', JSON.stringify(before.json.me) === JSON.stringify(after.json.me));
  r = await req('POST', '/api/judge', { body: { judge: 'gemini-3.5-flash-lite', entries: [{ slot: 'A', text: 'a' }, { slot: 'B', text: 'b' }], attachments: expiredRef } });
  check('/api/judge with expired cached attachment → 409', r.status === 409 && r.json.code === 'ATTACHMENT_EXPIRED');

  // O5 graceful drain: an in-flight upload started before SIGTERM still completes.
  const inflight = new Promise((resolve) => {
    const hr = http.request({ host: '127.0.0.1', port: PORT, path: '/api/attachments/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': mp.length } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    hr.on('error', (e) => resolve({ status: 'error:' + e.message }));
    hr.write(mp.subarray(0, 20));
    setTimeout(() => { srv.kill('SIGTERM'); }, 150);
    setTimeout(() => { hr.end(mp.subarray(20)); }, 600);
  });
  const t0 = Date.now();
  const inf = await inflight;
  check('SIGTERM: in-flight request completes during drain', inf.status === 200, `[${inf.status}]`);
  let refused = false;
  try { await fetch(`http://127.0.0.1:${PORT}/healthz`); } catch (_) { refused = true; }
  check('SIGTERM: new connections refused while draining', refused);
  const ex = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 8000))]);
  check('SIGTERM: process exits 0 after drain', ex.code === 0, `code=${ex.code} ${Date.now() - t0}ms`);

  // O5 structured logs
  const lines = out.split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
  check('logs: every line is JSON with a severity', parsed.length > 0 && parsed.every((p) => p && typeof p.severity === 'string' && 'message' in p), `${parsed.filter(Boolean).length}/${lines.length}`);
  check('logs: shutdown events logged', parsed.some((p) => p && /\[shutdown\] SIGTERM/.test(p.message)) && parsed.some((p) => p && /drained cleanly/.test(p.message)));
  check('logs: no secret canary / CSV content leaked', !/sk-smokecanary|west,10/.test(out));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`\nFOLLOW-UP SMOKE: ${failed ? failed + ' FAILED' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
