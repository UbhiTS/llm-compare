// ---------------------------------------------------------------------------
// Image & GenMedia Arena — Vertex AI Nano Banana (Gemini Image) Benchmark Engine
//
// Compares Vertex AI native multimodal image generation & conversational editing
// models side-by-side:
//   • Gemini Nano Banana 2.1 (`gemini-nano-banana-2.1` — GA Oct 6, 2026)
//   • Gemini Nano Banana 2   (`gemini-3.1-flash-image` — GA High-Throughput)
//   • Gemini Nano Banana Pro (`gemini-3-pro-image`     — GA Complex Reasoning)
//   • Gemini Nano Banana 1   (`gemini-2.5-flash-image` — Legacy 1K Baseline)
//
// Grounded in live Vertex AI endpoint behavior & official pricing:
//   https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing#nano-banana
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image
// ---------------------------------------------------------------------------

const zlib = require('zlib');
const { providerFetch } = require('./providerFetch');
const globalKeys = require('./globalKeys');
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
    releaseDate: '2026-02-26',
    releaseBadge: 'GA · High-Throughput Regional + Global',
    slaBadge: '99.5% Long-Term GA SLA',
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
    architectureGuidance: 'Primary synchronous checkout & regional (US/EU) workload engine backed by the 99.5% Long-Term GA SLA.',
  },
  {
    id: 'gemini-nano-banana-2.1',
    label: 'Gemini Nano Banana 2.1 (GA Oct 6, 2026)',
    shortLabel: 'Nano Banana 2.1',
    model: 'gemini-nano-banana-2.1',
    family: 'Nano Banana 2.1',
    releaseDate: '2026-10-06',
    releaseBadge: 'GA Oct 6, 2026 · ~50% Lower Cost + 4K + Visual Thinking',
    slaBadge: '95.0% Short-Term GA SLA',
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
    id: 'gemini-3-pro-image',
    label: 'Gemini Nano Banana Pro (3 Pro Image)',
    shortLabel: 'Nano Banana Pro',
    model: 'gemini-3-pro-image',
    family: 'Nano Banana Pro',
    releaseDate: '2025-11-20',
    releaseBadge: 'GA · Deep Visual Reasoning',
    slaBadge: '99.5% Long-Term GA SLA',
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
    id: 'gemini-2.5-flash-image',
    label: 'Gemini Nano Banana 1 (2.5 Flash Image Legacy)',
    shortLabel: 'Nano Banana 1 (Legacy)',
    model: 'gemini-2.5-flash-image',
    family: 'Nano Banana 1',
    releaseDate: '2025-08-26',
    releaseBadge: 'Legacy · Fixed 1K Resolution Ceiling',
    slaBadge: '99.5% GA SLA (Legacy)',
    slaPct: 99.5,
    endpointBadge: 'Regional + Global',
    supportedSizes: ['1K'],
    maxReferenceImages: 3,
    contextWindow: 32768,
    pricing: {
      inputPerM: 0.30,
      imageOutputPerM: 30.00,
      textOutputPerM: 2.50,
      offPeakDiscount: 0,
      referenceCostBySize: { '1K': 0.0387, '2K': 0.0387, '4K': 0.0387 },
    },
    purchasingTiers: ['Standard PayGo'],
    architectureGuidance: 'Legacy generation baseline — capped at 1K (1344×768) even when 2K/4K is requested, and limited to 3 reference images.',
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

  return {
    smartEraseBeach: {
      id: 'sample-beach-photobomber',
      name: 'coastal-family-with-orange-bin-photobomber.png',
      mimeType: 'image/png',
      label: 'Coastal Portrait + Orange Bin & Wire Distraction',
      data: beachBuf.toString('base64'),
    },
    storybookFox: {
      id: 'sample-char-fox',
      name: 'ref-1-character-red-fox-blue-scarf.png',
      mimeType: 'image/png',
      label: 'Ref 1 · Explorer Fox Character (Blue/Gold Scarf)',
      data: foxBuf.toString('base64'),
    },
    storybookStyle: {
      id: 'sample-style-watercolor',
      name: 'ref-2-watercolor-pine-palette.png',
      mimeType: 'image/png',
      label: 'Ref 2 · Storybook Watercolor Pine Style',
      data: styleBuf.toString('base64'),
    },
    storybookLantern: {
      id: 'sample-prop-lantern',
      name: 'ref-3-golden-brass-lantern.png',
      mimeType: 'image/png',
      label: 'Ref 3 · Glowing Brass Lantern Prop',
      data: lanternBuf.toString('base64'),
    },
  };
})();

// ---------------------------------------------------------------------------
// Pre-Loaded Industry & Use-Case Packs (100% Generic / Team-Safe UI Labels)
// ---------------------------------------------------------------------------
const IMAGE_USE_CASE_PACKS = [
  {
    id: 'print-photobooks',
    title: '📸 Print, Photo Books & Personalized Stationery',
    badge: 'Print & Consumer Photo',
    scenarios: [
      {
        id: 'holiday-card-typography',
        title: '1. Holiday Card & Multilingual Typography Modernization ("2026")',
        badge: 'Typography & Template Refresh',
        recommendedSize: '2K',
        recommendedAspectRatio: '4:3',
        prompt: 'Design a luxury press-printed holiday greeting card flat-lay on textured warm cotton cardstock with delicate gold-foil botanical pine and eucalyptus borders. Render crisp, zero-typo serif and calligraphy typography centered on the card reading:\n"Warmest Wishes"\n"The Miller Family · 2026"\n"Joyeux Noël · Feliz Navidad · Frohe Weihnachten"\nInclude soft natural morning window shadows and print-ready kerning.',
        whyItMatters: 'Tests automated template year-reference modernization ("2025" → "2026") and multilingual glyph accuracy across Latin diacritics without manual designer re-typesetting.',
        sampleAttachments: [],
      },
      {
        id: 'print-4k-upscale',
        title: '2. 4K (16.9 MP) Print Super-Resolution & Wall-Art Canvas Detail',
        badge: 'Native 4K · 5504×3072 (16.9 MP)',
        recommendedSize: '4K',
        recommendedAspectRatio: '16:9',
        prompt: 'Ultra-high-resolution fine-art gallery canvas photograph of an autumn alpine lake at sunrise in the Dolomites. Capture razor-sharp 300-DPI micro-texture in the weathered wooden boat planks in the foreground, individual frost crystals on shoreline pine needles, mirror-like water reflections, and subtle linen canvas weave suitable for a 36×24 inch large-format wall print.',
        whyItMatters: 'Demonstrates true 4K (5504×3072 = 16.9 MP) generation for large-format wall art and photo books—preventing blurry upscaling and reducing physical print reprints.',
        sampleAttachments: [],
      },
      {
        id: 'smart-erase-conversational',
        title: '3. Smart Erase — Conversational Object & Photobomber Removal (No Mask)',
        badge: '1-Click Built-In Reference Photo',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Edit the attached coastal family portrait: completely remove the bright neon-orange trash bin on the right side of the beach and remove the dark overhead utility power wires across the top sky. Reconstruct natural ocean waves, golden sunset sky, and smooth sandy beach lighting while keeping the two family figures on the left intact.',
        whyItMatters: 'Shows mask-free conversational photo cleanup (Smart Erase) — removing background clutter, power lines, and photobombers while preserving subject identity and scene lighting.',
        sampleAttachments: ['smartEraseBeach'],
      },
      {
        id: 'multi-image-storybook',
        title: '4. Multi-Image Character & Style Consistency (Up to 13 Reference Inputs)',
        badge: '3 Built-In Reference Images Loaded',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Using the 3 attached reference images — (1) the red fox explorer character wearing the blue and gold scarf, (2) the pastel sage watercolor pine forest style, and (3) the glowing brass lantern prop — illustrate a cohesive two-page children’s photo-book spread where the exact same fox character holds the glowing brass lantern on a snowy woodland bridge at twilight. Include a storybook page header reading "Chapter 3 · The Winter Lantern".',
        whyItMatters: 'Tests multi-image subject and style locking across up to 13 reference images (64K context window) so multi-page photo books and calendars maintain consistent characters.',
        sampleAttachments: ['storybookFox', 'storybookStyle', 'storybookLantern'],
      },
    ],
  },
  {
    id: 'retail-ecommerce',
    title: '🛍️ Retail & E-Commerce Product Studio',
    badge: 'Retail & Catalog',
    scenarios: [
      {
        id: 'retail-lifestyle-staging',
        title: '1. Virtual Lifestyle Staging & Seasonal Catalog Localization',
        badge: 'Catalog Automation',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: 'Commercial studio lifestyle photograph of an espresso machine on a sunlit Scandinavian oak kitchen counter surrounded by fresh croissants, linen napkins, and ceramic cups. In the upper-right corner, render a clean minimalist promotional badge reading "AUTUMN ROAST EVENT · SAVE 25% · CODE: ESPRESSO26".',
        whyItMatters: 'Replaces expensive physical studio reshoots with instant seasonal lifestyle staging and localized promotional badge typography.',
        sampleAttachments: [],
      },
      {
        id: 'retail-packaging-mockup',
        title: '2. 4K Packaging & Label Micro-Typography Inspection',
        badge: '4K Label Proofing',
        recommendedSize: '4K',
        recommendedAspectRatio: '1:1',
        prompt: 'Macro studio product photograph of an amber glass botanical serum bottle standing on wet slate stone with water droplets. The matte cream paper label must legibly display: "LUMIÈRE BOTANICALS · HYALURONIC + VITAMIN C SERUM · 30 ML / 1.0 FL OZ · MADE IN CALIFORNIA".',
        whyItMatters: 'Validates fine-print packaging legibility and specular glass/liquid reflections at 4K resolution.',
        sampleAttachments: [],
      },
    ],
  },
  {
    id: 'media-posters',
    title: '🎬 Media, Brand Typography & Campaign Posters',
    badge: 'Media & Agency',
    scenarios: [
      {
        id: 'media-key-art',
        title: '1. Cinematic Key Art Poster with Multi-Line Title Credits',
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
    title: '✏️ Custom Prompt & Reference Image Upload (Up to 13 Images)',
    badge: 'Freeform Studio',
    scenarios: [
      {
        id: 'custom-freeform',
        title: 'Freeform Image Generation or Multi-Image Conversational Edit',
        badge: 'Custom Prompt + Up to 13 Reference Photos',
        recommendedSize: '2K',
        recommendedAspectRatio: '16:9',
        prompt: '',
        whyItMatters: 'Write any custom generation or editing prompt and attach up to 13 reference images.',
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

  const finalImagePart = nonThoughtImages.length > 0
    ? nonThoughtImages[nonThoughtImages.length - 1]
    : (imageParts[imageParts.length - 1] || null);

  const thoughtImagePart = (thoughtImages.length > 0 && thoughtImages[0] !== finalImagePart)
    ? thoughtImages[0]
    : null;

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
  const promptTokens = Number(u.promptTokenCount) || 0;
  const reasoningTokens = Number(u.thoughtsTokenCount) || 0;
  const details = Array.isArray(u.candidatesTokensDetails) ? u.candidatesTokensDetails : [];

  let imageOutputTokens = 0;
  let textOutputTokens = 0;
  for (const d of details) {
    if (!d || typeof d.tokenCount !== 'number') continue;
    if (String(d.modality || '').toUpperCase() === 'IMAGE') imageOutputTokens += d.tokenCount;
    else if (String(d.modality || '').toUpperCase() === 'TEXT') textOutputTokens += d.tokenCount;
  }
  if (imageOutputTokens === 0 && textOutputTokens === 0) {
    imageOutputTokens = Number(u.candidatesTokenCount) || 0;
  }
  const totalTokens = Number(u.totalTokenCount) || (promptTokens + imageOutputTokens + textOutputTokens + reasoningTokens);

  const p = (catalogEntry && catalogEntry.pricing) || {
    inputPerM: 0.50,
    imageOutputPerM: 60.00,
    textOutputPerM: 3.00,
    offPeakDiscount: 0,
  };

  const inputCostUsd = (promptTokens / 1_000_000) * p.inputPerM;
  const imageOutputCostUsd = (imageOutputTokens / 1_000_000) * p.imageOutputPerM;
  const textAndThinkingCostUsd = ((textOutputTokens + reasoningTokens) / 1_000_000) * p.textOutputPerM;
  const standardPayGoCostUsd = inputCostUsd + imageOutputCostUsd + textAndThinkingCostUsd;
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

async function runSingleImageSlot({ slot, catalogId, prompt, aspectRatio, imageSize, attachments, keys, signal }) {
  const entry = getImageCatalogEntry(catalogId) || IMAGE_MODEL_CATALOG[0];
  const key = (keys && (keys.agentplatform || keys.gemini))
    || globalKeys.get('AGENT_PLATFORM_API_KEY')
    || globalKeys.get('GEMINI_API_KEY')
    || process.env.AGENT_PLATFORM_API_KEY
    || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env) or Settings.');
  }

  const projNum = (keys && keys.gcpProject)
    || process.env.AGENT_PLATFORM_PROJECT_NUMBER
    || DEFAULT_IMAGE_PROJECT_NUMBER;

  const userParts = [];
  const safeAtts = Array.isArray(attachments) ? attachments.slice(0, entry.maxReferenceImages || 13) : [];
  for (const att of safeAtts) {
    if (!att || typeof att.data !== 'string' || !att.data) continue;
    const rawB64 = att.data.replace(/^data:[^;]+;base64,/, '');
    const mimeType = /^image\/(png|jpeg|webp|gif)$/i.test(String(att.mimeType || ''))
      ? att.mimeType
      : 'image/png';
    userParts.push({ inlineData: { mimeType, data: rawB64 } });
  }
  userParts.push({ text: String(prompt || '').trim() || 'Generate a high-resolution studio image.' });

  const buildPayload = (includeSize = true) => {
    const imageConfig = { aspectRatio: aspectRatio || '16:9' };
    if (includeSize && imageSize) imageConfig.imageSize = imageSize;
    return JSON.stringify({
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig,
      },
    });
  };

  const globalProjectUrl =
    `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(projNum)}` +
    `/locations/global/publishers/google/models/${encodeURIComponent(entry.model)}:generateContent`;
  const altProjectId = process.env.GCP_PROJECT_ID && process.env.GCP_PROJECT_ID !== projNum
    ? process.env.GCP_PROJECT_ID
    : null;
  const altGlobalProjectUrl = altProjectId
    ? `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(altProjectId)}/locations/global/publishers/google/models/${encodeURIComponent(entry.model)}:generateContent`
    : null;
  const shortPublisherUrl =
    `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${encodeURIComponent(entry.model)}:generateContent`;

  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  const t0 = Date.now();

  let usedUrl = globalProjectUrl;
  let r = await providerFetch(usedUrl, {
    method: 'POST',
    headers,
    body: buildPayload(true),
    signal,
  });

  // If the key belongs to GCP_PROJECT_ID (e.g., llm-compare-ubhits on Cloud Run) instead of 419460847694,
  // try the GCP_PROJECT_ID /locations/global endpoint next.
  if ((r.status === 403 || r.status === 404) && altGlobalProjectUrl) {
    const fbAlt = await providerFetch(altGlobalProjectUrl, {
      method: 'POST',
      headers,
      body: buildPayload(true),
      signal,
    });
    if (fbAlt.ok || fbAlt.status === 400) {
      r = fbAlt;
      usedUrl = altGlobalProjectUrl;
    }
  }

  // If a custom BYOK key belongs to a different project number (403/404 on project path),
  // fall back automatically to the projectless publisher path.
  if (r.status === 403 || r.status === 404) {
    const fb = await providerFetch(shortPublisherUrl, {
      method: 'POST',
      headers,
      body: buildPayload(true),
      signal,
    });
    if (fb.ok || fb.status === 400) {
      r = fb;
      usedUrl = shortPublisherUrl;
    }
  }

  // If a legacy model rejects `imageSize` with HTTP 400, retry once with `{ aspectRatio }` only.
  if (r.status === 400) {
    const fbSize = await providerFetch(usedUrl, {
      method: 'POST',
      headers,
      body: buildPayload(false),
      signal,
    });
    if (fbSize.ok) r = fbSize;
  }

  const latencyMs = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errMsg = (j && j.error && j.error.message) || JSON.stringify(j).slice(0, 320);
    throw new Error(`Vertex AI ${r.status} for "${entry.model}": ${scrubError(errMsg)}`);
  }

  const candidate = (j.candidates && j.candidates[0]) || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const extracted = extractImageResponseParts(parts);

  if (!extracted.finalImagePart) {
    const finishReason = candidate.finishReason || 'NO_IMAGE';
    throw new Error(`Model "${entry.model}" returned no image (${finishReason})${extracted.text ? ': ' + extracted.text.slice(0, 180) : ''}`);
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

  const econ = computeImageSlotEconomics(entry, j.usageMetadata, imageSize || '2K');

  return {
    slot,
    ok: true,
    catalogId: entry.id,
    label: entry.label,
    shortLabel: entry.shortLabel,
    model: entry.model,
    modelVersion: j.modelVersion || entry.model,
    releaseBadge: entry.releaseBadge,
    slaBadge: entry.slaBadge,
    slaPct: entry.slaPct,
    endpointBadge: entry.endpointBadge,
    architectureGuidance: entry.architectureGuidance,
    requestedSize: imageSize || '2K',
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

async function runImageArenaComparison({ slots, prompt, aspectRatio = '16:9', imageSize = '2K', attachments = [], keys = {}, signal }) {
  const validAspect = IMAGE_ASPECT_RATIOS.some((a) => a.id === aspectRatio) ? aspectRatio : '16:9';
  const validSize = IMAGE_RESOLUTIONS.some((s) => s.id === imageSize) ? imageSize : '2K';

  const requestedSlots = Array.isArray(slots) && slots.length
    ? slots.slice(0, 4)
    : DEFAULT_IMAGE_SLOTS;

  const normalizedSlots = requestedSlots.map((s, idx) => {
    const slotId = String((s && s.slot) || String.fromCharCode(65 + idx)).slice(0, 4);
    const entry = getImageCatalogEntry(s && s.catalogId) || IMAGE_MODEL_CATALOG[idx % IMAGE_MODEL_CATALOG.length];
    return { slot: slotId, catalogId: entry.id };
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
        });
      } catch (e) {
        const entry = getImageCatalogEntry(s.catalogId) || IMAGE_MODEL_CATALOG[0];
        return {
          slot: s.slot,
          ok: false,
          catalogId: entry.id,
          label: entry.label,
          shortLabel: entry.shortLabel,
          model: entry.model,
          slaBadge: entry.slaBadge,
          endpointBadge: entry.endpointBadge,
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
  runSingleImageSlot,
  runImageArenaComparison,
};
