---
id: compliance-readiness
title: Governance: SOC 2 + GDPR readiness assessment
category: business
language: null
functionName: solution
executable: false
---
Act as a GRC (governance, risk & compliance) consultant. A B2B SaaS company that stores customer personal data in AWS wants to sell to enterprise buyers and must become SOC 2 Type II and GDPR ready. From the profile below, produce a decision-ready readiness assessment and remediation roadmap. Reason step by step, cite which control area each gap maps to, state assumptions, and present the output as clear Markdown with tables. (You are giving practical compliance guidance, not formal legal advice - note that caveat.)

Company profile:
- ~90 employees; a multi-tenant web app; production in AWS (EC2/RDS/S3), code in GitHub, CI/CD to production. ~50 SaaS vendors (including sub-processors) handle parts of the workflow.
- Current state: SSO for the app but not for all internal tools; MFA inconsistent; access reviews ad hoc; no formal risk assessment; backups exist but restores are untested; logging in CloudWatch but no central SIEM/alerting; no formal incident-response plan; onboarding/offboarding is manual; a public privacy policy exists but there is no data-processing inventory (RoPA), no standard DPA with sub-processors, and no defined data-subject-request (DSAR) process; encryption at rest/in transit is mostly on but unverified.
- Timeline goal: audit-ready in ~6 months; limited security headcount (1 security engineer + eng leadership).

Deliverables:
1. Scope & framework mapping: which SOC 2 Trust Services Criteria (Security, Availability, Confidentiality, Processing Integrity, Privacy) are in scope, and how the GDPR obligations (lawful basis, RoPA, DPAs, DSAR, breach notification, data-minimization, international transfers) overlap - shown in a mapping table.
2. A gap analysis table: for each control area, current state, the gap, severity (High/Med/Low), and the SOC 2 criterion and/or GDPR article it maps to.
3. A prioritized remediation roadmap over 6 months (30/60/90/180-day milestones) with owner-role and effort, sequenced so quick wins and audit-blocking items come first.
4. The specific policies, and the evidence/artifacts an auditor will request, that must exist before the Type II observation window starts (list them).
5. Vendor / sub-processor management: how to inventory them, what to require (DPAs, security reviews), and how to handle international data transfers.
6. An executive summary: overall readiness rating, the top 5 risks to close first, a realistic cost/effort estimate, and the go/no-go criteria for starting the audit window.
