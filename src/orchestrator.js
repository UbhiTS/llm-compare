// ---------------------------------------------------------------------------
// Runs the three agent loops CONCURRENTLY (Promise.all). Because each loop is
// dominated by network I/O to its provider, this gives real wall-clock
// parallelism — all three models are working at the same time. Events stream
// out as they happen so the UI can update each column live.
// ---------------------------------------------------------------------------

const { runAgent } = require('./agent');
const { thinkingProfile } = require('./providers');

async function runComparison({ task, models, maxIterations, emit, keys, signal, repair }) {
  emit({
    type: 'start',
    task: {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      testCount: task.testCases.length,
      functionName: task.functionName,
      attachments: Array.isArray(task.attachments)
        ? task.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, kind: a.kind }))
        : [],
    },
    models: models.map((m) => ({ slot: m.slot, label: m.label, provider: m.provider, model: m.model, price: m.price, thinking: thinkingProfile(m) })),
    maxIterations,
    startedAt: Date.now(),
  });

  const results = await Promise.all(
    models.map(async (m) => {
      try {
        const result = await runAgent({ modelConfig: m, task, maxIterations, emit, keys, signal, repair });
        emit({ type: 'done', slot: m.slot, result });
        return result;
      } catch (e) {
        const message = String((e && e.message) || e);
        emit({ type: 'model_error', slot: m.slot, label: m.label, message });
        return { slot: m.slot, label: m.label, error: message };
      }
    })
  );

  emit({ type: 'all_done', results });
  return results;
}

module.exports = { runComparison };
