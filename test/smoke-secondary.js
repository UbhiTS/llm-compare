// ---------------------------------------------------------------------------
// smoke-secondary.js — the optional second HTTP listener is OFF by default
// (audit R10). It only starts when SECONDARY_PORT is a port number.
//   node test/smoke-secondary.js
// Offline: never calls a model provider.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_SECONDARY_PORT || 18768);
const SECOND = PORT + 1;
let failed = 0;
const check = (name, cond, extra) => { if (!cond) failed++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch (_) { return false; }
}

async function withServer(secondary, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-smoke-sec-'));
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', APP_DATA_DIR: tmp, AUTH_DATA_DIR: path.join(tmp, 'auth') };
  delete env.K_SERVICE; delete env.ANTIGRAVITY_SIDECAR_WEB_PORT; delete env.SECONDARY_PORT;
  if (secondary !== undefined) env.SECONDARY_PORT = secondary;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => srv.on('exit', r));
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await reachable(PORT); if (!up) await sleep(250); }
    if (!up) throw new Error('server did not start\n' + out);
    await sleep(300); // let a secondary listener (if any) bind
    await fn(() => out);
  } finally {
    srv.kill('SIGTERM');
    await Promise.race([exited, sleep(12000)]);
    try { srv.kill('SIGKILL'); } catch (_) { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

(async () => {
  await withServer(undefined, async (out) => {
    check('SECONDARY_PORT unset: primary serves', await reachable(PORT));
    check('SECONDARY_PORT unset: no secondary listener started', !/secondary URL/.test(out()));
  });
  await withServer('0', async (out) => {
    check('SECONDARY_PORT=0: no secondary listener', !/secondary URL/.test(out()));
  });
  await withServer('abc', async (out) => {
    check('SECONDARY_PORT=abc (not a port): no secondary listener', !/secondary URL/.test(out()));
  });
  await withServer(String(SECOND), async (out) => {
    check(`SECONDARY_PORT=${SECOND}: secondary listener serves`, await reachable(SECOND) && new RegExp(`secondary URL .*:${SECOND}`).test(out()));
  });
  check(`after shutdown: :${SECOND} closed`, !(await reachable(SECOND)));
  console.log(`\nSECONDARY LISTENER SMOKE: ${failed ? failed + ' FAILED' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
