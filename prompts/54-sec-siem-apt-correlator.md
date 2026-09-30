---
id: sec-siem-apt-correlator
title: Security: Multi-Stage APT Kill-Chain & SIEM Log Correlator
category: security
language: javascript
functionName: correlateAptCampaigns
executable: true
testCases: [{"input":[[{"id":"e1","ts":100,"type":"auth_fail","actor":"alice","srcIp":"203.0.113.10"},{"id":"e2","ts":150,"type":"auth_fail","actor":"bob","srcIp":"203.0.113.25"},{"id":"e3","ts":200,"type":"auth_fail","actor":"carol","srcIp":"203.0.113.99"},{"id":"e4","ts":400,"type":"auth_success","actor":"alice","srcIp":"203.0.113.50"},{"id":"e5","ts":900,"type":"process","actor":"alice","meta":{"cmd":"curl -s http://169.254.169.254/latest/meta-data/"}},{"id":"e6","ts":1200,"type":"storage_read","actor":"alice","meta":{"bytes":60000000}}]],"expected":[{"rootActor":"alice","initialSubnet":"203.0.113","identitiesUsed":["alice"],"exfilMethod":"BULK_STORAGE","firstCompromiseTs":400,"exfilConfirmedTs":1200}]},{"input":[[{"id":"b1","ts":100,"type":"auth_fail","actor":"dave","srcIp":"198.51.100.1"},{"id":"b2","ts":110,"type":"auth_fail","actor":"dave","srcIp":"198.51.100.2"},{"id":"b3","ts":120,"type":"auth_fail","actor":"erin","srcIp":"198.51.100.3"},{"id":"b4","ts":130,"type":"auth_fail","actor":"dave","srcIp":"198.51.100.4"},{"id":"b5","ts":200,"type":"auth_success","actor":"dave","srcIp":"198.51.100.5"},{"id":"b6","ts":300,"type":"process","actor":"dave","meta":{"cmd":"nsenter -t 1 -m -u -i -n /bin/sh"}},{"id":"b7","ts":400,"type":"storage_read","actor":"dave","meta":{"bytes":90000000}}]],"expected":[]},{"input":[[{"id":"m1","ts":10,"type":"auth_fail","actor":"alice","srcIp":"192.0.2.11"},{"id":"m2","ts":50,"type":"auth_fail","actor":"bob","srcIp":"192.0.2.12"},{"id":"m3","ts":90,"type":"auth_fail","actor":"charlie","srcIp":"192.0.2.13"},{"id":"m4","ts":300,"type":"auth_success","actor":"alice","srcIp":"192.0.2.99"},{"id":"m5","ts":500,"type":"impersonate","actor":"alice","target":"ci-runner-sa"},{"id":"m6","ts":700,"type":"impersonate","actor":"ci-runner-sa","target":"prod-kms-sa"},{"id":"m7","ts":1000,"type":"process","actor":"ci-runner-sa","meta":{"cmd":"echo payload | base64 -d | sh"}},{"id":"m8","ts":1300,"type":"dns_query","actor":"prod-kms-sa","target":"a1b2c3d4e5f6g7h8i9j0k1l2.stage.exfil-cdn.net"},{"id":"m9","ts":1350,"type":"dns_query","actor":"alice","target":"z9y8x7w6v5u4t3s2r1q0p9o8.stage.exfil-cdn.net"},{"id":"m10","ts":1400,"type":"dns_query","actor":"prod-kms-sa","target":"0123456789abcdef01234567.deep.sub.exfil-cdn.net"}]],"expected":[{"rootActor":"alice","initialSubnet":"192.0.2","identitiesUsed":["alice","ci-runner-sa","prod-kms-sa"],"exfilMethod":"DNS_TUNNEL","firstCompromiseTs":300,"exfilConfirmedTs":1400}]},{"input":[[{"id":"d6","ts":1500,"type":"storage_read","actor":"svc-db","meta":{"bytes":30000000}},{"id":"d5","ts":1100,"type":"storage_read","actor":"alice","meta":{"bytes":25000000}},{"id":"d5","ts":1100,"type":"storage_read","actor":"alice","meta":{"bytes":99999999}},{"id":"d4","ts":800,"type":"process","actor":"svc-db","meta":{"cmd":"chmod +s /bin/bash"}},{"id":"d3","ts":600,"type":"impersonate","actor":"alice","target":"svc-db"},{"id":"d2","ts":500,"type":"auth_success","actor":"alice"},{"id":"d1c","ts":250,"type":"auth_fail","actor":"u3","srcIp":"198.18.0.9"},{"id":"d1b","ts":200,"type":"auth_fail","actor":"u2","srcIp":"198.18.0.8"},{"id":"d1a","ts":100,"type":"auth_fail","actor":"alice","srcIp":"198.18.0.7"}]],"expected":[{"rootActor":"alice","initialSubnet":"198.18.0","identitiesUsed":["alice","svc-db"],"exfilMethod":"BULK_STORAGE","firstCompromiseTs":500,"exfilConfirmedTs":1500}]},{"input":[[{"id":"w1","ts":100,"type":"auth_fail","actor":"alice","srcIp":"203.0.113.1"},{"id":"w2","ts":120,"type":"auth_fail","actor":"bob","srcIp":"203.0.113.2"},{"id":"w3","ts":140,"type":"auth_fail","actor":"carol","srcIp":"203.0.113.3"},{"id":"w4","ts":200,"type":"auth_success","actor":"alice"},{"id":"w5","ts":400,"type":"process","actor":"alice","meta":{"cmd":"nsenter -t 1 -m /bin/sh","maintenanceWindow":true}},{"id":"w6","ts":600,"type":"storage_read","actor":"alice","meta":{"bytes":80000000}}]],"expected":[]},{"input":[[{"id":"s1","ts":50,"type":"auth_fail","actor":"kim","srcIp":"100.64.1.1"},{"id":"s2","ts":100,"type":"auth_fail","actor":"lee","srcIp":"100.64.1.2"},{"id":"s3","ts":150,"type":"auth_fail","actor":"max","srcIp":"100.64.1.3"},{"id":"s4","ts":200,"type":"auth_success","actor":"kim"},{"id":"s5","ts":300,"type":"process","actor":"kim","meta":{"cmd":"powershell -enc SQBFAFgA"}},{"id":"s6","ts":400,"type":"storage_read","actor":"kim","meta":{"bytes":20000000}},{"id":"s7","ts":500,"type":"storage_read","actor":"kim","meta":{"bytes":15000000}},{"id":"s8","ts":600,"type":"storage_read","actor":"kim","meta":{"bytes":14999999}}]],"expected":[]},{"input":[[{"id":"q1","ts":10,"type":"auth_fail","actor":"nia","srcIp":"192.0.2.1"},{"id":"q2","ts":20,"type":"auth_fail","actor":"omar","srcIp":"192.0.2.2"},{"id":"q3","ts":30,"type":"auth_fail","actor":"pat","srcIp":"192.0.2.3"},{"id":"q4","ts":100,"type":"auth_success","actor":"nia"},{"id":"q5","ts":200,"type":"process","actor":"nia","meta":{"cmd":"curl http://metadata.google.internal/computeMetadata/v1/"}},{"id":"q6","ts":300,"type":"dns_query","actor":"nia","target":"12345678901234567890.c2.bad.io"},{"id":"q7","ts":310,"type":"dns_query","actor":"nia","target":"1234567890123456789.c2.bad.io"},{"id":"q8","ts":320,"type":"dns_query","actor":"nia","target":"abcdefghijklmnopqrst.c2.bad.io"}]],"expected":[]},{"input":[[{"id":"r1","ts":10,"type":"auth_fail","actor":"nia","srcIp":"192.0.2.1"},{"id":"r2","ts":20,"type":"auth_fail","actor":"omar","srcIp":"192.0.2.2"},{"id":"r3","ts":30,"type":"auth_fail","actor":"pat","srcIp":"192.0.2.3"},{"id":"r4","ts":100,"type":"auth_success","actor":"nia"},{"id":"r5","ts":200,"type":"process","actor":"nia","meta":{"cmd":"curl http://metadata.google.internal/computeMetadata/v1/"}},{"id":"r6","ts":300,"type":"dns_query","actor":"nia","target":"12345678901234567890.a.domain1.io"},{"id":"r7","ts":310,"type":"dns_query","actor":"nia","target":"12345678901234567890.b.domain1.io"},{"id":"r8","ts":320,"type":"dns_query","actor":"nia","target":"12345678901234567890.a.domain2.io"}]],"expected":[]},{"input":[[{"id":"x1","ts":100,"type":"auth_fail","actor":"root1","srcIp":"198.51.100.10"},{"id":"x2","ts":110,"type":"auth_fail","actor":"root2","srcIp":"198.51.100.11"},{"id":"x3","ts":120,"type":"auth_fail","actor":"root3","srcIp":"198.51.100.12"},{"id":"x4","ts":200,"type":"auth_success","actor":"root1"},{"id":"x5","ts":400,"type":"process","actor":"root1","meta":{"cmd":"nsenter -t 1 -n /bin/sh"}},{"id":"x6","ts":500,"type":"dns_query","actor":"root1","target":"aaaaaaaaaaaaaaaaaaaa.sub.c2-drop.org"},{"id":"x7","ts":510,"type":"dns_query","actor":"root1","target":"bbbbbbbbbbbbbbbbbbbb.sub.c2-drop.org"},{"id":"x8","ts":520,"type":"dns_query","actor":"root1","target":"cccccccccccccccccccc.sub.c2-drop.org"},{"id":"x9","ts":600,"type":"storage_read","actor":"root1","meta":{"bytes":55000000}}]],"expected":[{"rootActor":"root1","initialSubnet":"198.51.100","identitiesUsed":["root1"],"exfilMethod":"BOTH","firstCompromiseTs":200,"exfilConfirmedTs":520}]},{"input":[[{"id":"t1","ts":100,"type":"auth_fail","actor":"u1","srcIp":"203.0.113.1"},{"id":"t2","ts":200,"type":"auth_fail","actor":"u2","srcIp":"203.0.113.2"},{"id":"t3","ts":300,"type":"auth_fail","actor":"u3","srcIp":"203.0.113.3"},{"id":"t4","ts":901,"type":"auth_success","actor":"u1"},{"id":"t5","ts":1000,"type":"process","actor":"u1","meta":{"cmd":"nsenter -t 1"}},{"id":"t6","ts":1100,"type":"storage_read","actor":"u1","meta":{"bytes":60000000}}]],"expected":[]},{"input":[[{"id":"o1","ts":100,"type":"auth_fail","actor":"u1","srcIp":"203.0.113.1"},{"id":"o2","ts":150,"type":"auth_fail","actor":"u2","srcIp":"203.0.113.2"},{"id":"o3","ts":200,"type":"auth_fail","actor":"u3","srcIp":"203.0.113.3"},{"id":"o4","ts":300,"type":"auth_success","actor":"u1"},{"id":"o5","ts":400,"type":"storage_read","actor":"u1","meta":{"bytes":60000000}},{"id":"o6","ts":500,"type":"process","actor":"u1","meta":{"cmd":"nsenter -t 1"}}]],"expected":[]},{"input":[[{"id":"z1","ts":10,"type":"auth_fail","actor":"zoe","srcIp":"192.0.2.1"},{"id":"z2","ts":20,"type":"auth_fail","actor":"adam","srcIp":"198.51.100.1"},{"id":"z3","ts":30,"type":"auth_fail","actor":"ben","srcIp":"192.0.2.2"},{"id":"z4","ts":40,"type":"auth_fail","actor":"carl","srcIp":"192.0.2.3"},{"id":"z5","ts":50,"type":"auth_fail","actor":"dan","srcIp":"198.51.100.2"},{"id":"z6","ts":60,"type":"auth_fail","actor":"eva","srcIp":"198.51.100.3"},{"id":"z7","ts":100,"type":"auth_success","actor":"zoe"},{"id":"z8","ts":110,"type":"auth_success","actor":"adam"},{"id":"z9","ts":200,"type":"process","actor":"zoe","meta":{"cmd":"chmod +s /usr/bin/find"}},{"id":"z10","ts":210,"type":"process","actor":"adam","meta":{"cmd":"curl http://169.254.169.254/latest"}},{"id":"z11","ts":300,"type":"storage_read","actor":"zoe","meta":{"bytes":50000000}},{"id":"z12","ts":310,"type":"storage_read","actor":"adam","meta":{"bytes":75000000}}]],"expected":[{"rootActor":"adam","initialSubnet":"198.51.100","identitiesUsed":["adam"],"exfilMethod":"BULK_STORAGE","firstCompromiseTs":110,"exfilConfirmedTs":310},{"rootActor":"zoe","initialSubnet":"192.0.2","identitiesUsed":["zoe"],"exfilMethod":"BULK_STORAGE","firstCompromiseTs":100,"exfilConfirmedTs":300}]}]
---
You are building a stateful SIEM correlation engine (`correlateAptCampaigns`) that detects multi-stage Advanced Persistent Threat (APT) campaigns across out-of-order authentication, lateral-movement, process-execution, DNS, and cloud-storage telemetry logs.

Signature: `correlateAptCampaigns(events)`

### Input
`events` is an array of telemetry log objects:
`{ id: string, ts: number, type: string, actor: string, srcIp?: string, target?: string, meta?: object }`
where `ts` is a Unix epoch timestamp in seconds.

---

### Correlation Rules

#### 1. Deduplication, Maintenance Filtering & Chronological Ordering
- **Deduplicate by `id`**: Keep ONLY the **first occurrence** of each `id` as it appears in the input array.
- **Ignore Maintenance Activity**: Discard any event where `event.meta && event.meta.maintenanceWindow === true`.
- **Sort**: Order the remaining events by `ts` ascending, breaking ties by `id` lexicographically (`a.id < b.id ? -1 : a.id > b.id ? 1 : 0`).

#### 2. Stage 1 — Distributed Password Spraying (`auth_fail` → `auth_success`)
- Group `type === "auth_fail"` events by the `/24` IPv4 prefix of `srcIp` (the first 3 dot-separated octets, e.g., `"203.0.113"` from `"203.0.113.45"`).
- Whenever an `auth_fail` event occurs at timestamp `t_fail` from `/24` subnet `S`, inspect all `auth_fail` events from that same `/24` subnet `S` within the sliding window `[t_fail - 300, t_fail]` (inclusive):
  - If that window contains `auth_fail` attempts against **at least 3 distinct `actor` usernames**, then subnet `S` triggers a **Spray Burst** at `t_fail`.
  - Every `actor` targeted by subnet `S` within `[t_fail - 300, t_fail]` is marked as sprayed by subnet `S` with an active compromise eligibility window `[t_fail, t_fail + 600]` (inclusive).
  - *Important*: High-volume brute force against only 1 or 2 usernames on a `/24` subnet is NOT a password spray and must never trigger Stage 1.
- If a non-compromised `actor` has a `type === "auth_success"` event at timestamp `t_login` that falls inside `[t_fail, t_fail + 600]` for a Spray Burst that targeted `actor` on subnet `S`, then `actor` becomes the `rootActor` of a new **Stage-1 Compromised Campaign** with:
  - `rootActor = actor`
  - `initialSubnet = S`
  - `firstCompromiseTs = t_login`
  - Active campaign identity set initialized to `{ [actor]: t_login }`.

#### 3. Lateral Movement & Transitive Identity Graph (`impersonate`)
- Once a campaign is active (starting at `firstCompromiseTs`), if any currently active identity `A` in that campaign (`ts >= activeFrom[A]` and `ts <= firstCompromiseTs + 3600`) performs `type === "impersonate"` with a non-empty `target: B`:
  - Identity `B` joins that campaign's active identity set starting at `ts` (if `B` was already in the campaign, keep its earliest activation timestamp).
  - Lateral movement can chain transitively (`alice → ci-runner-sa → prod-kms-sa`).
  - `identitiesUsed` for a campaign is the sorted unique array of `rootActor` plus all identities `B` reached via `impersonate` in that campaign within `[firstCompromiseTs, firstCompromiseTs + 3600]`.

#### 4. Stage 2 — Living-off-the-Land / Privilege Escalation (`process`)
- For an active campaign, a `type === "process"` event at timestamp `ts` satisfies **Stage 2** if:
  1. `event.actor` is currently an active identity in the campaign (`ts >= activeFrom[event.actor]`),
  2. `ts <= firstCompromiseTs + 1800` (within 30 minutes of `firstCompromiseTs`), AND
  3. `event.meta && typeof event.meta.cmd === "string"` contains ANY of the following substrings (case-sensitive):
     - `"169.254.169.254"` or `"metadata.google.internal"` (IMDS credential theft)
     - `"nsenter"` or `"chmod +s"` (container escape / SUID escalation)
     - `"-enc "` or `"base64 -d"` (encoded payload execution)
- Record `stage2Ts` as the timestamp of the **first** valid Stage-2 event for the campaign.

#### 5. Stage 3 — Data Exfiltration (`dns_query` | `storage_read`)
- Only events occurring **at or after `stage2Ts`** (`ts >= stage2Ts`) and within **60 minutes of `firstCompromiseTs`** (`ts <= firstCompromiseTs + 3600`), executed by a currently active identity in the campaign (`ts >= activeFrom[event.actor]`), count toward Stage 3:
  1. **DNS Tunneling (`"DNS_TUNNEL"`)**:
     - `type === "dns_query"` where `target` (lowercased, trailing dot removed) has at least 3 dot-separated labels AND the leftmost subdomain label (`labels[0]`) has length `>= 20` characters.
     - Group valid tunneling queries in the campaign by their **registrable domain** (the last 2 labels, e.g., `"exfil-cdn.net"` for `"a1b2c3d4e5f6g7h8i9j0k1l2.stage.exfil-cdn.net"`).
     - As soon as ANY single registrable domain reaches **3** such queries in the campaign, `"DNS_TUNNEL"` is confirmed at the 3rd query's `ts`.
  2. **Bulk Cloud Storage Read (`"BULK_STORAGE"`)**:
     - `type === "storage_read"` with a positive number `event.meta.bytes`.
     - Sum `event.meta.bytes` cumulatively across all valid Stage-3 `storage_read` events in the campaign (across all active identities in the campaign).
     - As soon as the campaign's cumulative bytes reach **`>= 50000000`** (50 MB), `"BULK_STORAGE"` is confirmed at that event's `ts`.
- If a campaign confirms both methods within `[stage2Ts, firstCompromiseTs + 3600]`, set `exfilMethod = "BOTH"` and `exfilConfirmedTs = Math.min(dnsConfirmedTs, storageConfirmedTs)`. Otherwise set `exfilMethod` to the confirmed method (`"DNS_TUNNEL"` or `"BULK_STORAGE"`) and `exfilConfirmedTs` to its confirmation timestamp.

#### 6. Output Format
Return an array of all campaigns that completed **all three stages (Stage 1 + Stage 2 + Stage 3)**, sorted by `rootActor` ascending:
```js
[
  {
    rootActor: string,
    initialSubnet: string,
    identitiesUsed: string[], // sorted unique array
    exfilMethod: "DNS_TUNNEL" | "BULK_STORAGE" | "BOTH",
    firstCompromiseTs: number,
    exfilConfirmedTs: number
  }
]
```

Your answer must be a single, complete JavaScript function named exactly `correlateAptCampaigns` and nothing else (no test/driver code, no exports, no usage examples).

Output ONLY the solution as a single fenced ```javascript code block. No prose, explanation, comments outside the code, preamble, or postscript — nothing before or after the single code block.
