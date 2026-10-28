# Ghost text (inline completion) for the note editor

Research for Epo's 2026-10-28 direction: editor AI is ghost text only, for the
Plate note now and the BlockSuite note later, on the older OpenRouter DeepSeek
pin with reasoning off. Nothing is built yet. Epo's answers and what is still open are at the end.

Measured 2026-10-28 from the developer Mac through OpenRouter with the UAT key:
72 streamed calls in all, in the same provider order elitellm uses. The
throwaway script is in the session scratchpad, not the repo.
Prices are from `GET openrouter.ai/api/v1/models/{id}/endpoints` on the same day.

## Status (2026-10-28): built on Plate, not pushed

Epo's picks: the 1017 pin; a "Note AI suggestions" switch in Settings → LLM,
off by default; the build flag dropped; 1017's capacity 76/56; a probe from the
ingest host before the reserve was fixed. Recorded in `human/frontend/plate-editor.md`,
`human/observability-metering.md` and `human/test-catalog.md`.

Built on branch `claude/ghost-text-18f936`:

- **Server.** `users.note_ai_enabled` replaces the editor model columns
  (`server/migrations/0128_note_ai_toggle.sql`; renumber to the next free
  number at landing). `PATCH /api/me/models` takes `noteAiEnabled`. The editor
  slot runs on its default pin. `/ai/copilot` takes `{title, before, after}`
  and refuses with 403 `note_ai_disabled` before any spend. `/ai/command` is
  gone. The ops role grants (`deploy/ops-roles.sql`) drop the editor columns.
- **Pipeline.** `/plate-ai/copilot` owns the prompt (`prompts/editor.py`), with
  40 tokens at temperature 0.2 and reasoning off. It keeps the answer's first
  line and joins it at the caret. `/plate-ai/command` and the menu prompts are
  gone.
- **Browser.** The AI menu is gone. Ghost text lives in
  `src/features/notes/ai/` (`ghostText.ts`, shared later with BlockSuite;
  `ghostTextPlugin.ts`; `GhostTextView.tsx`). `VITE_FEATURE_EDITOR_AI` is
  removed.
- **Checked in the browser under MSW:**
  - the switch saves;
  - ghost text appears after a pause and Tab accepts it;
  - Chinese text triggers without a space;
  - Esc rejects;
  - with the switch off, no request is sent even on ⌥Space;
  - the Settings row holds at 360px.

  Go DB tests and the full suites are left to CI.

Review of 350900237 (one read-only reviewer, 2026-10-28), now fixed:

- The ops admin role check still listed the dropped columns.
- A pending trigger survived further typing, so a request fired mid-word.
- A container's text after the caret leaked into the prompt. By Epo's
  decision, ghost text now runs in top-level text blocks only.
- A collaborator's edits wiped suggestions. They are now ignored unless they
  touch the caret's block.
- Phones paid for hidden suggestions. Nothing triggers under 640px.
- Every block re-rendered on every suggestion change.
- ⌥Space waited for the debounce.
- A switch turned off on another device went unnoticed.
- The 0010 replay test and two docs had leftovers.

Found while checking the fixes in the browser: the Markdown serializer writes
a trailing space as `&#x20;`, which leaked into `before`. Fixed.

The subscription cost, measured on a 3,000-block note in node:

- Rendering takes 172 ms without the plugin and 190 ms with it, about 6 µs per
  block.
- A store write runs 3,000 boolean selectors in about 0.45 ms and re-renders
  only the one or two blocks whose answer changed. Before the fix, every write
  re-rendered every block.

Stop sequence: `elitellm` has no `stop` parameter, so the server keeps the
answer's first line instead. It looks the same to the user and costs the same,
since the model rarely writes a newline.

Probe from the ingest host, 1017 on InferenceNet, ghost-text-sized calls
(about 400 tokens in, 20 out, uncached), 10 rounds per worker:

| In flight | Calls a minute | First token p50 / p95 | Total p50 / p95 / max | 429s |
| --- | --- | --- | --- | --- |
| 16 | 1,197 | 398 / 632 ms | 644 / 1,025 / 1,674 ms | 0 |
| 32 | 2,469 | 390 / 571 ms | 619 / 1,018 / 2,105 ms | 0 |
| 64 | 4,970 | 386 / 548 ms | 630 / 977 / 1,332 ms | 0 |

The run cost $0.029 for 1,120 calls, about $0.000026 each.

UAT steps for an operator, since these are registry data, not migrations:

1. Ops registry: a new version of 1017 with `editor` in its slots and as the
   editor default, and its rates raised to 160 / 16 / 1100 micros (raise-only).
2. Ops capacity: change 1017's row to 76 / 56. The script fills only missing
   rows, and the UAT row exists.

Handed off:

- The UAT credits journey (`e2e/uat/journeys/credits.spec.ts`) drained the
  allowance through `/ai/command`, so it fails until it changes.
- Epo's rule: few, small LLM calls; set the counter near zero, then cross it
  with one ghost-text call.
- Journey database access is read-only, so the "Rust harness optimizations and
  security review" session designs the write path.
- The journey file is untouched here.

## 1. Cost

### Prices today (USD per 1M tokens: input / cached input / output)

| Pin | Route (elitellm order) | Price |
| --- | --- | --- |
| `deepseek/deepseek-v4-flash-0731` (older) | Reka | 0.05 / 0.04 / 0.28 |
| | DigitalOcean | 0.119 / 0.0238 / 0.238 |
| | StreamLake | 0.132 / 0.0042 / 0.396 |
| `deepseek/deepseek-v4.1-flash-1017` (newer) | InferenceNet | 0.08 / 0.008 / 0.55 |
| | Cloudflare | 0.10 / 0.003 / 0.60 |
| `qwen/qwen3.7-flash` (cheapest alternative) | Alibaba | 0.03 / 0.006 / 0.13 |

Every 0731 call went to Reka and every 1017 call to InferenceNet. OpenRouter's
reported `cost` matched Reka's list price exactly (for example, 339 input + 17
output tokens = $0.0000217).

The registry's credit rates for 0731 (42 / 12 / 1056 micros, set 2026-10-20 from
Reka's price at the time, human/agentic-retrieval.md:652) no longer match.
Reka's price today converts to 100 / 80 / 560 micros, so input is undercharged
and output overcharged. With ghost text's shape (input much larger than output)
we charge about 25% under cost.

### Per suggestion

Token counts below use the recommended prompt (section 3). They were measured at
96–418 input tokens and 3–21 output tokens. The figures use 380 in and 18 out,
which is a full 1,500-byte window.

| Model / route | Provider cost | Credits charged (registered rates) |
| --- | --- | --- |
| 0731 / Reka | $0.000024 | 0.035 (0.048 at today's Reka rates) |
| 0731 / DigitalOcean (2nd) | $0.000050 | same rates |
| 1017 / InferenceNet | $0.000040, $0.000022 with its 256-token prefix cache | 0.079, or 0.042 cached |
| Qwen3.7 Flash | $0.000014 | n/a |

1 credit = $0.0005 of provider cost (human/observability-metering.md:63), and the
user pays $1 per 1,000 credits.

Qwen3.7 Flash is cheaper but not clearly better. Its Beijing filter refused
Chinese history text in the 2026-10-15 descriptor bake-off, and our notes
include exactly that. 0731's cheaper Relace endpoint (0.0475 / 0.028 / 0.1568)
was dropped on 2026-10-20 after answering 429 to every call.

### Trigger rate and per active hour

Plate's `CopilotPlugin` (v53.3.3, `@platejs/ai/dist/react/index.js:1414-1438`)
auto-triggers only under all of these conditions:

- the caret is collapsed at the end of a block;
- the block's last character is a space;
- no suggestion is showing;
- no request is in flight (`isLoading`);
- the debounce has run out. Ours is 500 ms (`aiPlugins.ts`).

In practice it fires when the user pauses for half a second after a word. At
most one request is in flight at a time.

Estimate: about 8 requests per minute of actual typing (roughly a quarter of
word gaps at 35 wpm are ≥500 ms). Typing 25 minutes of an active hour gives
about 200 suggestions per hour; a heavy writer gets about 480.

| Per active hour | 200 suggestions | 480 suggestions |
| --- | --- | --- |
| 0731 / Reka | $0.005, 7 credits | $0.012, 17 credits |
| 1017 / InferenceNet | $0.008 ($0.004 cached), 16 credits (8 cached) | $0.019, 38 credits |

Free's 1,000 monthly credits cover about 140 active writing hours on 0731.

### Metering

The existing path stays as it is:

1. `POST /api/workspaces/{id}/ai/copilot` runs `beginProviderSession`. It uses
   surface `editor`, the resolved slot rates and `instant` thinking. It reserves
   0 credits. The gate is `used + reserved >= limit`, plus `ConcurrentLLMLeases`
   (5, shared with chat and generate).
2. Python binds `spendSessionId`. It writes a `provider_calls` row (`open`)
   before the call. The usage then lands as a `usage_events` row with surface
   `editor`, and Go's `charge.settle` closes the session.
3. Exhausted credits return 403 `llm_credits_exhausted` before any spend.
4. Route class `editor` limits each user to 120 per minute, with a burst of 30
   (`ratelimit.go:103`). That is far above ghost text's rate.

There is one gap: aborted requests. The interactive transport streams from the
provider, and usage arrives in the last event. A request the browser aborts is
therefore "abandoned unbilled" for the user, while OpenRouter has probably
already billed us for the input. Today Plate never aborts (see section 4), so
this only appears once abort-on-edit is added. At about $0.00002 per abort, it
is a small cost the platform absorbs.

## 2. Endpoint shape: chat/completions, not streamed to the browser

| Shape | 0731 (Reka) | 1017 (InferenceNet) |
| --- | --- | --- |
| `/chat/completions` + system prompt | Good continuations | Good continuations |
| `/completions` (raw prompt) | Chat template applied: it answers the note as an assistant ("你提供的背景信息非常準確…", `**bold**`). Unusable. | Real continuation, but it runs on to `max_tokens` with no sentence stop |
| FIM (`suffix`) | Not supported: no endpoint lists `suffix` in `supported_parameters`, and output was the same with and without it | Same |

Latency (median / p90, ms, from the Mac):

| Pin | Calls | First token | Total |
| --- | --- | --- | --- |
| 0731 chat | 24 | 1244 / 1597 | 1555 / 1887 (max 3749) |
| 1017 chat | 24 | 896 / 1125 | 1014 / 1725 (max 2873) |

A suggestion is about 17 output tokens, so first token ≈ total: the median gap
is 100–300 ms. Streaming text into ghost text would mostly add flicker. Keep
the browser contract as one JSON response (today's route). Python already
streams from the provider, which is what lets an abort reach it.

The gateway and pipeline hops add some time on top of these figures. I did not
measure UAT end to end.

1017 is about 0.5 s faster and uses the text after the caret better. 0731 costs
about 60% of 1017 before 1017's cache. For something shown while typing, 0.5 s
is noticeable.

## 3. Prompt

Recommended (server-owned):

```
system: You complete the user's note at <CARET>. Reply with only the text that
goes at the caret: at most one sentence, in the note's language, no Markdown,
no repetition of the text before or after it. Reply with nothing if no
continuation fits.
user:   Title: {note title}

        {≤1,500 UTF-8 bytes of Markdown before the caret, starting at a block start}<CARET>{rest of the current block}
params: max_tokens 40, temperature 0.2, reasoning {enabled: false}, stop ["\n"]
```

What each part is for:

- **Text before the caret: needed.** Today's prompt sends only the current
  block. That works for in-paragraph continuation but loses the heading and
  earlier blocks.
- **Window size.** 1,500 bytes is about 340 tokens in English and about 420 in
  Chinese. UTF-8 bytes track tokens evenly across both scripts (about 3.5
  bytes per token in each), so one byte cap fits both languages.
- **Title: cheap (about 5–10 tokens).** It matters when the window has
  scrolled past the top of the note. I did not A/B test it.
- **Nearby headings: no extra field.** They come in with the window.
- **Language: no field.** All 48 chat calls answered in the note's language
  and script (Traditional Chinese stayed Traditional).
- **Text after the caret: the current block only.** When the after-text
  included the next section ("## 武昌起義…"), 0731 continued from the wrong
  place in both tries ("革命黨人迅速佔領武漢三鎮…" right after the 1898 reform
  sentence). Within the same block it helps: mid-sentence 0731 gives "103天便遭慈禧太后發動政變鎮壓。"
  and the shorter "the price changes." when the rest of the sentence follows.
- **`stop ["\n"]` and `max_tokens` 40** keep a suggestion inside the block. The
  longest chat answer was 40 tokens, in Chinese.
- **The "Return 0" sentinel and `stripMarkdown`** become "reply with nothing".
  I did not test whether the models leave the reply empty when nothing fits;
  they always suggested something.

Examples (recommended prompt, 0731 unless noted):

| Note | Input tokens | Suggestion |
| --- | --- | --- |
| EN cell respiration, 1,222 chars, caret after "giving in total" | 339 | "6 NADH, 2 FADH2, and 2 ATP per glucose." |
| ZH 辛亥革命, 469 chars, caret after "清廷從湖北調兵入川鎮壓，" | 418 | "武昌因此兵力空虛，革命黨人趁機發動起義。" (1017: "導致武漢兵力空虛，為武昌起義提供了時機。") |
| ZH mid-sentence, after-text "，慈禧太后便發動政變。" | 96 | "103天便遭慈禧太后發動政變鎮壓。" (1017: "103天") |
| EN elasticity, same-block after-text | 93 | "the price changes." |
| Today's prompt (block only), EN glycolysis | 57 | "two molecules of pyruvate, producing a net gain of two ATP and two NADH." |

The two models disagree on whitespace: 0731 drops the leading space ("two…"
after "split into") and 1017 keeps it (" two…"). The join needs one rule; see Q8.

## 4. Fit with what exists

### Server route today

The browser calls `POST /api/workspaces/{id}/ai/copilot`
(`server/internal/httpapi/ai_plate.go:325`), which goes to Python
`/plate-ai/copilot` (`pipeline/pipeline/retrieve/ai_adapter.py:735`). Python
calls the model with `max_tokens` 50, temperature 0.7 and reasoning off. The
model comes from the user's editor-slot pick (`users.editor_model_*`, Settings
→ LLM, behind the flag).

### Model catalog

Both pins are in the OpenRouter allowlist: `server/internal/models/elitellm_providers.json`
and `pipeline/pipeline/elitellm/providers.json`. Their routes are set in
`pipeline/pipeline/elitellm/client.py:36-43`, and their capacity rows in
`deploy/model-capacities.sql:49-50` (0731 at 32, 1017 at 64; neither has an
interactive reserve). Today 0731 is the ingest descriptor model and 1017 the
captioning model. Adding the `editor` slot is a registry edit (UAT data).

### Capacity probes so far

The raw data is in `C:/WEB/capy-harness` on the PC. Each probe was a one-shot
burst. None measured first-token latency, requests per minute under sustained
load, or ghost-text-sized prompts, so the figures below are an upper bound on
how ghost text would behave, not a measurement of it.

0731, 2026-10-20 (`2026-10-19-vlm-routing/SUMMARY-ROUTE.md`, `runs/summary-route/*.jsonl`).
File summaries of up to ~8k tokens in and ~75 out; total latency as median / p95:

| Provider | Alone | 16 at once | 32 at once |
| --- | --- | --- | --- |
| Reka | 2.1 s | 2.6 / 3.0 s | 3.2 / 6.9 s |
| DigitalOcean | 2.9 s | 3.7 / 4.6 s | 5.7 / 7.8 s |
| StreamLake | 2.9 s | 3.2 / 4.1 s (max 25.2) | 4.0 / 7.1 s |

- Routed through all three at 32 at once: 3.1 / 5.1 s, every call served by Reka.
- Rejected routes: DeepInfra answered 429 after 1 of 4 calls and BaseTen after 2 of 4.
- No raw data was found for "Relace held 96 in flight (2026-10-15)".

1017, 2026-10-21 (`2026-10-21-glm-route/REPORT.md`, `runs/a2/burst-*.jsonl`).
Page reads, ~753 tokens in and ~300 out, no 429s; total latency as p50 / p95:

| Provider | 32 at once | 64 at once | 128 at once |
| --- | --- | --- | --- |
| InferenceNet | 2.7 / 4.9 s | 3.4 / 6.5 s | 4.8 / 8.6 s |
| Cloudflare | 4.8 / 8.1 s | 5.8 / 10.1 s | — |

Before choosing a reserve (Q6), run one short sustained probe from the ingest
host on the chosen pin. Use the recommended prompt (about 400 in, 20 out) at 16,
32 and 64 in flight, and record first-token time, total time, requests per
minute and 429s.

### Keep

- The Go route: editor-role check, live authorization, metering, rate class.
- The Python `/plate-ai/copilot` handler: capacity refusal, call slot,
  accounting bind.
- `CopilotPlugin` with the `GhostText` renderer.
- `features.editorAi` / `VITE_FEATURE_EDITOR_AI`.

### Delete: the AI menu

Frontend:

- `src/features/notes/ai/AiMenu.tsx`, `aiMenuState.ts` (+ test),
  `aiPreviewState.ts` (+ test).
- `AIChatPlugin`, `AIPlugin` and `CursorOverlayPlugin` in `aiPlugins.ts`.
- `AiLeaf`, `AiAnchorElement`, `AiLoadingBar` and `AiCursorOverlay` in
  `PlateAi.tsx`.
- The AI entries in `NoteToolbar.tsx`, `FloatingToolbar.tsx`,
  `BlockInteractions.tsx` and `NoteEditorCore.tsx`.
- `createPlateAiTransport` and `plateAiCommandUrl` in `src/api/plateAiTransport.ts` (+ test).
- The comment in `merge/applyBlocks.ts:22`.
- Analytics `editor_ai_used`, the menu strings in `messages/*.json`, and the
  AI parts of `e2e/editor/ui-motion.spec.ts`.

Server:

- Go `aiCommand`, `copyAIDataStream` and `plateCommandReq`, the `/ai/command`
  route, and its ratelimit `classAI` entry.
- Python `/plate-ai/command`, `PlateCommandReq` and the command prompts.

Docs: the openwiki editor AI sections.

`aiPreviewState.ts` is on the Rust harness's open AI-edit defect list
(2026-10-21), so tell that session before deleting it.

### Missing or wrong

1. **The MI:225 keys are not in the code.** `aiPlugins.ts` still binds
   `ctrl+space` and `mod+right`, and on a Mac `mod` is ⌘.
2. **Chinese never auto-triggers.** The trigger needs a trailing space.
3. **Stale requests are not cancelled.** Plate's `reject()` returns early when
   no suggestion is showing, so typing does not abort an in-flight request. New
   triggers are skipped while it loads, and its answer lands as a stale
   suggestion after the user has typed on. The fix: abort on any document or
   selection change while loading, and drop an answer whose `before` no longer
   matches.
4. **The browser sends `instructions` and `system`** (up to 8 KB each). Anyone
   with editor access can run arbitrary prompts on our key, though only 50
   tokens at a time and billed to them. The fix: the server owns the prompt,
   the body becomes `{title, before, after}`, and Python's default-instructions
   fallback is deleted.
5. **The model follows the user's editor pick, not a fixed pin** (see Q4).
6. **Every failed suggestion raises an error toast** (`onError`). That is noisy
   for an automatic feature (see Q5).
7. **The rate and capacity entries aren't set for this use.** 0731's credit
   rates are stale (see section 1), and the chosen pin's capacity row has no
   interactive reserve, so an ingest burst on 0731 (32 in flight) would refuse
   every ghost text call with `provider_busy`.

## 5. BlockSuite later

The server side is shared unchanged: the same route, the same `{title, before,
after}` body and the same prompt. Only the trigger and the overlay are written
per editor. One framework-free module, `ghostText.ts`, would hold the parts
both editors share:

- the trigger rule;
- the 500 ms debounce;
- the AbortController and the stale-answer check;
- the request;
- the whitespace join.

In BlockSuite (vendored `framework/std/src/inline/inline-editor.ts` on
`blocksuite-notes`):

- **Trigger.** Listen to the focused block's `inlineEditor.slots.textChange`
  and `inlineRangeSync`. Fire when the range is collapsed at
  `yTextLength`, `!isComposing`, and the last character fits the trigger rule.
- **Context.** `before` walks the note's blocks back from the current one and
  serialises them with the same Markdown export the note uses; `after` is the
  rest of `yTextString`.
- **Overlay.** An absolutely positioned widget on the editor host. Its top-left
  is `toDomRange(range).getBoundingClientRect()`, its width is the block's
  content box, and `text-indent` is set to the caret's x offset, so wrapped
  lines follow the block like inline text. Nothing is written into the
  inline editor's DOM, which lit re-renders.
- **Keys.** A capture-phase keydown on the host that acts only while a
  suggestion shows: Tab accepts, Esc rejects, ⌥→ / Ctrl+→ accepts a word, and
  ⌥Space / Ctrl+Space asks for a suggestion. Any other key, a click or blur
  rejects.
- **Accept.** `inlineEditor.insertText({index, length: 0}, text)` then
  `setInlineRange`, as one Yjs transaction, so it is one Undo step.

This is option 15a in `todo-blocksuite-decisions.md`, with D19 as the answer
to Q5.

## Epo's answers (2026-10-28) and what is still open

Recorded in `human/frontend/plate-editor.md` and `human/observability-metering.md`.

| # | Answer |
| --- | --- |
| 1 Model | Either is fine; pick it once 6 is settled. **Open: see the proposal below.** |
| 2 Prompt | As recommended. `max_tokens` 40 is cut straight, with no trimming back to a word. |
| 3 Chinese trigger | Yes. |
| 4 Fixed pin | Yes: the editor picker and `users.editor_model_*` go. |
| 5 Errors | Yes. Epo asked how the browser knows credits are out; answered below. |
| 6 Capacity | Probably yes. **Open: numbers proposed below.** |
| 7 Rates | Check OpenRouter; rates are only ever raised, never lowered. |
| 8 Whitespace | Yes. |

### How the browser knows credits are out (5)

Before any provider spend, `/ai/copilot` opens a provider session. With no
credits left, the gate answers **403 with body `code: "llm_credits_exhausted"`**:

- the body also carries `creditsUsedMicros`, `creditsLimitMicros`,
  `creditsPurchasedMicros` and `planTier` (`server/internal/httpapi/server.go:613-623`);
- the copilot case is covered in `server/internal/httpapi/billing_gates_test.go:150-153`.

The browser already recognises it:

- `isCreditsExhaustedError` (`src/api/client.ts:52`) checks an `ApiError`'s code;
- `errorKind` maps it to `'credits'` (`src/lib/errors.ts:80`);
- chat handles the same code in `src/api/chatStream.ts:134`.

Ghost text can't use this today. Plate's `callCompletionApi` throws
`new Error(await res.text())`, which drops the status and code. The ghost-text
fetch needs to build an `ApiError` the way the rest of the API client does,
then check `isCreditsExhaustedError`. Every other failure stays silent: 503
`provider_busy`, 429 rate limit, network and 5xx.

Nothing pushes "credits ran out" to the browser; the server reports it only in
the refused response. The `billing` event on the user's event stream
(`server/internal/httpapi/sse_events.go:44-48`, handled at `src/api/hooks.ts:408`)
only says billing changed, after a purchase, top-up or reload. Under 5,
auto-trigger stays off until the page reloads. That same event could switch it
back on after a top-up, but this is not decided.

### Rates (7), OpenRouter prices rechecked 2026-10-28

| Pin, first route | Registered (micros: input / cached / output) | List price now | Raised to |
| --- | --- | --- | --- |
| 0731, Reka | 42 / 12 / 1056 | 100 / 80 / 560 | **100 / 80 / 1056** |
| 1017, InferenceNet | 160 / 16 / 1000 | 160 / 16 / 1100 | **160 / 16 / 1100** |

Each rate keeps the greater of the two, as a new registry version.

Fallback routes cost more than the first route: 0731 on DigitalOcean is
238 / 48 / 476 and 1017 on Cloudflare is 200 / 6 / 1200. A call served by a
fallback is therefore charged under its cost, as with every OpenRouter pin today.

At the raised rates, with 380 tokens in and 18 out:

| Pin | Credits per suggestion | Credits per active hour (200 / 480 suggestions) |
| --- | --- | --- |
| 0731 | 0.057 | 11 / 27 |
| 1017 | 0.081 (0.044 when its 256-token cache hits) | 16 / 39 (9 / 21 cached) |

### Proposal for 6 and 1

Interactive reserves:

| Pin | Production (total / reserved for interactive) | UAT and local | What the other user keeps |
| --- | --- | --- | --- |
| 0731 | 32 / 16 | 8 / 4 | ingest file summaries drop from 32 to 16 in flight |
| 1017 | 64 / 32 | 16 / 8 | standalone image captions keep 32; page reads have their own `vlm_page` gate and are unaffected |

What 16 slots for ghost text serve, at 1–1.5 s per call: 640–960 calls a
minute, about 80 people typing at the same time at 8 suggestions a minute, or
about 190 active writers at 200 suggestions an hour.

**I recommend 1017 for the pin.**

- It is faster: a median of 1.0 s against 1.55 s.
- It has more headroom. InferenceNet was probed up to 128 calls at once
  (p95 8.6 s with larger page reads). Ghost text sits inside that tested load
  even when the row and `vlm_page` are both full. 0731's 32 is the most Reka was
  probed at, and at 32 Reka's median rose to 3.2 s and its p95 to 6.9 s. An
  ingest burst would put ghost text in that slow zone.
- Page reads and image captions are bursty but rarer than file summaries, which
  run for every upload.
- It costs about 40% more credits uncached (0.081 against 0.057 per
  suggestion) and about 25% less when its cache hits.

Before the reserve is final, run one sustained probe of ghost-text-sized calls
(about 400 in, 20 out) on the chosen pin from the ingest host, at 16, 32 and 64
in flight. Nothing measured so far used calls that small.

### Before building

- The Rust harness session cleared deleting `aiPreviewState.ts` (2026-10-28).
  Nothing depends on it: agent and chat edits write through the room, and the
  2026-10-21 AI-accept defects lived inside it, so they retire with it. When
  deleting, also:
  - reword the comment at `src/features/notes/merge/applyBlocks.ts:22` to
    describe the flush → stopCapturing → withoutNormalizing pattern itself;
  - remove `/ai/command` from `server/internal/ratelimit/middleware.go:47`;
  - remove its MSW handler (`src/mocks/handlers.ts:2752`) and
    `src/mocks/scenarioFailures.ts:361`;
  - keep `plateAiTransport.ts` only if ghost text reuses it.

  Ask that session before pushing to main. Its land-time gates:
  - `gen:api` with no diff;
  - `review:validate-boundaries`;
  - `pnpm run check`;
  - every test file that calls a changed function;
  - CI's clippy on current stable, if Rust is touched.
- Nothing is built beyond this doc until Epo confirms the pin.
