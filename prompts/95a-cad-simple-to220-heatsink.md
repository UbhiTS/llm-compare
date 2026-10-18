---
id: cad-simple-to220-heatsink
title: Extruded Aluminum Finned Power Heatsink
category: cad3d
vertical: electronics
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of an **anodized extruded 6063-T5 aluminum board-level heatsink** for cooling a TO-220 power transistor or voltage regulator:

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Thermal Baseplate & TO-220 Mounting Tab (`heatsink_base`)**:
   - Vertical backplate (**38 mm** wide along X, **5.0 mm** thick along Z, **42 mm** tall along Y from `Y = 0` to `Y = 42 mm`) with a centered **3.2 mm** through-hole at `Y = 28 mm` for the TO-220 M3 mounting screw and two **2.5 mm** solderable PCB mounting pins protruding from the bottom face.
2. **Cooling Fin Array (`cooling_fins`)**:
   - **9 parallel vertical cooling fins** (**2.0 mm** thick, **22 mm** deep along Z, **42 mm** tall) spaced evenly across the **38 mm** width, with the two outer fins featuring inward thermal-clip retention grooves.

### Adjustable Dimensions
Include sliders for **heatsink width** (default `38 mm`), **heatsink height** (default `42 mm`), **fin depth** (default `22 mm`), and **number of fins** (default `9`).
