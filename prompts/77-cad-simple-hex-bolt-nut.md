---
id: cad-simple-hex-bolt-nut
title: Metric M20 Hex Bolt, Washer & Nut
category: cad3d
vertical: industrial
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Metric M20 Hex-Head Cap Bolt with a Flat Washer and Matching Hex Nut** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Chamfered Hex Bolt Head (`hex_bolt_head`):**
   - A 6-sided hexagonal bolt head resting flat on `Y = 0`, 30 mm across flats (`34.6 mm` across corners) and `13 mm` tall, with a beveled top washer-face chamfer ring.
   - Material: dark black-oxide or brushed alloy steel.

2. **Unthreaded Upper Grip Shank (`bolt_grip_shank`):**
   - A smooth cylindrical 20 mm diameter unthreaded grip shoulder rising from the top of the hex head (`Y = 13 mm` to `Y = 35 mm`).
   - Material: brushed alloy steel.

3. **Helical Threaded Shaft (`bolt_helical_thread`):**
   - A 20 mm diameter metric V-thread section with a 2.5 mm thread pitch extending from `Y = 35 mm` up to `Y = 80 mm`, complete with a chamfered lead-in tip at the top.
   - Material: brushed steel.

4. **Hardened Flat Washer & Threaded Hex Nut (`flat_washer` and `hex_nut`):**
   - A 37 mm outer-diameter, 3.5 mm thick hardened flat washer and a 6-sided M20 hex nut (`16 mm` tall, `30 mm` across flats) with an internal 20 mm bore threaded mid-way along the threaded shaft (`Y = 44 mm`), finished in contrasting zinc-chromate brass or gold tone.

Expose key shop dimensions (`boltDiameter`, `threadPitch`, `shankLength`, `threadLength`, `nutPositionY`) as interactive parameters.
