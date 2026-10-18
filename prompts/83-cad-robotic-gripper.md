---
id: cad-robotic-gripper
title: Articulated 2-Finger Parallel Robot Gripper
category: cad3d
vertical: robotics
subcategory: complex
language: javascript
functionName: buildModel
executable: true
visualizer: cad3d
---
Design an industrial 2-Finger Parallel Robot End-Effector Gripper assembly in millimeters mounted on an ISO-9409-1 robot wrist adapter flange:

1. **ISO-9409-1 Robot Wrist Mounting Flange**:
   - 63 mm outer diameter, 10 mm thick circular adapter base sitting flat on the ground plane, with a 6-bolt M6 counterbored mounting circle and an 18 mm central cable pass-through bore.
   - Material: Ti-6Al-4V titanium or dark anodized aluminum.

2. **Actuator Palm Chassis**:
   - 76 mm wide by 42 mm deep by 48 mm tall machined actuator block bolted above the wrist flange, featuring twin clevis pivot ears on both the left and right sides and an internal dual-pinion drive gear pair visible through a front inspection pocket.
   - Material: brushed stainless steel and matte carbon-fiber reinforced housing.

3. **Symmetric Parallel Linkage & Gripper Jaws**:
   - Left and right parallel-motion linkage arms (52 mm link length) pivoting on stainless steel dowel pins so both fingers remain strictly parallel throughout the jaw stroke.
   - Two L-shaped machined aluminum gripper fingers (62 mm tall, 22 mm deep) with serrated elastomer inner contact pads facing each other across the center grip axis.
   - Material: blue anodized 6061-T6 aluminum fingers with dark high-friction silicone grip pads.

Make key dimensions adjustable via live sliders (jaw opening stroke, finger length, palm width, and palm height).
