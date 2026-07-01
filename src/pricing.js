// ---------------------------------------------------------------------------
// Pricing & default model configuration
//
// Prices are USD per 1,000,000 tokens. These are PLACEHOLDERS — update them to
// the live published prices for the exact models you are demoing. The whole
// point of this tool is that the numbers are real, so verify before showing a
// customer. (Cost is also editable live in the UI.)
// ---------------------------------------------------------------------------

const PRICING = {
  gemini:    { input: 1.50, output: 9.00 },   // Gemini 3.5 Flash (May 2026)
  openai:    { input: 2.50, output: 10.00 },  // e.g. a GPT-5-class model
  anthropic: { input: 5.00, output: 25.00 },  // Claude Opus 4.8 (price is a placeholder — verify)
};

// The default slots shown in the UI. Slots are DYNAMIC — the UI can add or
// remove them (min 1, max 6), so this is just the starting set. `label` is
// cosmetic; `model` is the exact API model id; `price` overrides the provider
// default above. All editable in the UI before a run.
const DEFAULT_MODELS = [
  // Both run through Google Agent Platform (Vertex). publisher = google | anthropic.
  // Prices are USD per 1M tokens — PLACEHOLDERS, verify before a customer demo.
  { slot: 'A', label: 'Gemini 3.5 Flash', provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.5-flash', price: { input: 1.50, output: 9.00 } },
  // Claude via Vertex uses GCP_PROJECT_ID (set it in .env / Cloud Run env), or a per-slot `project`.
  { slot: 'B', label: 'Claude Opus 4.8',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-8', price: { input: 5.00, output: 25.00 } },
  // Add more in the UI with “+ Add model”, e.g. Gemini 3.1 Pro:
  // { slot: 'C', label: 'Gemini 3.1 Pro (preview)', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.1-pro-preview', price: { input: 2.00, output: 12.00 } },
];

function priceFor(cfg) {
  if (cfg && cfg.price && (cfg.price.input != null) && (cfg.price.output != null)) return cfg.price;
  return PRICING[cfg && cfg.provider] || { input: 0, output: 0 };
}

module.exports = { PRICING, DEFAULT_MODELS, priceFor };
