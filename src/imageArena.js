// ---------------------------------------------------------------------------
// Image & GenMedia Arena — Vertex AI Nano Banana (Gemini Image) Benchmark Engine
//
// Compares Vertex AI native multimodal image generation & conversational editing
// models side-by-side:
//   • Gemini Nano Banana 2.1 (`gemini-nano-banana-2.1`)
//   • Gemini Nano Banana 2   (`gemini-3.1-flash-image`)
//   • Gemini Nano Banana Pro (`gemini-3-pro-image`)
//
// Grounded in live Vertex AI endpoint behavior & official pricing:
//   https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing#nano-banana
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image
// ---------------------------------------------------------------------------

const zlib = require('zlib');
const { providerFetch } = require('./providerFetch');
const globalKeys = require('./globalKeys');
// Strict BYOK: a user's own key is used exclusively (never a shared key or shared project).
const byok = require('./byok');
const { scrubError } = require('./secrets');
const { imageDimensionsFromBase64 } = require('./imageInfo');

const DEFAULT_IMAGE_PROJECT_NUMBER = process.env.AGENT_PLATFORM_PROJECT_NUMBER || '419460847694';

const IMAGE_RESOLUTIONS = [
  { id: '1K', label: '1K · Standard (~1.0 MP)', shortLabel: '1K', description: 'Fast web preview & social cards (1376×768 at 16:9 · 1024×1024 at 1:1)' },
  { id: '2K', label: '2K · High-Res (~4.2 MP)', shortLabel: '2K', description: 'High-DPI digital catalogs & photo book spreads (2752×1536 at 16:9)' },
  { id: '4K', label: '4K · Print-Ready (~16.9 MP)', shortLabel: '4K', description: 'Large-format 300-DPI print, canvas wall art & micro-typography (5504×3072 at 16:9)' },
];

const IMAGE_ASPECT_RATIOS = [
  { id: '16:9', label: '16:9 · Landscape Spread' },
  { id: '1:1',  label: '1:1 · Square Album' },
  { id: '4:3',  label: '4:3 · Classic Photo Print' },
  { id: '3:4',  label: '3:4 · Portrait Greeting Card' },
  { id: '9:16', label: '9:16 · Vertical Story / Poster' },
];

const IMAGE_MODEL_CATALOG = [
  {
    id: 'gemini-3.1-flash-image',
    label: 'Gemini Nano Banana 2 (3.1 Flash Image)',
    shortLabel: 'Nano Banana 2',
    model: 'gemini-3.1-flash-image',
    family: 'Nano Banana 2',
    provider: 'agentplatform',
    publisher: 'google',
    providerFamily: 'google',
    releaseDate: '2026-02-26',
    releaseBadge: 'High-Throughput Regional + Global',
    slaBadge: '99.5% Long-Term SLA',
    slaPct: 99.5,
    endpointBadge: 'US/EU Multi-Region + Global',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 14,
    contextWindow: 65536,
    pricing: {
      inputPerM: 0.50,
      imageOutputPerM: 60.00,
      textOutputPerM: 3.00,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.0672, '2K': 0.1008, '4K': 0.1512 },
    },
    purchasingTiers: ['Standard PayGo', 'Provisioned Throughput (PTU)', 'Batch Prediction'],
    architectureGuidance: 'Primary synchronous checkout & regional (US/EU) workload engine backed by the 99.5% Long-Term SLA.',
  },
  {
    id: 'gemini-nano-banana-2.1',
    label: 'Gemini Nano Banana 2.1',
    shortLabel: 'Nano Banana 2.1',
    model: 'gemini-nano-banana-2.1',
    family: 'Nano Banana 2.1',
    provider: 'agentplatform',
    publisher: 'google',
    providerFamily: 'google',
    releaseDate: '2026-10-06',
    releaseBadge: '~50% Lower Cost · 4K + Visual Thinking',
    slaBadge: '95.0% Short-Term SLA',
    slaPct: 95.0,
    endpointBadge: 'Global Endpoint (/locations/global)',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 13,
    contextWindow: 65536,
    pricing: {
      inputPerM: 0.50,
      imageOutputPerM: 30.00,
      textOutputPerM: 2.00,
      offPeakDiscount: 0.50,
      referenceCostBySize: { '1K': 0.0336, '2K': 0.0504, '4K': 0.1134 },
    },
    purchasingTiers: ['Standard PayGo (~50% lower output rate)', 'Off-Peak PayGo (50% extra discount)', 'Provisioned Throughput (PTU)'],
    architectureGuidance: 'High-margin engine for 4K (16.9 MP) print upscaling, multilingual card typography, conversational Smart Erase, and 50% Off-Peak PayGo batch catalog jobs.',
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    label: 'Gemini Nano Banana 2 Lite (3.1 Flash-Lite Image)',
    shortLabel: 'Nano Banana 2 Lite',
    model: 'gemini-3.1-flash-lite-image',
    family: 'Nano Banana 2 Lite',
    provider: 'agentplatform',
    publisher: 'google',
    providerFamily: 'google',
    releaseDate: '2026-07-21',
    releaseBadge: 'Ultra-Low Latency · 1K Efficiency Specialist',
    slaBadge: '99.5% Long-Term SLA',
    slaPct: 99.5,
    endpointBadge: 'Global + Regional (1K Max)',
    supportedSizes: ['1K'],
    maxReferenceImages: 14,
    contextWindow: 65536,
    pricing: {
      inputPerM: 0.25,
      imageOutputPerM: 30.00,
      textOutputPerM: 1.50,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.0336, '2K': 0.0336, '4K': 0.0336 },
    },
    purchasingTiers: ['Standard PayGo ($0.0336/img)', 'Provisioned Throughput (PTU)', 'Batch Prediction'],
    architectureGuidance: 'Sub-2s ultra-low-latency 1K specialist ($0.25/1M input, $30/1M image output) for rapid interactive previews, stickers, and high-volume 1K thumbnails.',
  },
  {
    id: 'gemini-3-pro-image',
    label: 'Gemini Nano Banana Pro (3 Pro Image)',
    shortLabel: 'Nano Banana Pro',
    model: 'gemini-3-pro-image',
    family: 'Nano Banana Pro',
    provider: 'agentplatform',
    publisher: 'google',
    providerFamily: 'google',
    releaseDate: '2025-11-20',
    releaseBadge: 'Deep Visual Reasoning',
    slaBadge: '99.5% Long-Term SLA',
    slaPct: 99.5,
    endpointBadge: 'Global + Regional',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 14,
    contextWindow: 65536,
    pricing: {
      inputPerM: 2.00,
      imageOutputPerM: 120.00,
      textOutputPerM: 12.00,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.134, '2K': 0.168, '4K': 0.240 },
    },
    purchasingTiers: ['Standard PayGo', 'Provisioned Throughput (PTU)'],
    architectureGuidance: 'Flagship creative studio tier for dense multi-character composition and maximum reasoning depth.',
  },
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'OpenAI GPT Image 2.5 Sunburst',
    shortLabel: 'GPT Image 2.5 Sunburst',
    model: 'gpt-image-2.5-sunburst',
    family: 'GPT Image 2.5',
    provider: 'openai',
    publisher: 'openai',
    providerFamily: 'openai',
    releaseDate: '2026-09-15',
    releaseBadge: 'Flagship Image Generation & Editing · Direct OpenAI API',
    slaBadge: '99.9% OpenAI Enterprise SLA',
    slaPct: 99.9,
    endpointBadge: 'OpenAI API (/v1/images)',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 16,
    contextWindow: 32768,
    pricing: {
      inputPerM: 5.00,
      imageInputPerM: 8.00,
      imageOutputPerM: 30.00,
      textOutputPerM: 10.00,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.1248, '2K': 0.1872, '4K': 0.3744 },
    },
    purchasingTiers: ['Standard PayGo ($30/1M img output tok)', 'OpenAI Batch API'],
    architectureGuidance: 'OpenAI flagship image generation & multi-reference editing engine (`gpt-image-2.5-sunburst`) supporting 16px-aligned resolutions up to 4K UHD (3840x2160 / 2880x2880, 8.29 MP).',
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'OpenAI GPT Image 2.5 Flare',
    shortLabel: 'GPT Image 2.5 Flare',
    model: 'gpt-image-2.5-flare',
    family: 'GPT Image 2.5',
    provider: 'openai',
    publisher: 'openai',
    providerFamily: 'openai',
    releaseDate: '2026-09-15',
    releaseBadge: 'Fast Image Generation & Editing · Direct OpenAI API',
    slaBadge: '99.9% OpenAI Enterprise SLA',
    slaPct: 99.9,
    endpointBadge: 'OpenAI API (/v1/images)',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 16,
    contextWindow: 32768,
    pricing: {
      inputPerM: 5.00,
      imageInputPerM: 8.00,
      imageOutputPerM: 30.00,
      textOutputPerM: 10.00,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.1248, '2K': 0.1872, '4K': 0.3744 },
    },
    purchasingTiers: ['Standard PayGo ($30/1M img output tok)', 'OpenAI Batch API'],
    architectureGuidance: 'Low-latency OpenAI image generation & editing variant (`gpt-image-2.5-flare`) tuned for interactive creative iteration and high-throughput studio pipelines.',
  },
  {
    id: 'gpt-image-2',
    label: 'OpenAI GPT Image 2',
    shortLabel: 'GPT Image 2',
    model: 'gpt-image-2',
    family: 'GPT Image 2',
    provider: 'openai',
    publisher: 'openai',
    providerFamily: 'openai',
    releaseDate: '2026-05-12',
    releaseBadge: 'Multimodal Image Generation & Editing · Direct OpenAI API',
    slaBadge: '99.9% OpenAI Enterprise SLA',
    slaPct: 99.9,
    endpointBadge: 'OpenAI API (/v1/images)',
    supportedSizes: ['1K', '2K', '4K'],
    maxReferenceImages: 16,
    contextWindow: 32768,
    pricing: {
      inputPerM: 5.00,
      imageInputPerM: 8.00,
      imageOutputPerM: 30.00,
      textOutputPerM: 10.00,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.1248, '2K': 0.1872, '4K': 0.3744 },
    },
    purchasingTiers: ['Standard PayGo ($30/1M img output tok)', 'OpenAI Batch API'],
    architectureGuidance: 'General-availability OpenAI GPT Image 2 baseline (`gpt-image-2`) for cross-provider quality, typography, and editing benchmarking against Vertex AI Nano Banana.',
  },
];

const DEFAULT_IMAGE_SLOTS = [
  { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
  { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
];

// ---------------------------------------------------------------------------
// Pure-Node deterministic PNG generator for built-in reference images
// (Zero external dependencies; generates rich, valid RGB PNGs in <10ms at boot
// so Smart Erase & Multi-Image Consistency work with 1 click out of the box.)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbPng(width, height, drawPixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = drawPixel(x, y, width, height);
      const p = rowOff + 1 + x * 3;
      raw[p] = Math.max(0, Math.min(255, r | 0));
      raw[p + 1] = Math.max(0, Math.min(255, g | 0));
      raw[p + 2] = Math.max(0, Math.min(255, b | 0));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 6 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

const SAMPLE_REFERENCE_ASSETS = (() => {
  try {
    const realRefs = require('./assets/ref-images.json');
    if (realRefs && typeof realRefs === 'object' && Object.keys(realRefs).length >= 14) {
      return realRefs;
    }
  } catch (_) {
    // Fallback to procedural PNGs only if ref-images.json is missing
  }
  // 1. Smart Erase Reference: Golden-hour beach scene with family silhouettes on left
  //    AND a bright neon-orange construction bin + dark utility wire photobomber on right.
  const beachBuf = encodeRgbPng(384, 240, (x, y, w, h) => {
    const ny = y / h;
    const nx = x / w;
    let r = 0, g = 0, b = 0;
    if (ny < 0.52) {
      // Sunset sky gradient
      const t = ny / 0.52;
      r = 72 + t * 178;
      g = 98 + t * 88;
      b = 168 - t * 42;
      // Warm sun disc at left-center horizon
      const sd = dist(x, y, w * 0.34, h * 0.42);
      if (sd < 34) {
        const st = 1 - sd / 34;
        r = Math.min(255, r + st * 85);
        g = Math.min(255, g + st * 65);
        b = Math.min(255, b + st * 25);
      }
      // Overhead dark utility power wire sagging across upper sky (to be erased!)
      const wireY = 28 + Math.sin(nx * Math.PI) * 18;
      if (Math.abs(y - wireY) < 1.8 || Math.abs(y - (wireY + 9)) < 1.4) {
        return [24, 24, 30];
      }
    } else if (ny < 0.70) {
      // Ocean water + gentle whitecap waves
      const t = (ny - 0.52) / 0.18;
      const wave = Math.sin(x * 0.16 + y * 0.7) * 10;
      r = 28 + t * 35 + wave;
      g = 115 + t * 40 + wave;
      b = 158 + t * 25 + wave;
      if (Math.abs(ny - 0.68) < 0.012 && Math.sin(x * 0.25) > -0.2) {
        r = 238; g = 242; b = 246;
      }
    } else {
      // Warm sandy beach
      const t = (ny - 0.70) / 0.30;
      const grain = ((x * 37 + y * 13) % 11) - 5;
      r = 216 - t * 18 + grain;
      g = 184 - t * 16 + grain;
      b = 136 - t * 14 + grain;
    }

    // Subject 1 & 2 (Family figures on left beach — keep intact)
    const p1Head = dist(x, y, 108, 134) < 11;
    const p1Body = x >= 94 && x <= 122 && y >= 145 && y <= 198 && Math.abs(x - 108) < 12 + (y - 145) * 0.08;
    if (p1Head) return [225, 178, 145];
    if (p1Body) return [38, 88, 165]; // Navy coastal jacket

    const p2Head = dist(x, y, 142, 144) < 9.5;
    const p2Body = x >= 130 && x <= 154 && y >= 154 && y <= 198 && Math.abs(x - 142) < 10 + (y - 154) * 0.08;
    if (p2Head) return [228, 182, 148];
    if (p2Body) return [214, 72, 96]; // Coral sweater

    // Distraction to erase: Bright neon-orange construction barrel / trash bin on right beach (x: 280..336, y: 138..214)
    if (x >= 282 && x <= 334 && y >= 142 && y <= 212) {
      const isStripe = (y >= 158 && y <= 168) || (y >= 184 && y <= 194);
      if (isStripe) return [245, 245, 250];
      return [255, 82, 14]; // Neon orange distraction
    }
    // Lid of bin
    if (x >= 278 && x <= 338 && y >= 135 && y < 142) {
      return [40, 44, 52];
    }

    return [r, g, b];
  });

  // 2. Multi-Image Reference A: Character Identity (Red Fox Explorer in Blue Scarf)
  const foxBuf = encodeRgbPng(256, 256, (x, y, w, h) => {
    const cx = w / 2, cy = h / 2 + 10;
    // Soft cream studio background
    let r = 246, g = 241, b = 230;
    // Left & right pointed fox ears
    const inLeftEar = x >= 74 && x <= 112 && y >= 48 && y <= 105 && (x - 74) * 1.4 >= (105 - y) * 0.5 && (112 - x) * 1.4 >= (105 - y) * 0.5;
    const inRightEar = x >= 144 && x <= 182 && y >= 48 && y <= 105 && (x - 144) * 1.4 >= (105 - y) * 0.5 && (182 - x) * 1.4 >= (105 - y) * 0.5;
    if (inLeftEar || inRightEar) {
      r = 224; g = 96; b = 36;
      if (y > 66 && Math.abs(x - (inLeftEar ? 93 : 163)) < 8) { r = 42; g = 34; b = 32; }
    }
    // Fox head circle
    const hd = dist(x, y, cx, cy - 22);
    if (hd < 48) {
      r = 232; g = 104; b = 40;
      // White cheek patches
      if (y > cy - 18 && (dist(x, y, cx - 22, cy - 4) < 24 || dist(x, y, cx + 22, cy - 4) < 24)) {
        r = 250; g = 246; b = 240;
      }
      // Eyes
      if (dist(x, y, cx - 16, cy - 26) < 5.5 || dist(x, y, cx + 16, cy - 26) < 5.5) {
        return [28, 24, 24];
      }
      // Nose
      if (dist(x, y, cx, cy - 8) < 6.5) {
        return [32, 24, 24];
      }
    }
    // Cozy cobalt-blue explorer scarf around neck
    if (y >= cy + 16 && y <= cy + 44 && Math.abs(x - cx) < 46) {
      const stripe = ((x + y) % 14) < 4;
      return stripe ? [245, 202, 76] : [36, 94, 192];
    }
    // Scarf tail
    if (x >= cx + 10 && x <= cx + 32 && y > cy + 40 && y <= cy + 82) {
      return [36, 94, 192];
    }
    // Torso
    if (y > cy + 42 && y <= cy + 102 && Math.abs(x - cx) < 40) {
      r = 224; g = 96; b = 36;
      if (Math.abs(x - cx) < 18) { r = 250; g = 246; b = 240; }
    }
    return [r, g, b];
  });

  // 3. Multi-Image Reference B: Storybook Watercolor Pine & Snowy Palette Swatch
  const styleBuf = encodeRgbPng(256, 256, (x, y, w, h) => {
    const ny = y / h;
    const wave = Math.sin(x * 0.05) * 8 + Math.cos(y * 0.05) * 6;
    // Soft watercolor sky & snowy hills
    let r = Math.min(255, 210 + ny * 35 + wave * 0.5);
    let g = Math.min(255, 225 + ny * 22 + wave * 0.4);
    let b = Math.min(255, 242 + ny * 10);
    // Pine trees silhouette in soft sage/emerald watercolor
    for (const tx of [56, 128, 198]) {
      const topY = tx === 128 ? 54 : 74;
      if (y >= topY && y <= 196) {
        const halfW = (y - topY) * 0.34;
        if (Math.abs(x - tx) <= halfW) {
          r = 46; g = 112; b = 98;
        }
      }
    }
    return [r, g, b];
  });

  // 4. Multi-Image Reference C: Golden Vintage Lantern Prop
  const lanternBuf = encodeRgbPng(256, 256, (x, y, w, h) => {
    const cx = w / 2, cy = h / 2;
    const d = dist(x, y, cx, cy);
    // Deep twilight backdrop with warm radial lantern glow
    let r = 24, g = 34, b = 62;
    if (d < 95) {
      const glow = 1 - d / 95;
      r = Math.min(255, r + glow * 220);
      g = Math.min(255, g + glow * 165);
      b = Math.min(255, b + glow * 65);
    }
    // Brass lantern frame
    if (Math.abs(x - cx) < 34 && y >= 78 && y <= 182) {
      const border = Math.abs(x - cx) > 27 || y < 88 || y > 170;
      if (border) return [184, 134, 45];
      return [255, 232, 138];
    }
    return [r, g, b];
  });

  // 5. Upscaling Reference: Low-res blocky 160x120 mountain cabin by lake (quantized 4x4 pixel blocks)
  const lowResCabinBuf = encodeRgbPng(160, 120, (x, y, w, h) => {
    const qx = Math.floor(x / 4) * 4;
    const qy = Math.floor(y / 4) * 4;
    const ny = qy / h;
    let r = 82, g = 132, b = 198;
    if (ny < 0.45) {
      r = 95 + ny * 90; g = 145 + ny * 65; b = 215 - ny * 20;
    } else if (ny < 0.68) {
      // Mountain ridge
      const ridge = 0.42 + Math.sin(qx * 0.06) * 0.10 + Math.cos(qx * 0.11) * 0.06;
      if (ny >= ridge) {
        const snow = ny < ridge + 0.07;
        r = snow ? 235 : 88; g = snow ? 240 : 96; b = snow ? 248 : 112;
      }
    } else {
      // Alpine lake + pine shore
      r = 38; g = 98; b = 138;
    }
    // Blocky wooden cabin on right shore
    if (qx >= 92 && qx <= 132 && qy >= 62 && qy <= 88) {
      r = 138; g = 82; b = 44;
      if (qx >= 106 && qx <= 118 && qy >= 70 && qy <= 80) {
        r = 248; g = 208; b = 92; // Warm cabin window
      }
    }
    return [r, g, b];
  });

  // 6. Aspect-Ratio Resampling / Outpainting Reference: 1:1 tight square crop of a coastal lighthouse
  const lighthouseBuf = encodeRgbPng(240, 240, (x, y, w, h) => {
    const ny = y / h;
    let r = 64 + ny * 110, g = 112 + ny * 75, b = 178 - ny * 25;
    if (ny > 0.66) {
      // Basalt cliff & ocean base
      r = x < 155 ? 62 : 28;
      g = x < 155 ? 64 : 112;
      b = x < 155 ? 72 : 148;
    }
    // Lighthouse tower (centered tight crop)
    if (y >= 54 && y <= 165 && Math.abs(x - 118) <= 16 + (y - 54) * 0.08) {
      const band = Math.floor((y - 54) / 22) % 2 === 0;
      return band ? [242, 240, 236] : [204, 48, 44];
    }
    // Lantern beacon at top
    if (dist(x, y, 118, 46) < 14) return [255, 232, 124];
    return [r, g, b];
  });

  // 7. Vintage Photo Restoration Reference: Sepia portrait with white diagonal paper creases & dust specks
  const vintageBuf = encodeRgbPng(320, 240, (x, y, w, h) => {
    // Sepia garden backdrop
    let lum = 135 + Math.sin(x * 0.04) * 18 + Math.cos(y * 0.05) * 16;
    // Subject silhouette in center
    if (dist(x, y, 160, 96) < 28) lum = 188;
    if (y >= 124 && y <= 220 && Math.abs(x - 160) < 48) lum = 86;
    // Vignette darkening at corners
    const cd = dist(x, y, w / 2, h / 2) / 190;
    lum = lum * Math.max(0.45, 1 - cd * 0.45);
    let r = Math.min(255, lum * 1.18);
    let g = Math.min(255, lum * 0.98);
    let b = Math.min(255, lum * 0.74);
    // Diagonal white paper fold creases across image (to be repaired)
    const crease1 = Math.abs((x * 0.65 + y) - 195) < 1.9;
    const crease2 = Math.abs((x * -0.55 + y) - 42) < 1.6;
    if (crease1 || crease2) return [244, 238, 224];
    // Random dust specks
    if (((x * 73 + y * 151) % 997) === 0) return [248, 244, 232];
    return [r, g, b];
  });

  // 8. Eyeglass Glare & Indoor Tungsten Cast Reference
  const glareBuf = encodeRgbPng(280, 240, (x, y, w, h) => {
    // Warm yellow-orange tungsten indoor wall
    let r = 212, g = 168, b = 104;
    const cx = w / 2, cy = h / 2;
    // Face oval
    if (dist(x, y * 0.9, cx, cy * 0.9) < 56) {
      r = 228; g = 176; b = 128;
    }
    // Eyeglass frames (left & right)
    const dL = dist(x, y, cx - 24, cy - 8);
    const dR = dist(x, y, cx + 24, cy - 8);
    if ((dL >= 16 && dL <= 19) || (dR >= 16 && dR <= 19) || (Math.abs(y - (cy - 8)) < 2 && Math.abs(x - cx) <= 8)) {
      return [38, 34, 32];
    }
    // Bright white/cyan flash glare obscuring both lenses
    if (dL < 16 || dR < 16) {
      return [238, 252, 246];
    }
    return [r, g, b];
  });

  // 9. Cluttered Desk Mug Cleanup Reference
  const deskMugBuf = encodeRgbPng(320, 240, (x, y, w, h) => {
    let r = 196, g = 188, b = 176;
    if (y > 140) { r = 148; g = 132; b = 114; } // Tabletop
    // Centerpiece terracotta ceramic mug (keep intact)
    if (x >= 134 && x <= 186 && y >= 108 && y <= 184) {
      return [198, 92, 64];
    }
    // Distraction 1: Bright yellow sticky notes on left
    if (x >= 34 && x <= 86 && y >= 146 && y <= 192) return [252, 234, 72];
    // Distraction 2: Green plastic bottle on right
    if (x >= 242 && x <= 278 && y >= 88 && y <= 186) return [42, 178, 84];
    // Distraction 3: Tangled black cable across foreground
    if (Math.abs(y - (196 + Math.sin(x * 0.09) * 12)) < 2.5) return [24, 24, 28];
    return [r, g, b];
  });

  // 10. Pattern & Wallpaper Colorway Recoloring Reference (Navy Blue & Mustard Gold repeat tile)
  const patternBuf = encodeRgbPng(256, 256, (x, y) => {
    // Navy blue ground
    let r = 22, g = 42, b = 84;
    const gx = (x % 64) - 32;
    const gy = (y % 64) - 32;
    const d = Math.hypot(gx, gy);
    const angle = Math.atan2(gy, gx);
    const petal = 18 + Math.cos(angle * 6) * 8;
    // Mustard gold floral rosette
    if (d < petal) {
      r = 228; g = 178; b = 52;
      if (d < 7) { r = 244; g = 238, b = 222; }
    }
    // Geometric diamond lattice line
    if (Math.abs(Math.abs(gx) + Math.abs(gy) - 30) < 1.8) {
      r = 184; g = 204; b = 232;
    }
    return [r, g, b];
  });

  // 11. SKU Colorway Swap Reference (Crimson Red woven throw pillow on neutral linen sofa)
  const pillowBuf = encodeRgbPng(320, 240, (x, y, w, h) => {
    // Neutral warm oat linen sofa backdrop
    let r = 226, g = 218, b = 206;
    if (y > 165) { r = 208; g = 198; b = 184; }
    // Crimson red woven pillow in center with knit texture
    if (x >= 96 && x <= 224 && y >= 58 && y <= 182) {
      const weave = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) * 14;
      r = 186 + weave; g = 28 + weave * 0.4; b = 42 + weave * 0.4;
    }
    return [r, g, b];
  });

  // 12. Seasonal Relighting Reference (Bright Summer Midday Green Trees & Porch)
  const summerPorchBuf = encodeRgbPng(320, 220, (x, y, w, h) => {
    const ny = y / h;
    // Bright blue summer midday sky
    let r = 92, g = 174, b = 242;
    if (ny > 0.65) {
      // Bright green summer lawn
      r = 74; g = 164; b = 68;
      // Stone walkway
      if (Math.abs(x - w / 2) < 28 + (y - h * 0.65) * 0.45) {
        r = 182; g = 178; b = 172;
      }
    }
    // Lush summer green tree canopies on left & right
    if (dist(x, y, 68, 92) < 54 || dist(x, y, 252, 88) < 56) {
      r = 46; g = 138; b = 52;
    }
    // White porch facade in center
    if (x >= 122 && x <= 198 && y >= 78 && y <= 144) {
      r = 242; g = 238; b = 232;
    }
    return [r, g, b];
  });

  // 13. Low-Res 180×180 Compressed Portrait Fallback
  const lowResPortraitBuf = encodeRgbPng(180, 180, (x, y, w, h) => {
    const bx = Math.floor(x / 4) * 4;
    const by = Math.floor(y / 4) * 4;
    const d = dist(bx, by, w / 2, h * 0.44);
    if (d < 42) return [218, 168, 138];
    if (by > h * 0.65 && Math.abs(bx - w / 2) < 58) return [236, 228, 212];
    return [168, 134, 82];
  });

  // 14. 2025 Holiday Card Template Fallback (640×480)
  const holidayCard2025Buf = encodeRgbPng(640, 480, (x, y, w, h) => {
    if (x < 36 || x > w - 36 || y < 28 || y > h - 28) return [214, 206, 194];
    if (x < 56 || x > w - 56 || y < 48 || y > h - 48) return [42, 92, 58];
    return [248, 244, 236];
  });

  return {
    smartEraseBeach: {
      id: 'sample-beach-photobomber',
      name: 'coastal-family-with-orange-bin-photobomber.png',
      mimeType: 'image/png',
      label: 'Coastal Family Portrait with Beach Clutter',
      data: beachBuf.toString('base64'),
    },
    storybookFox: {
      id: 'sample-char-fox',
      name: 'ref-1-character-red-fox-blue-scarf.png',
      mimeType: 'image/png',
      label: 'Explorer Fox Character Reference',
      data: foxBuf.toString('base64'),
    },
    storybookStyle: {
      id: 'sample-style-watercolor',
      name: 'ref-2-watercolor-pine-palette.png',
      mimeType: 'image/png',
      label: 'Watercolor Pine Forest Style Reference',
      data: styleBuf.toString('base64'),
    },
    storybookLantern: {
      id: 'sample-prop-lantern',
      name: 'ref-3-golden-brass-lantern.png',
      mimeType: 'image/png',
      label: 'Vintage Brass Woodland Lantern Prop',
      data: lanternBuf.toString('base64'),
    },
    lowResCabinThumb: {
      id: 'sample-lowres-cabin-thumb',
      name: 'lowres-160x120-pixelated-alpine-cabin.png',
      mimeType: 'image/png',
      label: 'Pixelated Alpine Cabin Thumbnail',
      data: lowResCabinBuf.toString('base64'),
    },
    squareLighthouseCrop: {
      id: 'sample-square-lighthouse-crop',
      name: 'tight-1x1-square-lighthouse-crop.png',
      mimeType: 'image/png',
      label: 'Square Coastal Lighthouse Crop',
      data: lighthouseBuf.toString('base64'),
    },
    scratchedVintagePhoto: {
      id: 'sample-scratched-vintage-photo',
      name: 'vintage-sepia-creased-heirloom-photo.png',
      mimeType: 'image/png',
      label: 'Damaged Vintage Sepia Family Portrait',
      data: vintageBuf.toString('base64'),
    },
    glareGlassesPortrait: {
      id: 'sample-glare-glasses-portrait',
      name: 'indoor-portrait-eyeglass-flash-glare.png',
      mimeType: 'image/png',
      label: 'Indoor Portrait with Eyeglass Flash Glare',
      data: glareBuf.toString('base64'),
    },
    clutteredDeskMug: {
      id: 'sample-cluttered-desk-mug',
      name: 'ceramic-mug-with-desk-clutter-cables.png',
      mimeType: 'image/png',
      label: 'Handcrafted Terracotta Mug on Desk',
      data: deskMugBuf.toString('base64'),
    },
    botanicalPatternNavyGold: {
      id: 'sample-botanical-pattern-navy-gold',
      name: 'repeat-floral-pattern-navy-gold-swatch.png',
      mimeType: 'image/png',
      label: 'Botanical & Geometric Pattern Swatch',
      data: patternBuf.toString('base64'),
    },
    crimsonThrowPillow: {
      id: 'sample-crimson-throw-pillow',
      name: 'crimson-red-knit-pillow-sku.png',
      mimeType: 'image/png',
      label: 'Crimson Cable-Knit Throw Pillow',
      data: pillowBuf.toString('base64'),
    },
    summerPorchScene: {
      id: 'sample-summer-porch-scene',
      name: 'summer-midday-green-trees-porch.png',
      mimeType: 'image/png',
      label: 'Craftsman Porch in Summer Foliage',
      data: summerPorchBuf.toString('base64'),
    },
    lowResPortraitThumb: {
      id: 'sample-lowres-portrait-thumb',
      name: 'lowres-180x180-compressed-portrait.jpg',
      mimeType: 'image/png',
      label: 'Compressed Studio Portrait',
      data: lowResPortraitBuf.toString('base64'),
    },
    holidayCard2025Template: {
      id: 'sample-holiday-card-2025-template',
      name: 'holiday-card-2025-template.jpg',
      mimeType: 'image/png',
      label: 'Holiday Greeting Card Template',
      data: holidayCard2025Buf.toString('base64'),
    },
  };
})();

// ---------------------------------------------------------------------------
// Pre-Loaded Industry & Use-Case Packs (100% Generic / Team-Safe UI Labels)
// ---------------------------------------------------------------------------
const IMAGE_USE_CASE_PACKS = [
  {
    id: 'upscaling-resampling',
    title: '🔍 Super-Resolution & Outpainting',
    badge: 'Super-Resolution & Outpainting',
    subcategories: [
      { id: 'super-res', label: '🔬 4K Super-Resolution Upscaling' },
      { id: 'outpaint-print', label: '🖼️ Outpainting & Large-Format Print' },
    ],
    scenarios: [
      {
        id: 'lowres-to-4k-upscale',
        subcategory: 'super-res',
        title: 'Low-Resolution Landscape to 4K Print Upscale',
        badge: '4K Super-Resolution',
        recommendedSize: '4K',
        recommendedAspectRatio: '4:3',
        prompt: 'Perform a strict, lossless super-resolution upscale of the attached photograph to 4K print-ready resolution without changing any aspect of the image. Do not add, remove, reframe, crop, restyle, or alter any subjects, faces, expressions, pets, clothing, fabrics, colors, lighting, shadows, or background geometry. Strictly preserve the exact pixel layout, color palette, cabin structure, roofline, glowing window, shoreline trees, mountain ridge, and water reflections 100% identical to the original photo - only eliminate pixelation, compression blockiness, and blur to restore crisp, natural optical sharpness.',
        whyItMatters: 'Evaluates lossless generative super-resolution for rescuing low-DPI uploads so they pass 300-DPI preflight checks for wall canvases and photo books.',
        sampleAttachments: ['lowResCabinThumb'],
      },
      {
        id: 'portrait-color-science-4k-upscale',
        subcategory: 'super-res',
        title: 'Identity-Locked Portrait & Fabric 4K Super-Resolution',
        badge: '4K Portrait Upscale',
        recommendedSize: '4K',
        recommendedAspectRatio: '1:1',
        prompt: 'Perform a strict, identity-locked 4K super-resolution upscale of the attached portrait without changing any aspect of the person, pets, clothing, or scene. Treat the subject’s facial features, expression, smile, eye shape, iris color, eyeglasses, eyebrows, hair strands, skin tone, cable-knit sweater weave, colors, lighting, and framing as strictly locked to the original photograph. Do not beautify, age, de-age, restyle, relight, or plastic-smooth the face - only remove JPEG compression blockiness, mosquito noise, and blur to restore natural optical sharpness, fine hair strands, and crisp fabric weave 100% faithful to the original image.',
        whyItMatters: 'Validates skin-tone accuracy, natural hair and pore micro-detail, and zero plastic smoothing when upscaling compressed portraits to 4K print DPI.',
        sampleAttachments: ['lowResPortraitThumb'],
      },
      {
        id: 'aspect-ratio-resampling',
        subcategory: 'outpaint-print',
        title: 'Panoramic Aspect-Ratio Outpainting',
        badge: '1:1 to 16:9 Outpainting',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Outpaint and extend the borders of the attached photograph to fill the target 16:9 panoramic aspect ratio while keeping the entire original image 100% intact, untouched, and unmodified in the center. Do not alter, relight, restyle, rescale, or regenerate any subjects, faces, clothing, structures, colors, textures, or details inside the original frame (keep the red-and-white striped lighthouse, basalt cliff, and ocean base pixel-identical to the input). Seamlessly extend only the surrounding coastline, ocean waves, and sky outward beyond the original borders with zero visible seams.',
        whyItMatters: 'Tests aspect-ratio expansion and border outpainting when fitting square mobile photos into full-bleed 16:9 panoramic spreads or banners.',
        sampleAttachments: ['squareLighthouseCrop'],
      },
      {
        id: 'dpi-canvas-resampling',
        subcategory: 'outpaint-print',
        title: '300-DPI Large-Format Architectural Canvas Synthesis',
        badge: 'Native 4K Print',
        recommendedSize: '4K',
        recommendedAspectRatio: '16:9',
        prompt: 'Generate an ultra-high-resolution 4K (300-DPI print-ready) architectural and botanical photograph of a traditional Kyoto autumn courtyard garden at dawn. Render microscopic surface detail in the wet moss-covered stepping stones, hand-raked gravel ripples, crimson Japanese maple leaves, and warm cedar joinery engineered for a 36x24 inch metallic or canvas wall print. (If a reference image is attached, perform a strict 4K super-resolution upscale preserving all original subjects, faces, fabrics, colors, and framing 100% as-is.)',
        whyItMatters: 'Compares 1K, 2K, and 4K native output token fidelity and micro-texture sharpness in the 1:1 pixel viewer.',
        sampleAttachments: [],
      },
    ],
  },
  {
    id: 'cleaning-restoration',
    title: '🧹 Photo Restoration & Smart Cleanup',
    badge: 'Restoration & Cleanup',
    subcategories: [
      { id: 'distraction-erase', label: '✨ Distraction & Clutter Removal' },
      { id: 'heritage-retouch', label: '🎞️ Archival Restoration & Retouching' },
    ],
    scenarios: [
      {
        id: 'smart-erase-conversational',
        subcategory: 'distraction-erase',
        title: 'Mask-Free Distraction & Power-Line Removal',
        badge: 'Conversational Smart Erase',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Edit the attached photograph by removing ONLY the bright neon-orange trash bin on the right side of the beach and the dark overhead utility power wires across the upper sky. Treat the two people on the left (their faces, expressions, hair, skin tones, jackets, pants, shoes, poses, scale, and positions) and the rest of the coastal scene as a strictly locked, untouched pixel mask. Do not alter, relight, rescale, or re-render the people or their clothing in any way - only inpaint the exact background pixels where the orange bin and overhead wires were removed with matching sand, ocean waves, and sunset sky.',
        whyItMatters: 'Evaluates mask-free conversational photo cleanup by removing background clutter and utility lines while locking subject identity and lighting.',
        sampleAttachments: ['smartEraseBeach'],
      },
      {
        id: 'cluttered-desk-cleanup',
        subcategory: 'distraction-erase',
        title: 'Product Isolation & Studio Tabletop Cleanup',
        badge: 'Object Isolation',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Treat the centerpiece handcrafted terracotta ceramic mug as a strictly locked, untouched pixel cutout at its exact original position, scale, angle, and lighting - do not alter its shape, rim, handle, speckled glaze texture, or terracotta color. Remove only the surrounding desk clutter (the yellow sticky notes on the left, green plastic bottle on the right, and black cable in the foreground) and replace the messy surface behind and beneath the mug with a clean, sunlit honed marble tabletop and soft studio background.',
        whyItMatters: 'Transforms casual tabletop product snapshots into clean, catalog-ready studio imagery without manual clipping paths.',
        sampleAttachments: ['clutteredDeskMug'],
      },
      {
        id: 'vintage-photo-restoration',
        subcategory: 'heritage-retouch',
        title: 'Vintage Print Crease, Scratch & Color Restoration',
        badge: 'Archival Restoration',
        recommendedSize: '2K',
        recommendedAspectRatio: '4:3',
        prompt: 'Restore the attached damaged vintage photograph by repairing only the white diagonal paper fold creases, surface scratches, dust specks, and corner staining. Strictly preserve 100% of the original subjects’ exact facial features, expressions, eye shapes, eyeglasses, hairstyles, clothing, collars, poses, framing, and proportions without altering or modernizing their faces or outfits. Faithfully reconstruct only the damaged pixels along the paper creases and restore natural, balanced daylight color while keeping every person’s identity and appearance completely true to the original photo.',
        whyItMatters: 'Validates automated archival photo repair and colorization for heritage photo books and family anniversary albums.',
        sampleAttachments: ['scratchedVintagePhoto'],
      },
      {
        id: 'glare-shadow-cleanup',
        subcategory: 'heritage-retouch',
        title: 'Eyeglass Flash Glare & Color-Cast Correction',
        badge: 'Portrait Retouching',
        recommendedSize: '2K',
        recommendedAspectRatio: '4:3',
        prompt: 'Retouch the attached indoor portrait by removing ONLY the bright white/green camera flash reflection glare inside the eyeglass lenses and neutralizing the yellow indoor tungsten color cast to clean natural daylight. Keep the subject’s exact facial features, eye shape, expression, wrinkles, skin texture, eyeglass frame geometry, hair strands, clothing, fabric weave, pose, and framing 100% identical and untouched - do not alter the person’s identity, face shape, or outfit in any way.',
        whyItMatters: 'Tests portrait retouching on event photos and portraits affected by eyeglass flash reflections and indoor tungsten lighting casts.',
        sampleAttachments: ['glareGlassesPortrait'],
      },
    ],
  },
  {
    id: 'recoloring-restyling',
    title: '🎨 Colorway Studio & Scene Relighting',
    badge: 'Colorways & Relighting',
    subcategories: [
      { id: 'textile-sku', label: '🧵 Textile & Product SKU Colorways' },
      { id: 'scene-relight', label: '🌅 Scene Relighting & Background Swap' },
    ],
    scenarios: [
      {
        id: 'pattern-colorway-recoloring',
        subcategory: 'textile-sku',
        title: 'Surface Pattern & Textile Colorway Recoloring',
        badge: 'Pattern Colorway Studio',
        recommendedSize: '2K',
        recommendedAspectRatio: '1:1',
        prompt: 'Recolor ONLY the color palette of the attached repeat botanical floral and geometric wallpaper/textile pattern from Navy Blue and Mustard Gold into warm Autumn Terracotta, Sage Green, Dusty Rose, and Warm Cream. Treat all pattern outlines, floral rosette geometry, leaf veins, diamond lattice lines, motif positions, scale, and seamless repeat layout as 100% locked and pixel-identical to the original image - do not redraw, shift, add, or remove any pattern elements.',
        whyItMatters: 'Powers custom fabric, wallpaper, and home-decor catalogs by generating seasonal colorway variants from a single surface pattern without altering motif geometry.',
        sampleAttachments: ['botanicalPatternNavyGold'],
      },
      {
        id: 'sku-colorway-swap',
        subcategory: 'textile-sku',
        title: 'Home Goods & Apparel SKU Colorway Swap',
        badge: 'SKU Recoloring',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Change ONLY the fabric color of the attached crimson-red woven knit throw pillow into a rich Heathered Forest Emerald Green with subtle Champagne Gold edge piping. Keep the pillow’s exact shape, dimensions, placement, individual cable-knit stitch geometry, fabric fold shadows, and the entire surrounding oat-linen sofa and room background 100% untouched and pixel-identical to the original photograph.',
        whyItMatters: 'Eliminates physical studio reshoots when launching new seasonal SKU colorways across pillows, textiles, drinkware, and apparel.',
        sampleAttachments: ['crimsonThrowPillow'],
      },
      {
        id: 'seasonal-relighting',
        subcategory: 'scene-relight',
        title: 'Seasonal Foliage & Golden-Hour Relighting',
        badge: 'Seasonal Relighting',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Recolor and relight only the seasonal foliage and sky lighting of the attached summer midday porch photograph into an October Autumn Golden Hour setting: transform the green tree canopies into amber, copper, and crimson fall leaves and add warm sunset lighting while keeping the white Craftsman porch architecture, columns, railings, stone steps, roofline, camera angle, and framing 100% identical to the original photo.',
        whyItMatters: 'Demonstrates semantic scene recoloring and relighting to adapt evergreen catalog photography for seasonal campaigns.',
        sampleAttachments: ['summerPorchScene'],
      },
      {
        id: 'winter-wonderland-bg-swap',
        subcategory: 'scene-relight',
        title: 'Identity-Locked Winter Scene Background Replacement',
        badge: 'Locked Foreground Swap',
        recommendedSize: '2K',
        recommendedAspectRatio: '1:1',
        prompt: 'Treat all foreground subjects (every person, pet, face, and body from head to toe) as a strictly locked, read-only pixel mask at their exact original position, scale, and framing. Do NOT re-render, rescale, relight, smooth, or modify any facial features, wrinkles, smiles, teeth, eyeglasses, hair strands, fur, skin tones, jackets, sweaters, logos, zippers, scarves, purses, or shoes. Keep the foreground subjects 100% pixel-identical to the input photo with the exact same neutral daylight on their faces, and replace ONLY the background behind them with a scenic snow-covered evergreen pine forest and winter trail. Do not add falling snowflakes or lighting casts in front of the subjects.',
        whyItMatters: 'Replaces the background scene while locking foreground facial features, expressions, eyeglasses, and clothing without drift.',
        sampleAttachments: ['lowResPortraitThumb'],
      },
    ],
  },
  {
    id: 'print-photobooks',
    title: '📸 Print, Photo Books & Stationery',
    badge: 'Print & Stationery',
    subcategories: [
      { id: 'stationery-cards', label: '💌 Cards, Invitations & Typography' },
      { id: 'photobooks-art', label: '📚 Storybooks, Stickers & Wall Art' },
    ],
    scenarios: [
      {
        id: 'holiday-card-typography',
        subcategory: 'stationery-cards',
        title: 'Greeting Card Template Year Refresh & Typography',
        badge: 'Card Template Refresh',
        recommendedSize: '2K',
        recommendedAspectRatio: '4:3',
        prompt: 'Modernize the attached "2025" holiday greeting card template for the 2026 season by updating ONLY the year reference from "2025" to "2026" (so the card reads "WARMEST WISHES · THE MILLER FAMILY · 2026") while keeping the entire card layout, textured warm cream cotton cardstock, gold-foil botanical pine and berry borders, font family, letter kerning, gold-foil embossing, card placement, and natural tabletop shadows 100% pixel-identical to the original 2025 template.',
        whyItMatters: 'Automates annual template updates across stationery catalogs while preserving cardstock textures, foil borders, and kerning.',
        sampleAttachments: ['holidayCard2025Template'],
      },
      {
        id: 'wedding-invitation-suite',
        subcategory: 'stationery-cards',
        title: 'Letterpress Wedding Invitation Suite & Foil Typography',
        badge: 'Letterpress Stationery',
        recommendedSize: '2K',
        recommendedAspectRatio: '3:4',
        prompt: 'Overhead editorial flat-lay photograph of a luxury letterpress wedding invitation suite on handmade deckle-edge cotton paper with wax seal, dried olive branches, and silk ribbon. Render crisp debossed serif typography reading:\n"SOPHIA LAURENT & ETHAN VANCE"\n"SATURDAY, OCTOBER 24, 2026"\n"VILLA CIMBRONE · RAVELLO, ITALY"\n"RECEPTION TO FOLLOW IN THE BELVEDERE GARDENS"',
        whyItMatters: 'Benchmarks fine stationery layout composition, debossed foil texture realism, and multi-line formal invitation typography.',
        sampleAttachments: [],
      },
      {
        id: 'multi-image-storybook',
        subcategory: 'photobooks-art',
        title: 'Multi-Reference Storybook Character & Style Consistency',
        badge: 'Multi-Reference Consistency',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Using the 3 attached reference images, illustrate a cohesive two-page children’s photo-book spread while strictly preserving the exact visual identity of each reference: (1) keep the red fox explorer’s exact facial features, eye shape, black ear tips, white cheek patches, and cobalt-blue scarf with gold stars 100% identical to Reference 1; (2) match the exact pastel sage watercolor and gouache pine forest palette and brushwork of Reference 2; and (3) preserve the exact vintage brass woodland lantern geometry and warm golden glow from Reference 3. Show the exact same fox character holding the brass lantern on a snowy woodland bridge at twilight with a clean header reading "Chapter 3 · The Winter Lantern".',
        whyItMatters: 'Tests multi-image subject and style locking across reference inputs so multi-page photo books maintain consistent characters and props.',
        sampleAttachments: ['storybookFox', 'storybookStyle', 'storybookLantern'],
      },
      {
        id: 'persistent-custom-stickers',
        subcategory: 'photobooks-art',
        title: 'Character-Locked Die-Cut Sticker Sheet Generation',
        badge: 'Die-Cut Sticker Sheet',
        recommendedSize: '2K',
        recommendedAspectRatio: '1:1',
        prompt: 'Using the attached explorer fox character reference image, generate a cohesive sheet of 6 die-cut vinyl photo-book stickers and scrapbook embellishments on a clean light-gray studio backing. Strictly preserve 100% of the character’s exact facial features, eye shape, fur color, black ear tips, white cheek patches, and cobalt-blue scarf with gold stars from the reference image across all 6 stickers - do not alter the character’s facial structure or outfit. Show the exact same character in 6 playful poses (waving, holding a camera, sipping hot cocoa, wearing a winter beanie, framing a photo border, and a "2026 Family Memories" badge), each with a crisp white kiss-cut sticker border.',
        whyItMatters: 'Generates character-locked die-cut sticker packs and scrapbook embellishments from a single character reference image.',
        sampleAttachments: ['storybookFox'],
      },
      {
        id: 'print-4k-upscale',
        subcategory: 'photobooks-art',
        title: 'Fine-Art Alpine Gallery Wall Canvas Generation',
        badge: 'Native 4K Wall Art',
        recommendedSize: '4K',
        recommendedAspectRatio: '16:9',
        prompt: 'Ultra-high-resolution fine-art gallery canvas photograph of an autumn alpine lake at sunrise in the Dolomites. Capture razor-sharp 300-DPI micro-texture in the weathered wooden boat planks in the foreground, individual frost crystals on shoreline pine needles, mirror-like water reflections, and subtle linen canvas weave suitable for a 36x24 inch large-format wall print.',
        whyItMatters: 'Demonstrates native 4K generation for large-format wall art and photo books, preventing blurry upscaling.',
        sampleAttachments: [],
      },
    ],
  },
  {
    id: 'retail-ecommerce',
    title: '🛍️ Retail, Packaging & Brand Key Art',
    badge: 'Retail & Brand Studio',
    subcategories: [
      { id: 'lifestyle-staging', label: '🛋️ Product Lifestyle Staging' },
      { id: 'packaging-keyart', label: '📦 Packaging & Campaign Key Art' },
    ],
    scenarios: [
      {
        id: 'retail-lifestyle-staging',
        subcategory: 'lifestyle-staging',
        title: 'Kitchen Counter Product Lifestyle Staging & Promo Badge',
        badge: 'Lifestyle Staging',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Treat the centerpiece handcrafted terracotta ceramic mug from the attached photo as a strictly locked, untouched product cutout - keep its exact shape, rim, handle geometry, speckled glaze texture, terracotta color, scale, and position 100% identical to the original photo. Replace only the cluttered desk background around the mug with a sunlit Scandinavian oak kitchen counter lifestyle scene featuring fresh croissants, linen napkins, and an espresso machine, and render a clean promotional badge in the upper-right corner reading "AUTUMN ROAST EVENT · SAVE 25% · CODE: ESPRESSO26".',
        whyItMatters: 'Replaces physical studio reshoots with seasonal lifestyle staging and localized promotional badge typography.',
        sampleAttachments: ['clutteredDeskMug'],
      },
      {
        id: 'personalized-plaque-lifestyle',
        subcategory: 'lifestyle-staging',
        title: 'Living Room Home-Decor & Gift SKU Staging',
        badge: 'Home Decor Staging',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Treat the attached crimson-red woven cable-knit throw pillow SKU as a strictly locked, untouched product cutout - keep its exact crimson color, cable-knit stitch geometry, fabric folds, shape, and proportions 100% identical to the input photo. Stage the surrounding environment into a warm, modern apartment living room lifestyle scene alongside a 5x7 wooden desktop photo plaque and warm fairy lights on an oak shelf, and render a clean promotional campaign badge in the upper-right corner reading "PERSONALIZED HOME & GIFT EVENT · 50% OFF".',
        whyItMatters: 'Places customized home-decor and gift SKUs into targeted lifestyle scenes with promotional badge copy.',
        sampleAttachments: ['crimsonThrowPillow'],
      },
      {
        id: 'retail-packaging-mockup',
        subcategory: 'packaging-keyart',
        title: 'Botanical Serum Bottle Packaging & Label Proofing',
        badge: '4K Label Proofing',
        recommendedSize: '4K',
        recommendedAspectRatio: '1:1',
        prompt: 'Macro studio product photograph of an amber glass botanical serum bottle standing on wet slate stone with water droplets. The matte cream paper label must legibly display: "LUMIÈRE BOTANICALS · HYALURONIC + VITAMIN C SERUM · 30 ML / 1.0 FL OZ · MADE IN CALIFORNIA".',
        whyItMatters: 'Validates fine-print packaging legibility and specular glass and liquid reflections at 4K resolution.',
        sampleAttachments: [],
      },
      {
        id: 'media-key-art',
        subcategory: 'packaging-keyart',
        title: 'Theatrical Sci-Fi Key Art Poster & Title Credits',
        badge: 'Key Art & Credits',
        recommendedSize: '2K',
        recommendedAspectRatio: '3:4',
        prompt: 'Cinematic sci-fi theatrical movie poster showing a lone astronaut standing on a crystalline ridge overlooking a ringed gas giant in deep teal and amber anamorphic lighting. Render bold metallic title typography at the top reading "HORIZON OF TITAN" and a crisp subtitle at the bottom reading "EXPERIENCE IT IN IMAX · NOVEMBER 2026".',
        whyItMatters: 'Benchmarks dramatic lighting composition paired with multi-line display typography.',
        sampleAttachments: [],
      },
    ],
  },
  {
    id: 'custom-image-prompt',
    title: '✏️ Custom Image Prompt',
    badge: 'Custom Studio',
    subcategories: [],
    scenarios: [
      {
        id: 'custom-freeform',
        title: 'Custom Generation or Multi-Image Edit',
        badge: 'Custom Prompt',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: '',
        whyItMatters: 'Write any custom generation, upscaling, outpainting, restoration, or recoloring prompt and attach up to 13 reference images.',
        sampleAttachments: [],
      },
    ],
  },
];

function getImageCatalogEntry(id) {
  return IMAGE_MODEL_CATALOG.find((m) => m.id === id || m.model === id) || null;
}

function getHydratedUseCasePacks() {
  return IMAGE_USE_CASE_PACKS.map((pack) => ({
    ...pack,
    scenarios: pack.scenarios.map((sc) => ({
      ...sc,
      attachments: (sc.sampleAttachments || [])
        .map((key) => SAMPLE_REFERENCE_ASSETS[key])
        .filter(Boolean),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Parse `candidates[0].content.parts` from Vertex AI Image models.
//
// CRITICAL FOR `gemini-nano-banana-2.1`:
// When called with `responseModalities: ["TEXT", "IMAGE"]`, Nano Banana 2.1
// emits TWO `inlineData` PNG parts:
//   • `part[0]` with `thought: true`  (a 1K visual-reasoning draft image)
//   • `part[1]` with `thought: false` (the final 1K / 2K / 4K output image!)
// We extract the final non-thought image as the primary result and preserve
// `thoughtImage` so the UI can offer a 1-click "Inspect Visual Thinking Draft" toggle.
// ---------------------------------------------------------------------------
function extractImageResponseParts(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const imageParts = list.filter((p) => p && p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data.length > 0);
  const nonThoughtImages = imageParts.filter((p) => p.thought !== true);
  const thoughtImages = imageParts.filter((p) => p.thought === true);

  // The final image is ONLY ever a non-thought part. When the model produced a
  // visual-thinking draft but the final image was blocked or never arrived, the
  // slot must fail (with the block reason) instead of presenting the 1K draft
  // as the 4K result the user asked and paid for.
  const finalImagePart = nonThoughtImages.length > 0
    ? nonThoughtImages[nonThoughtImages.length - 1]
    : null;

  const thoughtImagePart = thoughtImages.length > 0 ? thoughtImages[0] : null;

  const text = list
    .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('\n')
    .trim();

  const reasoning = list
    .filter((p) => p && typeof p.text === 'string' && p.thought === true)
    .map((p) => p.text)
    .join('\n')
    .trim();

  return {
    finalImagePart,
    thoughtImagePart,
    text,
    reasoning,
  };
}

function computeImageSlotEconomics(catalogEntry, usageMetadata, requestedSize) {
  const u = usageMetadata || {};
  const p = (catalogEntry && catalogEntry.pricing) || {
    inputPerM: 0.50,
    imageOutputPerM: 60.00,
    textOutputPerM: 3.00,
    offPeakDiscount: 0,
  };

  let promptTokens = 0;
  let reasoningTokens = 0;
  let imageOutputTokens = 0;
  let textOutputTokens = 0;
  let totalTokens = 0;
  let inputCostUsd = 0;
  // 'usage' when the provider reported token counts; 'reference' when a successful
  // generation came back without any usage block, in which case the catalog's
  // per-image reference price is billed instead of $0 (the image was still made).
  let costBasis = 'usage';

  const hasOpenAIUsage = typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number';
  const hasVertexUsage = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount']
    .some((k) => typeof u[k] === 'number') || (Array.isArray(u.candidatesTokensDetails) && u.candidatesTokensDetails.length > 0);

  if (hasOpenAIUsage) {
    // OpenAI /v1/images usage schema:
    // { input_tokens, output_tokens, total_tokens, input_tokens_details: { text_tokens, image_tokens }, output_tokens_details: { image_tokens, text_tokens } }
    const inDetails = u.input_tokens_details || {};
    const outDetails = u.output_tokens_details || {};
    const textInputTokens = Number(inDetails.text_tokens) || 0;
    const imageInputTokens = Number(inDetails.image_tokens) || 0;
    promptTokens = Number(u.input_tokens) || (textInputTokens + imageInputTokens);
    imageOutputTokens = Number(outDetails.image_tokens) || Number(u.output_tokens) || 0;
    textOutputTokens = Number(outDetails.text_tokens) || 0;
    reasoningTokens = 0;
    totalTokens = Number(u.total_tokens) || (promptTokens + imageOutputTokens + textOutputTokens);

    if (p.imageInputPerM != null && (textInputTokens > 0 || imageInputTokens > 0)) {
      inputCostUsd = (textInputTokens / 1_000_000) * p.inputPerM + (imageInputTokens / 1_000_000) * p.imageInputPerM;
    } else {
      inputCostUsd = (promptTokens / 1_000_000) * p.inputPerM;
    }
  } else if (hasVertexUsage) {
    // Vertex AI usageMetadata schema
    promptTokens = Number(u.promptTokenCount) || 0;
    reasoningTokens = Number(u.thoughtsTokenCount) || 0;
    const details = Array.isArray(u.candidatesTokensDetails) ? u.candidatesTokensDetails : [];

    for (const d of details) {
      if (!d || typeof d.tokenCount !== 'number') continue;
      if (String(d.modality || '').toUpperCase() === 'IMAGE') imageOutputTokens += d.tokenCount;
      else if (String(d.modality || '').toUpperCase() === 'TEXT') textOutputTokens += d.tokenCount;
    }
    if (imageOutputTokens === 0 && textOutputTokens === 0) {
      imageOutputTokens = Number(u.candidatesTokenCount) || 0;
    }
    totalTokens = Number(u.totalTokenCount) || (promptTokens + imageOutputTokens + textOutputTokens + reasoningTokens);
    inputCostUsd = (promptTokens / 1_000_000) * p.inputPerM;
  } else {
    costBasis = 'reference';
  }

  const imageOutputCostUsd = (imageOutputTokens / 1_000_000) * p.imageOutputPerM;
  const textAndThinkingCostUsd = ((textOutputTokens + reasoningTokens) / 1_000_000) * p.textOutputPerM;
  const ref = (p.referenceCostBySize && typeof p.referenceCostBySize === 'object') ? p.referenceCostBySize : {};
  const referenceCostUsd = Number(ref[requestedSize]) || Number(ref['2K']) || Number(ref['1K']) || 0;
  const standardPayGoCostUsd = costBasis === 'reference'
    ? referenceCostUsd
    : inputCostUsd + imageOutputCostUsd + textAndThinkingCostUsd;
  const offPeakDiscount = Number(p.offPeakDiscount) || 0;
  const offPeakPayGoCostUsd = standardPayGoCostUsd * (1 - offPeakDiscount);

  // Baseline comparison against Nano Banana 2 (`gemini-3.1-flash-image` @ $60/1M image tokens)
  const nb2BaselinePerImage = ({ '1K': 0.0672, '2K': 0.1008, '4K': 0.1512 })[requestedSize] || 0.1008;
  const savingsVsNanoBanana2Pct = nb2BaselinePerImage > 0
    ? Math.round(((nb2BaselinePerImage - standardPayGoCostUsd) / nb2BaselinePerImage) * 100)
    : 0;
  const offPeakSavingsVsNanoBanana2Pct = nb2BaselinePerImage > 0
    ? Math.round(((nb2BaselinePerImage - offPeakPayGoCostUsd) / nb2BaselinePerImage) * 100)
    : 0;

  return {
    promptTokens,
    imageOutputTokens,
    textOutputTokens,
    reasoningTokens,
    totalTokens,
    costBasis,
    standardPayGoCostUsd,
    standardPayGoPer1kUsd: standardPayGoCostUsd * 1000,
    offPeakPayGoCostUsd,
    offPeakPayGoPer1kUsd: offPeakPayGoCostUsd * 1000,
    offPeakSupported: offPeakDiscount > 0,
    offPeakDiscountPct: Math.round(offPeakDiscount * 100),
    savingsVsNanoBanana2Pct,
    offPeakSavingsVsNanoBanana2Pct,
  };
}

// OpenAI GPT Image 2 / 2.5 support 16px-aligned dimensions within a hard
// 8,294,400-pixel budget (3840x2160 = 2880x2880 = 8.29 MP).
const OPENAI_IMAGE_DIMENSIONS = {
  '1K': {
    '1:1': '1024x1024',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '16:9': '1280x720',
    '9:16': '720x1280',
  },
  '2K': {
    '1:1': '2048x2048',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
  },
  '4K': {
    '1:1': '2880x2880',
    '4:3': '3200x2400',
    '3:4': '2400x3200',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
  },
};

function resolveOpenAIImageSize(sizeId, aspectRatio) {
  const tier = OPENAI_IMAGE_DIMENSIONS[sizeId] || OPENAI_IMAGE_DIMENSIONS['2K'];
  return tier[aspectRatio] || tier['16:9'] || '1024x1024';
}

// Image generations are non-streaming: headers only arrive once the image is
// rendered (a 4K Nano Banana call can take a couple of minutes), so every call
// raises the provider header timeout well above the streaming default.
const IMAGE_TIMEOUT_MS = 300000;
// Wall-clock budget for ONE slot including every fallback step (alternate
// project, projectless alias, 4K -> 2K -> 1K cascade). Checked before each step
// so a slow upstream cannot chain five multi-minute generations.
const IMAGE_SLOT_DEADLINE_MS = 240000;
// Per reference image: base64 length cap (~9 MB of pixels) and MIME allow-list.
const MAX_REFERENCE_IMAGE_B64_CHARS = 12 * 1024 * 1024;
const REFERENCE_IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif)$/i;

const imageFetch = (url, init) => providerFetch(url, { timeoutMs: IMAGE_TIMEOUT_MS, ...init });

function slotDeadline(entry, t0) {
  return (stage) => {
    const elapsed = Date.now() - t0;
    if (elapsed <= IMAGE_SLOT_DEADLINE_MS) return;
    throw new Error(`${entry.label} gave up after ${Math.round(elapsed / 1000)}s: no time left for ${stage} (per-slot limit ${Math.round(IMAGE_SLOT_DEADLINE_MS / 1000)}s).`);
  };
}

// Sniff the container from the first base64 bytes when the declared MIME is missing.
function sniffImageMime(b64) {
  const head = String(b64 || '').slice(0, 16);
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return null;
}

// Validate the user's reference images up front: count, per-image size and MIME.
// Returns [{ mimeType, data }] with the data-URL prefix stripped.
function validateReferenceImages(entry, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length > entry.maxReferenceImages) {
    throw new Error(`${entry.label} accepts at most ${entry.maxReferenceImages} reference images (${list.length} attached).`);
  }
  const out = [];
  list.forEach((att, idx) => {
    if (!att || typeof att.data !== 'string' || !att.data) return; // empty slots are skipped, as before
    const rawB64 = att.data.replace(/^data:[^;]+;base64,/, '');
    if (rawB64.length > MAX_REFERENCE_IMAGE_B64_CHARS) {
      throw new Error(`Reference image ${idx + 1}${att.name ? ` (${String(att.name).slice(0, 80)})` : ''} is too large: ${(rawB64.length / (1024 * 1024)).toFixed(1)} MB encoded, limit ${MAX_REFERENCE_IMAGE_B64_CHARS / (1024 * 1024)} MB. Downscale it and try again.`);
    }
    const declared = String(att.mimeType || '').trim().toLowerCase();
    const mimeType = REFERENCE_IMAGE_MIME_RE.test(declared) ? declared : (declared ? null : sniffImageMime(rawB64));
    if (!mimeType) {
      throw new Error(`Reference image ${idx + 1}${att.name ? ` (${String(att.name).slice(0, 80)})` : ''} has an unsupported type${declared ? ` "${declared.slice(0, 60)}"` : ''}: only PNG, JPEG, WebP and GIF are accepted.`);
    }
    out.push({ mimeType, data: rawB64 });
  });
  return out;
}

// A safety / moderation rejection is final for the prompt: retrying the same
// prompt at a smaller size (the 4K -> 2K -> 1K cascade) or on another project
// would only produce the same block, each time billed as a request.
function isModerationError(j) {
  const e = j && typeof j === 'object' ? (j.error || j) : null;
  if (!e || typeof e !== 'object') return false;
  const blob = [e.code, e.type, e.status, e.message, e.reason, j && j.promptFeedback && j.promptFeedback.blockReason]
    .filter((v) => v != null).map((v) => String(v)).join(' ');
  return /moderation_blocked|content_policy|safety|prohibited|blocked|usage guidelines|responsible ai|harm|violat/i.test(blob);
}

// Read a JSON body exactly once. A parse failure on an OK response fails the
// slot: the generation was made and billed, and re-invoking `sendFn()` would
// silently buy a second one.
async function readJsonBody(sendFn, signal) {
  const r = await sendFn();
  let rawText = '';
  try {
    rawText = await r.text();
  } catch (bodyErr) {
    if (signal && signal.aborted) throw bodyErr;
    if (!r.ok) return { r, j: {} };
    throw new Error(`Response stream interrupted while downloading the image payload (${(bodyErr && bodyErr.message) || 'truncated body'}); the generation was not retried.`);
  }
  if (!rawText || !rawText.trim()) return { r, j: {} };
  try {
    return { r, j: JSON.parse(rawText) };
  } catch (parseErr) {
    if (!r.ok) return { r, j: {} };
    throw new Error(`Image provider returned an unreadable payload (${(parseErr && parseErr.message) || 'invalid JSON'}, ${rawText.length} chars); the generation was not retried.`);
  }
}

async function runOpenAIImageSlot({ slot, entry, prompt, aspectRatio, imageSize, refs, keys, signal, auditUser }) {
  const { buildUpstreamAttribution } = require('./providers');
  const attr = buildUpstreamAttribution(auditUser);
  // Strict BYOK: the user's own OpenAI key (when supplied) is the ONLY key used
  // for this slot - the shared key is never a default, retry or fallback.
  const ownOpenAIKey = byok.userCredential('openai', keys);
  let oaKey = ownOpenAIKey
    || globalKeys.get('OPENAI_API_KEY')
    || process.env.OPENAI_API_KEY;
  if (!oaKey && typeof globalKeys.refreshAll === 'function') {
    await globalKeys.refreshAll().catch(() => {});
    oaKey = globalKeys.get('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  }
  if (!oaKey) {
    throw new Error('Missing OPENAI_API_KEY in environment (.env) or Settings.');
  }

  let effectiveSize = (Array.isArray(entry.supportedSizes) && imageSize && !entry.supportedSizes.includes(imageSize))
    ? entry.supportedSizes[0]
    : (imageSize || '2K');
  const validAspect = aspectRatio || '16:9';
  const promptText = String(prompt || '').trim() || 'Generate a high-resolution studio image.';
  // Reference images were validated (count, size, MIME) in runSingleImageSlot.
  const safeAtts = Array.isArray(refs) ? refs : [];

  const sendOpenAIRequest = async (sizeTier) => {
    const oaSize = resolveOpenAIImageSize(sizeTier, validAspect);
    if (safeAtts.length > 0) {
      const form = new FormData();
      form.append('model', entry.model);
      form.append('prompt', promptText);
      form.append('n', '1');
      form.append('size', oaSize);
      form.append('quality', 'high');
      if (attr && attr.openaiUser) form.append('user', attr.openaiUser);
      const fieldName = safeAtts.length > 1 ? 'image[]' : 'image';
      safeAtts.forEach((att, idx) => {
        const mimeType = att.mimeType;
        const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const buf = Buffer.from(att.data, 'base64');
        form.append(fieldName, new Blob([buf], { type: mimeType }), `ref-${idx}.${ext}`);
      });
      return imageFetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${oaKey}` },
        body: form,
        signal,
      });
    }
    const genPayload = {
      model: entry.model,
      prompt: promptText,
      n: 1,
      size: oaSize,
      quality: 'high',
    };
    if (attr && attr.openaiUser) genPayload.user = attr.openaiUser;
    return imageFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${oaKey}`,
      },
      body: JSON.stringify(genPayload),
      signal,
    });
  };

  const t0 = Date.now();
  const checkDeadline = slotDeadline(entry, t0);
  let { r, j } = await readJsonBody(() => sendOpenAIRequest(effectiveSize), signal);
  // A moderation / content-policy block is final: never re-run the prompt smaller.
  if (r.status === 400 && effectiveSize !== '1K' && !isModerationError(j)) {
    const fallbackOrder = effectiveSize === '4K' ? ['2K', '1K'] : ['1K'];
    for (const fbTier of fallbackOrder) {
      checkDeadline(`the ${fbTier} fallback`);
      const fb = await readJsonBody(() => sendOpenAIRequest(fbTier), signal);
      if (fb.r.ok) {
        r = fb.r;
        j = fb.j;
        effectiveSize = fbTier;
        break;
      }
      if (fb.r.status !== 400 || isModerationError(fb.j)) {
        r = fb.r;
        j = fb.j;
        break;
      }
    }
  }

  const latencyMs = Date.now() - t0;
  if (!r.ok) {
    const errMsg = (j && j.error && j.error.message) || JSON.stringify(j).slice(0, 320);
    const err = new Error(`OpenAI ${r.status} for "${entry.model}": ${scrubError(errMsg)}`);
    if (isModerationError(j)) err.code = 'IMAGE_BLOCKED';
    throw err;
  }

  const firstItem = (j && Array.isArray(j.data) && j.data[0]) || null;
  let finalB64 = firstItem && typeof firstItem.b64_json === 'string' ? firstItem.b64_json : '';
  if (!finalB64 && firstItem && typeof firstItem.url === 'string' && firstItem.url) {
    // A plain GET of the rendered file: safe to retry after a header timeout.
    const imgRes = await imageFetch(firstItem.url, { method: 'GET', signal, idempotent: true });
    if (imgRes.ok) {
      const arrBuf = await imgRes.arrayBuffer();
      finalB64 = Buffer.from(arrBuf).toString('base64');
    }
  }
  if (!finalB64) {
    const detail = (j && j.error && j.error.message) || (firstItem && firstItem.revised_prompt) || '';
    throw new Error(`Model "${entry.model}" returned no image data${detail ? ': ' + scrubError(String(detail)).slice(0, 200) : '.'}`);
  }

  const finalMime = (j.output_format === 'jpeg' ? 'image/jpeg' : j.output_format === 'webp' ? 'image/webp' : 'image/png');
  const dims = imageDimensionsFromBase64(finalB64) || { width: null, height: null };
  const megapixels = (dims.width && dims.height)
    ? Number(((dims.width * dims.height) / 1_000_000).toFixed(2))
    : null;
  const byteLength = Math.floor((finalB64.length * 3) / 4);
  const econ = computeImageSlotEconomics(entry, j.usage, effectiveSize);

  return {
    slot,
    ok: true,
    catalogId: entry.id,
    label: entry.label,
    shortLabel: entry.shortLabel,
    model: entry.model,
    modelVersion: entry.model,
    provider: entry.provider || 'openai',
    publisher: entry.publisher || 'openai',
    providerFamily: entry.providerFamily || 'openai',
    releaseBadge: entry.releaseBadge,
    slaBadge: entry.slaBadge,
    slaPct: entry.slaPct,
    endpointBadge: entry.endpointBadge,
    architectureGuidance: entry.architectureGuidance,
    requestedSize: effectiveSize,
    requestedAspectRatio: validAspect,
    mimeType: finalMime,
    imageDataUrl: `data:${finalMime};base64,${finalB64}`,
    width: dims.width,
    height: dims.height,
    megapixels,
    byteLength,
    hasThoughtImage: false,
    thoughtImageDataUrl: null,
    thoughtDims: null,
    text: (firstItem && firstItem.revised_prompt) || '',
    reasoning: '',
    latencyMs,
    ...econ,
  };
}

async function runSingleImageSlot({ slot, catalogId, prompt, aspectRatio, imageSize, attachments, keys, signal, auditUser }) {
  const entry = getImageCatalogEntry(catalogId);
  if (!entry) {
    throw new Error(`Unknown image model "${catalogId}".`);
  }
  // Count, per-image size and MIME allow-list are enforced before any key is read
  // or any upstream request is built (a rejected reference costs nothing).
  const refs = validateReferenceImages(entry, attachments);

  if (entry.provider === 'openai') {
    return runOpenAIImageSlot({ slot, entry, prompt, aspectRatio, imageSize, refs, keys, signal, auditUser });
  }
  const { buildUpstreamAttribution } = require('./providers');
  const attr = buildUpstreamAttribution(auditUser);

  // Strict BYOK: the user's own Vertex key (when supplied) is the ONLY key used
  // and is only ever paired with the user's own project (or the projectless
  // alias, which bills the key's own project) - never a shared key/project.
  const ownVertexKey = byok.userCredential('vertexKey', keys);
  let key = ownVertexKey
    || globalKeys.get('AGENT_PLATFORM_API_KEY')
    || globalKeys.get('GEMINI_API_KEY')
    || process.env.AGENT_PLATFORM_API_KEY
    || process.env.GEMINI_API_KEY;
  if (!key && typeof globalKeys.refreshAll === 'function') {
    await globalKeys.refreshAll().catch(() => {});
    key = globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY') || process.env.AGENT_PLATFORM_API_KEY || process.env.GEMINI_API_KEY;
  }
  if (!key) {
    throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env) or Settings.');
  }

  const candidateProjects = ownVertexKey
    ? [byok.userProject(keys)].filter(Boolean)
    : Array.from(new Set([
      process.env.AGENT_PLATFORM_PROJECT_NUMBER || '',
      '419460847694',
      process.env.GCP_PROJECT_ID || '',
    ].filter(Boolean)));

  const userParts = [];
  for (const att of refs) {
    userParts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
  }
  userParts.push({ text: String(prompt || '').trim() || 'Generate a high-resolution studio image.' });

  let effectiveSize = (Array.isArray(entry.supportedSizes) && imageSize && !entry.supportedSizes.includes(imageSize))
    ? entry.supportedSizes[0]
    : (imageSize || '2K');

  const buildPayload = (sizeOverride = effectiveSize) => {
    const imageConfig = { aspectRatio: aspectRatio || '16:9' };
    if (sizeOverride) imageConfig.imageSize = sizeOverride;
    const bodyObj = {
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig,
      },
    };
    if (attr && attr.vertexLabels) bodyObj.labels = attr.vertexLabels;
    return JSON.stringify(bodyObj);
  };

  const buildGlobalProjectUrl = (proj) =>
    `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/google/models/${encodeURIComponent(entry.model)}:generateContent`;
  const shortPublisherUrl =
    `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${encodeURIComponent(entry.model)}:generateContent`;

  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  const payloadStr = buildPayload(effectiveSize);
  const t0 = Date.now();
  const checkDeadline = slotDeadline(entry, t0);
  const post = (url, body) => imageFetch(url, { method: 'POST', headers, body, signal });

  // Own key without an own project -> straight to the projectless alias.
  let usedUrl = candidateProjects.length
    ? buildGlobalProjectUrl(candidateProjects[0])
    : (ownVertexKey ? shortPublisherUrl : buildGlobalProjectUrl(DEFAULT_IMAGE_PROJECT_NUMBER));
  let { r, j } = await readJsonBody(() => post(usedUrl, payloadStr), signal);

  // If the key belongs to another candidate project (e.g., GCP_PROJECT_ID when a custom key is mounted),
  // try remaining candidate /locations/global project endpoints next.
  for (let i = 1; i < candidateProjects.length && (r.status === 403 || r.status === 404); i++) {
    checkDeadline('an alternate project endpoint');
    const altUrl = buildGlobalProjectUrl(candidateProjects[i]);
    const fbAlt = await readJsonBody(() => post(altUrl, payloadStr), signal);
    if (fbAlt.r.ok || fbAlt.r.status === 400) {
      r = fbAlt.r;
      j = fbAlt.j;
      usedUrl = altUrl;
      break;
    }
  }

  // If a custom BYOK key belongs to a different project number (403/404 on project path),
  // fall back automatically to the projectless publisher path.
  if ((r.status === 403 || r.status === 404) && usedUrl !== shortPublisherUrl) {
    checkDeadline('the projectless publisher endpoint');
    const fb = await readJsonBody(() => post(shortPublisherUrl, payloadStr), signal);
    if (fb.r.ok || fb.r.status === 400) {
      r = fb.r;
      j = fb.j;
      usedUrl = shortPublisherUrl;
    }
  }

  // Safety net: if a model rejects 2K/4K with HTTP 400, cascade down 4K -> 2K -> 1K.
  // A safety / moderation block is final for this prompt and is never retried smaller.
  if (r.status === 400 && effectiveSize !== '1K' && !isModerationError(j)) {
    const fallbackOrder = effectiveSize === '4K' ? ['2K', '1K'] : ['1K'];
    for (const fbTier of fallbackOrder) {
      checkDeadline(`the ${fbTier} fallback`);
      const retryFb = await readJsonBody(() => post(usedUrl, buildPayload(fbTier)), signal);
      if (retryFb.r.ok) {
        r = retryFb.r;
        j = retryFb.j;
        effectiveSize = fbTier;
        break;
      }
      if (retryFb.r.status !== 400 || isModerationError(retryFb.j)) {
        r = retryFb.r;
        j = retryFb.j;
        break;
      }
    }
  }

  const latencyMs = Date.now() - t0;
  if (!r.ok) {
    const errMsg = (j && j.error && j.error.message) || JSON.stringify(j).slice(0, 320);
    const err = new Error(`Vertex AI ${r.status} for "${entry.model}": ${scrubError(errMsg)}`);
    if (isModerationError(j)) err.code = 'IMAGE_BLOCKED';
    throw err;
  }

  const candidate = (j.candidates && j.candidates[0]) || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const extracted = extractImageResponseParts(parts);

  if (!extracted.finalImagePart) {
    // Say WHY there is no final image: a prompt-level block (promptFeedback), a
    // candidate-level stop (finishReason / finishMessage), or simply no image part.
    // A thought-only response is reported here too, never promoted to the result.
    const pf = (j && j.promptFeedback) || {};
    const reasons = [];
    if (pf.blockReason) reasons.push(`prompt blocked: ${String(pf.blockReason)}${pf.blockReasonMessage ? ` - ${String(pf.blockReasonMessage).slice(0, 160)}` : ''}`);
    if (candidate.finishReason) reasons.push(`finish reason: ${String(candidate.finishReason)}${candidate.finishMessage ? ` - ${String(candidate.finishMessage).slice(0, 160)}` : ''}`);
    if (extracted.thoughtImagePart) reasons.push('only a visual-thinking draft was produced, no final image');
    if (!reasons.length) reasons.push('NO_IMAGE');
    const detail = extracted.text ? `: ${extracted.text.slice(0, 180)}` : '';
    const err = new Error(`Model "${entry.model}" returned no image (${scrubError(reasons.join('; '))})${scrubError(detail)}`);
    err.code = 'IMAGE_NOT_RETURNED';
    if (pf.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i.test(String(candidate.finishReason || ''))) err.code = 'IMAGE_BLOCKED';
    throw err;
  }

  const finalMime = extracted.finalImagePart.inlineData.mimeType || 'image/png';
  const finalB64 = extracted.finalImagePart.inlineData.data;
  const dims = imageDimensionsFromBase64(finalB64) || { width: null, height: null };
  const megapixels = (dims.width && dims.height)
    ? Number(((dims.width * dims.height) / 1_000_000).toFixed(2))
    : null;
  const byteLength = Math.floor((finalB64.length * 3) / 4);

  let thoughtImageDataUrl = null;
  let thoughtDims = null;
  if (extracted.thoughtImagePart) {
    const tMime = extracted.thoughtImagePart.inlineData.mimeType || 'image/png';
    const tB64 = extracted.thoughtImagePart.inlineData.data;
    thoughtImageDataUrl = `data:${tMime};base64,${tB64}`;
    thoughtDims = imageDimensionsFromBase64(tB64) || null;
  }

  const econ = computeImageSlotEconomics(entry, j.usageMetadata, effectiveSize);

  return {
    slot,
    ok: true,
    catalogId: entry.id,
    label: entry.label,
    shortLabel: entry.shortLabel,
    model: entry.model,
    modelVersion: j.modelVersion || entry.model,
    provider: entry.provider || 'agentplatform',
    publisher: entry.publisher || 'google',
    providerFamily: entry.providerFamily || 'google',
    releaseBadge: entry.releaseBadge,
    slaBadge: entry.slaBadge,
    slaPct: entry.slaPct,
    endpointBadge: entry.endpointBadge,
    architectureGuidance: entry.architectureGuidance,
    requestedSize: effectiveSize,
    requestedAspectRatio: aspectRatio || '16:9',
    mimeType: finalMime,
    imageDataUrl: `data:${finalMime};base64,${finalB64}`,
    width: dims.width,
    height: dims.height,
    megapixels,
    byteLength,
    hasThoughtImage: Boolean(thoughtImageDataUrl),
    thoughtImageDataUrl,
    thoughtDims,
    text: extracted.text,
    reasoning: extracted.reasoning,
    latencyMs,
    ...econ,
  };
}

async function runImageArenaComparison({ slots, prompt, aspectRatio = '16:9', imageSize = '2K', attachments = [], keys = {}, signal, auditUser }) {
  const validAspect = IMAGE_ASPECT_RATIOS.some((a) => a.id === aspectRatio) ? aspectRatio : '16:9';
  const validSize = IMAGE_RESOLUTIONS.some((s) => s.id === imageSize) ? imageSize : '2K';

  const requestedSlots = Array.isArray(slots) && slots.length
    ? slots.slice(0, 4)
    : DEFAULT_IMAGE_SLOTS;

  // A slot with no model falls back to catalog order. An ID that isn't in the catalog
  // (e.g. a retired model sent by a stale page) fails on its own slot instead of silently
  // running a different model.
  const normalizedSlots = requestedSlots.map((s, idx) => {
    const slotId = String((s && s.slot) || String.fromCharCode(65 + idx)).slice(0, 4);
    const requested = s && s.catalogId ? String(s.catalogId).slice(0, 100) : '';
    return { slot: slotId, catalogId: requested || IMAGE_MODEL_CATALOG[idx % IMAGE_MODEL_CATALOG.length].id };
  });

  const results = await Promise.all(
    normalizedSlots.map(async (s) => {
      try {
        return await runSingleImageSlot({
          slot: s.slot,
          catalogId: s.catalogId,
          prompt,
          aspectRatio: validAspect,
          imageSize: validSize,
          attachments,
          keys,
          signal,
          auditUser,
        });
      } catch (e) {
        const entry = getImageCatalogEntry(s.catalogId);
        return {
          slot: s.slot,
          ok: false,
          catalogId: entry ? entry.id : s.catalogId,
          label: entry ? entry.label : s.catalogId,
          shortLabel: entry ? entry.shortLabel : s.catalogId,
          model: entry ? entry.model : s.catalogId,
          provider: entry ? entry.provider : '',
          publisher: entry ? entry.publisher : '',
          providerFamily: entry ? entry.providerFamily : '',
          slaBadge: entry ? entry.slaBadge : '',
          endpointBadge: entry ? entry.endpointBadge : '',
          error: scrubError(String((e && e.message) || e)),
        };
      }
    })
  );

  return {
    ok: true,
    at: Date.now(),
    aspectRatio: validAspect,
    imageSize: validSize,
    referenceCount: Array.isArray(attachments) ? attachments.length : 0,
    results,
  };
}

function getImageArenaConfig() {
  return {
    ok: true,
    catalog: IMAGE_MODEL_CATALOG,
    defaultSlots: DEFAULT_IMAGE_SLOTS,
    resolutions: IMAGE_RESOLUTIONS,
    aspectRatios: IMAGE_ASPECT_RATIOS,
    packs: getHydratedUseCasePacks(),
  };
}

module.exports = {
  IMAGE_MODEL_CATALOG,
  DEFAULT_IMAGE_SLOTS,
  IMAGE_RESOLUTIONS,
  IMAGE_ASPECT_RATIOS,
  SAMPLE_REFERENCE_ASSETS,
  getImageArenaConfig,
  extractImageResponseParts,
  computeImageSlotEconomics,
  resolveOpenAIImageSize,
  runSingleImageSlot,
  runImageArenaComparison,
};
