---
id: lot-sizing
title: Production Lot-Sizing (Wagner-Whitin)
category: coding
language: javascript
functionName: minProductionCost
executable: true
testCases: [{"input":[[5],10,2],"expected":10},{"input":[[3,2],10,1],"expected":12},{"input":[[1,2,3],5,1],"expected":12},{"input":[[10,10,10],20,1],"expected":50},{"input":[[5,5],0,1],"expected":0},{"input":[[5,5],10,0],"expected":10},{"input":[[],100,100],"expected":0},{"input":[[1,0,1],10,2],"expected":14},{"input":[[3,3,3,3],10,1],"expected":26},{"input":[[2,2,2,2,2,2],15,1],"expected":42},{"input":[[7],99,99],"expected":99},{"input":[[0,0,0,0],50,5],"expected":0}]
---
You are planning production of a single product over T discrete periods.

Write a single JavaScript function with this exact signature:

minProductionCost(demands, setupCost, holdingCost)

Parameters:
- demands: array of T non-negative integers; demands[i] is the units due at the END of period i (0-indexed).
- setupCost: a fixed cost charged ONCE in any period in which you produce a positive quantity.
- holdingCost: the cost to carry ONE unit from one period to the next.

Rules:
- You may produce any non-negative integer quantity each period (no capacity limit).
- Starting inventory and ending inventory are both 0.
- Demand must be met on time — NO backlogging. A unit consumed in period k must be produced in some period j ≤ k, incurring (k − j) × holdingCost of holding cost.

Return the MINIMUM total cost (sum of all setup costs plus all holding costs) as an integer. If demands is empty or every demand is 0, return 0.

Worked example: minProductionCost([3, 2], 10, 1) returns 12 — produce all 5 units in period 0: one setup (10) plus holding 2 units for one period (2).

The answer must be a single complete function named exactly minProductionCost and nothing else: no helper code outside it unless you nest it inside, no top-level statements, no calls, no examples.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment inside the block.
