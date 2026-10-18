---
id: cad-simple-pipe-flange
title: ANSI Raised-Face Weld-Neck Pipe Flange
category: cad3d
vertical: industrial
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of an **ANSI Class 150 Raised-Face Weld-Neck Stainless-Steel Pipe Flange** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Raised Gasket Sealing Face (`raised_sealing_face`):**
   - A circular raised sealing ring sitting at the bottom (`Y = 0` to `Y = 3 mm`) with a `92 mm` outer diameter and `52 mm` central fluid bore.
   - Material: machined 316L stainless steel.

2. **Main Bolted Flange Ring Disc (`bolted_flange_disc`):**
   - A heavy circular flange ring (`150 mm` outer diameter, `52 mm` inner bore, `16 mm` thick from `Y = 3 mm` to `Y = 19 mm`) perforated by 8 evenly spaced bolt clearance holes (`16 mm` hole diameter on a `120 mm` bolt circle diameter).
   - Material: brushed 316L stainless steel.

3. **Tapered Conical Weld-Neck Hub & Beveled Pipe Stub (`tapered_weld_neck_hub` and `beveled_weld_lip`):**
   - A hollow tapered weld-neck cone rising from the top of the flange ring (`Y = 19 mm` to `Y = 55 mm`), tapering smoothly from `78 mm` outer diameter at the base down to `60 mm` pipe outer diameter at the top while maintaining the `52 mm` internal flow bore, topped with a 37.5-degree weld-prep bevel ring.

Expose `flangeOuterDia`, `boreDiameter`, `boltCircleDia`, `boltHoleCount`, and `neckHeight` as adjustable parameters.
