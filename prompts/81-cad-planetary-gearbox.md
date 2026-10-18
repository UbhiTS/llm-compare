---
id: cad-planetary-gearbox
title: Epicyclic Planetary Gearbox Assembly
category: cad3d
vertical: automotive
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design a complete Epicyclic Planetary Gearbox Assembly in millimeters resting flat on the build plate:

1. **Gear Meshing & Ratio Requirements**:
   - All gears must use module 2.0 mm and a 20-degree pressure angle, satisfying the planetary meshing law where the ring gear tooth count equals the sun gear tooth count plus twice the planet gear tooth count:
     - Center sun gear: 18 teeth (36 mm pitch diameter)
     - Three planet gears: 15 teeth each (30 mm pitch diameter)
     - Outer internal ring gear: 48 teeth (96 mm pitch diameter)
   - Space the three planet gears evenly at 120-degree intervals on a 33 mm carrier orbit radius so their teeth mesh cleanly between the sun gear and the outer ring gear without interference.

2. **Mechanical Components & Materials**:
   - **Outer Ring Gear Housing**: 16 mm face width, 9 mm radial wall thickness, with 4 external bolting ears around the perimeter and M5 mounting through-holes. Material: Ti-6Al-4V titanium.
   - **Center Sun Gear & Input Shaft**: 16 mm face width with a 10 mm central bore and a raised central hub collar. Material: C360 machined brass.
   - **Three Planet Gears & Dowel Pins**: 16 mm face width with an 8 mm central bearing bore seated on hardened steel carrier pins. Material: blue anodized 6061-T6 aluminum gears on brushed stainless steel pins.
   - **Upper Planet Carrier Spider**: A 3-arm structural bridge plate mounted above the planet gears connecting all three planet pins to a central output shaft collar. Material: brushed 304 stainless steel.

Make key dimensions adjustable via live sliders (module, sun teeth, planet teeth, ring teeth, planet count, and gear face width).
