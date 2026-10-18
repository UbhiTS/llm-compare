---
id: cad-simple-clevis-rod-end
title: Flight Control Forked Clevis Rod End
category: cad3d
vertical: aerospace
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **machined 17-4PH stainless steel aerospace flight-control forked clevis rod end** with a cross-pin and retention cotter hole:

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Threaded Actuator Shank & Wrench Hex (`threaded_shank`)**:
   - Lower cylindrical threaded shank (**12.0 mm** diameter, **28 mm** long from `Y = 0` to `Y = 28 mm`) topped by an integrated hexagonal wrench collar (**19.0 mm** across flats, **8.0 mm** tall from `Y = 28 mm` to `Y = 36 mm`).
2. **U-Shaped Clevis Fork (`clevis_fork`)**:
   - Symmetrical U-yoke body rising from `Y = 36 mm` to `Y = 76 mm` (**32 mm** overall width across the two fork ears, **12.0 mm** inside slot gap for the mating control horn, **22 mm** ear width) with rounded semi-circular top tips centered at `Y = 64 mm` and a **10.0 mm** coaxial cross-pin through-bore piercing both ears.
3. **Removable Clevis Pin (`clevis_pin`)**:
   - **10.0 mm** diameter shear pin seated across the fork ears at `Y = 64 mm`, featuring a **16.0 mm** flat head on one side and a **2.5 mm** cotter-pin cross-hole on the opposite end.

### Adjustable Dimensions
Include sliders for **inside fork gap** (default `12 mm`), **cross-pin diameter** (default `10 mm`), **fork ear thickness** (default `10 mm`), and **shank length** (default `28 mm`).
