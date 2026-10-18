---
id: cad-enclosure-snapfit
title: Snap-Fit IoT Edge Compute Enclosure
category: cad3d
vertical: electronics
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a manufacturable 3-part IoT Edge AI Compute Enclosure assembly in millimeters resting flat on the build plate:

1. **Lower Enclosure Housing Tub**:
   - Outer footprint 120 mm long by 84 mm wide by 36 mm tall, with 3.0 mm uniform wall and floor thickness and 8 mm filleted vertical corners.
   - Four internal cylindrical PCB mounting standoffs (9 mm outer diameter, M3 threaded bore, 8 mm height) rising from the interior floor inset 12 mm from each corner.
   - Front wall rectangular I/O port cutouts for USB-C and RJ45 Ethernet connectors, plus two external side mounting flanges with M4 through-holes.
   - Material: dark slate anodized 6061-T6 aluminum.

2. **Internal Edge AI Carrier PCB & Finned Heatsink**:
   - A 104 mm by 68 mm by 1.8 mm circuit board seated on top of the four internal standoffs with matching corner mounting holes.
   - A multi-fin copper-base NPU heatsink mounted at the center of the board to dissipate thermal load.
   - Material: matte emerald FR-4 PCB with a machined copper/aluminum finned heatsink.

3. **Ventilated Snap-Fit Top Cover (Exploded Inspection View)**:
   - Positioned 20 mm above the lower tub rim in an exploded inspection view so the internal PCB and standoffs remain clearly visible.
   - Includes a 2.5 mm stepped perimeter alignment lip, 4 cantilever snap-fit retention clips along the long edges, and parallel ventilation louver slots across the top face.
   - Material: semi-translucent frosted polycarbonate.

Make key dimensions adjustable via live sliders (length, width, base height, wall thickness, corner radius, and lid explode offset).
