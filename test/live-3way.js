require('dotenv').config();
const { runComparison } = require('../src/orchestrator');
const { TASKS } = require('../src/tasks');
const { DEFAULT_MODELS } = require('../src/pricing');
const task = TASKS.find(t => t.id === 'meeting-rooms');
const reasoning = {};
(async () => {
  const results = await runComparison({
    task, models: DEFAULT_MODELS, maxIterations: 3,
    emit: (e) => {
      if (e.type === 'iteration') console.error(`[${e.slot}] round ${e.iteration}: ${e.passed}/${e.total}`);
      if (e.type === 'metrics' && e.reasoning) reasoning[e.slot] = e.reasoning;
      if (e.type === 'model_error') console.error(`[${e.slot}] ERROR ${e.message}`);
    },
  });
  const rows = results.map(r => r.error ? { label: r.label, error: r.error } : {
    label: r.label, model: r.model, solved: r.solved, correctness: r.correctness + '%',
    rounds: r.iterations, inTok: r.promptTokens, outTok: r.completionTokens,
    tokPerSec: r.tokensPerSec, wall: (r.wallMs/1000).toFixed(1)+'s',
    cost: '$' + r.costUsd.toFixed(6), costPer1k: '$' + (r.costUsd*1000).toFixed(2),
    reasoningChars: (reasoning[r.slot] || '').length,
  });
  console.log('\n===== REAL 3-WAY RESULT (Minimum Meeting Rooms) =====');
  console.table(rows);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
