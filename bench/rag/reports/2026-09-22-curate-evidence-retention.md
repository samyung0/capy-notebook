# Curate excerpt retention in the playground

The playground now retains the exact bounded `read_knowledge` text for excerpt
IDs used in successful material creation or editing. Follow-ups replay that text
as untrusted source history and can write from it without an agent reread. The
application's retention policy has not changed.

Replay deduplicates each excerpt ID/start position at its latest use. It checks
saved text against the current library with read-only queries. Retained evidence
surviving compaction counts as read; an ID or compacted summary alone does not.
Failed writes and unused reads add no retained evidence. Existing saved runs
have no library snapshots; retention begins with new successful writes.

## Live agent check

Used the existing `curate-new` config unchanged: GLM-5.3-Flash, high thinking,
Tencent TokenHub. Both databases were configured read-only by the local server
launcher; generated materials stayed under `lab/playground/local/runs`.

```sh
python3 bench/rag/scripts/knowledge_retention_agent.py --config curate-new
```

| Measure | First turn | Follow-up |
| --- | --- | --- |
| Request | Short introductory note on diffusion and osmosis | Four flashcards on the same material |
| Run | `20260922-003048-9ad9e1` | `20260922-003213-759f8b` |
| Agent search calls | 1 | 0 |
| Agent read calls | 4 | 0 |
| Other tool calls | Create ledger, create note | Create ledger, create flashcards |
| Refused tools | 0 | 0 |
| Retained excerpt pages | 4 | 4 |
| First provider-reported input tokens | 5,522 | 9,609 |
| First estimated history tokens | 0 | 4,621 |
| Elapsed seconds | 84.89 | 46.31 |

All four saved snapshots exactly matched the bounded tool results in the first
run. The follow-up's first ledger event contained all four retained reads, and
the material write succeeded without any search/read tool call. Automatic
library revalidation still reads the database; zero agent reads does not mean
zero database reads.

This checks the retention behavior for one real two-turn conversation, not broad
retrieval or material quality. The first note exceeded the requested 250-word
limit at 411 whitespace-delimited words. The follow-up produced exactly four
cards. Production promotion remains a separate step.

## Offline checks

`playground.py --check` verifies create/edit selection, refusal and unused-read
exclusion, paginated text, duplicate replay, provenance checks on reuse,
compaction revoking inherited read permission, fresh rereads, and changed or
missing source rejection. The UI self-check carries `libraryExcerpts` through
follow-up requests and saved-run restoration. Both pass, as do formatting and
lint checks.

## Ledger correction follow-up

The playground also accepts `{id, todo}` entries to add a fresh ID or overwrite
an existing todo's text. Unmentioned todos stay unchanged. Non-null `body`
replaces the ledger body; null or omission preserves it. Repeated corrections
do not count as additional stall progress. Completion still comes from material
writes, and the ten-open-todo limit remains.

Copied saved conversation `20260922-005540-0790ad`, including its retained
evidence, into a separate local follow-up. That conversation had four completed
materials and stale open todo 0, “Await learner's choice of level and material
type, then plan cell biology materials.” Asked GLM high to rewrite todo 0 as a
short prokaryotic/eukaryotic comparison note, replace the body with that goal,
keep the ID, and write from retained sources.

Run `20260922-010311-87aee1` succeeded in 89 seconds. The agent called
`create_ledger` with `{id: 0, todo: ...}` and a replacement body, then
`create_material` with `todo: 0`. Both succeeded, with no search/read tool calls
or refusals. The body became one current-plan entry, the ID counter stayed at
5, all four previous material records remained, and the new note completed
todo 0. The user's open browser conversation was left unchanged by this test.
The live prompt preview exposed the same update schema and tool description.

`check_curate_ledger.py`, included in `playground.py --check`, covers duplicate
IDs, new explicit IDs, null/omitted/empty bodies, preservation of other entries
and completion, updates at capacity, atomic failures, stable stored IDs and
repeated edits leaving stall progress unchanged. The HTTP turn self-check also
exercises the update through the playground's actual tool wrapper. All pass.
