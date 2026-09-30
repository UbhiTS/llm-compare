// ---------------------------------------------------------------------------
// verify-pdf-export.js — unit + HTTP integration verification for PDF export.
// ---------------------------------------------------------------------------

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { buildComparisonPdf, computeReportData, pdfFilename, toWinAnsi } = require('../src/pdfReport');
const { inspectAttachmentsAsync } = require('../src/attachments');

console.log('--- RUNNING PDF EXPORT VERIFICATION ---');

// Helper to decompress all FlateDecode streams in a PDF buffer and concatenate
// their raw PDF operator / text content so we can assert on rendered strings.
function decompressPdfStreams(pdfBuf) {
  const raw = pdfBuf.toString('latin1');
  const streams = [];
  let pos = 0;
  while (true) {
    const sIdx = raw.indexOf('stream\n', pos);
    if (sIdx < 0) break;
    const dataStart = sIdx + 'stream\n'.length;
    const eIdx = raw.indexOf('\nendstream', dataStart);
    if (eIdx < 0) break;
    const compressed = pdfBuf.subarray(dataStart, eIdx);
    const inflated = zlib.inflateSync(compressed).toString('latin1')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    streams.push(inflated);
    pos = eIdx + 10;
  }
  return streams;
}

(async () => {
  // 1. Verify Unicode-to-WinAnsi normalization
  const normSample = toWinAnsi('Passed ✓ · Failed ✗ · Next → ▸ ★ ≥ ≤ ≠ — “quoted”');
  assert(normSample.includes('[PASS]'), '✓ should normalize to [PASS]');
  assert(normSample.includes('[FAIL]'), '✗ should normalize to [FAIL]');
  assert(normSample.includes('->'), '→ should normalize to ->');
  assert(normSample.includes('>='), '≥ should normalize to >=');
  console.log('✓ Unicode-to-WinAnsi text normalization verified');

  // 2. Build a comprehensive graded + judge multi-model report
  const samplePayload = {
    taskId: 'lis',
    taskTitle: 'Longest Increasing Subsequence',
    prompt: 'Given an integer array nums, return the length of the longest strictly increasing subsequence in O(n log n) time.',
    language: 'javascript',
    at: Date.UTC(2026, 8, 30, 17, 0, 0),
    models: [
      { slot: 'A', label: 'Gemini 3.8 Flash', provider: 'agentplatform', model: 'gemini-3.8-flash-preview', effort: 'high' },
      { slot: 'B', label: 'Claude Opus 5.5', provider: 'agentplatform', model: 'claude-opus-5-5', effort: 'high' },
      { slot: 'C', label: 'GPT-6 Sol', provider: 'openai', model: 'gpt-6-sol', effort: 'medium' },
    ],
    results: {
      A: {
        slot: 'A',
        label: 'Gemini 3.8 Flash',
        provider: 'agentplatform',
        model: 'gemini-3.8-flash-preview',
        thinking: { label: 'High', detail: 'thinking_level=HIGH' },
        passed: 10,
        total: 10,
        solved: true,
        correctness: 100,
        promptTokens: 320,
        completionTokens: 640,
        reasoningTokens: 240,
        totalTokens: 960,
        wallMs: 1420,
        tokensPerSec: 450.7,
        costUsd: 0.0012,
        reasoning: 'We can maintain a tails array where tails[i] stores the smallest tail of all increasing subsequences of length i+1 and binary search each element.',
        code: Array.from({ length: 75 }, (_, i) => `// Line ${i + 1}: O(n log n) binary search step\nfunction lengthOfLIS_${i}(nums) { return nums.length; }`).join('\n'),
      },
      B: {
        slot: 'B',
        label: 'Claude Opus 5.5',
        provider: 'agentplatform',
        model: 'claude-opus-5-5',
        thinking: { label: 'High', detail: 'budget_tokens=16384' },
        passed: 10,
        total: 10,
        solved: true,
        correctness: 100,
        promptTokens: 340,
        completionTokens: 890,
        reasoningTokens: 410,
        totalTokens: 1230,
        wallMs: 3150,
        tokensPerSec: 282.5,
        costUsd: 0.0185,
        reasoning: 'Analyzing patience sorting and binary search invariants for strictly increasing subsequences.',
        code: 'function lengthOfLIS(nums) {\n  const tails = [];\n  for (const x of nums) {\n    let l = 0, r = tails.length;\n    while (l < r) {\n      const m = (l + r) >> 1;\n      if (tails[m] < x) l = m + 1; else r = m;\n    }\n    tails[l] = x;\n  }\n  return tails.length;\n}',
      },
      C: {
        slot: 'C',
        label: 'GPT-6 Sol',
        provider: 'openai',
        model: 'gpt-6-sol',
        thinking: { label: 'Medium', detail: 'reasoning.effort=medium' },
        passed: 9,
        total: 10,
        solved: false,
        correctness: 90,
        promptTokens: 310,
        completionTokens: 520,
        reasoningTokens: 180,
        totalTokens: 830,
        wallMs: 2280,
        tokensPerSec: 228.1,
        costUsd: 0.0064,
        reasoning: '',
        code: 'function lengthOfLIS(nums) { return nums.length ? 1 : 0; }',
      },
    },
    execOutputs: {
      A: '✓ 10 / 10 hidden test cases passed in 14ms',
    },
    judge: {
      judge: { label: 'Gemini 3.1 Pro', model: 'gemini-3.1-pro-preview', provider: 'agentplatform' },
      criteria: [
        { key: 'completeness', label: 'Completeness' },
        { key: 'accuracy', label: 'Accuracy' },
        { key: 'structure', label: 'Structure' },
        { key: 'actionability', label: 'Actionability' },
      ],
      blindOrder: ['A=Gemini 3.8 Flash', 'B=Claude Opus 5.5', 'C=GPT-6 Sol'],
      winnerSlot: 'A',
      why: 'Response A provided optimal O(n log n) binary search with clear edge-case handling and highest speed.',
      results: [
        { slot: 'A', label: 'Gemini 3.8 Flash', blindId: 'A', overall: 9.8, scores: { completeness: 10, accuracy: 10, structure: 9, actionability: 10 }, note: 'Optimal patience-sorting binary search implementation.' },
        { slot: 'B', label: 'Claude Opus 5.5', blindId: 'B', overall: 9.3, scores: { completeness: 9, accuracy: 10, structure: 9, actionability: 9 }, note: 'Clean solution with thorough comments.' },
        { slot: 'C', label: 'GPT-6 Sol', blindId: 'C', overall: 7.5, scores: { completeness: 7, accuracy: 8, structure: 8, actionability: 7 }, note: 'Missed one duplicate-element edge case.' },
      ],
    },
  };

  const reportData = computeReportData(samplePayload);
  assert.strictEqual(reportData.winner.slot, 'A', 'Gemini 3.8 Flash should be best balanced winner');
  assert.strictEqual(reportData.cheapest.slot, 'A');
  assert.strictEqual(reportData.fastest.slot, 'A');
  assert.strictEqual(reportData.slots.length, 3);
  console.log('✓ computeReportData calculates balanced scores, rankings, and takeaways accurately');

  const pdfBuf = buildComparisonPdf(samplePayload);
  assert(Buffer.isBuffer(pdfBuf), 'buildComparisonPdf must return a Buffer');
  assert(pdfBuf.length > 4000, `PDF buffer should be substantial (got ${pdfBuf.length} bytes)`);
  assert.strictEqual(pdfBuf.subarray(0, 8).toString('latin1'), '%PDF-1.4', 'Must start with %PDF-1.4 header');
  assert(pdfBuf.toString('latin1').trimEnd().endsWith('%%EOF'), 'Must end with %%EOF trailer');

  const streams = decompressPdfStreams(pdfBuf);
  assert(streams.length >= 2, `Expected multi-page PDF (>=2 pages) for 75-line code + 3 models, got ${streams.length} pages`);
  const allContent = streams.join('\n');

  // Verify all 4 major sections and charts are present in the decompressed content stream
  const expectedSnippets = [
    'LLM Compare',
    'Executive Summary',
    'Longest Increasing Subsequence',
    'BEST BALANCED MODEL: GEMINI 3.8 FLASH',
    'Visual Comparison Graphs',
    'Overall Balanced Score',
    'Cost per Task (USD)',
    'Wall Time / Latency',
    'Throughput (Tokens / sec)',
    'Correctness (Hidden Tests Passed)',
    'Token Usage Breakdown',
    'Multi-Axis Efficiency Profile',
    'Full Metrics Table & Evaluation',
    'BLIND LLM-AS-JUDGE EVALUATION',
    'Detailed Per-Model Results',
    'Thinking / Reasoning Trace',
    'Execution / Verification Output',
    'lengthOfLIS',
    'Page 1 of ' + streams.length,
  ];
  for (const snippet of expectedSnippets) {
    assert(allContent.includes(snippet), `Expected PDF content stream to include "${snippet}"`);
  }
  console.log(`✓ Generated ${streams.length}-page PDF (${pdfBuf.length} bytes) with all 4 sections, vector charts, judge table & paginated code`);

  // 3. Verify that llm-compare's own PDF attachment inspector can parse our generated PDF
  const inspected = await inspectAttachmentsAsync([
    {
      name: pdfFilename(samplePayload.taskTitle, samplePayload.at),
      mimeType: 'application/pdf',
      data: pdfBuf.toString('base64'),
    },
  ]);
  assert.strictEqual(inspected.length, 1);
  assert.strictEqual(inspected[0].kind, 'pdf');
  assert.strictEqual(inspected[0].pageCount, streams.length);
  assert(inspected[0].extractedChars > 500, 'Generated PDF must have extractable text via attachments.js');
  console.log(`✓ Generated PDF verified readable by attachments.js PDF parser (${inspected[0].pageCount} pages, ${inspected[0].extractedChars} chars extracted)`);

  // 4. Verify HTTP endpoints: POST /api/export-pdf and GET /api/history/:id/pdf
  const PORT = 18891;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-pdf-test-'));
  process.env.APP_DATA_DIR = tmp;
  delete require.cache[require.resolve('../src/history')];
  const history = require('../src/history');
  const savedItem = await history.saveRun({
    user: 'ubhi@google.com',
    userName: 'ubhi@google.com',
    task: { id: 'lis', title: 'Longest Increasing Subsequence', prompt: samplePayload.prompt },
    models: samplePayload.models,
    results: Object.values(samplePayload.results),
    kind: 'compare',
  });
  assert(savedItem && savedItem.id, 'history.saveRun should return saved metadata with id');
  await new Promise((r) => setTimeout(r, 320)); // allow snapshot flush

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      APP_DATA_DIR: tmp,
      AUTH_DATA_DIR: path.join(tmp, 'auth'),
      ENABLE_WEB_GAME: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { srv.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', stop);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, 'Test server failed to start');

  // 4A. POST /api/export-pdf with empty payload -> 400
  const emptyResp = await fetch(`http://127.0.0.1:${PORT}/api/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 'custom', results: {} }),
  });
  assert.strictEqual(emptyResp.status, 400, 'Empty results should return 400');

  // 4B. POST /api/export-pdf with comparison payload -> 200 binary PDF
  const postResp = await fetch(`http://127.0.0.1:${PORT}/api/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(samplePayload),
  });
  assert.strictEqual(postResp.status, 200, 'POST /api/export-pdf should return 200');
  assert.strictEqual(postResp.headers.get('content-type'), 'application/pdf');
  assert(/attachment;\s*filename="llm-compare-longest-increasing-subsequence-.*\.pdf"/i.test(postResp.headers.get('content-disposition') || ''));
  const httpPdfBuf = Buffer.from(await postResp.arrayBuffer());
  assert.strictEqual(httpPdfBuf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert(httpPdfBuf.toString('latin1').trimEnd().endsWith('%%EOF'));
  console.log(`✓ POST /api/export-pdf returned valid binary PDF (${httpPdfBuf.length} bytes)`);

  // 4C. GET /api/history/:id/pdf on saved run -> 200 binary PDF, and unknown ID -> 404
  const histPdfResp = await fetch(`http://127.0.0.1:${PORT}/api/history/${encodeURIComponent(savedItem.id)}/pdf`);
  assert.strictEqual(histPdfResp.status, 200, 'Saved history run PDF export should return 200');
  assert.strictEqual(histPdfResp.headers.get('content-type'), 'application/pdf');
  const histPdfBuf = Buffer.from(await histPdfResp.arrayBuffer());
  assert.strictEqual(histPdfBuf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert(histPdfBuf.toString('latin1').trimEnd().endsWith('%%EOF'));
  console.log(`✓ GET /api/history/:id/pdf returned valid binary PDF (${histPdfBuf.length} bytes)`);

  const notFoundPdf = await fetch(`http://127.0.0.1:${PORT}/api/history/nonexistent-id-123/pdf`);
  assert.strictEqual(notFoundPdf.status, 404, 'Unknown history ID should return 404');
  console.log('✓ GET /api/history/:id/pdf returns 404 for unknown run ID');

  stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('\nALL PDF EXPORT CHECKS PASSED ✓');
  process.exit(0);
})().catch((e) => {
  console.error('\nPDF EXPORT VERIFICATION FAILED:', e);
  process.exit(1);
});
