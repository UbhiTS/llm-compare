// ---------------------------------------------------------------------------
// Pricing & model catalog
//
// Users may ONLY pick from a fixed catalog of preconfigured models (Google
// Model Garden). Model ids, provider/publisher and per-token prices are locked
// here and cannot be changed from the UI — the browser can add/remove catalog
// entries but never edit their settings, and `/api/run` re-resolves whatever the
// client posts back through this catalog (see `resolveModels`) so a tampered
// price or model id is ignored.
//
// Prices are USD per 1,000,000 tokens, taken from public 2026 pricing:
//   • Gemini 3.5 Flash  — $1.50 in / $9.00 out  (Vertex, launched 2026-05-19)
//   • Claude Opus 4.8   — $5.00 in / $25.00 out (Anthropic list price)
//   • Gemini 3.1 Pro    — $2.00 in / $12.00 out (Vertex, ≤200K context)
// ---------------------------------------------------------------------------

const PRICING = {
  gemini:    { input: 1.50, output: 9.00 },   // Gemini 3.5 Flash (May 2026)
  openai:    { input: 2.50, output: 10.00 },  // unused by the catalog; kept as a fallback
  anthropic: { input: 5.00, output: 25.00 },  // Claude Opus 4.8
};

// The ONLY models a user may select. All run through Google Agent Platform
// (Vertex); `publisher` = google | anthropic. `id` is the stable catalog key
// (== `model` except where the API id differs, e.g. Gemini 3.1 Pro's preview id).
const MODEL_CATALOG = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.5-flash',      price: { input: 1.50, output: 9.00 } },
  { id: 'claude-opus-4-8',  label: 'Claude Opus 4.8',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-8',        price: { input: 5.00, output: 25.00 } },
  { id: 'gemini-3.1-pro',   label: 'Gemini 3.1 Pro',   provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.1-pro-preview', price: { input: 2.00, output: 12.00 } },
];

function catalogEntry(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || MODEL_CATALOG.find((m) => m.model === id) || null;
}

// Expand a catalog entry into a runnable slot config. Everything except `slot`
// comes from the catalog, so callers can never smuggle in a custom price/model.
function modelFromCatalog(slot, id) {
  const c = catalogEntry(id);
  if (!c) return null;
  return { slot, catalogId: c.id, label: c.label, provider: c.provider, publisher: c.publisher, model: c.model, price: { input: c.price.input, output: c.price.output } };
}

// The default slots shown in the UI on first load (a subset of the catalog).
const DEFAULT_MODELS = [
  modelFromCatalog('A', 'gemini-3.5-flash'),
  modelFromCatalog('B', 'claude-opus-4-8'),
];

// Server-authoritative model resolution for a run. Takes whatever the client
// posted and rebuilds each slot from the catalog — dropping anything not in the
// catalog and ignoring any client-supplied price/provider/model. This is what
// makes "settings can't be modified" true even against a hand-crafted request.
function resolveModels(requested) {
  const list = Array.isArray(requested) ? requested : [];
  const out = [];
  const usedSlots = new Set();
  list.forEach((m, idx) => {
    if (!m) return;
    const c = catalogEntry(m.catalogId || m.id || m.model);
    if (!c) return; // not in the catalog → cannot be run
    let slot = (typeof m.slot === 'string' && m.slot.trim()) ? m.slot.trim() : String.fromCharCode(65 + idx);
    if (usedSlots.has(slot)) slot = String.fromCharCode(65 + out.length); // keep slots unique
    usedSlots.add(slot);
    out.push(modelFromCatalog(slot, c.id));
  });
  return out.length ? out : DEFAULT_MODELS.map((m) => modelFromCatalog(m.slot, m.catalogId));
}

function priceFor(cfg) {
  if (cfg && cfg.price && (cfg.price.input != null) && (cfg.price.output != null)) return cfg.price;
  return PRICING[cfg && cfg.provider] || { input: 0, output: 0 };
}

module.exports = { PRICING, MODEL_CATALOG, DEFAULT_MODELS, modelFromCatalog, resolveModels, priceFor };
