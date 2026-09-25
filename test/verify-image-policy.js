// ---------------------------------------------------------------------------
// verify-image-policy.js — offline regression tests for "no silent attachment
// stripping" (Round 7). All upstream calls are mocked; nothing here calls a real
// provider. Synthetic image fixtures only have valid headers (providers are
// mocked, so the pixels are never decoded).
//
//   - an image rejected by the provider → the SAME model is retried with a
//     scaled copy, visibly labelled — never a text-only request
//   - OpenAI's documented 30,000-patch limit is applied up front (fit copy)
//   - no copy / copy also rejected → labelled "image couldn't be sent" error
//   - text-only models → labelled "does not accept images", zero upstream calls
//   - genuine provider errors (429) surface unchanged, no image retry
//   - OpenAI /responses image 400 never falls back to /chat/completions
//   - native-PDF fallback to extracted text is visible (attachmentNotes)
//   - server-side validation of the OpenAI fit copy
// ---------------------------------------------------------------------------
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-imgpolicy-'));
process.env.APP_DATA_DIR = tmpDir;
process.env.AUTH_DATA_DIR = path.join(tmpDir, 'auth');
process.env.OPENAI_API_KEY = 'sk-test-imgpolicy';
process.env.AGENT_PLATFORM_API_KEY = 'test-imgpolicy-vertex-key';
process.env.GEMINI_API_KEY = 'test-imgpolicy-gemini-key';
process.env.GCP_PROJECT_ID = 'llm-compare-ubhits';
process.env.PROVIDER_RETRY_BASE_MS = '1';
process.env.PROVIDER_RETRY_MAX_MS = '5';

let calls = [];
let handler = null;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const raw = String(opts.body || '');
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
  calls.push({ url: u, model: body && body.model, body, raw });
  return handler(u, opts, body, raw);
};
const enc = new TextEncoder();
function sse(lines) {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < lines.length) c.enqueue(enc.encode(lines[i++] + '\n\n')); else c.close(); } });
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const sseResp = (lines) => new Response(sse(lines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const att = require('../src/attachments');
const { complete } = require('../src/providers');
const { imageDimensionsFromBuffer } = require('../src/imageInfo');
const { modelFromCatalog } = require('../src/pricing');

// ---- synthetic images with valid headers --------------------------------
function png(w, h, tail = 2048) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12); ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, crypto.randomBytes(tail)]);
}
function jpeg(w, h, tail = 2048) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, crypto.randomBytes(tail)]);
}
function webpVP8X(w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

// Tarun's case: 7952×5304 JPEG (41,334 OpenAI patches) with both browser copies.
const ORIG = jpeg(7952, 5304, 64 * 1024);
const FIT = jpeg(6764, 4512, 32 * 1024);      // ≤ 30,000 patches (official shrink formula)
const COMPACT = webpVP8X(2348, 1566);          // Claude max native size
const b64 = (b) => b.toString('base64');
function bigImage({ fit = true, compact = true } = {}) {
  const item = { name: 'landscape.jpg', mimeType: 'image/jpeg', data: b64(ORIG) };
  if (fit) { item.fitDataBase64 = b64(FIT); item.fitMimeType = 'image/jpeg'; }
  if (compact) { item.claudeDataBase64 = b64(COMPACT); item.claudeMimeType = 'image/webp'; }
  return att.normalizeAttachments([item])[0];
}
// A 9000×2000 panorama: within OpenAI's patch budget (17,766) but over Claude's 8000 px, so it carries only the compact copy.
const MID = jpeg(9000, 2000, 32 * 1024);
function midImage() {
  return att.normalizeAttachments([{ name: 'mid.jpg', mimeType: 'image/jpeg', data: b64(MID), claudeDataBase64: b64(COMPACT), claudeMimeType: 'image/webp' }])[0];
}

const imgIn = (raw) => {
  if (!raw) return null;
  if (raw.includes(b64(ORIG).slice(0, 200)) || raw.includes(b64(MID).slice(0, 200))) return 'original';
  if (raw.includes(b64(FIT).slice(0, 200))) return 'fit';
  if (raw.includes(b64(COMPACT).slice(0, 60))) return 'compact';
  if (/data:image\/|"inlineData"|"type":"image"/.test(raw)) return 'other';
  return null;
};
const OPENAI_PATCH_400 = { error: { message: 'The image you provided requires 41334 patches after processing, exceeding the limit of 30000. Please resize the image and try again.', type: 'invalid_request_error', param: 'input', code: 'invalid_value' } };
const openaiOkStream = () => sseResp([
  'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Rolling hills under a blue sky.' }),
  'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } } } }),
]);
const chatOkStream = () => sseResp([
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Rolling hills under a blue sky.' } }] }),
  'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 8 } }),
  'data: [DONE]',
]);
const geminiOkStream = () => sseResp([
  'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Rolling hills under a blue sky.' }] } }], usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 8 } }),
]);
const claudeOkStream = () => sseResp([
  'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1600 } } }),
  'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Rolling hills under a blue sky.' } }),
  'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } }),
]);

const KEYS = { claudeBearerToken: 'test-bearer' };
const callFor = (id, a, extra = {}) => {
  const c = modelFromCatalog('A', id);
  return complete({
    provider: c.provider, publisher: c.publisher, project: c.project, model: c.model, effort: c.effort,
    endpointType: c.endpointType, region: c.region, thinkingMode: c.thinkingMode,
    system: 'sys', messages: [{ role: 'user', content: 'Describe the photo.', attachments: a ? [a] : undefined }],
    keys: KEYS, ...extra,
  });
};
const ok = (m) => console.log('✓ ' + m);
let failed = false;
async function check(name, fn) {
  calls = [];
  try { await fn(); ok(name); } catch (e) { failed = true; console.error(`✗ ${name}\n  ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n  ') : e}`); }
}

(async () => {
  // ---------------------------------------------------------------- connect attempt knob
  await check('providerFetch: happy-eyeballs attempt timeout applied at load (default 2500) and clamped 250–10000 ms', async () => {
    const net = require('net');
    const pf = require('../src/providerFetch');
    if (typeof net.getDefaultAutoSelectFamilyAttemptTimeout !== 'function') return; // older Node: unchanged behaviour
    const expected = pf.connectAttemptTimeoutMs();
    assert.strictEqual(pf.CONNECT_ATTEMPT_TIMEOUT_MS, expected, 'effective value exported');
    assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), expected, 'applied process-wide at module load');
    if (!process.env.PROVIDER_CONNECT_ATTEMPT_TIMEOUT_MS) assert.strictEqual(expected, 2500);
    for (const [raw, want] of [[undefined, 2500], ['', 2500], ['abc', 2500], ['0', 250], ['-5', 250], ['100', 250], ['4000', 4000], ['99999', 10000], ['1234.6', 1235]]) {
      assert.strictEqual(pf.connectAttemptTimeoutMs(raw), want, `raw ${raw}`);
    }
    assert.strictEqual(pf.applyConnectAttemptTimeout('99999'), 10000);
    assert.strictEqual(pf.applyConnectAttemptTimeout(String(expected)), expected); // restore
  });

  // ---------------------------------------------------------------- header parsing
  await check('imageInfo: PNG/JPEG/WebP/GIF dimensions from headers; garbage → null', async () => {
    assert.deepStrictEqual(imageDimensionsFromBuffer(png(7952, 5304)), { width: 7952, height: 5304 });
    assert.deepStrictEqual(imageDimensionsFromBuffer(jpeg(4000, 3000)), { width: 4000, height: 3000 });
    assert.deepStrictEqual(imageDimensionsFromBuffer(webpVP8X(2348, 1566)), { width: 2348, height: 1566 });
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x20, 0x03, 0x58, 0x02]), crypto.randomBytes(40)]);
    assert.deepStrictEqual(imageDimensionsFromBuffer(gif), { width: 800, height: 600 });
    assert.strictEqual(imageDimensionsFromBuffer(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)])), null);
  });

  // ---------------------------------------------------------------- fit copy validation
  await check('fit copy: accepted only for >30,000-patch originals; smaller, matching bytes, within budget', async () => {
    const a = bigImage();
    assert.strictEqual(a.fitDataBase64, b64(FIT));
    assert.strictEqual(a.fitMimeType, 'image/jpeg');
    assert.strictEqual(att.inspectAttachments([{ name: 'x.jpg', mimeType: 'image/jpeg', data: b64(jpeg(7952, 5304, 70000)), fitDataBase64: b64(FIT), fitMimeType: 'image/jpeg' }])[0].fitScaled, true);
    const reject = (fields, orig = jpeg(7952, 5304, 70000)) => att.normalizeAttachments([{ name: 'r.jpg', mimeType: 'image/jpeg', data: b64(orig), ...fields }])[0];
    let r = reject({ fitDataBase64: b64(jpeg(7000, 5000, 1000)), fitMimeType: 'image/jpeg' }); // 35,000+ patches
    assert.ok(!r.fitDataBase64 && r.fitScaledRejected, 'copy over the patch budget rejected');
    r = reject({ fitDataBase64: b64(FIT), fitMimeType: 'image/png' });
    assert.ok(!r.fitDataBase64 && r.fitScaledRejected, 'MIME/bytes mismatch rejected');
    r = reject({ fitDataBase64: b64(jpeg(6764, 4512, 200000)), fitMimeType: 'image/jpeg' });
    assert.ok(!r.fitDataBase64 && r.fitScaledRejected, 'copy larger than original rejected');
    r = reject({ fitDataBase64: b64(FIT), fitMimeType: 'image/jpeg' }, jpeg(4000, 3000, 70000));
    assert.ok(!r.fitDataBase64 && !r.fitScaledRejected, 'unneeded copy (original within budget) dropped');
    const plain = att.normalizeAttachments([{ name: 'n.jpg', mimeType: 'image/jpeg', data: b64(jpeg(1024, 683)) }])[0];
    assert.ok(!('fitDataBase64' in plain) && !('fitScaledRejected' in plain) && !('claudeDataBase64' in plain), 'normal uploads keep their exact shape');
  });

  // ---------------------------------------------------------------- OpenAI up front
  await check('OpenAI: >30,000-patch original → fit copy sent up front (no 400), visible note, answer kept', async () => {
    handler = (u, o, body, raw) => (u.endsWith('/responses') ? openaiOkStream() : json(500, {}));
    const res = await callFor('gpt-6-sol', bigImage(), { onDelta: () => {} });
    assert.strictEqual(calls.length, 1, 'one upstream call');
    assert.strictEqual(imgIn(calls[0].raw), 'fit');
    assert.ok(/auto-scaled to 6764×4512 for gpt-6-sol/.test(calls[0].raw), 'text block names the scaled size');
    assert.ok(res.attachmentNotes && /image auto-scaled to 6764×4512 for gpt-6-sol \(7952×5304 px needs 41334 patches, over the 30000-patch limit\)/.test(res.attachmentNotes[0]));
    assert.ok(/Rolling hills/.test(res.text));
  });

  await check('OpenAI per-family budgets: gpt-6/5.6 30k patches; gpt-5.5 + unknown 10k / 6000 px → compact copy', async () => {
    const { openaiLimitsFor, planImages } = require('../src/imagePolicy');
    assert.deepStrictEqual(openaiLimitsFor('gpt-6-sol'), { maxPatches: 30000, maxDim: 65535 });
    assert.deepStrictEqual(openaiLimitsFor('gpt-5.6-luna'), { maxPatches: 30000, maxDim: 65535 });
    assert.deepStrictEqual(openaiLimitsFor('gpt-5.5'), { maxPatches: 10000, maxDim: 6000 });
    assert.deepStrictEqual(openaiLimitsFor('gpt-5.55-x'), { maxPatches: 10000, maxDim: 6000 }, 'unknown → conservative');
    const msgs = [{ role: 'user', content: 'x', attachments: [bigImage()] }];
    const pick = (model) => {
      const p = planImages(msgs, { provider: 'openai', model }, new Map(), null);
      const a = p.messages[0].attachments[0];
      return a.data === b64(FIT) ? 'fit' : a.data === b64(COMPACT) ? 'compact' : a.data === b64(ORIG) ? 'original' : 'other';
    };
    assert.strictEqual(pick('gpt-6-sol'), 'fit', '6764×4512 = 212×141 = 29,892 patches fits 30k');
    assert.strictEqual(pick('gpt-5.5'), 'compact', 'fit copy (29,892 patches, 6764 px) is over 10k / 6000 px');
    assert.strictEqual(pick('gpt-some-new-model'), 'compact');
  });

  // ---------------------------------------------------------------- reactive retry
  await check('OpenAI /responses image 400 → same model retried with smaller copy on /responses; never chat, never text-only', async () => {
    let n = 0;
    handler = (u, o, body, raw) => {
      if (u.endsWith('/chat/completions')) return json(500, { error: 'chat must not be called' });
      n++;
      return imgIn(raw) === 'original' ? json(400, OPENAI_PATCH_400) : openaiOkStream();
    };
    const res = await callFor('gpt-5.6-sol', midImage(), { onDelta: () => {} });
    assert.ok(!calls.some((c) => c.url.endsWith('/chat/completions')), 'no fallback to chat');
    assert.ok(calls.every((c) => imgIn(c.raw)), 'every request carried an image');
    assert.deepStrictEqual(calls.map((c) => imgIn(c.raw)), ['original', 'compact']);
    assert.ok(/image auto-scaled to 2348×1566 for gpt-5\.6-sol \(provider rejected the original: The image you provided requires 41334 patches/.test(res.attachmentNotes[0]));
  });

  await check('OpenAI non-stream chat path: image 400 → scaled retry; no allowImages:false request', async () => {
    handler = (u, o, body, raw) => (imgIn(raw) === 'original' ? json(400, OPENAI_PATCH_400) : json(200, { choices: [{ message: { content: 'Rolling hills.' } }], usage: { prompt_tokens: 900, completion_tokens: 3 } }));
    const res = await callFor('gpt-6-luna', midImage());
    assert.ok(calls.every((c) => imgIn(c.raw)), 'every request carried an image');
    assert.strictEqual(imgIn(calls[calls.length - 1].raw), 'compact');
    assert.ok(res.attachmentNotes && res.attachmentNotes.length === 1);
  });

  await check('no copy + image 400 → labelled "image couldn\'t be sent" error; never a text-only request', async () => {
    const plainBig = att.normalizeAttachments([{ name: 'mid.jpg', mimeType: 'image/jpeg', data: b64(jpeg(4000, 3000, 9000)) }])[0];
    handler = (u, o, body, raw) => (imgIn(raw) ? json(400, OPENAI_PATCH_400) : json(200, { output_text: 'text-only answer' }));
    let err = null;
    try { await callFor('gpt-6-sol', plainBig, { onDelta: () => {} }); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.strictEqual(err.code, 'IMAGE_NOT_SENT');
    assert.ok(/^image couldn't be sent to gpt-6-sol: .*41334 patches.*Not answered without it\.$/.test(err.message), err.message);
    assert.ok(calls.every((c) => imgIn(c.raw)), 'no request without the image');
  });

  await check('no copy + original over OpenAI limit → labelled error up front, zero upstream calls', async () => {
    const plainHuge = att.normalizeAttachments([{ name: 'huge.jpg', mimeType: 'image/jpeg', data: b64(jpeg(7952, 5304, 9000)) }])[0];
    handler = () => json(500, {});
    let err = null;
    try { await callFor('gpt-6-sol', plainHuge, { onDelta: () => {} }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'IMAGE_NOT_SENT' && /41334 patches, over the 30000-patch limit/.test(err.message), err && err.message);
    assert.strictEqual(calls.length, 0);
  });

  await check('Gemini (Vertex, stream): gets the ORIGINAL; image 400 → retried with copy, visible note', async () => {
    handler = () => geminiOkStream();
    let res = await callFor('gemini-3.5-flash', bigImage(), { onDelta: () => {} });
    assert.deepStrictEqual(calls.map((c) => imgIn(c.raw)), ['original']);
    assert.ok(!res.attachmentNotes);
    calls = [];
    handler = (u, o, b, raw) => (imgIn(raw) === 'original' ? json(400, { error: { code: 400, message: 'Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting', status: 'INVALID_ARGUMENT' } }) : geminiOkStream());
    res = await callFor('gemini-3.5-flash', bigImage(), { onDelta: () => {} });
    assert.deepStrictEqual(calls.map((c) => imgIn(c.raw)), ['original', 'fit']);
    assert.ok(/image auto-scaled to 6764×4512 for gemini-3\.5-flash \(provider rejected the original: Unable to process input image/.test(res.attachmentNotes[0]));
  });

  await check('Vertex MaaS (Grok, stream): image 400 → fit copy then compact copy, never allowImages:false', async () => {
    handler = (u, o, b, raw) => (imgIn(raw) !== 'compact' ? json(400, [{ error: { code: 400, message: 'Image payload too large', status: 'INVALID_ARGUMENT' } }]) : chatOkStream());
    const res = await callFor('grok-4.20-reasoning', bigImage(), { onDelta: () => {} });
    const seq = calls.map((c) => imgIn(c.raw));
    assert.ok(seq.every(Boolean), `every request carried an image: ${seq}`);
    assert.strictEqual(seq[seq.length - 1], 'compact');
    assert.ok(seq.includes('original') && seq.includes('fit'));
    assert.ok(/auto-scaled to 2348×1566 for xai\/grok-4\.20-reasoning/.test(res.attachmentNotes[0]));
  });

  await check('Claude (Agent Platform, stream): compact copy up front (>5 MB); image 400 with no smaller copy → labelled error', async () => {
    handler = () => claudeOkStream();
    const big = bigImage();
    // Force the >5 MB base64 path Claude cares about.
    const huge = { ...big, data: big.data + 'A'.repeat(6 * 1024 * 1024 - (big.data.length % 4 ? 0 : 0)) };
    let res = await callFor('claude-sonnet-5', huge, { onDelta: () => {} });
    assert.deepStrictEqual(calls.map((c) => imgIn(c.raw)), ['compact'], 'Claude never gets the fit copy');
    assert.ok(/auto-scaled to 2348×1566 for claude-sonnet-5/.test(res.attachmentNotes[0]));
    calls = [];
    handler = (u, o, b, raw) => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.0.image.source.base64: image exceeds 5 MB maximum' } });
    let err = null;
    try { await callFor('claude-sonnet-5', huge, { onDelta: () => {} }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'IMAGE_NOT_SENT' && /^image couldn't be sent to claude-sonnet-5/.test(err.message), err && err.message);
    assert.ok(calls.every((c) => imgIn(c.raw)), 'no request without the image');
  });

  await check('Claude with a small image: original, no note (unchanged)', async () => {
    handler = () => claudeOkStream();
    const small = att.normalizeAttachments([{ name: 's.jpg', mimeType: 'image/jpeg', data: b64(jpeg(1024, 683)) }])[0];
    const res = await callFor('claude-sonnet-5', small, { onDelta: () => {} });
    assert.strictEqual(calls.length, 1);
    assert.ok(!res.attachmentNotes);
  });

  // ---------------------------------------------------------------- text-only + genuine errors
  await check('text-only MaaS model → "<model> does not accept images", zero upstream calls', async () => {
    handler = () => chatOkStream();
    let err = null;
    try { await callFor('qwen3-235b-a22b-instruct-maas', midImage(), { onDelta: () => {} }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'IMAGE_UNSUPPORTED' && /does not accept images/.test(err.message), err && err.message);
    assert.strictEqual(calls.length, 0);
    // The same model still answers text-only prompts.
    const res = await callFor('qwen3-235b-a22b-instruct-maas', null, { onDelta: () => {} });
    assert.ok(/Rolling hills/.test(res.text));
  });

  await check('genuine 429 with an image → labelled upstream error, no scaled retry', async () => {
    handler = () => json(429, { error: { code: 429, message: 'Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model', status: 'RESOURCE_EXHAUSTED' } });
    let err = null;
    try { await callFor('claude-fable-5-1', midImage(), { onDelta: () => {} }); } catch (e) { err = e; }
    assert.ok(err && err.status === 429 && /rate limited/.test(err.message) && err.code !== 'IMAGE_NOT_SENT', err && err.message);
    // Claude gets the compact copy up front (9000 px > 8000 px); a quota error must not walk the ladder.
    assert.deepStrictEqual([...new Set(calls.map((c) => imgIn(c.raw)))], ['compact'], 'no further copy tried for a quota error');
  });

  // ---------------------------------------------------------------- docs + misc
  await check('native PDF rejected by Gemini → retried as extracted text, VISIBLE note; images stay inline', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nBT (Hello quarterly report) Tj ET\n%%EOF\n');
    const [p] = att.normalizeAttachments([{ name: 'r.pdf', mimeType: 'application/pdf', data: b64(pdf) }]);
    const small = att.normalizeAttachments([{ name: 's.jpg', mimeType: 'image/jpeg', data: b64(jpeg(1024, 683)) }])[0];
    handler = (u, o, b, raw) => (raw.includes('"mimeType":"application/pdf"') ? json(400, { error: { code: 400, message: 'The document has no pages.', status: 'INVALID_ARGUMENT' } }) : geminiOkStream());
    const c = modelFromCatalog('A', 'gemini-3.5-flash');
    const res = await complete({ provider: c.provider, publisher: c.publisher, model: c.model, effort: c.effort, system: 's', messages: [{ role: 'user', content: 'x', attachments: [p, small] }], onDelta: () => {} });
    assert.strictEqual(calls.length, 2);
    assert.ok(imgIn(calls[1].raw), 'image still inline on the retry');
    assert.ok(res.attachmentNotes && /PDF\/audio\/video attachment\(s\) sent to gemini-3\.5-flash as extracted text/.test(res.attachmentNotes[0]));
  });

  await check('Llama 4 Scout gets max_tokens 8192 (platform range 1–8192)', async () => {
    handler = () => chatOkStream();
    await callFor('llama-4-scout-17b-16e-maas', null, { onDelta: () => {} });
    assert.strictEqual(calls[0].body.max_tokens, 8192);
    calls = [];
    await callFor('llama-4-maverick-17b-128e-maas', null, { onDelta: () => {} });
    assert.ok(!('max_tokens' in calls[0].body), 'other MaaS models unchanged');
  });

  await check('orchestrator: attachment_note event + attachmentNotes on the slot result', async () => {
    const { runAgent } = require('../src/agent');
    handler = (u) => (u.endsWith('/responses') ? openaiOkStream() : json(500, {}));
    const events = [];
    const mc = modelFromCatalog('A', 'gpt-6-sol');
    const r = await runAgent({ modelConfig: mc, task: { prompt: 'Describe.', testCases: [], attachments: [bigImage()] }, maxIterations: 1, emit: (e) => events.push(e), keys: KEYS });
    const ev = events.find((e) => e.type === 'attachment_note');
    assert.ok(ev && ev.slot === 'A' && /auto-scaled to 6764×4512/.test(ev.message));
    assert.ok(Array.isArray(r.attachmentNotes) && r.attachmentNotes.length === 1);
    const plain = await runAgent({ modelConfig: mc, task: { prompt: 'Hi', testCases: [] }, maxIterations: 1, emit: () => {}, keys: KEYS });
    assert.ok(!('attachmentNotes' in plain), 'no field for runs without substitutions');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failed) { console.error('\nIMAGE POLICY: FAILED'); process.exit(1); }
  console.log('\nIMAGE POLICY: ALL CHECKS PASSED ✓');
})();
