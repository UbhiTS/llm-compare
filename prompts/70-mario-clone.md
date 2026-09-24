---
id: mario-clone
title: Super Mario Bros clone (Pygame, polished art + physics)
category: games
language: python
functionName: solution
executable: true
gui: true
---
Act as an expert game developer specializing in retro 2D platformers. Write the complete code for a Super Mario Bros clone that faithfully recreates the mechanics and feel of the original Nintendo NES game, and that starts in an automatic DEMO / ATTRACT mode where Mario plays himself.

Use Python 3 and the Pygame library (Pygame 2.x). Deliver it as a single, self-contained, runnable file. The code must be strictly object-oriented, with classes for the player, enemies, blocks, and the level map.

Core requirements and mechanics:

1. Visuals and Architecture
- Resolution: render at a generous resolution (e.g. a ~768x720 or 800x600 window). Do NOT use a tiny 256x240 pixel-art buffer or chunky integer-scaled NES pixels - aim for a clean, modern, HIGH-RESOLUTION look.
- ART DIRECTION & MANDATORY MULTI-FRAME CHARACTER ANIMATION (make it look polished, NOT blocky - this matters): draw every character and object by COMPOSING MULTIPLE shaded shapes, never a single flat rectangle. Use smooth shapes via pygame.draw (circle, ellipse, polygon, aaline) — do NOT use pygame.gfxdraw: it is unavailable in the browser (pygbag) and its calls silently draw nothing there, leaving blank/missing art. For extra-smooth shapes, draw onto a 2-3x `pygame.Surface((w,h), pygame.SRCALPHA)` and `pygame.transform.smoothscale` it down. Add soft gradients and shading (a lighter highlight toward the top, a darker shade toward the bottom), rounded corners (pygame.draw.rect supports border_radius), and small details.
  - **Mario 4-Frame Running Leg & Arm Stride Cycle (CRITICAL - NEVER DRAW STATIC LEGS WHILE MOVING)**:
    - Mario = blue overalls with gold straps/buttons + red shirt + skin-tone face + brown hair + a red cap with a curved brim and white emblem + eyes + a dark moustache + brown boots + white gloves, plus a soft ground shadow. Flip horizontally (`facing = -1`) when moving left.
    - Track `walk_frame = (pygame.time.get_ticks() // 75) % 4` whenever `abs(vx) > 0.25` on the ground, and explicitly render 6 distinct pose states:
      1. `IDLE`: Both brown boots planted evenly beneath overalls (`left_leg_dx = -4, right_leg_dx = +4`), arms resting at sides.
      2. `RUN_1` (Wide Stride A): Left leg and boot extended forward (`dx = +8, dy = -2`), right leg kicked back (`dx = -8, dy = -3`), right arm swung forward (`dx = +7`), left arm back.
      3. `RUN_2` (Mid-Pass): Legs crossing past center (`left_leg_dx = +2, right_leg_dx = -2`, back knee raised `dy = -4`), torso bobbed `-2px`.
      4. `RUN_3` (Wide Stride B): Right leg and boot extended forward (`dx = +8, dy = -2`), left leg kicked back (`dx = -8, dy = -3`), left arm swung forward (`dx = +7`), right arm back.
      5. `JUMP`: Front knee tucked high (`dy = -5`), back leg extended down (`dy = +2`), one fist raised high overhead (`arm_y = head_y - 6`) in the classic NES jump pose.
      6. `SKID`: When player/AI reverses direction opposite `vx` (`vx * input_dir < 0 and abs(vx) > 1.0`), lean torso back, brace front boot forward, and spawn 2-3 white dust puff circles at Mario's heel.
  - **Goombas, Blocks, Coins & Particle Polish**:
    - Goombas = a shaded chestnut mushroom cap with angry white eyes, dark pupils, furrowed eyebrows, beige stem, and **2-frame alternating waddling feet** (`(pygame.time.get_ticks() // 140) % 2` toggling left/right foot sizes/offsets); when stomped, display a flattened squished state for 350ms with floating `+100` score popup before removing.
    - Question (`?`) Blocks: Golden blocks whose inner highlight and `?` glyph pulse across a 4-phase brightness cycle; when bonked from below, animate a smooth vertical bounce offset (`vy = -4` returning to `0`), spawn a spinning gold coin arc (`+200`) or emerging red-spotted Super Mushroom, and transition to an inert riveted brown block.
    - Brick Blocks: Textured terracotta mortar bricks; when Super Mario bonks a brick, shatter it into 4 spinning diagonal debris chunks with gravity (`vx = ±3, vy = -7`) or bounce it upward if Small Mario hits it.
    - Pipes = emerald green cylinder with a vertical specularity highlight band and darker lip rim; Flagpole = pole with top orb, waving triangular green flag, and brick castle at the end of World 1-1.
- Background: a pretty LAYERED scene - a vertical sky gradient (deep blue to light), soft parallax clouds, rolling hills/bushes in the distance, and a textured ground (not a flat brown bar). Parallax the far background slower than the foreground for depth.
- Tile-based world: implement a tile-based level system. Use a 2D array (or list of strings) to lay out World 1-1, including ground blocks, brick blocks, question-mark blocks, and pipes.
- Camera: a side-scrolling camera that follows Mario only when he moves right of screen center, and never scrolls backward (left).

2. Player Physics and Controls (crucial)
- Movement: implement acceleration, top speed, and friction - Mario should not stop instantly when the Left/Right key is released; he should slide slightly.
- Jumping: variable jump height (higher the longer Spacebar/Up is held, up to a max peak) with gravity and 90ms coyote time.
- Jump reachability (REQUIRED - no un-jumpable obstacles): every obstacle the player must clear by jumping - pipes, staircase steps, and any stacked/ground blocks in the forward path - MUST be low enough to clear with a single full-height jump given YOUR OWN physics. Compute Mario's peak jump height from your constants (approximately `h_max = (JUMP_SPEED ** 2) / (2 * GRAVITY)`, in pixels, using the magnitude of the initial jump velocity) and design the level so that no obstacle the player must jump over rises more than about 65-70% of `h_max` above the surface Mario jumps from (leave margin for jump timing, hitbox size, and horizontal speed). In practice: cap every pipe's height and every staircase's step-height to that limit, and NEVER place a solid obstacle taller than Mario can reach - if a taller structure is desired, make it a background/decoration that is NOT solid. Check these heights against your actual JUMP_SPEED and GRAVITY values before committing the level layout, so neither Mario nor the demo AI can ever get stuck against a wall he cannot clear.
- Collision: Axis-Aligned Bounding Box (AABB). Mario stops on the ground, bonks bricks with his head, and stops at the sides of pipes.
- Solid collision is ABSOLUTE (REQUIRED - a top bug to avoid: bodies sinking into or tunneling THROUGH solid tiles). Mario, enemies, and items must NEVER pass through solid tiles (ground, bricks, pipes, blocks). Resolve collisions PER AXIS with sub-stepping (`steps = max(1, int(max(abs(vx), abs(vy)) // (TILE // 3)) + 1)`):
  1. In each sub-step, advance `x += vx / steps`, rebuild `rect.x = round(x)`, and check all overlapping solid tiles: if `vx > 0`, snap `rect.right = tile.left; x = rect.x; vx = 0`; if `vx < 0`, snap `rect.left = tile.right; x = rect.x; vx = 0`.
  2. Next, advance `y += vy / steps`, rebuild `rect.y = round(y)`, and check all overlapping solid tiles: if `vy > 0` (falling), snap `rect.bottom = tile.top; y = rect.y; vy = 0; on_ground = True`; if `vy < 0` (jumping upward), snap `rect.top = tile.bottom; y = rect.y; vy = 0` and trigger `on_block_bumped(tile)`.
  Mario must land cleanly on top of surfaces and be blocked flush against pipe/wall sides - never overlapping, jittering inside, or clipping past them.

3. Entities and States
- Mario state machine: Small, Super, Dead.
- Items: hitting a question block spawns a Super Mushroom (moves right, bouncing off pipes) or a Coin. Collecting a Mushroom turns Small Mario into Super Mario (taller hitbox, can break bricks).
- Enemies: Goombas spawn off-screen, walk left continuously, and fall off ledges. Jumping on a Goomba defeats it (squish); a side touch damages Mario (shrinks if Super, dies if Small).

4. Demo / Attract mode (auto-play) - IMPORTANT
- On launch the game MUST start in DEMO mode, exactly like the original NES attract screen: Mario plays HIMSELF with NO human input. A rule-based AI drives him so he visibly runs right, jumps over pits and pipes/obstacles, stomps Goombas, grabs the Super Mushroom to grow into Super Mario, and makes real forward progress through World 1-1.
- The auto-player must be a simple heuristic (no machine learning). For example: hold right by default; trigger a jump when a pit/gap is just ahead, when a pipe or block obstructs forward motion, or when a Goomba is close ahead - timing the jump so Mario lands on top and squishes it. It should read as a competent player, not random twitching, and should not get permanently stuck. Because §2 guarantees every obstacle is jumpable, the AI must commit to a FULL-height jump (hold the jump long enough for max height) and start it early enough to clear pipes and stairs; if forward progress stalls even briefly against an obstacle, it must retry the jump rather than keep walking into the wall - it must NEVER softlock.
- Show a blinking overlay while in demo mode, e.g. "DEMO - PRESS ENTER TO PLAY".
- When the player presses Start (Enter / Return), leave demo mode and hand full control to the human (Left/Right to move, Space or Up to jump). On death or level end while in player mode, returning to demo mode is fine. The SAME physics, collisions, stomping, growing, and win/loss rules apply in both demo and player modes.

5. Assets and Game Loop
- All art is drawn PROCEDURALLY (no external image files) - but make it DETAILED per the ART DIRECTION above: each sprite is a small composition of shaded shapes with highlights and shadows, not a single rectangle. Keep each sprite's drawing in its own method/function so it stays readable.
- HUD: show Score, Coin count, World (1-1), and a descending Timer at the top.
- Win/Loss: the level ends when Mario reaches the flagpole on the far right, or when he falls into a pit / dies to an enemy. Include a simple reset function.

6. Browser/async game loop — MANDATORY for pygbag/WebAssembly (getting this wrong is the #1 cause of a BLACK SCREEN or a FROZEN tab — follow it EXACTLY):
- ONE coroutine, ONE loop: `import asyncio` at the top; the ENTIRE game runs inside `async def main():` with a SINGLE game loop; launch via `asyncio.run(main())` under `if __name__ == "__main__":`. Nothing else may drive the loop.
- STATE MACHINE, no nested/blocking sub-loops: title, DEMO/attract, playing, paused, transition (level change / respawn / death), and game-over are STATES checked inside the ONE loop — never separate `while` loops. A second loop that doesn't yield freezes the tab on a black canvas. Need a "wait"? Use a timer variable or `pygame.time.get_ticks()` deltas and check it each frame.
- YIELD EVERY FRAME: the LAST statement of every loop iteration MUST be `await asyncio.sleep(0)`. No branch (a `continue`, a state screen, game-over) may skip it — skipping it hard-freezes the browser. This is mandatory, not optional.
- DRAW + FLIP EVERY FRAME: every iteration must draw the current state and then call `pygame.display.flip()` (or `update()`); never `continue` past the draw/flip. Paint one visible frame BEFORE any heavy setup so the canvas is never black at startup.
- NO BLOCKING CALLS anywhere (they freeze WASM): never `time.sleep()`, `pygame.time.wait()`, `pygame.time.delay()`, `input()`, `sys.exit()`, `exit()`, `quit()`, `os._exit()`, and never a `while` that spins waiting for a key/event. To stop, break the single loop; for timed effects use frame counters or tick deltas. Do NOT read/write files or access the network — draw everything procedurally with shapes.
- CORRECT INIT ORDER (a wrong order raises and blanks the canvas): call `pygame.init()` then `screen = pygame.display.set_mode((W, H))` FIRST; only AFTER that create Surfaces or call `.convert()`/`.convert_alpha()` (converting a Surface before `set_mode()` raises `pygame.error`). Build all sprites/assets once, before the loop.
- BOUNDED PER-FRAME WORK (prevents "runs for a moment, then freezes"): do heavy setup ONCE before the loop; keep per-frame work O(active entities), not O(whole level) each frame. Any AI/search must be THROTTLED — computed at a decision point (spawn, reaching a tile edge) or on a cached cadence, never a full search for every actor every frame.
- FRAME CAP: create `clock = pygame.time.Clock()` and call `clock.tick(60)` once per iteration (it does NOT block in pygbag) to hold ~60 FPS.
- DEFENSIVE FRAME (so one bad frame never leaves a black/frozen screen): wrap the per-frame update+draw body in `try/except`; on error, print the traceback (it appears in the pygbag console) and STILL call `pygame.display.flip()` + `await asyncio.sleep(0)` so the loop survives. Never let an exception escape the loop.

7. CORRECTNESS - the program MUST run with no crashes. Target runtime: Python 3.13 with Pygame 2.6.1 (SDL 2.28.4) on a desktop AND in the browser via pygbag - use ONLY functions and attributes that exist in Pygame 2.6.1; never invent or guess a name (for instance pygame.event.get_events() and pygame.Rect.padded() have NEVER existed in any Pygame version - the real calls are pygame.event.get() and Rect.inflate()). Below is the EXACT, correct API for everything this game needs - use these names verbatim and do not use any pygame.* call that is not a documented Pygame 2.x API:
   - Init / display: pygame.init(); screen = pygame.display.set_mode((w, h)); pygame.display.set_caption(str); pygame.display.flip() (or pygame.display.update()).
   - Events: the event queue is read with pygame.event.get() -> list of events. There is NO pygame.event.get_events(). Loop: `for event in pygame.event.get():` then check `event.type` (pygame.QUIT, pygame.KEYDOWN, pygame.KEYUP) and `event.key` (pygame.K_RETURN, pygame.K_LEFT, pygame.K_RIGHT, pygame.K_SPACE, pygame.K_UP, ...).
   - Held keys: keys = pygame.key.get_pressed(); then index it like keys[pygame.K_LEFT].
   - Drawing: pygame.draw.rect(surface, color, rect[, width][, border_radius=N]) (border_radius rounds the corners); pygame.draw.line(...) and pygame.draw.aaline(surface, color, start, end) (anti-aliased); pygame.draw.polygon(surface, color, points); pygame.draw.ellipse(surface, color, rect); pygame.draw.circle(surface, color, center, radius[, width]).
   - Smooth/anti-aliased shapes WITHOUT gfxdraw: `pygame.gfxdraw` is NOT available in the browser (pygbag) — its calls silently do nothing there, so do NOT import or use it. Instead use pygame.draw.circle / pygame.draw.ellipse / pygame.draw.polygon / pygame.draw.aaline, rounded rects via pygame.draw.rect(surface, color, rect, border_radius=N), and for extra-smooth art draw onto a 2-3x pygame.Surface((w, h), pygame.SRCALPHA) then pygame.transform.smoothscale(surf, (w, h)) it down.
   - Surfaces: s = pygame.Surface((w, h)) - or pygame.Surface((w, h), pygame.SRCALPHA) for transparency (soft shadows / glows); s.fill(color); s.blit(src, (x, y)); s.set_alpha(0-255); s.get_rect(); s.convert() / s.convert_alpha().
   - Scaling/rotation: pygame.transform.scale(surface, (w, h)); pygame.transform.smoothscale(surface, (w, h)) for a SMOOTH (non-blocky) scale; pygame.transform.scale_by(surface, factor); pygame.transform.rotate(surface, degrees); pygame.transform.flip(surface, x_bool, y_bool).
   - Fonts: pygame.font.init(); f = pygame.font.SysFont(name, size, bold=False); txt = f.render(text, antialias_bool, color); txt.get_rect(center=(x, y)).
   - Clock / time: clock = pygame.time.Clock(); clock.tick(60); pygame.time.get_ticks().
   - pygame.Rect attributes/methods that EXIST: x, y, width, height, left, right, top, bottom, centerx, centery, center, topleft, topright, bottomleft, bottomright; .move(dx, dy), .move_ip(dx, dy), .inflate(dx, dy), .copy(), .colliderect(other), .collidepoint(point), .clamp(rect), .clamp_ip(rect). pygame.Rect does NOT have a .padded() method - for an inset/outset use rect.inflate(dx, dy).
   Before writing any pygame.* call, confirm it is in the list above or is a real Pygame 2.x API. If unsure whether a method exists, use a simpler call that you are certain exists.

The file must run directly: include an `if __name__ == "__main__":` guard that calls `asyncio.run(main())`. Use no third-party libraries other than Pygame (plus the standard-library `asyncio`). All commentary must live inside the code as comments.

Output ONLY the solution as a single fenced ```python code block. No prose, explanation, comments outside the code, preamble, or postscript - nothing before or after the single code block. Any necessary explanation must be a code comment inside that block.
