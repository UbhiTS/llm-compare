---
id: retail-replenishment
title: Retail: multi-store demand forecast + replenishment plan
category: business
language: null
functionName: solution
executable: false
---
Act as a senior demand-planning and inventory-optimization analyst for a mid-size omnichannel apparel retailer. Using the data below, produce a complete, decision-ready replenishment plan for the next 6 weeks. Show your reasoning, state every assumption explicitly, and present the outputs as clear Markdown tables.

Context:
- 4 distribution regions feeding 40 stores; the sample below is a representative slice of 5 stores x 4 SKUs. Scale your recommended method so it would apply to the full network.
- It is the start of Week 27 (early July). A national 20%-off promotion runs in Weeks 30-31. Peak back-to-school demand builds through August.
- Replenishment lead time from the DC is 2 weeks. Cases ship in multiples of 6 units. Target in-stock service level: 97% (assume a z of ~1.9 for safety stock).

Sample data (units) - recent 4-week average weekly sales / current on-hand / in-transit, per store x SKU:
- SKU A "Core Tee" (never-out-of-stock basic): Store 1: 60 / 40 / 0 · Store 2: 45 / 120 / 0 · Store 3: 80 / 30 / 36 · Store 4: 25 / 15 / 0 · Store 5: 95 / 200 / 0
- SKU B "Denim Short" (seasonal peak now): Store 1: 30 / 20 / 0 · Store 2: 55 / 10 / 24 · Store 3: 40 / 60 / 0 · Store 4: 20 / 5 / 0 · Store 5: 70 / 15 / 0
- SKU C "Fleece Hoodie" (early back-to-school ramp): Store 1: 8 / 50 / 0 · Store 2: 12 / 40 / 0 · Store 3: 18 / 30 / 0 · Store 4: 6 / 25 / 0 · Store 5: 22 / 20 / 0
- SKU D "Printed Dress" (slow mover, ending season): Store 1: 5 / 45 / 0 · Store 2: 3 / 60 / 0 · Store 3: 7 / 55 / 0 · Store 4: 2 / 30 / 0 · Store 5: 6 / 70 / 0
- DC on-hand available to allocate: SKU A 1,500 · SKU B 400 · SKU C 2,000 · SKU D 0 (discontinued at DC).

Deliverables:
1. A per-SKU demand forecast for Weeks 27-32 that reflects seasonality and the promo lift (call out your assumed promo uplift % per SKU and why).
2. Safety stock and reorder point per store x SKU, with the formula you used.
3. A replenishment/allocation plan: units to ship to each store and in which week, respecting the 2-week lead time, case-pack rounding, and the limited DC on-hand (show how you ration SKU B when DC supply is short).
4. A risk register: flag likely stockouts before the promo and overstock/aged inventory, each with a recommended action.
5. Markdown / clearance strategy for the slow mover (SKU D) with suggested markdown depth and expected sell-through.
6. An executive summary: top 5 actions this week, projected service level, and the KPIs you would track (weeks-of-supply, sell-through, in-stock %, GMROI).

Presentation - make it look genuinely professional (this matters as much as the content): format the entire response as a polished, board-ready **Markdown** document, not a plain-text dump.
- Lead with a bold **Executive summary** (3-5 crisp lines), then the sections in the order of the deliverables above, using clear `##` / `###` headings.
- Put ALL numeric, comparative, or tabular data in well-formed **Markdown tables** (bold header row, aligned columns, units in the header) - never bury figures in prose.
- Use tight bullet / numbered lists, and **bold** every key figure, target, decision, and risk so the page scans in seconds.
- Add polished touches: a one-line takeaway under each major table, and simple status markers where useful (✅ / ⚠️ / 🔴, or **High / Med / Low** badges in risk and priority columns).
- Keep it crisp and skimmable - favour tables and short lines over long paragraphs, and do not output raw code, JSON, or unformatted blobs.
