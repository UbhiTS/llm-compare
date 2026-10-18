// ---------------------------------------------------------------------------
// Server-side code execution for the "Run code" button.
//
//   python      -> run the generated PROGRAM in a child `python` process
//                  (headless: SDL_VIDEODRIVER=dummy so Pygame can init without a
//                  display), capture stdout/stderr, hard timeout.
//   javascript  -> run the generated FUNCTION against the task's hidden test
//                  cases in the vm sandbox (src/runner.js) and report pass/fail.
//
// SECURITY: this runs model-generated code on the host. Intended for a LOCAL
// demo where you control the tasks - NOT a hardened sandbox. OFF by default on
// Cloud Run (K_SERVICE): opt in with ENABLE_CODE_EXEC=1; locally it is on unless
// ENABLE_CODE_EXEC=0. (Same posture as the vm test runner in runner.js.)
// ---------------------------------------------------------------------------
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runTests } = require('./runner');

const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');
const EXEC_TIMEOUT_MS = (parseInt(process.env.EXEC_TIMEOUT_SEC, 10) || 10) * 1000;
const GUI_MAX_LIFETIME_MS = 10 * 60 * 1000; // a launched window is killed after this, whatever it is doing
const MAX_OUTPUT = 100_000; // cap captured stdout/stderr (chars)
const POSIX = process.platform !== 'win32';

const SUPPORTED = new Set(['python', 'javascript']);

// Opt-in on Cloud Run, opt-out locally (3.3): the deploy scripts never set the flag, so
// "default on" meant arbitrary Python on the production instance.
function executionEnabled() {
  if (process.env.ENABLE_CODE_EXEC === '1') return true;
  return !process.env.K_SERVICE && process.env.ENABLE_CODE_EXEC !== '0';
}

// Children we started and may still be running (headless runs + launched GUI windows):
// killed when the server exits so nothing model-generated outlives the process.
const liveChildren = new Set();
function killTree(child) {
  if (!child || !child.pid) return;
  if (!POSIX) {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); } catch (_) { try { child.kill(); } catch (_e) { /* gone */ } }
    return;
  }
  // Detached children lead their own process group: -pid takes the grandchildren too.
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }
}
process.on('exit', () => { for (const c of liveChildren) killTree(c); });

// SECURITY: executed code must not inherit the server's credentials (provider API
// keys, OAuth client secret, bootstrap admin password, bearer tokens, the gcloud
// token command, SSH agent socket...). For the local GUI launcher anything whose NAME
// looks secret is dropped and everything else (PATH, HOME, DISPLAY, XAUTHORITY, proxies,
// locale, SDL vars) is kept so windowed Pygame launches behave exactly as before.
// Headless runs use the stricter allow-list below (headlessEnv).
// Extra names can be dropped with EXEC_ENV_DENY=NAME1,NAME2 and specific names can be
// kept with EXEC_ENV_ALLOW=NAME1,NAME2.
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|PRIVATE)/i;
const SECRET_ENV_EXACT = new Set(['SSH_AUTH_SOCK', 'GCLOUD_TOKEN_CMD', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']);
function childEnv(extra) {
  const deny = new Set(String(process.env.EXEC_ENV_DENY || '').split(',').map((s) => s.trim()).filter(Boolean));
  const allow = new Set(String(process.env.EXEC_ENV_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k)) { env[k] = v; continue; }
    if (deny.has(k) || SECRET_ENV_EXACT.has(k) || SECRET_ENV_RE.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// Headless runs get an ALLOW-list instead (3.3), the same shape as webGame.buildSafeGameEnv:
// a headless program needs nothing but an interpreter, a locale and a temp dir, so nothing
// else from the server's environment (proxies, cloud metadata hints, tool paths...) is
// visible to it. EXEC_ENV_ALLOW names are still honoured for operator opt-ins (e.g. a venv).
const EXEC_SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'PYTHONIOENCODING', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR'];
function headlessEnv(extra) {
  const env = { PYTHONIOENCODING: 'utf-8' };
  const allow = new Set(String(process.env.EXEC_ENV_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const k of [...EXEC_SAFE_ENV_KEYS, ...allow]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

function runPython(code) {
  return new Promise((resolve) => {
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-exec-'));
      fs.writeFileSync(path.join(dir, 'program.py'), code);
    } catch (e) {
      return resolve({ kind: 'program', stdout: '', stderr: 'Failed to stage code: ' + e.message, exitCode: null, timedOut: false, durationMs: 0, truncated: false });
    }

    const t0 = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Headless: lets Pygame / SDL programs init without a real display.
    const env = headlessEnv({ SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', PYGAME_HIDE_SUPPORT_PROMPT: '1' });
    // -I = isolated mode (ignore env-derived sys.path / user site) for a bit of hygiene.
    // cwd is the scratch dir (relative file writes land there, not in the server tree);
    // detached on POSIX puts the program in its own process group so a timeout kills
    // whatever it forked as well, not just the interpreter.
    let child;
    try {
      child = spawn(PYTHON_CMD, ['-I', path.join(dir, 'program.py')], { cwd: dir, windowsHide: true, env, detached: POSIX });
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      return resolve({ kind: 'program', stdout: '', stderr: `Failed to launch ${PYTHON_CMD}: ${e.message}`, exitCode: null, timedOut: false, durationMs: 0, truncated: false });
    }
    liveChildren.add(child);

    const killProcessTree = () => killTree(child);
    const timer = setTimeout(() => { timedOut = true; killProcessTree(); }, EXEC_TIMEOUT_MS);
    if (child.stdin) { try { child.stdin.end(); } catch (_) { /* ignore */ } }
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      resolve({
        kind: 'program',
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode,
        timedOut,
        durationMs: Date.now() - t0,
        truncated: stdout.length >= MAX_OUTPUT || stderr.length >= MAX_OUTPUT,
      });
    };

    child.on('error', (e) => { stderr += `Failed to launch ${PYTHON_CMD}: ${e.message}`; finish(null); });
    // Resolve on 'exit' (+ a short drain for buffered output) rather than on 'close': a
    // grandchild that inherited the pipes and keeps running would hold 'close' back for
    // as long as it lives, i.e. well past the timeout.
    let exitCode = null;
    child.on('exit', (codeExit) => {
      exitCode = codeExit;
      const drain = setTimeout(() => finish(exitCode), 500);
      if (drain.unref) drain.unref();
    });
    child.on('close', (codeExit) => finish(codeExit != null ? codeExit : exitCode));
  });
}

// Launch a GRAPHICAL program (e.g. Pygame) on the local machine so its window
// opens on the user's desktop. Unlike runPython this uses the REAL display (no
// dummy SDL driver), does not capture the process, and returns as soon as the
// window is up (or reports an immediate failure). Only meaningful when the
// server runs on the same machine as the display (the localhost demo), so it is
// refused outright on Cloud Run, and a launched program is killed after
// GUI_MAX_LIFETIME_MS so a forgotten window can't run forever (3.3).
function launchGuiProgram(code, opts = {}) {
  if (process.env.K_SERVICE) throw new Error('GUI launch is local-only');
  return new Promise((resolve) => {
    // Force the window TITLE to the model name (monkeypatch pygame so whatever the
    // program sets is overridden) by prepending a small preamble before the code.
    const title = String(opts.title || 'LLM Arena');
    const pyTitle = JSON.stringify(title); // valid Python string literal
    const hasPos = Number.isFinite(opts.posX) && Number.isFinite(opts.posY);
    const pyPos = hasPos ? `(${Math.round(opts.posX)}, ${Math.round(opts.posY)})` : 'None';
    const idx = Number.isInteger(opts.index) ? opts.index : null;
    const cnt = Number.isInteger(opts.count) && opts.count > 0 ? opts.count : null;
    const gap = Number.isFinite(opts.gap) ? Math.round(opts.gap) : 10;
    const posY = Number.isFinite(opts.posY) ? Math.round(opts.posY) : 60;
    // After the window is created we know its real width, so we center a ROW of N
    // equal-width windows (this one at `index`, with `gap` px between them) and pin
    // it topmost. Forces the title to the model name too. Falls back to (posX,posY).
    const preamble = [
      'import pygame as _ag_pg',
      `_ag_t = ${pyTitle}`,
      `_ag_pos = ${pyPos}`,
      `_ag_idx = ${idx === null ? 'None' : idx}`,
      `_ag_cnt = ${cnt === null ? 'None' : cnt}`,
      `_ag_gap = ${gap}`,
      `_ag_posY = ${posY}`,
      '_ag_oc = _ag_pg.display.set_caption',
      '_ag_pg.display.set_caption = lambda *a, **k: _ag_oc(_ag_t)',
      'def _ag_move():',
      '    try:',
      '        import ctypes, ctypes.wintypes',
      '        _h = _ag_pg.display.get_wm_info().get("window")',
      '        if not _h: return',
      '        _u = ctypes.windll.user32',
      '        _r = ctypes.wintypes.RECT(); _u.GetWindowRect(ctypes.c_void_p(_h), ctypes.byref(_r))',
      '        _w = _r.right - _r.left',
      '        _sw = _u.GetSystemMetrics(0)',
      '        if _ag_cnt and _ag_idx is not None:',
      '            _total = _ag_cnt * _w + (_ag_cnt - 1) * _ag_gap',
      '            if _total <= _sw:',
      '                _x = int((_sw - _total) / 2) + _ag_idx * (_w + _ag_gap)  # fits: centered row with gap',
      '            elif _ag_cnt > 1:',
      '                _x = int(_ag_idx * (_sw - _w) / (_ag_cnt - 1))           # too wide: spread edge-to-edge (may overlap)',
      '            else:',
      '                _x = max(0, int((_sw - _w) / 2))',
      '            _y = _ag_posY',
      '        elif _ag_pos:',
      '            _x, _y = int(_ag_pos[0]), int(_ag_pos[1])',
      '        else:',
      '            _x, _y = 0, _ag_posY',
      '        _u.SetWindowPos(ctypes.c_void_p(_h), ctypes.c_void_p(-1), int(_x), int(_y), 0, 0, 0x0001)  # HWND_TOPMOST + SWP_NOSIZE',
      '        try:',
      '            _u.BringWindowToTop(ctypes.c_void_p(_h)); _u.SetForegroundWindow(ctypes.c_void_p(_h))',
      '        except Exception: pass',
      '    except Exception:',
      '        pass',
      '_ag_om = _ag_pg.display.set_mode',
      'def _ag_sm(*a, **k):',
      '    _s = _ag_om(*a, **k)',
      '    try: _ag_oc(_ag_t)',
      '    except Exception: pass',
      '    _ag_move()',
      '    return _s',
      '_ag_pg.display.set_mode = _ag_sm',
      '',
    ].join('\n');

    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-gui-'));
      fs.writeFileSync(path.join(dir, 'program.py'), preamble + code);
    } catch (e) {
      return resolve({ kind: 'launched', launched: false, message: 'Failed to stage code: ' + e.message });
    }

    const t0 = Date.now();
    let stderr = '';
    let settled = false;
    // NOTE: no SDL_VIDEODRIVER=dummy -> real window. SDL_VIDEO_WINDOW_POS places it.
    const env = childEnv({ PYGAME_HIDE_SUPPORT_PROMPT: '1' });
    if (Number.isFinite(opts.posX) && Number.isFinite(opts.posY)) {
      env.SDL_VIDEO_WINDOW_POS = `${Math.round(opts.posX)},${Math.round(opts.posY)}`;
      env.SDL_VIDEO_CENTERED = '0';
    }
    let child;
    try {
      child = spawn(PYTHON_CMD, ['-I', path.join(dir, 'program.py')], { cwd: dir, windowsHide: false, env, detached: POSIX });
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      return resolve({ kind: 'launched', launched: false, message: `Failed to launch ${PYTHON_CMD}: ${e.message}` });
    }
    liveChildren.add(child);

    if (child.stdin) { try { child.stdin.end(); } catch (_) { /* ignore */ } }
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const done = (obj) => { if (settled) return; settled = true; resolve(obj); };
    child.on('error', (e) => done({ kind: 'launched', launched: false, message: `Failed to launch ${PYTHON_CMD}: ${e.message}` }));
    // Exited before the grace window -> it crashed or finished without staying open.
    child.on('exit', (exitCode) => done({
      kind: 'launched', launched: false, exitCode, durationMs: Date.now() - t0,
      message: stderr.trim() ? 'Program exited right away:\n' + stderr.slice(-1500) : 'Program exited immediately (no window stayed open).',
    }));
    // Still running after the grace window -> assume the window is up. The window stays
    // open for the user; it is only force-closed at the lifetime cap (or server exit).
    setTimeout(() => done({
      kind: 'launched', launched: true, durationMs: Date.now() - t0,
      message: '▶ Launched on this machine — a window should be open on your desktop. Close it to stop.',
    }), 2500);
    const lifetime = setTimeout(() => killTree(child), GUI_MAX_LIFETIME_MS);
    if (lifetime.unref) lifetime.unref();
    child.on('exit', () => { clearTimeout(lifetime); liveChildren.delete(child); });
    // Best-effort temp cleanup later (Python has already read the file by then).
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }, 60000);
  });
}

// Run a generated JS function against the task's hidden tests (in the vm sandbox).
function runJsTests(code, functionName, testCases) {
  const t0 = Date.now();
  const tr = runTests(code, functionName, testCases);
  return {
    kind: 'tests',
    passed: tr.passed,
    total: tr.total,
    failing: tr.failing,
    durationMs: Date.now() - t0,
  };
}

// Dispatch on language. opts = { functionName, testCases } for graded JS.
async function runCode(language, code, opts = {}) {
  if (!executionEnabled()) throw new Error('Code execution is disabled on this server (ENABLE_CODE_EXEC=0, or unset on Cloud Run; set ENABLE_CODE_EXEC=1 to allow it).');
  if (!SUPPORTED.has(language)) throw new Error(`Unsupported language: ${language} (supported: ${[...SUPPORTED].join(', ')}).`);
  if (typeof code !== 'string' || !code.trim()) throw new Error('No code to run.');
  if (language === 'python') return opts.gui ? launchGuiProgram(code, opts) : runPython(code);
  // javascript
  if (opts.testCases && opts.testCases.length) return runJsTests(code, opts.functionName, opts.testCases);
  throw new Error('This JavaScript task has no tests to run.');
}

module.exports = { runCode, runPython, runJsTests, launchGuiProgram, executionEnabled, EXEC_TIMEOUT_MS, SUPPORTED };
