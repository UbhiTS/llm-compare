#!/usr/bin/env node
// ---------------------------------------------------------------------------
// run-all.js: run every test/verify-*.js (plus mock-run.js) sequentially, keep going
// after a failure, and print one summary with per-suite exit codes and runtimes
// (review 12.5: the `npm test` && chain stopped at the first failure and hid the rest;
// 12.7: no runtime was recorded).
//
//   node test/run-all.js                  # every suite
//   node test/run-all.js auth pdf         # only suites whose file name contains a word
//   TEST_SUITE_TIMEOUT_MS=600000          # per-suite cap (default 10 min)
//
// Exit code: 0 when every suite passed, 1 otherwise. Each suite spawns its own servers
// on its own fixed ports, so they must run one at a time.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_DIR = __dirname;
const ROOT = path.join(TEST_DIR, '..');
const SUITE_TIMEOUT_MS = Math.max(10000, Number(process.env.TEST_SUITE_TIMEOUT_MS) || 10 * 60 * 1000);
const filters = process.argv.slice(2).map((s) => s.toLowerCase()).filter(Boolean);

const suites = ['mock-run.js', ...fs.readdirSync(TEST_DIR).filter((f) => /^verify-.*\.js$/.test(f)).sort()]
  .filter((f) => fs.existsSync(path.join(TEST_DIR, f)))
  .filter((f) => !filters.length || filters.some((w) => f.toLowerCase().includes(w)));

function runSuite(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-4000); };
    child.stdout.on('data', (d) => { process.stdout.write(d); keep(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); keep(d); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, SUITE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ file, code: timedOut ? 'timeout' : (code == null ? `signal ${signal}` : code), ms: Date.now() - t0, tail });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ file, code: 'spawn error: ' + e.message, ms: Date.now() - t0, tail }); });
  });
}

(async () => {
  if (!suites.length) { console.error('run-all: no suites matched', filters); process.exit(1); }
  const results = [];
  const started = Date.now();
  for (const file of suites) {
    console.log(`\n${'='.repeat(78)}\n== ${file}\n${'='.repeat(78)}`);
    results.push(await runSuite(file));
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${'='.repeat(78)}\n== run-all summary (${results.length} suites, ${((Date.now() - started) / 1000).toFixed(1)}s)\n${'='.repeat(78)}`);
  for (const r of results) {
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.file.padEnd(46)} exit=${String(r.code).padEnd(8)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} suite(s) failed: ${failed.map((r) => r.file).join(', ')}`);
    for (const r of failed) {
      const lines = r.tail.split('\n').filter((l) => /✗|FAILED|AssertionError|Error:|failed/.test(l)).slice(-6);
      if (lines.length) console.log(`  ${r.file}:\n    ${lines.join('\n    ')}`);
    }
  } else {
    console.log('\nall suites passed');
  }
  process.exit(failed.length ? 1 : 0);
})();
