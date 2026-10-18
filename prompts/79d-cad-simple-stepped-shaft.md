---
id: cad-simple-stepped-shaft
title: CNC Stepped Drive Shaft with Keyseat
category: cad3d
vertical: automotive
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Multi-Step CNC Lathe-Turned Steel Transmission Drive Shaft** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Lower Drive Journal & Thrust Shoulder Collar (`lower_bearing_journal` and `center_thrust_collar`):**
   - A precision ground lower bearing journal (`32 mm` diameter, `Y = 0` to `Y = 26 mm`) stepping up to a wide central thrust shoulder collar (`54 mm` diameter, `Y = 26 mm` to `Y = 40 mm`) that locates the shaft axially against a bearing inner race.
   - Material: hardened 4140 chromoly steel.

2. **Main Gear-Seat Step & Parallel Feather Key (`gear_seat_step` and `parallel_feather_key`):**
   - Above the thrust collar, machine the main gear-mounting step (`38 mm` diameter, `Y = 40 mm` to `Y = 82 mm`) fitted with a raised rectangular brass or hardened-steel parallel feather key (`8 mm` wide by `7 mm` thick by `32 mm` long) seated along the `+X` side of the shaft wall.

3. **Upper Bearing Journal & Threaded Locknut Stub (`upper_bearing_journal` and `threaded_locknut_stub`):**
   - Step down to an upper support bearing journal (`28 mm` diameter, `Y = 82 mm` to `Y = 104 mm`) and finish with a top M20 helical threaded spindle nose (`20 mm` diameter, `1.5 mm` fine pitch, `Y = 104 mm` to `Y = 124 mm`) for a retaining locknut.

Expose `collarDiameter`, `gearSeatDiameter`, `upperJournalDiameter`, `keyLength`, and `totalShaftLength` as adjustable parameters.
