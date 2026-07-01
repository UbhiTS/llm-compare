---
id: supply-chain-disruption
title: Supply chain: disruption response playbook
category: business
language: null
functionName: solution
executable: false
---
Act as the VP of Global Supply Chain for a consumer-electronics manufacturer. A disruption just hit and you must produce a decision-ready response playbook for the executive team within the hour. Reason step by step, quantify impact where you can, state assumptions, and present the plan in clear Markdown (use tables and a prioritized action list).

The situation:
- A magnitude-6.8 earthquake has halted your primary supplier's factory in Kaohsiung, Taiwan, which produces the custom power-management IC (part PMIC-7) used in 3 of your 5 top-selling products. The supplier estimates 4-8 weeks to restore partial output.
- PMIC-7 has a normal lead time of 10 weeks and no drop-in second source qualified today. You hold 5 weeks of PMIC-7 on hand plus 2 weeks in transit.
- Affected products represent ~45% of quarterly revenue (~$180M). Q-end is 7 weeks away. A major retail customer has a contractual on-time-delivery SLA with penalties.
- You have a secondary supplier in Malaysia that could make a functionally similar PMIC but needs 6 weeks to qualify and ramp; and a costlier distributor spot-market supply of limited quantity available now.

Deliverables:
1. Impact assessment: which products, how many weeks until you run out of PMIC-7 at current build rates, revenue and units at risk by week, and the customers/SLAs exposed.
2. Immediate actions (first 72 hours): triage, allocation of remaining PMIC-7 across products (which to prioritize and why), spot-buy decision with a cost/benefit, customer and internal communications.
3. Short-term mitigation (weeks 1-6): re-sequencing the production plan, engineering options (firmware/board rework to a substitute part, de-featuring), expedite/air-freight trade-offs, and building the qualification plan for the Malaysia source.
4. A decision framework and recommendation: build-to-stock vs. allocate-to-key-accounts, and how to split scarce supply between the SLA customer and higher-margin channels.
5. Financials: estimated cost of each mitigation lever and the net revenue protected, in a comparison table.
6. Risk register + trigger points: what could go wrong with each lever, leading indicators to watch, and the "if X by date Y, then switch to plan Z" contingencies.
7. A one-paragraph executive summary and the single recommended course of action.

Presentation - make it look genuinely professional (this matters as much as the content): format the entire response as a polished, board-ready **Markdown** document, not a plain-text dump.
- Lead with a bold **Executive summary** (3-5 crisp lines), then the sections in the order of the deliverables above, using clear `##` / `###` headings.
- Put ALL numeric, comparative, or tabular data in well-formed **Markdown tables** (bold header row, aligned columns, units in the header) - never bury figures in prose.
- Use tight bullet / numbered lists, and **bold** every key figure, target, decision, and risk so the page scans in seconds.
- Add polished touches: a one-line takeaway under each major table, and simple status markers where useful (✅ / ⚠️ / 🔴, or **High / Med / Low** badges in risk and priority columns).
- Keep it crisp and skimmable - favour tables and short lines over long paragraphs, and do not output raw code, JSON, or unformatted blobs.
