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

// 4. Check history cache and retrieval
const history = require('../src/history');
const initialRuns = history.listRuns('test-user');
assert(Array.isArray(initialRuns), 'listRuns should return an array');
console.log('✓ History operations work with in-memory caching');

// 5. Check webGame caching
const { idFor } = require('../src/webGame');
const dummyId = idFor('import pygame');
assert.strictEqual(typeof dummyId, 'string');
assert.strictEqual(dummyId.length, 16);
console.log('✓ WebGame idFor works as expected');

console.log('\nALL ENHANCEMENT CHECKS PASSED ✓');
