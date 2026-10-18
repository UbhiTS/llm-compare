// ---------------------------------------------------------------------------
// Provider adapters. Each returns a normalized:
//   { text, reasoning?, promptTokens, completionTokens, reasoningTokens?, latencyMs,
//     stopReason?, attachmentNotes? }
// `stopReason` is the provider's own finish/stop reason (Gemini finishReason,
// Claude stop_reason, OpenAI finish_reason / Responses status) so the agent loop
// can see truncation (max_tokens / length) and safety stops instead of treating
// a clipped or empty answer as a normal success.
//
// API keys are read from the environment ONLY on the server. They are never
// sent to the browser — a good security talking point during the demo.
//
// Uses the global `fetch` built into Node 18+. No external HTTP deps.
// ---------------------------------------------------------------------------

// Rough fallback token estimate (~4 chars/token) used only if a provider
// omits usage data. Real usage is preferred and used whenever returned.
// 0 = uncapped (let each model use its own max). Set MAX_OUTPUT_TOKENS in .env to clamp.
const crypto = require('crypto');
const { getClaudeToken } = require('./gcloudToken');
// Upstream calls go through providerFetch (header timeout + 429/5xx/network retries).
const { providerFetch, withFetchDefaults } = require('./providerFetch');
const { scrubError } = require('./secrets');
// Shared keys an admin can set at runtime (Secret Manager), falling back to the
// deploy-time env vars. A user's own key always wins over these.
const globalKeys = require('./globalKeys');
// Strict BYOK: when a user supplies the credential for a model, ONLY that
// credential (and the user's own GCP project) is used - never a shared key or
// shared project, not even as a retry/fallback. See src/byok.js.
const byok = require('./byok');
const {
  toGeminiParts,
  toClaudeContent,
  toOpenAIResponsesContent,
  toOpenAIChatContent,
} = require('./attachments');
const { withImagePolicy, IMAGE_REJECTION_RE } = require('./imagePolicy');

// Build upstream abuse-attribution metadata for OpenAI (`user`) and Vertex AI (`labels` / `metadata.user_id`)
// so any upstream safety alert from Google Cloud Trust & Safety or OpenAI can be attributed to the exact
// application user (distinguishing `external` accounts from `google_internal` accounts).
function buildUpstreamAttribution(auditUser) {
  if (!auditUser) return null;
  const rawUser = typeof auditUser === 'string'
    ? auditUser
    : String((auditUser && (auditUser.username || auditUser.user)) || '').trim().toLowerCase();
  if (!rawUser) return null;
  const isExt = typeof auditUser === 'object' && auditUser !== null && auditUser.isExternal != null
    ? Boolean(auditUser.isExternal && !/@google\.com$/i.test(rawUser))
    : !/@google\.com$/i.test(rawUser);
  const accountType = isExt ? 'external' : 'google_internal';
  // GCP label values must be lowercase letters, digits, underscores, or dashes (max 63 chars).
  const sanitizedLabelUser = rawUser
    .replace(/@/g, '_at_')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60) || 'user';
  // For OpenAI (3rd-party external API), pass `ext:<username>` for external accounts and a
  // pseudonymous SHA-256 tag `goog:<20-hex>` for @google.com accounts so internal emails aren't leaked to OpenAI.
  const openaiUser = isExt
    ? `ext:${rawUser.replace(/[^a-z0-9._@-]/gi, '_').slice(0, 56)}`
    : `goog:${crypto.createHash('sha256').update(rawUser).digest('hex').slice(0, 20)}`;
  const claudeUserId = `${accountType}:${sanitizedLabelUser}`.slice(0, 64);
  return {
    accountType,
    isExternal: isExt,
    openaiUser,
    claudeUserId,
    vertexLabels: {
      app_name: 'llm_compare',
      account_type: accountType,
      app_user: sanitizedLabelUser,
    },
  };
}

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
  const m = String(model || '').match(/-(\d+)(?:-(\d+))?(?:-fast)?$/);
  if (!m) return 99;                                  // unknown → assume modern
  return Number(m[1]) + (m[2] != null ? Number(m[2]) / 10 : 0);
}
// --- Reasoning-depth controls, per the official docs -----------------------
// Anthropic `output_config.effort` (platform.claude.com/docs/en/build-with-claude/effort):
// the ladder is low < medium < high < xhigh < max, the API default is `high`,
// and support is NOT uniform — `xhigh` is on Claude 5.5 / 5 / 4.8 / 4.7, while
// Opus 4.6 / Sonnet 4.6 have low/medium/high/max, and Opus 4.5 has neither xhigh nor
// max. Sending an unsupported level is a 400, so each model lists its own set.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORT_SUPPORT = {
  'claude-fable-5-5':     ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5-5':    ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5-1':     ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5':       ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5':      ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5':      ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5-fast': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5-5':    ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-5-5':     ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5':        ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8':      ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7':      ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5':      ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6':      ['low', 'medium', 'high', 'max'],           // no xhigh
  'claude-sonnet-4-6':    ['low', 'medium', 'high', 'max'],           // no xhigh
  'claude-opus-4-5':      ['low', 'medium', 'high'],                  // effort AND budget_tokens
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
  'gemini-4-argon':         ['low', 'medium', 'high'],          // GA on Vertex global endpoint (verified 2026-10-14)
  'gemini-3.8-flash':       ['low', 'medium', 'high'],          // no minimal (verified)
  'gemini-3.7-flash':       ['low', 'medium', 'high'],
  'gemini-3.6-flash':       ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash':       ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite':  ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro':         ['low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3.1-flash-lite':  ['minimal', 'low', 'medium', 'high'],
};
const GEMINI_DEFAULT_LEVEL = {
  'gemini-4-argon': 'medium',
  'gemini-3.8-flash': 'medium', 'gemini-3.7-flash': 'medium', 'gemini-3.6-flash': 'medium', 'gemini-3.5-flash': 'medium',
  'gemini-3.5-flash-lite': 'minimal', 'gemini-3.1-pro': 'high', 'gemini-3.1-pro-preview': 'high',
  'gemini-3.1-flash-lite': 'minimal',
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
function formatEffortOptions(levels, def) {
  const hasDef = levels.includes(def);
  const effectiveDef = hasDef ? def : levels[levels.length - 1] || '';
  return {
    defaultValue: effectiveDef,
    options: levels.map((lvl) => ({
      value: lvl,
      label: lvl === effectiveDef ? `${lvl} (default)` : lvl,
      isDefault: lvl === effectiveDef,
    })),
  };
}

function thinkingOptions({ provider, publisher, model, endpointType, thinkingMode } = {}) {
  if (endpointType === 'openai-maas') {
    if (thinkingMode === 'configurable-effort') {
      const def = openaiDefaultEffort();
      const formatted = formatEffortOptions(OPENAI_EFFORTS, def);
      return {
        configurable: true,
        kind: 'effort',
        defaultValue: formatted.defaultValue,
        note: 'Sets reasoning_effort on the Vertex AI OpenAI-compatible MaaS endpoint and streams reasoning_content.',
        options: formatted.options,
      };
    }
    if (thinkingMode === 'native') {
      return {
        configurable: false,
        kind: 'native',
        note: 'This model always performs native chain-of-thought reasoning on Vertex AI MaaS.',
        options: [{ value: '', label: 'Native Reasoning (default)', isDefault: true }],
      };
    }
    return {
      configurable: false,
      kind: 'off',
      note: 'Standard non-thinking instruct model on Vertex AI MaaS.',
      options: [{ value: '', label: 'Standard (default)', isDefault: true }],
    };
  }
  if (provider === 'agentplatform' && publisher === 'anthropic') {
    const supported = claudeEffortsFor(model);
    if (!supported) {
      return {
        configurable: false, kind: 'budget-fixed',
        note: 'This model predates the effort parameter, so only a fixed thinking budget is sent.',
        options: [{ value: '', label: 'Fixed Budget 8,192 tok (default)', isDefault: true }],
      };
    }
    const modern = claudeModelVersion(model) >= 4.6;
    const def = claudeDefaultEffort(model);
    const formatted = formatEffortOptions(supported, def);
    return {
      configurable: true,
      kind: 'effort',
      defaultValue: formatted.defaultValue,
      note: modern
        ? 'Sets output_config.effort and thinking.display="summarized" so reasoning thoughts and token counts stream live.'
        : 'Opus 4.5 takes both an effort level and a thinking budget, so this sets each of them.',
      options: formatted.options,
    };
  }
  if (provider === 'agentplatform') {
    const levels = geminiLevelsFor(model);
    const def = GEMINI_DEFAULT_LEVEL[String(model || '')] || (/pro/i.test(String(model || '')) ? 'high' : 'medium');
    const formatted = formatEffortOptions(levels, def);
    return {
      configurable: true,
      kind: 'level',
      defaultValue: formatted.defaultValue,
      note: 'Sets thinkingConfig.thinkingLevel. On models that support it, "minimal" effectively turns thinking off.',
      options: formatted.options,
    };
  }
  if (provider === 'openai') {
    const def = openaiDefaultEffort();
    const formatted = formatEffortOptions(OPENAI_EFFORTS, def);
    return {
      configurable: true,
      kind: 'effort',
      defaultValue: formatted.defaultValue,
      note: 'Sets reasoning.effort and requests live reasoning summaries (summary:"auto") via OpenAI Responses API.',
      options: formatted.options,
    };
  }
  return {
    configurable: false,
    kind: 'none',
    note: 'No reasoning parameter is sent for this provider, so there is nothing to override here.',
    options: [{ value: '', label: 'Standard (default)', isDefault: true }],
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
function thinkingProfile({ provider, publisher, model, effort, endpointType, thinkingMode, region } = {}) {
  const chosen = validateEffort({ provider, publisher, model, endpointType, thinkingMode }, effort);
  const mark = chosen ? ' (set on this card)' : '';
  if (endpointType === 'openai-maas') {
    if (thinkingMode === 'configurable-effort') {
      const level = chosen || openaiDefaultEffort();
      return {
        mode: 'effort', level, overridden: !!chosen,
        label: `thinking · ${level}`,
        detail: `Vertex AI MaaS (${region || 'global'}) · reasoning_effort: "${level}"${mark}`,
      };
    }
    if (thinkingMode === 'native') {
      return {
        mode: 'effort', level: 'native', overridden: false,
        label: 'thinking · native (always on)',
        detail: `Vertex AI MaaS (${region || 'global'}) · native chain-of-thought reasoning stream enabled`,
      };
    }
    return {
      mode: 'off', level: 'off', overridden: false,
      label: 'thinking · off (standard)',
      detail: `Vertex AI MaaS (${region || 'global'}) · standard non-reasoning instruct model`,
    };
  }
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
    messages.reduce((acc, m) => {
      let len = m.content ? (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length) : 0;
      if (Array.isArray(m.attachments)) {
        for (const a of m.attachments) {
          len += (a.textContent ? a.textContent.length : 1000);
        }
      }
      return acc + len;
    }, 0);
  return Math.ceil(chars / 4);
}

function hasAttachments(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0);
}

// Native (non-image) documents that an adapter may, visibly, re-send as extracted
// text if the provider rejects the native form. Images are NEVER flattened here:
// image rejections go to imagePolicy (scaled copy on the same model, or a
// labelled "image couldn't be sent" error).
function hasNativeDocs(messages, kinds = ['pdf', 'audio', 'video']) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m.attachments) &&
    m.attachments.some((a) => a && !a.isEmpty && a.data && kinds.includes(a.kind)));
}

// Read an error body without consuming the response.
async function peekBody(r) {
  try { return await r.clone().text(); } catch (_) { return ''; }
}

// True when a non-OK response looks like it was caused by an attached image
// (so no unrelated same-model fallback should be attempted before imagePolicy).
async function isImageError(r, messages) {
  if (!hasAttachments(messages) || r.ok) return false;
  if (r.status === 413) return true;
  if (r.status !== 400 && r.status !== 422) return false;
  return IMAGE_REJECTION_RE.test(await peekBody(r));
}

// Throwable error that carries the HTTP status (imagePolicy keys off it).
function statusError(message, status, model) {
  const err = new Error(message);
  err.status = status;
  if (model) err.model = model;
  return err;
}

const docNote = (model, what) => `${what} sent to ${model} as extracted text (the provider rejected the native file)`;

// Same-model fallbacks are gated on what the provider's 400 body actually
// complains about, so an unrelated 400 (bad prompt, policy, malformed request)
// is not re-sent, with its full multi-MB body, once per fallback rung.
const DOC_REJECTION_RE = /file|document|pdf|audio|video|mime/i;        // native doc -> extracted text
const THINKING_DISPLAY_REJECTION_RE = /display|adaptive/i;            // Claude thinking.display / adaptive
const EFFORT_REJECTION_RE = /reasoning/i;                              // reasoning_effort unsupported
const RESPONSES_SUMMARY_REJECTION_RE = /summary|verified/i;            // Responses API reasoning summaries
const STREAM_OPTIONS_REJECTION_RE = /reasoning|stream_options|include_usage|unsupported|unknown|extra/i; // MaaS stream extras

async function gemini({ model, system, messages, keys, signal }) {
  const key = byok.userCredential('gemini', keys) || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing GEMINI_API_KEY in environment (.env)');

  const buildBody = (inlineDocs = true) => {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.attachments) && m.attachments.length
        ? toGeminiParts(m.content, m.attachments, { inlineBinary: true, inlineDocs })
        : [{ text: m.content }],
    }));
    const body = {
      contents,
      generationConfig: { temperature: 0.2 },
    };
    if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  // SECURITY: the API key travels in the x-goog-api-key header, never in the URL
  // (URLs end up in proxy/access logs, error messages and undici error causes).
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };

  const t0 = Date.now();
  let r = await providerFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(true)),
    signal,
  });
  const notes = [];
  if (r.status === 400 && hasNativeDocs(messages) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    // Visible fallback: PDFs/audio/video as extracted text; images stay inline.
    r = await providerFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(false)),
      signal,
    });
    if (r.ok) notes.push(docNote(model, 'PDF/audio/video attachment(s)'));
  }
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw statusError(`Gemini ${r.status} for model "${model}": ${scrubError(JSON.stringify(j)).slice(0, 400)}`, r.status, model);

  const text = (j.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
  const u = j.usageMetadata || {};
  return {
    text,
    stopReason: j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || null,
    promptTokens: u.promptTokenCount ?? estimateTokens(messages, system),
    completionTokens: u.candidatesTokenCount ?? estimateTokens([{ content: text }]),
    latencyMs,
    ...(notes.length ? { attachmentNotes: notes } : {}),
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
  const key = byok.userCredential(cfg.keyField, keys) || globalKeys.get(cfg.env);
  if (!key) throw new Error(`Missing ${cfg.env} — add it under "Your API keys" or set it on the server.`);
  return key;
}

function buildOpenAIChatMessages(system, messages, { allowImages = true, allowFiles = false } = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    out.push({
      role: m.role,
      content: Array.isArray(m.attachments) && m.attachments.length
        ? toOpenAIChatContent(m.content, m.attachments, { allowImages, allowFiles })
        : m.content,
    });
  }
  return out;
}

// Labelled upstream error for a slot. Names the provider, HTTP status and the
// exact model that was requested, and says explicitly that no other model was
// substituted, so the UI never shows/prices a model the slot didn't use.
const CLAUDE_CFG = { label: 'Claude (Agent Platform)' };

async function upstreamError(cfg, model, r) {
  let detail = '';
  try { detail = await r.text(); } catch (_) { detail = ''; }
  const hint = r.status === 429 ? ' (rate limited / quota exhausted)'
    : r.status === 404 ? ' (model not found or not enabled for this key/project)'
    : r.status === 403 ? ' (permission denied / model not enabled for this project)' : '';
  const err = new Error(`${cfg.label} ${r.status}${hint} for model "${model}" — not re-routed to another model: ${scrubError(String(detail)).slice(0, 400)}`);
  err.status = r.status;
  err.model = model;
  return err;
}

async function openaiCompat(cfg, { model, system, messages, keys, signal, effort, auditUser }) {
  const key = compatKey(cfg, keys);
  const isOpenAI = cfg.keyField === 'openai';
  const attr = isOpenAI ? buildUpstreamAttribution(auditUser) : null;
  const msgs = buildOpenAIChatMessages(system, messages, { allowImages: true, allowFiles: isOpenAI });
  const eff = isOpenAI ? (validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort()) : null;
  const reqBody = { model, messages: msgs };
  if (eff) reqBody.reasoning_effort = eff;
  if (attr && attr.openaiUser) reqBody.user = attr.openaiUser;
  const t0 = Date.now();
  let r = await providerFetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(reqBody),
    signal,
  });
  // Images are never stripped: an image rejection surfaces to imagePolicy.
  // Only a native PDF may (visibly) fall back to its extracted text.
  const notes = [];
  let curMsgs = msgs;
  if (r.status === 400 && isOpenAI && hasNativeDocs(messages, ['pdf']) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    curMsgs = buildOpenAIChatMessages(system, messages, { allowImages: true, allowFiles: false });
    const fbBody = { model, messages: curMsgs };
    if (eff) fbBody.reasoning_effort = eff;
    if (attr && attr.openaiUser) fbBody.user = attr.openaiUser;
    r = await providerFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(fbBody),
      signal,
    });
    if (r.ok) notes.push(docNote(model, 'PDF attachment(s)'));
  }
  if (r.status === 400 && eff && !(await isImageError(r, messages)) && EFFORT_REJECTION_RE.test(await peekBody(r))) {
    // Fallback if a specific OpenAI-compatible model rejects reasoning_effort
    // (same model, attachments unchanged).
    const noEffBody = { model, messages: curMsgs };
    if (attr && attr.openaiUser) noEffBody.user = attr.openaiUser;
    r = await providerFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(noEffBody),
      signal,
    });
  }
  // No silent model substitution: a 404/429 for the requested model surfaces as
  // a labelled error for THIS slot instead of being re-routed to (and priced as)
  // a different model. Same-model retries for 400s above are unchanged.
  if (!r.ok) throw await upstreamError(cfg, model, r);
  const j = await r.json();
  const latencyMs = Date.now() - t0;

  const choice = j.choices?.[0] || {};
  const msg = choice.message || {};
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
    promptTokens: u.prompt_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    reasoningTokens: think,
    latencyMs,
    stopReason: choice.finish_reason || null,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

// OpenAI /v1/responses streaming adapter — requests `reasoning: { effort, summary: "auto" }`
// so GPT-5.x / o-series stream live `response.reasoning_summary_text.delta` events AND
// return exact `output_tokens_details.reasoning_tokens`. Returns null ONLY when the
// endpoint/model does not support `/v1/responses` (400/403/404 before any streaming),
// allowing `openaiCompatStream` to fall back cleanly to `/v1/chat/completions`.
// Quota/auth/server errors (429/401/5xx) and any failure after the stream has started
// (`state.started`) are thrown: they are final for this request, and a second full
// generation on /chat/completions would double the spend.
async function openaiResponsesStream(cfg, { model, system, messages, keys, onDelta, signal, effort, auditUser, state }) {
  const key = compatKey(cfg, keys);
  const attr = buildUpstreamAttribution(auditUser);
  const eff = validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort();
  const input = [];
  if (system) input.push({ role: 'developer', content: system });
  for (const m of messages) {
    input.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(m.attachments) && m.attachments.length
        ? toOpenAIResponsesContent(m.content, m.attachments)
        : String(m.content || ''),
    });
  }

  const sendReq = (withSummary, targetModel = model) => {
    const reqPayload = {
      model: targetModel,
      input,
      stream: true,
      reasoning: withSummary ? { effort: eff, summary: 'auto' } : { effort: eff },
    };
    if (attr && attr.openaiUser) reqPayload.user = attr.openaiUser;
    return providerFetch(`${cfg.base}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(reqPayload),
      signal,
    });
  };

  const t0 = Date.now();
  let r = await sendReq(true, model);
  if ((r.status === 400 || r.status === 403) && !(await isImageError(r, messages)) && RESPONSES_SUMMARY_REJECTION_RE.test(await peekBody(r))) {
    // Some OpenAI orgs are not verified for `summary: "auto"` — retry with `{ effort }` only
    // (same model — never substitute a different one).
    r = await sendReq(false, model);
  }
  // An image rejection must NOT fall back to /chat/completions (which used to
  // end in a silent text-only retry): surface it so imagePolicy can resend the
  // same model a scaled copy, or fail the slot with a labelled error.
  if (await isImageError(r, messages)) throw await upstreamError(cfg, model, r);
  if (!r.ok) {
    // Quota, auth and server errors are final for this request: a labelled slot
    // error, never a second full generation (and retry ladder) on /chat/completions.
    if (r.status === 429 || r.status === 401 || r.status >= 500) throw await upstreamError(cfg, model, r);
    // Endpoint / model / verification mismatch: release the body and fall back.
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) { /* ignore */ }
    return null;
  }

  let text = '', reasoning = '', usage = null, stopReason = null;
  await readSSE(r, (ev) => {
    if (state) state.started = true; // from here on a failure is final (no chat fallback)
    const t = ev && ev.type;
    if (t === 'error' || t === 'response.failed' || (ev && ev.error && !t)) {
      throw streamErrorEvent(cfg.label, model, (ev.response && ev.response.error) || ev.error || ev);
    }
    if (t === 'response.output_text.delta' && ev.delta) {
      text += ev.delta;
    } else if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && ev.delta) {
      reasoning += ev.delta;
    } else if (t === 'response.reasoning_summary_part.done' && ev.part?.text && !reasoning.includes(ev.part.text)) {
      reasoning += (reasoning ? '\n' : '') + ev.part.text;
    } else if (t === 'response.completed' || t === 'response.done') {
      if (ev.response?.usage) usage = ev.response.usage;
      stopReason = ev.response?.status || 'completed';
    } else if (t === 'response.incomplete') {
      // Hit max_output_tokens or a content filter: the usage is real and billed,
      // so take it like a completed response, but flag why it stopped.
      if (ev.response?.usage) usage = ev.response.usage;
      const why = ev.response?.incomplete_details?.reason || '';
      stopReason = /content_filter/i.test(why) ? 'content_filter' : 'max_tokens';
    }
    if (onDelta && (ev.delta || usage)) {
      const uThink = usage?.output_tokens_details?.reasoning_tokens || 0;
      const estThink = Math.max(uThink, reasoning ? estimateTokens([{ content: reasoning }]) : 0);
      const estAns = text ? estimateTokens([{ content: text }]) : 0;
      const runOut = usage?.output_tokens || (estAns + estThink);
      onDelta({ answer: text, reasoning, runningOut: runOut, runningThink: estThink, runningIn: usage?.input_tokens ?? null });
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
    stopReason,
  };
}

// Streamed variant — same contract, emits onDelta so the UI gets a live feed
// (without this an external model's column sits blank until it finishes).
async function openaiCompatStream(cfg, { model, system, messages, keys, onDelta, signal, effort, auditUser }) {
  const isOpenAI = cfg.keyField === 'openai';
  if (isOpenAI) {
    const state = { started: false };
    try {
      const res = await openaiResponsesStream(cfg, { model, system, messages, keys, onDelta, signal, effort, auditUser, state });
      if (res) return res;
    } catch (e) {
      // A labelled upstream error, or a stream that died AFTER it started (the
      // generation is already billed upstream), is final for this slot: never a
      // silent second generation on /chat/completions.
      if ((e && e.status) || state.started) throw e;
      /* otherwise (transport error before any event) fall through to /chat/completions */
    }
  }

  const key = compatKey(cfg, keys);
  const attr = isOpenAI ? buildUpstreamAttribution(auditUser) : null;
  const eff = isOpenAI ? (validateEffort({ provider: 'openai', model }, effort) || openaiDefaultEffort()) : null;
  const buildBody = (includeEffort, targetModel = model, allowFiles = true) => {
    const msgs = buildOpenAIChatMessages(system, messages, {
      allowImages: true, // images are never stripped (see imagePolicy)
      allowFiles: allowFiles && isOpenAI,
    });
    const b = { model: targetModel, messages: msgs, stream: true };
    if (cfg.usageOpt) b.stream_options = { include_usage: true }; // OpenAI reports usage in the final chunk
    if (includeEffort && eff) b.reasoning_effort = eff;
    if (attr && attr.openaiUser) b.user = attr.openaiUser;
    return b;
  };
  const t0 = Date.now();
  let r = await providerFetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(buildBody(true, model, true)),
    signal,
  });
  const notes = [];
  let filesOk = true;
  if (r.status === 400 && isOpenAI && hasNativeDocs(messages, ['pdf']) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    filesOk = false; // visible fallback: PDF as extracted text; images unchanged
    r = await providerFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildBody(true, model, false)),
      signal,
    });
    if (r.ok) notes.push(docNote(model, 'PDF attachment(s)'));
  }
  if (r.status === 400 && eff && !(await isImageError(r, messages)) && EFFORT_REJECTION_RE.test(await peekBody(r))) {
    r = await providerFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildBody(false, model, filesOk)),
      signal,
    });
  }
  // No silent re-route to gpt-oss-120b-maas (or any other model): the slot fails
  // with a labelled error so it is never priced/labelled as a model it didn't use.
  if (!r.ok) throw await upstreamError(cfg, model, r);

  let text = '', reasoning = '', usage = null, stopReason = null;
  await readSSE(r, (ev) => {
    if (ev && ev.error) throw streamErrorEvent(cfg.label, model, ev.error);
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    const d = choice?.delta;
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (d) {
      if (d.content) text += d.content;
      const rChunk = d.reasoning_content || d.reasoning || d.thinking || '';
      if (rChunk) reasoning += rChunk;
    }
    if (onDelta && (d || ev.usage)) {
      const uThink = usage?.completion_tokens_details?.reasoning_tokens || 0;
      const runThink = Math.max(uThink, reasoning ? estimateTokens([{ content: reasoning }]) : 0);
      const runOut = usage?.completion_tokens || (estimateTokens([{ content: text }]) + runThink);
      onDelta({ answer: text, reasoning, runningOut: runOut, runningThink: runThink, runningIn: usage?.prompt_tokens ?? null });
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
    promptTokens: u.prompt_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    reasoningTokens: think,
    latencyMs,
    stopReason,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

const openai = (args) => openaiCompat(OPENAI_COMPAT.openai, args);
const moonshot = (args) => openaiCompat(OPENAI_COMPAT.moonshot, args);

async function anthropic({ model, system, messages, keys, signal }) {
  const key = byok.userCredential('anthropic', keys) || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY in environment (.env)');

  const sendReq = (allowPdfDocument = true) => providerFetch('https://api.anthropic.com/v1/messages', {
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
      messages: messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.attachments) && m.attachments.length
          ? toClaudeContent(m.content, m.attachments, { allowPdfDocument })
          : m.content,
      })),
    }),
    signal,
  });

  const t0 = Date.now();
  let r = await sendReq(true);
  const notes = [];
  if (r.status === 400 && hasNativeDocs(messages, ['pdf']) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    r = await sendReq(false); // visible fallback: PDF as extracted text; images unchanged
    if (r.ok) notes.push(docNote(model, 'PDF attachment(s)'));
  }
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw statusError(`Anthropic ${r.status} for model "${model}": ${scrubError(JSON.stringify(j)).slice(0, 400)}`, r.status, model);

  const text = (j.content || []).map((c) => c.text || '').join('');
  const stopReason = j.stop_reason || null;
  const u = j.usage || {};
  return {
    text,
    stopReason,
    promptTokens: u.input_tokens ?? estimateTokens(messages, system),
    completionTokens: u.output_tokens ?? estimateTokens([{ content: text }]),
    latencyMs,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

// --- Google Agent Platform (formerly Vertex AI) ---------------------------
// One platform, two call styles:
//   * Google (Gemini) publishers -> :generateContent with the API key (x-goog-api-key header)
//   * Anthropic (Claude) publishers -> :rawPredict with an OAuth bearer token
//     on the project-scoped /locations/global path (per the model sheet).
// Both can return reasoning ("thinking"); we separate it from the answer and
// count reasoning tokens as output for accurate cost.

// (agentplatform dispatcher is defined below alongside agentPlatformOpenAIMaaS)

// Gemini 4+ (e.g. `gemini-4-argon`) and explicitly global-scoped Gemini models
// are served on the project-scoped `/v1/projects/<PROJECT>/locations/global`
// Vertex AI path rather than the projectless `/v1/publishers/google` alias
// (which routes to us-central1 and returns 404 for global-only models).
// Because `AGENT_PLATFORM_API_KEY` belongs to project 419460847694 while
// `GCP_PROJECT_ID` is used for Claude OAuth (`llm-compare-ubhits`), the shared
// key defaults to `AGENT_PLATFORM_PROJECT_NUMBER` (`419460847694`).
// Strict BYOK: a user's own key is only ever paired with the user's own
// `gcpProject` (or the projectless alias, which bills the key's own project) -
// never with the shared project - and a user-supplied `gcpProject` is never
// paired with the shared key.
function vertexGeminiBaseUrl(model, keys, region) {
  const needsGlobalProjectPath = region === 'global' || geminiVersion(model) >= 4;
  const ownKey = !!byok.userCredential('vertexKey', keys);
  const proj = ownKey
    ? byok.userProject(keys)
    : (process.env.AGENT_PLATFORM_PROJECT_NUMBER || '419460847694').trim();
  if (!needsGlobalProjectPath || !proj) {
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}`;
  }
  const loc = (region || 'global').trim();
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}`;
}

// Extra hint on a Vertex Gemini error when the user's own key was used without
// their own project (global-only models need the project-scoped path).
function ownVertexKeyHint(keys, status) {
  if (!byok.userCredential('vertexKey', keys) || byok.userProject(keys)) return '';
  if (status !== 403 && status !== 404) return '';
  return ' (Your own Vertex AI key was used - shared keys are never used with it. Global-only models such as Gemini 4 also need your GCP project ID under "Your API keys".)';
}

// GCP project for Claude / partner MaaS models (OAuth). A user's own OAuth token
// runs ONLY on the user's own project; the shared service-account token runs
// only on the shared project (a user-supplied project is ignored there).
function vertexOAuthProject(keys, catalogProject) {
  if (byok.userCredential('vertexOAuth', keys)) {
    const own = byok.userProject(keys);
    if (!own) {
      throw byok.byokError('Your own Vertex AI OAuth token needs your own GCP project ID - add it under "Your API keys" (shared projects and keys are never used with your own credentials).');
    }
    return own;
  }
  return catalogProject || process.env.GCP_PROJECT_ID || '';
}

async function agentPlatformGemini({ model, system, messages, keys, signal, effort, region, auditUser }) {
  const key = byok.userCredential('vertexKey', keys) || globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');
  const attr = buildUpstreamAttribution(auditUser);

  const buildBody = (inlineDocs = true) => {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.attachments) && m.attachments.length
        ? toGeminiParts(m.content, m.attachments, { inlineBinary: true, inlineDocs })
        : [{ text: m.content }],
    }));
    const body = {
      contents,
      generationConfig: geminiGenerationConfig(model, effort), // reasoning on, at the level this card asked for
    };
    if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (attr && attr.vertexLabels) body.labels = attr.vertexLabels;
    return body;
  };

  const url = `${vertexGeminiBaseUrl(model, keys, region)}:generateContent`;
  // SECURITY: API key in the x-goog-api-key header, never in the URL.
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };

  const t0 = Date.now();
  let r = await providerFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(true)),
    signal,
  });
  const notes = [];
  if (r.status === 400 && hasNativeDocs(messages) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    r = await providerFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(false)),
      signal,
    });
    if (r.ok) notes.push(docNote(model, 'PDF/audio/video attachment(s)'));
  }
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw statusError(`Agent Platform ${r.status} for model "${model}": ${scrubError(JSON.stringify(j)).slice(0, 400)}${ownVertexKeyHint(keys, r.status)}`, r.status, model);

  const candidate = j.candidates?.[0];
  const parts = candidate?.content?.parts || [];
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
    // MAX_TOKENS / SAFETY / RECITATION / PROHIBITED_CONTENT, or a prompt-level block.
    stopReason: candidate?.finishReason || j.promptFeedback?.blockReason || null,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

async function agentPlatformClaude({ model, system, messages, project, keys, signal, effort, auditUser }) {
  const proj = vertexOAuthProject(keys, project); // strict BYOK: own token -> own project only
  const userToken = byok.userCredential('vertexOAuth', keys); // if the user brought their own token, use it (no minting)
  const attr = buildUpstreamAttribution(auditUser);

  const makePayload = (omitDisplay, targetModel = model, allowPdfDocument = true) => {
    const b = {
      anthropic_version: 'vertex-2023-10-16',
      ...claudeThinkingFields(targetModel, effort, { omitDisplay }),
      messages: messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.attachments) && m.attachments.length
          ? toClaudeContent(m.content, m.attachments, { allowPdfDocument })
          : m.content,
      })),
    };
    if (system) b.system = system;
    if (attr && attr.claudeUserId) b.metadata = { user_id: attr.claudeUserId };
    return JSON.stringify(b);
  };

  const makeUrl = (m) =>
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(m)}:rawPredict`;

  const send = (token, omitDisplay = false, targetModel = model, allowPdfDocument = true) =>
    providerFetch(makeUrl(targetModel), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: makePayload(omitDisplay, targetModel, allowPdfDocument),
      signal,
    });

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, false, model, true);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, false, model, true);
  }
  const notes = [];
  if (r.status === 400 && !(await isImageError(r, messages))) {
    // Same-model fallbacks, each gated on what the 400 body complains about.
    let body400 = await peekBody(r);
    let omitDisplay = false;
    if (THINKING_DISPLAY_REJECTION_RE.test(body400)) {
      omitDisplay = true; // model predates thinking.display / adaptive
      r = await send(tok, true, model, true);
      body400 = r.status === 400 ? await peekBody(r) : '';
    }
    if (r.status === 400 && hasNativeDocs(messages, ['pdf']) && DOC_REJECTION_RE.test(body400) && !(await isImageError(r, messages))) {
      r = await send(tok, omitDisplay, model, false); // visible fallback: PDF as extracted text; images unchanged
      if (r.ok) notes.push(docNote(model, 'PDF attachment(s)'));
    }
  }
  // No silent model substitution (previously a 429/403/404 was re-routed to
  // claude-opus-5-5). The slot fails with a labelled, unpriced error instead.
  if (!r.ok) throw await upstreamError(CLAUDE_CFG, model, r);
  const j = await r.json();
  const latencyMs = Date.now() - t0;

  const blocks = j.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const stopReason = j.stop_reason || null;
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
    stopReason,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

// --- Streaming variants (SSE) for live token-by-token updates ----------------
// Idle deadline for a streamed body: if the upstream sends NOTHING for this long
// the stream is cancelled and the slot fails, instead of holding the run (and
// its budget charge, heartbeat and request slot) open for the whole Cloud Run
// request timeout. Distinct from PROVIDER_TIMEOUT_MS, which only covers headers.
const PROVIDER_IDLE_MS = (() => {
  const n = Number(process.env.PROVIDER_IDLE_MS);
  return process.env.PROVIDER_IDLE_MS != null && String(process.env.PROVIDER_IDLE_MS).trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 120000;
})();
// A single SSE line can never legitimately approach this; a provider that keeps
// sending bytes without a newline would otherwise grow `buf` without bound.
const SSE_MAX_BUFFER_CHARS = 8 * 1024 * 1024;

function idleTimeoutError(idleMs) {
  const human = idleMs >= 1000 ? `${Math.round(idleMs / 1000)}s` : `${idleMs}ms`;
  const err = new Error(`provider stream stalled: no data received for ${human} (PROVIDER_IDLE_MS) - the slot was cancelled`);
  err.name = 'ProviderIdleTimeoutError';
  err.code = 'PROVIDER_IDLE_TIMEOUT';
  return err;
}

async function readSSE(response, onEvent, { idleMs = PROVIDER_IDLE_MS } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Race every read() against the idle deadline; on expiry cancel the reader so
  // the upstream connection is released, then fail the stream with a clear error.
  const readWithDeadline = () => {
    if (!(idleMs > 0)) return reader.read();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = idleTimeoutError(idleMs);
        Promise.resolve().then(() => reader.cancel(err)).catch(() => {});
        reject(err);
      }, idleMs);
    });
    return Promise.race([reader.read(), deadline]).finally(() => { if (timer) clearTimeout(timer); });
  };
  try {
    for (;;) {
      const { value, done } = await readWithDeadline();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > SSE_MAX_BUFFER_CHARS) {
        const err = new Error(`provider stream exceeded the ${SSE_MAX_BUFFER_CHARS / (1024 * 1024)} MB event buffer without a line break`);
        err.code = 'PROVIDER_STREAM_TOO_LARGE';
        throw err;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(data); } catch (_) { continue; } // partial / non-JSON line
          // Handler exceptions (a mid-stream provider error event, a bug in the
          // adapter) propagate: they must never be swallowed into a "successful"
          // truncated answer with estimated usage.
          onEvent(ev);
        }
      }
    }
  } catch (e) {
    try { await reader.cancel(e); } catch (_) { /* already closed */ }
    throw e;
  }
}

// Mid-stream provider error events ({error}, type:'error', response.failed) are
// surfaced as a 502 for the slot: the partial text is NOT a successful answer.
function streamErrorEvent(label, model, detail) {
  let text = '';
  try { text = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch (_) { text = String(detail); }
  return statusError(`${label} stream error for model "${model}": ${scrubError(text || 'unknown error').slice(0, 400)}`, 502, model);
}

async function agentPlatformGeminiStream({ model, system, messages, onDelta, keys, signal, effort, region, auditUser }) {
  const key = byok.userCredential('vertexKey', keys) || globalKeys.get('AGENT_PLATFORM_API_KEY') || globalKeys.get('GEMINI_API_KEY');
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');
  const attr = buildUpstreamAttribution(auditUser);

  const buildBody = (inlineDocs = true) => {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.attachments) && m.attachments.length
        ? toGeminiParts(m.content, m.attachments, { inlineBinary: true, inlineDocs })
        : [{ text: m.content }],
    }));
    const body = {
      contents,
      generationConfig: geminiGenerationConfig(model, effort),
    };
    if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (attr && attr.vertexLabels) body.labels = attr.vertexLabels;
    return body;
  };
  const url = `${vertexGeminiBaseUrl(model, keys, region)}:streamGenerateContent?alt=sse`;
  // SECURITY: API key in the x-goog-api-key header, never in the URL.
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };

  const t0 = Date.now();
  let r = await providerFetch(url, { method: 'POST', headers, body: JSON.stringify(buildBody(true)), signal });
  const notes = [];
  if (r.status === 400 && hasNativeDocs(messages) && !(await isImageError(r, messages)) && DOC_REJECTION_RE.test(await peekBody(r))) {
    r = await providerFetch(url, { method: 'POST', headers, body: JSON.stringify(buildBody(false)), signal });
    if (r.ok) notes.push(docNote(model, 'PDF/audio/video attachment(s)'));
  }
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = await r.text(); } throw statusError(`Agent Platform ${r.status} for model "${model}": ${scrubError(JSON.stringify(e)).slice(0, 400)}${ownVertexKeyHint(keys, r.status)}`, r.status, model); }

  let answer = '', reasoning = '', usage = {}, stopReason = null;
  await readSSE(r, (obj) => {
    if (obj && obj.error) throw streamErrorEvent('Agent Platform', model, obj.error);
    const cand = obj.candidates?.[0];
    const parts = cand?.content?.parts || [];
    for (const p of parts) {
      if (p.text == null) continue;
      if (p.thought === true) reasoning += p.text; else answer += p.text;
    }
    // Truncation / safety stops are reported here and nowhere else.
    if (cand?.finishReason) stopReason = cand.finishReason;
    else if (obj.promptFeedback?.blockReason) stopReason = obj.promptFeedback.blockReason;
    if (obj.usageMetadata) usage = obj.usageMetadata;
    if (onDelta && (parts.length || obj.usageMetadata)) {
      const think = usage.thoughtsTokenCount || 0;
      const runningOut = usage.candidatesTokenCount != null ? usage.candidatesTokenCount + think : null;
      onDelta({ answer, reasoning, runningOut, runningThink: think, runningIn: usage.promptTokenCount ?? null });
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
    stopReason,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

async function agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys, signal, effort, auditUser }) {
  const proj = vertexOAuthProject(keys, project); // strict BYOK: own token -> own project only
  const userToken = byok.userCredential('vertexOAuth', keys);
  const attr = buildUpstreamAttribution(auditUser);
  const makePayload = (omitDisplay, targetModel = model, allowPdfDocument = true) => {
    const b = {
      anthropic_version: 'vertex-2023-10-16',
      ...claudeThinkingFields(targetModel, effort, { omitDisplay }),
      stream: true,
      messages: messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.attachments) && m.attachments.length
          ? toClaudeContent(m.content, m.attachments, { allowPdfDocument })
          : m.content,
      })),
    };
    if (system) b.system = system;
    if (attr && attr.claudeUserId) b.metadata = { user_id: attr.claudeUserId };
    return JSON.stringify(b);
  };
  const makeUrl = (m) =>
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(m)}:streamRawPredict`;

  const send = (token, omitDisplay = false, targetModel = model, allowPdfDocument = true) =>
    providerFetch(makeUrl(targetModel), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: makePayload(omitDisplay, targetModel, allowPdfDocument), signal });

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, false, model, true);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, false, model, true);
  }
  const notes = [];
  if (r.status === 400 && !(await isImageError(r, messages))) {
    // Same-model fallbacks, each gated on what the 400 body complains about.
    let body400 = await peekBody(r);
    let omitDisplay = false;
    if (THINKING_DISPLAY_REJECTION_RE.test(body400)) {
      omitDisplay = true; // model predates thinking.display / adaptive
      r = await send(tok, true, model, true);
      body400 = r.status === 400 ? await peekBody(r) : '';
    }
    if (r.status === 400 && hasNativeDocs(messages, ['pdf']) && DOC_REJECTION_RE.test(body400) && !(await isImageError(r, messages))) {
      r = await send(tok, omitDisplay, model, false); // visible fallback: PDF as extracted text; images unchanged
      if (r.ok) notes.push(docNote(model, 'PDF attachment(s)'));
    }
  }
  // No silent model substitution (previously a 429/403/404 was re-routed to
  // claude-opus-5-5). The slot fails with a labelled, unpriced error instead.
  if (!r.ok) throw await upstreamError(CLAUDE_CFG, model, r);

  let answer = '', reasoning = '', inTok = 0, outTok = 0, thinkTok = 0, stopReason = null;
  await readSSE(r, (ev) => {
    if (ev.type === 'error' || (ev.error && !ev.type)) {
      // Anthropic reports overloads / internal errors as an SSE event on a 200 stream.
      throw streamErrorEvent(CLAUDE_CFG.label, model, ev.error || ev);
    }
    if (ev.type === 'message_start') {
      if (ev.message?.usage) inTok = ev.message.usage.input_tokens || inTok;
      if (ev.message?.stop_reason) stopReason = ev.message.stop_reason;
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') answer += d.text || '';
      else if (d.type === 'thinking_delta') reasoning += d.thinking || '';
      if (onDelta && (d.type === 'text_delta' || d.type === 'thinking_delta')) {
        const estThink = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
        const estAns = answer ? estimateTokens([{ content: answer }]) : 0;
        const curThink = thinkTok || estThink;
        const curOut = outTok ? Math.max(outTok, estAns + curThink) : (estAns + curThink);
        onDelta({ answer, reasoning, runningOut: curOut, runningThink: curThink, runningIn: inTok || null });
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      else if (ev.stop_reason) stopReason = ev.stop_reason;
      if (ev.usage) {
        outTok = ev.usage.output_tokens || outTok;
        if (ev.usage.output_tokens_details?.thinking_tokens) {
          thinkTok = ev.usage.output_tokens_details.thinking_tokens;
        } else if (outTok > 0) {
          const ansEst = estimateTokens([{ content: answer }]);
          const reasonEst = reasoning ? estimateTokens([{ content: reasoning }]) : 0;
          const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
          thinkTok = reasonEst > 0 ? Math.min(outTok, Math.max(reasonEst, impliedThink)) : impliedThink;
        }
        if (onDelta) onDelta({ answer, reasoning, runningOut: outTok, runningThink: thinkTok, runningIn: inTok || null });
      }
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
    stopReason,
    ...(notes.length ? { attachmentNotes: notes } : {}),
  };
}

function splitThinkTags(rawText, rawReasoning) {
  let text = String(rawText || '');
  let reasoning = String(rawReasoning || '');
  // Extract <think>...</think> (including an open <think> mid-stream)
  const closed = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (closed) {
    const inside = closed[1].trim();
    if (inside && !reasoning.includes(inside)) reasoning = reasoning ? (reasoning + '\n' + inside) : inside;
    text = (text.slice(0, closed.index) + text.slice(closed.index + closed[0].length)).trimStart();
  } else {
    const openIdx = text.indexOf('<think>');
    if (openIdx >= 0) {
      const inside = text.slice(openIdx + 7).trimStart();
      if (inside) reasoning = reasoning ? (reasoning + '\n' + inside) : inside;
      text = text.slice(0, openIdx).trimEnd();
    }
  }
  return { text, reasoning };
}

// Some MaaS models reject a request that omits max_tokens (the platform default
// exceeds their range). Llama 4 Scout: 400 "maxOutputTokens … supported range is
// from 1 (inclusive) to 8193 (exclusive)"; without max_tokens it returns 400
// INVALID_ARGUMENT / 500 INTERNAL for every prompt (live, 2026-09-25).
const MAAS_MAX_OUTPUT = { 'meta/llama-4-scout-17b-16e-instruct-maas': 8192 };
const maasMaxTokens = (model) => MAX_OUTPUT_TOKENS
  ? (MAAS_MAX_OUTPUT[model] ? Math.min(MAX_OUTPUT_TOKENS, MAAS_MAX_OUTPUT[model]) : MAX_OUTPUT_TOKENS)
  : (MAAS_MAX_OUTPUT[model] || 0);

async function agentPlatformOpenAIMaaS({ model, system, messages, project, keys, signal, effort, region, thinkingMode }) {
  const proj = vertexOAuthProject(keys, project); // strict BYOK: own token -> own project only
  const reg = region || 'global';
  const host = reg === 'global' ? 'aiplatform.googleapis.com' : `${reg}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1beta1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(reg)}/endpoints/openapi/chat/completions`;
  const userToken = byok.userCredential('vertexOAuth', keys);
  const eff = thinkingMode === 'configurable-effort' ? (validateEffort({ provider: 'agentplatform', endpointType: 'openai-maas', thinkingMode, model }, effort) || openaiDefaultEffort()) : null;

  const send = (token, withEffort) => {
    // Images are never stripped (see imagePolicy); MaaS takes no native files.
    const msgs = buildOpenAIChatMessages(system, messages, { allowImages: true, allowFiles: false });
    const body = { model, messages: msgs };
    if (withEffort && eff) body.reasoning_effort = eff;
    const maxTok = maasMaxTokens(model);
    if (maxTok) body.max_tokens = maxTok;
    return providerFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  };

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, true);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, true);
  }
  if (r.status === 400 && eff && !(await isImageError(r, messages)) && EFFORT_REJECTION_RE.test(await peekBody(r))) {
    r = await send(tok, false);
  }
  let j; try { j = await r.json(); } catch (_) { j = {}; }
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw statusError(`Vertex AI MaaS (${reg}) ${r.status} for model "${model}": ${scrubError(JSON.stringify(j)).slice(0, 400)}`, r.status, model);

  const choice = j.choices?.[0] || {};
  const msg = choice.message || {};
  const split = splitThinkTags(msg.content || '', msg.reasoning_content || msg.reasoning || msg.thinking || '');
  const text = split.text;
  const reasoning = split.reasoning.trim();
  const u = j.usage || {};
  const outTok = u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const think = u.completion_tokens_details?.reasoning_tokens
    ?? (reasoning ? Math.max(estimateTokens([{ content: reasoning }]), impliedThink) : impliedThink);
  return {
    text,
    reasoning,
    reasoningTokens: think,
    promptTokens: u.prompt_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    latencyMs,
    stopReason: choice.finish_reason || null,
  };
}

async function agentPlatformOpenAIMaaSStream({ model, system, messages, project, onDelta, keys, signal, effort, region, thinkingMode }) {
  const proj = vertexOAuthProject(keys, project); // strict BYOK: own token -> own project only
  const reg = region || 'global';
  const host = reg === 'global' ? 'aiplatform.googleapis.com' : `${reg}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1beta1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(reg)}/endpoints/openapi/chat/completions`;
  const userToken = byok.userCredential('vertexOAuth', keys);
  const eff = thinkingMode === 'configurable-effort' ? (validateEffort({ provider: 'agentplatform', endpointType: 'openai-maas', thinkingMode, model }, effort) || openaiDefaultEffort()) : null;

  const send = (token, withEffort, withUsageOpt = true) => {
    // Images are never stripped (see imagePolicy); MaaS takes no native files.
    const msgs = buildOpenAIChatMessages(system, messages, { allowImages: true, allowFiles: false });
    const body = { model, messages: msgs, stream: true };
    if (withUsageOpt) body.stream_options = { include_usage: true };
    if (withEffort && eff) body.reasoning_effort = eff;
    const maxTok = maasMaxTokens(model);
    if (maxTok) body.max_tokens = maxTok;
    return providerFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  };

  const t0 = Date.now();
  let tok = userToken || await getClaudeToken();
  let r = await send(tok, true, true);
  if (r.status === 401 && !userToken) {
    tok = await getClaudeToken({ forceRefresh: true });
    r = await send(tok, true, true);
  }
  if (r.status === 400 && !(await isImageError(r, messages)) && STREAM_OPTIONS_REJECTION_RE.test(await peekBody(r))) {
    r = await send(tok, false, false); // same model, no effort/usage options; attachments unchanged
  }
  if (!r.ok) {
    let e; try { e = await r.json(); } catch { e = await r.text(); }
    throw statusError(`Vertex AI MaaS (${reg}) ${r.status} for model "${model}": ${scrubError(JSON.stringify(e)).slice(0, 400)}`, r.status, model);
  }

  let rawContent = '', rawReasoning = '', usage = null, stopReason = null;
  await readSSE(r, (ev) => {
    if (ev && ev.error) throw streamErrorEvent(`Vertex AI MaaS (${reg})`, model, ev.error);
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    const d = choice?.delta;
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (d) {
      if (d.content) rawContent += d.content;
      const rChunk = d.reasoning_content || d.reasoning || d.thinking || '';
      if (rChunk) rawReasoning += rChunk;
    }
    if (onDelta && (d || ev.usage)) {
      const sp = splitThinkTags(rawContent, rawReasoning);
      const uThink = usage?.completion_tokens_details?.reasoning_tokens || 0;
      const runThink = Math.max(uThink, sp.reasoning ? estimateTokens([{ content: sp.reasoning }]) : 0);
      const runOut = usage?.completion_tokens || (estimateTokens([{ content: sp.text }]) + runThink);
      onDelta({ answer: sp.text, reasoning: sp.reasoning, runningOut: runOut, runningThink: runThink, runningIn: usage?.prompt_tokens ?? null });
    }
  });
  const latencyMs = Date.now() - t0;
  const sp = splitThinkTags(rawContent, rawReasoning);
  const text = sp.text;
  const reasoning = sp.reasoning.trim();
  const u = usage || {};
  const outTok = u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]);
  const ansEst = estimateTokens([{ content: text }]);
  const impliedThink = outTok > ansEst ? (outTok - ansEst) : 0;
  const think = u.completion_tokens_details?.reasoning_tokens
    ?? (reasoning ? Math.max(estimateTokens([{ content: reasoning }]), impliedThink) : impliedThink);
  return {
    text,
    reasoning,
    reasoningTokens: think,
    promptTokens: u.prompt_tokens ?? estimateTokens(messages, system),
    completionTokens: outTok,
    latencyMs,
    stopReason,
  };
}

async function agentplatform({ publisher, model, system, messages, project, keys, effort, endpointType, region, thinkingMode, signal, auditUser }) {
  if (endpointType === 'openai-maas') {
    return agentPlatformOpenAIMaaS({ model, system, messages, project, keys, signal, effort, region, thinkingMode, auditUser });
  }
  const pub = publisher || 'google';
  if (pub === 'anthropic') return agentPlatformClaude({ model, system, messages, project, keys, signal, effort, auditUser });
  return agentPlatformGemini({ model, system, messages, keys, signal, effort, region, auditUser });
}

const ADAPTERS = { agentplatform, gemini, openai, anthropic, moonshot };

// `keys` (optional) lets a user bring their own API credentials for a run; each
// adapter uses keys.<x> when present, else falls back to the server's env vars.
// `signal` aborts the upstream request when the client goes away (or restarts a
// slot) so an abandoned run stops burning tokens instead of finishing unseen.
// `timeoutMs` (optional) raises the response-header timeout for every upstream
// request this call makes: non-streaming callers (the judge) only get headers
// when the whole generation is done, so the streaming default is far too short
// for them and a timeout there would abort a billed call.
async function complete(args) {
  const { provider, model, messages, publisher, endpointType, signal, timeoutMs } = args;
  // Every image is either seen by the model (original, or a visibly-labelled
  // scaled copy) or the slot fails with a labelled error — see imagePolicy.js.
  const run = () => withImagePolicy({ provider, model, publisher, endpointType }, messages, signal,
    (msgs) => dispatchComplete({ ...args, messages: msgs }));
  return Number(timeoutMs) > 0 ? withFetchDefaults({ timeoutMs: Number(timeoutMs) }, run) : run();
}

async function dispatchComplete({ provider, model, system, messages, publisher, project, onDelta, keys, signal, effort, endpointType, region, thinkingMode, auditUser }) {
  if (provider === 'agentplatform' && onDelta) {
    if (endpointType === 'openai-maas') {
      return agentPlatformOpenAIMaaSStream({ model, system, messages, project, onDelta, keys, signal, effort, region, thinkingMode, auditUser });
    }
    const pub = publisher || 'google';
    return pub === 'anthropic'
      ? agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys, signal, effort, auditUser })
      : agentPlatformGeminiStream({ model, system, messages, onDelta, keys, signal, effort, region, auditUser });
  }
  // OpenAI-compatible providers stream too, so an external model's column gets
  // the same live token feed as the Vertex ones.
  if (OPENAI_COMPAT[provider] && onDelta) {
    return openaiCompatStream(OPENAI_COMPAT[provider], { model, system, messages, onDelta, keys, signal, effort, auditUser });
  }
  const fn = ADAPTERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  return fn({ model, system, messages, publisher, project, keys, signal, effort, endpointType, region, thinkingMode, auditUser });
}

module.exports = { complete, estimateTokens, thinkingProfile, thinkingOptions, validateEffort, buildUpstreamAttribution, ADAPTERS };
