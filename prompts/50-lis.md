---
id: lis
title: Longest Increasing Subsequence
category: coding
language: javascript
functionName: lengthOfLIS
executable: true
testCases: [{"input":[[10,9,2,5,3,7,101,18]],"expected":4},{"input":[[0,1,0,3,2,3]],"expected":4},{"input":[[7,7,7,7,7]],"expected":1},{"input":[[]],"expected":0},{"input":[[1]],"expected":1},{"input":[[4,10,4,3,8,9]],"expected":3},{"input":[[1,3,6,7,9,4,10,5,6]],"expected":6},{"input":[[3,2]],"expected":1},{"input":[[1,2,3,4,5]],"expected":5},{"input":[[5,4,3,2,1]],"expected":1}]
---
Given an array of integers `nums`, return the length of the longest STRICTLY increasing subsequence.

Signature: `lengthOfLIS(nums)`

A subsequence keeps the original order of elements but need not be contiguous. "Strictly increasing" means each chosen element is greater than the previous one — equal values do not count. An empty array returns 0.

Return an integer (the length of the longest strictly increasing subsequence).

Worked examples:
- `lengthOfLIS([10,9,2,5,3,7,101,18])` → 4 (e.g. the subsequence 2,3,7,18 or 2,3,7,101)
- `lengthOfLIS([7,7,7,7,7])` → 1 (all equal, so strictly increasing length is 1)
- `lengthOfLIS([])` → 0

Your answer MUST be a single, complete JavaScript function named exactly `lengthOfLIS` and nothing else — no helper code outside it unless defined inside the same function, no test/driver code, no exports.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment inside the block.
