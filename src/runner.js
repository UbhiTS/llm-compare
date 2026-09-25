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
const { types } = require('util');

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
  // Serialise inside the sandbox (still under the vm timeout) so the host only ever
  // receives a primitive string — never a sandbox object whose getters/proxies could
  // run candidate code on the host with no timeout.
  function __ss(v) {
    try { return JSON.stringify(v); } catch (e) { try { return String(v); } catch (e2) { return '[unserializable]'; } }
  }
  for (var i = 0; i < tests.length; i++) {
    try {
      var r = ${functionName}.apply(null, tests[i].input);
      if (r && typeof r.then === 'function') {
        out.push({ ok: false, error: 'Function returned a Promise — expected a synchronous return value.' });
      } else {
        var __ok = __dq(r, tests[i].expected) === true;
        out.push({ ok: __ok, got: r, gotStr: __ok ? undefined : __ss(r) });
      }
    } catch (e) {
      var __msg; try { __msg = String((e && e.message) || e); } catch (e2) { __msg = 'threw a non-printable value'; }
      out.push({ ok: false, error: __msg });
    }
  }
  globalThis.__results = out;
  return JSON.stringify(out.map(function (o) { return { ok: o.ok === true, error: o.error == null ? null : String(o.error), gotStr: o.gotStr }; }));
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

// An exception thrown out of the vm may be a SANDBOX object (or Proxy). Reading
// `e.message` normally could fire a sandbox getter / proxy trap on the host with no
// timeout, so only accept plain own data properties from non-proxy objects.
function safeErrorMessage(e) {
  if (e === null || (typeof e !== 'object' && typeof e !== 'function')) {
    try { return String(e); } catch (_) { return 'Error'; }
  }
  if (types.isProxy(e)) return 'Error (non-inspectable value thrown)';
  const d = Object.getOwnPropertyDescriptor(e, 'message');
  if (d && 'value' in d && typeof d.value === 'string' && d.value) return d.value;
  return 'Error (non-inspectable value thrown)';
}

function runTests(code, functionName, testCases, timeoutMs = 3000) {
  // SECURITY: a null-prototype sandbox object means `this.constructor.constructor`
  // resolves to the CONTEXT's Function (no `process`), not the host's — closing the
  // classic `this.constructor.constructor('return process')()` escape to the host.
  const context = vm.createContext(Object.create(null));
  let results;
  try {
    const script = new vm.Script(buildHarness(code, functionName, testCases));
    const json = script.runInContext(context, { timeout: timeoutMs });
    // Only a primitive string crosses back; never dereference sandbox objects here.
    results = typeof json === 'string' ? JSON.parse(json) : [];
    if (!Array.isArray(results)) results = [];
  } catch (e) {
    // Compile error, timeout, or undefined function name -> everything fails.
    const msg = safeErrorMessage(e);
    results = testCases.map(() => ({ ok: false, error: msg }));
  }

  const failing = [];
  testCases.forEach((t, idx) => {
    const r = results[idx] || { ok: false, error: 'no result produced' };
    if (!r.ok) {
      failing.push({
        inputStr: t.input.map((x) => safeStr(x)).join(', '),
        gotStr: r.error ? `threw: ${r.error}` : r.gotStr,
        expectedStr: safeStr(t.expected),
        error: r.error || null,
      });
    }
  });

  const passed = results.filter((r) => r && r.ok === true).length;
  return { passed, total: testCases.length, failing };
}

module.exports = { runTests };
