---
id: incident-postmortem
title: Engineering: production incident RCA + postmortem
category: business
language: null
functionName: solution
executable: false
---
Act as a senior site-reliability engineer facilitating a blameless postmortem for a major production incident at a large e-commerce company. From the timeline and signals below, produce a complete, publishable postmortem. Reason carefully about root cause and contributing factors, distinguish correlation from causation, state assumptions, and present it as a clean Markdown document.

Incident facts:
- Severity SEV-1. Customer impact: checkout failure rate rose from 0.2% to 34% for 47 minutes during a Friday flash sale; estimated ~$2.1M in lost orders and elevated support volume.
- Timeline (UTC): 18:02 deploy of payments-service v4.7 (adds a new fraud-check call). 18:05 latency on the payments DB primary begins climbing. 18:14 first checkout-error alert pages on-call. 18:19 on-call acks; suspects the fraud vendor. 18:31 fraud vendor confirms healthy. 18:40 engineer notices DB connection pool exhausted and CPU 100% on the primary. 18:45 v4.7 rolled back. 18:49 error rate recovers. 19:05 incident closed.
- Signals: the new fraud-check ran a synchronous query inside the checkout transaction, holding a DB connection ~700ms longer per request; connection pool max was 100; a config flag meant to gate the feature to 5% of traffic was set to 100% by default in the new release. Load tests were run at average traffic, not flash-sale peak. No automatic rollback on error-rate SLO breach existed.

Deliverables:
1. A crisp summary (what happened, impact, duration) and an impact table (users, orders, revenue, support).
2. A precise timeline table with timestamps, events, and who/what detected each.
3. Root-cause analysis using the "5 whys" AND a contributing-factors breakdown (technical, process, and organizational) - be explicit about the true root cause vs. the factors that amplified it.
4. Detection & response analysis: time-to-detect, time-to-mitigate, what slowed diagnosis (e.g., the wrong initial hypothesis), and how monitoring/alerting should change.
5. Corrective actions: a prioritized table of action items (owner-role, priority P0-P2, and whether each prevents recurrence, speeds detection, or limits blast radius) - covering the connection-pool/query design, the feature-flag default, load-testing at peak, and automated SLO-based rollback.
6. Lessons learned and a short "what went well" section, written blamelessly (focus on systems, not individuals).
