'use strict';

/**
 * Regression & Parity Verification Suite (v1.0.45)
 * Verifies:
 *   1. Text vs Image Arena UI parity & removal of button/category/scenario numbers
 *   2. Restoring history runs syncs models into Step 2 (Select Models) in both arenas
 *   3. Admin Image Arena History shows all platform users & merges per-slot server saves
 *   4. Zero regressions on Tower of Hanoi (255-move animation) & Pygame WASM (#canvas vs #canvas3d)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-compare-v1045-'));
process.env.AUTH_DATA_DIR = tmpDir;
process.env.APP_DATA_DIR = tmpDir;

const history = require('../src/history');
const { getImageArenaConfig, IMAGE_MODEL_CATALOG } = require('../src/imageArena');
const { TASKS } = require('../src/tasks');

(async () => {
  console.log('=== Running Arena Polish, History Model Restore, Admin Image History & Game/Hanoi Regression Suite (v1.0.45) ===');

  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const webGameJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'webGame.js'), 'utf8');

  // ---------------------------------------------------------------------------
  // 1. Text vs Image Arena UI Parity & Removal of Numbers + Header/Footer Version & Timestamp
  // ---------------------------------------------------------------------------
  assert(indexHtml.includes('<div class="wordmark-row">') && indexHtml.includes('id="headerAppVersion" class="head-version">v1.0.48</span>'), 'index.html must render #headerAppVersion next to LLM Compare title on top-left');
  assert(indexHtml.includes('id="appLastUpdated" class="foot-updated"') && indexHtml.includes('Last updated '), 'index.html footer must render #appLastUpdated with "Last updated" timestamp');
  assert(serverJs.includes('lastUpdated: LAST_UPDATED_ISO'), 'server.js /api/config must expose lastUpdated timestamp');
  assert(appJs.includes('function formatLastUpdatedStamp(isoStr)'), 'app.js must format lastUpdated timestamp');
  assert(!indexHtml.includes('+ Add model (3/6)'), 'index.html #addSlotBtn must not show (3/6) count');
  assert(!indexHtml.includes('+ Add model (2/4)'), 'index.html #imgAddSlotBtn must not show (2/4) count');
  assert(indexHtml.includes('id="addSlotBtn"') && indexHtml.includes('>+ Add model</button>'), 'index.html #addSlotBtn must say "+ Add model"');
  assert(indexHtml.includes('id="imgAddSlotBtn"') && indexHtml.includes('>+ Add model</button>'), 'index.html #imgAddSlotBtn must say "+ Add model"');

  // Image Arena Step 1 & Step 3 parity controls
  assert(indexHtml.includes('id="imgCopyPromptBtn"'), 'index.html must include #imgCopyPromptBtn in Image Arena Step 1');
  assert(indexHtml.includes('id="imgEndpointPill"'), 'index.html must include #imgEndpointPill in Image Arena Step 1');
  assert(indexHtml.includes('id="imgJumpScorecardBtn"'), 'index.html must include #imgJumpScorecardBtn in Image Arena Step 3');
  assert(
    indexHtml.includes('Generate &amp; Compare Images ▸ <kbd class="run-kbd">⌘↵</kbd>'),
    'index.html #imgRunBtn must include the ⌘↵ keyboard shortcut hint matching Text Arena'
  );

  // Category dropdowns must not include numbers
  assert(
    !appJs.includes('Custom & Saved Prompts (${SAVED_PROMPTS.length})'),
    'app.js must not append (${SAVED_PROMPTS.length}) count to Custom & Saved Prompts category option'
  );
  assert(
    !appJs.includes('`${label} (${inCat.length})`'),
    'app.js must not append (${inCat.length}) count to #categorySelect options'
  );
  assert(
    !appJs.includes('+ Add model (${SLOT_IDS.length}/${MAX_SLOTS})') &&
    !appJs.includes('+ Add model (${IMG_SLOTS.length}/${maxActiveSlots})'),
    'app.js must not append (X/Y) counts to #addSlotBtn or #imgAddSlotBtn'
  );

  // Image History button must not append run counts
  assert(
    !appJs.includes('`🗂 History (${ids.size})`'),
    'updateImageHistoryButton() must never append (${ids.size}) to #imgHistoryBtn'
  );
  const histFnMatch = appJs.match(/async function updateImageHistoryButton\(\)\s*\{([\s\S]*?)\n\}/);
  assert(histFnMatch && histFnMatch[1].includes("histBtn.textContent = '🗂 History';"), 'updateImageHistoryButton() must always set textContent to "🗂 History"');

  // Image Arena packs and scenarios must not have numbered prefixes or "(Up to 13 Images)"
  const imgCfg = getImageArenaConfig();
  for (const pack of imgCfg.packs || []) {
    assert(!/\(\s*Up to \d+\s+Images\s*\)/i.test(pack.title || pack.label || ''), `Pack title "${pack.title}" must not contain "(Up to N Images)"`);
    for (const sc of pack.scenarios || []) {
      assert(!/^\d+\.\s+/.test(sc.title), `Scenario title "${sc.title}" must not start with a number prefix`);
    }
  }

  // Image Arena preset active highlighting & Slot pill parity
  assert(stylesCss.includes('.img-preset-btn.is-active'), 'styles.css must style .img-preset-btn.is-active matching .mc-preset-btn.is-active');
  assert(appJs.includes("btn.classList.toggle('is-active', Boolean(presetMap[p] && presetMap[p] === currentIdsSig))"), 'renderImageSlotsConfigurator() must highlight active .img-preset-btn');
  assert(appJs.includes('>Slot ${esc(slotObj.slot)}</span>'), 'renderImageArenaPlaceholderCards() must display "Slot A" badge text matching Text Arena');
  assert(appJs.includes('>Slot ${esc(r.slot)}</span>'), 'renderImageEconomicsModeler() must display "Slot A" badge text matching Text Arena');
  console.log('✓ 1. Text vs Image Arena UI parity & number removal verified');

  // ---------------------------------------------------------------------------
  // 2. Restore History -> Sync Models in Step 2 (Select Models)
  // ---------------------------------------------------------------------------
  const renderSavedMatch = appJs.match(/function renderSavedRun\(snap\)\s*\{([\s\S]*?)buildArena\(snap\.models\);/);
  assert(renderSavedMatch, 'renderSavedRun(snap) must exist and precede buildArena(snap.models)');
  const preBuildBody = renderSavedMatch[1];
  assert(preBuildBody.includes('SLOT_IDS = newSlotIds;'), 'renderSavedRun() must update SLOT_IDS from snap.models');
  assert(preBuildBody.includes('SLOT_ASSIGN[s] = newAssign[s] || null;'), 'renderSavedRun() must mutate const SLOT_ASSIGN in place from snap.models');
  assert(preBuildBody.includes('SLOT_EFFORT[s] = newEffort[s] || null;'), 'renderSavedRun() must mutate const SLOT_EFFORT in place from snap.models');
  assert(!preBuildBody.includes('SLOT_ASSIGN ='), 'renderSavedRun() must never reassign const SLOT_ASSIGN');
  assert(!preBuildBody.includes('SLOT_EFFORT ='), 'renderSavedRun() must never reassign const SLOT_EFFORT');
  assert(preBuildBody.includes('syncModelsFromSlots();'), 'renderSavedRun() must call syncModelsFromSlots()');
  assert(preBuildBody.includes('renderModelEditors();'), 'renderSavedRun() must call renderModelEditors() so Step 2 reflects restored models');
  assert(preBuildBody.includes('RETIRED_MODEL_MAP[rawId]'), 'renderSavedRun() must map retired model IDs via RETIRED_MODEL_MAP');

  const restoreImgMatch = appJs.match(/async function restoreImageArenaRun\(runId\)\s*\{([\s\S]*?)renderImageArenaPlaceholderCards\(\);/);
  assert(restoreImgMatch, 'restoreImageArenaRun(runId) must exist');
  assert(
    restoreImgMatch[1].includes('Array.isArray(rec.summary)') &&
    restoreImgMatch[1].includes('renderImageSlotsConfigurator();') &&
    restoreImgMatch[1].includes('updateQuotaBadge();'),
    'restoreImageArenaRun() must sync IMG_SLOTS from slots/results/summary and re-render Step 2 configurator'
  );
  console.log('✓ 2. History restore Step 2 model synchronization verified for both Text and Image Arenas');

  // ---------------------------------------------------------------------------
  // 3. Admin Arena-Specific History Roster (runs >= 1) & Server-Authoritative Per-Slot Merging
  // ---------------------------------------------------------------------------
  const mockRegisteredUsers = [
    { username: 'ubhi@google.com', role: 'admin' },
    { username: 'john', role: 'user' },
    { username: 'alice@example.com', role: 'user' },
    { username: 'zero_run_user', role: 'user' },
  ];

  // Save a text run and an image run for ubhi@google.com (active in both arenas)
  await history.saveRun({
    id: 'txt_ubhi_1',
    user: 'ubhi@google.com',
    userName: 'ubhi@google.com',
    at: Date.now() - 6000,
    taskId: 'custom',
    taskTitle: 'Ubhi prompt',
    models: [{ slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform' }],
    slots: [{ slot: 'A', data: { ok: true, durationMs: 400, costUsd: 0.001 } }],
  });
  await history.saveImageRun({
    id: 'img_ubhi_1',
    user: 'ubhi@google.com',
    userName: 'ubhi@google.com',
    at: Date.now() - 5500,
    packId: 'retail-print',
    scenarioId: 'holiday-card',
    title: 'Ubhi image run',
    prompt: 'Create a card.',
    imageSize: '1K',
    aspectRatio: '1:1',
    slots: [{ slot: 'A', catalogId: 'gemini-3.1-flash-image' }],
    results: [{ slot: 'A', catalogId: 'gemini-3.1-flash-image', ok: true, latencyMs: 1200, costUsd: 0.02 }],
  });

  // Save a text-only run for alice@example.com (no image runs)
  await history.saveRun({
    id: 'txt_alice_1',
    user: 'alice@example.com',
    userName: 'alice@example.com',
    at: Date.now() - 5000,
    taskId: 'custom',
    taskTitle: 'Alice prompt',
    models: [{ slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform' }],
    slots: [{ slot: 'A', data: { ok: true, durationMs: 500, costUsd: 0.001 } }],
  });

  // Simulate server-authoritative per-slot Image Arena saves for user "john"
  // (Slot A finishes first, Slot B finishes 200ms later with the same sharedRunId)
  const sharedRunId = 'img_john_multi_slot_test';
  const johnSlots = [
    { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
    { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
  ];
  await history.saveImageRun({
    id: sharedRunId,
    mergeSlots: true,
    user: 'john',
    userName: 'john',
    at: Date.now() - 1000,
    packId: 'retail-print',
    scenarioId: 'holiday-card',
    title: 'Holiday Card Typography & Foil Hierarchy',
    prompt: 'Create a luxury holiday card with gold foil lettering.',
    imageSize: '2K',
    aspectRatio: '16:9',
    slots: johnSlots,
    results: [
      {
        slot: 'A',
        catalogId: 'gemini-3.1-flash-image',
        model: 'gemini-3.1-flash-image-preview',
        label: 'Gemini Nano Banana 2',
        shortLabel: 'Nano Banana 2',
        ok: true,
        latencyMs: 3200,
        imageSize: '2K',
        aspectRatio: '16:9',
        width: 2048,
        height: 1152,
        megapixels: 2.36,
        imageOutputTokens: 1290,
        standardPayGoCostUsd: 0.04,
        costUsd: 0.04,
        imageVaultRef: 'img_john_slot_a_vault',
      },
    ],
  });

  await history.saveImageRun({
    id: sharedRunId,
    mergeSlots: true,
    user: 'john',
    userName: 'john',
    at: Date.now() - 800,
    packId: 'retail-print',
    scenarioId: 'holiday-card',
    title: 'Holiday Card Typography & Foil Hierarchy',
    prompt: 'Create a luxury holiday card with gold foil lettering.',
    imageSize: '2K',
    aspectRatio: '16:9',
    slots: johnSlots,
    results: [
      {
        slot: 'B',
        catalogId: 'gemini-nano-banana-2.1',
        model: 'gemini-nano-banana-2.1',
        label: 'Gemini Nano Banana 2.1',
        shortLabel: 'Nano Banana 2.1',
        ok: true,
        latencyMs: 2800,
        imageSize: '2K',
        aspectRatio: '16:9',
        width: 2048,
        height: 1152,
        megapixels: 2.36,
        imageOutputTokens: 1680,
        standardPayGoCostUsd: 0.02,
        costUsd: 0.02,
        imageVaultRef: 'img_john_slot_b_vault',
      },
    ],
  });

  // Now simulate client-side save arriving with thumbDataUrl for both slots
  await history.saveImageRun({
    id: sharedRunId,
    user: 'john',
    userName: 'john',
    at: Date.now() - 700,
    packId: 'retail-print',
    scenarioId: 'holiday-card',
    title: 'Holiday Card Typography & Foil Hierarchy',
    prompt: 'Create a luxury holiday card with gold foil lettering.',
    imageSize: '2K',
    aspectRatio: '16:9',
    slots: johnSlots,
    results: [
      {
        slot: 'A',
        catalogId: 'gemini-3.1-flash-image',
        ok: true,
        latencyMs: 3200,
        costUsd: 0.04,
        thumbDataUrl: 'data:image/jpeg;base64,AA==',
      },
      {
        slot: 'B',
        catalogId: 'gemini-nano-banana-2.1',
        ok: true,
        latencyMs: 2800,
        costUsd: 0.02,
        thumbDataUrl: 'data:image/jpeg;base64,BB==',
      },
    ],
  });

  const allImgRuns = history.listAllImageRuns();
  const johnImgRuns = history.listImageRuns('john');
  assert(johnImgRuns.some((r) => r.id === sharedRunId), 'listImageRuns("john") must include john merged image run');
  const johnRunMeta = allImgRuns.find((r) => r.id === sharedRunId);
  assert(johnRunMeta, 'Admin listAllImageRuns() must include john merged image run');
  assert.strictEqual(johnRunMeta.userName, 'john');
  assert.strictEqual(johnRunMeta.summary.length, 2, 'Merged image run must contain both Slot A and Slot B');
  const slotASummary = johnRunMeta.summary.find((s) => s.slot === 'A');
  const slotBSummary = johnRunMeta.summary.find((s) => s.slot === 'B');
  assert.strictEqual(slotASummary.imageVaultRef, 'img_john_slot_a_vault', 'Slot A must preserve server imageVaultRef after client thumb merge');
  assert.strictEqual(slotASummary.thumbDataUrl, 'data:image/jpeg;base64,AA==', 'Slot A must include client thumbDataUrl');
  assert.strictEqual(slotBSummary.imageVaultRef, 'img_john_slot_b_vault', 'Slot B must preserve server imageVaultRef after client thumb merge');
  assert.strictEqual(slotBSummary.thumbDataUrl, 'data:image/jpeg;base64,BB==', 'Slot B must include client thumbDataUrl');

  // Verify arena-specific runs >= 1 filtering:
  // - ubhi@google.com (1 Text run, 1 Image run) appears in BOTH usageSummary and imageUsageSummary
  // - alice@example.com (1 Text run, 0 Image runs) appears ONLY in usageSummary and NOT in imageUsageSummary
  // - john (0 Text runs, 1 Image run) appears ONLY in imageUsageSummary and NOT in usageSummary
  // - zero_run_user (0 runs in both) appears in NEITHER
  const textUsage = history.usageSummary({ registeredUsers: mockRegisteredUsers });
  const imgUsage = history.imageUsageSummary({ registeredUsers: mockRegisteredUsers });
  const textUserNames = new Set(textUsage.users.map((u) => u.userName));
  const imgUserNames = new Set(imgUsage.users.map((u) => u.userName));

  assert(textUserNames.has('ubhi@google.com'), 'Text usageSummary must include ubhi@google.com (has Text runs)');
  assert(imgUserNames.has('ubhi@google.com'), 'Image imageUsageSummary must include ubhi@google.com (has Image runs)');

  assert(textUserNames.has('alice@example.com'), 'Text usageSummary must include Text-only user alice@example.com');
  assert(!imgUserNames.has('alice@example.com'), 'Image imageUsageSummary must NOT include Text-only user alice@example.com');

  assert(imgUserNames.has('john'), 'Image imageUsageSummary must include Image-only user john');
  assert(!textUserNames.has('john'), 'Text usageSummary must NOT include Image-only user john');

  assert(!textUserNames.has('zero_run_user'), 'Text usageSummary must NOT include 0-run user');
  assert(!imgUserNames.has('zero_run_user'), 'Image imageUsageSummary must NOT include 0-run user');

  for (const u of textUsage.users) {
    assert(u.runs >= 1, `Every user in Text usageSummary must have runs >= 1 (found ${u.userName} with ${u.runs})`);
  }
  for (const u of imgUsage.users) {
    assert(u.runs >= 1, `Every user in Image imageUsageSummary must have runs >= 1 (found ${u.userName} with ${u.runs})`);
  }

  const johnImgRow = imgUsage.users.find((u) => u.userName === 'john');
  assert(johnImgRow && johnImgRow.runs >= 1 && johnImgRow.imagesGenerated >= 2, 'john row in imageUsageSummary must reflect his merged run and 2 generated images');

  // Verify server.js passes registeredUsers to both usage endpoints and saves image runs server-authoritatively
  assert(serverJs.includes('history.usageSummary({ registeredUsers: auth.listUsers() })'), 'server.js /api/usage must pass auth.listUsers()');
  assert(serverJs.includes('history.imageUsageSummary({ registeredUsers: auth.listUsers() })'), 'server.js /api/image-arena/usage must pass auth.listUsers()');
  assert(serverJs.includes('await history.saveImageRun({') && serverJs.includes('mergeSlots: true,'), 'server.js POST /api/image-arena/run must save image runs server-authoritatively with mergeSlots: true');
  console.log('✓ 3. Arena-specific runs >= 1 History roster filtering & server-authoritative per-slot merging verified');

  // ---------------------------------------------------------------------------
  // 4. Tower of Hanoi & Pygame WASM Game Execution Regressions
  // ---------------------------------------------------------------------------
  // 4a. Tower of Hanoi task config & move parser / generator
  const hanoiTask = TASKS.find((t) => t.id === 'hanoi' || t.visualizer === 'hanoi');
  assert(hanoiTask, 'TASKS must include the Tower of Hanoi task');
  assert.strictEqual(hanoiTask.visualizer, 'hanoi');
  assert(
    appJs.includes("(currentTask().executable || currentTask().visualizer === 'hanoi')"),
    'public/app.js must keep visualizer === "hanoi" runnable in browser even when codeExecOn is false'
  );

  // Extract parseHanoiMoves and generateHanoiMoves from public/app.js and execute them directly
  const parseHanoiMatch = appJs.match(/function parseHanoiMoves\(stdout\)\s*\{[\s\S]*?\n\}/);
  const genHanoiMatch = appJs.match(/function generateHanoiMoves\([\s\S]*?\n\}/);
  assert(parseHanoiMatch && genHanoiMatch, 'public/app.js must define parseHanoiMoves and generateHanoiMoves');
  const hanoiFns = new Function(`${parseHanoiMatch[0]}\n${genHanoiMatch[0]}\nreturn { parseHanoiMoves, generateHanoiMoves };`)();

  const generated255 = hanoiFns.generateHanoiMoves(8);
  assert.strictEqual(generated255.length, 255, 'generateHanoiMoves(8) must produce 255 moves (2^8 - 1)');
  assert.deepStrictEqual(generated255[0], { disk: 1, from: 'A', to: 'B' });
  assert.deepStrictEqual(generated255[254], { disk: 1, from: 'B', to: 'C' });

  // Ensure comments in Python source code do not fool parseHanoiMoves
  const pythonSourceWithComments = [
    '# Example output: Move disk 1 from A to C',
    '// Move disk 2 from A to B',
    'def hanoi(n, src, dst, aux):',
    '    print(f"Move disk {n} from {src} to {dst}")',
  ].join('\n');
  const parsedFromSource = hanoiFns.parseHanoiMoves(pythonSourceWithComments);
  assert.strictEqual(parsedFromSource.length, 0, 'parseHanoiMoves must ignore comment lines (# and //) and f-string templates');

  const realStdout = generated255.map((m) => `Move disk ${m.disk} from ${m.from} to ${m.to}`).join('\n');
  const parsed255 = hanoiFns.parseHanoiMoves(realStdout);
  assert.strictEqual(parsed255.length, 255, 'parseHanoiMoves must parse all 255 moves from standard stdout');

  // 4b. Pygame WASM (#canvas vs #canvas3d) protection
  const { patchIndexHtml } = require('../src/webGame');
  assert(
    webGameJs.includes('#canvas{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;') &&
    webGameJs.includes('#canvas3d{display:none!important;visibility:hidden!important;'),
    'src/webGame.js must keep #canvas as the full-screen 2D SDL2 Pygame surface and #canvas3d as the hidden 3D surface so Pygame games never render a blank black screen'
  );
  const sampleHtmlPath = path.join(tmpDir, 'pygbag-sample.html');
  fs.writeFileSync(sampleHtmlPath, '<html><head></head><body><canvas id="canvas"></canvas><canvas id="canvas3d"></canvas></body></html>', 'utf8');
  patchIndexHtml(sampleHtmlPath);
  const patchedHtml = fs.readFileSync(sampleHtmlPath, 'utf8');
  assert(patchedHtml.includes('#canvas{position:fixed!important;') && patchedHtml.includes('#canvas3d{display:none!important;'), 'patchIndexHtml must inject #canvas visible and #canvas3d hidden CSS');
  console.log('✓ 4. Tower of Hanoi (255-move animation) & Pygame WASM (#canvas vs #canvas3d) regression checks passed');

  // ---------------------------------------------------------------------------
  // 5. Exported Module Surface & Edge-Case Coverage (codeRunner, webGame, history, pricing, log)
  // ---------------------------------------------------------------------------
  const codeRunner = require('../src/codeRunner');
  const webGameMod = require('../src/webGame');
  const pricingMod = require('../src/pricing');
  const logMod = require('../src/log');

  assert.strictEqual(typeof codeRunner.executionEnabled(), 'boolean');
  const pyOut = await codeRunner.runPython('print("Move disk 1 from A to C")');
  assert.strictEqual(pyOut.exitCode, 0);
  assert(pyOut.stdout.includes('Move disk 1 from A to C'));

  const jsTestOut = codeRunner.runJsTests('function add(a, b) { return a + b; }', 'add', [{ input: [2, 3], expected: 5 }]);
  assert.strictEqual(jsTestOut.passed, 1);
  assert.strictEqual(jsTestOut.total, 1);
  const runCodeJsOut = await codeRunner.runCode('javascript', 'function add(a, b) { return a + b; }', {
    functionName: 'add',
    testCases: [{ input: [4, 5], expected: 9 }],
  });
  assert.strictEqual(runCodeJsOut.passed, 1);
  const runCodePyOut = await codeRunner.runCode('python', 'print(42)');
  assert.strictEqual(runCodePyOut.exitCode, 0);

  const sanitizedGame = webGameMod.sanitizeForPygbag('import pygame\nimport pygame.gfxdraw\npygame.init()\n');
  assert(sanitizedGame.includes('___ULLM_GAME_BOOTED___'), 'sanitizeForPygbag must inject ___ULLM_GAME_BOOTED___ hook');
  assert(sanitizedGame.includes('_PgbNoGfxdraw'), 'sanitizeForPygbag must shim pygame.gfxdraw for Pygbag WASM');
  const gameHash = webGameMod.idFor('print(1)');
  assert.strictEqual(gameHash.length, 16);
  assert.strictEqual(webGameMod.gameDir('invalid-id'), null);
  assert.strictEqual(typeof webGameMod.webGameEnabled(), 'boolean');

  // Verify history.getImageRun, setImageRunStarred, deleteImageRun, flushSnapshotSync/Async
  const hydratedJohn = history.getImageRun(sharedRunId, { username: 'ubhi@google.com', isAdmin: true });
  assert(hydratedJohn && hydratedJohn.id === sharedRunId && Array.isArray(hydratedJohn.results) && hydratedJohn.results.length === 2, 'Admin getImageRun must return merged 2-slot run');
  const starRes = await history.setImageRunStarred(sharedRunId, true, { username: 'john', isAdmin: false });
  assert(starRes && starRes.starred === true, 'Owner can star image run');
  history.flushSnapshotSync();
  await history.flushSnapshotAsync();
  const delImgRes = await history.deleteImageRun(sharedRunId, { username: 'john', isAdmin: false });
  assert.strictEqual(delImgRes, true, 'Owner can soft-delete image run');

  // Verify pricing.resolveModels maps retired IDs cleanly
  const resolvedModels = pricingMod.resolveModels([
    { slot: 'A', id: 'claude-opus-5-5-fast' },
    { slot: 'B', id: 'gemini-3.8-flash' },
  ]);
  assert.strictEqual(resolvedModels.length, 2);
  assert.strictEqual(resolvedModels[0].catalogId, 'claude-opus-5-5', 'resolveModels must map retired claude-opus-5-5-fast to claude-opus-5-5');

  // Verify log.redact and log.jsonMode
  assert.strictEqual(typeof logMod.jsonMode(), 'boolean');
  assert(!logMod.redact('Bearer sk-proj-secret1234567890').includes('sk-proj-secret1234567890'), 'log.redact must scrub Bearer tokens');
  console.log('✓ 5. Module surface & edge-case coverage checks passed');

  console.log('\nALL v1.0.45 ARENA POLISH, HISTORY RESTORE & REGRESSION CHECKS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
