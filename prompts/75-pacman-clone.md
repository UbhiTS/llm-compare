---
id: pacman-clone
title: Pac-Man clone (Pygame, polished art + ghost AI)
category: games
language: python
functionName: solution
executable: true
gui: true
---
Act as an expert game developer specializing in arcade classics. Write the complete code for a Pac-Man clone that faithfully recreates the mechanics and feel of the original Namco arcade game, and that starts in an automatic DEMO / ATTRACT mode where Pac-Man plays himself.

Use Python 3 and the Pygame library (Pygame 2.x). Deliver it as a single, self-contained, runnable file. The code must be strictly object-oriented, with classes for Pac-Man, the ghosts, the maze, and the pellets.

Core requirements and mechanics:

1. Visuals and Architecture
- Resolution: render at a generous resolution (a tile size of ~24-28px over a 28x31 tile maze, so roughly a 700x800 window including the HUD). Aim for a clean, HIGH-RESOLUTION, polished look - NOT chunky pixels.
- ART DIRECTION (make it look polished, NOT blocky - this matters): draw everything by COMPOSING MULTIPLE shaded shapes with anti-aliasing, never a single flat rectangle. Use pygame.draw.circle / ellipse / polygon / arc and pygame.draw.aaline for smooth shapes — do NOT use pygame.gfxdraw: it is unavailable in the browser (pygbag) and its calls silently draw nothing there. For extra-smooth art, draw onto a 2-3x `pygame.Surface((w,h), pygame.SRCALPHA)` and `pygame.transform.smoothscale` it down. Add soft gradients/shading, rounded corners (border_radius), and glows. Specifically:
  - Maze walls: rounded, glowing blue/indigo "tube" walls with a lighter inner highlight and a darker outer edge (classic neon-maze look), not flat blocks.
  - Pac-Man: a smooth yellow circle with an ANIMATED chomping mouth (a wedge that opens and closes each few frames) that faces his current direction; add a subtle radial shading/glow.
  - Ghosts: the classic shape - a smooth domed top + a wavy/scalloped bottom skirt, with two white eyes whose blue pupils look toward the ghost's movement direction. Colors: Blinky red, Pinky pink, Inky cyan, Clyde orange. In FRIGHTENED mode ghosts turn deep blue with a wavy worried mouth and white eyes, and flash white in the last ~2 seconds before the power-up ends.
  - Pellets: small glowing dots; power pellets are large pulsing/blinking glowing orbs.
- Maze: a tile-based maze laid out from a 2D array (or list of strings). Include the classic features - outer walls, interior wall blocks, a central ghost house, two side TUNNELS that wrap Pac-Man and ghosts from the left edge to the right edge, the dot field, and four power pellets in the corners.
- HUD: show Score, High Score, and remaining Lives (drawn as little Pac-Man icons), and the level number.

2. Movement and Controls (crucial)
- Grid-based movement: Pac-Man and ghosts move along the tile grid at a steady speed, turning only at tile centers. Pac-Man can "buffer" a queued turn so a direction pressed slightly early still registers at the next valid intersection.
- Pac-Man: continuous movement in the last chosen direction until a wall blocks him; he cannot move into walls. He wraps through the side tunnels.
- Wall collision is ABSOLUTE (REQUIRED - this is the #1 bug to avoid: Pac-Man/ghosts sliding OVER or THROUGH walls). No entity may ever enter, overlap, or pass through a wall tile. Enforce it STRUCTURALLY, never by after-the-fact overlap push-back: (a) pick a per-frame step speed in pixels that EVENLY DIVIDES the tile size (e.g. tile size 24 -> speed 2, 3, 4, or 6) so every entity always lands exactly on tile centers and can never overshoot past a wall; (b) an entity may only begin moving in a direction - or turn - when it is centered on a tile AND the NEXT tile in that direction is not a wall; otherwise it keeps its current direction or stops dead at the wall; (c) snap the position to the exact tile center at each intersection to kill floating-point drift. Do NOT move by free pixel velocity and merely "resolve overlaps" afterward - that clips through corners at speed. All movement stays strictly inside the open corridors of the maze grid; the only wrap is the side tunnels.
- Eating: moving over a dot scores 10 and removes it; a power pellet scores 50 and triggers FRIGHTENED mode. Eating all dots completes the level (advance to a faster level and reset the maze).

3. Ghosts and AI (the heart of Pac-Man)
- Four ghosts with DISTINCT personalities and target-tile logic, exactly like the original:
  - Blinky (red): targets Pac-Man's current tile (direct chaser).
  - Pinky (pink): targets 4 tiles ahead of Pac-Man's current direction (ambusher).
  - Inky (cyan): targets using a vector from Blinky through the tile 2 ahead of Pac-Man.
  - Clyde (orange): chases like Blinky when far, but flees to his scatter corner when close (within ~8 tiles).
- Global mode timer alternating SCATTER (each ghost heads to its own corner) and CHASE, like the arcade waves. Ghosts choose, at each intersection, the legal direction (no reversing) that minimizes straight-line distance to their target tile.
- Ghost house: ghosts start in/near the house and are released on a timer. After being eaten (in frightened mode), a ghost becomes a pair of "eyes" that return to the house and revive.
- FRIGHTENED mode: on a power pellet, all ghosts turn blue, reverse direction, and move slowly and semi-randomly; Pac-Man eating a frightened ghost scores 200/400/800/1600 in a chain and sends its eyes home. Mode ends after a few seconds (flash before it ends).

4. Demo / Attract mode (auto-play) - IMPORTANT
- On launch the game MUST start in DEMO mode like the arcade attract screen: Pac-Man plays HIMSELF with NO human input. A rule-based AI drives him so he visibly clears dots, avoids ghosts, grabs a power pellet when ghosts are near and then chases and eats the now-frightened ghosts. It should read as a competent player, not random twitching, and must not get permanently stuck.
- A reasonable heuristic: pathfind (BFS/greedy on the tile grid) toward the nearest dot or power pellet; if a non-frightened ghost is dangerously close, steer away (or toward a power pellet); when ghosts are frightened, steer toward the closest one to eat it.
- Show a blinking overlay while in demo mode, e.g. "DEMO - PRESS ENTER TO PLAY".
- When the player presses Start (Enter / Return), leave demo mode and hand full control to the human (Arrow keys to choose direction). On death (losing the last life) or level clear while in player mode, returning to demo mode is fine. The SAME maze, ghost AI, eating, scoring, and win/loss rules apply in both demo and player modes.

5. Assets and Game Loop
- All art is drawn PROCEDURALLY (no external image files) - but make it DETAILED per the ART DIRECTION above: each sprite is a small composition of smooth, shaded shapes, not a single rectangle. Keep each sprite's drawing in its own method so it stays readable.
- Lives & game over: Pac-Man starts with 3 lives; colliding with a non-frightened ghost loses a life and resets positions; at 0 lives show a brief GAME OVER, then return to demo mode. Include a simple reset function.

6. Browser/async game loop — MANDATORY for pygbag/WebAssembly (getting this wrong is the #1 cause of a BLACK SCREEN or a FROZEN tab — follow it EXACTLY):
- ONE coroutine, ONE loop: `import asyncio` at the top; the ENTIRE game runs inside `async def main():` with a SINGLE game loop; launch via `asyncio.run(main())` under `if __name__ == "__main__":`. Nothing else may drive the loop.
- STATE MACHINE, no nested/blocking sub-loops: title, DEMO/attract, playing, paused, transition (level clear / respawn / ready), and game-over are STATES checked inside the ONE loop — never separate `while` loops. A second loop that doesn't yield freezes the tab on a black canvas. Need a "wait"? Use a timer variable or `pygame.time.get_ticks()` deltas and check it each frame.
- YIELD EVERY FRAME: the LAST statement of every loop iteration MUST be `await asyncio.sleep(0)`. No branch (a `continue`, a state screen, game-over) may skip it — skipping it hard-freezes the browser. This is mandatory, not optional.
- DRAW + FLIP EVERY FRAME: every iteration must draw the current state and then call `pygame.display.flip()` (or `update()`); never `continue` past the draw/flip. Paint one visible frame BEFORE any heavy setup so the canvas is never black at startup.
- NO BLOCKING CALLS anywhere (they freeze WASM): never `time.sleep()`, `pygame.time.wait()`, `pygame.time.delay()`, `input()`, `sys.exit()`, `exit()`, `quit()`, `os._exit()`, and never a `while` that spins waiting for a key/event. To stop, break the single loop; for timed effects use frame counters or tick deltas. Do NOT read/write files or access the network — draw everything procedurally with shapes.
- CORRECT INIT ORDER (a wrong order raises and blanks the canvas): call `pygame.init()` then `screen = pygame.display.set_mode((W, H))` FIRST; only AFTER that create Surfaces or call `.convert()`/`.convert_alpha()` (converting a Surface before `set_mode()` raises `pygame.error`). Build all sprites/assets once, before the loop.
- BOUNDED PER-FRAME WORK (prevents "runs for a moment, then freezes"): do heavy setup ONCE before the loop; keep per-frame work O(active entities), not O(whole maze) each frame. Any ghost/Pac-Man pathfinding (BFS/greedy) must be THROTTLED — recompute a target/route only when the actor reaches a tile center or on a cached cadence, never a full-maze search for every ghost every frame.
- FRAME CAP: create `clock = pygame.time.Clock()` and call `clock.tick(60)` once per iteration (it does NOT block in pygbag) to hold ~60 FPS.
- DEFENSIVE FRAME (so one bad frame never leaves a black/frozen screen): wrap the per-frame update+draw body in `try/except`; on error, print the traceback (it appears in the pygbag console) and STILL call `pygame.display.flip()` + `await asyncio.sleep(0)` so the loop survives. Never let an exception escape the loop.

7. CORRECTNESS - the program MUST run with no crashes. Target runtime: Python 3.13 with Pygame 2.6.1 (SDL 2.28.4) on a desktop AND in the browser via pygbag - use ONLY functions and attributes that exist in Pygame 2.6.1; never invent or guess a name (for instance pygame.event.get_events() and pygame.Rect.padded() have NEVER existed in any Pygame version - the real calls are pygame.event.get() and Rect.inflate()). Below is the EXACT, correct API for everything this game needs - use these names verbatim and do not use any pygame.* call that is not a documented Pygame 2.x API:
   - Init / display: pygame.init(); screen = pygame.display.set_mode((w, h)); pygame.display.set_caption(str); pygame.display.flip() (or pygame.display.update()).
   - Events: the event queue is read with pygame.event.get() -> list of events. There is NO pygame.event.get_events(). Loop: `for event in pygame.event.get():` then check `event.type` (pygame.QUIT, pygame.KEYDOWN, pygame.KEYUP) and `event.key` (pygame.K_RETURN, pygame.K_LEFT, pygame.K_RIGHT, pygame.K_UP, pygame.K_DOWN, ...).
   - Held keys: keys = pygame.key.get_pressed(); then index it like keys[pygame.K_LEFT].
   - Drawing: pygame.draw.rect(surface, color, rect[, width][, border_radius=N]) (border_radius rounds the corners); pygame.draw.line(...) and pygame.draw.aaline(surface, color, start, end) (anti-aliased); pygame.draw.polygon(surface, color, points); pygame.draw.arc(surface, color, rect, start_angle, stop_angle[, width]); pygame.draw.ellipse(surface, color, rect); pygame.draw.circle(surface, color, center, radius[, width]).
   - Smooth/anti-aliased shapes WITHOUT gfxdraw: `pygame.gfxdraw` is NOT available in the browser (pygbag) — its calls silently do nothing there, so do NOT import or use it. Instead use pygame.draw.circle / pygame.draw.ellipse / pygame.draw.polygon / pygame.draw.arc / pygame.draw.aaline, rounded rects via pygame.draw.rect(surface, color, rect, border_radius=N), and for extra-smooth art draw onto a 2-3x pygame.Surface((w, h), pygame.SRCALPHA) then pygame.transform.smoothscale(surf, (w, h)) it down.
   - Surfaces: s = pygame.Surface((w, h)) - or pygame.Surface((w, h), pygame.SRCALPHA) for transparency (glows, frightened-ghost flash); s.fill(color); s.blit(src, (x, y)); s.set_alpha(0-255); s.get_rect(); s.convert() / s.convert_alpha().
   - Scaling/rotation: pygame.transform.scale(surface, (w, h)); pygame.transform.smoothscale(surface, (w, h)) for a SMOOTH (non-blocky) scale; pygame.transform.rotate(surface, degrees); pygame.transform.flip(surface, x_bool, y_bool).
   - Fonts: pygame.font.init(); f = pygame.font.SysFont(name, size, bold=False); txt = f.render(text, antialias_bool, color); txt.get_rect(center=(x, y)).
   - Clock / time: clock = pygame.time.Clock(); clock.tick(60); pygame.time.get_ticks().
   - pygame.Rect attributes/methods that EXIST: x, y, width, height, left, right, top, bottom, centerx, centery, center, topleft, topright, bottomleft, bottomright; .move(dx, dy), .move_ip(dx, dy), .inflate(dx, dy), .copy(), .colliderect(other), .collidepoint(point), .clamp(rect), .clamp_ip(rect). pygame.Rect does NOT have a .padded() method - for an inset/outset use rect.inflate(dx, dy).
   Before writing any pygame.* call, confirm it is in the list above or is a real Pygame 2.x API. If unsure whether a method exists, use a simpler call that you are certain exists.

The file must run directly: include an `if __name__ == "__main__":` guard that calls `asyncio.run(main())`. Use no third-party libraries other than Pygame (plus the standard-library `asyncio`, and `collections`/`random` if helpful). All commentary must live inside the code as comments.

Output ONLY the solution as a single fenced ```python code block. No prose, explanation, comments outside the code, preamble, or postscript - nothing before or after the single code block. Any necessary explanation must be a code comment inside that block.
