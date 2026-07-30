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

const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 0;
const CLAUDE_MAX_OUTPUT = MAX_OUTPUT_TOKENS || 128000; // Anthropic requires max_tokens; Opus 4.8 supports 128k

function estimateTokens(messages, system = '') {
  const chars =
    (system ? system.length : 0) +
    messages.reduce((acc, m) => acc + (m.content ? String(m.content).length : 0), 0);
  return Math.ceil(chars / 4);
}

async function gemini({ model, system, messages, keys }) {
  const key = (keys && keys.gemini) || process.env.GEMINI_API_KEY;
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
  const key = (keys && keys[cfg.keyField]) || process.env[cfg.env];
  if (!key) throw new Error(`Missing ${cfg.env} — add it under "Your API keys" or set it on the server.`);
  return key;
}

async function openaiCompat(cfg, { model, system, messages, keys }) {
  const key = compatKey(cfg, keys);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const t0 = Date.now();
  const r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: msgs }),
  });
  const j = await r.json();
  const latencyMs = Date.now() - t0;
  if (!r.ok) throw new Error(`${cfg.label} ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);

  const msg = j.choices?.[0]?.message || {};
  const text = msg.content || '';
  const reasoning = msg.reasoning_content || '';          // Kimi/DeepSeek-style thinking
  const u = j.usage || {};
  const think = u.completion_tokens_details?.reasoning_tokens ?? (reasoning ? estimateTokens([{ content: reasoning }]) : 0);
  return {
    text, reasoning,
    promptTokens: u.prompt_tokens ?? estimateTokens(msgs),
    completionTokens: u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]),
    reasoningTokens: think,
    latencyMs,
  };
}

// Streamed variant — same contract, emits onDelta so the UI gets a live feed
// (without this an external model's column sits blank until it finishes).
async function openaiCompatStream(cfg, { model, system, messages, keys, onDelta }) {
  const key = compatKey(cfg, keys);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = { model, messages: msgs, stream: true };
  if (cfg.usageOpt) body.stream_options = { include_usage: true }; // OpenAI reports usage in the final chunk
  const t0 = Date.now();
  const r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify(await r.json()); } catch (e) { try { detail = await r.text(); } catch (_) { detail = ''; } }
    throw new Error(`${cfg.label} ${r.status}: ${String(detail).slice(0, 400)}`);
  }

  let text = '', reasoning = '', usage = null;
  await readSSE(r, (ev) => {
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) text += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (onDelta) onDelta({ answer: text, reasoning, runningOut: estimateTokens([{ content: text }]), runningThink: estimateTokens([{ content: reasoning }]) });
  });
  const latencyMs = Date.now() - t0;
  const u = usage || {};
  const think = u.completion_tokens_details?.reasoning_tokens ?? (reasoning ? estimateTokens([{ content: reasoning }]) : 0);
  return {
    text, reasoning,
    promptTokens: u.prompt_tokens ?? estimateTokens(msgs),
    completionTokens: u.completion_tokens ?? estimateTokens([{ content: text + reasoning }]),
    reasoningTokens: think,
    latencyMs,
  };
}

const openai = (args) => openaiCompat(OPENAI_COMPAT.openai, args);
const moonshot = (args) => openaiCompat(OPENAI_COMPAT.moonshot, args);

async function anthropic({ model, system, messages, keys }) {
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

async function agentplatform({ publisher, model, system, messages, project, keys }) {
  const pub = publisher || 'google';
  if (pub === 'anthropic') return agentPlatformClaude({ model, system, messages, project, keys });
  return agentPlatformGemini({ model, system, messages, keys });
}

async function agentPlatformGemini({ model, system, messages, keys }) {
  const key = (keys && (keys.agentplatform || keys.gemini)) || process.env.AGENT_PLATFORM_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: {
      temperature: 0.2,
      thinkingConfig: { includeThoughts: true }, // ask the model to return its reasoning
    },
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

async function agentPlatformClaude({ model, system, messages, project, keys }) {
  const proj = (keys && keys.gcpProject) || project || process.env.GCP_PROJECT_ID || '';
  const userToken = keys && keys.claudeBearerToken; // if the user brought their own token, use it (no minting)

  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: CLAUDE_MAX_OUTPUT,
    thinking: { type: 'adaptive' },          // Opus 4.8 uses adaptive thinking
    output_config: { effort: process.env.CLAUDE_EFFORT || 'high' }, // engage adaptive thinking
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (system) body.system = system;
  // (temperature intentionally omitted: Anthropic requires it unset when thinking is on)

  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(model)}:rawPredict`;

  const payload = JSON.stringify(body);
  const send = (token) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload,
    });

  const t0 = Date.now();
  let r = await send(userToken || await getClaudeToken());
  if (r.status === 401 && !userToken) r = await send(await getClaudeToken({ forceRefresh: true })); // token expired -> mint fresh, retry once
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
  return {
    text,
    reasoning,
    reasoningTokens: u.output_tokens_details?.thinking_tokens ?? undefined,
    promptTokens: u.input_tokens ?? estimateTokens(messages, system),
    completionTokens: u.output_tokens ?? estimateTokens([{ content: text }]),
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

async function agentPlatformGeminiStream({ model, system, messages, onDelta, keys }) {
  const key = (keys && (keys.agentplatform || keys.gemini)) || process.env.AGENT_PLATFORM_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing AGENT_PLATFORM_API_KEY in environment (.env)');
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { temperature: 0.2, thinkingConfig: { includeThoughts: true } },
  };
  if (MAX_OUTPUT_TOKENS) body.generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`;

  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

async function agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys }) {
  const proj = (keys && keys.gcpProject) || project || process.env.GCP_PROJECT_ID || '';
  const userToken = keys && keys.claudeBearerToken;
  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: CLAUDE_MAX_OUTPUT,
    thinking: { type: 'adaptive' },
    output_config: { effort: process.env.CLAUDE_EFFORT || 'high' },
    stream: true,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (system) body.system = system;
  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}` +
    `/locations/global/publishers/anthropic/models/${encodeURIComponent(model)}:streamRawPredict`;

  const payload = JSON.stringify(body);
  const send = (token) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload });

  const t0 = Date.now();
  let r = await send(userToken || await getClaudeToken());
  if (r.status === 401 && !userToken) r = await send(await getClaudeToken({ forceRefresh: true })); // token expired -> mint fresh, retry once
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = await r.text(); } throw new Error(`Claude (Agent Platform) ${r.status}: ${JSON.stringify(e).slice(0, 400)}`); }

  let answer = '', reasoning = '', inTok = 0, outTok = 0, thinkTok = 0;
  await readSSE(r, (ev) => {
    if (ev.type === 'message_start' && ev.message?.usage) inTok = ev.message.usage.input_tokens || inTok;
    else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') { answer += d.text || ''; if (onDelta) onDelta({ answer, reasoning, runningOut: outTok || null, runningThink: thinkTok }); }
      else if (d.type === 'thinking_delta') { reasoning += d.thinking || ''; if (onDelta) onDelta({ answer, reasoning, runningOut: outTok || null, runningThink: thinkTok }); }
    } else if (ev.type === 'message_delta' && ev.usage) {
      outTok = ev.usage.output_tokens || outTok;
      if (ev.usage.output_tokens_details) thinkTok = ev.usage.output_tokens_details.thinking_tokens || thinkTok;
      if (onDelta) onDelta({ answer, reasoning, runningOut: outTok, runningThink: thinkTok });
    }
  });
  const latencyMs = Date.now() - t0;
  return {
    text: answer, reasoning: reasoning.trim(), reasoningTokens: thinkTok || undefined,
    promptTokens: inTok || estimateTokens(messages, system),
    completionTokens: outTok || estimateTokens([{ content: answer }]),
    latencyMs,
  };
}

const ADAPTERS = { agentplatform, gemini, openai, anthropic, moonshot };

// `keys` (optional) lets a user bring their own API credentials for a run; each
// adapter uses keys.<x> when present, else falls back to the server's env vars.
async function complete({ provider, model, system, messages, publisher, project, onDelta, keys }) {
  if (provider === 'agentplatform' && onDelta) {
    const pub = publisher || 'google';
    return pub === 'anthropic'
      ? agentPlatformClaudeStream({ model, system, messages, project, onDelta, keys })
      : agentPlatformGeminiStream({ model, system, messages, onDelta, keys });
  }
  // OpenAI-compatible providers stream too, so an external model's column gets
  // the same live token feed as the Vertex ones.
  if (OPENAI_COMPAT[provider] && onDelta) {
    return openaiCompatStream(OPENAI_COMPAT[provider], { model, system, messages, onDelta, keys });
  }
  const fn = ADAPTERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  return fn({ model, system, messages, publisher, project, keys });
}

module.exports = { complete, estimateTokens, ADAPTERS };
