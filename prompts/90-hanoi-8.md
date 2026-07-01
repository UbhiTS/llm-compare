---
id: hanoi-8
title: Towers of Hanoi — enumerate all 255 moves (8 disks)
category: general
language: null
functionName: solution
executable: false
---
Act as an expert in logic and algorithms. Solve the classic "Towers of Hanoi" puzzle for 8 disks and enumerate every move as text (this is an output-fidelity / long-context test, not a coding task).

The Setup:
- There are 3 pegs: Peg A (Source), Peg B (Auxiliary), and Peg C (Target).
- There are 8 disks numbered 1 (smallest) to 8 (largest).
- At the start, all 8 disks are stacked on Peg A in order of size: Disk 8 on the bottom, Disk 1 on top.

The Rules:
1. Move only one disk at a time.
2. Move only the uppermost disk from a peg.
3. Never place a larger disk on top of a smaller disk.

Output requirements: move all 8 disks from Peg A to Peg C in the minimum number of moves (exactly 255). Show your work strictly step-by-step. For each step provide:
- Move [Number]: the exact action (e.g., "Move Disk 1 from Peg A to Peg C").
- State: a clear text representation of which disks are on each peg after the move, listed bottom to top (e.g., "Peg A: [8, 7, 6, 5, 4]").

Crucial: output every single one of the 255 moves. Do not summarize, skip steps, or use placeholders like "... [Moves 100-200] ...". Do not stop until Move 255 with all disks on Peg C. If you hit your output token limit, stop cleanly at a completed move so you can be asked to continue.
