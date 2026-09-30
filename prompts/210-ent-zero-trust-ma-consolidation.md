---
id: ent-zero-trust-ma-consolidation
title: Enterprise: Post-M&A Zero-Trust Identity & Cloud Directory Consolidation
category: enterprise
language: null
functionName: solution
executable: false
---
Act as the Chief Enterprise Security Architect leading the technical integration for a global tech enterprise ($14B ARR) following the acquisition of a $3.8B competitor. You are tasked with consolidating 42,000 acquired employees, 18,000 contractors, and 650 third-party partner organizations across 3 legacy Active Directory forests, 2 Okta tenants, and 1 Microsoft Entra ID tenant into a unified Zero-Trust Identity Fabric.

The acquired company operates sensitive intellectual property, federal defense contracts (NIST SP 800-171 / CMMC Level 2), and multi-cloud infrastructure (AWS, Azure, and GCP). The enterprise requires seamless Day-1 single sign-on (SSO), automated SCIM lifecycle provisioning, device posture verification, and complete perimeter dismantling adhering to NIST SP 800-207 Zero-Trust Architecture standards.

### Deliverables & Section Requirements:

#### 1. Identity Fabric & Federation Architecture Topology
- Target state architecture diagram description and federation model: Hub-and-Spoke identity architecture leveraging Google Cloud Identity / BeyondCorp Enterprise as the primary federation broker.
- Directory synchronization topology: bidirectional identity sync, cross-tenant trust deprecation, and Kerberos / NTLM sunsetting timeline.
- Detailed identity mapping table: schema reconciliation for UPNs, email aliases, immutable employee IDs, security group nestings, and attribute normalization.

#### 2. Zero-Trust Access Policy & Context-Aware Matrix
Provide a comprehensive policy matrix table across 6 core workforce personas (Executive Leadership, Core Software Engineers, Defense/Cleared Personnel, Customer Support, Remote Contractors, and Factory IoT Technicians) detailing:
- Device Posture Requirements (Managed vs. Unmanaged BYOD, CrowdStrike / Google Endpoint verification, TPM 2.0 / Secure Boot, minimum OS version).
- Context Signals (Geolocation, impossible travel velocity, IP reputation, time-of-day access, risk score).
- Authentication Strength (FIDO2 / WebAuthn hardware security keys vs. passkeys vs. PIV/CAC cards).
- Destination Resources (GCP console, corporate Intranet, GitHub Enterprise, Salesforce, AWS production VPCs).
- Session Lifetimes & Step-up re-authentication triggers.

#### 3. Day-1 Through Day-180 Phased Consolidation Roadmap
Chronological milestone table detailing the integration phases:
- **Phase 1: Day 1-14 (Bridge & Secure)**: Immediate SSO federation, perimeter lockdown, compromised credential sweeps.
- **Phase 2: Day 15-60 (Device Trust & SaaS Rationalization)**: MDM profile push, Conditional Access policy deployment, duplicate SaaS app cutover.
- **Phase 3: Day 61-120 (Infrastructure & Cloud Access)**: Cloud IAM migration, AWS IAM Identity Center and GCP Workload Identity federation, bastion host decommissioning via BeyondCorp App Connectors.
- **Phase 4: Day 121-180 (Legacy Decommissioning)**: On-prem domain controller demotion, forest trust teardown, final security sign-off.

#### 4. SaaS Portfolio Rationalization & Licensing Optimization
Financial and operational rationalization table comparing duplicate corporate applications:
- Okta vs. Cloud Identity / Entra ID.
- Slack vs. Google Chat / Microsoft Teams.
- Box vs. Google Drive.
- Zoom vs. Google Meet.
- Zscaler Private Access vs. BeyondCorp Enterprise.
- Projected annualized software license savings, contract termination penalties, and net 3-year financial ROI.

#### 5. Defense & Federal Compliance Boundary (CMMC Level 2)
- Architecture specification for isolating defense-contract data within an isolated Google Cloud Assured Workloads / FedRAMP High boundary.
- Hardware-enforced token requirements, cryptographic module boundaries (FIPS 140-3), and mandatory access logging.

#### 6. Enterprise Risk Register & Transition Contingencies
- Risk matrix table identifying user lockout scenarios, directory sync loops, legacy application authentication failures (LDAP/Kerberos legacy binds), and security bypass attempts.
- Severity scoring, telemetry alerts, and automated rollback protocols.

---
### Presentation Standards:
- Structure the report with clean, authoritative headings following the six numbered sections above.
- Present all policy rules, schemas, cost savings, and timelines in clean, well-aligned Markdown tables.
- Bold every key technical term, protocol, and numeric threshold.
- Do not output generic summaries or incomplete placeholder notes; provide an exhaustive, board-level technical architecture.
