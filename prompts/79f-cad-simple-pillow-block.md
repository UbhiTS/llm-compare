---
id: cad-simple-pillow-block
title: Cast-Iron Pillow Block Bearing Housing
category: cad3d
vertical: robotics
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Mounted Cast-Iron Pillow Block Shaft Bearing Housing** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Bolted Base Mounting Foot (`pillow_base_foot`):**
   - A heavy elongated rectangular base foot (`140 mm` wide in X by `44 mm` deep in Z by `14 mm` tall in Y) resting flat on `Y = 0` with rounded ends and two vertical bolt-down clearance holes (`12 mm` diameter) near the left and right mounting ears (`X = ±52 mm`).
   - Material: painted industrial blue or dark cast iron.

2. **Upright Pedestal Web & Cylindrical Bearing Housing Ring (`pedestal_housing_ring`):**
   - A central upright support web rising from the base foot to carry a horizontal cylindrical bearing housing ring (`68 mm` outer diameter, `44 mm` inner bore, `42 mm` axial length along Z) whose shaft centerline sits at `Y = 46 mm` above the base plane.

3. **Spherical Bronze Bearing Insert & Top Grease Zerk Fitting (`bronze_bearing_insert` and `grease_zerk_fitting`):**
   - Inside the cast-iron housing bore, fit a machined phosphor-bronze inner bearing sleeve (`44 mm` outer diameter, `28 mm` shaft bore, `48 mm` axial length protruding slightly on both Z faces), and mount a vertical brass hexagon grease zerk lubrication nipple at the top crown (`Y = 80 mm`).

Expose `baseWidth`, `baseThickness`, `shaftCenterHeight`, `housingOuterDia`, and `shaftBoreDia` as adjustable parameters.
