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

// Verify documented defaults for the 3-slot Flagships lineup (Gemini 3.8 Flash, Claude Opus 5.5, GPT-6 Sol)
const gemini38Slot = modelFromCatalog('A', 'gemini-3.8-flash');
assert.strictEqual(thinkingOptions(gemini38Slot).defaultValue, 'medium', 'Gemini 3.8 Flash default thinkingLevel should be medium');
assert.strictEqual(thinkingProfile(gemini38Slot).level, 'medium', 'Gemini 3.8 Flash thinkingProfile should show medium (default)');

const claudeOpus55Slot = modelFromCatalog('B', 'claude-opus-5-5');
assert.strictEqual(thinkingOptions(claudeOpus55Slot).defaultValue, 'high', 'Claude Opus 5.5 default effort should be high');
assert.deepStrictEqual(
  thinkingOptions(claudeOpus55Slot).options.map((o) => o.value),
  ['low', 'medium', 'high', 'xhigh', 'max'],
  'Claude Opus 5.5 should expose low, medium, high, xhigh, max effort options'
);
assert.strictEqual(thinkingProfile(claudeOpus55Slot).level, 'high', 'Claude Opus 5.5 thinkingProfile should show high');

const gpt6SolSlot = modelFromCatalog('C', 'gpt-6-sol');
assert.strictEqual(thinkingOptions(gpt6SolSlot).defaultValue, 'medium', 'GPT-6 Sol default reasoning effort should be medium');
assert.strictEqual(thinkingProfile(gpt6SolSlot).level, 'medium', 'GPT-6 Sol thinkingProfile should show medium');

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

// Buggy: adds an extra 1 to every binary addition result, failing test assertions.
const BUGGY = fence(`
function compileAndExecuteVM(ast, options) {
  function fold(n) {
    if (!n || typeof n !== "object") return n;
    if (n.type === "BinaryExpr") {
      const l = fold(n.left), r = fold(n.right);
      if (l.type === "Literal" && r.type === "Literal") {
        if (n.op === "+") return { type: "Literal", value: l.value + r.value + 1 }; // BUG: + 1
        if (n.op === "*") return { type: "Literal", value: l.value * r.value };
        if (n.op === "-") return { type: "Literal", value: l.value - r.value };
      }
      return { ...n, left: l, right: r };
    }
    if (n.type === "ReturnStmt") return { ...n, value: fold(n.value) };
    if (n.type === "Program") return { ...n, body: (n.body || []).map(fold) };
    return n;
  }
  const opt = fold(ast);
  let res = null;
  if (opt.body && opt.body[0] && opt.body[0].type === "ReturnStmt") {
    res = opt.body[0].value ? opt.body[0].value.value : null;
  }
  return { status: "SUCCESS", result: res, stdout: [], stats: { gasUsed: 1, constantsFolded: 1, bytecodeLength: 1 } };
}`);

const CORRECT = fence(`
function compileAndExecuteVM(ast, options = {}) {
  const optimize = options.optimize !== false;
  let constantsFolded = 0;
  function fold(n) {
    if (!n || typeof n !== "object") return n;
    if (n.type === "BinaryExpr") {
      const l = fold(n.left), r = fold(n.right);
      if (optimize && l.type === "Literal" && r.type === "Literal" && typeof l.value === "number" && typeof r.value === "number") {
        let val;
        switch (n.op) {
          case "+": val = l.value + r.value; break;
          case "-": val = l.value - r.value; break;
          case "*": val = l.value * r.value; break;
          case "/": val = r.value !== 0 ? Math.floor(l.value / r.value) : null; break;
          case "%": val = r.value !== 0 ? l.value % r.value : null; break;
          case "==": val = l.value === r.value; break;
          case "!=": val = l.value !== r.value; break;
          case "<": val = l.value < r.value; break;
          case "<=": val = l.value <= r.value; break;
          case ">": val = l.value > r.value; break;
          case ">=": val = l.value >= r.value; break;
        }
        if (val !== undefined && val !== null) { constantsFolded++; return { type: "Literal", value: val }; }
      }
      return { ...n, left: l, right: r };
    }
    if (n.type === "IfStmt") {
      const c = fold(n.condition);
      if (optimize && c.type === "Literal" && typeof c.value === "boolean") {
        constantsFolded++;
        return c.value ? fold(n.thenBranch) : (n.elseBranch ? fold(n.elseBranch) : { type: "Empty" });
      }
      return { ...n, condition: c, thenBranch: fold(n.thenBranch), elseBranch: fold(n.elseBranch) };
    }
    if (n.type === "BlockStmt") return { ...n, statements: (n.statements || []).map(fold).filter(s => s && s.type !== "Empty") };
    if (n.type === "VarDecl") return { ...n, init: fold(n.init) };
    if (n.type === "AssignStmt") return { ...n, value: fold(n.value) };
    if (n.type === "ReturnStmt") return { ...n, value: fold(n.value) };
    if (n.type === "WhileStmt") return { ...n, condition: fold(n.condition), body: fold(n.body) };
    if (n.type === "PrintStmt") return { ...n, expr: fold(n.expr) };
    return n;
  }
  const opt = optimize ? fold(ast) : ast;
  const bytecode = [];
  function emit(op, arg) { const idx = bytecode.length; bytecode.push(arg !== undefined ? [op, arg] : [op]); return idx; }
  function compileExpr(e) {
    if (!e) return;
    if (e.type === "Literal") emit("PUSH", e.value);
    else if (e.type === "VarExpr") emit("LOAD", e.name);
    else if (e.type === "BinaryExpr") {
      compileExpr(e.left); compileExpr(e.right);
      const ops = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "==": "EQ", "!=": "NEQ", "<": "LT", "<=": "LTE", ">": "GT", ">=": "GTE" };
      if (ops[e.op]) emit(ops[e.op]);
    }
  }
  function compileStmt(s) {
    if (!s || s.type === "Empty") return;
    if (s.type === "VarDecl" || s.type === "AssignStmt") { compileExpr(s.init || s.value); emit("STORE", s.name); }
    else if (s.type === "PrintStmt") { compileExpr(s.expr); emit("PRINT"); }
    else if (s.type === "ReturnStmt") { compileExpr(s.value); emit("RET"); }
    else if (s.type === "BlockStmt") { (s.statements || []).forEach(compileStmt); }
    else if (s.type === "IfStmt") {
      compileExpr(s.condition); const jf = emit("JUMP_IF_FALSE", 0); compileStmt(s.thenBranch);
      if (s.elseBranch && s.elseBranch.type !== "Empty") {
        const jend = emit("JUMP", 0); bytecode[jf][1] = bytecode.length; compileStmt(s.elseBranch); bytecode[jend][1] = bytecode.length;
      } else bytecode[jf][1] = bytecode.length;
    } else if (s.type === "WhileStmt") {
      const start = bytecode.length; compileExpr(s.condition); const jf = emit("JUMP_IF_FALSE", 0);
      compileStmt(s.body); emit("JUMP", start); bytecode[jf][1] = bytecode.length;
    }
  }
  if (opt.type === "Program") (opt.body || []).forEach(compileStmt); else compileStmt(opt);
  emit("HALT");
  const stack = [], memory = {}, stdout = [];
  let ip = 0, gasUsed = 0, res = null;
  const maxGas = options.maxGas || 10000;
  while (ip < bytecode.length) {
    if (gasUsed >= maxGas) return { status: "OUT_OF_GAS", result: null, stdout, stats: { gasUsed, constantsFolded, bytecodeLength: bytecode.length } };
    gasUsed++;
    const [inst, arg] = bytecode[ip++];
    switch (inst) {
      case "PUSH": stack.push(arg); break;
      case "LOAD": stack.push(memory[arg] !== undefined ? memory[arg] : null); break;
      case "STORE": memory[arg] = stack.pop(); break;
      case "ADD": { const b = stack.pop(), a = stack.pop(); stack.push(a + b); break; }
      case "SUB": { const b = stack.pop(), a = stack.pop(); stack.push(a - b); break; }
      case "MUL": { const b = stack.pop(), a = stack.pop(); stack.push(a * b); break; }
      case "DIV": { const b = stack.pop(), a = stack.pop(); stack.push(b !== 0 ? Math.floor(a / b) : null); break; }
      case "MOD": { const b = stack.pop(), a = stack.pop(); stack.push(b !== 0 ? a % b : null); break; }
      case "EQ": { const b = stack.pop(), a = stack.pop(); stack.push(a === b); break; }
      case "NEQ": { const b = stack.pop(), a = stack.pop(); stack.push(a !== b); break; }
      case "LT": { const b = stack.pop(), a = stack.pop(); stack.push(a < b); break; }
      case "LTE": { const b = stack.pop(), a = stack.pop(); stack.push(a <= b); break; }
      case "GT": { const b = stack.pop(), a = stack.pop(); stack.push(a > b); break; }
      case "GTE": { const b = stack.pop(), a = stack.pop(); stack.push(a >= b); break; }
      case "PRINT": stdout.push(String(stack.pop())); break;
      case "JUMP": ip = arg; break;
      case "JUMP_IF_FALSE": { const cond = stack.pop(); if (!cond) ip = arg; break; }
      case "RET": res = stack.pop(); ip = bytecode.length; break;
      case "HALT": ip = bytecode.length; break;
    }
  }
  return { status: "SUCCESS", result: res !== null ? res : (stack.length ? stack[stack.length - 1] : null), stdout, stats: { gasUsed, constantsFolded, bytecodeLength: bytecode.length } };
}`);

// ---- 1) runner sanity ----
const task = TASKS.find((t) => t.id === 'compiler-vm');
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
