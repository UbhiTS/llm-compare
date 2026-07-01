---
id: meeting-rooms
title: Minimum Meeting Rooms
category: coding
language: javascript
functionName: minMeetingRooms
executable: true
testCases: [{"input":[[[0,30],[5,10],[15,20]]],"expected":2},{"input":[[[7,10],[2,4]]],"expected":1},{"input":[[]],"expected":0},{"input":[[[1,5],[5,9]]],"expected":1},{"input":[[[1,5],[2,6],[3,7]]],"expected":3},{"input":[[[0,1]]],"expected":1},{"input":[[[1,10],[2,3],[4,5],[6,7]]],"expected":2},{"input":[[[1,5],[8,9],[2,6]]],"expected":2},{"input":[[[13,15],[1,13]]],"expected":1},{"input":[[[2,7],[2,7],[2,7]]],"expected":3}]
---
Given an array of meeting intervals `intervals`, where `intervals[i] = [start, end]` and `start < end`, return the minimum number of conference rooms required so that no two overlapping meetings are ever assigned to the same room.

Signature: `minMeetingRooms(intervals)`

Rules:
- Two meetings overlap only if they share an open time interval. Meetings that merely TOUCH at an endpoint do NOT overlap: if one meeting ends exactly when another starts (e.g. `[1,5]` and `[5,9]`), they can share one room.
- An empty list requires 0 rooms.
- Return an integer (the minimum room count).

Example: `minMeetingRooms([[0,30],[5,10],[15,20]])` returns `2`.

Provide a single complete JavaScript function named exactly `minMeetingRooms` and nothing else.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment inside the block.
