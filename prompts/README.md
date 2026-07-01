# Prompts

Every task in **Ubhi's LLM Matrix** lives in one text file in this folder. The
app loads all of them at startup (`src/tasks.js`). **To add a task, just drop a
new `.md` file here — no code changes, restart the server, done.** To change a
prompt, edit its file's body and restart.

## File format

```
---
id: my-task                 # required, unique, kebab-case
title: My Great Task        # required, shown in the dropdown
category: coding            # coding | general
language: python            # javascript | python | null  (null for prose tasks)
functionName: solution      # the JS function name for graded tasks; else "solution"
executable: true            # true -> shows a "Run code" button (JS = run hidden tests, Python = run program)
gui: true                   # optional: graphical (Pygame) — Run launches a real window
visualizer: hanoi           # optional: a custom UI visualizer (currently only "hanoi")
testCases: [{"input":[1,2],"expected":3}]   # optional: JSON array, only for graded JS tasks
---
The prompt text goes here, below the frontmatter. Write it however you like —
multiple paragraphs, lists, examples. This is the part that is sent to the model.
```

### Notes

- **Frontmatter** is the block between the two `---` lines. Each line is `key: value`.
  Values that look like JSON (arrays, objects, numbers, `true`/`false`/`null`) are
  parsed as JSON; everything else is a plain string.
- **Body** = the prompt (everything after the closing `---`).
- **Order**: files load in filename order, so the numeric prefix (`10-`, `20-`, …)
  controls where a task appears. Insert a new task by picking an in-between number
  (e.g. `35-my-task.md`).
- **Graded JS tasks** must include a `testCases` JSON array and a `functionName`.
  The model's generated function is run against these hidden tests in a sandbox.
- **Prompt-only tasks** (no `testCases`) just generate once — great for code
  generation (Python programs, Pygame games) or prose (itineraries, analysis).
- `README.md` and any file starting with `_` are ignored by the loader.

### Minimal example (a prose task)

```
---
id: haiku
title: Write a haiku about databases
category: general
language: null
---
Write a single, evocative haiku (5-7-5) about relational databases.
```
