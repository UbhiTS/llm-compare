---
id: cad-simple-spur-gear
title: Involute Spur Gear with Lightening Web
category: cad3d
vertical: automotive
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Single Machined Steel Involute Spur Gear with a Recessed Web and Keyed Hub** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Involute Toothed Gear Rim (`involute_gear_rim`):**
   - A 28-tooth involute spur gear with a `2.5 mm` metric module (`70 mm` pitch diameter), `20-degree` pressure angle, and `18 mm` face width (`Y = 0` to `Y = 18 mm`), featuring 6 circular lightening holes (`10 mm` diameter) arranged around the web between the root rim and central hub.
   - Material: case-hardened brushed alloy steel.

2. **Raised Central Shaft Hub (`central_gear_hub`):**
   - A concentric cylindrical boss (`34 mm` outer diameter, `18 mm` inner shaft bore) rising `10 mm` above the top face of the gear web (`Y = 0` to `Y = 28 mm`) for torsional support.
   - Material: machined brass or dark-anodized steel contrast.

3. **Hub Locking Collar & Axial Retaining Ring (`hub_clamp_collar`):**
   - A stepped clamping shoulder ring (`40 mm` outer diameter, `4 mm` thick) at the base of the protruding hub (`Y = 18 mm` to `Y = 22 mm`).

Expose `teeth`, `module`, `faceWidth`, `boreDiameter`, `hubDiameter`, and `lighteningHoles` as adjustable parameters.
