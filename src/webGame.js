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

// Make LLM-generated pygame code survive pygbag's WASM runtime. The big one:
// `import pygame.gfxdraw` — gfxdraw isn't in pygbag's pygame-ce build, and the
// failed import triggers pygbag's pip-install fallback, which fetches a
// non-existent PyPI package and crashes the async loop *during import* (before a
// single frame renders). Models emit this constantly (often unused). We strip the
// import and shim pygame.gfxdraw to a no-op so import-only games run and any real
// usage degrades gracefully (that draw is skipped) instead of killing the game.
function sanitizeForPygbag(code) {
  const src = String(code || '');
  const usesGfx = /(^|\n)\s*import\s+pygame\.gfxdraw\b/.test(src) || /(^|\n)\s*from\s+pygame\s+import\b[^\n]*\bgfxdraw\b/.test(src);
  if (!usesGfx) return src;
  let out = src
    .replace(/^([ \t]*)import\s+pygame\.gfxdraw(?:\s+as\s+\w+)?[ \t]*$/gm, '$1pass  # pygbag: pygame.gfxdraw not available in WASM (shimmed below)')
    .replace(/^([ \t]*)from\s+pygame\s+import\s+gfxdraw[ \t]*$/gm, '$1pass  # pygbag: gfxdraw import removed (shimmed below)');
  const shim = [
    'import pygame as _pgb_pygame',
    'if not hasattr(_pgb_pygame, "gfxdraw"):',
    '    class _PgbNoGfxdraw:',
    '        def __getattr__(self, _name):',
    '            return lambda *a, **k: None',
    '    _pgb_pygame.gfxdraw = _PgbNoGfxdraw()',
    '',
    '',
  ].join('\n');
  return shim + out;
}

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
    fs.writeFileSync(path.join(appDir, 'main.py'), sanitizeForPygbag(code), 'utf8'); // pygbag entry point must be main.py
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
    html = html.replace(
      /https:\/\/pygame-web\.github\.io\/cdn\/[0-9.]+\/+browserfs\.min\.js/g,
      'https://cdn.jsdelivr.net/npm/browserfs@1.4.3/dist/browserfs.min.js',
    );
    // Auto-start the game instead of blocking on a user click. pygbag computes
    // MM.UME = !ume_block, so the default ume_block:1 leaves MM.UME false and the
    // loader sits waiting for a gesture — which, embedded in an iframe that just
    // reads "Loading…", the user has no idea they need to make. ume_block:0 starts
    // the game immediately; the audio context simply resumes on the first click.
    html = html.replace(/ume_block\s*:\s*1/g, 'ume_block : 0');
    // Make the game page self-diagnosing: surface real errors (ignoring browser-
    // extension noise like the injected share-modal.js), and if pygbag's loader
    // never hands off, drop its "Loading…" overlay after a grace period so a
    // running or frozen game is visible instead of a perpetual spinner.
    if (html.indexOf('ullm-diag') < 0) {
      const nl = '\\n';
      const diag =
        '<script>(function(){' +
        'function box(){var e=document.getElementById("ullm-diag");if(!e){e=document.createElement("div");e.id="ullm-diag";' +
        'e.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(30,0,0,.92);color:#ff9b9b;font:12px/1.4 monospace;padding:8px 10px;white-space:pre-wrap;max-height:45%;overflow:auto";' +
        'document.body.appendChild(e);}return e;}' +
        'function noise(s){s=String(s||"");return s.indexOf("share-modal")>=0||s.indexOf("Could not establish connection")>=0||s.indexOf("Receiving end does not exist")>=0;}' +
        'window.addEventListener("error",function(e){var src=(e&&e.filename)||"";if(noise(src)||noise(e&&e.message))return;box().textContent+="JS error: "+((e&&e.message)||e)+(src?(" @ "+src+":"+(e.lineno||"")):"")+"' + nl + '";});' +
        'window.addEventListener("unhandledrejection",function(e){var r=e&&e.reason;var m=(r&&r.message)||r;if(noise(m))return;box().textContent+="Promise rejected: "+m+"' + nl + '";});' +
        'setTimeout(function(){var ib=document.getElementById("infobox");if(ib)ib.style.display="none";' +
        'var c=document.getElementById("canvas");if(c&&c.width<=1){var pc=document.getElementById("pyconsole");if(pc){pc.hidden=false;pc.style.cssText="position:fixed;left:0;right:0;bottom:0;height:45%;z-index:2147483646;background:#000;color:#ddd;overflow:auto;font:11px monospace";}}},15000);' +
        '})();</script>';
      if (html.indexOf('</body>') >= 0) html = html.replace('</body>', diag + '\n</body>');
      else html += diag;
    }
    fs.writeFileSync(idxPath, html, 'utf8');
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
