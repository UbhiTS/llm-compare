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
//   • Gemini 3.8 Flash      — $0.75 in / $3.75 out (introductory through 2026-12-31;
//       1M context / 64k output. Thinking levels: low | medium | high — it REJECTS
//       'minimal' with a 400, unlike 3.6/3.5 Flash. Verified live 2026-09-02.)
//   • Gemini 3.7 Flash      — $0.75 in / $3.75 out (introductory through 2026-12-31)
//   • Gemini 3.6 Flash      — $0.75 in / $3.75 out (same introductory rate;
//       ⚠ both rise to $1.50 / $7.50 on 2027-01-01 — update the catalog then)
//   • Gemini 3.5 Flash      — $1.50 in / $9.00 out  (Vertex, launched 2026-05-19)
//   • Gemini 3.5 Flash Lite — $0.30 in / $2.50 out  (Vertex, cheapest option here)
//   • Gemini 3.1 Pro        — $2.00 in / $12.00 out (Vertex, ≤200K context)
//   • Claude Fable 5        — $10.00 in / $50.00 out (Anthropic list price; launched 2026-06-09)
//   • Claude Opus 5         — $5.00 in / $25.00 out (Anthropic list price; launched 2026-07-24)
//   • Claude Opus 4.8       — $5.00 in / $25.00 out (Anthropic list price)
//   • Claude Sonnet 5       — $3.00 in / $15.00 out (standard rate since 2026-09-01)
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
  // --- 1. Google (Gemini — Vertex AI Agent Platform) ---
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.8-flash', price: { input: 0.75, output: 3.75 }, context: 1000000 },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.7-flash', price: { input: 0.75, output: 3.75 }, context: 1000000 },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.6-flash', price: { input: 0.75, output: 3.75 }, context: 1000000 },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.5-flash', price: { input: 1.50, output: 9.00 }, context: 1000000 },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.5-flash-lite', price: { input: 0.30, output: 2.50 }, context: 1000000 },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', provider: 'agentplatform', publisher: 'google', providerFamily: 'google', providerLabel: 'Google (Gemini)', model: 'gemini-3.1-pro-preview', price: { input: 2.00, output: 12.00 }, context: 200000 },

  // --- 2. Anthropic (Claude — Vertex AI Partner) ---
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5-5', price: { input: 5.00, output: 25.00 }, context: 1000000 },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-fable-5-1', price: { input: 10.00, output: 50.00 }, context: 1000000 },
  { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-fable-5', price: { input: 10.00, output: 50.00 }, context: 1000000 },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5', price: { input: 5.00, output: 25.00 }, context: 1000000 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-sonnet-5', price: { input: 3.00, output: 15.00 }, context: 1000000 },
  { id: 'claude-mythos-5', label: 'Claude Mythos 5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-mythos-5', price: { input: 10.00, output: 50.00 }, context: 1000000 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-4-8', price: { input: 5.00, output: 25.00 }, context: 1000000 },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-4-7', price: { input: 5.00, output: 25.00 }, context: 1000000 },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-4-6', price: { input: 5.00, output: 25.00 }, context: 1000000 },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-4-5', price: { input: 5.00, output: 25.00 }, context: 200000 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-sonnet-4-6', price: { input: 3.00, output: 15.00 }, context: 1000000 },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-sonnet-4-5', price: { input: 3.00, output: 15.00 }, context: 200000 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'agentplatform', publisher: 'anthropic', providerFamily: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-haiku-4-5', price: { input: 1.00, output: 5.00 }, context: 200000 },

  // --- 3. xAI (Grok — Vertex AI Model Garden Global MaaS) ---
  { id: 'grok-4.20-reasoning', label: 'Grok 4.20 (Reasoning)', provider: 'agentplatform', publisher: 'xai', providerFamily: 'xai', providerLabel: 'xAI (Grok)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'xai/grok-4.20-reasoning', price: { input: 3.00, output: 15.00 }, context: 256000 },
  { id: 'grok-4.20-non-reasoning', label: 'Grok 4.20 (Standard)', provider: 'agentplatform', publisher: 'xai', providerFamily: 'xai', providerLabel: 'xAI (Grok)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'xai/grok-4.20-non-reasoning', price: { input: 3.00, output: 15.00 }, context: 256000 },
  { id: 'grok-4.1-fast-reasoning', label: 'Grok 4.1 Fast (Reasoning)', provider: 'agentplatform', publisher: 'xai', providerFamily: 'xai', providerLabel: 'xAI (Grok)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'xai/grok-4.1-fast-reasoning', price: { input: 0.60, output: 3.00 }, context: 131072 },
  { id: 'grok-4.1-fast-non-reasoning', label: 'Grok 4.1 Fast (Standard)', provider: 'agentplatform', publisher: 'xai', providerFamily: 'xai', providerLabel: 'xAI (Grok)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'xai/grok-4.1-fast-non-reasoning', price: { input: 0.60, output: 3.00 }, context: 131072 },
  { id: 'grok-4.6', label: 'Grok 4.6', provider: 'agentplatform', publisher: 'xai', providerFamily: 'xai', providerLabel: 'xAI (Grok)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'xai/grok-4.6', price: { input: 5.00, output: 25.00 }, context: 256000 },

  // --- 4. Meta (Llama — Vertex AI Model Garden MaaS, EULA accepted & enabled) ---
  { id: 'llama-4-maverick-17b-128e-maas', label: 'Llama 4 Maverick 17B-128E', provider: 'agentplatform', publisher: 'meta', providerFamily: 'meta', providerLabel: 'Meta (Llama)', endpointType: 'openai-maas', region: 'us-east5', thinkingMode: 'off', model: 'meta/llama-4-maverick-17b-128e-instruct-maas', price: { input: 0.35, output: 1.15 }, context: 1000000 },
  { id: 'llama-4-scout-17b-16e-maas', label: 'Llama 4 Scout 17B-16E', provider: 'agentplatform', publisher: 'meta', providerFamily: 'meta', providerLabel: 'Meta (Llama)', endpointType: 'openai-maas', region: 'us-east5', thinkingMode: 'off', model: 'meta/llama-4-scout-17b-16e-instruct-maas', price: { input: 0.20, output: 0.70 }, context: 1000000 },
  { id: 'llama-3.3-70b-instruct-maas', label: 'Llama 3.3 70B Instruct', provider: 'agentplatform', publisher: 'meta', providerFamily: 'meta', providerLabel: 'Meta (Llama)', endpointType: 'openai-maas', region: 'us-central1', thinkingMode: 'off', model: 'meta/llama-3.3-70b-instruct-maas', price: { input: 0.60, output: 0.60 }, context: 128000 },

  // --- 5. DeepSeek (Vertex AI Model Garden MaaS) ---
  { id: 'deepseek-r1-0528-maas', label: 'DeepSeek-R1 (0528)', provider: 'agentplatform', publisher: 'deepseek-ai', providerFamily: 'deepseek', providerLabel: 'DeepSeek', endpointType: 'openai-maas', region: 'us-central1', thinkingMode: 'native', model: 'deepseek-ai/deepseek-r1-0528-maas', price: { input: 1.35, output: 5.40 }, context: 163840 },
  { id: 'deepseek-v3.2-maas', label: 'DeepSeek-V3.2', provider: 'agentplatform', publisher: 'deepseek-ai', providerFamily: 'deepseek', providerLabel: 'DeepSeek', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'deepseek-ai/deepseek-v3.2-maas', price: { input: 0.56, output: 1.68 }, context: 163840 },

  // --- 6. Alibaba / Qwen (Vertex AI Model Garden MaaS) ---
  { id: 'qwen3-235b-a22b-instruct-maas', label: 'Qwen3 235B A22B Instruct', provider: 'agentplatform', publisher: 'qwen', providerFamily: 'qwen', providerLabel: 'Alibaba (Qwen)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'qwen/qwen3-235b-a22b-instruct-2507-maas', price: { input: 0.65, output: 2.60 }, context: 262144 },
  { id: 'qwen3-coder-480b-a35b-instruct-maas', label: 'Qwen3 Coder 480B A35B', provider: 'agentplatform', publisher: 'qwen', providerFamily: 'qwen', providerLabel: 'Alibaba (Qwen)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'qwen/qwen3-coder-480b-a35b-instruct-maas', price: { input: 0.90, output: 3.60 }, context: 262144 },
  { id: 'qwen3-next-80b-a3b-thinking-maas', label: 'Qwen3 Next 80B Thinking', provider: 'agentplatform', publisher: 'qwen', providerFamily: 'qwen', providerLabel: 'Alibaba (Qwen)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'qwen/qwen3-next-80b-a3b-thinking-maas', price: { input: 0.40, output: 1.60 }, context: 131072 },
  { id: 'qwen3-next-80b-a3b-instruct-maas', label: 'Qwen3 Next 80B Instruct', provider: 'agentplatform', publisher: 'qwen', providerFamily: 'qwen', providerLabel: 'Alibaba (Qwen)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'off', model: 'qwen/qwen3-next-80b-a3b-instruct-maas', price: { input: 0.40, output: 1.60 }, context: 131072 },

  // --- 7. OpenAI & GPT-OSS (GPT-6 Series + GPT-5.6 Series + Vertex AI MaaS) ---
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-6-sol', price: { input: 6.00, output: 36.00 }, context: 1000000 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-6-luna', price: { input: 0.30, output: 1.50 }, context: 1000000 },
  { id: 'gpt-6-terra', label: 'GPT-6 Terra', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-6-terra', price: { input: 2.50, output: 15.00 }, context: 1000000 },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-6-astra', price: { input: 4.00, output: 24.00 }, context: 1000000 },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-5.6-sol', price: { input: 5.00, output: 30.00 }, context: 400000 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-5.6-terra', price: { input: 2.00, output: 12.00 }, context: 400000 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', model: 'gpt-5.6-luna', price: { input: 0.20, output: 1.20 }, context: 400000 },
  { id: 'gpt-oss-120b-maas', label: 'GPT-OSS 120B (Vertex MaaS)', provider: 'agentplatform', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', endpointType: 'openai-maas', region: 'global', thinkingMode: 'configurable-effort', model: 'openai/gpt-oss-120b-maas', price: { input: 0.30, output: 1.20 }, context: 131072 },
  { id: 'gpt-oss-20b-maas', label: 'GPT-OSS 20B (Vertex MaaS)', provider: 'agentplatform', publisher: 'openai', providerFamily: 'openai', providerLabel: 'OpenAI & GPT-OSS', endpointType: 'openai-maas', region: 'global', thinkingMode: 'configurable-effort', model: 'openai/gpt-oss-20b-maas', price: { input: 0.10, output: 0.40 }, context: 131072 },

  // --- 8. Moonshot AI (Kimi — Vertex AI MaaS + Direct) ---
  { id: 'kimi-k2-thinking-maas', label: 'Kimi K2 Thinking (Vertex MaaS)', provider: 'agentplatform', publisher: 'moonshotai', providerFamily: 'moonshot', providerLabel: 'Moonshot AI (Kimi)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'moonshotai/kimi-k2-thinking-maas', price: { input: 0.60, output: 2.50 }, context: 256000 },
  { id: 'kimi-k3', label: 'Kimi K3', provider: 'moonshot', publisher: 'moonshot', providerFamily: 'moonshot', providerLabel: 'Moonshot AI (Kimi)', model: 'kimi-k3', price: { input: 3.00, output: 15.00 }, external: true },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'moonshot', publisher: 'moonshot', providerFamily: 'moonshot', providerLabel: 'Moonshot AI (Kimi)', model: 'kimi-k2.6', price: { input: 0.95, output: 4.00 }, external: true },

  // --- 9. Z.AI / Zhipu (GLM — Vertex AI Model Garden MaaS) ---
  { id: 'glm-5.2-maas', label: 'GLM-5.2 (Vertex MaaS)', provider: 'agentplatform', publisher: 'zai-org', providerFamily: 'zai', providerLabel: 'Z.AI (GLM)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'zai-org/glm-5.2-maas', price: { input: 0.50, output: 2.00 }, context: 131072 },
  { id: 'glm-5-maas', label: 'GLM-5 (Vertex MaaS)', provider: 'agentplatform', publisher: 'zai-org', providerFamily: 'zai', providerLabel: 'Z.AI (GLM)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'zai-org/glm-5-maas', price: { input: 0.40, output: 1.60 }, context: 131072 },
  { id: 'glm-4.7-maas', label: 'GLM-4.7 (Vertex MaaS)', provider: 'agentplatform', publisher: 'zai-org', providerFamily: 'zai', providerLabel: 'Z.AI (GLM)', endpointType: 'openai-maas', region: 'global', thinkingMode: 'native', model: 'zai-org/glm-4.7-maas', price: { input: 0.30, output: 1.20 }, context: 131072 },
];

function catalogEntry(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || MODEL_CATALOG.find((m) => m.model === id) || null;
}

// Expand a catalog entry into a runnable slot config. Everything except `slot`
// comes from the catalog, so callers can never smuggle in a custom price/model.
function modelFromCatalog(slot, id) {
  const c = catalogEntry(id);
  if (!c) return null;
  return {
    slot,
    catalogId: c.id,
    label: c.label,
    provider: c.provider,
    publisher: c.publisher,
    providerFamily: c.providerFamily || c.publisher || c.provider,
    providerLabel: c.providerLabel || c.publisher || c.provider,
    endpointType: c.endpointType || null,
    region: c.region || null,
    thinkingMode: c.thinkingMode || null,
    model: c.model,
    price: { input: c.price.input, output: c.price.output },
    external: !!c.external,
    blocked: c.blocked || null,
    context: c.context || null,
  };
}

// The default slots shown in the UI on first load (latest frontier models).
const DEFAULT_MODELS = [
  modelFromCatalog('A', 'gemini-3.8-flash'),
  modelFromCatalog('B', 'claude-opus-5-5'),
  modelFromCatalog('C', 'claude-fable-5-1'),
  modelFromCatalog('D', 'gpt-6-sol'),
];

// Server-authoritative model resolution for a run. Takes whatever the client
// posted and rebuilds each slot from the catalog — dropping anything not in the
// catalog and ignoring any client-supplied price/provider/model.
// Also disambiguates labels when the user compares the SAME model across multiple
// slots with different Thinking Modes (e.g., Gemini 3.7 Flash [low] vs [high]).
function resolveModels(requested) {
  const list = Array.isArray(requested) ? requested : [];
  const out = [];
  const usedSlots = new Set();
  list.slice(0, 6).forEach((m, idx) => {
    if (!m) return;
    const c = catalogEntry(m.catalogId || m.id || m.model);
    if (!c) return;       // not in the catalog → cannot be run
    if (c.blocked) return; // listed for visibility, but known-unrunnable on this project
    let slot = (typeof m.slot === 'string' && m.slot.trim()) ? m.slot.trim() : String.fromCharCode(65 + idx);
    if (usedSlots.has(slot)) slot = String.fromCharCode(65 + out.length); // keep slots unique
    usedSlots.add(slot);
    const resolved = modelFromCatalog(slot, c.id);
    // The one client-supplied field we honour — and only after the provider
    // layer confirms the level is legal for this exact model.
    const effort = require('./providers').validateEffort(resolved, m.effort);
    if (effort) resolved.effort = effort;
    out.push(resolved);
  });
  // If the same catalogId appears in more than one slot (e.g. comparing Thinking Off vs High),
  // append the effective thinking level to each duplicate's label so scorecards & legends are distinct.
  const counts = {};
  out.forEach((m) => { counts[m.catalogId] = (counts[m.catalogId] || 0) + 1; });
  out.forEach((m) => {
    if (counts[m.catalogId] > 1) {
      const prof = require('./providers').thinkingProfile(m);
      const tag = m.effort || (prof && prof.level) || ('Slot ' + m.slot);
      m.label = `${m.label} (${tag})`;
    }
  });
  return out.length ? out : DEFAULT_MODELS.map((m) => modelFromCatalog(m.slot, m.catalogId));
}

function priceFor(cfg) {
  if (cfg && cfg.price && (cfg.price.input != null) && (cfg.price.output != null)) return cfg.price;
  return PRICING[cfg && cfg.provider] || { input: 0, output: 0 };
}

module.exports = { PRICING, MODEL_CATALOG, DEFAULT_MODELS, modelFromCatalog, resolveModels, priceFor };
