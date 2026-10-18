---
id: cad-simple-flanged-bushing
title: Flanged Oil-Groove Bronze Sleeve Bushing
category: cad3d
vertical: robotics
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Lathe-Turned Flanged Phosphor-Bronze Sleeve Bearing Bushing** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Lower Thrust Flange Collar (`thrust_flange_collar`):**
   - A circular thrust flange resting on `Y = 0` with an outer diameter of `68 mm`, an inner shaft bore diameter of `32 mm`, and a flange thickness of `8 mm`.
   - Include 4 counterbored axial mounting holes (`5.5 mm` diameter on a `56 mm` bolt circle) so the flange can be secured against a housing face.
   - Material: machined SAE 660 phosphor bronze / brass.

2. **Precision Cylindrical Bearing Barrel (`bushing_sleeve_barrel`):**
   - A concentric cylindrical sleeve rising from `Y = 8 mm` to `Y = 58 mm` with a `46 mm` outer diameter and `32 mm` inner shaft bore (`7 mm` wall thickness).
   - Material: machined bronze / brass.

3. **External Annular Oil-Distribution Groove & Feed Holes (`annular_oil_collar`):**
   - At mid-height on the outer barrel (`Y = 30 mm`), machine a recessed external oil distribution band with 4 radial oil-feed cross-ports and a chamfered top lead-in lip at `Y = 58 mm` for easy shaft insertion.

Expose `boreDiameter`, `barrelOuterDiameter`, `flangeDiameter`, `flangeThickness`, and `totalHeight` as adjustable parameters.
