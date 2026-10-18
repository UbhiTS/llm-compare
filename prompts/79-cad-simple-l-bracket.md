---
id: cad-simple-l-bracket
title: Gusseted 90° Structural Mounting L-Bracket
category: cad3d
vertical: industrial
subcategory: simple
language: javascript
visualizer: cad3d
executable: true
---
Design a parametric 3D mechanical model of a **Heavy-Duty 90-Degree Gusseted CNC / Fabricated Mounting L-Bracket** in millimeters (`Y`-up coordinate system, `Y = 0` ground plane):

1. **Horizontal Slotted Base Plate (`horizontal_base_plate`):**
   - A flat rectangular mounting foot (`90 mm` wide in X by `80 mm` deep in Z by `10 mm` thick in Y) resting on `Y = 0`, with filleted outer corners and 4 bolt clearance holes (`8.5 mm` diameter) near the front and rear corners.
   - Material: blue or dark-grey anodized 6061-T6 aluminum.

2. **Vertical Upright Spindle Faceplate (`vertical_upright_plate`):**
   - A perpendicular vertical wall (`90 mm` wide in X by `75 mm` tall in Y by `10 mm` thick in Z) rising along the rear edge of the base plate from `Y = 10 mm` to `Y = 85 mm`.
   - Machine a large central circular pilot bore (`34 mm` diameter) with a raised steel reinforcement boss ring around the bore and 4 surrounding M6 tapped mounting holes.

3. **Twin Triangular Side Stiffener Gussets (`left_rib_gusset` and `right_rib_gusset`):**
   - Two solid right-triangle structural gusset ribs (`8 mm` thick) connecting the horizontal base plate to the vertical upright faceplate along the left and right outer edges to prevent bending under cantilevered load.

Expose `bracketWidth`, `baseDepth`, `uprightHeight`, `plateThickness`, and `pilotBoreDiameter` as adjustable parameters.
