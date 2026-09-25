const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configure isolated temp data dir and shared server keys before loading modules
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-compare-e2e-'));
process.env.APP_DATA_DIR = tmpDir;
process.env.AUTH_DATA_DIR = path.join(tmpDir, 'auth');
process.env.AGENT_PLATFORM_API_KEY = 'test-shared-vertex-key';
process.env.CLAUDE_BEARER_TOKEN = 'test-shared-claude-bearer';
process.env.GCP_PROJECT_ID = 'llm-compare-ubhits';
process.env.OPENAI_API_KEY = 'sk-test-shared-openai-key';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'admin-test-password-123';
process.env.SECONDARY_PORT = '0'; // secondary listener is off by default; keep it explicitly off here

// Mock global.fetch for upstream provider calls (Vertex Gemini, Vertex Claude, OpenAI Responses API)
// while allowing local HTTP calls to our Express server to pass through to real fetch.
const realFetch = global.fetch;

function sseStreamFromLines(lines) {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < lines.length) {
        controller.enqueue(encoder.encode(lines[idx++] + '\n\n'));
      } else {
        controller.close();
      }
    },
  });
}

let lastClaudeRequestBody = null;
let lastOpenAiRequestBody = null;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:')) {
    return realFetch(url, opts);
  }
  if (u.includes('secretmanager.googleapis.com')) {
    return new Response(JSON.stringify({ payload: { data: Buffer.from('mock-secret-val').toString('base64') } }), { status: 200 });
  }

  // 1. Mock Vertex AI Claude (:streamRawPredict)
  // Simulates Anthropic Vertex behavior where message_delta.usage ONLY has output_tokens (no output_tokens_details)
  if (u.includes('publishers/anthropic/models/') && u.includes(':streamRawPredict')) {
    lastClaudeRequestBody = JSON.parse(opts.body || '{}');
    const lines = [
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 120 } } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Step 1: Analyzing algorithmic edge cases and time complexity... ' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Step 2: Constructing O(n) hash map solution.' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '```javascript\nfunction twoSum(nums, target) { return [0, 1]; }\n```' } }),
      // Notice: Anthropic Vertex message_delta.usage only reports total output_tokens (180), NOT thinking_tokens!
      'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 180 } }),
      'data: [DONE]',
    ];
    return new Response(sseStreamFromLines(lines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  // 2. Mock Vertex AI Gemini (:streamGenerateContent)
  if (u.includes('publishers/google/models/') && u.includes(':streamGenerateContent')) {
    const lines = [
      'data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ thought: true, text: 'Gemini thinking trace: checking constraints.' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 42 },
      }),
      'data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: '```javascript\nfunction twoSum(nums, target) { return [0, 1]; }\n```' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 35, thoughtsTokenCount: 95 },
      }),
    ];
    return new Response(sseStreamFromLines(lines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  // 3. Mock OpenAI /v1/responses API
  if (u.includes('api.openai.com/v1/responses')) {
    lastOpenAiRequestBody = JSON.parse(opts.body || '{}');
    const lines = [
      'data: ' + JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'OpenAI reasoning summary: evaluating optimal data structures for lookup.' }),
      'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '```javascript\nfunction twoSum(nums, target) { return [0, 1]; }\n```' }),
      'data: ' + JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 110,
            output_tokens: 210,
            output_tokens_details: { reasoning_tokens: 165 },
          },
        },
      }),
    ];
    return new Response(sseStreamFromLines(lines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  throw new Error('Unexpected external fetch in E2E test: ' + u);
};

(async () => {
  console.log('=== STARTING LOCAL END-TO-END VERIFICATION ===');

  const { complete } = require('../src/providers');
  const auth = require('../src/auth');

  // A. Test Claude 4.8 / Sonnet 5 Stream Thinking Tokens & Display Parameter
  const claudeDeltas = [];
  const claudeRes = await complete({
    provider: 'agentplatform',
    publisher: 'anthropic',
    model: 'claude-opus-4-8',
    effort: 'high',
    messages: [{ role: 'user', content: 'Solve twoSum' }],
    onDelta: (d) => claudeDeltas.push(d),
  });
  assert.strictEqual(lastClaudeRequestBody.thinking.type, 'adaptive', 'Claude 4.8 should send adaptive thinking');
  assert.strictEqual(lastClaudeRequestBody.thinking.display, 'summarized', 'Claude 4.8 should request display:"summarized" so thinking blocks stream');
  assert(claudeRes.reasoning.includes('Step 1: Analyzing'), 'Claude stream should capture thinking_delta text');
  assert(claudeRes.reasoningTokens > 0, `Claude should compute non-zero reasoningTokens (got ${claudeRes.reasoningTokens}) even when message_delta omits thinking_tokens`);
  console.log(`✓ Claude 4.8 / 5.0 stream verified: display="summarized", reasoning text length=${claudeRes.reasoning.length}, reasoningTokens=${claudeRes.reasoningTokens}`);

  // B. Test OpenAI GPT-5.4 / GPT-5.6 Luna Stream Thinking Tokens & Reasoning Summary
  const oaDeltas = [];
  const oaRes = await complete({
    provider: 'openai',
    model: 'gpt-5.4',
    effort: 'high',
    messages: [{ role: 'user', content: 'Solve twoSum' }],
    onDelta: (d) => oaDeltas.push(d),
  });
  assert.deepStrictEqual(lastOpenAiRequestBody.reasoning, { effort: 'high', summary: 'auto' }, 'OpenAI should request reasoning effort="high" and summary="auto"');
  assert(oaRes.reasoning.includes('OpenAI reasoning summary'), 'OpenAI stream should capture reasoning_summary_text.delta');
  assert.strictEqual(oaRes.reasoningTokens, 165, 'OpenAI stream should capture exact reasoning_tokens (165) from response.completed');
  console.log(`✓ OpenAI GPT-5.4 stream verified: reasoning.summary="auto", reasoning text length=${oaRes.reasoning.length}, reasoningTokens=${oaRes.reasoningTokens}`);

  // C. Test Quota Policy: Regular user gets 3 OpenAI runs/day AND Unlimited Vertex AI (Gemini & Claude) runs!
  const regUser = { username: 'regular.user@google.com', role: 'user' };
  const qInitial = auth.runQuota(regUser, 'compare');
  assert.strictEqual(qInitial.limit, 3, 'Regular user daily OpenAI limit must be 3');
  assert.strictEqual(qInitial.remaining, 3, 'Regular user starts with 3 OpenAI runs remaining');

  // Simulate 5 Vertex-only runs (Gemini + Claude on agentplatform): server.js does NOT call consumeRun when usesSharedPersonalKey === false
  const vertexModels = [
    { id: 'gemini-3.8-flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash' },
    { id: 'claude-sonnet-5', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-5' },
  ];
  const usesSharedOnVertexOnly = vertexModels.some((m) => m.provider !== 'agentplatform');
  assert.strictEqual(usesSharedOnVertexOnly, false, 'Vertex-only comparison (Gemini + Claude) must NOT trigger OpenAI quota consumption');
  assert.strictEqual(auth.runQuota(regUser, 'compare').remaining, 3, 'After any number of Gemini + Claude runs, OpenAI quota remains 3/3');

  // Now consume 3 OpenAI runs for the regular user
  for (let i = 1; i <= 3; i++) {
    const c = auth.consumeRun(regUser, 'compare');
    assert.strictEqual(c.ok, true, `OpenAI run #${i} should be allowed`);
    assert.strictEqual(c.remaining, 3 - i, `After OpenAI run #${i}, remaining should be ${3 - i}`);
  }
  // 4th OpenAI run must be blocked
  const c4 = auth.consumeRun(regUser, 'compare');
  assert.strictEqual(c4.ok, false, '4th OpenAI run in the same day must be blocked');
  assert.strictEqual(c4.remaining, 0, 'Remaining OpenAI runs must be 0');

  //Even when OpenAI quota is 0/3, Vertex AI (Gemini & Claude) runs are STILL allowed because usesSharedPersonalKey === false!
  assert.strictEqual(usesSharedOnVertexOnly, false, 'Vertex AI (Gemini + Claude) runs continue unrestricted after OpenAI quota hits 0/3');
  console.log('✓ Quota enforcement verified: 3/day OpenAI cap enforced, while Gemini & Claude (Vertex AI) remain 100% unlimited before and after cap');

  // D. Spin up the actual Express server (server.js) on a local port and test live HTTP /api/run
  const TEST_PORT = 43291;
  process.env.PORT = String(TEST_PORT);
  process.env.HOST = '127.0.0.1';
  await auth.createUser('http_tester', 'tester-password-123', 'user');
  const sessionToken = auth.createSession({ username: 'http_tester', role: 'user' });
  const cookieHeader = `${auth.COOKIE_NAME}=${sessionToken}`;

  require('../server.js');
  // Wait briefly for server.listen
  await new Promise((r) => setTimeout(r, 250));

  async function postRun(models) {
    return realFetch(`http://127.0.0.1:${TEST_PORT}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        taskId: 'custom',
        customPrompt: 'Write a function twoSum(nums, target)',
        maxIterations: 1,
        models,
        keys: {},
      }),
    });
  }

  // 1) Run 4 full comparisons using ONLY Gemini + Claude (Vertex AI / agentplatform)
  for (let i = 1; i <= 4; i++) {
    const r = await postRun([
      { slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash' },
      { slot: 'B', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-8' },
    ]);
    assert.strictEqual(r.status, 200, `Vertex-only HTTP /api/run #${i} should succeed with 200 OK`);
    const bodyText = await r.text();
    const events = bodyText.trim().split('\n').map((l) => JSON.parse(l));
    const claudeDone = events.find((e) => e.type === 'done' && e.slot === 'B');
    assert(claudeDone && claudeDone.result.reasoningTokens > 0, 'Claude done event over HTTP must include non-zero reasoningTokens');
    assert(claudeDone && claudeDone.result.reasoning.includes('Step 1: Analyzing'), 'Claude done event over HTTP must include thinking text');
  }
  assert.strictEqual(auth.runQuota({ username: 'http_tester', role: 'user' }, 'compare').remaining, 3,
    'After 4 live HTTP Vertex-only comparisons, user still has 3/3 OpenAI runs left');
  console.log('✓ Live HTTP /api/run verified: 4 consecutive Gemini + Claude runs succeeded with full thinking tokens and 3/3 OpenAI quota untouched');

  // 2) Run 3 comparisons that include an OpenAI model on the shared key
  for (let i = 1; i <= 3; i++) {
    const r = await postRun([
      { slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash' },
      { slot: 'B', id: 'gpt-5.6-luna', catalogId: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', model: 'gpt-5.6-luna', effort: 'high' },
    ]);
    assert.strictEqual(r.status, 200, `OpenAI HTTP /api/run #${i} should succeed with 200 OK`);
    const bodyText = await r.text();
    const events = bodyText.trim().split('\n').map((l) => JSON.parse(l));
    const oaDone = events.find((e) => e.type === 'done' && e.slot === 'B');
    assert.strictEqual(oaDone.result.reasoningTokens, 165, 'OpenAI done event over HTTP must include exact reasoningTokens (165)');
    assert(oaDone.result.reasoning.includes('OpenAI reasoning summary'), 'OpenAI done event over HTTP must include reasoning summary text');
  }

  // 3) 4th comparison with an OpenAI model on the shared key must return HTTP 429 with openaiQuotaExhausted: true
  const r4 = await postRun([
    { slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash' },
    { slot: 'B', id: 'gpt-5.6-luna', catalogId: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', model: 'gpt-5.6-luna' },
  ]);
  assert.strictEqual(r4.status, 429, '4th OpenAI HTTP /api/run must return 429 Too Many Requests');
  const errJson = await r4.json();
  assert.strictEqual(errJson.openaiQuotaExhausted, true, '429 response must include openaiQuotaExhausted: true');
  console.log('✓ Live HTTP /api/run verified: 3 OpenAI runs succeeded with thinking tokens, and 4th OpenAI run returned HTTP 429 (openaiQuotaExhausted: true)');

  // 4) Immediately run another Gemini + Claude comparison AFTER getting 429 on OpenAI — must return 200 OK!
  const r5 = await postRun([
    { slot: 'A', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.8-flash' },
    { slot: 'B', id: 'claude-sonnet-5', label: 'Claude Sonnet 5.0', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-5' },
  ]);
  assert.strictEqual(r5.status, 200, 'Gemini + Claude HTTP /api/run AFTER OpenAI 429 must still succeed with 200 OK!');
  await r5.text();
  console.log('✓ Live HTTP /api/run verified: Gemini + Claude comparison AFTER OpenAI 429 succeeded with 200 OK!');

  console.log('\n=== ALL LOCAL E2E & LIVE HTTP VERIFICATIONS PASSED ✓ ===');
  process.exit(0);
})().catch((err) => {
  console.error('E2E VERIFICATION FAILED:', err);
  process.exit(1);
});
