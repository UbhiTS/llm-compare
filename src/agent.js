// ---------------------------------------------------------------------------
// The agentic loop: generate -> run tests -> read failures -> fix -> repeat.
//
// This is the "deep thinking + agent workflow" being measured. Each iteration
// is a real model call; the test runner is the tool the agent gets feedback
// from. We accumulate tokens, latency and cost across the whole loop.
// ---------------------------------------------------------------------------

const { complete, thinkingProfile, estimateTokens } = require('./providers');
const { withRetryListener } = require('./providerFetch');
const { runTests } = require('./runner');
const { priceFor, priceForPrompt, callCostUsd } = require('./pricing');
const { budgetAttachmentsForModel } = require('./attachments');
const { CAD_SYSTEM_PROMPT, isCadTask, buildCadModifyMessages } = require('./cadArena');

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

async function runAgent({ modelConfig, task, maxIterations, emit, keys, signal, repair, cadModifySlot, auditUser }) {
  const slot = modelConfig.slot;
  const cadTask = isCadTask(task);
  const system = cadTask
    ? CAD_SYSTEM_PROMPT
    : task.language
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
      costUsd: 0, // nothing spent yet
    });
  }

  // A repair run replaces the opening turn with the crash report; everything
  // downstream (streaming, metrics, cost) is identical to a normal run.
  const isRepair = !!(repair && repair.code && repair.error);
  const isCadModify = !!(
    cadModifySlot &&
    cadModifySlot.previousCode &&
    cadModifySlot.modificationPrompt
  );
  const messages = isRepair
    ? buildRepairMessages(modelTask, repair)
    : isCadModify
      ? buildCadModifyMessages({
          originalPrompt: modelTask.prompt,
          previousCode: cadModifySlot.previousCode,
          modificationPrompt: cadModifySlot.modificationPrompt,
          targetPart: cadModifySlot.targetPart,
          telemetry: cadModifySlot.telemetry,
          fourViewDataUrl: cadModifySlot.fourViewDataUrl,
          slot,
          extraAttachments: modelTask.attachments,
        })
      : buildInitialMessages(modelTask);

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

  const price = priceFor(modelConfig); // base price (reported on the result)
  // Cost accrues per provider call, each priced for ITS OWN prompt size (callCostUsd):
  // a tiered model (Claude Haiku 5.5) bills a call with a 100K+ token prompt at the higher
  // rate for both its input and output, so a multi-round task adds up its calls' costs
  // instead of pricing the summed tokens at one flat rate.
  let costSoFar = 0;
  // The in-flight call's best estimate (updated on every delta, reset once its real
  // usage lands). costSoFar + live is what every event carries as `costUsd`, and what
  // an abort / provider error reports as `partialCostUsd`: the tokens already streamed
  // are billed upstream whether or not the slot finishes.
  const live = { started: false, estPromptTokens: 0, promptTokens: null, completionTokens: 0, costUsd: 0 };
  const resetLive = (estPromptTokens) => { live.started = false; live.estPromptTokens = estPromptTokens; live.promptTokens = null; live.completionTokens = 0; live.costUsd = 0; };
  const runningCost = () => costSoFar + live.costUsd;
  // Spend to report if this slot dies now: completed calls + the in-flight call, whose
  // prompt counts (at its tier) as soon as generation has started, plus its live output.
  const partialCost = () => {
    if (!live.started) return costSoFar;
    const promptTokens = live.promptTokens != null ? live.promptTokens : live.estPromptTokens;
    return costSoFar + callCostUsd(modelConfig, promptTokens, live.completionTokens);
  };
  // Every event this slot emits carries the cumulative best-estimate cost, so the
  // server can meter partial spend on abort or error (not only on `done`).
  const emitSlot = (ev) => emit(ev.costUsd != null ? ev : { ...ev, costUsd: +runningCost().toFixed(6) });

  // Provider stop reasons that mean "do not keep iterating": the output was blocked
  // or refused, so feeding an empty / clipped answer back would only burn more rounds.
  const SAFETY_STOP_RE = /SAFETY|PROHIBITED|RECITATION|BLOCKLIST|SPII|refusal|blocked|content_filter/i;
  const TRUNCATION_RE = /max_tokens|length|MAX_TOKENS/i;
  let anyTruncated = false;
  let lastStopReason = null;

  const wallStart = Date.now();

  try {
  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    emitSlot({ type: 'status', slot, phase: 'thinking', iteration: iterations });
    // Our own estimate of this call's prompt size: only picks the live price tier until the
    // provider reports the real prompt-token count mid-stream (see the live cost below).
    const estPromptTokens = estimateTokens(messages, system);
    resetLive(estPromptTokens);
    let lastDelta = 0;
    let sentAnswer = '';
    let sentReasoning = '';
    const samples = []; // [{ms, charsLen}] rolling window for live tok/s
    const WINDOW_MS = 1000; // 1 second
    const onDelta = ({ answer, reasoning, runningOut, runningThink, runningIn }) => {
      const now = Date.now();
      const curAns = answer || '';
      const curReason = reasoning || '';
      // Split-aware LIVE estimate. Providers often don't populate token counts
      // mid-stream (Gemini reports thoughtsTokenCount only at the end), so estimate
      // thinking from the reasoning text and answer from the answer text, taking the
      // max with any provider count. (The final exact split lands on the metrics/done event.)
      const thinkNow = Math.max(runningThink || 0, Math.ceil(curReason.length / 4));
      const answerNow = Math.max(
        runningOut != null ? Math.max(0, runningOut - (runningThink || 0)) : 0,
        Math.ceil(curAns.length / 4)
      );
      // Live cost = prior calls' cost + this call so far. This call is priced for its own
      // prompt size (priceForPrompt): the provider's prompt-token count once the stream has
      // reported it (its input cost is then included), else our estimate above, used only to
      // pick the tier (input cost then lands when the call's usage arrives on the metrics
      // event). Streaming output tokens (incl. thinking) are billed at that tier's output rate.
      const callIn = Number(runningIn) > 0 ? Number(runningIn) : null;
      const callPrice = priceForPrompt(modelConfig, callIn != null ? callIn : estPromptTokens);
      // Kept current on EVERY delta (it is what an abort reports), even when the UI
      // emission below is throttled.
      live.started = true;
      live.promptTokens = callIn;
      live.completionTokens = answerNow + thinkNow;
      live.costUsd = ((callIn != null ? callPrice.input * callIn : 0) + callPrice.output * (answerNow + thinkNow)) / 1e6;
      if (now - lastDelta < 60) return; // throttle delta emissions to ~16 fps
      lastDelta = now;
      const wallMs = Date.now() - wallStart;
      const charsLen = curAns.length + curReason.length;
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
      const liveCostUsd = +(costSoFar + live.costUsd).toFixed(6);

      // Compute O(1) incremental deltas so we don't re-serialize & secret-scrub
      // the entire cumulative text on every 60ms tick.
      const answerReset = !curAns.startsWith(sentAnswer);
      const answerDelta = answerReset ? curAns : curAns.slice(sentAnswer.length);
      sentAnswer = curAns;

      const reasoningReset = !curReason.startsWith(sentReasoning);
      const reasoningDelta = reasoningReset ? curReason : curReason.slice(sentReasoning.length);
      sentReasoning = curReason;

      emit({
        type: 'delta', slot, iteration: iterations,
        ...(answerDelta || answerReset ? { answerDelta, ...(answerReset ? { answerReset: true } : {}) } : {}),
        ...(reasoningDelta || reasoningReset ? { reasoningDelta, ...(reasoningReset ? { reasoningReset: true } : {}) } : {}),
        estOutTokens: answerNow + thinkNow,   // total (answer + thinking)
        reasoningTokens: thinkNow,            // thinking subset; UI shows answer = total − thinking
        costUsd: liveCostUsd,
        currentTokensPerSec: rollingTps,
        wallMs,
      });
    };
    const resp = await withRetryListener(
      (retryInfo) => {
        emitSlot({
          type: 'status',
          slot,
          phase: 'retrying',
          iteration: iterations,
          status: retryInfo.status,
          attempt: retryInfo.attempt,
          maxRetries: retryInfo.maxRetries,
          delayMs: retryInfo.delayMs,
        });
      },
      () => complete({
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
        auditUser,
      })
    );

    // Visible record of any attachment substitution (e.g. an image auto-scaled
    // for this model because the provider rejects the original) — never silent.
    if (Array.isArray(resp.attachmentNotes) && resp.attachmentNotes.length) {
      const fresh = resp.attachmentNotes.filter((n) => !attachmentNotes.includes(n));
      if (fresh.length) {
        attachmentNotes.push(...fresh);
        emitSlot({ type: 'attachment_note', slot, notes: attachmentNotes.slice(), message: attachmentNotes.join(' · ') });
      }
    }

    totals.promptTokens += resp.promptTokens;
    totals.completionTokens += resp.completionTokens;
    totals.reasoningTokens += resp.reasoningTokens || 0;
    totals.apiLatencyMs += resp.latencyMs;
    costSoFar += callCostUsd(modelConfig, resp.promptTokens, resp.completionTokens); // this call at its own prompt tier
    resetLive(0); // the call's real usage is now in costSoFar
    // Coding tasks (have a `language`) return a fenced code block → extract it.
    // Prose/general tasks (no language) keep the raw text.
    const respText = String(resp.text || '');
    code = task.language ? extractCode(respText) : respText.trim();
    lastReasoning = resp.reasoning || '';

    // Why the provider stopped: a safety / refusal stop ends the loop (the answer was
    // withheld, not wrong), a max-tokens stop is flagged as truncated, and a round with
    // no text at all is never fed back as an assistant turn (Claude/Gemini reject an
    // empty assistant message with a 400 after the cost was already spent).
    const stopReason = resp.stopReason != null ? String(resp.stopReason) : '';
    lastStopReason = stopReason || null;
    const safetyStop = SAFETY_STOP_RE.test(stopReason);
    const roundTruncated = TRUNCATION_RE.test(stopReason);
    if (roundTruncated) anyTruncated = true;
    const noText = !respText.trim();
    const note = safetyStop
      ? `stopped by the provider (stop reason: ${stopReason}) - no further rounds`
      : noText
        ? `model returned no text${stopReason ? ` (stop reason: ${stopReason})` : ''} - no further rounds`
        : roundTruncated
          ? `output cut off by the provider (stop reason: ${stopReason})`
          : null;
    const roundFlags = {
      ...(stopReason ? { stopReason } : {}),
      ...(roundTruncated ? { truncated: true } : {}),
      ...(note ? { note } : {}),
    };

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
      ...roundFlags,
    });

    if (total === 0) {
      // Custom prompt: no hidden tests — just surface the output + metrics.
      emitSlot({ type: 'iteration', slot, iteration: iterations, passed: 0, total: 0, code, reasoning: lastReasoning, roundCompletionTokens: resp.completionTokens, ...roundFlags });
      break;
    }

    emitSlot({ type: 'status', slot, phase: 'testing', iteration: iterations });
    const tr = runTests(code, task.functionName, task.testCases);
    passed = tr.passed;
    if (firstTryPassed === null) firstTryPassed = passed;
    history.push({ iteration: iterations, passed, total });

    emitSlot({
      type: 'iteration',
      slot,
      iteration: iterations,
      passed,
      total,
      code,
      reasoning: lastReasoning,
      roundCompletionTokens: resp.completionTokens,
      ...roundFlags,
    });

    if (passed === total) break;
    // A blocked / refused / empty round cannot be self-corrected: stop here instead of
    // pushing an empty assistant turn and burning the remaining rounds.
    if (safetyStop || noText) break;

    // Feed the failures back so the agent can self-correct.
    messages.push({ role: 'assistant', content: resp.text });
    messages.push({ role: 'user', content: buildFixMessage(task, tr.failing) });
  }
  } catch (e) {
    // Whatever failed (abort, provider error, timeout), the spend so far is real:
    // completed calls plus the in-flight call's streamed tokens. The orchestrator
    // forwards it on the model_error event so the server can meter it.
    if (e && typeof e === 'object') {
      try {
        e.partialCostUsd = +partialCost().toFixed(6);
        e.partialPromptTokens = totals.promptTokens + (live.started ? (live.promptTokens != null ? live.promptTokens : live.estPromptTokens) : 0);
        e.partialCompletionTokens = totals.completionTokens + live.completionTokens;
      } catch (_) { /* never mask the original error */ }
    }
    throw e;
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
    cadModified: isCadModify,
    visionAttached: Boolean(isCadModify && cadModifySlot && cadModifySlot.fourViewDataUrl),
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
    // Provider stop signal of the last round: `truncated` when any round hit the output
    // limit (max_tokens / length), so a clipped answer is never shown as a clean finish.
    stopReason: lastStopReason,
    truncated: anyTruncated,
    history,
    code,
    reasoning: lastReasoning,
  };
}

module.exports = { runAgent, SYSTEM_PROMPT };
