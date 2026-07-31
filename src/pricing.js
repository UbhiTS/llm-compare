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
//   • Gemini 3.6 Flash      — $1.50 in / $7.50 out  (Vertex, launched 2026-07-21)
//   • Gemini 3.5 Flash      — $1.50 in / $9.00 out  (Vertex, launched 2026-05-19)
//   • Gemini 3.5 Flash Lite — $0.30 in / $2.50 out  (Vertex, cheapest option here)
//   • Gemini 3.1 Pro        — $2.00 in / $12.00 out (Vertex, ≤200K context)
//   • Claude Fable 5        — $10.00 in / $50.00 out (Anthropic list price; launched 2026-06-09)
//   • Claude Opus 5         — $5.00 in / $25.00 out (Anthropic list price; launched 2026-07-24)
//   • Claude Opus 4.8       — $5.00 in / $25.00 out (Anthropic list price)
//   • Claude Sonnet 5       — $2.00 in / $10.00 out (INTRODUCTORY through 2026-08-31;
//       ⚠ rises to $3.00 / $15.00 on 2026-09-01 — update the catalog entry then)
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
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.6-flash',      price: { input: 1.50, output: 7.50 } },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.5-flash',      price: { input: 1.50, output: 9.00 } },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.5-flash-lite', price: { input: 0.30, output: 2.50 } },
  { id: 'gemini-3.1-pro',   label: 'Gemini 3.1 Pro',   provider: 'agentplatform', publisher: 'google',    model: 'gemini-3.1-pro-preview', price: { input: 2.00, output: 12.00 } },
  { id: 'claude-fable-5',   label: 'Claude Fable 5',   provider: 'agentplatform', publisher: 'anthropic', model: 'claude-fable-5',         price: { input: 10.00, output: 50.00 } },
  { id: 'claude-opus-5',    label: 'Claude Opus 5',    provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-5',          price: { input: 5.00, output: 25.00 } },
  { id: 'claude-opus-4-8',  label: 'Claude Opus 4.8',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-8',        price: { input: 5.00, output: 25.00 } },
  { id: 'claude-opus-4-7',  label: 'Claude Opus 4.7',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-7',        price: { input: 5.00, output: 25.00 } },
  { id: 'claude-opus-4-6',  label: 'Claude Opus 4.6',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-6',        price: { input: 5.00, output: 25.00 } },
  { id: 'claude-opus-4-5',  label: 'Claude Opus 4.5',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-opus-4-5',        price: { input: 5.00, output: 25.00 } },
  // Sonnet 5 introductory pricing ends 2026-08-31 → then { input: 3.00, output: 15.00 }.
  { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5',  provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-5',        price: { input: 2.00, output: 10.00 } },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-4-6',    price: { input: 3.00, output: 15.00 } },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-sonnet-4-5',    price: { input: 3.00, output: 15.00 } },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'agentplatform', publisher: 'anthropic', model: 'claude-haiku-4-5',       price: { input: 1.00, output: 5.00 } },
  // --- External models (NOT on Vertex). These call the vendor's own API, so a
  // run on these sends the prompt outside Google infrastructure, and they need
  // their own key (Settings ▸ Your API keys, or OPENAI_API_KEY/MOONSHOT_API_KEY).
  // Without a key the UI shows them greyed out and refuses to place them.
  //
  // Anthropic note: every Claude model listed above was probed against this
  // project's Vertex Model Garden and returns 200. One is deliberately absent —
  // claude-mythos-5, which IS enabled but 403s until data sharing is consented
  // for the anthropic publisher (same setPublisherModelConfig call Fable 5 needed).
  // Re-probe before adding it; an entry that always fails is worse than none. ---
  { id: 'gpt-5.6-sol',      label: 'GPT-5.6 Sol',      provider: 'openai',        publisher: 'openai',    model: 'gpt-5.6-sol',            price: { input: 5.00, output: 30.00 }, external: true },
  { id: 'gpt-5.6-terra',    label: 'GPT-5.6 Terra',    provider: 'openai',        publisher: 'openai',    model: 'gpt-5.6-terra',          price: { input: 2.00, output: 12.00 }, external: true },
  { id: 'gpt-5.6-luna',     label: 'GPT-5.6 Luna',     provider: 'openai',        publisher: 'openai',    model: 'gpt-5.6-luna',           price: { input: 0.20, output: 1.20 },  external: true },
  { id: 'kimi-k3',          label: 'Kimi K3',          provider: 'moonshot',      publisher: 'moonshot',  model: 'kimi-k3',                price: { input: 3.00, output: 15.00 }, external: true },
  { id: 'kimi-k2.6',        label: 'Kimi K2.6',        provider: 'moonshot',      publisher: 'moonshot',  model: 'kimi-k2.6',              price: { input: 0.95, output: 4.00 },  external: true },
];

function catalogEntry(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || MODEL_CATALOG.find((m) => m.model === id) || null;
}

// Expand a catalog entry into a runnable slot config. Everything except `slot`
// comes from the catalog, so callers can never smuggle in a custom price/model.
function modelFromCatalog(slot, id) {
  const c = catalogEntry(id);
  if (!c) return null;
  return { slot, catalogId: c.id, label: c.label, provider: c.provider, publisher: c.publisher, model: c.model, price: { input: c.price.input, output: c.price.output }, external: !!c.external };
}

// The default slots shown in the UI on first load (a subset of the catalog).
// Three slots = MAX_SLOTS in public/app.js, so this fills the arena on open.
const DEFAULT_MODELS = [
  modelFromCatalog('A', 'gemini-3.6-flash'),
  modelFromCatalog('B', 'claude-opus-5'),
  modelFromCatalog('C', 'claude-fable-5'),
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
