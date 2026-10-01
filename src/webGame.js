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

const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');
const BUILD_TIMEOUT_MS = (Number(process.env.WEB_GAME_BUILD_TIMEOUT_SEC) || 240) * 1000;
const ROOT = path.join(os.tmpdir(), 'ullm-webgames');

const games = new Map();   // id -> { dir, builtAt }
const building = new Map(); // id -> Promise (dedupe concurrent builds of the same code)

function webGameEnabled() { return process.env.ENABLE_WEB_GAME !== '0'; }

function idFor(code) { return crypto.createHash('sha256').update(code).digest('hex').slice(0, 16); }
function webDirFor(id) { return path.join(ROOT, id, 'build', 'web'); }

const MAX_CACHED_GAMES = Number(process.env.MAX_CACHED_WEB_GAMES) || 25;

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA', 'PYTHONPATH', 'VIRTUAL_ENV',
];

function buildSafeGameEnv() {
  const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function pruneOldGames() {
  if (games.size <= MAX_CACHED_GAMES) return;
  const entries = Array.from(games.entries()).sort((a, b) => (a[1].builtAt || 0) - (b[1].builtAt || 0));
  while (games.size > MAX_CACHED_GAMES && entries.length) {
    const [oldId] = entries.shift();
    if (building.has(oldId)) continue;
    games.delete(oldId);
    try {
      fs.rmSync(path.join(ROOT, oldId), { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  }
}

// Make LLM-generated pygame code survive pygbag's WASM runtime and distinguish
// real unhandled crashes from caught per-frame try/except logs.
// 1. Strip `import pygame.gfxdraw` (not in pygbag's pygame-ce build; triggers a
//    failing PyPI fetch during import) and shim `pygame.gfxdraw` to a no-op.
// 2. Shim `pygame.event.get_events` -> `pygame.event.get` and `Rect.padded` if called.
// 3. Wrap `pygame.mixer` so headless/autoplay-blocked browser audio never crashes init.
// 4. Neutralize `sys.exit()` / `exit()` / `quit()` so `SystemExit` doesn't kill WASM.
// 5. Emit `___ULLM_GAME_BOOTED___` when `pygame.display.set_mode` succeeds, and
//    emit `___ULLM_FATAL_PYTHON_CRASH___` ONLY when an unhandled exception escapes
//    the game loop or top-level `asyncio.run(main())`.
function sanitizeForPygbag(code) {
  const src = String(code || '');
  if (src.includes('# --- ullm pygbag WASM compatibility & crash-detection preamble ---')) {
    return src;
  }
  const out = src
    .replace(/^([ \t]*)import\s+pygame\.gfxdraw(?:\s+as\s+\w+)?[ \t]*$/gm, '$1pass  # pygbag: pygame.gfxdraw shimmed below')
    .replace(/^([ \t]*)from\s+pygame\s+import\s+gfxdraw[ \t]*$/gm, '$1pass  # pygbag: gfxdraw import shimmed below');

  const preamble = [
    '# --- ullm pygbag WASM compatibility & crash-detection preamble ---',
    'import sys as _pgb_sys, builtins as _pgb_builtins, traceback as _pgb_tb, asyncio as _pgb_asyncio',
    '_pgb_sys.exit = lambda *a, **k: None',
    '_pgb_builtins.exit = lambda *a, **k: None',
    '_pgb_builtins.quit = lambda *a, **k: None',
    'def _pgb_excepthook(exc_type, exc_val, exc_tb):',
    '    if exc_type is SystemExit or exc_type is KeyboardInterrupt:',
    '        return',
    '    try:',
    '        _pgb_sys.stderr.write("\\n___ULLM_FATAL_PYTHON_CRASH___\\n")',
    '        _pgb_tb.print_exception(exc_type, exc_val, exc_tb, file=_pgb_sys.stderr)',
    '    except Exception:',
    '        pass',
    '_pgb_sys.excepthook = _pgb_excepthook',
    '_pgb_orig_asyncio_run = _pgb_asyncio.run',
    'def _pgb_safe_asyncio_run(coro, *a, **k):',
    '    async def _pgb_runner():',
    '        try:',
    '            return await coro',
    '        except (SystemExit, KeyboardInterrupt, _pgb_asyncio.CancelledError):',
    '            return None',
    '        except Exception:',
    '            _pgb_sys.stderr.write("\\n___ULLM_FATAL_PYTHON_CRASH___\\n")',
    '            _pgb_tb.print_exc(file=_pgb_sys.stderr)',
    '            return None',
    '    return _pgb_orig_asyncio_run(_pgb_runner(), *a, **k)',
    '_pgb_asyncio.run = _pgb_safe_asyncio_run',
    'try:',
    '    import pygame as _pgb_pygame',
    '    if not hasattr(_pgb_pygame, "gfxdraw"):',
    '        class _PgbNoGfxdraw:',
    '            def __getattr__(self, _name):',
    '                return lambda *a, **k: None',
    '        _pgb_pygame.gfxdraw = _PgbNoGfxdraw()',
    '    if hasattr(_pgb_pygame, "event") and not hasattr(_pgb_pygame.event, "get_events"):',
    '        _pgb_pygame.event.get_events = _pgb_pygame.event.get',
    '    if hasattr(_pgb_pygame, "mixer") and hasattr(_pgb_pygame.mixer, "init"):',
    '        _pgb_orig_mixer_init = _pgb_pygame.mixer.init',
    '        def _pgb_safe_mixer_init(*a, **k):',
    '            try: return _pgb_orig_mixer_init(*a, **k)',
    '            except Exception: return None',
    '        _pgb_pygame.mixer.init = _pgb_safe_mixer_init',
    '    if hasattr(_pgb_pygame, "display") and hasattr(_pgb_pygame.display, "set_mode"):',
    '        _pgb_orig_set_mode = _pgb_pygame.display.set_mode',
    '        _pgb_boot_printed = False',
    '        def _pgb_set_mode(*a, **k):',
    '            global _pgb_boot_printed',
    '            surf = _pgb_orig_set_mode(*a, **k)',
    '            if not _pgb_boot_printed:',
    '                _pgb_boot_printed = True',
    '                try: print("___ULLM_GAME_BOOTED___", flush=True)',
    '                except Exception: pass',
    '            return surf',
    '        _pgb_pygame.display.set_mode = _pgb_set_mode',
    'except Exception:',
    '    pass',
    '# --- end ullm preamble ---',
    '',
  ].join('\n');

  return preamble + out;
}

// A build is only reusable once pygbag has finished AND patchIndexHtml has run.
const READY_FILE = '.ullm-ready';

function isBuilt(webDir) {
  return fs.existsSync(path.join(webDir, 'index.html')) && fs.existsSync(path.join(webDir, READY_FILE));
}

// Build (or reuse a cached build of) the given Python/Pygame source. Returns
// { id, cached }. Concurrent requests for identical code share one build.
async function buildWebGame(code) {
  const id = idFor(code);
  const webDir = webDirFor(id);
  if (isBuilt(webDir)) {
    games.set(id, { dir: webDir, builtAt: Date.now() });
    return { id, cached: true };
  }
  if (building.has(id)) { await building.get(id); return { id, cached: true }; }

  const p = (async () => {
    const appDir = path.join(ROOT, id);
    try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    fs.mkdirSync(appDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(appDir, 'main.py'), sanitizeForPygbag(code), 'utf8');
      await runPygbag(appDir);
      const idxPath = path.join(webDir, 'index.html');
      if (!fs.existsSync(idxPath)) {
        throw new Error('pygbag finished but produced no build/web/index.html');
      }
      patchIndexHtml(idxPath);
      if (!fs.readFileSync(idxPath, 'utf8').includes('<script id="ullm-diag">')) {
        throw new Error('pygbag output could not be patched (the loader would hang)');
      }
      fs.writeFileSync(path.join(webDir, READY_FILE), String(Date.now()), 'utf8');
      games.set(id, { dir: webDir, builtAt: Date.now() });
      pruneOldGames();
    } catch (err) {
      try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {}
      throw err;
    }
  })();
  building.set(id, p);
  try { await p; } finally { building.delete(id); }
  return { id, cached: false };
}

// Patch pygbag 0.9.3's generated index.html:
// 1. Repoint dead browserfs CDN URL to jsdelivr and set ume_block:0 for auto-start.
// 2. Isolate same-origin capabilities (localStorage, sessionStorage, indexedDB,
//    window.parent, window.top, and /api/* requests) so untrusted Python code
//    running in Pygbag WASM cannot read user BYOK keys or call authenticated APIs.
// 3. Force full-viewport canvas CSS and permanently hide pygbag's #pyconsole, #dlg,
//    #box, and #infobox overlays so the console NEVER splits half-code / half-game.
// 4. Only emit `game-error` to the parent when `___ULLM_FATAL_PYTHON_CRASH___`
//    occurs or when the canvas fails to initialize after 45s.
function patchIndexHtml(idxPath) {
  try {
    let html = fs.readFileSync(idxPath, 'utf8');
    html = html.replace(
      /https:\/\/pygame-web\.github\.io\/cdn\/[0-9.]+\/+browserfs\.min\.js/g,
      'https://cdn.jsdelivr.net/npm/browserfs@1.4.3/dist/browserfs.min.js',
    );
    html = html.replace(/ume_block\s*:\s*1/g, 'ume_block : 0');

    if (html.indexOf('<script id="ullm-cdn-fix">') < 0) {
      const headPatch = [
        '<style id="ullm-game-css">',
        'html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#000!important;}',
        'canvas.emscripten,#canvas{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;object-fit:contain!important;display:block!important;margin:auto!important;z-index:10!important;background:#000!important;}',
        '#pyconsole,#dlg,#box,#terminal,#system,#transfer,#status,#infobox{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;overflow:hidden!important;pointer-events:none!important;z-index:-1!important;}',
        '</style>',
        '<script id="ullm-cdn-fix">(function(){',
        // Capture parent postMessage before shadowing window.parent/top
        'var rawParent=(window.parent&&window.parent!==window)?window.parent:null;',
        'var postUp=rawParent?rawParent.postMessage.bind(rawParent):function(){};',
        'var origin=window.location.origin;',
        'Object.defineProperty(window,"__ullmPost",{value:function(msg){try{postUp(msg,origin);}catch(e){}},writable:false,configurable:false});',
        // Isolate storage & parent frame access so untrusted WASM Python cannot read ullm.keys
        'function memStore(){var d=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;},setItem:function(k,v){d[k]=String(v);},removeItem:function(k){delete d[k];},clear:function(){d=Object.create(null);},key:function(i){return Object.keys(d)[i]||null;},get length(){return Object.keys(d).length;}};}',
        'try{Object.defineProperty(window,"localStorage",{value:memStore(),configurable:false});}catch(e){}',
        'try{Object.defineProperty(window,"sessionStorage",{value:memStore(),configurable:false});}catch(e){}',
        'try{Object.defineProperty(window,"indexedDB",{get:function(){return null;},configurable:false});}catch(e){}',
        'try{Object.defineProperty(window,"parent",{get:function(){return window;},configurable:false});}catch(e){}',
        'try{Object.defineProperty(window,"top",{get:function(){return window;},configurable:false});}catch(e){}',
        'try{Object.defineProperty(window,"frameElement",{get:function(){return null;},configurable:false});}catch(e){}',
        // Rewrite localhost:8000 wheel URLs and block same-origin /api/* or /auth/* requests
        'var BAD=["http://localhost:8000/","https://localhost:8000/"];',
        'var GOOD="https://pygame-web.github.io/";',
        'function fx(u){u=String(u);for(var i=0;i<BAD.length;i++){',
        'if(u.slice(0,BAD[i].length)===BAD[i])return GOOD+u.slice(BAD[i].length);}',
        'return u;}',
        'function blocked(u){try{var p=new URL(String(u),window.location.href);if(p.origin===origin&&(/^\\/(api|auth)(\\/|$)/i.test(p.pathname)))return true;}catch(e){}return false;}',
        'var of=window.fetch;',
        'window.fetch=function(i,o){',
        'var u=(typeof i==="string")?i:(i&&i.url)||"";',
        'if(blocked(u))return Promise.reject(new Error("Blocked by sandbox"));',
        'if(typeof i==="string")i=fx(i);',
        'else if(i&&i.url){var n=fx(i.url);if(n!==i.url)i=new Request(n,i);}',
        'return of.call(this,i,o);};',
        'var oo=XMLHttpRequest.prototype.open;',
        'XMLHttpRequest.prototype.open=function(m,u){',
        'if(blocked(u))throw new Error("Blocked by sandbox");',
        'var a=[].slice.call(arguments);a[1]=fx(u);return oo.apply(this,a);};',
        '})();<' + '/script>',
      ].join('');
      html = html.replace(/<head>/i, '<head>' + headPatch);
    }

    if (html.indexOf('<script id="ullm-diag">') < 0) {
      const diag = [
        '<script id="ullm-diag">(function(){',
        'var seen={},booted=false;',
        'function post(obj){if(typeof window.__ullmPost==="function")window.__ullmPost(obj);}',
        'function markBooted(){if(booted)return;booted=true;post({__ullm:"game-booted"});}',
        'function report(kind,text){text=String(text||"").slice(0,2000);var k=kind+"|"+text;',
        'if(seen[k])return;seen[k]=1;',
        'post({__ullm:"game-error",kind:kind,message:text});}',
        'function noise(s){s=String(s||"");return s.indexOf("share-modal")>=0||s.indexOf("Could not establish connection")>=0||s.indexOf("Receiving end does not exist")>=0||s.indexOf("NotAllowedError")>=0||s.indexOf("AudioContext")>=0||s.indexOf("play()")>=0||s.indexOf("ResizeObserver")>=0||s.indexOf("Blocked by sandbox")>=0;}',
        'window.addEventListener("error",function(e){if(booted)return;var src=(e&&e.filename)||"";var m=(e&&e.message)||String(e);',
        'if(noise(src)||noise(m))return;if(/SyntaxError|ReferenceError|RangeError|WebAssembly|RuntimeError/i.test(m))report("js",m+(src?(" @ "+src):""));});',
        'window.addEventListener("unhandledrejection",function(e){if(booted)return;var r=e&&e.reason;var m=(r&&r.message)||String(r||"");',
        'if(noise(m))return;if(/WebAssembly|RuntimeError|BadGzipFile/i.test(m))report("js","Unhandled rejection: "+m);});',
        'function scanPy(){',
        'var c=document.getElementById("canvas");if(c&&c.width>1&&c.height>1)markBooted();',
        'var pc=document.getElementById("pyconsole");if(!pc)return;',
        'var t=pc.value||pc.textContent||"";',
        'if(t.indexOf("___ULLM_GAME_BOOTED___")>=0)markBooted();',
        'var f=t.lastIndexOf("___ULLM_FATAL_PYTHON_CRASH___");',
        'if(f>=0){var sub=t.slice(f+"___ULLM_FATAL_PYTHON_CRASH___".length).trim();report("python",sub||"Unhandled Python exception in game.");return;}',
        'if(!booted){var tb=t.lastIndexOf("Traceback (most recent call last)");',
        'if(tb>=0&&/SyntaxError:|IndentationError:|ImportError:|ModuleNotFoundError:|NameError:/.test(t.slice(tb))){report("python",t.slice(tb));}}',
        '}',
        'setInterval(scanPy,1500);',
        'setTimeout(function(){scanPy();if(!booted){var c=document.getElementById("canvas");if(!c||c.width<=1){',
        'var pc=document.getElementById("pyconsole");var t=(pc&&(pc.value||pc.textContent))||"";var i=t.lastIndexOf("Traceback (most recent call last)");',
        'if(i>=0)report("python",t.slice(i));',
        'else report("nostart","The game never started: after 45 seconds its canvas had still not been initialised.");}}},45000);',
        '})();</script>',
      ].join('');
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
      const env = buildSafeGameEnv();
      child = spawn(PYTHON_CMD, args, { cwd: appDir, windowsHide: true, env });
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
  if (g) {
    g.builtAt = Date.now();
    return g.dir;
  }
  // survive a server restart: re-adopt a build that's still on disk
  const dir = webDirFor(id);
  if (isBuilt(dir)) {
    games.set(id, { dir, builtAt: Date.now() });
    pruneOldGames();
    return dir;
  }
  return null;
}

module.exports = { buildWebGame, gameDir, webGameEnabled, idFor, sanitizeForPygbag, patchIndexHtml };

