require('dotenv').config();
const { runAgent } = require('../src/agent');
const { TASKS } = require('../src/tasks');
const task = TASKS.find(t => t.id === 'meeting-rooms');
const modelConfig = { slot: 'A', label: 'Gemini 3.5 Flash', provider: 'agentplatform', publisher: 'google', model: 'gemini-3.5-flash', price: { input: 0.10, output: 0.40 } };
(async () => {
  console.log('LIVE call -> Agent Platform / gemini-3.5-flash, task:', task.title);
  const r = await runAgent({
    modelConfig, task, maxIterations: 3,
    emit: (e) => {
      if (e.type === 'iteration') console.log(`  round ${e.iteration}: ${e.passed}/${e.total} tests pass`);
      if (e.type === 'metrics') console.log(`     -> tokens out ${e.completionTokens}, ${e.tokensPerSec} tok/s, $${e.costUsd.toFixed(6)} so far`);
    },
  });
  console.log('\nFINAL:', JSON.stringify({
    solved: r.solved, correctness: r.correctness + '%', rounds: r.iterations,
    promptTokens: r.promptTokens, completionTokens: r.completionTokens,
    tokensPerSec: r.tokensPerSec, wall: (r.wallMs/1000).toFixed(1)+'s', cost: '$'+r.costUsd.toFixed(6),
  }, null, 2));
})().catch(e => { console.error('LIVE TEST ERROR:', e.message); process.exit(1); });
