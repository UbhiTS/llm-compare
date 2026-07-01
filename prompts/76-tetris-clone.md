---
id: tetris-clone
title: Tetris clone (Pygame, polished art + self-play AI)
category: games
language: python
functionName: solution
executable: true
gui: true
---
Act as an expert game developer specializing in arcade puzzle games. Write the complete code for a Tetris clone that faithfully recreates the mechanics and feel of the classic falling-block game, and that starts in an automatic DEMO / ATTRACT mode where the game plays itself.

Use Python 3 and the Pygame library (Pygame 2.x). Deliver it as a single, self-contained, runnable file. The code must be strictly object-oriented, with classes for the tetromino piece, the board/well, and the game.

Core requirements and mechanics:

1. Visuals and Architecture
- Resolution: a clean ~640x760 window — a 10x20 well of ~30px cells on the left plus a side panel for the HUD. Aim for a HIGH-RESOLUTION, polished look, NOT flat chunky squares.
- ART DIRECTION (make it look polished, NOT blocky - this matters): draw every cell as a small COMPOSITION, never a single flat rectangle — a rounded-rect body (pygame.draw.rect with border_radius) with a lighter top-left highlight bevel, a darker bottom-right shade, and a subtle inner sheen. Use smooth shapes via pygame.draw (rect, polygon, circle, aaline) — do NOT use pygame.gfxdraw: it is unavailable in the browser (pygbag) and its calls silently draw nothing there, leaving blank/missing art. For extra-smooth art, draw onto a 2-3x `pygame.Surface((w,h), pygame.SRCALPHA)` and `pygame.transform.smoothscale` it down. Give the well a dark, softly-lit background with a faint grid; add a subtle glow to the active piece and a flash when lines clear.
- The seven tetrominoes use their classic colors: I cyan, O yellow, T purple, S green, Z red, J blue, L orange.
- Board: a 10-wide x 20-tall grid stored as a 2D array of cells (empty or a color). Pieces spawn at the top center.
- HUD side panel: Score, Level, Lines cleared, and a NEXT-piece preview drawn with the same block art. A HOLD slot is a nice touch (optional).

2. Gameplay and rules (crucial - get these exactly right)
- The seven tetrominoes (I, O, T, S, Z, J, L) with correct shapes and rotation. Implement rotation with basic wall kicks so a rotation near a wall or the floor nudges into a legal spot instead of silently failing.
- Gravity: the active piece falls one row every "gravity interval"; the interval shortens as the level rises (a speed curve). A piece LOCKS when it can no longer move down (use a short lock delay), then the next piece spawns.
- Line clears: detect full rows, clear them, and shift the rows above down. Score 100 / 300 / 500 / 800 x level for clearing 1 / 2 / 3 / 4 lines (a 4-line "Tetris" is worth the most). Every 10 lines cleared raises the level and the speed.
- Collision and bounds are ABSOLUTE: a piece may NEVER overlap a filled cell or leave the 10x20 grid — validate every move, rotation, and drop against the board BEFORE applying it (revert if illegal). Locked cells never move except when full rows collapse. No piece may tunnel through the floor or stack.
- Controls (player mode): Left / Right move; Down = soft drop; Up or X = rotate clockwise (Z = counter-clockwise); Space = hard drop (instant lock); optionally C = hold. Support held-key auto-repeat (DAS) for Left/Right/Down.
- Ghost piece: show a faint outline where the current piece would land if hard-dropped.
- Game over when a newly spawned piece immediately collides; show a brief GAME OVER, then return to demo mode.

3. Demo / Attract mode (auto-play) - IMPORTANT
- On launch the game MUST start in DEMO mode: it plays ITSELF with NO human input, and plays WELL. Use a rule-based heuristic (no machine learning): for the current piece, evaluate every reachable (rotation, column) landing by simulating the drop, then score the resulting board with a weighted sum of features — aggregate column height, number of holes, bumpiness, and lines cleared (a Dellacherie / "El-Tetris"-style heuristic) — and steer the piece to the best-scoring placement, then hard-drop it. It should clear many lines and survive a long time, reading as a skilled player, not random drops.
- Show a blinking overlay while in demo mode, e.g. "DEMO - PRESS ENTER TO PLAY".
- When the player presses Start (Enter / Return), leave demo mode and hand full control to the human. On game over while in player mode, returning to demo mode is fine. The SAME rules, scoring, and speed curve apply in both modes.

4. Assets and Game Loop
- All art is drawn PROCEDURALLY (no external image files) - detailed per the ART DIRECTION above (bevelled, shaded blocks; glowing well; clean HUD). Keep each drawing routine in its own method so it stays readable.
- Include a simple reset function that clears the board and state on game over.

5. Browser/async game loop - MANDATORY for pygbag/WebAssembly (getting this wrong is the #1 cause of a BLACK SCREEN or a FROZEN tab - follow it EXACTLY):
- ONE coroutine, ONE loop: `import asyncio` at the top; the ENTIRE game runs inside `async def main():` with a SINGLE game loop; launch via `asyncio.run(main())` under `if __name__ == "__main__":`. Nothing else may drive the loop.
- STATE MACHINE, no nested/blocking sub-loops: title, DEMO/attract, playing, paused, line-clear animation, and game-over are STATES checked inside the ONE loop - never separate `while` loops. A second loop that doesn't yield freezes the tab on a black canvas. Need a "wait"? Use a timer variable or `pygame.time.get_ticks()` deltas and check it each frame.
- YIELD EVERY FRAME: the LAST statement of every loop iteration MUST be `await asyncio.sleep(0)`. No branch (a `continue`, a state screen, game-over) may skip it - skipping it hard-freezes the browser. This is mandatory, not optional.
- DRAW + FLIP EVERY FRAME: every iteration must draw the current state and then call `pygame.display.flip()` (or `update()`); never `continue` past the draw/flip. Paint one visible frame BEFORE any heavy setup so the canvas is never black at startup.
- NO BLOCKING CALLS anywhere (they freeze WASM): never `time.sleep()`, `pygame.time.wait()`, `pygame.time.delay()`, `input()`, `sys.exit()`, `exit()`, `quit()`, `os._exit()`, and never a `while` that spins waiting for a key/event. To stop, break the single loop; for timed effects use frame counters or tick deltas. Do NOT read/write files or access the network - draw everything procedurally with shapes.
- CORRECT INIT ORDER (a wrong order raises and blanks the canvas): call `pygame.init()` then `screen = pygame.display.set_mode((W, H))` FIRST; only AFTER that create Surfaces or call `.convert()`/`.convert_alpha()` (converting a Surface before `set_mode()` raises `pygame.error`). Build all block/HUD surfaces once, before the loop.
- BOUNDED PER-FRAME WORK (prevents "runs for a moment, then freezes"): the demo AI's placement search must run ONCE when a new piece spawns (cache the chosen target), then just execute moves toward it each frame — do NOT re-run the full placement search every frame.
- FRAME CAP: create `clock = pygame.time.Clock()` and call `clock.tick(60)` once per iteration (it does NOT block in pygbag) to hold ~60 FPS.
- DEFENSIVE FRAME (so one bad frame never leaves a black/frozen screen): wrap the per-frame update+draw body in `try/except`; on error, print the traceback (it appears in the pygbag console) and STILL call `pygame.display.flip()` + `await asyncio.sleep(0)` so the loop survives. Never let an exception escape the loop.

6. CORRECTNESS - the program MUST run with no crashes. Target runtime: Python 3.13 with Pygame 2.6.1 (SDL 2.28.4) on a desktop AND in the browser via pygbag - use ONLY functions and attributes that exist in Pygame 2.6.1; never invent or guess a name (for instance pygame.event.get_events() and pygame.Rect.padded() have NEVER existed - the real calls are pygame.event.get() and Rect.inflate()). Below is the EXACT, correct API for everything this game needs - use these names verbatim and do not use any pygame.* call that is not a documented Pygame 2.x API:
   - Init / display: pygame.init(); screen = pygame.display.set_mode((w, h)); pygame.display.set_caption(str); pygame.display.flip() (or pygame.display.update()).
   - Events: the event queue is read with pygame.event.get() -> list of events. There is NO pygame.event.get_events(). Loop `for event in pygame.event.get():` then check `event.type` (pygame.QUIT, pygame.KEYDOWN, pygame.KEYUP) and `event.key` (pygame.K_RETURN, pygame.K_LEFT, pygame.K_RIGHT, pygame.K_UP, pygame.K_DOWN, pygame.K_SPACE, pygame.K_z, pygame.K_x, pygame.K_c, ...).
   - Held keys: keys = pygame.key.get_pressed(); then index it like keys[pygame.K_LEFT].
   - Drawing: pygame.draw.rect(surface, color, rect[, width][, border_radius=N]) (border_radius rounds the corners); pygame.draw.line(...) and pygame.draw.aaline(surface, color, start, end) (anti-aliased); pygame.draw.polygon(surface, color, points); pygame.draw.circle(surface, color, center, radius[, width]).
   - Smooth/anti-aliased shapes WITHOUT gfxdraw: `pygame.gfxdraw` is NOT available in the browser (pygbag) - do NOT import or use it (its calls silently draw nothing there). Use the pygame.draw.* calls above; for extra-smooth blocks draw onto a 2-3x pygame.Surface((w, h), pygame.SRCALPHA) then pygame.transform.smoothscale(surf, (w, h)) it down.
   - Surfaces: s = pygame.Surface((w, h)) - or pygame.Surface((w, h), pygame.SRCALPHA) for transparency (soft glows / the ghost piece); s.fill(color); s.blit(src, (x, y)); s.set_alpha(0-255); s.get_rect(); s.convert() / s.convert_alpha() (only AFTER set_mode()).
   - Scaling: pygame.transform.scale(surface, (w, h)); pygame.transform.smoothscale(surface, (w, h)) for a SMOOTH (non-blocky) scale.
   - Fonts: pygame.font.init(); f = pygame.font.SysFont(name, size, bold=False) OR pygame.font.Font(None, size); txt = f.render(text, True, color); txt.get_rect(center=(x, y)).
   - Clock / time: clock = pygame.time.Clock(); clock.tick(60); pygame.time.get_ticks().
   - pygame.Rect attributes/methods that EXIST: x, y, width, height, left, right, top, bottom, centerx, centery, center, topleft, topright, bottomleft, bottomright; .move(dx, dy), .move_ip(dx, dy), .inflate(dx, dy), .copy(), .colliderect(other), .collidepoint(point). pygame.Rect does NOT have a .padded() method - for an inset/outset use rect.inflate(dx, dy).
   Before writing any pygame.* call, confirm it is in the list above or is a real Pygame 2.x API. If unsure whether a method exists, use a simpler call that you are certain exists.

The file must run directly: include an `if __name__ == "__main__":` guard that calls `asyncio.run(main())`. Use no third-party libraries other than Pygame (plus the standard-library `asyncio`, and `random`/`collections` if helpful). All commentary must live inside the code as comments.

Output ONLY the solution as a single fenced ```python code block. No prose, explanation, comments outside the code, preamble, or postscript - nothing before or after the single code block. Any necessary explanation must be a code comment inside that block.
