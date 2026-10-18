---
id: cad-simple-pulley-sheave
title: Cast-Iron V-Belt Pulley Sheave
category: cad3d
vertical: automotive
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Single-Groove Cast-Iron V-Belt Pulley Wheel (Sheave)** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Outer V-Groove Rim (`vbelt_pulley_rim`):**
   - A circular pulley wheel (`120 mm` outer diameter, `28 mm` total height along Y) with a deep 38-degree V-shaped belt groove machined around its outer circumference (`top and bottom rim flanges` framing a recessed V-belt root diameter of `96 mm`).
   - Material: dark grey cast iron or brushed steel.

2. **Recessed Web with Circular Lightening Holes (`recessed_pulley_web`):**
   - Between the outer V-belt rim and the central shaft hub, machine a recessed 10 mm thick central web disc perforated by 6 evenly spaced circular weight-reduction holes (`14 mm` diameter on a `66 mm` pitch circle).
   - Material: anodized aluminum or machined steel.

3. **Central Keyed Drive Hub & Locking Set-Screw Collar (`central_drive_hub` and `set_screw_boss`):**
   - A raised central cylindrical hub (`44 mm` outer diameter, `28 mm` tall) with a `20 mm` center shaft bore and a brass set-screw locking collar ring on top.

Expose `outerDiameter`, `rimThickness`, `boreDiameter`, `hubDiameter`, and `lighteningHoles` as adjustable parameters.
