const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

console.log('--- RUNNING USER PREFERENCES & CLEANUP VERIFICATION ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ullm-pref-test-'));
process.env.APP_DATA_DIR = tmpDir;

delete require.cache[require.resolve('../src/history')];
const history = require('../src/history');

const USER_ALICE = 'alice@example.com';
const USER_BOB = 'bob@example.com';

(async () => {
  // 1. Initial state for fresh user (lightweight, no legacy prompt/attachments bloat)
  const initAlice = history.getUserPreferences(USER_ALICE);
  assert.strictEqual(initAlice.taskId, 'custom');
  assert.strictEqual(initAlice.slots, null);
  assert.strictEqual(initAlice.prompt, undefined, 'Legacy remembered prompt field must be removed');
  assert.strictEqual(initAlice.attachments, undefined, 'Legacy remembered attachments field must be removed');
  assert.strictEqual(initAlice.remembered, undefined, 'Legacy remembered flag must be removed');
  assert.strictEqual(history.lastPrompt, undefined, 'history.lastPrompt must be removed');
  console.log('✓ Initial state is clean and free of legacy remembered prompt bloat');

  // 2. Save preferences for Alice (taskId & slots)
  const aliceSlots = [
    { slot: 'A', catalogId: 'gemini-3.8-flash', effort: 'high' },
    { slot: 'B', catalogId: 'claude-sonnet-5', effort: null },
    { slot: 'C', catalogId: 'grok-4.20-reasoning', effort: 'medium' },
  ];
  const aliceSaved = history.saveUserPreferences(USER_ALICE, {
    taskId: 'custom',
    slots: aliceSlots,
  });
  assert(aliceSaved, 'saveUserPreferences must return preference object');
  assert.strictEqual(aliceSaved.taskId, 'custom');
  assert.strictEqual(aliceSaved.slots.length, 3);
  assert.deepStrictEqual(history.lastModels(USER_ALICE), [
    { catalogId: 'gemini-3.8-flash', effort: 'high' },
    { catalogId: 'claude-sonnet-5', effort: null },
    { catalogId: 'grok-4.20-reasoning', effort: 'medium' },
  ]);
  console.log('✓ Alice preferences saved and read back via lastModels');

  // 3. User isolation: Bob has completely separate preferences
  const initBob = history.getUserPreferences(USER_BOB);
  assert.strictEqual(initBob.slots, null, 'Bob should not inherit Alice slots');

  const bobSlots = [
    { slot: 'A', catalogId: 'gpt-6-sol', effort: 'low' },
    { slot: 'B', catalogId: 'kimi-k3', effort: null },
  ];
  history.saveUserPreferences(USER_BOB, {
    taskId: 'coding-queue',
    slots: bobSlots,
  });

  assert.deepStrictEqual(history.lastModels(USER_BOB), [
    { catalogId: 'gpt-6-sol', effort: 'low' },
    { catalogId: 'kimi-k3', effort: null },
  ]);
  assert.strictEqual(history.getUserPreferences(USER_ALICE).slots.length, 3);
  console.log('✓ Strict per-user isolation verified between Alice and Bob');

  // 4. Updating preferences via saveRun (simulation of comparison run)
  await history.saveRun({
    user: USER_ALICE,
    userName: USER_ALICE,
    task: { id: 'custom', title: 'Custom prompt', prompt: 'New Alice Prompt from Run' },
    customPrompt: 'New Alice Prompt from Run',
    kind: 'compare',
    models: [
      { slot: 'A', catalogId: 'claude-opus-5-5', label: 'Opus', effort: 'high' },
      { slot: 'B', catalogId: 'gemini-3.8-pro', label: 'Pro', effort: 'high' },
    ],
    results: [
      { slot: 'A', code: 'code1', costUsd: 0.05, wallMs: 200 },
      { slot: 'B', code: 'code2', costUsd: 0.04, wallMs: 180 },
    ],
  });

  assert.deepStrictEqual(history.lastModels(USER_ALICE), [
    { catalogId: 'claude-opus-5-5', effort: 'high' },
    { catalogId: 'gemini-3.8-pro', effort: 'high' },
  ]);
  console.log('✓ saveRun automatically updates slot line-up');

  // 5. Single model run doesn't wipe multi-slot line-up
  await history.saveRun({
    user: USER_ALICE,
    userName: USER_ALICE,
    task: { id: 'custom', title: 'Custom prompt', prompt: 'Single rerun prompt' },
    customPrompt: 'Single rerun prompt',
    kind: 'single',
    models: [{ slot: 'A', catalogId: 'claude-opus-5-5', label: 'Opus', effort: 'high' }],
    results: [{ slot: 'A', code: 'code1-fixed', costUsd: 0.02, wallMs: 100 }],
  });
  assert.strictEqual(history.lastModels(USER_ALICE).length, 2);
  console.log('✓ Single model re-run preserves multi-slot lineup');

  // 6. Persistence across cache reset / reload from disk
  await new Promise((r) => setTimeout(r, 100));
  delete require.cache[require.resolve('../src/history')];
  const reloadedHistory = require('../src/history');

  assert.strictEqual(reloadedHistory.lastModels(USER_ALICE).length, 2);
  const reloadedBob = reloadedHistory.getUserPreferences(USER_BOB);
  assert.strictEqual(reloadedBob.taskId, 'coding-queue');
  assert.strictEqual(reloadedBob.slots.length, 2);
  console.log('✓ Preferences survive module re-instantiation and reload from disk/SQLite');

  // 7. Retain attachments in history run records (while keeping prefs lean)
  const sampleAttachment = {
    name: 'architecture-diagram.png',
    mimeType: 'image/png',
    kind: 'image',
    size: 102400,
    isEmpty: false,
    pageCount: 0,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    textContent: '',
    estimatedTokens: 258,
  };

  const runWithAttachment = await reloadedHistory.saveRun({
    user: USER_ALICE,
    userName: USER_ALICE,
    task: {
      id: 'custom',
      title: 'Custom prompt with attachment',
      prompt: 'Review the attached architecture diagram.',
      attachments: [sampleAttachment],
    },
    customPrompt: 'Review the attached architecture diagram.',
    kind: 'compare',
    models: [{ slot: 'A', catalogId: 'gemini-3.8-flash', label: 'Flash' }],
    results: [{ slot: 'A', code: 'looks good', costUsd: 0.001, wallMs: 150 }],
  });

  const fullRunRecord = reloadedHistory.getRun(runWithAttachment.id, { username: USER_ALICE, isAdmin: true });
  assert(fullRunRecord, 'Saved run must be retrievable from history');
  assert(Array.isArray(fullRunRecord.attachments), 'Run record must contain attachments array');
  assert.strictEqual(fullRunRecord.attachments.length, 1);
  assert.strictEqual(fullRunRecord.attachments[0].name, 'architecture-diagram.png');
  assert.strictEqual(fullRunRecord.attachments[0].data, sampleAttachment.data);
  console.log('✓ Attachments are retained in history run records without bloating user preferences');

  // 8. Verify complete removal of "Remember prompt & files" UI/JS/CSS
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert(!indexHtml.includes('rememberPromptCheckbox'), 'index.html must not contain rememberPromptCheckbox');
  assert(!indexHtml.includes('rememberPromptWrap'), 'index.html must not contain rememberPromptWrap');
  assert(!stylesCss.includes('.remember-prompt-wrap'), 'styles.css must not contain .remember-prompt-wrap');
  assert(!appJs.includes('rememberPromptCheckbox'), 'app.js must not contain rememberPromptCheckbox');
  assert(!appJs.includes('saveRememberedPromptAndAttachments'), 'app.js must not contain saveRememberedPromptAndAttachments');
  console.log('✓ Verified complete removal of Remember prompt & files from HTML, CSS, and JS');

  // 9. Per-arena workspace state persistence (Text, 3D & CAD, Image & GenMedia) + automatic lastRunId linkage
  const cadRun = await reloadedHistory.saveRun({
    user: USER_ALICE,
    userName: USER_ALICE,
    task: {
      id: 'cad3d-planetary-gearbox',
      category: 'cad3d',
      title: 'Planetary Gearbox',
      prompt: 'Build a planetary gearbox.',
    },
    customPrompt: '',
    kind: 'compare',
    models: [
      { slot: 'A', catalogId: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' },
      { slot: 'B', catalogId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', effort: 'high' },
    ],
    results: [
      { slot: 'A', code: 'buildPart()', costUsd: 0.001, wallMs: 400 },
      { slot: 'B', code: 'buildPart()', costUsd: 0.002, wallMs: 500 },
    ],
  });

  const imgRun = await reloadedHistory.saveImageRun({
    id: 'img_test_run_001',
    user: USER_ALICE,
    userName: USER_ALICE,
    packId: 'pack-photoreal',
    scenarioId: 'sc-product-hero',
    scenarioTitle: 'Product Hero Shot',
    prompt: 'Studio product hero shot on dark slate',
    imageSize: '2K',
    aspectRatio: '16:9',
    slots: [
      { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
      { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
    ],
    results: [
      { slot: 'A', catalogId: 'gemini-3.1-flash-image', ok: true, latencyMs: 1200, costUsd: 0.04 },
      { slot: 'B', catalogId: 'gemini-nano-banana-2.1', ok: true, latencyMs: 900, costUsd: 0.02 },
    ],
  });

  reloadedHistory.saveUserPreferences(USER_ALICE, {
    taskId: 'custom',
    slots: [
      { slot: 'A', catalogId: 'claude-opus-5-5', effort: 'high' },
      { slot: 'B', catalogId: 'deepseek-v4-1-flash', effort: null },
    ],
    workspaceState: {
      lastArena: '3d',
      arenas: {
        text: {
          slots: [
            { slot: 'A', catalogId: 'claude-opus-5-5', effort: 'high' },
            { slot: 'B', catalogId: 'deepseek-v4-1-flash', effort: null },
          ],
          taskId: 'custom',
          draftPrompt: 'Unsaved text arena custom prompt draft',
          lastRunId: runWithAttachment.id,
        },
        '3d': {
          slots: [
            { slot: 'A', catalogId: 'deepseek-v4-1-flash', effort: null },
            { slot: 'B', catalogId: 'gemini-3.8-flash', effort: 'high' },
          ],
          taskId: 'cad3d-planetary-gearbox',
          draftPrompt: 'Custom 3D bracket draft',
          lastRunId: cadRun.id,
        },
        image: {
          slots: [
            { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
            { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
          ],
          packId: 'pack-photoreal',
          scenarioId: 'sc-product-hero',
          draftPrompt: 'Custom image prompt draft',
          imageSize: '4K',
          aspectRatio: '1:1',
          lastRunId: imgRun.id,
        },
      },
    },
  });

  const wsPrefs = reloadedHistory.getUserPreferences(USER_ALICE);
  assert(wsPrefs.workspaceState, 'workspaceState must be present in getUserPreferences');
  assert.strictEqual(wsPrefs.workspaceState.lastArena, '3d');
  assert.strictEqual(wsPrefs.workspaceState.arenas.text.draftPrompt, 'Unsaved text arena custom prompt draft');
  assert.strictEqual(wsPrefs.workspaceState.arenas.text.lastRunId, runWithAttachment.id);
  assert.strictEqual(Boolean(wsPrefs.workspaceState.arenas.text.prunedToDefault), false);
  assert.strictEqual(wsPrefs.workspaceState.arenas['3d'].taskId, 'cad3d-planetary-gearbox');
  assert.strictEqual(wsPrefs.workspaceState.arenas['3d'].lastRunId, cadRun.id);
  assert.strictEqual(Boolean(wsPrefs.workspaceState.arenas['3d'].prunedToDefault), false);
  assert.strictEqual(wsPrefs.workspaceState.arenas.image.packId, 'pack-photoreal');
  assert.strictEqual(wsPrefs.workspaceState.arenas.image.imageSize, '4K');
  assert.strictEqual(wsPrefs.workspaceState.arenas.image.aspectRatio, '1:1');
  assert.strictEqual(wsPrefs.workspaceState.arenas.image.lastRunId, imgRun.id);
  assert.strictEqual(Boolean(wsPrefs.workspaceState.arenas.image.prunedToDefault), false);
  console.log('✓ Per-arena workspaceState (lastArena, text, 3d, image) saved and verified');

  // 10. 7-Day Pruning Fallback Rule (Case A: lastRunId points to a pruned/deleted run)
  await reloadedHistory.deleteRun(cadRun.id, { username: USER_ALICE, isAdmin: true });
  const afterCadRunPruned = reloadedHistory.getUserPreferences(USER_ALICE);
  assert.strictEqual(afterCadRunPruned.workspaceState.arenas['3d'].prunedToDefault, true, '3D arena must flag prunedToDefault when its lastRunId was pruned');
  assert.strictEqual(afterCadRunPruned.workspaceState.arenas['3d'].taskId, 'custom', '3D arena must fall back to Custom Prompt when its lastRunId was pruned');
  assert.strictEqual(afterCadRunPruned.workspaceState.arenas['3d'].draftPrompt, '', '3D arena draftPrompt must be cleared when pruned');
  assert.strictEqual(afterCadRunPruned.workspaceState.arenas['3d'].lastRunId, null, '3D arena lastRunId must be cleared when pruned');
  assert.strictEqual(afterCadRunPruned.workspaceState.arenas['3d'].slots.length, 2, '3D arena model slots must still be preserved');
  assert.strictEqual(Boolean(afterCadRunPruned.workspaceState.arenas.text.prunedToDefault), false, 'Text arena with live run must remain untouched');
  console.log('✓ 7-Day Pruning Fallback (Case A: pruned run ID) resets affected arena to Custom Prompt while preserving model slots');

  // 11. 7-Day Pruning Fallback Rule (Case B: user logs back in after > 7 days of inactivity)
  const EIGHT_DAYS_AGO = Date.now() - (8 * 24 * 60 * 60 * 1000);
  reloadedHistory.saveUserPreferences(USER_ALICE, {
    taskId: 'coding-queue',
    slots: afterCadRunPruned.slots,
    workspaceState: afterCadRunPruned.workspaceState,
    _testUpdatedAt: EIGHT_DAYS_AGO,
  });
  const afterSevenDays = reloadedHistory.getUserPreferences(USER_ALICE);
  assert.strictEqual(afterSevenDays.taskId, 'custom', 'Top-level taskId must default to custom after 7 days');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.text.prunedToDefault, true);
  assert.strictEqual(afterSevenDays.workspaceState.arenas.text.taskId, 'custom');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.text.draftPrompt, '');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.text.lastRunId, null);
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.prunedToDefault, true);
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.packId, 'custom-image-prompt');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.scenarioId, 'custom-freeform');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.draftPrompt, '');
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.lastRunId, null);
  assert.strictEqual(afterSevenDays.workspaceState.arenas.image.slots.length, 2, 'Image arena model slots must be preserved after 7-day reset');
  console.log('✓ 7-Day Pruning Fallback (Case B: >7 days inactivity) resets all arenas to Custom Prompt while keeping model slots');

  console.log('\nALL USER PREFERENCE & CLEANUP CHECKS PASSED ✓');
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
