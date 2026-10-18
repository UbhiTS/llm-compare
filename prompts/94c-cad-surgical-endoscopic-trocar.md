---
id: cad-surgical-endoscopic-trocar
title: Laparoscopic Surgical Trocar & Valve Assembly
category: cad3d
vertical: medical
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **12 mm laparoscopic surgical trocar assembly** consisting of a ribbed cannula sleeve, ergonomic valve housing, CO2 insufflation stopcock port, and removable pyramidal-tip obturator:

### Required Components & Dimensions (in millimeters, Y-axis up)
1. **Ribbed Cannula Sleeve (`cannula_tube`)**:
   - Thin-walled stainless steel or medical polymer tube (**15.0 mm** outer diameter, **12.5 mm** inner instrument bore, **95 mm** length from `Y = 0` to `Y = 95 mm`) with an angled distal bevel tip and concentric Abdominal-wall retention ridges along the mid-shaft.
2. **Ergonomic Seal Housing (`seal_housing`)**:
   - Upper flared bell housing (`Y = 95 mm` to `Y = 128 mm`, **44 mm** outer diameter) with recessed finger-grip scallops on both sides and a silicone duckbill instrument seal cap at the top.
3. **CO2 Insufflation Side Port & Stopcock (`insufflation_valve`)**:
   - Radial Luer-lock gas port extending **24 mm** from the side of the seal housing at `Y = 108 mm`, topped with a rotatable quarter-turn wing stopcock handle (`stopcock_lever`).
4. **Removable Obturator & Pyramidal Tip (`obturator_rod`)**:
   - Central **12.0 mm** obturator shaft passing through the cannula with a domed palm cap (`Y = 128 mm` to `Y = 145 mm`) at the top and a 3-faceted pyramidal dilating tip protruding slightly below `Y = 0`.

### Adjustable Dimensions
Include sliders for **instrument bore diameter** (default `12.5 mm`), **cannula length** (default `95 mm`), **seal housing diameter** (default `44 mm`), and **obturator insertion offset** (default `0 mm`).
