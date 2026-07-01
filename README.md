# LLM Agent Arena

Send the **same agentic task** to **three configurable LLMs at the same time** and
compare them on the things a buyer actually cares about: **correctness, speed,
tokens, and cost** — plus a balanced scorecard.

The task is a real agent workflow: each model **writes code → the harness runs it
against hidden edge-case tests → the model reads the failures → fixes → repeats**
until the tests pass or it runs out of rounds. All three run in parallel and the
UI updates live.

![arena](docs/screenshot.png)

## Why this is a credible demo (not a rigged one)

Every number is measured live from the provider APIs — real latency, the token
counts the APIs return, and **your** configured prices. Quality is the % of hidden
tests passed on the final round. Nothing is hardcoded. A fast, low-cost model wins
the cost and speed axes on its own merits; pick a task where throughput and price
matter and that advantage is real and defensible under scrutiny.

## Setup

```bash
cd llm-arena
npm install
cp .env.example .env      # then add your API keys
npm start                 # open http://localhost:3000
```

You can run with only one or two keys; slots missing a key just report an error.

## Configure (all in the UI)

- **Task** — pick from the presets (Minimum Meeting Rooms, Word Break, Longest
  Increasing Subsequence). Each has tricky edge cases so the self-debug loop has
  something to do.
- **Models** — three slots, each with a display label, provider
  (`gemini` / `openai` / `anthropic`), exact model id, and price ($/1M in & out).
- **Max self-debug rounds** — how many generate→test→fix iterations are allowed.

### Edit defaults in code

- Models & default prices: `src/pricing.js`
- Tasks & their hidden tests: `src/tasks.js` (add your own — the UI picks them up)

> ⚠️ The prices and model ids shipped here are **placeholders**. Set them to the
> exact models and current published prices before you demo to a customer.

## How it works

```
server.js            Express: serves UI, /api/config, /api/run (NDJSON stream)
src/orchestrator.js  runs the 3 agent loops concurrently (Promise.all)
src/agent.js         the generate → test → fix loop; accrues tokens/latency/cost
src/providers.js     Gemini / OpenAI / Anthropic adapters (normalized output)
src/runner.js        sandboxed (vm) JS test runner with a hard timeout
src/pricing.js       prices + default model slots
src/tasks.js         coding tasks + hidden edge-case tests
public/              the UI (vanilla JS + Chart.js radar)
```

## Verify without keys

```bash
npm test    # mocks the provider API and exercises the full loop + scoring
```

## Notes / limitations

- The test runner uses Node's `vm` for isolation + a timeout. That's fine for the
  bundled tasks you control; don't point it at untrusted task definitions.
- Provider API shapes (auth headers, usage fields) occasionally change. If a slot
  errors, the message from the provider is shown verbatim in that column.
