# Prompt and tool tuning: handoff (2026-10-30)

Where the chat agent's prompt and tool tuning stands. Setup and every config
field are in `README.md`; the scenarios are its Acceptance table. Running notes
and raw measurements of the 2026-10-30 session are outside the repository, in
`C:/WEB/capy-harness/2026-10-30-playground-tuning/NOTES.md`.

## Models (UAT `model_configs`, 2026-10-30)

| Pin | Route | Use |
|---|---|---|
| `deepseek/deepseek-flash` v9 | DeepSeek's own API, thinking high, temperature 0.3 | chat default |
| `openrouter/minimax/minimax-m3.1-flash` v1 | OpenRouter: Together, then DigitalOcean | chat |
| `zai/glm-5.3-flash` v3 | OpenRouter (`z-ai/glm-5.3-flash`) | chat |

## What a turn sends now

- **System prompt**: workspace chat 17.7k characters, account chat 18.9k; the
  OpenUI answer format (`prompts/openui_lang.txt`, generated from
  `src/features/workspace/chat/schema.ts` by `pnpm gen:openui`) is 10.2k of
  either. Security, grounding, sources, answer or build ("plan first as the
  editing skill says"), the budget line, then the all sources rules and the
  answer format.
- **Skills** (`prompts/skills.py`), read with `read_skill`: `editing`,
  `note_building`, `deck_building` (with the `editorial` style and its
  reference slides), `office_building`; account chat has its own wording of
  each. Writes are refused until the skill's text is in the request.
- **Tool arguments** are offered in writing order, required first
  (`tools.ARGUMENT_ORDER`, 2026-10-30).
- **Turn context**, a user message after every tool batch: study preferences,
  library excerpts read, and the allowance line; the last response gets
  "Tools are off for this response", with the tools still offered under the
  default `tool_choice`.
- **Limits** (`retrieval/limits.py`): 4 tool calls per response; 12 responses
  before the first write, the last with tools off; after a write, 160 tool
  calls and the stall guard (5 responses without a write, more after errored
  writes); the loop ladder logs a repeated identical call at 2, refuses it
  from 3 and ends the turn at 6.

## Measuring

- **Single turns** in the playground. Workspace chat takes `workspace_id`;
  account chat takes `account` (`configs/account-uat.json`). Real UAT chats
  imported with `scripts/import_chat.py` open as runs to continue.
- **Counts that need many samples** run on the UAT host, not this PC (Epo's
  rule), in a throwaway container from the retrieval image: the loop-trace
  harness captures one real turn's requests and a replay script sends the
  final request again with one change. Scripts:
  `C:/WEB/capy-harness/2026-10-30-playground-tuning/scripts/`.
- **Forcing an answer:** do not use `tool_choice: "none"`. DeepSeek then writes
  its tool call as DSML text (16 of 20 runs). Use production's tools-off notice
  instead (`format_replay.py --final-notice`).

## Findings 2026-10-30

- **Answer format** (handed to the OpenUI session, which owns it now): DeepSeek
  Flash breaks programs with a bare `"` inside a string, Python-style
  `Md("""…""")`, statements root never lists (silently dropped), a program
  with no root, and its reasoning written after the program; MiniMax writes
  `[n]` markers inside text. The UAT case `conv_a8be00792c` was bare quotes
  only; its second `root` is harmless (the later root wins).
- **Answer quality** (observed, not yet measured): "teach me X" is handled
  three ways (GLM v3 answered with only the offer, MiniMax with only a plan,
  DeepSeek with a short explanation and a plan); answers open with file
  bookkeeping and source attribution in prose; DeepSeek adds scope nobody
  asked for.
- **Decks** (Q590): paragraphs are one `<text>` with `<tspan>` lines in the
  editorial style; adoption measured in the playground.
- **Loop-trace fixes hold on UAT**: the one deck turn since the deploy wrote
  slides 1–12 once each with no rebuild; a MiniMax replay exported its deck
  with the long Physics credit.

## Caching (2026-10-05, GLM on Relace; the route has changed since)

- A provider that caches where an earlier call ended only hits when the next
  request extends the previous one exactly, reasoning and tool-call arguments
  included. That is why the turn context is appended and kept in place, and
  why a written slide's SVG stays in the history (`DECKS.md`, Measured).
- Tools-off calls keep the tools under the default `tool_choice`: Relace
  drops them from the prompt under `"none"`, which missed the cache.

## Measurements to compare against (2026-10-05)

| What | Tokens |
|---|---|
| Passage in a tool result | about 290 (header 50, text 220 median, location line 19) |
| One `search_workspace` (5 passages) | about 1.5k, carried on every later call |
| A 4-question quiz as `create_material` arguments | about 1.4k |
| A three-section explainer note | about 2.6k |
| One slide as `write_slide` arguments (2k to 4.5k characters of SVG) | about 1k |

## Open questions

- Split the OpenUI answer format (core components in the prompt, rich ones in
  a skill), now with the OpenUI session.
- Which answer-quality issues to tune first, and how to judge them (a rubric
  over the imported chats, per model).
