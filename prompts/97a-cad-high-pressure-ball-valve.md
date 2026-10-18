---
id: cad-high-pressure-ball-valve
title: Flanged 3-Piece Stainless Ball Valve
category: cad3d
vertical: industrial
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **3-piece bolted stainless steel industrial quarter-turn ball valve** with raised-face pipe flanges, exposed internal floating ball bore, tie-rod bolts, and a locking lever handle:

### Required Components & Dimensions (in millimeters, Y-axis up)
1. **Center Valve Body & PTFE Seat Rings (`valve_body`)**:
   - Cylindrical/octagonal center housing (**86 mm** outer diameter, **56 mm** axial length along X) centered on the horizontal flow axis (`Y = 55 mm`), with a raised top ISO 5211 actuator mounting pad at `Y = 102 mm`.
2. **Inlet & Outlet Bolted End Caps & Pipe Flanges (`end_flanges`)**:
   - Left and right flanged end caps (**110 mm** flange outer diameter, **50 mm** internal flow bore) clamped across the center body by **4 horizontal tie-rod stud bolts and hex nuts** (`tie_bolts`), each end flange having **4 outer pipeline bolt holes** (`14 mm` diameter on an `85 mm` bolt circle).
3. **Internal Polished Quarter-Turn Ball (`floating_ball`)**:
   - Polished **68 mm** diameter stainless steel sphere seated inside the valve cavity with a **50 mm** straight-through flow bore and a top drive-stem slot.
4. **Valve Stem, Packing Gland & Quarter-Turn Lever Handle (`lever_handle`)**:
   - Vertical **16 mm** stem rising through the top packing gland (`Y = 98 mm` to `Y = 122 mm`) attached to a **135 mm** long cranked steel lever arm with an insulated vinyl grip sleeve and lockout tab.

### Adjustable Dimensions
Include sliders for **nominal flow bore** (default `50 mm`), **flange outer diameter** (default `110 mm`), **handle angle** (default `0°` open to `90°` closed), and **handle length** (default `135 mm`).
