const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

console.log('--- RUNNING USER PREFERENCES VERIFICATION ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ullm-pref-test-'));
process.env.APP_DATA_DIR = tmpDir;

delete require.cache[require.resolve('../src/history')];
const history = require('../src/history');

const USER_ALICE = 'alice@example.com';
const USER_BOB = 'bob@example.com';

(async () => {
  // 1. Initial state for fresh user
  const initAlice = history.getUserPreferences(USER_ALICE);
  assert.strictEqual(initAlice.prompt, '');
  assert.strictEqual(initAlice.slots, null);
  assert.strictEqual(history.lastPrompt(USER_ALICE), null);
  console.log('✓ Initial state is empty for new user');

  // 2. Save preferences for Alice
  const aliceSlots = [
    { slot: 'A', catalogId: 'gemini-3.8-flash', effort: 'high' },
    { slot: 'B', catalogId: 'claude-sonnet-5', effort: null },
    { slot: 'C', catalogId: 'grok-4.20-reasoning', effort: 'medium' },
  ];
  const aliceSaved = history.saveUserPreferences(USER_ALICE, {
    prompt: 'Analyze distributed systems consistency models.',
    taskId: 'custom',
    slots: aliceSlots,
  });
  assert(aliceSaved, 'saveUserPreferences must return preference object');
  assert.strictEqual(aliceSaved.prompt, 'Analyze distributed systems consistency models.');
  assert.strictEqual(aliceSaved.taskId, 'custom');
  assert.strictEqual(aliceSaved.slots.length, 3);
  assert.strictEqual(history.lastPrompt(USER_ALICE), 'Analyze distributed systems consistency models.');
  assert.deepStrictEqual(history.lastModels(USER_ALICE), [
    { catalogId: 'gemini-3.8-flash', effort: 'high' },
    { catalogId: 'claude-sonnet-5', effort: null },
    { catalogId: 'grok-4.20-reasoning', effort: 'medium' },
  ]);
  console.log('✓ Alice preferences saved and read back via lastPrompt & lastModels');

  // 3. User isolation: Bob has completely separate preferences
  const initBob = history.getUserPreferences(USER_BOB);
  assert.strictEqual(initBob.prompt, '', 'Bob should not inherit Alice prompt');
  assert.strictEqual(initBob.slots, null, 'Bob should not inherit Alice slots');
  assert.strictEqual(history.lastPrompt(USER_BOB), null);

  const bobSlots = [
    { slot: 'A', catalogId: 'gpt-6-sol', effort: 'low' },
    { slot: 'B', catalogId: 'kimi-k3', effort: null },
  ];
  history.saveUserPreferences(USER_BOB, {
    prompt: 'Implement a lock-free queue in C++.',
    taskId: 'coding-queue',
    slots: bobSlots,
  });

  assert.strictEqual(history.lastPrompt(USER_BOB), 'Implement a lock-free queue in C++.');
  assert.deepStrictEqual(history.lastModels(USER_BOB), [
    { catalogId: 'gpt-6-sol', effort: 'low' },
    { catalogId: 'kimi-k3', effort: null },
  ]);
  // Verify Alice remains untouched
  assert.strictEqual(history.lastPrompt(USER_ALICE), 'Analyze distributed systems consistency models.');
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

  assert.strictEqual(history.lastPrompt(USER_ALICE), 'New Alice Prompt from Run');
  assert.deepStrictEqual(history.lastModels(USER_ALICE), [
    { catalogId: 'claude-opus-5-5', effort: 'high' },
    { catalogId: 'gemini-3.8-pro', effort: 'high' },
  ]);
  console.log('✓ saveRun automatically updates lastPrompt and slot line-up');

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
  // Prompt is updated, but the 2-model line-up is preserved!
  assert.strictEqual(history.lastPrompt(USER_ALICE), 'Single rerun prompt');
  assert.strictEqual(history.lastModels(USER_ALICE).length, 2);
  console.log('✓ Single model re-run updates prompt while preserving multi-slot lineup');

  // 6. Persistence across cache reset / reload from disk
  // Wait 100ms for disk writes to finish
  await new Promise((r) => setTimeout(r, 100));
  delete require.cache[require.resolve('../src/history')];
  const reloadedHistory = require('../src/history');

  const reloadedAlice = reloadedHistory.getUserPreferences(USER_ALICE);
  assert.strictEqual(reloadedAlice.prompt, 'Single rerun prompt');
  assert.strictEqual(reloadedHistory.lastModels(USER_ALICE).length, 2);

  const reloadedBob = reloadedHistory.getUserPreferences(USER_BOB);
  assert.strictEqual(reloadedBob.prompt, 'Implement a lock-free queue in C++.');
  assert.strictEqual(reloadedBob.taskId, 'coding-queue');
  assert.strictEqual(reloadedBob.slots.length, 2);
  console.log('✓ Preferences survive module re-instantiation and reload from disk/SQLite');

  console.log('\nALL USER PREFERENCE CHECKS PASSED ✓');
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
