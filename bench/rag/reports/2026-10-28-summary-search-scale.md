# Account chat summary search at scale (2026-10-28)

Account chat's `search_files_summary` matches a query against the names and
~50-word summaries (`rag_content_summaries.descriptor`) of every file and
material the user reaches: their owned and member workspaces (at most 50, the
workspace cap, of at most 100 files each) and their own items with no
workspace. The first version listed that whole scope through Go each turn,
prepared every name and summary with the unindexed-edit hints' matcher in
Python, and had Postgres build a text vector for each one on every call.
Epo asked how that behaves with many documents and whether summaries could be
indexed by workspace.

## Setup

- `scripts/summary_search_scale.py` against a throwaway
  `pgvector/pgvector:pg16` container on the prod host (Coolify only; 2 CPUs and
  3 GB for the container, `shared_buffers` 512 MB, `work_mem` 64 MB), driven
  from a Mac over an SSH tunnel; container removed afterwards.
- 1.2 million synthetic items: 10,000 workspaces of 100 plus 200,000 with no
  workspace, each with a 50-word summary drawn Zipf-like from 20,000 words and
  a name holding one such word. One user reaches 50 full workspaces and 2,000
  items of their own, 7,000 items in all.
- Text vectors with the `simple` configuration (production uses the
  pipeline's tokenizer and each summary's language configuration, as passages
  do; the costs compare the same way).
- Server-side times (`EXPLAIN ANALYZE`), warm, median of 5. Python prep timed
  separately on the Mac with `pending_hints._prepare`.

## Strategies

- **A, the first version:** the scope's items, a text vector built for each
  name and summary on every call.
- **B, a stored column, scope first:** each summary row stores its vector; the
  query takes the scope's items through their indexes (`files.workspace_id`,
  `files.user_id`, and the materials' equivalents), then matches their
  summaries' column. No index on the column.
- **C, a global GIN index** on the stored column, the scope applied after.
- **D, "by workspace":** summaries carry no workspace (since 0126 they are
  content rows shared by identical files), so D copies each item's name and
  summary onto the item row under a `(workspace_id, tsv)` GIN index
  (`btree_gin`).

## Results (ms per call)

| Query | A today | B column, scope first | C global GIN | D per-workspace GIN | Matches in the whole database |
|---|---|---|---|---|---|
| a rare word | 271.7 | 11.7 | 11.4 | 1.0 | 390 |
| a common word | 429.9 | 71.4 | 67.4 | 26.8 | 1,051,969 |
| two words | 287.1 | 59.2 | 53.8 | 64.3 | 146,605 |

Building them for 1.2 million rows: the stored column 69 s, C's index 35 s
(177 MB, the summaries table 1,576 MB), D's copy and index 92 s (243 MB).

A also costs, before its SQL: the first summary search of a turn prepared
every name and summary in Python, 2.8 s for 1,000 items and 5.8 s for 7,000,
and every call sent that text (3.2 MB at 7,000) to Postgres. It also listed the
whole scope through Go each turn.

## Findings

- A grows with the scope on every call; B grows only with the matching
  rows inside it, 5 to 23 times faster here, with no per-turn listing and no
  Python preparation.
- C buys nothing over B: the planner narrows to the scope either way, and a
  common word matches a million rows globally.
- D is fastest on a rare word (1 ms) but no better on two words, and needs
  every rename and every new summary to refresh its copies on file and
  material rows, plus a 243 MB index. Summaries themselves cannot be indexed
  by workspace, as one summary serves identical files in many workspaces.
- Summaries are rewritten only when a document's text changes by 2% or more
  (`SUMMARY_REUSE_SHARE`), and short text files have none, so building the
  vector when a summary is written adds nothing noticeable.

## Decision

Epo picked B (2026-10-28): `rag_content_summaries.lang` and `.search` written
with each summary (`store.summary_search_text`, also copied by clones and
moves), and `store.summary_search` narrows to the turn's workspaces and the
user's own items, matches names (`ILIKE` on the query's words of three or more
letters, or CJK runs) and the stored column, ranks name matches first, and
returns ten; Go's access check then runs on those hits alone. A summary
written before the column existed is found by its file's name until it is
written again.

## Raw output

```
generated 1200000 items in 33s
tsv column 69s, global GIN 35s (177 MB), per-item ws GIN 92s (243 MB); summaries table 1576 MB

ms per call (median of 5), scope = 50 workspaces x 100 + 2,000 own items
rare word (w15000)       A today   271.7  B scope+column   11.7  C global GIN    11.4  D ws GIN    1.0   (global matches 390)
common word (w2)         A today   429.9  B scope+column   71.4  C global GIN    67.4  D ws GIN   26.8   (global matches 1,051,969)
two words (w40 | w900)   A today   287.1  B scope+column   59.2  C global GIN    53.8  D ws GIN   64.3   (global matches 146,605)

prepare 1000 names+summaries: 2.79s, 0.5 MB of text sent per match call
prepare 7000 names+summaries: 5.82s, 3.2 MB of text sent per match call
```
