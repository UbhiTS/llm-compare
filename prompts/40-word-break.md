---
id: word-break
title: Word Break
category: coding
language: javascript
functionName: wordBreak
executable: true
testCases: [{"input":["leetcode",["leet","code"]],"expected":true},{"input":["applepenapple",["apple","pen"]],"expected":true},{"input":["catsandog",["cats","dog","sand","and","cat"]],"expected":false},{"input":["",["a"]],"expected":true},{"input":["a",["a"]],"expected":true},{"input":["a",["b"]],"expected":false},{"input":["aaaaaaa",["aaaa","aaa"]],"expected":true},{"input":["aaaaaaa",["aaaa","aa"]],"expected":false},{"input":["cars",["car","ca","rs"]],"expected":true},{"input":["abcd",["a","abc","b","cd"]],"expected":true}]
---
Given a string `s` and an array of strings `wordDict`, return `true` if `s` can be segmented into a sequence of one or more dictionary words joined end to end with no gaps or overlaps; otherwise return `false`.

Signature: `wordBreak(s, wordDict)`

Rules:
- Dictionary words may be reused any number of times.
- Every character of `s` must be covered exactly once, scanning left to right.
- The empty string is segmentable, so `wordBreak("", wordDict)` returns `true`.

Return a boolean.

Examples:
- `wordBreak("applepenapple", ["apple","pen"])` -> true (apple + pen + apple)
- `wordBreak("catsandog", ["cats","dog","sand","and","cat"])` -> false

Write the answer as a single complete JavaScript function named exactly `wordBreak` and nothing else.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment inside the block.
