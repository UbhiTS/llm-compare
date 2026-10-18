---
id: cad-simple-luer-lock-adapter
title: Luer-Lock Syringe Hub & Barbed Adapter
category: cad3d
vertical: medical
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **one-piece precision-machined medical female Luer-Lock to barbed IV tubing adapter** (ISO 80369-7 compliant geometry):

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Female Luer-Lock Threaded Collar (`luer_hub`)**:
   - Bottom cylindrical hub (`Y = 0` to `Y = 10 mm`) with **7.8 mm** outer diameter, twin external Luer-lock thread lugs at the base (`9.2 mm` lug span), and a smooth **4.3 mm** internal conical Luer taper bore.
2. **Hexagonal Grip & Finger Flange (`hex_grip_flange`)**:
   - Central **6-flat hexagonal wrench/finger collar** (`12.0 mm` across flats, **4.0 mm** tall from `Y = 10 mm` to `Y = 14 mm`) separating the Luer hub from the tubing barb.
3. **Multi-Ridge Hose Barb (`tubing_barb`)**:
   - Upper barbed stem (`Y = 14 mm` to `Y = 30 mm`) with **4.8 mm** stem diameter and three tapered retention ridges (**6.2 mm** barb crest diameter) that grip flexible silicone medical tubing, plus a continuous **2.8 mm** central fluid lumen through the entire fitting.

### Adjustable Dimensions
Include sliders for **barb outer diameter** (default `6.2 mm`), **fluid lumen diameter** (default `2.8 mm`), **number of barb ridges** (default `3`), and **hex collar width** (default `12 mm`).
