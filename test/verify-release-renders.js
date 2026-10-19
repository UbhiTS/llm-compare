'use strict';

/**
 * Mandatory Pre-Release Verification Suite (`test/verify-release-renders.js`)
 *
 * Runs before every release (`npm test`, `node test/run-all.js`, and CI/CD) to verify:
 *   1. Zero Browser UI Caching: every HTML/JS/CSS/Three.js/CAD/Game route serves
 *      `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
 *      and per-boot cache-busted asset URLs (`?v=<version>-<hash10>-<bootId>`).
 *   2. Game Rendering (Pygame WASM): multi-slot concurrency (`MAX_CONCURRENT_WEB_GAME_PER_USER >= 6`),
 *      UberProxy-compatible `allow-same-origin` iframe sandbox with in-frame `localStorage`/`parent`
 *      isolation, `#canvas` full-viewport + `#canvas3d` hidden CSS, and boot/crash postMessage hooks.
 *   3. Towers of Hanoi Animation: 255-move (8-disk) move generation/parsing, automatic in-browser
 *      animation on History restore (`renderHanoiInBrowser`), and in-browser simulation when
 *      `ENABLE_CODE_EXEC=0` (Cloud Run).
 *   4. Multi-Slot Image Arena Rendering: `MAX_CONCURRENT_IMAGE_PER_USER >= 6` so firing 4-6 slots
 *      in parallel never trips HTTP 429 (`Too many concurrent requests`).
 *   5. 3D & CAD Model Rendering: UberProxy-compatible `allow-same-origin` iframe with strict JS
 *      global/storage/network lockdown, non-blocking telemetry + deferred 4-view composite capture,
 *      `restoreHistory` auto-switching to `'3d'` mode, and live headless Chrome multi-slot WebGL
 *      rendering verification.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-compare-release-renders-'));
process.env.AUTH_DATA_DIR = tmpDir;
process.env.APP_DATA_DIR = tmpDir;

const rootDir = path.join(__dirname, '..');
const { CAD_REFERENCE_SOLUTIONS } = require('../src/cadArena');

function httpRequest(port, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== Running Pre-Release Renderers & Zero-Cache Verification Suite ===');

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const serverJs = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'public', 'app.js'), 'utf8');
  const cadRunnerHtml = fs.readFileSync(path.join(rootDir, 'public', 'cad-runner.html'), 'utf8');

  // ---------------------------------------------------------------------------
  // 1. Static Source Invariants: Concurrency, Sandboxes, Hanoi, CAD & No-Cache
  // ---------------------------------------------------------------------------
  assert(
    /MAX_CONCURRENT_IMAGE_PER_USER\s*=\s*([6-9]|\d{2,})/.test(serverJs),
    'server.js must set MAX_CONCURRENT_IMAGE_PER_USER >= 6 so 4-6 parallel Image Arena slots never 429'
  );
  assert(
    /MAX_CONCURRENT_WEB_GAME_PER_USER\s*=\s*([6-9]|\d{2,})/.test(serverJs),
    'server.js must set MAX_CONCURRENT_WEB_GAME_PER_USER >= 6 so 4-6 parallel Pygame builds never 429'
  );
  assert(
    !serverJs.includes("if (process.env.NODE_ENV === 'production' && prev) return prev;"),
    'server.js must not freeze static asset cache in production mode'
  );
  assert(
    !serverJs.includes("res.setHeader('Cache-Control', 'public, max-age=86400')"),
    'server.js must not set max-age=86400 on UI or Three.js vendor routes'
  );
  assert(
    appJs.includes('sandbox="allow-scripts allow-same-origin allow-downloads"'),
    'public/app.js must include allow-same-origin on iframe.cad-frame so Google Corp UberProxy forwards cookies for ES module imports'
  );
  assert(
    appJs.includes('sandbox="allow-scripts allow-same-origin allow-pointer-lock"'),
    'public/app.js must include allow-same-origin on iframe.game-frame so Google Corp UberProxy forwards cookies for Pygame WASM bundles'
  );
  assert(
    cadRunnerHtml.includes('const _parentWin = window.parent;') &&
    cadRunnerHtml.includes("Object.defineProperty(window, 'parent', { get: () => window, configurable: false })") &&
    cadRunnerHtml.includes("Object.defineProperty(window, 'top', { get: () => window, configurable: false })") &&
    cadRunnerHtml.includes('if (event.source !== _parentWin) return;'),
    'public/cad-runner.html must isolate window.parent / window.top while keeping _parentWin for postMessage'
  );
  assert(
    cadRunnerHtml.includes('emitTelemetryToParent(false);') &&
    cadRunnerHtml.includes('scheduleDeferredFourViewCapture();'),
    'public/cad-runner.html must emit CAD_TELEMETRY immediately and defer 4-view composite capture asynchronously'
  );
  assert(
    appJs.includes('function renderHanoiInBrowser(slot, rawCode)') &&
    appJs.includes("if (task.visualizer === 'hanoi' && !(CONFIG && CONFIG.codeExec))"),
    'public/app.js must support in-browser Towers of Hanoi animation on restore and when codeExec is disabled'
  );
  assert(
    appJs.includes("const targetMode = isCadSnap ? '3d' : 'text';") &&
    appJs.includes('if (isCadActiveTask() && r.code)') &&
    appJs.includes('runCad3dViewport(slot, r.code);') &&
    appJs.includes('function isCadHistoryRun(r)') &&
    appJs.includes("'🧊 3D & CAD Arena Run History'") &&
    appJs.includes("if (presetName === 'gemini')") &&
    appJs.includes("{ id: 'claude-fable-5-1',    effort: null }") &&
    appJs.includes("{ id: 'gpt-6.1-sol',         effort: null }") &&
    appJs.includes('function buildProviderModelCascadingControlsHtml(') &&
    appJs.includes("providerSelectClass: 'slot-provider-select col-inline-select col-prov-sel img-provider-select'"),
    'public/app.js must isolate 3D & CAD Arena history, use Gemini 4 Argon + Fable 5.1 + Sol 6.1 in Flagships preset, and use Provider ▸ Model cascading controls across all arenas including Image & GenMedia Arena'
  );
  assert(
    cadRunnerHtml.includes('renderer.shadowMap.autoUpdate = vi === 0 ? savedShadowAutoUpdate : false;') &&
    cadRunnerHtml.includes("document.addEventListener('visibilitychange', () => {"),
    'public/cad-runner.html must initialize PCFShadowMap depth compare texture before compiling MeshStandardMaterial shaders in background tabs'
  );
  console.log('✓ 1. Source invariants verified (multi-slot concurrency, UberProxy iframe sandboxes, Hanoi fallback, CAD background-tab shadow sampler, 3D history isolation, Flagships preset & Provider ▸ Model UX)');

  // ---------------------------------------------------------------------------
  // 2. Spawned HTTP Server: Zero-Cache Headers & Parallel Multi-Slot Requests
  // ---------------------------------------------------------------------------
  const port = 18923;
  const srvEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_DATA_DIR: tmpDir,
    APP_DATA_DIR: tmpDir,
    GLOBAL_KEYS_ENABLED: '0',
  };
  delete srvEnv.K_SERVICE;
  delete srvEnv.ANTIGRAVITY_SIDECAR_WEB_PORT;
  delete srvEnv.LOCAL_AUTO_AUTH;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: srvEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('primary URL')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Server exited early with code ' + code));
      });
    });

    // 2a. Verify strict no-cache headers on all UI & asset routes (including 4 isolated arena sub-paths)
    const uiRoutes = [
      '/',
      '/index.html',
      '/text',
      '/image',
      '/3d',
      '/cad',
      '/video',
      '/app.js',
      '/styles.css',
      '/theme-init.js',
      '/login',
      '/cad-runner.html?slot=A',
      '/cad-kernel.js',
      '/cad-step-worker.js',
      '/vendor/three/three.module.js',
      '/favicon.ico',
      '/api/config',
    ];
    for (const route of uiRoutes) {
      const r = await httpRequest(port, 'GET', route);
      assert.strictEqual(r.status, 200, `GET ${route} must return 200 (got ${r.status})`);
      const cc = String(r.headers['cache-control'] || '');
      assert(
        cc.includes('no-store') && cc.includes('no-cache') && cc.includes('max-age=0'),
        `GET ${route} must return no-store/no-cache/max-age=0 Cache-Control header (got "${cc}")`
      );
    }

    // 2a-ii. Verify server-side DOM stripping on the 4 isolated sub-path pages (/text, /image, /3d, /video)
    const [rTextPage, rImgPage, r3dPage, rVidPage] = await Promise.all([
      httpRequest(port, 'GET', '/text'),
      httpRequest(port, 'GET', '/image'),
      httpRequest(port, 'GET', '/3d'),
      httpRequest(port, 'GET', '/video'),
    ]);
    assert(rTextPage.text.includes('data-arena-page="text"') && rTextPage.text.includes('id="arena"'), '/text must serve isolated Text Arena DOM');
    assert(!rTextPage.text.includes('id="cadModifyBar"') && !rTextPage.text.includes('id="imageArenaSection"') && !rTextPage.text.includes('id="videoArenaSection"') && !rTextPage.text.includes('id="cadMcpModal"'), '/text must strip 3D CAD Studio, Image Arena, Video Arena, and CAD MCP modal from HTML');

    assert(rImgPage.text.includes('data-arena-page="image"') && rImgPage.text.includes('id="imageArenaSection"'), '/image must serve isolated Image Arena DOM');
    assert(!rImgPage.text.includes('id="cadModifyBar"') && !rImgPage.text.includes('id="arena"') && !rImgPage.text.includes('id="scorecard"') && !rImgPage.text.includes('id="videoArenaSection"') && !rImgPage.text.includes('id="cadMcpModal"'), '/image must strip 3D CAD Studio, Text/3D stage, Scorecard, Video Arena, and CAD MCP modal from HTML');

    assert(r3dPage.text.includes('data-arena-page="3d"') && r3dPage.text.includes('id="cadModifyBar"') && r3dPage.text.includes('id="arena"') && r3dPage.text.includes('id="cadMcpModal"'), '/3d must serve isolated 3D & CAD Arena DOM');
    assert(!r3dPage.text.includes('id="imageArenaSection"') && !r3dPage.text.includes('id="videoArenaSection"'), '/3d must strip Image Arena and Video Arena from HTML');

    assert(rVidPage.text.includes('data-arena-page="video"') && rVidPage.text.includes('id="videoArenaSection"'), '/video must serve isolated Video Arena DOM');
    assert(!rVidPage.text.includes('id="cadModifyBar"') && !rVidPage.text.includes('id="arena"') && !rVidPage.text.includes('id="scorecard"') && !rVidPage.text.includes('id="imageArenaSection"') && !rVidPage.text.includes('id="cadMcpModal"'), '/video must strip 3D CAD Studio, Text/3D stage, Scorecard, Image Arena, and CAD MCP modal from HTML');

    const rRoot = await httpRequest(port, 'GET', '/');
    assert(
      new RegExp(`styles\\.css\\?v=${pkg.version.replace(/\./g, '\\.')}-[0-9a-f]{10}-[0-9a-f]{8}`).test(rRoot.text) &&
      new RegExp(`app\\.js\\?v=${pkg.version.replace(/\./g, '\\.')}-[0-9a-f]{10}-[0-9a-f]{8}`).test(rRoot.text),
      'GET / must inject version + content hash + bootId query strings into styles.css and app.js'
    );
    const rCfg = await httpRequest(port, 'GET', '/api/config');
    const cfgJson = JSON.parse(rCfg.text);
    assert(
      cfgJson.assetVersion && cfgJson.assetVersion.startsWith(`${pkg.version}-`),
      '/api/config must expose assetVersion starting with package version'
    );
    console.log('✓ 2. Zero browser UI caching verified across all 12 HTML/JS/CSS/Three.js/CAD/API routes');

    // 2b. Verify 4 concurrent /api/image-arena/run requests never return 429 Too Many Concurrent Requests
    const sharedImgRunId = `img_rel_${Date.now()}`;
    const imgPromises = ['A', 'B', 'C', 'D'].map((slot) =>
      httpRequest(port, 'POST', '/api/image-arena/run', {
        runId: sharedImgRunId,
        prompt: 'A brushed aluminum planetary gear assembly on an engineer desk',
        aspectRatio: '1:1',
        imageSize: '1K',
        slots: [{ slot, catalogId: 'gemini-3.1-flash-image' }],
        keys: {}, // no BYOK key -> fast missing-key slot result, exercises the concurrency gate!
      })
    );
    const imgResponses = await Promise.all(imgPromises);
    for (const [idx, res] of imgResponses.entries()) {
      assert.notStrictEqual(
        res.status,
        429,
        `Parallel Image Arena slot #${idx + 1} must NOT fail with HTTP 429 Too Many Concurrent Requests`
      );
      assert.strictEqual(res.status, 200, `Parallel Image Arena slot #${idx + 1} must return HTTP 200`);
    }
    console.log('✓ 3. 4-slot parallel Image Arena execution verified (zero HTTP 429 concurrency rejections)');

    // ---------------------------------------------------------------------------
    // 3. Live Headless Chrome E2E: 4-Slot 3D CAD WebGL Rendering + Towers of Hanoi
    // ---------------------------------------------------------------------------
    if (fs.existsSync('/usr/bin/google-chrome')) {
      const cdpPort = 19288;
      const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-compare-chrome-e2e-'));
      const chrome = spawn('/usr/bin/google-chrome', [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeProfile}`,
        `http://127.0.0.1:${port}/?tab=3d`,
      ], { stdio: 'ignore' });

      try {
        // Wait for Chrome DevTools Protocol endpoint
        let pageWsUrl = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            const targets = await listRes.json();
            const page = targets.find((t) => t.type === 'page' && t.url.includes(String(port)));
            if (page && page.webSocketDebuggerUrl) {
              pageWsUrl = page.webSocketDebuggerUrl;
              break;
            }
          } catch (_) { /* wait */ }
        }
        assert(pageWsUrl, 'Headless Chrome must expose CDP WebSocket target');

        const ws = new WebSocket(pageWsUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve);
          ws.addEventListener('error', reject);
        });
        let msgSeq = 1;
        const cdpSend = (method, params = {}) => new Promise((resolve) => {
          const id = msgSeq++;
          const onMsg = (ev) => {
            const d = JSON.parse(ev.data);
            if (d.id === id) {
              ws.removeEventListener('message', onMsg);
              resolve(d.result);
            }
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id, method, params }));
        });

        await cdpSend('Runtime.enable');
        // Wait for app boot
        await new Promise((r) => setTimeout(r, 1000));

        const steppedShaftCode = CAD_REFERENCE_SOLUTIONS['cad-simple-stepped-shaft'];
        const gearboxCode = CAD_REFERENCE_SOLUTIONS['cad-planetary-gearbox'];

        const e2eResult = await cdpSend('Runtime.evaluate', {
          expression: `(async () => {
            // 1. Test 2-slot 3D CAD live WebGL rendering + telemetry + deferred 4-view snapshot
            switchArenaMode('3d', { skipInterruptCheck: true });
            selectTaskById('cad-simple-stepped-shaft');
            buildArena([
              { slot: 'A', id: 'gemini-3.8-flash', catalogId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform' },
              { slot: 'B', id: 'gemini-4-argon', catalogId: 'gemini-4-argon', label: 'Gemini 4 Argon', provider: 'agentplatform' },
            ]);
            const codeA = ${JSON.stringify(steppedShaftCode)};
            const codeB = ${JSON.stringify(gearboxCode)};
            document.getElementById('code-A').textContent = codeA;
            document.getElementById('code-B').textContent = codeB;
            // Intentionally stagger Slot A and Slot B completion by 700ms so we verify
            // that 3-Axis Spin stays phase-locked even when models finish at different times.
            await runCad3dViewport('A', codeA);
            await new Promise((r) => setTimeout(r, 700));
            await runCad3dViewport('B', codeB);

            // Wait up to 12s for both slots to report CAD_TELEMETRY
            const deadline = Date.now() + 12000;
            while (Date.now() < deadline) {
              const stA = CAD_SLOT_STATE['A'] || {};
              const stB = CAD_SLOT_STATE['B'] || {};
              if (stA.telemetry && stB.telemetry) break;
              await new Promise((r) => setTimeout(r, 150));
            }
            // Query spin state from both slots simultaneously after staggered completion
            const getSlotSpinState = (slot) => new Promise((resolve) => {
              const st = CAD_SLOT_STATE[slot];
              if (!st || !st.iframe || !st.iframe.contentWindow) return resolve(null);
              const reqId = 'spin-' + slot + '-' + Date.now();
              const onMsg = (ev) => {
                const m = ev && ev.data;
                if (m && m.type === 'CAD_SPIN_STATE_REPORT' && m.reqId === reqId) {
                  window.removeEventListener('message', onMsg);
                  resolve(m);
                }
              };
              window.addEventListener('message', onMsg);
              st.iframe.contentWindow.postMessage({ type: 'CAD_GET_SPIN_STATE', reqId }, '*');
              setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 2000);
            });
            const [spinStateA, spinStateB] = await Promise.all([getSlotSpinState('A'), getSlotSpinState('B')]);

            // Ensure both slots capture their 4-angle composite PNG (either via deferred timer or explicit request)
            if (!CAD_SLOT_STATE['A']?.fourViewDataUrl) {
              await requestFresh4ViewFromSlot('A', 6000);
            }
            if (!CAD_SLOT_STATE['B']?.fourViewDataUrl) {
              await requestFresh4ViewFromSlot('B', 6000);
            }
            const cadSlots = ['A', 'B'].map((s) => {
              const st = CAD_SLOT_STATE[s] || {};
              const strip = document.getElementById('cad-telem-' + s);
              return {
                slot: s,
                ready: Boolean(st.ready),
                triangles: st.telemetry ? st.telemetry.triangleCount : 0,
                parts: st.telemetry ? st.telemetry.partCount : 0,
                watertight: st.telemetry ? st.telemetry.watertight : null,
                has4View: Boolean(st.fourViewDataUrl && st.fourViewDataUrl.startsWith('data:image/png;base64,')),
                stripText: strip ? strip.textContent : '',
              };
            });

            // 2. Test Towers of Hanoi in-browser animation rendering
            switchArenaMode('text', { skipInterruptCheck: true });
            selectTaskById('hanoi-python');
            buildArena([
              { slot: 'A', id: 'gemini-3.8-flash', catalogId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform' },
            ]);
            const hanoiOk = renderHanoiInBrowser('A', 'def hanoi(n=8): pass');
            const hanoiViz = document.getElementById('exec-viz-A');
            const hanoiDisks = hanoiViz ? hanoiViz.querySelectorAll('.hanoi-disk').length : 0;

            // 3. Test Image & GenMedia Arena Provider ▸ Model cascading selector UX
            await ensureImageArenaLoaded();
            switchArenaMode('image', { skipInterruptCheck: true });
            const imgProvSelects = Array.from(document.querySelectorAll('#imgSlotGrid .img-provider-select'));
            const imgModSelects = Array.from(document.querySelectorAll('#imgSlotGrid .img-slot-select'));
            const provOptionsA = imgProvSelects[0] ? Array.from(imgProvSelects[0].options).map((o) => o.value) : [];
            if (imgProvSelects[0]) {
              imgProvSelects[0].value = 'openai';
              imgProvSelects[0].dispatchEvent(new Event('change'));
            }
            const afterSwitchModSelA = document.querySelector('#imgSlotGrid .img-slot-select');
            const openaiModOptionsA = afterSwitchModSelA ? Array.from(afterSwitchModSelA.options).map((o) => o.value) : [];

            // 4. Test Workspace State Continuity & New/Clear buttons across Text, 3D & Image Arenas
            const hasNewClearBtn = Boolean(document.getElementById('newClearArenaBtn'));
            const hasImgNewClearBtn = Boolean(document.getElementById('imgNewClearBtn'));
            switchArenaMode('text', { skipInterruptCheck: true });
            selectTaskById('custom');
            const customTa = document.getElementById('customPrompt');
            if (customTa) {
              customTa.value = 'Text Arena Draft Continuity Check';
              customTa.dispatchEvent(new Event('input'));
            }
            // Switch to 3D Arena (normal user switch without skipInterruptCheck)
            // It should restore the 3D task ('cad-simple-stepped-shaft') from Step 1!
            switchArenaMode('3d');
            const tsEl = document.getElementById('taskSelect');
            const restored3dTaskFromStep1 = tsEl ? tsEl.value : '';
            selectTaskById('custom');
            const customTa3d = document.getElementById('customPrompt');
            if (customTa3d) {
              customTa3d.value = '3D Arena Draft Continuity Check';
              customTa3d.dispatchEvent(new Event('input'));
            }
            // Switch back to Text Arena and verify Text Arena's draft prompt is restored
            switchArenaMode('text');
            const restoredTextDraft = customTa ? customTa.value : '';
            const saved3dDraftInState = (ARENA_WORKSPACE_STATE && ARENA_WORKSPACE_STATE.arenas && ARENA_WORKSPACE_STATE.arenas['3d'])
              ? ARENA_WORKSPACE_STATE.arenas['3d'].draftPrompt
              : '';
            // Click ✦ New / Clear in Text Arena and verify it resets to blank Custom Prompt
            clearAndResetCurrentArena();
            const afterClearTextDraft = customTa ? customTa.value : 'non-empty';

            // 5. Cross-Arena UI Isolation Matrix (verifies zero card/toolbar/modal leakage across all 4 tabs)
            const checkVis = () => {
              const isShown = (el) => Boolean(el && !el.classList.contains('hidden') && window.getComputedStyle(el).display !== 'none');
              const isStrictlyHidden = (el) => Boolean(el && el.classList.contains('hidden') && window.getComputedStyle(el).display === 'none');
              const textControlsEl = document.querySelector('section.controls:not(.image-controls-panel)');
              const cadBarEl = document.getElementById('cadModifyBar');
              const arenaEl = document.getElementById('arena');
              const scorecardEl = document.getElementById('scorecard');
              const imgSecEl = document.getElementById('imageArenaSection');
              const vidSecEl = document.getElementById('videoArenaSection');
              const cadMcpModalEl = document.getElementById('cadMcpModal');
              return {
                bodyMode: document.body.dataset.arenaMode || '',
                textControlsShown: isShown(textControlsEl),
                textControlsHidden: isStrictlyHidden(textControlsEl),
                cadBarShown: isShown(cadBarEl),
                cadBarHidden: isStrictlyHidden(cadBarEl),
                arenaShown: isShown(arenaEl),
                arenaHidden: isStrictlyHidden(arenaEl),
                scorecardShown: isShown(scorecardEl),
                scorecardHidden: isStrictlyHidden(scorecardEl),
                imgSecShown: isShown(imgSecEl),
                imgSecHidden: isStrictlyHidden(imgSecEl),
                vidSecShown: isShown(vidSecEl),
                vidSecHidden: isStrictlyHidden(vidSecEl),
                cadMcpModalHidden: isStrictlyHidden(cadMcpModalEl),
              };
            };

            // 5a. Enter 3D Arena with a 3D benchmark task selected, scorecard open, and CAD MCP modal open
            document.getElementById('modeBtn3d').click();
            selectTaskById('cad-planetary-gearbox');
            document.getElementById('scorecard').classList.remove('hidden');
            document.getElementById('cadMcpModal').classList.remove('hidden');
            const visIn3d = checkVis();

            // 5b. Switch directly from 3D Arena (with 3D task selected!) to Image Arena via tab click
            document.getElementById('modeBtnImage').click();
            // Also try calling syncCadModifyBarVisibility() while on Image Arena to prove it stays hidden
            syncCadModifyBarVisibility();
            const visInImageAfter3d = checkVis();

            // 5c. Switch to Video Arena via tab click
            document.getElementById('modeBtnVideo').click();
            syncCadModifyBarVisibility();
            const visInVideo = checkVis();

            // 5d. Switch to Text Arena via tab click
            document.getElementById('modeBtnText').click();
            syncCadModifyBarVisibility();
            const visInText = checkVis();
            const calloutEl = document.getElementById('arenaDiscoveryCallout');
            const calloutVisibleOnText = Boolean(calloutEl && !calloutEl.hasAttribute('hidden') && window.getComputedStyle(calloutEl).display !== 'none');
            const caretImgEl = document.getElementById('calloutCaretImage');
            const caret3dEl = document.getElementById('calloutCaret3d');
            const hasBothCarets = Boolean(caretImgEl && caret3dEl);
            document.getElementById('arenaCalloutDismissBtn').click();
            const calloutHiddenAfterDismiss = Boolean(calloutEl && (calloutEl.hasAttribute('hidden') || window.getComputedStyle(calloutEl).display === 'none'));

            // 5e. Switch back to 3D Arena via tab click
            document.getElementById('modeBtn3d').click();
            const visIn3dReturn = checkVis();

            return {
              cadSlots,
              spinStateA,
              spinStateB,
              hanoiOk,
              hanoiDisks,
              hanoiVisible: Boolean(hanoiViz && !hanoiViz.classList.contains('hidden')),
              imgProvCount: imgProvSelects.length,
              imgModCount: imgModSelects.length,
              provOptionsA,
              openaiModOptionsA,
              hasNewClearBtn,
              hasImgNewClearBtn,
              restored3dTaskFromStep1,
              restoredTextDraft,
              saved3dDraftInState,
              afterClearTextDraft,
              visIn3d,
              visInImageAfter3d,
              visInVideo,
              visInText,
              visIn3dReturn,
              calloutVisibleOnText,
              hasBothCarets,
              calloutHiddenAfterDismiss,
            };
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });

        const val = e2eResult && e2eResult.result && e2eResult.result.value;
        assert(val && Array.isArray(val.cadSlots) && val.cadSlots.length === 2, 'Headless Chrome E2E must return cadSlots result');
        for (const cs of val.cadSlots) {
          assert(cs.ready, `Slot ${cs.slot} 3D CAD iframe must report CAD_VIEWPORT_READY`);
          assert(cs.triangles >= 100, `Slot ${cs.slot} 3D CAD model must build >= 100 triangles (got ${cs.triangles})`);
          assert.strictEqual(cs.watertight, true, `Slot ${cs.slot} 3D CAD model must be watertight`);
          assert(cs.has4View, `Slot ${cs.slot} 3D CAD viewport must capture deferred 4-angle composite PNG`);
          assert(cs.stripText.includes('Watertight') && cs.stripText.includes('tris'), `Slot ${cs.slot} telemetry strip must render mesh stats (got "${cs.stripText}")`);
        }
        assert(val.spinStateA && val.spinStateB, 'Both staggered 3D slots must report CAD_SPIN_STATE_REPORT');
        assert.strictEqual(val.spinStateA.turntableEnabled, true, 'Slot A must default to Iso + Spin (turntableEnabled = true) at execution rendering');
        assert.strictEqual(val.spinStateB.turntableEnabled, true, 'Slot B must default to Iso + Spin (turntableEnabled = true) at execution rendering');
        assert.strictEqual(val.spinStateA.spin3AxisEnabled, false, 'Slot A must have 3-Axis Spin OFF by default');
        assert.strictEqual(val.spinStateA.cameraPreset, 'iso', 'Slot A must default to Iso camera preset at execution rendering');
        assert.strictEqual(val.spinStateB.cameraPreset, 'iso', 'Slot B must default to Iso camera preset at execution rendering');
        assert.strictEqual(val.spinStateA.spinEpochMs, val.spinStateB.spinEpochMs, 'Staggered 3D slots must share identical spinEpochMs');
        const dy = Math.abs(val.spinStateA.modelRotation.y - val.spinStateB.modelRotation.y);
        const wrappedDy = Math.min(dy, Math.abs(dy - Math.PI * 2));
        assert(wrappedDy < 0.08, `Staggered 3D slots (700ms apart) must be phase-locked in Iso + Spin when Synced is ON (got Δy=${wrappedDy.toFixed(4)} rad)`);
        assert(Math.abs(val.spinStateA.modelRotation.x) < 1e-6 && Math.abs(val.spinStateA.modelRotation.z) < 1e-6, 'Iso + Spin must keep X and Z model rotation at 0 (upright turntable)');
        assert(val.hanoiOk && val.hanoiVisible && val.hanoiDisks === 8, `Towers of Hanoi must render 8 animated disks in #exec-viz-A (got hanoiDisks=${val.hanoiDisks})`);
        assert(val.imgProvCount >= 2 && val.imgModCount >= 2, `Image & GenMedia Arena must render Provider ▸ Model selects for each slot (got ${val.imgProvCount} provider selects, ${val.imgModCount} model selects)`);
        assert(Array.isArray(val.provOptionsA) && val.provOptionsA.includes('google') && val.provOptionsA.includes('openai'), 'Image Arena Provider select must include Google and OpenAI');
        assert(Array.isArray(val.openaiModOptionsA) && val.openaiModOptionsA[0] === 'gpt-image-2.5-sunburst', `Selecting OpenAI in Image Arena Provider dropdown must cascade to OpenAI image models (got ${JSON.stringify(val.openaiModOptionsA)})`);
        assert(val.hasNewClearBtn && val.hasImgNewClearBtn, 'Both #newClearArenaBtn and #imgNewClearBtn must exist in DOM');
        assert.strictEqual(val.restored3dTaskFromStep1, 'cad-simple-stepped-shaft', 'Switching back to 3D Arena must restore its saved task cad-simple-stepped-shaft');
        assert.strictEqual(val.restoredTextDraft, 'Text Arena Draft Continuity Check', 'Switching 3D -> Text must restore Text Arena draft prompt');
        assert.strictEqual(val.saved3dDraftInState, '3D Arena Draft Continuity Check', 'Switching away from 3D Arena must capture 3D Arena draft prompt');
        assert.strictEqual(val.afterClearTextDraft, '', 'clearAndResetCurrentArena() must clear draft prompt to blank');

        // Assert Cross-Arena UI Isolation Matrix
        assert.strictEqual(val.visIn3d.bodyMode, '3d', '3D Arena must set body[data-arena-mode="3d"]');
        assert(val.visIn3d.cadBarShown && val.visIn3d.textControlsShown && val.visIn3d.arenaShown, '3D Arena must show #cadModifyBar, controls, and #arena');
        assert(val.visIn3d.imgSecHidden && val.visIn3d.vidSecHidden, '3D Arena must hide #imageArenaSection and #videoArenaSection');

        assert.strictEqual(val.visInImageAfter3d.bodyMode, 'image', 'Image Arena must set body[data-arena-mode="image"]');
        assert(val.visInImageAfter3d.cadBarHidden, 'Switching 3D -> Image Arena MUST hide #cadModifyBar (3D & CAD Studio card)');
        assert(val.visInImageAfter3d.textControlsHidden && val.visInImageAfter3d.arenaHidden && val.visInImageAfter3d.scorecardHidden, 'Image Arena must hide Text/3D controls, #arena, and #scorecard');
        assert(val.visInImageAfter3d.cadMcpModalHidden, 'Switching 3D -> Image Arena must auto-close #cadMcpModal');
        assert(val.visInImageAfter3d.imgSecShown && val.visInImageAfter3d.vidSecHidden, 'Image Arena must show #imageArenaSection and hide #videoArenaSection');

        assert.strictEqual(val.visInVideo.bodyMode, 'video', 'Video Arena must set body[data-arena-mode="video"]');
        assert(val.visInVideo.cadBarHidden && val.visInVideo.textControlsHidden && val.visInVideo.arenaHidden && val.visInVideo.scorecardHidden && val.visInVideo.imgSecHidden, 'Video Arena must hide #cadModifyBar, Text/3D controls, #arena, #scorecard, and #imageArenaSection');
        assert(val.visInVideo.vidSecShown, 'Video Arena must show #videoArenaSection');

        assert.strictEqual(val.visInText.bodyMode, 'text', 'Text Arena must set body[data-arena-mode="text"]');
        assert(val.visInText.cadBarHidden, 'Text Arena MUST hide #cadModifyBar (3D & CAD Studio card)');
        assert(val.visInText.imgSecHidden && val.visInText.vidSecHidden, 'Text Arena must hide #imageArenaSection and #videoArenaSection');
        assert(val.visInText.textControlsShown && val.visInText.arenaShown, 'Text Arena must show controls and #arena');

        assert.strictEqual(val.visIn3dReturn.bodyMode, '3d', 'Returning to 3D Arena must set body[data-arena-mode="3d"]');
        assert(val.visIn3dReturn.cadBarShown && val.visIn3dReturn.textControlsShown && val.visIn3dReturn.arenaShown, 'Returning to 3D Arena must show #cadModifyBar, controls, and #arena');
        assert(val.visIn3dReturn.imgSecHidden && val.visIn3dReturn.vidSecHidden, 'Returning to 3D Arena must hide #imageArenaSection and #videoArenaSection');
        assert.strictEqual(val.calloutVisibleOnText, true, 'Balloon pointer (#arenaDiscoveryCallout) must be visible on Text Arena before dismissal');
        assert.strictEqual(val.hasBothCarets, true, 'Balloon pointer must include both #calloutCaretImage and #calloutCaret3d upward carets');
        assert.strictEqual(val.calloutHiddenAfterDismiss, true, 'Clicking #arenaCalloutDismissBtn must dismiss #arenaDiscoveryCallout and persist to localStorage');

        // 6. Verify Isolated Sub-Path Pages (/3d, /image, /video, /text) in Live Headless Chrome
        await cdpSend('Page.enable');
        for (const subSpec of [
          { path: '/3d', mode: '3d', present: ['cadModifyBar', 'arena', 'cadMcpModal'], absent: ['imageArenaSection', 'videoArenaSection'] },
          { path: '/image', mode: 'image', present: ['imageArenaSection'], absent: ['cadModifyBar', 'arena', 'scorecard', 'videoArenaSection', 'cadMcpModal'] },
          { path: '/video', mode: 'video', present: ['videoArenaSection'], absent: ['cadModifyBar', 'arena', 'scorecard', 'imageArenaSection', 'cadMcpModal'] },
          { path: '/text', mode: 'text', present: ['arena', 'scorecard'], absent: ['cadModifyBar', 'imageArenaSection', 'videoArenaSection', 'cadMcpModal'] },
        ]) {
          await cdpSend('Page.navigate', { url: `http://127.0.0.1:${port}${subSpec.path}` });
          await new Promise((r) => setTimeout(r, 600));
          const subCheck = await cdpSend('Runtime.evaluate', {
            expression: `(() => ({
              pathname: window.location.pathname,
              arenaPage: document.body.dataset.arenaPage || '',
              arenaMode: document.body.dataset.arenaMode || '',
              presentOk: ${JSON.stringify(subSpec.present)}.every((id) => document.getElementById(id) !== null),
              absentOk: ${JSON.stringify(subSpec.absent)}.every((id) => document.getElementById(id) === null),
            }))()`,
            returnByValue: true,
          });
          const sv = subCheck && subCheck.result && subCheck.result.value;
          assert(sv && sv.pathname === subSpec.path, `Sub-path navigation to ${subSpec.path} must load ${subSpec.path} (got ${sv && sv.pathname})`);
          assert.strictEqual(sv.arenaPage, subSpec.mode, `${subSpec.path} must set body[data-arena-page="${subSpec.mode}"]`);
          assert.strictEqual(sv.arenaMode, subSpec.mode, `${subSpec.path} must boot into ACTIVE_ARENA_MODE="${subSpec.mode}"`);
          assert.strictEqual(sv.presentOk, true, `${subSpec.path} must contain expected active arena DOM nodes (${subSpec.present.join(', ')})`);
          assert.strictEqual(sv.absentOk, true, `${subSpec.path} must NOT contain any non-active arena DOM nodes (${subSpec.absent.join(', ')})`);
        }

        ws.close();
        console.log('✓ 4. Headless Chrome E2E verified: multi-slot 3D CAD WebGL viewports + deferred 4-view PNGs + 8-disk Towers of Hanoi + Image Arena Provider ▸ Model cascading selector + Workspace State Continuity + Cross-Arena UI Isolation Matrix + 4 Isolated Sub-Path Pages (/text, /image, /3d, /video)');
      } finally {
        try { chrome.kill('SIGKILL'); } catch (_) {}
        try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\nALL PRE-RELEASE RENDERERS & ZERO-CACHE CHECKS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
