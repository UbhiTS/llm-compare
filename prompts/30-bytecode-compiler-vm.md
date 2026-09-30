---
id: compiler-vm
title: Compilers: Bytecode Optimizer & Stack Virtual Machine Runtime
category: coding
language: javascript
functionName: compileAndExecuteVM
executable: true
testCases: [{"input":[{"type":"Program","body":[{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"+","left":{"type":"Literal","value":10},"right":{"type":"Literal","value":20}}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":30,"stdout":[],"stats":{"gasUsed":4,"constantsFolded":0,"bytecodeLength":5}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"a","init":{"type":"Literal","value":5}},{"type":"VarDecl","name":"b","init":{"type":"Literal","value":7}},{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"*","left":{"type":"VarExpr","name":"a"},"right":{"type":"VarExpr","name":"b"}}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":35,"stdout":[],"stats":{"gasUsed":8,"constantsFolded":0,"bytecodeLength":9}}},{"input":[{"type":"Program","body":[{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"+","left":{"type":"BinaryExpr","op":"*","left":{"type":"Literal","value":3},"right":{"type":"Literal","value":4}},"right":{"type":"BinaryExpr","op":"-","left":{"type":"Literal","value":20},"right":{"type":"Literal","value":5}}}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":27,"stdout":[],"stats":{"gasUsed":8,"constantsFolded":0,"bytecodeLength":9}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"res","init":{"type":"Literal","value":0}},{"type":"IfStmt","condition":{"type":"Literal","value":true},"thenBranch":{"type":"AssignStmt","name":"res","value":{"type":"Literal","value":100}},"elseBranch":{"type":"AssignStmt","name":"res","value":{"type":"Literal","value":200}}},{"type":"ReturnStmt","value":{"type":"VarExpr","name":"res"}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":100,"stdout":[],"stats":{"gasUsed":9,"constantsFolded":0,"bytecodeLength":12}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"res","init":{"type":"Literal","value":0}},{"type":"IfStmt","condition":{"type":"Literal","value":false},"thenBranch":{"type":"AssignStmt","name":"res","value":{"type":"Literal","value":100}},"elseBranch":{"type":"AssignStmt","name":"res","value":{"type":"Literal","value":200}}},{"type":"ReturnStmt","value":{"type":"VarExpr","name":"res"}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":200,"stdout":[],"stats":{"gasUsed":8,"constantsFolded":0,"bytecodeLength":12}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"i","init":{"type":"Literal","value":1}},{"type":"VarDecl","name":"sum","init":{"type":"Literal","value":0}},{"type":"WhileStmt","condition":{"type":"BinaryExpr","op":"<=","left":{"type":"VarExpr","name":"i"},"right":{"type":"Literal","value":5}},"body":{"type":"BlockStmt","statements":[{"type":"AssignStmt","name":"sum","value":{"type":"BinaryExpr","op":"+","left":{"type":"VarExpr","name":"sum"},"right":{"type":"VarExpr","name":"i"}}},{"type":"AssignStmt","name":"i","value":{"type":"BinaryExpr","op":"+","left":{"type":"VarExpr","name":"i"},"right":{"type":"Literal","value":1}}}]}},{"type":"ReturnStmt","value":{"type":"VarExpr","name":"sum"}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":15,"stdout":[],"stats":{"gasUsed":75,"constantsFolded":0,"bytecodeLength":20}}},{"input":[{"type":"Program","body":[{"type":"PrintStmt","expr":{"type":"Literal","value":"hello"}},{"type":"PrintStmt","expr":{"type":"Literal","value":"world"}},{"type":"ReturnStmt","value":{"type":"Literal","value":42}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":42,"stdout":["hello","world"],"stats":{"gasUsed":6,"constantsFolded":0,"bytecodeLength":7}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"x","init":{"type":"Literal","value":1}},{"type":"WhileStmt","condition":{"type":"BinaryExpr","op":">","left":{"type":"VarExpr","name":"x"},"right":{"type":"Literal","value":0}},"body":{"type":"AssignStmt","name":"x","value":{"type":"BinaryExpr","op":"+","left":{"type":"VarExpr","name":"x"},"right":{"type":"Literal","value":1}}}}]},{"maxGas":50,"optimize":false}],"expected":{"status":"OUT_OF_GAS","result":null,"stdout":[],"stats":{"gasUsed":50,"constantsFolded":0,"bytecodeLength":12}}},{"input":[{"type":"Program","body":[{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"==","left":{"type":"BinaryExpr","op":"<","left":{"type":"Literal","value":5},"right":{"type":"Literal","value":10}},"right":{"type":"Literal","value":true}}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":true,"stdout":[],"stats":{"gasUsed":6,"constantsFolded":0,"bytecodeLength":7}}},{"input":[{"type":"Program","body":[{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"%","left":{"type":"BinaryExpr","op":"/","left":{"type":"Literal","value":100},"right":{"type":"Literal","value":3}},"right":{"type":"Literal","value":5}}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":3,"stdout":[],"stats":{"gasUsed":6,"constantsFolded":0,"bytecodeLength":7}}},{"input":[{"type":"Program","body":[{"type":"VarDecl","name":"n","init":{"type":"Literal","value":5}},{"type":"VarDecl","name":"fact","init":{"type":"Literal","value":1}},{"type":"WhileStmt","condition":{"type":"BinaryExpr","op":">","left":{"type":"VarExpr","name":"n"},"right":{"type":"Literal","value":1}},"body":{"type":"BlockStmt","statements":[{"type":"AssignStmt","name":"fact","value":{"type":"BinaryExpr","op":"*","left":{"type":"VarExpr","name":"fact"},"right":{"type":"VarExpr","name":"n"}}},{"type":"AssignStmt","name":"n","value":{"type":"BinaryExpr","op":"-","left":{"type":"VarExpr","name":"n"},"right":{"type":"Literal","value":1}}}]}},{"type":"ReturnStmt","value":{"type":"VarExpr","name":"fact"}}]},{"optimize":true}],"expected":{"status":"SUCCESS","result":120,"stdout":[],"stats":{"gasUsed":62,"constantsFolded":0,"bytecodeLength":20}}},{"input":[{"type":"Program","body":[{"type":"ReturnStmt","value":{"type":"BinaryExpr","op":"+","left":{"type":"Literal","value":2},"right":{"type":"Literal","value":3}}}]},{"optimize":false}],"expected":{"status":"SUCCESS","result":5,"stdout":[],"stats":{"gasUsed":4,"constantsFolded":0,"bytecodeLength":5}}}]
---
You are implementing an optimizing compiler and stack-based virtual machine execution pipeline (`compileAndExecuteVM`).

Signature: `compileAndExecuteVM(ast, options)`

### 1. Abstract Syntax Tree (AST) Specification
The input `ast` is a procedural program representation:
- `Program`: `{ type: "Program", body: Statement[] }`
- `VarDecl`: `{ type: "VarDecl", name: string, init: Expression }`
- `AssignStmt`: `{ type: "AssignStmt", name: string, value: Expression }`
- `PrintStmt`: `{ type: "PrintStmt", expr: Expression }`
- `ReturnStmt`: `{ type: "ReturnStmt", value: Expression }`
- `BlockStmt`: `{ type: "BlockStmt", statements: Statement[] }`
- `IfStmt`: `{ type: "IfStmt", condition: Expression, thenBranch: Statement, elseBranch?: Statement }`
- `WhileStmt`: `{ type: "WhileStmt", condition: Expression, body: Statement }`
- `Literal`: `{ type: "Literal", value: number | boolean | string }`
- `VarExpr`: `{ type: "VarExpr", name: string }`
- `BinaryExpr`: `{ type: "BinaryExpr", op: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=", left: Expression, right: Expression }`

### 2. Compilation & Optimization Passes (`options.optimize !== false`)
1. **Constant Folding**:
   - Recursively evaluate binary expressions with literal numeric operands at compile-time:
     e.g., `3 * 4 + (20 - 5)` folds to `27`.
   - Division by zero returns `null` (not folded). Integer division truncates towards zero (`Math.floor`).
2. **Dead Branch Elimination**:
   - If an `IfStmt` condition folds to a boolean literal:
     - If `true`: replace the `IfStmt` with the `thenBranch`.
     - If `false`: replace with `elseBranch` (or empty statement if no else branch).
   - Track total count of folded operations in `stats.constantsFolded`.

### 3. Bytecode Emission & Stack Virtual Machine Execution
Generate linear instructions:
- `PUSH <val>`: pushes constant literal to operand stack.
- `LOAD <var>`: reads variable from memory table and pushes to stack.
- `STORE <var>`: pops top of stack and stores in memory table.
- Arithmetic: `ADD`, `SUB`, `MUL`, `DIV`, `MOD` (pops `b`, then `a`, pushes `a op b`).
- Comparisons: `EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE` (pushes boolean).
- Control Flow:
  - `JUMP <addr>`: sets instruction pointer to `addr`.
  - `JUMP_IF_FALSE <addr>`: pops condition; if falsey, sets instruction pointer to `addr`.
- `PRINT`: pops value and appends string representation to `stdout` array.
- `RET`: pops return value, halts execution, sets result.
- `HALT`: terminates program.

### 4. Safety & Resource Limits (`options.maxGas || 10000`)
- Track instructions executed in `stats.gasUsed`.
- If `gasUsed >= maxGas` before halting:
  - Immediately return `{ status: "OUT_OF_GAS", result: null, stdout, stats }`.

### 5. Output Format
Return an object:
`{ status: "SUCCESS" | "OUT_OF_GAS", result: any, stdout: string[], stats: { gasUsed: number, constantsFolded: number, bytecodeLength: number } }`

The solution MUST be a single, complete JavaScript function named exactly `compileAndExecuteVM`.

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, or external dependencies.
