---
id: sec-ssrf-hotpatch
title: Security: Zero-Day SSRF & Path-Traversal Virtual Patch Engine
category: security
language: javascript
functionName: evaluateZeroDayPatch
executable: true
testCases: [{"input":[{"path":"/v1/payments/charge?currency=USD&amount=500","targetUrl":"https://api.stripe.com:443/v1/charges","headers":{"Content-Type":"application/json"}},{"allowedHosts":["api.stripe.com","hooks.partner.io"],"blockedPathPrefixes":["/admin","/internal"],"stripParams":["debug","token"]}],"expected":{"action":"ALLOW","reason":null,"canonicalPath":"/v1/payments/charge?currency=USD&amount=500","targetHost":"api.stripe.com"}},{"input":[{"path":"/v1/catalog//items\\./featured/../list/?debug=1&q=laptop&xss=javascript:alert(1)&sqli=1'%20OR%20'1'='1","targetUrl":null,"headers":{}},{"allowedHosts":["api.stripe.com"],"blockedPathPrefixes":["/admin"],"stripParams":["debug","token"]}],"expected":{"action":"SANITIZE","reason":"NORMALIZED","canonicalPath":"/v1/catalog/items/list?q=laptop","targetHost":null}},{"input":[{"path":"/v1/files/%252e%252e/%252e%252e/%252e%252e/etc/passwd","targetUrl":null,"headers":{}},{"allowedHosts":[],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"PATH_TRAVERSAL","canonicalPath":null,"targetHost":null}},{"input":[{"path":"/v1/%2525252e%2525252e/secret","targetUrl":null,"headers":{}},{"allowedHosts":[],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"ENCODING_ATTACK","canonicalPath":null,"targetHost":null}},{"input":[{"path":"/v1/public/avatar.png%00.php","targetUrl":null,"headers":{}},{"allowedHosts":[],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"ENCODING_ATTACK","canonicalPath":null,"targetHost":null}},{"input":[{"path":"/v1/../%61dmin/keys/rotate","targetUrl":null,"headers":{}},{"allowedHosts":[],"blockedPathPrefixes":["/admin","/internal"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"BLOCKED_PATH","canonicalPath":"/admin/keys/rotate","targetHost":null}},{"input":[{"path":"/v1/orders","targetUrl":null,"headers":{"X_Forwarded_User":"root","Accept":"*/*"}},{"allowedHosts":[],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"HEADER_SMUGGLING","canonicalPath":"/v1/orders","targetHost":null}},{"input":[{"path":"/v1/orders","targetUrl":null,"headers":{"Content-Length":"42","Transfer-Encoding":"chunked"}},{"allowedHosts":[],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"HEADER_SMUGGLING","canonicalPath":"/v1/orders","targetHost":null}},{"input":[{"path":"/v1/webhooks","targetUrl":"https://api.stripe.com@169.254.169.254/latest/meta-data/iam","headers":{}},{"allowedHosts":["api.stripe.com"],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"SSRF_USERINFO","canonicalPath":"/v1/webhooks","targetHost":null}},{"input":[{"path":"/v1/webhooks","targetUrl":"http://0177.0.0.1:8080/internal","headers":{}},{"allowedHosts":["0177.0.0.1","127.0.0.1"],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"SSRF_PRIVATE_IP","canonicalPath":"/v1/webhooks","targetHost":null}},{"input":[{"path":"/v1/webhooks","targetUrl":"http://2852039166/computeMetadata/v1/","headers":{}},{"allowedHosts":["2852039166","169.254.169.254"],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"SSRF_PRIVATE_IP","canonicalPath":"/v1/webhooks","targetHost":null}},{"input":[{"path":"/admin2/webhook","targetUrl":"http://[::ffff:169.254.169.254]/latest/meta-data/","headers":{}},{"allowedHosts":["hooks.partner.io"],"blockedPathPrefixes":["/admin"],"stripParams":[]}],"expected":{"action":"BLOCK","reason":"SSRF_PRIVATE_IP","canonicalPath":"/admin2/webhook","targetHost":null}}]
---
You are implementing an emergency edge virtual-patching function (`evaluateZeroDayPatch`) deployed at an API gateway to neutralize chained multi-encoding path traversal, HTTP header smuggling, and zero-day Server-Side Request Forgery (SSRF) against cloud metadata and RFC1918 networks.

Signature: `evaluateZeroDayPatch(req, policy)`

### Inputs
- `req`: `{ path: string, targetUrl: string | null, headers?: object }`
  - `path`: raw request URI path with optional query string (e.g., `"/v1/items?debug=1&q=shoes"`).
  - `targetUrl`: optional outbound webhook/callback URL string (or `null` / `""` when no outbound fetch occurs).
  - `headers`: optional map of HTTP request headers (keys may have arbitrary casing or underscores).
- `policy`: `{ allowedHosts: string[], blockedPathPrefixes: string[], stripParams: string[] }`

### Output Format
Return an object with the exact shape:
`{ action: "ALLOW" | "SANITIZE" | "BLOCK", reason: string | null, canonicalPath: string | null, targetHost: string | null }`

---

### Evaluation Pipeline (MUST be enforced in exact order 1 → 5)

First, split `req.path` at the first `"?"` into `rawPath` (before `"?"`) and `rawQuery` (after `"?"`, or `""` if no `"?"` is present).

#### 1. Recursive Percent-Decoding & Over-Encoding Detection (`ENCODING_ATTACK`)
- Iteratively apply `decodeURIComponent` to `rawPath` up to **3 passes**, stopping early as soon as a pass produces no change.
- Immediately return `{ action: "BLOCK", reason: "ENCODING_ATTACK", canonicalPath: null, targetHost: null }` if ANY of the following holds:
  1. `decodeURIComponent` throws a `URIError` (malformed `%` sequence).
  2. After 3 decoding passes, the decoded path STILL contains a percent-encoded byte matching `/%[0-9a-fA-F]{2}/` (4+ layer over-encoding evasion).
  3. The decoded path contains a null byte (`"\0"`) or any ASCII control character (`code < 32` or `code === 127`).

#### 2. Canonical POSIX Path Normalization & Traversal / Prefix Blocking (`PATH_TRAVERSAL`, `BLOCKED_PATH`)
- Convert all backslashes `\` in the decoded path to `/`.
- Split the path on `/` and resolve segments left-to-right using a stack:
  - Ignore empty `""` segments (collapsing `///*` and leading/trailing slashes) and `"."` segments.
  - On `".."`: if the segment stack is currently empty (attempting to traverse above root `/`), immediately return:
    `{ action: "BLOCK", reason: "PATH_TRAVERSAL", canonicalPath: null, targetHost: null }`.
    Otherwise pop the top segment from the stack.
  - Push normal segments onto the stack.
- Form `baseCanonicalPath = "/" + stack.join("/")` (always starts with `/`, never ends with `/` when length > 1).
- Check `policy.blockedPathPrefixes`: for each `prefix` (with any trailing `/` removed when length > 1), if `baseCanonicalPath === prefix` or `baseCanonicalPath.startsWith(prefix + "/")` (segment-boundary match: `"/admin"` blocks `"/admin"` and `"/admin/keys"`, but NOT `"/admin2"`), immediately return:
  `{ action: "BLOCK", reason: "BLOCKED_PATH", canonicalPath: baseCanonicalPath, targetHost: null }`.

#### 3. HTTP Request / Header Smuggling Check (`HEADER_SMUGGLING`)
- Inspect `req.headers` (if provided). Normalize every header name via `key.toLowerCase().replace(/_/g, "-")`.
- If BOTH `"content-length"` and `"transfer-encoding"` are present, OR if `"x-forwarded-user"` or `"x-internal-admin"` is present (including underscore variants like `X_Forwarded_User`), immediately return:
  `{ action: "BLOCK", reason: "HEADER_SMUGGLING", canonicalPath: baseCanonicalPath, targetHost: null }`.

#### 4. Zero-Day SSRF Target URL Inspection (`SSRF_SCHEME`, `SSRF_USERINFO`, `SSRF_PRIVATE_IP`, `SSRF_HOST_NOT_ALLOWED`)
- If `req.targetUrl` is `null`, `undefined`, or `""`, set `targetHost = null` and proceed to Step 5.
- Otherwise:
  1. **Scheme Check**: `req.targetUrl` must start with `http://` or `https://` (case-insensitive). Any other scheme (`gopher://`, `file://`, `dict://`, etc.) or missing authority returns:
     `{ action: "BLOCK", reason: "SSRF_SCHEME", canonicalPath: baseCanonicalPath, targetHost: null }`.
  2. **Userinfo Confusion Check**: Extract the authority substring between `://` and the next `/`, `?`, `#`, or end of string. If the authority contains `"@"` (e.g., `https://api.stripe.com@169.254.169.254/latest/meta-data/`), return:
     `{ action: "BLOCK", reason: "SSRF_USERINFO", canonicalPath: baseCanonicalPath, targetHost: null }`.
  3. **Host Extraction**:
     - If the authority begins with `"["` (IPv6 literal), extract the substring inside `[...]` and lowercase it as `host`.
     - Otherwise strip any `:port` suffix, lowercase the hostname, and strip any trailing dots `.`.
  4. **Adversarial IP & Internal Host Blocking (`SSRF_PRIVATE_IP`)**:
     - Immediately return `{ action: "BLOCK", reason: "SSRF_PRIVATE_IP", canonicalPath: baseCanonicalPath, targetHost: null }` if `host` is:
       - `"localhost"`, or ends with `".localhost"`, `".local"`, or `".internal"` (including `"metadata.google.internal"`).
       - An IPv6 loopback (`"::1"`, `"0:0:0:0:0:0:0:1"`), IPv6 link-local (`fe80:...`), IPv6 unique-local (`fc00:...` / `fd00:...`), or IPv4-mapped IPv6 (`::ffff:<ipv4-or-hex>`) whose embedded IPv4 address falls in a forbidden IPv4 range below.
       - Any IPv4 address — whether written in standard dotted-quad (`127.0.0.1`), **octal** (`0177.0.0.1`), **hexadecimal** (`0x7f.0.0.1` or `0x7f000001`), or **32-bit decimal integer / dword** (`2130706433` or `2852039166`) — whose 4 resolved octets `[a, b, c, d]` fall inside:
         - `0.0.0.0/8` (`a === 0`)
         - `10.0.0.0/8` (`a === 10`)
         - `100.64.0.0/10` (`a === 100 && b >= 64 && b <= 127`)
         - `127.0.0.0/8` (`a === 127`)
         - `169.254.0.0/16` (`a === 169 && b === 254` — AWS/GCP/Azure IMDSv1/v2)
         - `172.16.0.0/12` (`a === 172 && b >= 16 && b <= 31`)
         - `192.168.0.0/16` (`a === 192 && b === 168`)
  5. **Host Allowlist Check (`SSRF_HOST_NOT_ALLOWED`)**:
     - Compare `host` against `(policy.allowedHosts || []).map(h => h.toLowerCase())`. If not found, return:
       `{ action: "BLOCK", reason: "SSRF_HOST_NOT_ALLOWED", canonicalPath: baseCanonicalPath, targetHost: host }`.
     - Otherwise set `targetHost = host`.

#### 5. Query Parameter Sanitization (`SANITIZE` vs `ALLOW`)
- If `rawQuery` is non-empty, split on `"&"` and inspect each `key=value` pair in order:
  - URL-decode the key and value (treating `+` as space and applying `decodeURIComponent` safely).
  - Remove the parameter if its decoded key is in `policy.stripParams`, OR if its decoded value matches `/<script|javascript:|'\s*or\s*'/i` (XSS or SQLi tautology).
- Reconstruct `canonicalPath` by appending any remaining query parameters (`"?" + kept.join("&")`) to `baseCanonicalPath`.
- If `baseCanonicalPath !== rawPath` (the path required normalization/decoding) OR any query parameter was removed, return:
  `{ action: "SANITIZE", reason: "NORMALIZED", canonicalPath, targetHost }`.
- Otherwise return:
  `{ action: "ALLOW", reason: null, canonicalPath, targetHost }`.

Your answer must be a single, complete JavaScript function named exactly `evaluateZeroDayPatch` and nothing else (no test/driver code, no exports, no usage examples).

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block.
