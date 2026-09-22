// ---------------------------------------------------------------------------
// Provider adapters. Each returns a normalized:
//   { text, promptTokens, completionTokens, latencyMs }
//
// API keys are read from the environment ONLY on the server. They are never
// sent to the browser — a good security talking point during the demo.
//
// Uses the global `fetch` built into Node 18+. No external HTTP deps.
// ---------------------------------------------------------------------------

// Rough fallback token estimate (~4 chars/token) used only if a provider
// omits usage data. Real usage is preferred and used whenever returned.
// 0 = uncapped (let each model use its own max). Set MAX_OUTPUT_TOKENS in .env to clamp.
const { getClaudeToken } = require('./gcloudToken');
// Shared keys an admin can set at runtime (Secret Manager), falling back to the
// deploy-time env vars. A user's own key always wins over these.
const globalKeys = require('./globalKeys');

const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 0;
const CLAUDE_MAX_OUTPUT = MAX_OUTPUT_TOKENS || 128000; // Anthropic requires max_tokens; Opus 4.8 supports 128k
const CLAUDE_MAX_OUTPUT_LEGACY = MAX_OUTPUT_TOKENS || 32000; // pre-4.6 models cap well below 128k

// Claude's thinking API changed at 4.6. From 4.6 onward it is
// `thinking:{type:'adaptive'}` plus `output_config.effort`; BEFORE 4.6 only
// 'enabled'/'disabled' exist and 'adaptive' is rejected outright:
//   400 "thinking: input tag 'adaptive' ... does not match ... 'disabled', 'enabled'"
// The version is read off the model id (claude-opus-4-5 → 4.5, claude-opus-5 → 5.0)
// so newly added models default to the modern form without another code change.
function claudeModelVersion(model) {
  const m = String(model || '').match(/-(\d+)(?:-(\d+))?$/);
  if (!m) return 99;                                  // unknown → assume modern
  return Number(m[1]) + (m[2] != null ? Number(m[2]) / 10 : 0);
}
// --- Reasoning-depth controls, per the official docs -----------------------
// Anthropic `output_config.effort` (platform.claude.com/docs/en/build-with-claude/effort):
// the ladder is low < medium < high < xhigh < max, the API default is `high`,
// and support is NOT uniform — `xhigh` is only on Fable 5 / Mythos 5 / Opus 5 /
// Opus 4.8 / Opus 4.7 / Sonnet 5, and Opus 4.5 has effort but neither xhigh nor
// max. Sending an unsupported level is a 400, so each model lists its own set.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORT_SUPPORT = {
  'claude-fable-5':    ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5':   ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5':     ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8':   ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7':   ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5':   ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6':   ['low', 'medium', 'high', 'max'],           // no xhigh
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],           // no xhigh
  'claude-opus-4-5':   ['low', 'medium', 'high'],                  // effort AND budget_tokens
};
// Sonnet 4.5 / Haiku 4.5 and earlier: no effort at all, budget_tokens only.
// Note the docs are explicit that budget_tokens is "a target rather than a
// strict cap" — max_tokens stays the only hard ceiling.
const CLAUDE_BUDGETS = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };

function claudeEffortsFor(model) { return CLAUDE_EFFORT_SUPPORT[String(model || '')] || null; }

function claudeDefaultEffort(model) {
  const supported = claudeEffortsFor(model);
  const e = String(process.env.CLAUDE_EFFORT || 'high').toLowerCase();
  if (supported && supported.includes(e)) return e;
  return 'high';                                          // the documented API default
}

// Returns the request fields that differ between the two thinking APIs.
// `effort` is the optional per-slot override chosen in the UI.
function claudeThinkingFields(model, effort, { omitDisplay = false } = {}) {
  const supported = claudeEffortsFor(model);
  const level = supported && supported.includes(effort) ? effort : null;
  if (claudeModelVersion(model) >= 4.6) {
    return {
      max_tokens: CLAUDE_MAX_OUTPUT,
      // Claude 4.7+/4.8/5.0 default `display` to "omitted" in adaptive mode, which
      // suppresses `thinking_delta` text chunks unless `display: "summarized"` is requested.
      thinking: omitDisplay ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' },
      output_config: { effort: level || claudeDefaultEffort(model) },
    };
  }
  // Pre-4.6: manual budget. Minimum 1,024 and it must stay below max_tokens.
  const max = CLAUDE_MAX_OUTPUT_LEGACY;
  const wanted = level ? CLAUDE_BUDGETS[level] : Math.floor(max / 2);
  const fields = {
    max_tokens: max,
    thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.min(level ? max - 1024 : 8192, wanted)) },
  };
  // Opus 4.5 is the one extended-thinking-only model that also takes effort;
  // the docs say to set both. Only added when a level is explicitly chosen, so
  // the default request on this path stays byte-identical to what already works
  // on Vertex — this model rejected `adaptive` and is worth not disturbing.
  if (supported && level) fields.output_config = { effort: level };
  return fields;
}

const OPENAI_EFFORTS = ['low', 'medium', 'high'];
function openaiDefaultEffort() {
  const e = String(process.env.OPENAI_EFFORT || 'medium').toLowerCase();
  return OPENAI_EFFORTS.includes(e) ? e : 'medium';
}

// Gemini 3.x uses `thinkingConfig.thinkingLevel`, not the 2.5-era thinkingBudget
// (ai.google.dev/gemini-api/docs/thinking). Verified live on Agent Platform:
// minimal → 0 thought tokens in 2.7s, low → 236, medium → 898, high → 899, and an
// invalid value is rejected with an enum error.
//
// Support is NOT uniform across the family, so every entry below was probed live
// rather than inferred from the name: Gemini 3.8 Flash, 3.7 Flash and the 3.1 Pro
// preview all reject 'minimal' with a 400 ("Thinking level is unsupported:
// THINKING_LEVEL_MINIMAL") while 3.6, 3.5 Flash and 3.5 Flash Lite accept it.
// Offering a level a model rejects turns the picker into a hard failure — probe a
// new model before listing it here.
const GEMINI_LEVELS = {
  'gemini-3.8-flash':       ['low', 'medium', 'high'],          // no minimal (verified)
  'gemini-3.7-flash':       ['low', 'medium', 'high'],
  'gemini-3.6-flash':       ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash':       ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite':  ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
};
const GEMINI_DEFAULT_LEVEL = {
  'gemini-3.7-flash': 'medium', 'gemini-3.6-flash': 'medium', 'gemini-3.5-flash': 'medium',
  'gemini-3.5-flash-lite': 'minimal', 'gemini-3.1-pro-preview': 'high',
};
function geminiLevelsFor(model) { return GEMINI_LEVELS[String(model || '')] || ['low', 'medium', 'high']; }

function geminiThinkingConfig(model, effort) {
  const cfg = { includeThoughts: true };                  // always ask for the reasoning back
  if (geminiLevelsFor(model).includes(effort)) cfg.thinkingLevel = effort;
  return cfg;
}

// Gemini 3.6+ Flash rejects or ignores custom sampling values; the 3.7
// migration contract explicitly requires temperature/top-p/top-k to be absent.
// Keep this shared so streaming and non-streaming requests stay identical.
function geminiVersion(model) {
  const m = String(model || '').match(/^gemini-(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
}
function geminiGenerationConfig(model, effort) {
  const cfg = { thinkingConfig: geminiThinkingConfig(model, effort) };
  // Version-gated rather than an allowlist, so a newly added 3.x Flash is handled
  // without a second edit — the previous hardcoded list would silently have sent
  // temperature to 3.8.
  if (geminiVersion(model) < 3.6) cfg.temperature = 0.2;
  return cfg;
}

// The choices a given slot may offer in the UI, and what each one means.
// `configurable:false` means the request carries no reasoning parameter we own.
function thinkingOptions({ provider, publisher, model } = {}) {
  if (provider === 'agentplatform' && publisher === 'anthropic') {
    const supported = claudeEffortsFor(model);
    if (!supported) {
      return {
        configurable: false, kind: 'budget-fixed',
        note: 'This model predates the effort parameter, so only a fixed thinking budget is sent.',
        options: [],
      };
    }
    const modern = claudeModelVersion(model) >= 4.6;
    return {
      configurable: true,
      kind: 'effort',
      note: modern
        ? 'Sets output_config.effort and thinking.display="summarized" so reasoning thoughts and token counts stream live.'
        : 'Opus 4.5 takes both an effort level and a thinking budget, so this sets each of them.',
      options: [{ value: '', label: `Default (${claudeDefaultEffort(model)})` }]
        .concat(supported.map((e) => ({ value: e, label: e }))),
    };
  }
  if (provider === 'agentplatform') {
    const levels = geminiLevelsFor(model);
    const def = GEMINI_DEFAULT_LEVEL[String(model || '')] || 'model default';
    return {
      configurable: true,
      kind: 'level',
      note: 'Sets thinkingConfig.thinkingLevel. On models that support it, "minimal" effectively turns thinking off.',
      options: [{ value: '', label: `Default (${def})` }]
        .concat(levels.map((l) => ({ value: l, label: l }))),
    };
  }
  if (provider === 'openai') {
    const def = openaiDefaultEffort();
    return {
      configurable: true,
      kind: 'effort',
      note: 'Sets reasoning.effort and requests live reasoning summaries (summary:"auto") via OpenAI Responses API.',
      options: [{ value: '', label: `Default (${def})` }]
        .concat(OPENAI_EFFORTS.map((e) => ({ value: e, label: e }))),
    };
  }
  return {
    configurable: false,
    kind: 'none',
    note: 'No reasoning parameter is sent for this provider, so there is nothing to override here.',
    options: [],
  };
}

// Is `effort` a legal choice for this model? Used server-side so a hand-crafted
// request cannot smuggle an arbitrary value into the provider call.
function validateEffort(cfg, effort) {
  if (!effort) return null;
  const opts = thinkingOptions(cfg);
  const ok = opts.configurable && opts.options.some((o) => o.value && o.value === effort);
  return ok ? effort : null;
}

// What reasoning configuration a given slot will ACTUALLY be sent. Derived from
// the same helpers/constants that build the requests below, so the badge in the
// UI cannot drift from what goes on the wire. `detail` names the real request
// fields — it is what the tooltip shows.
function thinkingProfile({ provider, publisher, model, effort } = {}) {
  const chosen = validateEffort({ provider, publisher, model }, effort);
  const mark = chosen ? ' (set on this card)' : '';
  if (provider === 'agentplatform' && publisher === 'anthropic') {
    const f = claudeThinkingFields(model, chosen);
    // Branch on the thinking mode actually being sent, not on the presence of
    // output_config — Opus 4.5 carries BOTH a manual budget and an effort level.
    if (f.thinking.type === 'adaptive') {
      const level = f.output_config.effort;
      return {
        mode: 'effort', level, overridden: !!chosen, label: `effort · ${level}`,
        detail: `thinking: {type:"adaptive", display:"summarized"} · output_config.effort: "${level}" · max_tokens: ${f.max_tokens}${mark}`,
      };
    }
    const budget = f.thinking.budget_tokens;
    const eff = f.output_config && f.output_config.effort;
    return {
      mode: eff ? 'effort' : 'budget', level: eff || `${Math.round(budget / 1024)}k`, overridden: !!chosen,
      label: eff ? `effort · ${eff} · ${budget.toLocaleString('en-US')} tok` : `budget · ${budget.toLocaleString('en-US')} tok`,
      detail: `pre-4.6 thinking API — thinking: {type:"enabled", budget_tokens: ${budget}}`
        + (eff ? ` · output_config.effort: "${eff}"` : '')
        + ` · max_tokens: ${f.max_tokens}${mark}`,
    };
  }
  if (provider === 'agentplatform') {                     // Gemini on Agent Platform
    const cfg = geminiThinkingConfig(model, chosen);
    if (cfg.thinkingLevel) {
      return {
        mode: chosen === 'minimal' ? 'off' : 'level', level: cfg.thinkingLevel, overridden: true,
        label: `thinking · ${cfg.thinkingLevel}`,
        detail: `generationConfig.thinkingConfig: {thinkingLevel:"${cfg.thinkingLevel}", includeThoughts:true}${mark}`,
      };
    }
    const def = GEMINI_DEFAULT_LEVEL[String(model || '')];
    return {
      mode: 'auto', level: def || 'auto', overridden: false,
      label: `thinking · ${def ? `${def} (default)` : 'auto'}`,
      detail: 'generationConfig.thinkingConfig: {includeThoughts:true} — no thinkingLevel is set, so the model default applies',
    };
  }
  if (provider === 'openai') {
    const level = chosen || openaiDefaultEffort();
    return {
      mode: 'effort', level, overridden: !!chosen,
      label: `thinking · ${level}`,
      detail: `reasoning: {effort:"${level}", summary:"auto"} (Responses API + Chat Completions fallback)${mark}`,
    };
  }
  if (OPENAI_COMPAT[provider]) {
    return {
      mode: 'default', level: 'default', label: 'thinking · provider default',
      detail: `no reasoning parameter is sent to ${OPENAI_COMPAT[provider].label}, so the model's own default applies`,
    };
  }
  if (provider === 'anthropic') {
    return { mode: 'off', level: 'off', label: 'thinking · off', detail: 'the direct Anthropic adapter sends no thinking parameter' };
  }
  if (provider === 'gemini') {
    return { mode: 'off', level: 'off', label: 'thinking · off', detail: 'the direct Gemini adapter sends no thinkingConfig' };
  }
  return { mode: 'unknown', level: '—', label: 'thinking · unknown', detail: '' };
}

function estimateTokens(messages, system = '') {
  const chars =
    (system ? system.length : 0) +
    messages.reduce((acc, m) => acc + (m.content ? String(m.content).length : 0), 0);
  return Math.ceil(chars / 4);
}

async function gemini({ model, system, messages, keys, signal }) {
  const key = (keys && keys.gemini) || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing GEMINI_API_KEY in environment (.env)');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { temperature: 0.2 },
  };
  if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${key}`;

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const text = (j.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
  const u = j.usageMetadata || {};
  return {
    text,
    promptTokens: u.promptTokenCount ?? estimateTokens(messages, system),
    completionTokens: u.candidatesTokenCount ?? estimateTokens([{ content: text }]),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible providers (OpenAI itself + Moonshot / Kimi).
//
// Both speak the same /chat/completions contract, so one implementation serves
// both — only the base URL, env var and BYOK key field differ. These are the
// only NON-Vertex models in the catalog, so unlike the Agent Platform path the
// prompt leaves Google infrastructure.
//
// `temperature` is deliberately NOT sent: several newer models (GPT-5.x among
// them) reject any non-default value with a 400.
// ---------------------------------------------------------------------------
const OPENAI_COMPAT = {
  openai:   { label: 'OpenAI',   base: 'https://api.openai.com/v1',   env: 'OPENAI_API_KEY',   keyField: 'openai',   usageOpt: true },
  moonshot: { label: 'Moonshot', base: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY', keyField: 'moonshot', usageOpt: false },
};

function compatKey(cfg, keys) {
  const key = (keys && keys[cfg.keyField]) || globalKeys.get(cfg.env);
  if (!key) throw new Error(`Missing ${cfg.env} — add it under "Your API keys" or set it on the server.`);
  return key;
}

async function openaiCompat(cfg, { model, system, messages, keys, signal, effort }) {
  const key = compatKey(cfg, keys);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const eff = cfg.keyField === 'openai' ? (validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort()) : null;
  const reqBody = { model, messages: msgs };
  if (eff) reqBody.reasoning_effort = eff;
  const t0 = Date.now();
  let r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(reqBody),
    signal,
  });
  if (r.status === 400 && eff) {
    // Fallback if a specific OpenAI-compatible model rejects reasoning_effort
    r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: msgs }),
      signal,
    });
  }
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`${cfg.label} ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const msg = j.choices?.[0]?.message || {};
  const text = msg.content || '';
  const reasoning = msg.reasoning_content || msg.reasoning || msg.thinking || '';
  const u = j.usage || {};
  const outTok = u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const think = u.completion_tokens_details?.reasoning_tokens
    ?? (reasoning ? estimateTokens([{ content: reasoning }]) : impliedThink);
  return {
    text, reasoning,
    promptTokens: u.prompt_tokens ?? estimateTokens(msgs),
    completionTokens: outTok,
    reasoningTokens: think,
    latencyMs,
  };
}

// OpenAI /v1/responses streaming adapter — requests `reasoning: { effort, summary: "auto" }`
// so GPT-5.x / o-series stream live `response.reasoning_summary_text.delta` events AND
// return exact `output_tokens_details.reasoning_tokens`. Returns null if the endpoint or
// model does not support `/v1/responses` (or org is unverified for summaries), allowing
// `openaiCompatStream` to fall back cleanly to `/v1/chat/completions`.
async function openaiResponsesStream(cfg, { model, system, messages, keys, onDelta, signal, effort }) {
  const key = compatKey(cfg, keys);
  const eff = validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort();
  const input = [];
  if (system) input.push({ role: 'developer', content: system });
  for (const m of messages) input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });

  const sendReq = (withSummary) => fetch(`${cfg.base}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      input,
      stream: true,
      reasoning: withSummary ? { effort: eff, summary: 'auto' } : { effort: eff },
    }),
    signal,
  });

  const t0 = Date.now();
  let r = await sendReq(true);
  if (r.status === 400 || r.status === 403) {
    // Some OpenAI orgs are not verified for `summary: "auto"` — retry with `{ effort }` only
    r = await sendReq(false);
  }
  if (!r.ok) return null; // fall back to /v1/chat/completions

  let text = '', reasoning = '', usage = null;
  await readSSE(r, (ev) => {
    const t = ev && ev.type;
    if (t === 'response.output_text.delta' && ev.delta) {
      text += ev.delta;
    } else if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && ev.delta) {
      reasoning += ev.delta;
    } else if (t === 'response.reasoning_summary_part.done' && ev.part?.text && !reasoning.includes(ev.part.text)) {
      reasoning += (reasoning ? '\n' : '') + ev.part.text;
    } else if ((t === 'response.completed' || t === 'response.done') && ev.response?.usage) {
      usage = ev.response.usage;
    }
    if (onDelta && (ev.delta || usage)) {
      const uThink = usage?.output_tokens_details?.reasoning_tokens || 0;
      const estThink = Math.max(uThink, reasoning ? estimateTokens([{ content: reasoning }]) : 0);
      const estAns = text ? estimateTokens([{ content: text }]) : 0;
      const runOut = usage?.output_tokens || (estAns + estThink);
      onDelta({ answer: text, reasoning, runningOut: runOut, runningThink: estThink });
    }
  });

  if (!text && !reasoning && !usage) return null; // stream gave nothing recognizable -> fallback
  const latencyMs = Date.now() - t0;
  const u = usage || {};
  const outTok = u.output_tokens ?? u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const think = u.output_tokens_details?.reasoning_tokens
    ?? u.completion_tokens_details?.reasoning_tokens
    ?? (reasoning ? Math.max(estimateTokens([{ content: reasoning }]), impliedThink) : impliedThink);
  return {
    text, reasoning: reasoning.trim(),
    promptTokens: u.input_tokens ?? u.prompt_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    reasoningTokens: think,
    latencyMs,
  };
}

// Streamed variant — same contract, emits onDelta so the UI gets a live feed
// (without this an external model's column sits blank until it finishes).
async function openaiCompatStream(cfg, { model, system, messages, keys, onDelta, signal, effort }) {
  if (cfg.keyField === 'openai') {
    try {
      const res = await openaiResponsesStream(cfg, { model, system, messages, keys, onDelta, signal, effort });
      if (res) return res;
    } catch (_) { /* fall through to /chat/completions */ }
  }

  const key = compatKey(cfg, keys);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const eff = cfg.keyField === 'openai' ? (validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort()) : null;
  const buildBody = (includeEffort) => {
    const b = { model, messages: msgs, stream: true };
    if (cfg.usageOpt) b.stream_options = { include_usage: true }; // OpenAI reports usage in the final chunk
    if (includeEffort && eff) b.reasoning_effort = eff;
    return b;
  };
  const t0 = Date.now();
  let r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(buildBody(true)),
    signal,
  });
  if (r.status === 400 && eff) {
    r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildBody(false)),
      signal,
    });
  }
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify(await r.json()); } catch (e) { try { detail = await r.text(); } catch (_) { detail = ''; } }
    throw new Error(`${cfg.label} ${r.status}: ${String(detail).slice(0, 400)}`);
  }

  let text = '', reasoning = '', usage = null;
  await readSSE(r, (ev) => {
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta;
    if (d) {
      if (d.content) text += d.content;
      const rChunk = d.reasoning_content || d.reasoning || d.thinking || '';
      if (rChunk) reasoning += rChunk;
    }
    if (onDelta && (d || ev.usage)) {
      const uThink = usage?.completion_tokens_details?.reasoning_tokens || 0;
      const runThink = Math.max(uThink, reasoning ? estimateTokens([{ content: reasoning }]) : 0);
      const runOut = usage?.completion_tokens || (estimateTokens([{ content: text }]) + runThink);
      onDelta({ answer: text, reasoning, runningOut: runOut, runningThink: runThink });
    }
  });
  const latencyMs = Date.now() - t0;
  const u = usage || {};
  const outTok = u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const think = u.completion_tokens_details?.reasoning_tokens
    ?? (reasoning ? Math.max(estimateTokens([{ content: reasoning }]), impliedThink) : impliedThink);
  return {
    text, reasoning: reasoning.trim(),
    promptTokens: u.prompt_tokens ?? estimateTokens(msgs),
    completionTokens: outTok,
    reasoningTokens: think,
    latencyMs,
  };
}

const openai = (args) => openaiCompat(OPENAI_COMPAT.openai, args);
const moonshot = (args) => openaiCompat(OPENAI_COMPAT.moonshot, args);

async function anthropic({ model, system, messages, keys, signal }) {
  const key = (keys && keys.anthropic) || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY in environment (.env)');

  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: CLAUDE_MAX_OUTPUT,
      temperature: 0.2,
      system: system || undefined,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const text = (j.content || []).map((c) => c.text || '').join('');
  const u = j.usage || {};
  return {
    text,
    promptTokens: u.input_tokens ?? estimateTokens(messages, system),
    completionTokens: u.output_tokens ?? estimateTokens([{ content: text }]),
    latencyMs,
  };
}

// --- Google Agent Platform (formerly Vertex AI) ---------------------------
// One platform, two call styles:
//   * Google (Gemini) publishers -> :generateContent with the API key (?key=)
//   * Anthropic (Claude) publishers -> :rawPredict with an OAuth bearer token
//     on the project-scoped /locations/global path (per the model sheet).
// Both can return reasoning ("thinking"); we separate it from the answer and
// count reasoning tokens as output for accurate cost.

async function agentplatform({ publisher, model, system, messages, project, keys, effort }) {
  const pub = publisher || 'google';
  if (pub === 'anthropic') return agentPlatformClaude({ model, system, messages, project, keys, effort });
  return agentPlatformGemini({ model, system, messages, keys, effort });
}

async function agentPlatformGemini({ model, system, messages, keys, signal, effort }) {
  const key = (keys && (keys.agentplatform || keys.gemini)) || globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: geminiGenerationConfig(model, effort), // reasoning on, at the level this card asked for
  };
  if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url =
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${key}`;

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`Agent Platform ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const parts = j.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((x) => x.thought !== true).map((x) => x.text || '').join('');
  const reasoning = parts.filter((x) => x.thought === true).map((x) => x.text || '').join('\n').trim();
  const u = j.usageMetadata || {};
  const thoughtTokens = u.thoughtsTokenCount || 0;
  const completionTokens =
    u.candidatesTokenCount != null ? u.candidatesTokenCount + thoughtTokens : estimateTokens([{ content: text }]);
  return {
    text,
    reasoning,
    reasoningTokens: thoughtTokens,
    promptTokens: u.promptTokenCount ?? estimateTokens(messages, system),
    completionTokens,
    latencyMs,
  };
}

async function agentPlatformClaude({ model, system, messages, project, keys, signal, effort }) {
  const proj = (keys && keys.gcpProject) || project || process.env.GCP_PROJECT_ID || '';
  const userToken = keys && keys.claudeBearerToken; // if the user brought their own token, use it (no minting)

  const makePayload = (omitDisplay) => {
    const b = {
      anthropic_version: 'vertex-2023-10-16',
      ...claudeThinkingFields(model, effort, { omitDisplay }),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) b.system = system;
    return JSON.stringify(b);
  };

  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(model)}:rawPredict`;

  const send = (token, omitDisplay = false) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: makePayload(omitDisplay),
      signal,
    });

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, false);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, false);
  }
  if (r.status === 400) {
    // Fallback if a specific model rejects `display: "summarized"`
    r = await send(tok, true);
  }
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`Claude (Agent Platform) ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const blocks = j.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const reasoning = blocks
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking || '')
    .join('\n')
    .trim();
  const u = j.usage || {};
  const outTok = u.output_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const reasonEst = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const finalThink = u.output_tokens_details?.thinking_tokens
    ?? (reasonEst > 0 ? Math.min(outTok, Math.max(reasonEst, impliedThink)) : impliedThink);
  return {
    text,
    reasoning,
    reasoningTokens: finalThink,
    promptTokens: u.input_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    latencyMs,
  };
}

// --- Streaming variants (SSE) for live token-by-token updates ----------------
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch (_) { /* ignore partial */ }
      }
    }
  }
}

async function agentPlatformGeminiStream({ model, system, messages, onDelta, keys, signal, effort }) {
  const key = (keys && (keys.agentplatform || keys.gemini)) || globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: geminiGenerationConfig(model, effort),
  };
  if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`;

  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = await r.text(); } throw new Error(`Agent Platform ${r.status}: ${JSON.stringify(e).slice(0, 400)}`); }

  let answer = '', reasoning = '', usage = {};
  await readSSE(r, (obj) => {
    const parts = obj.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.text == null) continue;
      if (p.thought === true) reasoning += p.text; else answer += p.text;
    }
    if (obj.usageMetadata) usage = obj.usageMetadata;
    if (onDelta && (parts.length || obj.usageMetadata)) {
      const think = usage.thoughtsTokenCount || 0;
      const runningOut = usage.candidatesTokenCount != null ? usage.candidatesTokenCount + think : null;
      onDelta({ answer, reasoning, runningOut, runningThink: think });
    }
  });
  const latencyMs = Date.now() - t0;
  const thoughts = usage.thoughtsTokenCount || 0;
  const completionTokens =
    usage.candidatesTokenCount != null ? usage.candidatesTokenCount + thoughts : estimateTokens([{ content: answer + reasoning }]);
  return {
    text: answer, reasoning: reasoning.trim(), reasoningTokens: thoughts,
    promptTokens: usage.promptTokenCount ?? estimateTokens(messages, system),
    completionTokens, latencyMs,
  };
}

async function agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys, signal, effort }) {
  const proj = (keys && keys.gcpProject) || project || process.env.GCP_PROJECT_ID || '';
  const userToken = keys && keys.claudeBearerToken;
  const makePayload = (omitDisplay) => {
    const b = {
      anthropic_version: 'vertex-2023-10-16',
      ...claudeThinkingFields(model, effort, { omitDisplay }),
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) b.system = system;
    return JSON.stringify(b);
  };
  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(model)}:streamRawPredict`;

  const send = (token, omitDisplay = false) =>
    fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: makePayload(omitDisplay), signal });

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, false);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, false);
  }
  if (r.status === 400) {
    // Fallback if a specific model rejects `display: "summarized"`
    r = await send(tok, true);
  }
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = await r.text(); } throw new Error(`Claude (Agent Platform) ${r.status}: ${JSON.stringify(e).slice(0, 400)}`); }

  let answer = '', reasoning = '', inTok = 0, outTok = 0, thinkTok = 0;
  await readSSE(r, (ev) => {
    if (ev.type === 'message_start' && ev.message?.usage) inTok = ev.message.usage.input_tokens || inTok;
    else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') answer += d.text || '';
      else if (d.type === 'thinking_delta') reasoning += d.thinking || '';
      if (onDelta && (d.type === 'text_delta' || d.type === 'thinking_delta')) {
        const estThink = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
        const estAns = answer ? estimateTokens([{ content: answer }]) : 0;
        const curThink = thinkTok || estThink;
        const curOut = outTok ? Math.max(outTok, estAns + curThink) : (estAns + curThink);
        onDelta({ answer, reasoning, runningOut: curOut, runningThink: curThink });
      }
    } else if (ev.type === 'message_delta' && ev.usage) {
      outTok = ev.usage.output_tokens || outTok;
      if (ev.usage.output_tokens_details?.thinking_tokens) {
        thinkTok = ev.usage.output_tokens_details.thinking_tokens;
      } else if (outTok > 0) {
        const ansEst = estimateTokens([{ content: answer }]);
        const reasonEst = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
        const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
        thinkTok = reasonEst > 0 ? Math.min(outTok, Math.max(reasonEst, impliedThink)) : impliedThink;
      }
      if (onDelta) onDelta({ answer, reasoning, runningOut: outTok, runningThink: thinkTok });
    }
  });
  const latencyMs = Date.now() - t0;
  const ansEst = estimateTokens([{ content: answer }]);
  const reasonEst = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
  const totalOut = outTok || (ansEst + reasonEst);
  const impliedThink = totalOut > ansEst ? (totalOut - ansEst) : 0;
  const finalThink = thinkTok || (reasonEst > 0 ? Math.min(totalOut, Math.max(reasonEst, impliedThink)) : impliedThink);
  return {
    text: answer, reasoning: reasoning.trim(), reasoningTokens: finalThink,
    promptTokens: inTok || estimateTokens(messages, system),
    completionTokens: totalOut,
    latencyMs,
  };
}

const ADAPTERS = { agentplatform, gemini, openai, anthropic, moonshot };

// `keys` (optional) lets a user bring their own API credentials for a run; each
// adapter uses keys.<x> when present, else falls back to the server's env vars.
// `signal` aborts the upstream request when the client goes away (or restarts a
// slot) so an abandoned run stops burning tokens instead of finishing unseen.
async function complete({ provider, model, system, messages, publisher, project, onDelta, keys, signal, effort }) {
  if (provider === 'agentplatform' && onDelta) {
    const pub = publisher || 'google';
    return pub === 'anthropic'
      ? agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys, signal, effort })
      : agentPlatformGeminiStream({ model, system, messages, onDelta, keys, signal, effort });
  }
  // OpenAI-compatible providers stream too, so an external model's column gets
  // the same live token feed as the Vertex ones.
  if (OPENAI_COMPAT[provider] && onDelta) {
    return openaiCompatStream(OPENAI_COMPAT[provider], { model, system, messages, onDelta, keys, signal, effort });
  }
  const fn = ADAPTERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  return fn({ model, system, messages, publisher, project, keys, signal, effort });
}

module.exports = { complete, estimateTokens, thinkingProfile, thinkingOptions, validateEffort, ADAPTERS };
