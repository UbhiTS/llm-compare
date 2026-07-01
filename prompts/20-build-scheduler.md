---
id: build-scheduler
title: CI Build Scheduler (critical path + cycle detection)
category: coding
language: javascript
functionName: minBuildTime
executable: true
testCases: [{"input":[[{"id":"a","time":2,"deps":[]},{"id":"b","time":3,"deps":["a"]},{"id":"c","time":1,"deps":["b"]}]],"expected":6},{"input":[[{"id":"a","time":5,"deps":[]},{"id":"b","time":3,"deps":[]}]],"expected":5},{"input":[[{"id":"a","time":2,"deps":[]},{"id":"b","time":3,"deps":["a"]},{"id":"c","time":4,"deps":["a"]},{"id":"d","time":1,"deps":["b","c"]}]],"expected":7},{"input":[[{"id":"a","time":1,"deps":["b"]},{"id":"b","time":1,"deps":["a"]}]],"expected":-1},{"input":[[]],"expected":0},{"input":[[{"id":"a","time":7,"deps":[]}]],"expected":7},{"input":[[{"id":"a","time":3,"deps":["a"]}]],"expected":-1},{"input":[[{"id":"a","time":1,"deps":[]},{"id":"b","time":2,"deps":[]},{"id":"c","time":3,"deps":["a","b"]},{"id":"d","time":2,"deps":["c"]},{"id":"e","time":5,"deps":[]}]],"expected":7},{"input":[[{"id":"a","time":0,"deps":[]},{"id":"b","time":0,"deps":["a"]},{"id":"c","time":4,"deps":["b"]}]],"expected":4},{"input":[[{"id":"a","time":1,"deps":["c"]},{"id":"b","time":1,"deps":["a"]},{"id":"c","time":1,"deps":["b"]}]],"expected":-1},{"input":[[{"id":"a","time":3,"deps":[]},{"id":"b","time":2,"deps":["a"]},{"id":"c","time":10,"deps":["a"]},{"id":"d","time":1,"deps":["b","c"]}]],"expected":14},{"input":[[{"id":"c","time":1,"deps":["a"]},{"id":"a","time":4,"deps":[]}]],"expected":5}]
---
You are computing the makespan (total wall-clock time) of a CI build dependency graph.

Signature: `minBuildTime(targets)`
- `targets`: an array of objects `{ id, time, deps }` where:
  - `id` is the unique identifier of the target.
  - `time` is the build duration, a number ≥ 0.
  - `deps` is the array of target ids that must FINISH before this target may start.

Model:
- There are UNLIMITED parallel workers, so every target starts the instant all of its dependencies have finished.
- A target with no deps starts at time 0.
- A target's finish time = its start time + its `time`.

Return the minimum total wall-clock time to build everything — the latest finish time across all targets — subject to these rules:
- If the dependency graph contains a cycle (so the build can never complete), return -1.
- If `targets` is empty, return 0.
- Every id referenced in any `deps` is guaranteed to exist in `targets`. Input order is arbitrary — a target may appear before the targets it depends on.

Worked example:
`minBuildTime([{id:"a",time:2,deps:[]},{id:"b",time:3,deps:["a"]},{id:"c",time:1,deps:["b"]}])` → 6 (a: 0→2, b: 2→5, c: 5→6).

Your answer must be a single, complete JavaScript function named exactly `minBuildTime` and nothing else (no test/driver code, no exports, no usage examples).

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment inside the function.
