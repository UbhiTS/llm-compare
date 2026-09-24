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
// demo where you control the tasks — NOT a hardened sandbox. Disable with
// ENABLE_CODE_EXEC=0. (Same posture as the vm test runner in runner.js.)
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runTests } = require('./runner');

const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');
const EXEC_TIMEOUT_MS = (parseInt(process.env.EXEC_TIMEOUT_SEC, 10) || 10) * 1000;
const MAX_OUTPUT = 100_000; // cap captured stdout/stderr (chars)

const SUPPORTED = new Set(['python', 'javascript']);

function executionEnabled() {
  return process.env.ENABLE_CODE_EXEC !== '0';
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
    const env = { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', PYGAME_HIDE_SUPPORT_PROMPT: '1' };
    // -I = isolated mode (ignore env-derived sys.path / user site) for a bit of hygiene.
    const child = spawn(PYTHON_CMD, ['-I', path.join(dir, 'program.py')], { windowsHide: true, env });

    const killProcessTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); } catch (_) { child.kill(); }
      } else {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => { timedOut = true; killProcessTree(); }, EXEC_TIMEOUT_MS);
    if (child.stdin) { try { child.stdin.end(); } catch (_) { /* ignore */ } }
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    child.on('close', (codeExit) => finish(codeExit));
  });
}

// Launch a GRAPHICAL program (e.g. Pygame) on the local machine so its window
// opens on the user's desktop. Unlike runPython this uses the REAL display (no
// dummy SDL driver), does not capture/kill the process, and returns as soon as
// the window is up (or reports an immediate failure). Only meaningful when the
// server runs on the same machine as the display (the localhost demo).
function launchGuiProgram(code, opts = {}) {
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
    const env = { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: '1' };
    if (Number.isFinite(opts.posX) && Number.isFinite(opts.posY)) {
      env.SDL_VIDEO_WINDOW_POS = `${Math.round(opts.posX)},${Math.round(opts.posY)}`;
      env.SDL_VIDEO_CENTERED = '0';
    }
    const child = spawn(PYTHON_CMD, ['-I', path.join(dir, 'program.py')], { windowsHide: false, env });

    if (child.stdin) { try { child.stdin.end(); } catch (_) { /* ignore */ } }
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const done = (obj) => { if (settled) return; settled = true; resolve(obj); };
    child.on('error', (e) => done({ kind: 'launched', launched: false, message: `Failed to launch ${PYTHON_CMD}: ${e.message}` }));
    // Exited before the grace window -> it crashed or finished without staying open.
    child.on('exit', (exitCode) => done({
      kind: 'launched', launched: false, exitCode, durationMs: Date.now() - t0,
      message: stderr.trim() ? 'Program exited right away:\n' + stderr.slice(-1500) : 'Program exited immediately (no window stayed open).',
    }));
    // Still running after the grace window -> assume the window is up. We do NOT kill it.
    setTimeout(() => done({
      kind: 'launched', launched: true, durationMs: Date.now() - t0,
      message: '▶ Launched on this machine — a window should be open on your desktop. Close it to stop.',
    }), 2500);
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
  if (!executionEnabled()) throw new Error('Code execution is disabled (ENABLE_CODE_EXEC=0).');
  if (!SUPPORTED.has(language)) throw new Error(`Unsupported language: ${language} (supported: ${[...SUPPORTED].join(', ')}).`);
  if (typeof code !== 'string' || !code.trim()) throw new Error('No code to run.');
  if (language === 'python') return opts.gui ? launchGuiProgram(code, opts) : runPython(code);
  // javascript
  if (opts.testCases && opts.testCases.length) return runJsTests(code, opts.functionName, opts.testCases);
  throw new Error('This JavaScript task has no tests to run.');
}

module.exports = { runCode, runPython, runJsTests, launchGuiProgram, executionEnabled, EXEC_TIMEOUT_MS, SUPPORTED };
