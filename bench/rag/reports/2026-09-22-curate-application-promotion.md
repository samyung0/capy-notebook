# Curate application promotion

The application now uses the tested playground excerpt retention and ledger
updates. The playground calls those shared implementations directly, with no
retention or ledger-schema overrides. `curate-new` is consolidated into `curate`,
which uses the application prompt and tool descriptions rather than saved copies.

## Changes

- Successful material creation/editing retains the exact bounded read results
  for the supplied excerpt IDs in private `toolEvidence.libraryExcerpts`.
  Follow-ups revalidate against the current library and replay each read page
  once, at its latest owning turn. Full retained text surviving compaction counts
  as read. Changed, missing or compacted evidence requires another read.
- `create_ledger` accepts strings for additions and `{id, todo}` for adding or
  overwriting an ID. Unmentioned todos remain. A non-null body replaces the body,
  including an empty string; null/omission preserves it. Repeated corrections
  preserve completion, reads, material history and IDs. Only the first changed
  plan per turn counts as progress. Ten unfinished todos remains the bound.
- Contract v8 declares ledger mutations and `used_excerpts` retention. Go's
  existing opaque private evidence persistence needs no database migration.
- Curate allows four tools per response and 160 per turn. Previously its
  `tools_per_turn` setting was ignored. The total cap now produces one final
  tools-off response with `tool_cap`; five responses without progress trigger
  `curate_stall`, with the existing two-write error allowance. Ordinary chat's
  limits are unchanged.
- The prompt adopts the learner scope/difficulty/material-type clarification
  sequence, writing once evidence is sufficient, and page capture for apparent
  numerical/formula corruption. The subject catalog and role descriptions stay
  available from the first call. Workspace read tools remain offered in the app.

This promotes the interactive preset. The separate twenty-preview search
experiment remains benchmark-only; these runs use the existing five-hit search
with reviewed scope and hit text. No reranker, chunking or deduplication change.

## Real agent-loop checks

All turns used Tencent TokenHub `glm-5.3-flash`, high reasoning, the shared library
in read-only transactions and local material writes. They ran through the
playground HTTP endpoint with the application prompt and handlers. Live database
material mutations/deployment were not exercised. Source-PDF captures were
available but unnecessary in these cases.

| Case | Run | Search / read / writes | Result | Seconds |
| --- | --- | --- | --- | ---: |
| Introductory college diffusion/osmosis note | `20260922-012219-b1b9d9` | 1 / 4 / 1 | Note saved, four read results retained | 65.92 |
| Four flashcards on the same material | `20260922-012325-b33f0a` | 0 / 0 / 1 | Four cards saved directly from retained text | 42.52 |
| Correct an existing todo and replace the body | `20260922-012527-852ad9` | 0 / 0 / 1 | Todo 0 overwritten and completed; earlier materials and next-ID counter preserved | 44.23 |
| Missing level and material type, after prompt correction | `20260922-013133-01f5e7` | 0 / 0 / 0 | Asked for clarification; no ledger or materials created | 18.90 |

All four cases had zero refused writes. The flashcard follow-up started with
9,493 provider-reported input tokens, including retained evidence, versus 5,477
on the initial note request. Its estimated prior-history component was 4,560
tokens. The absence of model read calls does not mean zero database reads:
revalidation still checked the saved excerpts using the read-only library.

The ledger case continued the first two runs' history and evidence, with a local
fixture adding stale todo 0, “Await learner's choice of level and material type”.
The request explicitly corrected that same ID and replaced the body. The resulting
counter stayed at 3, all previous materials survived, and todo 0 completed in the
new note. It did not allocate a replacement todo or perform new retrieval.

The first clarification attempt, `20260922-012611-2fe6af`, failed behaviorally:
“I want to study cell biology” caused the model to choose college-intro level and
create a note, 28 cards and a 20-question quiz. It made 14 tool calls over 169.37
seconds. The prompt was then tightened to preserve the preset's MUST-clarify
intent: before any tool call, missing requirements must be obtained from the
learner rather than chosen. The same request then passed as recorded above.
This is one diagnostic retest, not a reliability estimate across vague requests.

The small diffusion/osmosis outputs track the source passages read. Word limits
remain soft: the first note has 287 whitespace-separated words including headings
and attribution against a 250-word request; the comparison note has 172 against
150. No broader quiz-accuracy claim follows from these mechanism tests. These
live runs neither reached 160 calls nor triggered compaction; cap termination and
compaction revoking inherited read permission are covered offline.

Local receipts are under `lab/playground/local/runs/<run>/run.json`, with exact
prompts, schemas, calls, provider usage, history, evidence and material files.
The two-turn reuse check is reproducible with:

```sh
.venv/bin/python bench/rag/scripts/knowledge_retention_agent.py --config curate
```

## Verification

- Pipeline offline suite: 806 passed, 125 integration tests deselected.
- Focused agent/retrieval checks: 147 passed, including retained create/edit
  evidence, changed/missing/compacted sources, stable ledger upserts, atomic
  invalid updates, stall progress and one terminal response at the tool cap.
- Go contract checks passed, including generated contract parity. Disposable-DB
  store checks passed, including retained library evidence round-trip and its
  exclusion from browser message JSON.
- Playground Python and UI checks passed; Python and Go formatting passed.
- Browser verification shows only `chat` and `curate`, with `curate` selected,
  the production prompt, high GLM effort and 160 tools per turn.

The independent [workspace follow-up](2026-09-22-workspace-terminal-agentic.md)
completed 14 turns. It supports an explicit final-answer instruction as the next
candidate, with forced-final refusal behavior and the application transport still
to check. Workspace ranking/catalog defaults remain unchanged.
