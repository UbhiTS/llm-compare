---
id: workforce-schedule
title: Operations: multi-store weekly staffing schedule
category: business
language: null
functionName: solution
executable: false
---
Act as a workforce-management planner for a large retail chain. Build a compliant, cost-efficient weekly staffing schedule for one store from the data below, then explain how the approach scales to hundreds of stores. Reason step by step, respect every hard constraint, state assumptions, and present the schedule and analysis as clear Markdown tables.

Store & demand:
- Store hours: Mon-Sat 9:00-21:00, Sun 10:00-18:00. Roles: Cashier, Sales Floor, and one Manager-on-Duty required whenever the store is open.
- Forecasted customer traffic drives labor need. Approximate concurrent staff required by daypart (Cashier + Sales Floor combined), per the traffic forecast:
  - Weekday mornings (open-12): 3 · midday (12-17): 5 · evening (17-close): 6
  - Saturday: mornings 5 · midday 8 · evening 7
  - Sunday: 4 all day
- Always at least 1 Cashier whenever open; Manager-on-Duty is separate and additional.

Staff roster (availability + constraints):
- 3 full-time associates (target ~38-40h/week each), 6 part-time associates (target 12-25h each), and 2 managers (one must cover every open hour between them; each ≤ 45h/week).
- Hard labor rules: no shift longer than 8 hours; a 30-min unpaid meal break on any shift over 6 hours; at least 10 hours off between shifts; part-timers ≤ 6 days/week; nobody scheduled outside their stated availability (assume typical availability, and clearly list the availability you assume).
- Weekly labor budget target: keep total scheduled hours within ~5% of the minimum needed to meet demand.

Deliverables:
1. A day-by-day, shift-by-shift schedule table (person, role, start-end, break, daily hours) that meets every daypart's coverage with a Manager-on-Duty always present.
2. A coverage check: for each daypart, required vs. scheduled staff, highlighting any gap or overage.
3. A summary table of weekly hours per person vs. their target, flagging overtime risk and under-utilization.
4. The optimization logic you used (how you matched shifts to the demand curve and minimized cost) and how you'd encode it as an automated solver (objective + hard/soft constraints) for a 300-store rollout.
5. Edge-case handling: a call-out plan (someone calls in sick Saturday midday) and how the schedule flexes.
6. KPIs to track (schedule-to-forecast fit, labor cost as % of sales, overtime %, compliance exceptions) and an executive summary of cost and coverage.

Presentation - make it look genuinely professional (this matters as much as the content): format the entire response as a polished, board-ready **Markdown** document, not a plain-text dump.
- Lead with a bold **Executive summary** (3-5 crisp lines), then the sections in the order of the deliverables above, using clear `##` / `###` headings.
- Put ALL numeric, comparative, or tabular data in well-formed **Markdown tables** (bold header row, aligned columns, units in the header) - never bury figures in prose (the schedule itself must be a table).
- Use tight bullet / numbered lists, and **bold** every key figure, target, decision, and risk so the page scans in seconds.
- Add polished touches: a one-line takeaway under each major table, and simple status markers where useful (✅ / ⚠️ / 🔴, or **High / Med / Low** badges in risk and priority columns).
- Keep it crisp and skimmable - favour tables and short lines over long paragraphs, and do not output raw code, JSON, or unformatted blobs.
