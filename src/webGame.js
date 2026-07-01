// ---------------------------------------------------------------------------
// webGame.js — build a Pygame program into a browser-runnable WebAssembly bundle
// (via pygbag) so GUI tasks render IN THE BROWSER instead of opening a native
// window on the server host. This is what makes "Run code" work for a REMOTE
// user: the game runs in *their* browser, not on the machine running the server.
//
// Security note: pygbag only PACKAGES the source (zips it + emits an HTML loader)
// — it does NOT execute the game on the host. The code only runs later, inside
// the browser's WASM sandbox. So this path is safer than the native launcher.
//
// Disable with ENABLE_WEB_GAME=0. Requires `pip install pygbag` + Python on PATH.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PYTHON_CMD = process.env.PYTHON_CMD || 'python';
const BUILD_TIMEOUT_MS = (Number(process.env.WEB_GAME_BUILD_TIMEOUT_SEC) || 240) * 1000;
const ROOT = path.join(os.tmpdir(), 'ullm-webgames');

const games = new Map();   // id -> { dir, builtAt }
const building = new Map(); // id -> Promise (dedupe concurrent builds of the same code)

function webGameEnabled() { return process.env.ENABLE_WEB_GAME !== '0'; }

function idFor(code) { return crypto.createHash('sha256').update(code).digest('hex').slice(0, 16); }
function webDirFor(id) { return path.join(ROOT, id, 'build', 'web'); }

// Build (or reuse a cached build of) the given Python/Pygame source. Returns
// { id, cached }. Concurrent requests for identical code share one build.
async function buildWebGame(code) {
  const id = idFor(code);
  const webDir = webDirFor(id);
  if (games.has(id) && fs.existsSync(path.join(webDir, 'index.html'))) return { id, cached: true };
  if (building.has(id)) { await building.get(id); return { id, cached: true }; }

  const p = (async () => {
    const appDir = path.join(ROOT, id);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'main.py'), code, 'utf8'); // pygbag entry point must be main.py
    await runPygbag(appDir);
    const idxPath = path.join(webDir, 'index.html');
    if (!fs.existsSync(idxPath)) {
      throw new Error('pygbag finished but produced no build/web/index.html');
    }
    patchIndexHtml(idxPath);
    games.set(id, { dir: webDir, builtAt: Date.now() });
  })();
  building.set(id, p);
  try { await p; } finally { building.delete(id); }
  return { id, cached: false };
}

// pygbag 0.9.3's generated loader references browserfs.min.js at a CDN path that
// now 404s (the pygame-web CDN dropped it), which leaves the game stuck on
// "Loading…". Repoint it at a reliable copy on jsdelivr so BrowserFS resolves.
function patchIndexHtml(idxPath) {
  try {
    let html = fs.readFileSync(idxPath, 'utf8');
    const fixed = html.replace(
      /https:\/\/pygame-web\.github\.io\/cdn\/[0-9.]+\/+browserfs\.min\.js/g,
      'https://cdn.jsdelivr.net/npm/browserfs@1.4.3/dist/browserfs.min.js',
    );
    if (fixed !== html) fs.writeFileSync(idxPath, fixed, 'utf8');
  } catch (e) { /* non-fatal: leave the file as-is */ }
}

function runPygbag(appDir) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'pygbag', '--build', path.join(appDir, 'main.py')];
    let child;
    try {
      child = spawn(PYTHON_CMD, args, { cwd: appDir, windowsHide: true });
    } catch (e) { return reject(new Error('Failed to start pygbag: ' + e.message)); }
    let log = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('pygbag build timed out')); }, BUILD_TIMEOUT_MS);
    const grab = (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); };
    child.stdout.on('data', grab); // pygbag logs progress to stdout
    child.stderr.on('data', grab);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('Failed to run pygbag: ' + e.message + (e.code === 'ENOENT' ? ` (is "${PYTHON_CMD}" on PATH and is pygbag installed? "pip install pygbag")` : '')));
    });
    child.on('close', (codeNum) => {
      clearTimeout(timer);
      if (codeNum === 0) return resolve();
      // Surface a hint if pygbag itself is missing.
      const hint = /No module named pygbag/i.test(log) ? ' — pygbag is not installed (run: pip install pygbag).' : '';
      reject(new Error(`pygbag build failed (exit ${codeNum})${hint} ${log.trim().slice(-600)}`));
    });
  });
}

// Absolute path of the built web dir for an id, or null. Used by the static route.
function gameDir(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return null; // ids are sha256 prefixes
  const g = games.get(id);
  if (g) return g.dir;
  // survive a server restart: re-adopt a build that's still on disk
  const dir = webDirFor(id);
  if (fs.existsSync(path.join(dir, 'index.html'))) { games.set(id, { dir, builtAt: Date.now() }); return dir; }
  return null;
}

module.exports = { buildWebGame, gameDir, webGameEnabled, idFor };
