---
id: hanoi-python
title: Towers of Hanoi solver (Python program)
category: coding
language: python
functionName: solution
executable: true
visualizer: hanoi
---
Write a complete, runnable Python 3 program that solves the Towers of Hanoi puzzle for any number of disks.

Requirements:
- Define a function with EXACTLY this signature: `hanoi(n, source="A", target="C", auxiliary="B")`. It must move `n` disks from the `source` peg to the `target` peg using `auxiliary` as the spare peg, via the classic recursive algorithm, obeying the rules (move one disk at a time; never place a larger disk on a smaller one). Do not rename the function or change the parameter names, order, or defaults.
- For each move, print one line in EXACTLY this format: `Move disk {k} from {source} to {target}` where `k` is the disk number (1 = smallest) and `{source}`/`{target}` are the peg labels for that move.
- Count the moves and, after solving, print a final line in EXACTLY this format: `Total moves: {count}`. The count must equal 2**n − 1.
- Include a `main()` function and an `if __name__ == "__main__":` guard that solves the puzzle for n = 8 by default (255 moves).
- Single self-contained file. Use only the Python standard library — no third-party packages. Any explanation must be written as Python comments inside the code.

Worked example (n = 2, default pegs A/B/C):
Move disk 1 from A to B
Move disk 2 from A to C
Move disk 1 from B to C
Total moves: 3

Output ONLY the solution as a single fenced ```python code block. No prose, explanation, preamble, or postscript — nothing before or after the single code block. Any necessary explanation must be a code comment.
