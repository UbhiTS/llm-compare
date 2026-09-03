// ---------------------------------------------------------------------------
// Sandboxed JavaScript test runner.
//
// Candidate code (produced by an LLM) is compiled and executed inside Node's
// `vm` module with a hard timeout, so an infinite loop or throw can't hang the
// server. This is the "tool" half of the agent loop: it runs the generated
// function against the task's test cases and reports pass/fail + failures.
//
// NOTE: `vm` is isolation, not a hardened security sandbox. This is intended
// for a local demo where you control the tasks. Don't point it at untrusted
// task definitions.
// ---------------------------------------------------------------------------

const vm = require('vm');

function buildHarness(code, functionName, testCases) {
  // A self-contained deep-equality check is injected so we don't depend on
  // anything outside the vm context.
  return `
${code}
;(function () {
  function __dq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
      var aArr = Array.isArray(a), bArr = Array.isArray(b);
      if (aArr !== bArr) return false;
      if (aArr) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!__dq(a[i], b[i])) return false;
        return true;
      }
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var k = 0; k < ka.length; k++) if (!__dq(a[ka[k]], b[ka[k]])) return false;
      return true;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      return a === b || (Number.isNaN(a) && Number.isNaN(b));
    }
    return false;
  }
  var tests = ${JSON.stringify(testCases)};
  var out = [];
  for (var i = 0; i < tests.length; i++) {
    try {
      var r = ${functionName}.apply(null, tests[i].input);
      if (r && typeof r.then === 'function') {
        out.push({ ok: false, error: 'Function returned a Promise — expected a synchronous return value.' });
      } else {
        out.push({ ok: __dq(r, tests[i].expected), got: r });
      }
    } catch (e) {
      out.push({ ok: false, error: String((e && e.message) || e) });
    }
  }
  globalThis.__results = out;
})();
`;
}

function safeStr(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function runTests(code, functionName, testCases, timeoutMs = 3000) {
  const context = vm.createContext({});
  let results;
  try {
    const script = new vm.Script(buildHarness(code, functionName, testCases));
    script.runInContext(context, { timeout: timeoutMs });
    results = context.__results || [];
  } catch (e) {
    // Compile error, timeout, or undefined function name -> everything fails.
    const msg = String((e && e.message) || e);
    results = testCases.map(() => ({ ok: false, error: msg }));
  }

  const failing = [];
  testCases.forEach((t, idx) => {
    const r = results[idx] || { ok: false, error: 'no result produced' };
    if (!r.ok) {
      failing.push({
        inputStr: t.input.map((x) => safeStr(x)).join(', '),
        gotStr: r.error ? `threw: ${r.error}` : safeStr(r.got),
        expectedStr: safeStr(t.expected),
        error: r.error || null,
      });
    }
  });

  const passed = results.filter((r) => r && r.ok).length;
  return { passed, total: testCases.length, failing };
}

module.exports = { runTests };
