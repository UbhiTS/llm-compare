---
id: crdt-sync
title: Distributed Systems: Conflict-Free Replicated Data Type (CRDT) Document Sync Engine
category: coding
language: javascript
functionName: syncCrdtDocument
executable: true
testCases: [{"input":[{"replicaId":"A","clock":{},"characters":[],"attributes":{}},[{"type":"INSERT","origin":"A","seq":1,"charId":{"replica":"A","seq":1},"char":"H","afterId":null},{"type":"INSERT","origin":"A","seq":2,"charId":{"replica":"A","seq":2},"char":"i","afterId":{"replica":"A","seq":1}}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":2},"characters":[{"id":{"replica":"A","seq":1},"char":"H","afterId":null,"beforeId":null,"deleted":false},{"id":{"replica":"A","seq":2},"char":"i","afterId":{"replica":"A","seq":1},"beforeId":null,"deleted":false}],"attributes":{}},"text":"Hi","attributes":{},"stats":{"operationsApplied":2,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{"A":1},"characters":[{"id":{"replica":"A","seq":1},"char":"A","afterId":null,"deleted":false}],"attributes":{}},[{"type":"INSERT","origin":"B","seq":1,"charId":{"replica":"B","seq":1},"char":"X","afterId":{"replica":"A","seq":1}},{"type":"INSERT","origin":"C","seq":1,"charId":{"replica":"C","seq":1},"char":"Y","afterId":{"replica":"A","seq":1}}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":1,"B":1,"C":1},"characters":[{"id":{"replica":"A","seq":1},"char":"A","afterId":null,"deleted":false},{"id":{"replica":"C","seq":1},"char":"Y","afterId":{"replica":"A","seq":1},"beforeId":null,"deleted":false},{"id":{"replica":"B","seq":1},"char":"X","afterId":{"replica":"A","seq":1},"beforeId":null,"deleted":false}],"attributes":{}},"text":"AYX","attributes":{},"stats":{"operationsApplied":2,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{"A":2},"characters":[{"id":{"replica":"A","seq":1},"char":"a","afterId":null,"deleted":false},{"id":{"replica":"A","seq":2},"char":"b","afterId":{"replica":"A","seq":1},"deleted":false}],"attributes":{}},[{"type":"DELETE","origin":"A","seq":3,"charId":{"replica":"A","seq":2}}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":3},"characters":[{"id":{"replica":"A","seq":1},"char":"a","afterId":null,"deleted":false},{"id":{"replica":"A","seq":2},"char":"b","afterId":{"replica":"A","seq":1},"deleted":true}],"attributes":{}},"text":"a","attributes":{},"stats":{"operationsApplied":1,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{"A":1},"characters":[{"id":{"replica":"A","seq":1},"char":"Z","afterId":null,"deleted":false}],"attributes":{}},[{"type":"INSERT","origin":"A","seq":1,"charId":{"replica":"A","seq":1},"char":"Z","afterId":null}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":1},"characters":[{"id":{"replica":"A","seq":1},"char":"Z","afterId":null,"deleted":false}],"attributes":{}},"text":"Z","attributes":{},"stats":{"operationsApplied":0,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{},"characters":[],"attributes":{"title":{"value":"Draft 1","timestamp":100,"replica":"A"}}},[{"type":"SET_ATTR","origin":"B","seq":1,"attrKey":"title","attrVal":"Draft 2","timestamp":200}]],"expected":{"nextState":{"replicaId":"A","clock":{"B":1},"characters":[],"attributes":{"title":{"value":"Draft 2","timestamp":200,"replica":"B"}}},"text":"","attributes":{"title":"Draft 2"},"stats":{"operationsApplied":1,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{},"characters":[],"attributes":{"status":{"value":"review","timestamp":100,"replica":"A"}}},[{"type":"SET_ATTR","origin":"B","seq":1,"attrKey":"status","attrVal":"published","timestamp":100}]],"expected":{"nextState":{"replicaId":"A","clock":{"B":1},"characters":[],"attributes":{"status":{"value":"published","timestamp":100,"replica":"B"}}},"text":"","attributes":{"status":"published"},"stats":{"operationsApplied":1,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{"A":5,"B":5},"characters":[{"id":{"replica":"A","seq":1},"char":"x","afterId":null,"deleted":true},{"id":{"replica":"A","seq":2},"char":"y","afterId":{"replica":"A","seq":1},"deleted":false}],"attributes":{}},[],{"compact":true,"minObservedClock":{"A":2,"B":2}}],"expected":{"nextState":{"replicaId":"A","clock":{"A":5,"B":5},"characters":[{"id":{"replica":"A","seq":2},"char":"y","afterId":{"replica":"A","seq":1},"deleted":false}],"attributes":{}},"text":"y","attributes":{},"stats":{"operationsApplied":0,"tombstonesPurged":1}}},{"input":[{"replicaId":"A","clock":{"A":5},"characters":[{"id":{"replica":"A","seq":4},"char":"del","afterId":null,"deleted":true}],"attributes":{}},[],{"compact":true,"minObservedClock":{"A":2,"B":1}}],"expected":{"nextState":{"replicaId":"A","clock":{"A":5},"characters":[{"id":{"replica":"A","seq":4},"char":"del","afterId":null,"deleted":true}],"attributes":{}},"text":"","attributes":{},"stats":{"operationsApplied":0,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{"A":1},"characters":[{"id":{"replica":"A","seq":1},"char":"O","afterId":null,"deleted":false}],"attributes":{}},[{"type":"INSERT","origin":"A","seq":2,"charId":{"replica":"A","seq":2},"char":"K","afterId":{"replica":"A","seq":1}},{"type":"INSERT","origin":"B","seq":1,"charId":{"replica":"B","seq":1},"char":"!","afterId":{"replica":"A","seq":2}}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":2,"B":1},"characters":[{"id":{"replica":"A","seq":1},"char":"O","afterId":null,"deleted":false},{"id":{"replica":"A","seq":2},"char":"K","afterId":{"replica":"A","seq":1},"beforeId":null,"deleted":false},{"id":{"replica":"B","seq":1},"char":"!","afterId":{"replica":"A","seq":2},"beforeId":null,"deleted":false}],"attributes":{}},"text":"OK!","attributes":{},"stats":{"operationsApplied":2,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{},"characters":[],"attributes":{}},[]],"expected":{"nextState":{"replicaId":"A","clock":{},"characters":[],"attributes":{}},"text":"","attributes":{},"stats":{"operationsApplied":0,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{},"characters":[{"id":{"replica":"A","seq":1},"char":"A","afterId":null,"deleted":false}],"attributes":{}},[{"type":"DELETE","origin":"B","seq":1,"charId":{"replica":"Z","seq":99}}]],"expected":{"nextState":{"replicaId":"A","clock":{"B":1},"characters":[{"id":{"replica":"A","seq":1},"char":"A","afterId":null,"deleted":false}],"attributes":{}},"text":"A","attributes":{},"stats":{"operationsApplied":0,"tombstonesPurged":0}}},{"input":[{"replicaId":"A","clock":{},"characters":[],"attributes":{}},[{"type":"SET_ATTR","origin":"A","seq":1,"attrKey":"font","attrVal":"Arial","timestamp":10},{"type":"SET_ATTR","origin":"B","seq":1,"attrKey":"size","attrVal":14,"timestamp":20},{"type":"SET_ATTR","origin":"C","seq":1,"attrKey":"font","attrVal":"Monospace","timestamp":30}]],"expected":{"nextState":{"replicaId":"A","clock":{"A":1,"B":1,"C":1},"characters":[],"attributes":{"font":{"value":"Monospace","timestamp":30,"replica":"C"},"size":{"value":14,"timestamp":20,"replica":"B"}}},"text":"","attributes":{"font":"Monospace","size":14},"stats":{"operationsApplied":3,"tombstonesPurged":0}}}]
---
You are implementing a state-based and operation-based Conflict-Free Replicated Data Type (CRDT) document synchronization and causal consistency engine (`syncCrdtDocument`).

Signature: `syncCrdtDocument(localState, operations, options)`

### 1. Document & Replica State (`localState` object)
- `replicaId`: string identifier of the local node (e.g. `"A"`).
- `clock`: vector clock mapping `{ [replicaId]: number }` tracking the maximum sequence observed per peer.
- `characters`: array of character atoms ordered by the Replicated Growable Array (RGA) / fractional sequence:
  `Array<{ id: { replica: string, seq: number }, char: string, afterId: { replica: string, seq: number } | null, beforeId: { replica: string, seq: number } | null, deleted: boolean }>`
- `attributes`: map of document-level metadata fields:
  `{ [attrKey]: { value: any, timestamp: number, replica: string } }`

### 2. Operations (`operations` array)
An array of remote or local mutation operations to apply sequentially:
1. **`INSERT`**: `{ type: "INSERT", origin: string, seq: number, charId: { replica: string, seq: number }, char: string, afterId?: { replica: string, seq: number } | null, beforeId?: { replica: string, seq: number } | null }`
   - If `charId` is already present in `state.characters`, this is an idempotent duplicate; skip insertion.
   - Insert character into `state.characters` immediately after the atom identified by `afterId` (or at position 0 if `afterId === null`).
   - Deterministic Conflict Resolution: If concurrent characters have the same predecessor (`afterId`), order characters by `charId.replica` descending (higher replica ID string appears earlier in the document).
2. **`DELETE`**: `{ type: "DELETE", origin: string, seq: number, charId: { replica: string, seq: number } }`
   - Locate the atom matching `charId`. If found and not already deleted, set `deleted = true` (marking a tombstone to maintain spatial causality for subsequent concurrent edits).
3. **`SET_ATTR`**: `{ type: "SET_ATTR", origin: string, seq: number, attrKey: string, attrVal: any, timestamp: number }`
   - Last-Write-Wins (LWW) register update: update the attribute if `timestamp > currentTimestamp`, breaking ties if timestamps match by choosing the higher `origin` replica ID string.

### 3. Vector Clock Causal Tracking
For every operation with an `origin` and `seq`, advance the local vector clock:
`state.clock[op.origin] = Math.max(state.clock[op.origin] || 0, op.seq)`.
Increment `stats.operationsApplied` for each non-duplicate operation applied.

### 4. Garbage Collection / Tombstone Compaction (`options`)
If `options.compact === true` and `options.minObservedClock` is provided:
- An atom marked `deleted = true` can be safely purged if and only if EVERY replica listed in `minObservedClock` has advanced its sequence counter beyond the atom's sequence:
  `Object.keys(minObservedClock).every(r => (minObservedClock[r] || 0) >= atom.id.seq)`.
- Track the count of purged tombstones in `stats.tombstonesPurged`.

### 5. Output Format
Return an object:
`{
  nextState: object,
  text: string,
  attributes: Record<string, any>,
  stats: { operationsApplied: number, tombstonesPurged: number }
}`
where `text` is the concatenation of all non-deleted characters in order, and `attributes` is a key-value map unwrapping the active values.

The solution MUST be a single complete JavaScript function named exactly `syncCrdtDocument`.

Output ONLY the solution as a single fenced ```javascript code block. No preamble, prose, or external packages.
