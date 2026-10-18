---
id: cad-simple-cortical-bone-screw
title: Titanium Cortical Bone Screw
category: cad3d
vertical: medical
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of an **implant-grade Ti-6Al-4V titanium cortical bone screw** used in orthopedic trauma fixationPlates:

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Low-Profile Spherical Head (`screw_head`)**:
   - **8.0 mm** outer diameter and **3.5 mm** height at the top of the screw (`Y = 28 mm` to `Y = 31.5 mm`), with a smooth spherical underside that seats into a dynamic compression bone plate and a **2.5 mm** deep star/hexalobe drive socket recessed into the top face.
2. **Smooth Cortical Neck & Threaded Shaft (`threaded_shank`)**:
   - **4.5 mm** core shaft extending from `Y = 0` to `Y = 28 mm`, wrapped with helical or stacked buttress bone-thread rings (**6.5 mm** major diameter, **2.2 mm** pitch) along the shaft.
3. **Self-Tapping Cutting Flutes (`cutting_tip`)**:
   - Tapered conical tip at the bottom (`Y = 0` to `Y = 5 mm`) with three longitudinal self-tapping bone-cutting flutes milled at **120°** intervals and a **1.6 mm** cannulated guide-wire central through-bore running the full length of the screw.

### Adjustable Dimensions
Include sliders for **major thread diameter** (default `6.5 mm`), **overall screw length** (default `30 mm`), **thread pitch** (default `2.2 mm`), and **cannulated bore diameter** (default `1.6 mm`).
