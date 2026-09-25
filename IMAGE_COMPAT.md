# Image compatibility — every model, large images (Round 7, 2026-09-25)

Rule (Tarun): no silent substitution. Every model must actually **see** the image.
- If a model needs a smaller copy, it gets one, labelled visibly.
- The only errors allowed are genuine provider-side ones (network, 429/503/quota/capacity, a real 404).
- Text-only models get a clear labelled note, and only when metadata or a live probe proves it.

## 1. The bug on 00078 (root cause)

gpt-6-sol and gpt-5.6-sol could not see Tarun's 5.3 MB JPEG (7952×5304). The upstream 400 was the same on `/v1/responses` (param `input`) and `/v1/chat/completions` (param `messages`):

```
{"error":{"message":"The image you provided requires 41334 patches after processing, exceeding the limit of 30000. Please resize the image and try again.","type":"invalid_request_error","param":"input","code":"invalid_value"}}
```

41334 = 249 × 166 patches of 32 px.

The old adapter then silently retried with `allowImages:false` and got a 200 with text only:
- gpt-6-sol said it couldn't see the image.
- gpt-5.6-sol **hallucinated** "a person in dark clothing".

That strip path is gone from every adapter.

## 2. Documented limits applied up front (`src/imagePolicy.js`)

| Provider | Source (fetched 2026-09-25) | Limit applied |
|---|---|---|
| OpenAI gpt-6 / gpt-5.6 | https://platform.openai.com/docs/guides/images-vision ("Image input requirements", "Model sizing behavior") | ≤ 30,000 patches of 32 px (**rejected, not resized**), 65,535 px; PNG/JPEG/WEBP/GIF |
| OpenAI gpt-5.5 | same | `original` detail: 10,000 patches, 6000 px max |
| OpenAI unknown model | same | conservative 10,000 / 6000 |
| Anthropic Claude | https://docs.anthropic.com/en/docs/build-with-claude/vision | 5 MB per image (base64), 8000×8000 px; compact copy at native 2576 px / 4784 visual tokens (Round 6) |
| Gemini API | Gemini API image understanding | inline data: total request ≤ 20 MB |
| Gemini on Vertex | Vertex image understanding (7 MB / 10 MB is the console upload only) | no byte cap applied; original |
| Moonshot Kimi | https://platform.moonshot.ai/docs/guide/use-kimi-vision-model | base64 only, request body ≤ 100 MB; "recommend ≤ 4k (4096×2160)" is advisory → original |
| Vertex MaaS (Grok, Llama 4) | MaaS overview | no documented image limit → original; reactive retry covers undocumented rejections |

### How the copies work
- **Ladder:** original → **fit copy** (OpenAI 30k-patch budget, official shrink formula, JPEG, browser-made) → **compact copy** (Claude native size). Claude skips the fit rung.
- **Up front:** the first rung inside the model's documented limits is sent. Any substitution adds a visible note in the slot, e.g. `image auto-scaled to 6764×4512 for gpt-6-sol (7952×5304 px needs 41334 patches, over the 30000-patch limit)`. The model's own prompt also names the scaled size.
- **Reactive:** when the provider rejects the image (413, or 400/422 naming image/patch/pixel/size…), the **same model** is retried one rung down.
- **Out of rungs:** `image couldn't be sent to <model>: "<name>" — <why>. Not answered without it.`
- **Other errors:** non-image errors (429/404/network) are surfaced unchanged and never cause a downscale.
- **Check:** the 6764×4512 fit copy = 212 × 141 = **29,892 patches**. That's ≤ 30k for gpt-6/5.6. For gpt-5.5 and unknown OpenAI models it's over 10k / 6000 px, so they get the 2348×1566 compact copy (3,626 patches). Unit-tested in `test/verify-image-policy.js`.

## 3. Text-only models: proof

Model Garden publisher metadata (`GET …/v1beta1/publishers/{p}/models/{m}`) has **no modality fields**, so the proof is a live probe:
- Image: a 1024×683 landscape, sent through the app path on 2026-09-25.
- A vision model's prompt costs 756–1943 tokens with that image. The endpoints below billed only 46–114 prompt tokens, i.e. the image was dropped server-side.
- Several of them then hallucinated a scene.

| Model | Probe evidence |
|---|---|
| llama-3.3-70b-instruct-maas | 400 `Unable to submit request because it has non-text input data but the model only accepts text input data` |
| deepseek-r1-0528-maas | 200, 47 prompt tokens; hallucinated "plowed field … arid terrain" |
| deepseek-v3.2-maas | 200, 46 prompt tokens; hallucinated (re-probe after a 429) |
| qwen3-235b-a22b-instruct-maas | 200, 55 tokens; hallucinated "dry, cracked earth … desert" |
| qwen3-coder-480b-a35b-instruct-maas | 200, 55 tokens; "I don't see an attached image" |
| qwen3-next-80b-a3b-thinking-maas | 200, 57 tokens; "I'm unable to view or analyze images" |
| qwen3-next-80b-a3b-instruct-maas | 200, 55 tokens; hallucinated "semi-arid grassland" |
| gpt-oss-120b-maas | 200, 114 tokens; "I can't see the image you mentioned" |
| gpt-oss-20b-maas | 200, 114 tokens; generic guess |
| kimi-k2-thinking-maas | 200, 74 tokens; guessed |
| glm-5.2-maas | 200, 77 tokens; "unable to view or analyze the image" |
| glm-5-maas | 200, 46 tokens; hallucinated "yellow crops … fences" |
| glm-4.7-maas | 200, 46 tokens; hallucinated |

These models now return `<model> does not accept images (…) — not answered without the image.` They make zero upstream calls, so they are no longer priced for an answer about an image they never saw.

Kimi K3 / K2.6 (Moonshot direct) are vision models per the docs and the live run below.

## 4. Other fixes found by the matrix

- **Llama 4 Scout** failed on every prompt (400/500) because `max_tokens` was missing. Platform error: "maxOutputTokens … supported range is from 1 (inclusive) to 8193 (exclusive)". It now sends 8192.
- **ETIMEDOUT under load** (our side):
  - Concurrent large bodies made Node's happy-eyeballs (250 ms per-address attempt) abort IPv4 connects: `AggregateError[ETIMEDOUT 162.159.140.245, EHOSTUNREACH 2606:4700:7::f3, …]`. No byte reached the provider.
  - Fix: `PROVIDER_CONNECT_ATTEMPT_TIMEOUT_MS` (default 2500, clamped 250–10000), applied once in `src/providerFetch.js` and logged at startup. No new dependency.
  - Same conc-6 full-catalog 19 MB run: before, 8 ETIMEDOUT cells; after, **0**.
- **Kimi in the first harness run**: "Missing MOONSHOT_API_KEY" was a harness artifact. The server reads it from Secret Manager via `globalKeys`, which the harness hadn't warmed. The deploy config was not changed.

## 5. Results matrix (local, app provider path, conc 6, final code)

Cell = sent as · final HTTP status · pass/fail.
- **Pass** = describes the landscape (fields/hills + sky/clouds) and gives no "can't see" answer.
- **genuine NNN** = a provider-side error, with the body listed below.

Test images:
- Tarun's original: a scratch copy, never modified or committed.
- The 10/17 MB JPEG and 19 MB PNG variants: re-encodes of it.
- A 21.8 MB 7200×4800 JPEG.
- CI uses synthetic headers only.

| model | Tarun original JPEG 5.6 MB 7952×5304 | JPEG 9.7 MB 7952×5304 | JPEG 17.2 MB 7952×5304 | PNG 19.0 MB 4500×3001 | JPEG 21.8 MB 7200×4800 |
|---|---|---|---|---|---|
| gemini-3.5-flash-lite | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| gemini-3.5-flash | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| gemini-3.1-pro | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| gemini-3.6-flash | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| gemini-3.7-flash | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| claude-opus-5-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| gemini-3.8-flash | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| claude-fable-5-1 | genuine 429 | genuine 429 | genuine 429 | genuine 429 | genuine 429 |
| claude-fable-5 | genuine 429 | genuine 429 | genuine 429 | genuine 429 | genuine 429 |
| claude-sonnet-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-opus-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-mythos-5 | genuine 429 | genuine 429 | genuine 429 | genuine 429 | genuine 429 |
| claude-opus-4-8 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-opus-4-6 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-sonnet-4-6 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-opus-4-7 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-opus-4-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-haiku-4-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| claude-sonnet-4-5 | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1566 · 200 · PASS | scaled 2348×1565 · 200 · PASS |
| grok-4.1-fast-non-reasoning | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| llama-4-maverick-17b-128e-maas | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| llama-3.3-70b-instruct-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| deepseek-r1-0528-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| deepseek-v3.2-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| qwen3-235b-a22b-instruct-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| qwen3-coder-480b-a35b-instruct-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| qwen3-next-80b-a3b-thinking-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| qwen3-next-80b-a3b-instruct-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| grok-4.20-reasoning | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| grok-4.20-non-reasoning | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| grok-4.6 | genuine 404 | genuine 404 | genuine 404 | genuine 404 | genuine 404 |
| gpt-6-sol | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| gpt-6-luna | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| llama-4-scout-17b-16e-maas | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| grok-4.1-fast-reasoning | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| gpt-oss-120b-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| gpt-oss-20b-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| kimi-k2-thinking-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| gpt-5.6-sol | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| gpt-5.6-luna | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| glm-5.2-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| glm-5-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| glm-4.7-maas | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) | not supported (labelled, 0 calls) |
| gpt-6-terra | genuine 404 | genuine 404 | genuine 404 | genuine 404 | genuine 404 |
| gpt-5.6-terra | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| gpt-6-astra | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | scaled 6764×4512 · 200 · PASS | original · 200 · PASS | scaled 6768×4512 · 200 · PASS |
| kimi-k2.6 | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |
| kimi-k3 | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS | original · 200 · PASS |


Counts: {"pass":150,"unsupported":65,"genuine":25,"fail":0}

### Genuine provider errors (evidence)

| Model | Status | Provider message | Images |
|---|---|---|---|
| claude-fable-5-1 | 429 | Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model: anthropic-claude-fable. Please submit a quota increase request. https://cloud.google.com/vertex-ai/docs/gener | tarun-orig, orig-10mb, orig-17mb, orig-19mb, land-20mb |
| claude-fable-5 | 429 | Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model: anthropic-claude-fable. Please submit a quota increase request. https://cloud.google.com/vertex-ai/docs/gener | tarun-orig, orig-10mb, orig-17mb, orig-19mb, land-20mb |
| claude-mythos-5 | 429 | Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model: anthropic-claude-mythos-5. Please submit a quota increase request. https://cloud.google.com/vertex-ai/docs/ge | tarun-orig, orig-10mb, orig-17mb, orig-19mb, land-20mb |
| grok-4.6 | 404 | Publisher model `projects/87624372578/locations/us-central1/publishers/xai/models/grok-4.6` was not found or your project does not have access to it. Ensure you are using a valid model name and that the model is availabl | tarun-orig, orig-10mb, orig-17mb, orig-19mb, land-20mb |
| gpt-6-terra | 404 | The model `gpt-6-terra` does not exist or you do not have access to it. | tarun-orig, orig-10mb, orig-17mb, orig-19mb, land-20mb |

- claude-fable-5 / fable-5-1 / mythos-5: per-base-model quota. Slot C decision: accept the labelled 429s.
- gpt-6-terra and grok-4.6: not available to this key/project.

## 6. Prod verification

_pending_

Counts: {"pass":0,"unsupported":0,"genuine":0,"fail":0}

| Model | Status | Provider message | Images |
|---|---|---|---|

