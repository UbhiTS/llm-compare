---
id: cad-simple-pitot-static-probe
title: L-Shaped Pitot-Static Airspeed Probe
category: cad3d
vertical: aerospace
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of an **aerospace L-shaped heated pitot-static airspeed probe** mounted to an aircraft fuselage skin flange:

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Aerodynamic Fuselage Mounting Flange (`fuselage_flange`)**:
   - Elliptical or teardrop-shaped base flange (**75 mm** long along X, **42 mm** wide along Z, **6.0 mm** thick) with four countersunk **5.0 mm** fastener holes.
2. **Swept Airfoil Strut (`airfoil_mast`)**:
   - Tapered swept-forward strut rising **60 mm** vertically from the base flange (`Y = 6 mm` to `Y = 66 mm`) with a streamlined cross-section (**32 mm** chord, **10 mm** thickness) that minimizes transonic drag.
3. **Pitot-Static Sensing Tube (`pitot_tube`)**:
   - Horizontal cylindrical sensing tube (**14.0 mm** outer diameter, **110 mm** long along X) supported at the top of the strut (`Y = 66 mm`), featuring a conical dynamic-pressure stagnation nose intake (**4.0 mm** bore), a water-drain hole, and a ring of eight **1.2 mm** static-pressure ports around the aft barrel.

### Adjustable Dimensions
Include sliders for **probe tube length** (default `110 mm`), **strut height** (default `60 mm`), **probe outer diameter** (default `14 mm`), and **stagnation intake bore** (default `4 mm`).
