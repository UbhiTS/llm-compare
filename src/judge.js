// ---------------------------------------------------------------------------
// judge.js — LLM-as-judge scoring for ungraded tasks.
//
// The business/general tasks have no hidden tests, so a run produces no quality
// signal at all. This asks a model to score the outputs against a rubric.
//
// The whole design point is that the result survives a customer asking "isn't
// that rigged?", so two things are non-negotiable:
//
//   * BLIND. The judge never sees model names, providers or prices. Responses
//     are relabelled "Response A/B/C…" and the mapping back to slots is kept
//     here on the server.
//   * SHUFFLED. Judges carry a position bias toward whatever they read first,
//     so the order is randomised per call and reported back with the result.
//
// The judge model is chosen by the caller, not hardcoded, and is echoed in the
// response so the UI can always show who did the scoring.
// ---------------------------------------------------------------------------

const { complete } = require('./providers');

// Answers go to the judge IN FULL. The only real ceiling is the JUDGE'S OWN
// context window, which is not a single number — it is 1M tokens on the Gemini 3.x
// and Claude 4.6+ models, but 200K on Opus 4.5 / Sonnet 4.5 / Haiku 4.5 and
// unknown on the external ones. So the budget is derived per judge rather than
// hardcoded, and only ~55% of the window is spent on answers, leaving room for
// the task prompt, the rubric, and the judge's own reasoning and output.
//
// Fairness is why this matters: an answer that arrives silently clipped reads as
// incomplete and gets marked down for it, which would penalise precisely the
// models that wrote the most. Trimming is a last resort, applied evenly, and
// always declared — to the judge in its prompt and to the user in the UI.
const CHARS_PER_TOKEN = 4;          // matches estimateTokens() in providers.js
const CONTEXT_SHARE = 0.55;         // of the window, spent on the answers
const DEFAULT_CONTEXT = 200000;     // conservative when a model's window is unknown
const MIN_PER_RESPONSE = 20000;     // no answer is ever trimmed below this
const MAX_TASK_CHARS = 20000;       // the longest shipped task prompt is ~3.7k

function budgetFor(judge) {
  const ctx = (judge && judge.context) || DEFAULT_CONTEXT;
  return Math.floor(ctx * CONTEXT_SHARE * CHARS_PER_TOKEN);
}

// Scored 1-10 each. Deliberately four axes that mean something for a business
// deliverable — not a single vague "quality" number nobody can argue with.
const CRITERIA = [
  { key: 'completeness',  label: 'Completeness',  hint: 'Covers everything the task actually asked for, with nothing important missing.' },
  { key: 'accuracy',      label: 'Accuracy',      hint: 'Claims, figures and reasoning are sound and internally consistent.' },
  { key: 'structure',     label: 'Structure',     hint: 'Organisation and formatting make it easy to read and genuinely presentable.' },
  { key: 'actionability', label: 'Actionability', hint: 'Specific and concrete enough to act on, rather than generic advice.' },
];

// Deterministic-enough shuffle. Randomised per call so position bias does not
// consistently favour whichever slot happens to be first on screen.
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const letter = (i) => String.fromCharCode(65 + i);

// Only ever trims when the combined set would blow the budget, and then evenly
// rather than punishing whoever happens to be longest.
function fitToBudget(list, budget) {
  const total = list.reduce((a, e) => a + e.text.length, 0);
  if (total <= budget) return list.map((e) => ({ ...e, truncated: false }));
  const share = Math.max(MIN_PER_RESPONSE, Math.floor(budget / list.length));
  return list.map((e) => (e.text.length <= share
    ? { ...e, truncated: false }
    : { ...e, text: e.text.slice(0, share), truncated: true }));
}

function buildPrompt(task, blinded) {
  const criteria = CRITERIA.map((c) => `- ${c.key}: ${c.hint}`).join('\n');
  const anyTrimmed = blinded.some((b) => b.truncated);
  const bodies = blinded
    .map((b) => `----- Response ${b.id}${b.truncated ? ' (shortened for length — see note above)' : ''} -----\n${b.text}`)
    .join('\n\n');
  const trimNote = anyTrimmed
    ? `\nIMPORTANT: the responses marked "shortened for length" were too long to include in full and were cut off at the end for transport reasons. ` +
      `That is an artefact of how they were sent to you, NOT a flaw in the response. Do not mark such a response down for completeness ` +
      `or for appearing to stop mid-sentence — judge it on the substance you can see.\n`
    : '';
  const schema = `{"scores":[{"id":"A",${CRITERIA.map((c) => `"${c.key}":<1-10>`).join(',')},"note":"<one sentence, max 25 words>"}],"winner":"<id>","why":"<one or two sentences>"}`;
  return (
    `You are judging ${blinded.length} anonymous responses to the same task.\n\n` +
    `You do NOT know which system produced which response. Do not speculate about ` +
    `authorship, and do not let response length alone decide the score — a shorter ` +
    `response that fully answers the task beats a longer one that pads.\n\n` +
    `=== TASK GIVEN TO EVERY SYSTEM ===\n${String(task.prompt || '').slice(0, MAX_TASK_CHARS)}\n\n` +
    trimNote +
    `=== RESPONSES ===\n${bodies}\n\n` +
    `=== HOW TO SCORE ===\nScore every response from 1 to 10 on each criterion:\n${criteria}\n\n` +
    `Use the full range. If two responses are genuinely close, give them close ` +
    `scores; if one is clearly better, say so decisively.\n\n` +
    `Return ONLY a single JSON object, no prose and no code fence:\n${schema}`
  );
}

// Models like to wrap JSON in a fence or add a sentence. Pull out the object.
function parseJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The judge did not return JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

const clamp10 = (v) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null;
};

/**
 * Score a set of outputs.
 * @param entries [{ slot, label, text }] — label is used only to map results back.
 * @param judge   a resolved model config (provider/model/publisher/effort).
 * @returns { judge, criteria, blindOrder, results:[{slot,label,scores,overall,note}], winnerSlot, why, raw }
 */
async function judgeOutputs({ task, entries, judge, keys, signal }) {
  const usable = (entries || []).filter((e) => e && String(e.text || '').trim());
  if (usable.length < 2) throw new Error('Need at least two non-empty outputs to compare.');

  const blinded = fitToBudget(shuffled(usable).map((e, i) => ({
    id: letter(i),
    slot: e.slot,
    label: e.label,
    text: String(e.text),            // full answer — see the budget note at the top
  })), budgetFor(judge));

  const resp = await complete({
    provider: judge.provider,
    publisher: judge.publisher,
    project: judge.project,
    model: judge.model,
    effort: judge.effort,
    endpointType: judge.endpointType,
    region: judge.region,
    thinkingMode: judge.thinkingMode,
    system: 'You are a rigorous, impartial evaluator. You return only the JSON object you are asked for.',
    messages: [{ role: 'user', content: buildPrompt(task, blinded) }],
    keys,
    signal,
  });

  const parsed = parseJson(resp.text);
  const byId = new Map((parsed.scores || []).map((s) => [String(s.id || '').trim().toUpperCase(), s]));

  const results = blinded.map((b) => {
    const s = byId.get(b.id) || {};
    const scores = {};
    let sum = 0, n = 0;
    CRITERIA.forEach((c) => {
      const v = clamp10(s[c.key]);
      scores[c.key] = v;
      if (v != null) { sum += v; n += 1; }
    });
    return {
      slot: b.slot,
      label: b.label,
      blindId: b.id,
      truncated: !!b.truncated,
      charsSent: b.text.length,
      scores,
      overall: n ? +(sum / n).toFixed(1) : null,
      note: String(s.note || '').slice(0, 300),
    };
  });

  const winnerId = String(parsed.winner || '').trim().toUpperCase();
  const winner = results.find((r) => r.blindId === winnerId);

  return {
    judge: { label: judge.label, model: judge.model, provider: judge.provider },
    criteria: CRITERIA.map((c) => ({ key: c.key, label: c.label })),
    blindOrder: blinded.map((b) => b.id + '=' + b.label),   // audit trail: what the judge actually saw
    truncated: blinded.some((b) => b.truncated),
    charsSent: blinded.reduce((a, b) => a + b.text.length, 0),
    budgetChars: budgetFor(judge),
    judgeContext: (judge && judge.context) || null,
    results,
    winnerSlot: winner ? winner.slot : null,
    why: String(parsed.why || '').slice(0, 600),
    usage: {
      promptTokens: resp.promptTokens,
      completionTokens: resp.completionTokens,
      latencyMs: resp.latencyMs,
    },
  };
}

module.exports = { judgeOutputs, CRITERIA };
