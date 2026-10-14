# Library flow: browse first, search by subject, sections (2026-10-14)

The chat agent's library tools against three reshaped flows, in the lab
playground on the Mac. One run per request; quality was not judged.

## Setup

- Model: GLM-5.3-Flash at high reasoning (production chat default), lab
  target (`odl_eval_odl_nocaption`), live library, decks off, local bank
  restore on (the bank tools were removed from production later the same day,
  dc3261d6; every arm had them).
- 16 requests from `bench/rag/intake/fixtures/requests.json`, `--once`:
  stat-01, 05, 08, 09, 10, 12, 16, 18, 24; gen-02, 03, 07; form-01, 04, 06,
  08. Two are scope controls (stat-16 CRISPR in a statistics course, stat-24
  the spectral theorem).
- Playground with the `inspect_document`/`edit_document` stand-in
  (d1074a48), so growing notes no longer split into "Part 2" notes.
- Arms, one playground process each (`library_flow` in
  `lab/playground/README.md`):

| Arm | Config | What changes |
| --- | --- | --- |
| Production | `intake-a` | Production rules and tools |
| Browse first | `flow-browse-first` | Rules say browse the subject first; `browse_knowledge` takes only `subject` (topics with counts) |
| Search by subject | `flow-search-subject` | `search_knowledge` takes a `subject` id instead of `topics`; `browse_knowledge` is gone and its subject list moves into search's description |
| Sections | `intake-c`, `CAPY_LIBRARY_SECTION_TOOLS=1` | The 2026-10-07 section-reading arm |

Raw records, the driver (`drive.sh`) and `analyze.py` are in the ignored
`bench/rag/reports/local/2026-10-14-library-flow/`.

## Results

Three turns failed on the provider (two 429 "busy", one stream silent for
120 s), in browse first (form-01, stat-24) and search by subject (form-08).
Totals below are over the 13 requests every arm completed.

| | Production | Browse first | Search by subject | Sections |
| --- | ---: | ---: | ---: | ---: |
| Searches (all 16 requests) | 41 | 31 | 33 | 38 |
| Refused searches | 7 guessed topic ids, 1 timeout | 0 | 0 | 2 guessed topic ids |
| Refused section reads | – | – | – | 9 guessed section names, 3 bad arguments |
| `browse_knowledge` calls | 5 | 16 | – | 13 |
| Tool calls (13 requests) | 201 | 208 | 183 | 188 |
| Input tokens (13 requests) | 4.25M | 4.10M | 3.62M | 3.82M |
| Median input tokens per request | 269k | 230k | 192k | 220k |
| Materials (13 requests) | 40 | 35 | 32 | 29 |
| Refused writes (13 requests) | 5 | 3 | 2 | 4 |

- Guessed topic ids are the only search refusals in production, as in the
  99 runs of 2026-10-13/14 (22 of 116). Both reshaped flows remove them:
  browse first by browsing once per request (16 browses, 25 searches with
  topics), search by subject by taking a subject id the description lists
  (28 of 33 searches).
- Search by subject was the cheapest on 9 of the 13 requests, but one run
  per request swings by 2× either way (form-06 448k against 294k, stat-12
  117k against 421k). The token and call differences are within that noise.
- Production built more materials mostly on gen-07 (five notes and four
  quizzes for two chapters) and gen-02.
- Sections repeated the 2026-10-07 failure: section paths guessed from
  memory ("2.2 Probability basics" for a book numbered otherwise), refused
  with the closest outline lines.
- `book` was used on 3 of production's 41 searches; `section` never.

## Reading

Search by subject removes the refusals and a tool, with no sign of cost.
Whether it keeps material quality is not measured: run the fidelity and
pairwise judges (`bench/rag/intake/scripts/materials_judge.py`, which still
reads `run["ledger"]`) on production against search by subject before
relying on it for quality. Section reading still offers nothing the excerpt
flow lacks.

## Decision (Epo, 2026-10-14)

Shipped before any quality check, in contract v28:

- `search_knowledge` takes an optional `subject` from the list in its
  description instead of `topics`, `book` and `section`;
- `browse_knowledge` is removed;
- search cards no longer list topic ids;
- section reading (the v17 question) is removed with
  `CAPY_LIBRARY_SECTION_TOOLS`.

The caveat Epo named: without browsing, the agent sees less of a book's
structure. Consistency within a book, and the flow of a build that makes
dozens of materials, may get worse. Epo is checking this in the playground.
