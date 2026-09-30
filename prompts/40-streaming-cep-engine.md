---
id: streaming-cep-engine
title: Stream Processing: Complex Event Processing (CEP) & Windowing Engine
category: coding
language: javascript
functionName: processEventStream
executable: true
testCases: [{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"windows":[{"id":"w_tumble","type":"TUMBLING","sizeMs":2000,"aggs":["count","sum"]}]}],"expected":{"windows":[{"windowId":"w_tumble","key":"user1","start":0,"end":2000,"results":{"count":2,"sum":2}},{"windowId":"w_tumble","key":"user1","start":2000,"end":4000,"results":{"count":1,"sum":5000}},{"windowId":"w_tumble","key":"user2","start":2000,"end":4000,"results":{"count":1,"sum":100}},{"windowId":"w_tumble","key":"user2","start":4000,"end":6000,"results":{"count":1,"sum":200}},{"windowId":"w_tumble","key":"user2","start":8000,"end":10000,"results":{"count":1,"sum":300}}],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"windows":[{"id":"w_slide","type":"SLIDING","sizeMs":2000,"slideMs":1000,"aggs":["min","max"]}]}],"expected":{"windows":[{"windowId":"w_slide","key":"user1","start":1000,"end":3000,"results":{"min":1,"max":5000}},{"windowId":"w_slide","key":"user1","start":2000,"end":4000,"results":{"min":5000,"max":5000}},{"windowId":"w_slide","key":"user2","start":3000,"end":5000,"results":{"min":100,"max":200}},{"windowId":"w_slide","key":"user2","start":4000,"end":6000,"results":{"min":200,"max":200}},{"windowId":"w_slide","key":"user2","start":7000,"end":9000,"results":{"min":300,"max":300}},{"windowId":"w_slide","key":"user2","start":8000,"end":10000,"results":{"min":300,"max":300}}],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"windows":[{"id":"w_session","type":"SESSION","gapMs":1500,"aggs":["count","sum"]}]}],"expected":{"windows":[{"windowId":"w_session","key":"user1","start":1000,"end":2000,"results":{"count":3,"sum":5002}},{"windowId":"w_session","key":"user2","start":3500,"end":4200,"results":{"count":2,"sum":300}},{"windowId":"w_session","key":"user2","start":8000,"end":8000,"results":{"count":1,"sum":300}}],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"patterns":[{"id":"p_fraud","sequence":["LOGIN_FAIL","LOGIN_FAIL","TRANSFER"],"withinMs":2000}]}],"expected":{"windows":[],"matches":[{"patternId":"p_fraud","key":"user1","eventIds":["e1","e2","e3"],"startTime":1000,"endTime":2000}],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":100,"key":"k1","type":"A","value":1},{"id":"e2","timestamp":200,"key":"k1","type":"CANCEL","value":0},{"id":"e3","timestamp":300,"key":"k1","type":"B","value":2}],{"patterns":[{"id":"p1","sequence":["A","B"],"withinMs":1000,"notFollowedBy":"CANCEL"}]}],"expected":{"windows":[],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":500,"key":"A","type":"T","value":10},{"id":"e2","timestamp":600,"key":"B","type":"T","value":20},{"id":"e3","timestamp":700,"key":"A","type":"T","value":30}],{"windows":[{"id":"w","type":"TUMBLING","sizeMs":1000,"aggs":["sum","avg"]}]}],"expected":{"windows":[{"windowId":"w","key":"A","start":0,"end":1000,"results":{"sum":40,"avg":20}},{"windowId":"w","key":"B","start":0,"end":1000,"results":{"sum":20,"avg":20}}],"matches":[],"lateDroppedCount":0}},{"input":[[],{"windows":[{"id":"w","type":"TUMBLING","sizeMs":1000,"aggs":["count"]}]}],"expected":{"windows":[],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"windows":[{"id":"w_fast","type":"TUMBLING","sizeMs":1000,"aggs":["count"]},{"id":"w_slow","type":"TUMBLING","sizeMs":5000,"aggs":["sum"]}]}],"expected":{"windows":[{"windowId":"w_slow","key":"user1","start":0,"end":5000,"results":{"sum":5002}},{"windowId":"w_slow","key":"user2","start":0,"end":5000,"results":{"sum":300}},{"windowId":"w_fast","key":"user1","start":1000,"end":2000,"results":{"count":2}},{"windowId":"w_fast","key":"user1","start":2000,"end":3000,"results":{"count":1}},{"windowId":"w_fast","key":"user2","start":3000,"end":4000,"results":{"count":1}},{"windowId":"w_fast","key":"user2","start":4000,"end":5000,"results":{"count":1}},{"windowId":"w_slow","key":"user2","start":5000,"end":10000,"results":{"sum":300}},{"windowId":"w_fast","key":"user2","start":8000,"end":9000,"results":{"count":1}}],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"k","type":"START","value":1},{"id":"e2","timestamp":5000,"key":"k","type":"END","value":1}],{"patterns":[{"id":"p","sequence":["START","END"],"withinMs":2000}]}],"expected":{"windows":[],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"1","timestamp":100,"key":"k","type":"X","value":5},{"id":"2","timestamp":300,"key":"k","type":"X","value":15}],{"windows":[{"id":"slide","type":"SLIDING","sizeMs":400,"slideMs":200,"aggs":["count","avg"]}]}],"expected":{"windows":[{"windowId":"slide","key":"k","start":0,"end":400,"results":{"count":2,"avg":10}},{"windowId":"slide","key":"k","start":200,"end":600,"results":{"count":1,"avg":15}}],"matches":[],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":10,"key":"k","type":"A","value":1},{"id":"e2","timestamp":20,"key":"k","type":"B","value":2},{"id":"e3","timestamp":30,"key":"k","type":"C","value":3}],{"patterns":[{"id":"abc","sequence":["A","B","C"],"withinMs":50}]}],"expected":{"windows":[],"matches":[{"patternId":"abc","key":"k","eventIds":["e1","e2","e3"],"startTime":10,"endTime":30}],"lateDroppedCount":0}},{"input":[[{"id":"e1","timestamp":1000,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e2","timestamp":1500,"key":"user1","type":"LOGIN_FAIL","value":1},{"id":"e3","timestamp":2000,"key":"user1","type":"TRANSFER","value":5000},{"id":"e4","timestamp":3500,"key":"user2","type":"PURCHASE","value":100},{"id":"e5","timestamp":4200,"key":"user2","type":"PURCHASE","value":200},{"id":"e6","timestamp":8000,"key":"user2","type":"PURCHASE","value":300}],{"windows":[{"id":"w","type":"TUMBLING","sizeMs":3000,"aggs":["count","sum"]}],"patterns":[{"id":"p","sequence":["LOGIN_FAIL","TRANSFER"],"withinMs":2000}]}],"expected":{"windows":[{"windowId":"w","key":"user1","start":0,"end":3000,"results":{"count":3,"sum":5002}},{"windowId":"w","key":"user2","start":3000,"end":6000,"results":{"count":2,"sum":300}},{"windowId":"w","key":"user2","start":6000,"end":9000,"results":{"count":1,"sum":300}}],"matches":[{"patternId":"p","key":"user1","eventIds":["e1","e3"],"startTime":1000,"endTime":2000},{"patternId":"p","key":"user1","eventIds":["e2","e3"],"startTime":1500,"endTime":2000}],"lateDroppedCount":0}}]
---
You are implementing a real-time event stream processing and Complex Event Processing (CEP) engine (`processEventStream`).

Signature: `processEventStream(events, config)`

### 1. Event Model (`events` array)
Each event in `events` has the structure:
- `id`: string (e.g. `"e1"`)
- `timestamp`: integer (milliseconds epoch)
- `key`: string (entity or partition key, e.g. `"user1"`)
- `type`: string (event type, e.g. `"LOGIN_FAIL"`, `"TRANSFER"`)
- `value`: number (metric payload)

Events should be processed in non-decreasing order of their `timestamp`.

### 2. Configuration Model (`config` object)
- `windows`: array of window configurations:
  - `id`: string (window configuration ID)
  - `type`: `"TUMBLING"` | `"SLIDING"` | `"SESSION"`
  - `sizeMs`: integer (window duration for tumbling and sliding)
  - `slideMs`: integer (slide interval for sliding windows)
  - `gapMs`: integer (inactivity gap threshold for session windows)
  - `aggs`: array of aggregations to compute: `"count"`, `"sum"`, `"avg"`, `"min"`, `"max"`
- `patterns`: array of CEP temporal pattern rules:
  - `id`: string (pattern identifier)
  - `sequence`: array of event `type` strings in chronological order (e.g. `["LOGIN_FAIL", "LOGIN_FAIL", "TRANSFER"]`)
  - `withinMs`: integer (maximum allowable time between the first and last event in the sequence)
  - `notFollowedBy`: optional event type string; if this event type occurs for the same key between the first and last matched events, the pattern match is invalidated.
- `allowedLatenessMs`: integer (optional watermark delay threshold)

### 3. Execution Rules

#### A. Window Processing
Windows partition events per individual `key`:
1. **Tumbling**: Non-overlapping fixed buckets aligned to epoch:
   `start = Math.floor(timestamp / sizeMs) * sizeMs`, `end = start + sizeMs`.
2. **Sliding**: Fixed-duration windows of length `sizeMs` advancing in increments of `slideMs` from `Math.floor(minTimestamp / slideMs) * slideMs` through `maxTimestamp`.
3. **Session**: Dynamic windows that aggregate consecutive events for the same key. A session closes when the time gap between consecutive events exceeds `gapMs`.
4. **Aggregations**: Computed over `event.value`:
   - `count`: total events in the window.
   - `sum`: sum of values in the window.
   - `avg`: mean rounded to 2 decimal places (`Math.round(mean * 100) / 100`).
   - `min` / `max`: minimum and maximum values.
5. Windows are sorted deterministically: ascending by `start`, tie-breaking lexicographically by `windowId`, then `key`.

#### B. CEP Pattern Matching
- Evaluates event sequences per individual `key`.
- Matches must occur strictly in temporal order within `withinMs`.
- If `notFollowedBy` is specified and appears between the first and final event of the sequence, the candidate sequence is aborted.
- Output matches: `{ patternId, key, eventIds: string[], startTime: number, endTime: number }`.
- Matches are sorted ascending by `startTime`, tie-breaking by `patternId`.

### 4. Output Shape
Return an object:
`{
  windows: Array<{ windowId: string, key: string, start: number, end: number, results: Record<string, number> }>,
  matches: Array<{ patternId: string, key: string, eventIds: string[], startTime: number, endTime: number }>,
  lateDroppedCount: number
}`

The solution MUST be a single complete JavaScript function named exactly `processEventStream`.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, or external dependencies.
