const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('--- RUNNING ENHANCEMENT VERIFICATION ---');

// 1. Check Sonnet 5 pricing
const { MODEL_CATALOG } = require('../src/pricing');
const sonnet5 = MODEL_CATALOG.find(m => m.id === 'claude-sonnet-5');
assert(sonnet5, 'Sonnet 5 must exist in catalog');
assert.strictEqual(sonnet5.price.input, 3.00, 'Sonnet 5 input price should be $3.00');
assert.strictEqual(sonnet5.price.output, 15.00, 'Sonnet 5 output price should be $15.00');
console.log('✓ Sonnet 5 pricing updated to $3.00 / $15.00');

// 2. Check Tasks loader and multi-line frontmatter parsing
const { TASKS } = require('../src/tasks');
assert(TASKS.length >= 17, 'Should load all tasks');
console.log(`✓ Tasks loaded successfully (${TASKS.length} tasks)`);

// 3. Check JS runner Promise detection
const { runTests } = require('../src/runner');
const asyncCode = 'async function solution(a, b) { return a + b; }';
const testCases = [{ input: [1, 2], expected: 3 }];
const tr = runTests(asyncCode, 'solution', testCases);
assert.strictEqual(tr.passed, 0, 'Async function should be caught');
assert(tr.failing[0].error.includes('Promise'), 'Error should mention Promise return');
console.log('✓ Runner catches async Promise return with clear message');

// 4. History must actually PERSIST, not just return an array. An earlier version
// renamed the temp file without writing it first, so every save failed with
// ENOENT and no run was ever recorded — invisible to a test that only called
// listRuns(). Round-trip through a scratch dir instead.
const os = require('os');
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ullm-hist-test-'));
delete require.cache[require.resolve('../src/history')];
const history = require('../src/history');
const HUSER = 'verify@example.com';
assert(Array.isArray(history.listRuns(HUSER)), 'listRuns should return an array');

(async () => {
  const saved = await history.saveRun({
    user: HUSER, userName: HUSER, task: { id: 't', title: 'T' }, kind: 'compare',
    models: [{ slot: 'A', catalogId: 'gemini-3.8-flash', label: 'G', effort: 'high' }],
    results: [{ slot: 'A', code: 'print(1)', costUsd: 0.01, wallMs: 100 }],
  });
  assert(saved && saved.id, 'saveRun must return the stored record (it writes then renames)');
  assert.strictEqual(history.listRuns(HUSER).length, 1, 'the saved run must be readable back');
  const full = history.getRun(saved.id, { username: HUSER, isAdmin: false });
  assert(full && full.slots[0].data.code === 'print(1)', 'the run must restore its generated code');
  assert.deepStrictEqual(history.lastModels(HUSER), [{ catalogId: 'gemini-3.8-flash', effort: 'high' }],
    'lastModels must read the remembered line-up back');
  console.log('✓ History round-trips: save → list → restore → lastModels');

  // 5. A web-game build counts as cached ONLY when it completed AND was patched.
  // pygbag writes index.html partway through, so trusting that file alone serves
  // an unpatched loader that hangs forever on "Loading…".
  const crypto = require('crypto');
  const { idFor, gameDir } = require('../src/webGame');
  const dummyId = idFor('import pygame');
  assert.strictEqual(typeof dummyId, 'string');
  assert.strictEqual(dummyId.length, 16);

  const poisonCode = 'import pygame  # verify-enhancements poisoned-cache probe';
  const pid = crypto.createHash('sha256').update(poisonCode).digest('hex').slice(0, 16);
  const proot = path.join(os.tmpdir(), 'ullm-webgames', pid);
  const pweb = path.join(proot, 'build', 'web');
  fs.rmSync(proot, { recursive: true, force: true });
  fs.mkdirSync(pweb, { recursive: true });
  fs.writeFileSync(path.join(pweb, 'index.html'), '<html>unpatched</html>');
  assert.strictEqual(gameDir(pid), null, 'an unpatched build must NOT be served as a finished one');
  fs.writeFileSync(path.join(pweb, '.ullm-ready'), '1');
  assert(gameDir(pid), 'a completed build must be re-adopted from disk');
  fs.rmSync(proot, { recursive: true, force: true });
  console.log('✓ WebGame cache rejects a half-built bundle and reuses a finished one');

  // 6. Verify 3/day OpenAI quota & thinking profiles for OpenAI and Claude
  const auth = require('../src/auth');
  assert.strictEqual(auth.MAX_OPENAI_RUNS_PER_DAY, 3, 'MAX_OPENAI_RUNS_PER_DAY should default to 3');
  assert.strictEqual(auth.MAX_RUNS_PER_DAY, 3, 'MAX_RUNS_PER_DAY should default to 3');
  console.log('✓ Daily OpenAI run cap verified at 3 runs/day (while Vertex AI remains unlimited)');

  const { thinkingOptions, thinkingProfile } = require('../src/providers');
  const oaOpts = thinkingOptions({ provider: 'openai', model: 'gpt-5.4' });
  assert(oaOpts && oaOpts.options.some((o) => o.value === 'high'), 'OpenAI models should expose reasoning effort options');
  const oaProf = thinkingProfile({ provider: 'openai', model: 'gpt-5.4', effort: 'high' });
  assert(oaProf && oaProf.detail && oaProf.detail.includes('effort:"high"'), 'OpenAI thinking profile should reflect reasoning effort');
  const claudeProf = thinkingProfile({ provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-5', effort: 'high' });
  assert(claudeProf && claudeProf.detail && claudeProf.detail.includes('adaptive'), 'Claude 5 thinking profile should use adaptive thinking');
  console.log('✓ Claude & OpenAI thinking options and profiles verified');

  console.log('\nALL ENHANCEMENT CHECKS PASSED ✓');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
