// ---------------------------------------------------------------------------
// verify-claude-scaled.js: offline tests for the Claude-only scaled image copy
// (claudeDataBase64 / claudeMimeType) in src/attachments.js:
//   - an image over Anthropic's 5 MB base64 cap + a valid scaled copy goes to
//     Claude as the copy; Gemini / OpenAI keep getting the original bytes
//   - cache byte accounting includes the copy; one cache entry per file
//     (SHA-256 key only), legacy sha1 refs still resolve
//   - bad / mismatched / oversized / non-image copies are ignored and Claude
//     falls back to the existing "too large" text note
//   - copy for a small original or a non-image is dropped
//   - cached-reference path picks up a copy the cache entry lacked
//   - browser copy size math (claudeNativeScale in public/app.js)
// No network, no server.
// ---------------------------------------------------------------------------
const assert = require('assert');
const crypto = require('crypto');
const att = require('../src/attachments');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const CAP = att.CLAUDE_MAX_IMAGE_BASE64_CHARS;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Original "PNG" whose base64 is over the cap (~6 MB base64). Random tail keeps
// each call unique so tests don't share cache entries.
const bigPng = () => Buffer.concat([PNG_SIG, crypto.randomBytes(Math.ceil(CAP * 0.75) + 600 * 1024)]);
const smallPng = () => Buffer.concat([PNG_SIG, crypto.randomBytes(64 * 1024)]);
const webpCopy = (n = 200 * 1024) => {
  const body = crypto.randomBytes(n);
  const hdr = Buffer.alloc(12);
  hdr.write('RIFF', 0, 'latin1'); hdr.writeUInt32LE(n + 4, 4); hdr.write('WEBP', 8, 'latin1');
  return Buffer.concat([hdr, body]);
};
const jpegCopy = (n = 150 * 1024) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

function norm(item) { return att.normalizeAttachments([item])[0]; }
function claudeImageBlocks(blocks) { return blocks.filter((b) => b.type === 'image'); }
function claudeText(blocks) { return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); }

// 1. Large image + valid copy: Claude gets the copy, everyone else the original.
check('large image: Claude gets scaled WebP copy, Gemini/OpenAI get original', () => {
  const orig = bigPng();
  const copy = webpCopy();
  const a = norm({ name: 'photo.png', mimeType: 'image/png', data: orig.toString('base64'), claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/webp' });
  assert.ok(a.data.length > CAP, 'original base64 must exceed cap');
  assert.strictEqual(a.claudeMimeType, 'image/webp');
  assert.strictEqual(a.claudeDataBase64, copy.toString('base64'));

  const cl = att.toClaudeContent('describe', [a]);
  const imgs = claudeImageBlocks(cl);
  assert.strictEqual(imgs.length, 1, 'one Claude image block');
  assert.strictEqual(imgs[0].source.media_type, 'image/webp');
  assert.strictEqual(imgs[0].source.data, copy.toString('base64'));
  assert.ok(!/exceeds|skipped binary image/i.test(claudeText(cl)), 'no too-large note when copy used');

  const gem = att.toGeminiParts('describe', [a]);
  const inl = gem.filter((p) => p.inlineData);
  assert.strictEqual(inl.length, 1);
  assert.strictEqual(inl[0].inlineData.mimeType, 'image/png');
  assert.strictEqual(inl[0].inlineData.data, orig.toString('base64'));

  const oaR = att.toOpenAIResponsesContent('describe', [a]).find((c) => c.type === 'input_image');
  assert.strictEqual(oaR.image_url, `data:image/png;base64,${orig.toString('base64')}`);
  const oaC = att.toOpenAIChatContent('describe', [a]).find((c) => c.type === 'image_url');
  assert.strictEqual(oaC.image_url.url, `data:image/png;base64,${orig.toString('base64')}`);

  const ins = att.inspectAttachments([{ name: 'photo.png', mimeType: 'image/png', data: orig.toString('base64'), claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/webp' }])[0];
  assert.strictEqual(ins.claudeScaled, true);
  assert.ok(!('claudeDataBase64' in ins), 'inspection never echoes the copy bytes');
});

check('large image: JPEG copy and image/jpg alias accepted', () => {
  const copy = jpegCopy();
  const a = norm({ name: 'p2.png', mimeType: 'image/png', data: bigPng().toString('base64'), claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/jpg' });
  assert.strictEqual(a.claudeMimeType, 'image/jpeg');
  assert.strictEqual(claudeImageBlocks(att.toClaudeContent('x', [a]))[0].source.media_type, 'image/jpeg');
});

// 2. Cache accounting + single entry + legacy sha1.
check('cache: bytes include the copy, one SHA-256 entry, legacy sha1 ref resolves', () => {
  const orig = bigPng();
  const copy = webpCopy(300 * 1024);
  const before = att._cacheStats();
  const a = norm({ name: 'c.png', mimeType: 'image/png', data: orig.toString('base64'), claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/webp' });
  const after = att._cacheStats();
  assert.strictEqual(after.entries - before.entries, 1, 'exactly one new cache entry');
  assert.ok(after.keys.includes(sha256(orig)), 'keyed by sha256');
  assert.ok(!after.keys.some((k) => /^[0-9a-f]{40}$/.test(k)), 'no 40-hex (sha1) cache keys');
  assert.strictEqual(after.bytes - before.bytes, orig.toString('base64').length + copy.toString('base64').length, 'bytes = original + copy');
  assert.strictEqual(a.sha1, sha1(orig));

  const viaSha1 = norm({ sha1: sha1(orig), name: 'c.png', mimeType: 'image/png' });
  assert.strictEqual(viaSha1.sha256, sha256(orig));
  assert.strictEqual(viaSha1.claudeDataBase64, copy.toString('base64'), 'sha1 ref keeps the copy');
  const viaSha256 = norm({ sha256: sha256(orig), name: 'c.png' });
  assert.strictEqual(claudeImageBlocks(att.toClaudeContent('x', [viaSha256]))[0].source.media_type, 'image/webp');
});

check('cache: normal uploads add no claude fields (object shape unchanged)', () => {
  const a = norm({ name: 'plain.png', mimeType: 'image/png', data: smallPng().toString('base64') });
  assert.ok(!('claudeDataBase64' in a) && !('claudeMimeType' in a) && !('claudeScaledRejected' in a));
  const ins = att.inspectAttachments([{ name: 'plain2.png', mimeType: 'image/png', data: smallPng().toString('base64') }])[0];
  assert.ok(!('claudeScaled' in ins));
});

// 3. Rejections: Claude falls back to the "too large" note, other providers unaffected.
const rejectCases = [
  ['unsupported MIME image/bmp', () => ({ claudeDataBase64: Buffer.concat([Buffer.from('BM'), crypto.randomBytes(1000)]).toString('base64'), claudeMimeType: 'image/bmp' })],
  ['MIME says webp but bytes are JPEG', () => ({ claudeDataBase64: jpegCopy().toString('base64'), claudeMimeType: 'image/webp' })],
  ['non-image MIME', () => ({ claudeDataBase64: webpCopy().toString('base64'), claudeMimeType: 'application/pdf' })],
  ['garbage base64', () => ({ claudeDataBase64: '@@@not base64!!!', claudeMimeType: 'image/webp' })],
  ['copy over the 5 MB cap', () => ({ claudeDataBase64: webpCopy(Math.ceil(CAP * 0.75) + 1024).toString('base64'), claudeMimeType: 'image/webp' })],
  ['non-string copy', () => ({ claudeDataBase64: { evil: true }, claudeMimeType: 'image/webp' })],
  ['missing MIME', () => ({ claudeDataBase64: webpCopy().toString('base64') })],
];
for (const [label, mk] of rejectCases) {
  check(`rejected copy (${label}) → ignored, claudeScaled:false, Claude gets text note`, () => {
    const orig = bigPng();
    const item = { name: 'r.png', mimeType: 'image/png', data: orig.toString('base64'), ...mk() };
    const a = norm(item);
    assert.ok(!a.claudeDataBase64, 'copy not stored');
    assert.strictEqual(a.claudeScaledRejected, true);
    const cl = att.toClaudeContent('x', [a]);
    assert.strictEqual(claudeImageBlocks(cl).length, 0);
    assert.ok(/skipped binary image block for Claude/.test(claudeText(cl)), 'too-large note present');
    assert.strictEqual(att.toGeminiParts('x', [a]).find((p) => p.inlineData).inlineData.data, orig.toString('base64'));
    const ins = att.inspectAttachments([{ ...item, data: bigPng().toString('base64') }])[0];
    assert.strictEqual(ins.claudeScaled, false);
  });
}

// 4. Unneeded copies are dropped silently.
check('copy for a small (≤5 MB) original → dropped, Claude gets original', () => {
  const orig = smallPng();
  const a = norm({ name: 's.png', mimeType: 'image/png', data: orig.toString('base64'), claudeDataBase64: webpCopy().toString('base64'), claudeMimeType: 'image/webp' });
  assert.ok(!a.claudeDataBase64 && !a.claudeScaledRejected);
  assert.strictEqual(claudeImageBlocks(att.toClaudeContent('x', [a]))[0].source.data, orig.toString('base64'));
});

check('copy on a non-image attachment → rejected, never used', () => {
  const csv = Buffer.from('a,b\n1,2\n'.repeat(10));
  const a = norm({ name: 'd.csv', mimeType: 'text/csv', data: csv.toString('base64'), claudeDataBase64: webpCopy().toString('base64'), claudeMimeType: 'image/webp' });
  assert.ok(!a.claudeDataBase64);
  assert.strictEqual(claudeImageBlocks(att.toClaudeContent('x', [a])).length, 0);
});

check('large image without a copy → unchanged legacy behaviour (text note for Claude)', () => {
  const a = norm({ name: 'n.png', mimeType: 'image/png', data: bigPng().toString('base64') });
  const cl = att.toClaudeContent('x', [a]);
  assert.strictEqual(claudeImageBlocks(cl).length, 0);
  assert.ok(/skipped binary image block for Claude/.test(claudeText(cl)));
});

// 5. Cached reference that carries a copy the entry lacked.
check('cached ref + copy: validated, attached, re-cached with correct bytes', () => {
  const orig = bigPng();
  norm({ name: 'late.png', mimeType: 'image/png', data: orig.toString('base64') });
  const before = att._cacheStats();
  const copy = webpCopy(120 * 1024);
  const a = norm({ sha256: sha256(orig), name: 'late.png', claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/webp' });
  assert.strictEqual(a.claudeDataBase64, copy.toString('base64'));
  const after = att._cacheStats();
  assert.strictEqual(after.entries, before.entries, 'no extra entry');
  assert.strictEqual(after.bytes - before.bytes, copy.toString('base64').length);
  const again = norm({ sha256: sha256(orig), name: 'late.png' });
  assert.strictEqual(again.claudeMimeType, 'image/webp', 'copy persisted in cache');
  const bad = bigPng();
  norm({ name: 'late2.png', mimeType: 'image/png', data: bad.toString('base64') });
  const b = norm({ sha256: sha256(bad), name: 'late2.png', claudeDataBase64: jpegCopy().toString('base64'), claudeMimeType: 'image/png' });
  assert.ok(!b.claudeDataBase64, 'mismatched copy on ref ignored');
});

// 6. Browser scale math (public/app.js claudeNativeScale), extracted and run in a vm.
check('browser copy size: ≤ 2576 px long edge and ≤ 4784 visual tokens (Claude native limit)', () => {
  const fs = require('fs');
  const vm = require('vm');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re) => { const m = src.match(re); assert.ok(m, `missing ${re}`); return m[0]; };
  const code = [
    grab(/const CLAUDE_IMAGE_MAX_LONG_EDGE = \d+;/),
    grab(/const CLAUDE_IMAGE_MAX_VISUAL_TOKENS = \d+;/),
    grab(/const CLAUDE_IMAGE_PATCH_PX = \d+;/),
    grab(/function claudeNativeScale\([\s\S]*?\n}\n/),
    'this.claudeNativeScale = claudeNativeScale; this.L = CLAUDE_IMAGE_MAX_LONG_EDGE; this.T = CLAUDE_IMAGE_MAX_VISUAL_TOKENS;',
  ].join('\n');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
  assert.strictEqual(ctx.L, 2576); assert.strictEqual(ctx.T, 4784);
  const tok = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
  for (const [W, H] of [[3000, 2200], [8000, 8000], [6000, 1000], [1000, 6000], [4032, 3024], [2576, 1000], [1200, 900], [20000, 300]]) {
    const s = ctx.claudeNativeScale(W, H);
    const w = Math.max(1, Math.round(W * s)); const h = Math.max(1, Math.round(H * s));
    assert.ok(s > 0 && s <= 1, `scale in (0,1] for ${W}x${H}`);
    assert.ok(Math.max(w, h) <= 2576, `${W}x${H} → ${w}x${h} long edge`);
    assert.ok(tok(w, h) <= 4784, `${W}x${H} → ${w}x${h} tokens ${tok(w, h)}`);
    // not needlessly small: 3% larger would break a limit (unless already at scale 1)
    const w2 = Math.round(W * s * 1.03); const h2 = Math.round(H * s * 1.03);
    assert.ok(s === 1 || Math.max(w2, h2) > 2576 || tok(w2, h2) > 4784, `${W}x${H} → ${w}x${h} is near the limit`);
  }
  assert.strictEqual(ctx.claudeNativeScale(1200, 900), 1, 'small images keep their size');
});

// 7. Worker path (normalizeAttachmentsAsync) gives the same result.
(async () => {
  try {
    const orig = bigPng();
    const copy = webpCopy();
    const [a] = await att.normalizeAttachmentsAsync([{ name: 'w.png', mimeType: 'image/png', data: orig.toString('base64'), claudeDataBase64: copy.toString('base64'), claudeMimeType: 'image/webp' }]);
    assert.strictEqual(a.claudeDataBase64, copy.toString('base64'));
    const ins = await att.inspectAttachmentsAsync([{ name: 'w2.png', mimeType: 'image/png', data: bigPng().toString('base64'), claudeDataBase64: 'garbage', claudeMimeType: 'image/webp' }]);
    assert.strictEqual(ins[0].claudeScaled, false);
    passed++; console.log('✓ async/worker path: copy accepted / garbage rejected');
  } catch (e) { console.error(`✗ async/worker path\n  ${e.message}`); process.exitCode = 1; }
  console.log(`\nCLAUDE SCALED COPY: ${process.exitCode ? 'FAILED' : `all ${passed} passed`}`);
})();
