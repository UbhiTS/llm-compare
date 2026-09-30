// ---------------------------------------------------------------------------
// imagePolicy.js — make sure every model actually SEES an attached image, or
// fails with a labelled error. Never silently strips an image.
//
// Each image attachment can carry up to two browser-made, downscaled copies
// (the server has no image codec and we add no dependency):
//   - fit copy     (fitDataBase64 / fitMimeType): shrunk to OpenAI's 30,000-patch
//                  budget with OpenAI's official shrink formula, so detail is kept;
//   - compact copy (claudeDataBase64 / claudeMimeType): Claude's max native size
//                  (2576 px / 4784 visual tokens, < 5 MB).
// The ladder for a model is original -> fit -> compact (largest first).
//
// 1. Up front: the first rung that meets the model's DOCUMENTED limits is sent
//    (pixel/patch caps, byte caps, accepted formats).
// 2. Reactive: if the provider still rejects the request because of the image
//    (HTTP 400/413/422 whose body names the image/size), the SAME model is retried
//    once per remaining rung with the next smaller copy.
// 3. Every substitution is reported in `attachmentNotes` (shown in the slot UI)
//    and named in the text block the model receives.
// 4. If no rung can be sent, the slot fails with
//    "image couldn't be sent to <model>: <reason>" — never a text-only answer.
// 5. Models documented/proven as text-only fail with "<model> does not accept
//    images" instead of answering as if the image were there.
// ---------------------------------------------------------------------------

const { imageDimensionsFromBase64 } = require('./imageInfo');

const IMAGE_MIMES_BASIC = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_MIMES_GEMINI = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

// OpenAI — https://platform.openai.com/docs/guides/images-vision ("Image input
// requirements" / "Model sizing behavior", checked 2026-09-25): PNG/JPEG/WEBP/
// non-animated GIF; 32x32 patches; "up to 30,000 patches per image … images that
// exceed the 30,000-patch limit after processing are REJECTED, not automatically
// resized". Confirmed live: a 7952x5304 JPEG (41,334 patches) returns 400
// "requires 41334 patches after processing, exceeding the limit of 30000".
const OPENAI_PATCH_PX = 32;
const OPENAI_IMAGE_LIMITS = [
  // gpt-5.5: `original` detail allows up to 10,000 patches and a 6000 px max dimension.
  { match: /^gpt-5\.5(?![0-9])/i, maxPatches: 10000, maxDim: 6000 },
  // gpt-6 family and gpt-5.6 sol/terra/luna: original/auto keep dimensions (65,535 px cap), 30,000 patches.
  { match: /^(gpt-6|gpt-5\.6)(?![0-9])/i, maxPatches: 30000, maxDim: 65535 },
];
// Unknown OpenAI models: conservative (the strictest documented `original` budget).
const OPENAI_DEFAULT_LIMITS = { maxPatches: 10000, maxDim: 6000 };
const OPENAI_DOC = 'platform.openai.com/docs/guides/images-vision';

// Anthropic — https://docs.anthropic.com/en/docs/build-with-claude/vision:
// 5 MB per image (base64) and 8000x8000 px hard limits.
const CLAUDE_MAX_B64 = 5 * 1024 * 1024;
const CLAUDE_MAX_DIM = 8000;

// Gemini API (AI Studio) — https://ai.google.dev/gemini-api/docs/image-understanding:
// "Inline image data limits your total request size … to 20MB."
const GEMINI_API_MAX_REQUEST_B64 = 20 * 1024 * 1024;

// Moonshot — https://platform.moonshot.ai/docs/guide/use-kimi-vision-model:
// base64 images only; request body must not exceed 100M.
const MOONSHOT_MAX_REQUEST_B64 = 100 * 1024 * 1024;

// Models proven to take no image input (Model Garden publisher metadata carries no
// modality field, so a live probe on 2026-09-25 is the evidence; IMAGE_COMPAT.md):
//  - Llama 3.3: Vertex rejects with 400 "…has non-text input data but the model only
//    accepts text input data".
//  - The rest: the Vertex MaaS endpoint returns 200 but DROPS the image — prompt
//    tokens 46–114 with a 1024x683 photo vs 756–1943 for vision models — and
//    several invented a description. Answering would be a fake answer.
const TEXT_ONLY_NOTE = 'text-only on Vertex AI MaaS: the endpoint drops image input';
const TEXT_ONLY_MODELS = new Map([
  ['meta/llama-3.3-70b-instruct-maas', 'Vertex AI: "the model only accepts text input data"'],
  ['deepseek-ai/deepseek-r1-0528-maas', TEXT_ONLY_NOTE],
  ['deepseek-ai/deepseek-v3.2-maas', TEXT_ONLY_NOTE],
  ['qwen/qwen3-235b-a22b-instruct-2507-maas', TEXT_ONLY_NOTE],
  ['qwen/qwen3-coder-480b-a35b-instruct-maas', TEXT_ONLY_NOTE],
  ['qwen/qwen3-next-80b-a3b-thinking-maas', TEXT_ONLY_NOTE],
  ['qwen/qwen3-next-80b-a3b-instruct-maas', TEXT_ONLY_NOTE],
  ['openai/gpt-oss-120b-maas', TEXT_ONLY_NOTE],
  ['openai/gpt-oss-20b-maas', TEXT_ONLY_NOTE],
  ['moonshotai/kimi-k2-thinking-maas', TEXT_ONLY_NOTE],
  ['zai-org/glm-5.2-maas', TEXT_ONLY_NOTE],
  ['zai-org/glm-5-maas', TEXT_ONLY_NOTE],
  ['zai-org/glm-4.7-maas', TEXT_ONLY_NOTE],
]);

function familyOf(cfg) {
  const provider = cfg && cfg.provider;
  if (provider === 'openai') return 'openai';
  if (provider === 'moonshot') return 'moonshot';
  if (provider === 'anthropic') return 'claude';
  if (provider === 'gemini') return 'gemini-api';
  if (provider === 'agentplatform') {
    if (cfg.endpointType === 'openai-maas') return 'maas';
    return (cfg.publisher || 'google') === 'anthropic' ? 'claude' : 'gemini-vertex';
  }
  return 'other';
}

function openaiLimitsFor(model) {
  const m = String(model || '');
  const hit = OPENAI_IMAGE_LIMITS.find((x) => x.match.test(m));
  return hit ? { maxPatches: hit.maxPatches, maxDim: hit.maxDim } : { ...OPENAI_DEFAULT_LIMITS };
}

// Documented per-image limits for a model. null fields = no documented limit
// (the reactive retry still covers undocumented rejections).
function imageLimitsFor(cfg) {
  const family = familyOf(cfg);
  switch (family) {
    case 'openai': {
      const l = openaiLimitsFor(cfg.model);
      return { family, mimes: IMAGE_MIMES_BASIC, maxB64: null, maxDim: l.maxDim, maxPatches: l.maxPatches, patchPx: OPENAI_PATCH_PX };
    }
    case 'claude':
      return { family, mimes: IMAGE_MIMES_BASIC, maxB64: CLAUDE_MAX_B64, maxDim: CLAUDE_MAX_DIM, maxPatches: null, patchPx: null };
    case 'gemini-api':
      return { family, mimes: IMAGE_MIMES_GEMINI, maxB64: GEMINI_API_MAX_REQUEST_B64, maxDim: null, maxPatches: null, patchPx: null };
    case 'gemini-vertex':
      return { family, mimes: IMAGE_MIMES_GEMINI, maxB64: null, maxDim: null, maxPatches: null, patchPx: null };
    case 'moonshot':
      return { family, mimes: IMAGE_MIMES_BASIC, maxB64: MOONSHOT_MAX_REQUEST_B64, maxDim: null, maxPatches: null, patchPx: null };
    default: // Vertex MaaS (OpenAI-compatible image_url parts) and anything else
      return { family, mimes: IMAGE_MIMES_BASIC, maxB64: null, maxDim: null, maxPatches: null, patchPx: null };
  }
}

function patchCount(dims, patchPx) {
  return Math.ceil(dims.width / patchPx) * Math.ceil(dims.height / patchPx);
}

// Why a rung does not meet the documented limits (null = it fits).
function limitViolation(rung, lim) {
  if (lim.mimes && !lim.mimes.has(rung.mimeType)) return `format ${rung.mimeType} is not accepted`;
  if (lim.maxB64 && rung.data.length > lim.maxB64) {
    return `${(rung.data.length / (1024 * 1024)).toFixed(1)} MB base64 exceeds the ${(lim.maxB64 / (1024 * 1024)).toFixed(0)} MB limit`;
  }
  const d = rung.dims();
  if (d) {
    if (lim.maxDim && Math.max(d.width, d.height) > lim.maxDim) {
      return `${d.width}×${d.height} px exceeds the ${lim.maxDim} px maximum dimension`;
    }
    if (lim.maxPatches && lim.patchPx) {
      const p = patchCount(d, lim.patchPx);
      if (p > lim.maxPatches) return `${d.width}×${d.height} px needs ${p} patches, over the ${lim.maxPatches}-patch limit`;
    }
  }
  return null;
}

function normMime(m) {
  const s = String(m || '').trim().toLowerCase().split(';')[0];
  return s === 'image/jpg' ? 'image/jpeg' : s;
}

function makeRung(key, data, mimeType) {
  let dims;
  return { key, data, mimeType: normMime(mimeType), dims: () => (dims === undefined ? (dims = imageDimensionsFromBase64(data)) : dims) };
}

// original -> fit -> compact, keeping only copies that are actually smaller.
// Claude never takes the fit copy: it gets the original or its own compact copy
// at Claude's max native resolution (unchanged Round 6 behaviour).
function laddersOf(att, family) {
  const rungs = [makeRung('original', att.data, att.mimeType)];
  if (family !== 'claude' && att.fitDataBase64 && att.fitMimeType) rungs.push(makeRung('fit', att.fitDataBase64, att.fitMimeType));
  if (att.claudeDataBase64 && att.claudeMimeType) rungs.push(makeRung('compact', att.claudeDataBase64, att.claudeMimeType));
  return rungs;
}

const isSendableImage = (att) => Boolean(att && att.kind === 'image' && !att.isEmpty && att.data);

function hasImageAttachments(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m.attachments) && m.attachments.some(isSendableImage));
}

class ImageNotSentError extends Error {
  constructor(message, { status = 400, model, code = 'IMAGE_NOT_SENT' } = {}) {
    super(message);
    this.name = 'ImageNotSentError';
    this.code = code;
    this.status = status;
    this.model = model;
  }
}

function describeRung(rung) {
  const d = rung.dims();
  return d ? `${d.width}×${d.height}` : 'a smaller size';
}

function shortReason(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  // Prefer the provider's own "message" field when the error embeds JSON.
  const m = s.match(/"message"\s*:\s*"([^"]{3,300})"/);
  const r = (m ? m[1] : s).replace(/\\n/g, ' ');
  return r.length > 220 ? `${r.slice(0, 217)}…` : r;
}

// Build the per-model messages for the current ladder positions.
// `pos` (Map attKey -> rung index) is the minimum rung allowed per image.
function planImages(messages, cfg, pos, rejectReason) {
  const lim = imageLimitsFor(cfg);
  const notes = [];
  const chosen = new Map();
  const out = messages.map((m, mi) => {
    if (!Array.isArray(m.attachments) || !m.attachments.length) return m;
    const atts = m.attachments.map((att, ai) => {
      if (!isSendableImage(att)) return att;
      const key = `${mi}:${ai}`;
      const rungs = laddersOf(att, lim.family);
      const start = pos.get(key) || 0;
      let pick = -1;
      let firstViolation = null;
      for (let i = start; i < rungs.length; i++) {
        const v = limitViolation(rungs[i], lim);
        if (!v) { pick = i; break; }
        if (firstViolation == null) firstViolation = v;
      }
      if (pick < 0) {
        const why = start > 0 && rejectReason
          ? `the provider rejected it (${rejectReason}) and no smaller copy is available`
          : `${firstViolation || 'it exceeds the provider limits'}${rungs.length > 1 ? ' and no scaled copy fits' : ' and no scaled copy is available (re-attach it in the browser so one can be made)'}`;
        throw new ImageNotSentError(`image couldn't be sent to ${cfg.model}: "${att.name}" — ${why}. Not answered without it.`, { model: cfg.model });
      }
      chosen.set(key, { pick, count: rungs.length });
      if (pick === 0) return att;
      const r = rungs[pick];
      const origDims = rungs[0].dims();
      const cause = rejectReason && start > 0
        ? `provider rejected the original: ${rejectReason}`
        : (limitViolation(rungs[0], lim) || 'original exceeds the provider limits');
      const scaledNote = `image auto-scaled to ${describeRung(r)} for ${cfg.model} (${cause})`;
      notes.push(`"${att.name}"${origDims ? ` (${origDims.width}×${origDims.height})` : ''}: ${scaledNote}`);
      const copy = { ...att, data: r.data, mimeType: r.mimeType, scaledNote };
      // The copy IS the image now; drop the other copies so converters don't re-pick.
      delete copy.claudeDataBase64; delete copy.claudeMimeType; delete copy.fitDataBase64; delete copy.fitMimeType;
      return copy;
    });
    return { ...m, attachments: atts };
  });
  return { messages: out, notes, chosen };
}

// A provider error caused by OUR image (as opposed to quota/capacity/network).
const IMAGE_REJECTION_RE = /image|patch|pixel|resiz|dimension|too large|payload|inline.?data|media|mime|base64|vision|multimodal|content.?type|file size|request entity/i;
function isImageRejection(err) {
  if (!err) return false;
  const st = Number(err.status);
  if (st === 413) return true;
  if (st !== 400 && st !== 422) return false;
  return IMAGE_REJECTION_RE.test(String(err.message || ''));
}

// Wrap one provider call with the image policy.
async function withImagePolicy(cfg, messages, signal, call) {
  if (!hasImageAttachments(messages)) return call(messages);
  const textOnly = TEXT_ONLY_MODELS.get(cfg.model);
  if (textOnly) {
    throw new ImageNotSentError(`${cfg.model} does not accept images (${textOnly}) — not answered without the image.`, { model: cfg.model, code: 'IMAGE_UNSUPPORTED' });
  }
  const pos = new Map();
  let plan = planImages(messages, cfg, pos, null);
  let lastReason = null;
  for (;;) {
    try {
      const res = await call(plan.messages);
      if (plan.notes.length) res.attachmentNotes = [...(res.attachmentNotes || []), ...plan.notes];
      return res;
    } catch (err) {
      // Not caused by the image (quota, capacity, network, auth…): surface unchanged.
      if (!isImageRejection(err) || (signal && signal.aborted)) throw err;
      lastReason = shortReason(err.message);
      // Move every image that can go one rung down; if none can, the image can't be sent.
      let moved = false;
      for (const [key, c] of plan.chosen) {
        if (c.pick + 1 < c.count) { pos.set(key, c.pick + 1); moved = true; }
      }
      if (!moved) {
        throw new ImageNotSentError(`image couldn't be sent to ${cfg.model}: the provider rejected it (${lastReason}) and no smaller copy is available. Not answered without it.`, { model: cfg.model, status: err.status });
      }
      plan = planImages(messages, cfg, pos, lastReason);
    }
  }
}

module.exports = {
  withImagePolicy,
  imageLimitsFor,
  openaiLimitsFor,
  planImages,
  isImageRejection,
  hasImageAttachments,
  ImageNotSentError,
  TEXT_ONLY_MODELS,
  IMAGE_REJECTION_RE,
  OPENAI_PATCH_PX,
  OPENAI_IMAGE_LIMITS,
  OPENAI_DOC,
  CLAUDE_MAX_DIM,
};
