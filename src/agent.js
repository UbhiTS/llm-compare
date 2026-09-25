// ---------------------------------------------------------------------------
// The agentic loop: generate -> run tests -> read failures -> fix -> repeat.
//
// This is the "deep thinking + agent workflow" being measured. Each iteration
// is a real model call; the test runner is the tool the agent gets feedback
// from. We accumulate tokens, latency and cost across the whole loop.
// ---------------------------------------------------------------------------

const { complete, thinkingProfile } = require('./providers');
const { runTests } = require('./runner');
const { priceFor } = require('./pricing');
const { budgetAttachmentsForModel } = require('./attachments');

const SYSTEM_PROMPT =
  'You are an expert software engineer. You write correct, efficient JavaScript ' +
  'and carefully handle edge cases. When asked to fix code, you reason about why ' +
  'the failing cases failed before rewriting.';

// Used for ALL coding tasks (graded JS and Python program tasks): forces code-only output.
const CODE_SYSTEM_PROMPT =
  'You are an expert software engineer. You write correct, efficient code and carefully ' +
  'handle edge cases. Output ONLY source code: a single fenced code block in the requested ' +
  'language, with NO prose, explanation, or any text before or after the block. Put any ' +
  'necessary notes in code comments. When asked to fix code, reason about why the failing ' +
  'cases failed, then return ONLY the corrected, complete code block.';

function extractCode(text) {
  if (!text) return '';
  // Prefer a fenced code block of any language (```python, ```js, ```, …).
  const fenced = text.match(/```[a-zA-Z0-9+#.-]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

function buildInitialMessages(task) {
  const attachments = Array.isArray(task.attachments) && task.attachments.length ? task.attachments : undefined;
  // Non-coding (general / custom) prompt: send the user's prompt verbatim.
  if (!task.language) {
    return [{ role: 'user', content: task.prompt, attachments }];
  }
  const lang = task.language === 'python' ? 'python' : 'javascript';
  const graded = !!(task.testCases && task.testCases.length);
  const tail = graded
    ? `\n\nImplement a ${lang} function named \`${task.functionName}\`. Return ONLY a single fenced ` +
      `\`\`\`${lang} code block with the complete function definition — no prose, no explanation, ` +
      `and no text before or after the block.`
    : `\n\nReturn ONLY a single fenced \`\`\`${lang} code block with the complete program — ` +
      `no prose, no explanation, and no text before or after the block.`;
  return [{ role: 'user', content: `${task.prompt}${tail}`, attachments }];
}

// A repair round: the model's own program crashed when it was actually run, so
// hand it back its code plus the real failure output and ask for a corrected
// version. Kept to ONE round by the caller — this is a demo, not an agent loop.
const MAX_REPAIR_CHARS = 6000;      // enough for a full program without blowing the prompt
const MAX_REPAIR_ERR = 2000;        // a traceback's tail is the useful part

function buildRepairMessages(task, repair) {
  const attachments = Array.isArray(task.attachments) && task.attachments.length ? task.attachments : undefined;
  const code = String((repair && repair.code) || '').slice(0, MAX_REPAIR_CHARS);
  const err = String((repair && repair.error) || '').slice(-MAX_REPAIR_ERR);
  const lang = task.language === 'python' ? 'python' : task.language === 'javascript' ? 'javascript' : '';
  const fence = lang || '';
  return [{
    role: 'user',
    attachments,
    content:
      `${task.prompt}\n\n` +
      `---\n\n` +
      `You already answered this, but the program you produced FAILED when it was run. ` +
      `Here is the code you returned:\n\n\`\`\`${fence}\n${code}\n\`\`\`\n\n` +
      `And here is what happened when it ran:\n\n\`\`\`\n${err}\n\`\`\`\n\n` +
      `Diagnose the failure and return the COMPLETE corrected program. Do not return a patch, ` +
      `a diff, or only the changed lines — return the whole file, ready to run. ` +
      (fence
        ? `Return ONLY a single fenced \`\`\`${fence} code block with no prose before or after it.`
        : `Return only the corrected output.`),
  }];
}

function buildFixMessage(task, failing) {
  const shown = failing.slice(0, 5);
  const lines = shown
    .map(
      (f) =>
        `- ${task.functionName}(${f.inputStr}) -> got ${f.gotStr}, expected ${f.expectedStr}`
    )
    .join('\n');
  const more = failing.length > shown.length ? `\n(...and ${failing.length - shown.length} more failing cases)` : '';
  return (
    `Your solution failed these hidden test cases:\n${lines}${more}\n\n` +
    `Identify the bug, then return ONLY a corrected \`\`\`${task.language || 'javascript'} code block ` +
    'with the full function — no prose or explanation outside the code.'
  );
}

async function runAgent({ modelConfig, task, maxIterations, emit, keys, signal, repair }) {
  const slot = modelConfig.slot;
  const system = task.language
    ? CODE_SYSTEM_PROMPT
    : 'You are a helpful assistant. When the user asks for a detailed plan or analysis, be thorough and well-structured.';

  // Per-model context window budgeting & smart head+tail fitting for attachments
  const budgetRes = budgetAttachmentsForModel(task.attachments, { prompt: task.prompt, modelConfig });
  const modelTask = Array.isArray(task.attachments) && task.attachments.length
    ? { ...task, attachments: budgetRes.attachments }
    : task;
  if (budgetRes.contextWarning) {
    emit({
      type: 'context_warning',
      slot,
      warning: budgetRes.contextWarning,
      message: budgetRes.contextWarning,
      estimatedInputTokens: budgetRes.estimatedInputTokens,
      contextLimit: budgetRes.contextLimit,
    });
  }

  // A repair run replaces the opening turn with the crash report; everything
  // downstream (streaming, metrics, cost) is identical to a normal run.
  const isRepair = !!(repair && repair.code && repair.error);
  const messages = isRepair ? buildRepairMessages(modelTask, repair) : buildInitialMessages(modelTask);

  // completionTokens = ALL output tokens (answer + thinking, which is how output is billed);
  // reasoningTokens = the thinking subset. answer-only = completionTokens - reasoningTokens.
  const totals = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, apiLatencyMs: 0 };
  let iterations = 0;
  let code = '';
  let lastReasoning = '';
  let passed = 0;
  const total = task.testCases.length;
  let firstTryPassed = null;
  const history = []; // [{ iteration, passed, total }]
  const attachmentNotes = []; // provider-specific attachment handling shown in the slot

  const price = priceFor(modelConfig);
  const runningCost = () =>
    (price.input * totals.promptTokens) / 1e6 + (price.output * totals.completionTokens) / 1e6;

  const wallStart = Date.now();

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    emit({ type: 'status', slot, phase: 'thinking', iteration: iterations });
    let lastDelta = 0;
    const samples = []; // [{ms, charsLen}] rolling window for live tok/s
    const WINDOW_MS = 1000; // 1 second
    const onDelta = ({ answer, reasoning, runningOut, runningThink }) => {
      const now = Date.now();
      if (now - lastDelta < 60) return; // throttle delta emissions to ~16 fps
      lastDelta = now;
      const wallMs = Date.now() - wallStart;
      const charsLen = (answer || '').length + (reasoning || '').length;
      // rolling 1s rate from char growth (smooth, immune to end-of-stream usage corrections)
      samples.push({ ms: wallMs, charsLen });
      while (samples.length > 1 && samples[0].ms < wallMs - WINDOW_MS) samples.shift();
      let rollingTps = 0;
      if (samples.length >= 2) {
        const first = samples[0], last = samples[samples.length - 1];
        const dt = (last.ms - first.ms) / 1000;
        const dc = last.charsLen - first.charsLen;
        if (dt > 0 && dc > 0) rollingTps = +((dc / 4) / dt).toFixed(1);
      }
      // Split-aware LIVE estimate. Providers often don't populate token counts
      // mid-stream (Gemini reports thoughtsTokenCount only at the end), so estimate
      // thinking from the reasoning text and answer from the answer text, taking the
      // max with any provider count. (The final exact split lands on the metrics/done event.)
      const thinkNow = Math.max(runningThink || 0, Math.ceil((reasoning || '').length / 4));
      const answerNow = Math.max(
        runningOut != null ? Math.max(0, runningOut - (runningThink || 0)) : 0,
        Math.ceil((answer || '').length / 4)
      );
      // Live cost = prior rounds' cost + this round's streaming output so far (output
      // tokens incl. thinking are billed at price.output). Input cost for the current
      // round lands when the round's usage arrives on the metrics event.
      const liveOut = totals.completionTokens + answerNow + thinkNow;
      const liveCostUsd = +(((price.input * totals.promptTokens) + (price.output * liveOut)) / 1e6).toFixed(6);
      emit({
        type: 'delta', slot, iteration: iterations,
        answer: answer || '', reasoning: reasoning || '',
        estOutTokens: answerNow + thinkNow,   // total (answer + thinking)
        reasoningTokens: thinkNow,            // thinking subset; UI shows answer = total − thinking
        costUsd: liveCostUsd,
        currentTokensPerSec: rollingTps,
        wallMs,
      });
    };
    const resp = await complete({
      provider: modelConfig.provider,
      publisher: modelConfig.publisher,
      project: modelConfig.project,
      model: modelConfig.model,
      effort: modelConfig.effort,        // per-card reasoning level, already validated server-side
      endpointType: modelConfig.endpointType,
      region: modelConfig.region,
      thinkingMode: modelConfig.thinkingMode,
      system,
      messages,
      onDelta,
      keys,
      signal,
    });

    // Visible record of any attachment substitution (e.g. an image auto-scaled
    // for this model because the provider rejects the original) — never silent.
    if (Array.isArray(resp.attachmentNotes) && resp.attachmentNotes.length) {
      const fresh = resp.attachmentNotes.filter((n) => !attachmentNotes.includes(n));
      if (fresh.length) {
        attachmentNotes.push(...fresh);
        emit({ type: 'attachment_note', slot, notes: attachmentNotes.slice(), message: attachmentNotes.join(' · ') });
      }
    }

    totals.promptTokens += resp.promptTokens;
    totals.completionTokens += resp.completionTokens;
    totals.reasoningTokens += resp.reasoningTokens || 0;
    totals.apiLatencyMs += resp.latencyMs;
    // Coding tasks (have a `language`) return a fenced code block → extract it.
    // Prose/general tasks (no language) keep the raw text.
    code = task.language ? extractCode(resp.text) : resp.text.trim();
    lastReasoning = resp.reasoning || '';

    // Live, cumulative metrics — emitted the moment each round's generation
    // lands, so the UI ticks up tokens / tokens-per-second / cost per round.
    emit({
      type: 'metrics',
      slot,
      iteration: iterations,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      reasoningTokens: totals.reasoningTokens,
      totalTokens: totals.promptTokens + totals.completionTokens,
      costUsd: +runningCost().toFixed(6),
      apiLatencyMs: totals.apiLatencyMs,
      tokensPerSec: totals.apiLatencyMs
        ? +(totals.completionTokens / (totals.apiLatencyMs / 1000)).toFixed(1)
        : 0,
      wallMs: Date.now() - wallStart,
      roundCompletionTokens: resp.completionTokens,
      roundReasoningTokens: resp.reasoningTokens ?? null,
      roundLatencyMs: resp.latencyMs,
      reasoning: lastReasoning,
    });

    if (total === 0) {
      // Custom prompt: no hidden tests — just surface the output + metrics.
      emit({ type: 'iteration', slot, iteration: iterations, passed: 0, total: 0, code, reasoning: lastReasoning, roundCompletionTokens: resp.completionTokens });
      break;
    }

    emit({ type: 'status', slot, phase: 'testing', iteration: iterations });
    const tr = runTests(code, task.functionName, task.testCases);
    passed = tr.passed;
    if (firstTryPassed === null) firstTryPassed = passed;
    history.push({ iteration: iterations, passed, total });

    emit({
      type: 'iteration',
      slot,
      iteration: iterations,
      passed,
      total,
      code,
      reasoning: lastReasoning,
      roundCompletionTokens: resp.completionTokens,
    });

    if (passed === total) break;

    // Feed the failures back so the agent can self-correct.
    messages.push({ role: 'assistant', content: resp.text });
    messages.push({ role: 'user', content: buildFixMessage(task, tr.failing) });
  }

  const wallMs = Date.now() - wallStart;
  const totalTokens = totals.promptTokens + totals.completionTokens;
  const costUsd = runningCost();

  return {
    slot,
    label: modelConfig.label,
    provider: modelConfig.provider,
    model: modelConfig.model,
    price,
    thinking: thinkingProfile(modelConfig),   // what reasoning config this run was sent
    contextWarning: budgetRes.contextWarning || null,
    ...(attachmentNotes.length ? { attachmentNotes } : {}),
    repaired: isRepair,                       // this output followed a crash-repair round
    iterations,
    passed,
    total,
    solved: total ? passed === total : null,
    correctness: total ? Math.round((passed / total) * 100) : null,
    firstTryCorrectness: total ? Math.round(((firstTryPassed || 0) / total) * 100) : null,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens,
    apiLatencyMs: totals.apiLatencyMs,
    wallMs,
    tokensPerSec: totals.apiLatencyMs
      ? +(totals.completionTokens / (totals.apiLatencyMs / 1000)).toFixed(1)
      : 0,
    costUsd: +costUsd.toFixed(6),
    history,
    code,
    reasoning: lastReasoning,
  };
}

module.exports = { runAgent, SYSTEM_PROMPT };
