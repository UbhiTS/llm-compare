// ---------------------------------------------------------------------------
// Verification without API keys.
//
// We mock global.fetch to emulate the Gemini endpoint: it returns a BUGGY
// solution on the first attempt and a CORRECT one once it sees the "failed
// these hidden test cases" fix prompt. This exercises providers.js + agent.js +
// runner.js + orchestrator.js + pricing end-to-end and checks:
//   - the runner correctly grades buggy vs correct code,
//   - the agent detects failure, iterates, and converges,
//   - tokens/latency/cost accumulate and compute correctly,
//   - the orchestrator runs slots concurrently and emits a clean event stream.
// ---------------------------------------------------------------------------

process.env.GEMINI_API_KEY = 'mock-key';

const assert = require('assert');
const { runTests } = require('../src/runner');
const { runComparison } = require('../src/orchestrator');
const { MODEL_CATALOG, DEFAULT_MODELS, modelFromCatalog, resolveModels } = require('../src/pricing');
const { complete, thinkingOptions, thinkingProfile } = require('../src/providers');
const { TASKS } = require('../src/tasks');

const fence = (code) => '```javascript\n' + code + '\n```';

// ---- 0) server-authoritative catalog + thinking metadata ----
assert.deepStrictEqual(
  DEFAULT_MODELS.map((m) => ({ slot: m.slot, catalogId: m.catalogId })),
  [
    { slot: 'A', catalogId: 'gemini-3.8-flash' },
    { slot: 'B', catalogId: 'claude-opus-5-5' },
    { slot: 'C', catalogId: 'gpt-6-sol' },
  ],
  'default slots should use the 3-model verified frontier lineup in the configured order'
);

const gemini37 = MODEL_CATALOG.find((m) => m.id === 'gemini-3.7-flash');
assert(gemini37, 'Gemini 3.7 Flash should be present in the model catalog');
assert.deepStrictEqual(gemini37.price, { input: 0.75, output: 3.75 }, 'Gemini 3.7 Flash introductory pricing');
assert.deepStrictEqual(
  MODEL_CATALOG.find((m) => m.id === 'gemini-3.6-flash').price,
  { input: 0.75, output: 3.75 },
  'Gemini 3.6 Flash should use the same introductory pricing'
);

const gemini37Slot = modelFromCatalog('A', 'gemini-3.7-flash');
assert.strictEqual(gemini37Slot.model, 'gemini-3.7-flash', 'Gemini 3.7 Flash should use its stable API model id');
assert.deepStrictEqual(
  thinkingOptions(gemini37Slot).options.map((o) => o.value),
  ['low', 'medium', 'high'],
  'Gemini 3.7 Flash should expose exactly its supported thinking levels'
);
assert.strictEqual(thinkingProfile(gemini37Slot).level, 'medium', 'Gemini 3.7 Flash should show its medium default');

const resolvedGemini37 = resolveModels([{
  slot: 'A', catalogId: 'gemini-3.7-flash', model: 'tampered-model', provider: 'tampered-provider',
  price: { input: 0, output: 0 }, effort: 'high',
}])[0];
assert.strictEqual(resolvedGemini37.model, 'gemini-3.7-flash', 'catalog resolution should restore the real model id');
assert.strictEqual(resolvedGemini37.provider, 'agentplatform', 'catalog resolution should restore the real provider');
assert.deepStrictEqual(resolvedGemini37.price, { input: 0.75, output: 3.75 }, 'catalog resolution should restore the real price');
assert.strictEqual(resolvedGemini37.effort, 'high', 'catalog resolution should retain a supported thinking level');
assert.strictEqual(
  resolveModels([{ slot: 'A', catalogId: 'gemini-3.7-flash', effort: 'minimal' }])[0].effort,
  undefined,
  'catalog resolution should reject unsupported minimal thinking'
);

// Buggy: frees a room only when a meeting ENDS STRICTLY before the next starts,
// so touching intervals ([1,5] & [5,9]) are wrongly counted as overlapping.
const BUGGY = fence(`
function minMeetingRooms(intervals){
  if(!intervals || intervals.length===0) return 0;
  const n = intervals.length;
  const starts = intervals.map(i=>i[0]).sort((a,b)=>a-b);
  const ends   = intervals.map(i=>i[1]).sort((a,b)=>a-b);
  let rooms=0, max=0, e=0;
  for(let s=0;s<n;s++){
    while(e<n && ends[e] < starts[s]){ e++; rooms--; }   // BUG: should be <=
    rooms++; if(rooms>max) max=rooms;
  }
  return max;
}`);

const CORRECT = fence(`
function minMeetingRooms(intervals){
  if(!intervals || intervals.length===0) return 0;
  const n = intervals.length;
  const starts = intervals.map(i=>i[0]).sort((a,b)=>a-b);
  const ends   = intervals.map(i=>i[1]).sort((a,b)=>a-b);
  let rooms=0, max=0, e=0;
  for(let s=0;s<n;s++){
    while(e<n && ends[e] <= starts[s]){ e++; rooms--; }  // touching frees room
    rooms++; if(rooms>max) max=rooms;
  }
  return max;
}`);

// ---- 1) runner sanity ----
const task = TASKS.find((t) => t.id === 'meeting-rooms');
function strip(f) { return f.replace(/```(?:javascript)?/g, '').replace(/```/g, '').trim(); }
const buggyRes = runTests(strip(BUGGY), task.functionName, task.testCases);
const correctRes = runTests(strip(CORRECT), task.functionName, task.testCases);
console.log(`runner: buggy ${buggyRes.passed}/${buggyRes.total}, correct ${correctRes.passed}/${correctRes.total}`);
assert(correctRes.passed === task.testCases.length, 'correct solution should pass all tests');
assert(buggyRes.passed < task.testCases.length, 'buggy solution should fail at least one test');
assert(buggyRes.failing.length > 0 && buggyRes.failing[0].expectedStr, 'failing details should be populated');

// ---- 2) mock the network ----
let lastRequestBody;
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  lastRequestBody = body;
  const text = JSON.stringify(body.contents);
  const isFix = text.includes('failed these hidden test cases');
  const reply = isFix ? CORRECT : BUGGY;
  await new Promise((r) => setTimeout(r, 15)); // simulate latency
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: reply }] } }],
      usageMetadata: { promptTokenCount: 350, candidatesTokenCount: 180 },
    }),
  };
};

// ---- 3) run three slots in parallel through the orchestrator ----
const models = [
  { slot: 'A', label: 'Gemini 3.5 Flash',  provider: 'gemini', model: 'gemini-3.5-flash',  price: { input: 0.10, output: 0.40 } },
  { slot: 'B', label: 'GPT-5',             provider: 'gemini', model: 'mock-premium-1',     price: { input: 2.50, output: 10.00 } },
  { slot: 'C', label: 'Claude Sonnet 4.5', provider: 'gemini', model: 'mock-premium-2',     price: { input: 3.00, output: 15.00 } },
];

(async () => {
  // The 3.7 migration contract rejects deprecated sampling parameters.
  await complete({
    provider: 'agentplatform', publisher: 'google', model: 'gemini-3.7-flash',
    messages: [{ role: 'user', content: 'Return a test response.' }],
  });
  assert.strictEqual(lastRequestBody.generationConfig.temperature, undefined, 'Gemini 3.7 Flash request should omit temperature');

  const events = [];
  const results = await runComparison({
    task, models, maxIterations: 4, emit: (e) => events.push(e),
  });

  const types = events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  console.log('events:', JSON.stringify(types));

  assert(events[0].type === 'start', 'first event is start');
  assert(types.iteration >= 6, 'expected >= 2 rounds x 3 slots of iteration events');
  assert(types.done === 3, 'all three slots should finish');
  assert(events[events.length - 1].type === 'all_done', 'last event is all_done');

  results.forEach((r) => {
    assert(!r.error, `${r.label} should not error`);
    assert(r.solved === true, `${r.label} should converge to a passing solution`);
    assert(r.correctness === 100, `${r.label} final correctness should be 100%`);
    assert(r.iterations === 2, `${r.label} should need exactly 2 rounds (buggy then fixed)`);
    // 2 rounds * (350 in + 180 out)
    assert(r.promptTokens === 700 && r.completionTokens === 360, `${r.label} token totals`);
    const expectedCost =
      (r.price.input * 700) / 1e6 + (r.price.output * 360) / 1e6;
    assert(Math.abs(r.costUsd - +expectedCost.toFixed(6)) < 1e-9, `${r.label} cost math`);
    console.log(
      `  ${r.label.padEnd(20)} solved=${r.solved} rounds=${r.iterations} ` +
      `tokens=${r.totalTokens} cost=$${r.costUsd.toFixed(5)} wall=${r.wallMs}ms`
    );
  });

  // The configured-cheap model (slot A) must come out cheapest given identical tokens.
  const cheapest = [...results].sort((a, b) => a.costUsd - b.costUsd)[0];
  assert(cheapest.slot === 'A', 'cheapest should be the low-priced Flash slot');
  const ratio = results.find(r=>r.slot==='C').costUsd / results.find(r=>r.slot==='A').costUsd;
  console.log(`  cost ratio (premium C / Flash A) = ${ratio.toFixed(1)}x`);

  console.log('\nALL CHECKS PASSED ✓');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
