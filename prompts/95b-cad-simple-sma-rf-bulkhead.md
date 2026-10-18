---
id: cad-simple-sma-rf-bulkhead
title: Flanged SMA RF Coaxial Bulkhead Jack
category: cad3d
vertical: electronics
subcategory: simple
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a 3D CAD model of a **gold-plated brass SMA female 4-hole panel-mount RF coaxial connector** (DC to 18 GHz microwave bulkhead jack):

### Required Features & Dimensions (in millimeters, Y-axis up)
1. **Square 4-Hole Mounting Flange (`mounting_flange`)**:
   - **12.7 mm × 12.7 mm** square flange (**2.0 mm** thick at the base, rounded corners) with four **2.6 mm** corner mounting through-holes on an **8.6 mm × 8.6 mm** square bolt pattern.
2. **Threaded SMA Barrel (`sma_threaded_barrel`)**:
   - Cylindrical RF barrel (**6.35 mm** / 1/4-36 UNS outer diameter, **9.5 mm** tall above the flange) with external coupling threads and an opposing pair of D-flat wrench flats at the base.
3. **PTFE Dielectric Insulator & Center Contact Pin (`center_conductor`)**:
   - Recessed white PTFE dielectric sleeve (**4.1 mm** outer diameter) inside the barrel and a gold-plated beryllium-copper female center socket pin (**1.27 mm** diameter) extending down into a rear solder cup post.

### Adjustable Dimensions
Include sliders for **flange width** (default `12.7 mm`), **barrel height** (default `9.5 mm`), **barrel outer diameter** (default `6.35 mm`), and **mounting hole diameter** (default `2.6 mm`).
