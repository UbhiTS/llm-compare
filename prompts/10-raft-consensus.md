---
id: raft-consensus
title: Distributed Consensus: Raft Node State Machine & Log Replication Engine
category: coding
language: javascript
functionName: stepRaftNode
executable: true
testCases: [{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":1,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0,"votesReceived":[]},{"type":"ELECTION_TIMEOUT","peers":["n2","n3"]}],"expected":{"nextState":{"nodeId":"n1","role":"CANDIDATE","currentTerm":2,"votedFor":"n1","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":["n1"]},"outboundMessages":[{"to":"n2","type":"REQUEST_VOTE","term":2,"candidateId":"n1","lastLogIndex":0,"lastLogTerm":0},{"to":"n3","type":"REQUEST_VOTE","term":2,"candidateId":"n1","lastLogIndex":0,"lastLogTerm":0}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"CANDIDATE","currentTerm":1,"votedFor":"n1","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":["n1"]},{"type":"REQUEST_VOTE_REQ","from":"n2","term":2,"candidateId":"n2","lastLogIndex":0,"lastLogTerm":0}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":"n2","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":[]},"outboundMessages":[{"to":"n2","type":"REQUEST_VOTE_RESP","term":2,"voteGranted":true}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":"n3","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":[]},{"type":"REQUEST_VOTE_REQ","from":"n2","term":2,"candidateId":"n2","lastLogIndex":0,"lastLogTerm":0}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":"n3","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":[]},"outboundMessages":[{"to":"n2","type":"REQUEST_VOTE_RESP","term":2,"voteGranted":false}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":2,"index":1,"command":"a"}],"commitIndex":1,"lastApplied":1,"votesReceived":[]},{"type":"REQUEST_VOTE_REQ","from":"n2","term":2,"candidateId":"n2","lastLogIndex":0,"lastLogTerm":0}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":2,"index":1,"command":"a"}],"commitIndex":1,"lastApplied":1,"votesReceived":[]},"outboundMessages":[{"to":"n2","type":"REQUEST_VOTE_RESP","term":2,"voteGranted":false}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"CANDIDATE","currentTerm":2,"votedFor":"n1","log":[{"term":1,"index":1,"command":"init"}],"commitIndex":1,"lastApplied":1,"votesReceived":["n1"]},{"type":"REQUEST_VOTE_RESP","from":"n2","term":2,"voteGranted":true,"clusterSize":3,"peers":["n2","n3"]}],"expected":{"nextState":{"nodeId":"n1","role":"LEADER","currentTerm":2,"votedFor":"n1","log":[{"term":1,"index":1,"command":"init"}],"commitIndex":1,"lastApplied":1,"votesReceived":["n1","n2"],"nextIndex":{"n2":2,"n3":2},"matchIndex":{"n2":0,"n3":0}},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES","term":2,"leaderId":"n1","prevLogIndex":1,"prevLogTerm":1,"entries":[],"leaderCommit":1},{"to":"n3","type":"APPEND_ENTRIES","term":2,"leaderId":"n1","prevLogIndex":1,"prevLogTerm":1,"entries":[],"leaderCommit":1}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"CANDIDATE","currentTerm":2,"votedFor":"n1","log":[],"commitIndex":0,"lastApplied":0,"votesReceived":["n1"]},{"type":"REQUEST_VOTE_RESP","from":"n2","term":3,"voteGranted":false,"clusterSize":3,"peers":["n2","n3"]}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":3,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0,"votesReceived":[]},"outboundMessages":[],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"LEADER","currentTerm":2,"votedFor":"n1","log":[{"term":2,"index":1,"command":"x=1"}],"commitIndex":1,"lastApplied":1,"nextIndex":{"n2":2,"n3":2},"matchIndex":{"n2":1,"n3":1}},{"type":"CLIENT_COMMAND","command":"y=2","peers":["n2","n3"]}],"expected":{"nextState":{"nodeId":"n1","role":"LEADER","currentTerm":2,"votedFor":"n1","log":[{"term":2,"index":1,"command":"x=1"},{"term":2,"index":2,"command":"y=2"}],"commitIndex":1,"lastApplied":1,"nextIndex":{"n2":2,"n3":2},"matchIndex":{"n2":1,"n3":1}},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES","term":2,"leaderId":"n1","prevLogIndex":1,"prevLogTerm":2,"entries":[{"term":2,"index":2,"command":"y=2"}],"leaderCommit":1},{"to":"n3","type":"APPEND_ENTRIES","term":2,"leaderId":"n1","prevLogIndex":1,"prevLogTerm":2,"entries":[{"term":2,"index":2,"command":"y=2"}],"leaderCommit":1}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":3,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0},{"type":"APPEND_ENTRIES_REQ","from":"n2","term":2,"leaderId":"n2","prevLogIndex":0,"prevLogTerm":0,"entries":[{"term":2,"index":1,"command":"a"}],"leaderCommit":0}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":3,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES_RESP","term":3,"success":false,"matchIndex":0}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0},{"type":"APPEND_ENTRIES_REQ","from":"n2","term":2,"leaderId":"n2","prevLogIndex":2,"prevLogTerm":1,"entries":[{"term":2,"index":3,"command":"c"}],"leaderCommit":0}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[],"commitIndex":0,"lastApplied":0},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES_RESP","term":2,"success":false,"matchIndex":0}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"}],"commitIndex":1,"lastApplied":1},{"type":"APPEND_ENTRIES_REQ","from":"n2","term":2,"leaderId":"n2","prevLogIndex":1,"prevLogTerm":1,"entries":[{"term":2,"index":2,"command":"b"}],"leaderCommit":1}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"},{"term":2,"index":2,"command":"b"}],"commitIndex":1,"lastApplied":1},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES_RESP","term":2,"success":true,"matchIndex":2}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":3,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"},{"term":2,"index":2,"command":"bad"}],"commitIndex":1,"lastApplied":1},{"type":"APPEND_ENTRIES_REQ","from":"n3","term":3,"leaderId":"n3","prevLogIndex":1,"prevLogTerm":1,"entries":[{"term":3,"index":2,"command":"good"}],"leaderCommit":1}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":3,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"},{"term":3,"index":2,"command":"good"}],"commitIndex":1,"lastApplied":1},"outboundMessages":[{"to":"n3","type":"APPEND_ENTRIES_RESP","term":3,"success":true,"matchIndex":2}],"newlyCommitted":[]}},{"input":[{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"},{"term":2,"index":2,"command":"b"}],"commitIndex":0,"lastApplied":0},{"type":"APPEND_ENTRIES_REQ","from":"n2","term":2,"leaderId":"n2","prevLogIndex":2,"prevLogTerm":2,"entries":[],"leaderCommit":2}],"expected":{"nextState":{"nodeId":"n1","role":"FOLLOWER","currentTerm":2,"votedFor":null,"log":[{"term":1,"index":1,"command":"a"},{"term":2,"index":2,"command":"b"}],"commitIndex":2,"lastApplied":0},"outboundMessages":[{"to":"n2","type":"APPEND_ENTRIES_RESP","term":2,"success":true,"matchIndex":2}],"newlyCommitted":[{"term":1,"index":1,"command":"a"},{"term":2,"index":2,"command":"b"}]}}]
---
You are implementing the core state transition function (`stepRaftNode`) of a distributed consensus engine obeying the Raft Consensus Protocol (Ongaro & Ousterhout).

Signature: `stepRaftNode(state, event)`

### 1. State Model (`state` object)
- `nodeId`: string (e.g. `"n1"`)
- `role`: `"FOLLOWER"` | `"CANDIDATE"` | `"LEADER"`
- `currentTerm`: integer (non-negative)
- `votedFor`: string | null (nodeId voted for in `currentTerm`)
- `log`: array of log entries `[{ term: number, index: number, command: any }]` (1-indexed entry positions)
- `commitIndex`: integer (highest log entry index known to be committed, starts at 0)
- `lastApplied`: integer (highest log entry index applied to state machine, starts at 0)
- `votesReceived`: array of string nodeIds that granted votes in the current election
- `nextIndex`: (leaders only) map of `{ [peerId]: number }` (index of next log entry to send)
- `matchIndex`: (leaders only) map of `{ [peerId]: number }` (highest index known replicated)

### 2. Events & Invariants (`event` object)

#### General Term Invariant (All Roles)
If an incoming event or RPC has a `term` strictly greater than `state.currentTerm`:
- Update `state.currentTerm = event.term`.
- Immediately convert to role `"FOLLOWER"`.
- Reset `votedFor = null` and `votesReceived = []`.

#### Event Types:

1. **`ELECTION_TIMEOUT`**: `{ type: "ELECTION_TIMEOUT", peers: string[] }`
   - Node converts to `"CANDIDATE"`.
   - Increments `currentTerm` by 1.
   - Votes for itself: `votedFor = nodeId`, and sets `votesReceived = [nodeId]`.
   - Sends `REQUEST_VOTE` messages to all listed `peers`:
     `{ to: peer, type: "REQUEST_VOTE", term: currentTerm, candidateId: nodeId, lastLogIndex: last.index, lastLogTerm: last.term }`
     (where `last` is the last entry in local log, or `{ term: 0, index: 0 }` if log is empty).

2. **`REQUEST_VOTE_REQ`**: `{ type: "REQUEST_VOTE_REQ", from: string, term: number, candidateId: string, lastLogIndex: number, lastLogTerm: number }`
   - If `term === currentTerm` and (`votedFor === null` or `votedFor === candidateId`):
     - Check if candidate log is at least as up-to-date as receiver log:
       - `candidate.lastLogTerm > myLastLogTerm`, OR
       - (`candidate.lastLogTerm === myLastLogTerm` AND `candidate.lastLogIndex >= myLastLogIndex`).
     - If up-to-date: `voteGranted = true`, and set `state.votedFor = candidateId`.
     - Otherwise: `voteGranted = false`.
   - Otherwise `voteGranted = false`.
   - Reply to `event.from` with `{ to: event.from, type: "REQUEST_VOTE_RESP", term: currentTerm, voteGranted }`.

3. **`REQUEST_VOTE_RESP`**: `{ type: "REQUEST_VOTE_RESP", from: string, term: number, voteGranted: boolean, clusterSize?: number, peers?: string[] }`
   - If role is `"CANDIDATE"`, `term === currentTerm`, and `voteGranted === true`:
     - Add `from` to `state.votesReceived` if not already included.
     - Let `N = clusterSize || (peers ? peers.length + 1 : 3)`.
     - If `votesReceived.length > Math.floor(N / 2)` (strict majority):
       - Convert role to `"LEADER"`.
       - Initialize `nextIndex` for all peers to `lastLogIndex + 1`.
       - Initialize `matchIndex` for all peers to `0`.
       - Immediately broadcast empty heartbeat `APPEND_ENTRIES` to all peers:
         `{ to: peer, type: "APPEND_ENTRIES", term: currentTerm, leaderId: nodeId, prevLogIndex: last.index, prevLogTerm: last.term, entries: [], leaderCommit: commitIndex }`.

4. **`APPEND_ENTRIES_REQ`**: `{ type: "APPEND_ENTRIES_REQ", from: string, term: number, leaderId: string, prevLogIndex: number, prevLogTerm: number, entries: Array<{ term: number, index: number, command: any }>, leaderCommit: number }`
   - If `term >= currentTerm` and role is `"CANDIDATE"`, convert to `"FOLLOWER"`.
   - If `term < currentTerm`: reply with `{ to: from, type: "APPEND_ENTRIES_RESP", term: currentTerm, success: false, matchIndex: 0 }`.
   - Log Matching Consistency:
     - If `prevLogIndex > 0`, verify that local log contains an entry at `prevLogIndex` with `term === prevLogTerm`.
     - If not matching: reply with `{ to: from, type: "APPEND_ENTRIES_RESP", term: currentTerm, success: false, matchIndex: 0 }`.
   - If matching:
     - For each entry in `event.entries`:
       - If an existing entry conflicts with a new entry (same index but different terms), truncate the log from that index onward.
       - If entry is not yet in log, append it.
     - If `leaderCommit > commitIndex`:
       - Set `commitIndex = Math.min(leaderCommit, lastEntryIndex)`.
       - Collect any newly committed entries into `newlyCommitted` (entries from previous commitIndex + 1 up to new commitIndex).
     - Reply with `{ to: from, type: "APPEND_ENTRIES_RESP", term: currentTerm, success: true, matchIndex: lastEntryIndex }`.

5. **`CLIENT_COMMAND`**: `{ type: "CLIENT_COMMAND", command: any, peers: string[] }`
   - If role is not `"LEADER"`: return `{ error: "NOT_LEADER", nextState: state, outboundMessages: [], newlyCommitted: [] }`.
   - If `"LEADER"`:
     - Append entry `{ term: currentTerm, index: lastLogIndex + 1, command }` to local log.
     - Broadcast `APPEND_ENTRIES` with `entries: [newEntry]` to all peers.

### Output Shape:
Return an object:
`{ nextState: object, outboundMessages: Array<object>, newlyCommitted: Array<object> }`

The solution MUST be a single, self-contained complete JavaScript function named exactly `stepRaftNode`.

Output ONLY the solution as a single fenced ```javascript code block. No preamble, prose, explanation, or external libraries.
