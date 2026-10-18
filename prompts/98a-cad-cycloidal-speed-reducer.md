---
id: cad-cycloidal-speed-reducer
title: Eccentric Cycloidal Robot Joint Reducer
category: cad3d
vertical: robotics
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **zero-backlash cycloidal robot actuator speed reducer** with an open-top inspection view showing the ring pin housing, eccentric input shaft, cycloidal lobe disc, and output roller pins:

### Required Components & Dimensions (in millimeters, Y-axis up)
1. **Outer Ring Gear Housing & Stationary Rollers (`ring_pin_housing`)**:
   - Cylindrical anodized aluminum stator casing (**128 mm** outer diameter, **104 mm** inner cavity diameter, **28 mm** height from `Y = 0` to `Y = 28 mm`) with **8 outer mounting bolt holes** (`6.5 mm` diameter on a `116 mm` bolt circle) and a circular ring of **12 stationary steel ring pins** (**8.0 mm** diameter, **24 mm** height) seated around the inner periphery on a **96 mm** pitch circle.
2. **Cycloidal Lobe Disc (`cycloidal_disc`)**:
   - Eccentrically offset hardened steel cycloidal cam disc (**86 mm** outer pitch diameter, **12 mm** thick from `Y = 8 mm` to `Y = 20 mm`, offset by **3.0 mm** along +X) featuring **11 external teeth/lobes**, a **32 mm** central eccentric bearing bore, and a circular pattern of **6 output roller through-holes** (**14.0 mm** diameter on a **54 mm** pitch circle).
3. **Input Eccentric Cam Shaft (`eccentric_input_shaft`)**:
   - Central **20 mm** diameter input motor shaft rising from `Y = 0` to `Y = 44 mm` with an integrated **32 mm** eccentric bearing cam lobe at `Y = 8 mm` to `Y = 20 mm`.
4. **Output Pin Carrier Flange (`output_pin_carrier`)**:
   - Upper output flange ring (**76 mm** outer diameter, **36 mm** inner bore, **6 mm** thick at `Y = 24 mm`) carrying **6 hardened drive pins** (**8.0 mm** diameter) that project downward through the 6 holes in the cycloidal disc.

### Adjustable Dimensions
Include sliders for **housing outer diameter** (default `128 mm`), **ring pin count** (default `12`), **eccentricity offset** (default `3.0 mm`), and **output pin count** (default `6`).
