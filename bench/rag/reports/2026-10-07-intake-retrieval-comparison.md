# Intake and retrieval comparison: results

Date: 2026-10-07. Results of the experiment planned in
[2026-10-06-intake-retrieval-comparison-plan.md](2026-10-06-intake-retrieval-comparison-plan.md)
(decisions in `human/agentic-retrieval.md`, 2026-10-06). Protocol frozen in
`bench/rag/intake/fixtures/protocol.json`; four amendments in
`protocol-amendments.json`. Raw run records, judge receipts and the audit
sit under the ignored `bench/rag/reports/local/2026-10-intake-eval/`.

RESULTS PENDING: summary, materials fidelity, pairwise, locator, chapters,
cost and decision sections are filled when the three arm runs and the judge
passes finish.

## Summary

RESULTS PENDING

## What was compared

| Arm | Parser and review | Reading mode | Data |
| --- | --- | --- | --- |
| A | ODL v12 plus full transcription review and tagging (the live published versions) | Current excerpt search with the six Part 1 fixes | Live shared library through the ingest-host tunnel |
| B | MinerU 4.0.10 standard tier on this PC's RTX 3060 Ti, no review, no tags | Section reading: book outline, ordered section reads, tag-free search as locator | Scratch library `intake-eval-scratch` (127.0.0.1:15445) |
| C | Same data as A | Section reading | Live shared library |

Everything else was fixed: the five PDFs by sha256, GLM-5.3-Flash thinking
high through the playground (`lab/playground/configs/intake-{a,b,c}.json`,
`chat.json` with decks off), the base prompt and skills, the 32 frozen
requests, the judge prompts. Arms B and C differ from A only in the two
process flags (`CAPY_LIBRARY_SECTION_TOOLS=1`, and for B
`CAPY_LIBRARY_REQUIRE_TAGS=0`) and in the library rules variant that replaces
production's search workflow lines with the section-reading ones
(`lab/playground/README.md`, "Intake comparison"). C answers whether a gain
comes from the parser or from the reading mode.

Books, live version at the run start (unchanged at the end, intake being
paused), and the arm B corpus built from the same PDFs:

| Book | Pages | Live version (A, C) | Live chunks / excerpts | MinerU v1 chunks / excerpts (B) |
| --- | ---: | --- | ---: | ---: |
| os4 OpenIntro Statistics | 465 | v4 | 1,226 / 695 | 1,228 / 759 |
| ahss4 Advanced High School Statistics | 514 | v5 | 1,306 / 775 | 1,371 / 889 |
| lsj Learning Statistics with jamovi | 495 | v5 | 1,053 / 424 | 1,138 / 491 |
| brief-calculus | 235 | v5 | 527 / 431 | 560 / 370 |
| fundamentals-of-electrical-engineering-i | 364 | v12 | 797 / 680 | 839 / 595 |

Requests (`bench/rag/intake/fixtures/requests.json`, 32): 8 generic learning
flows run as two scripted turns (request with the app's defaults, the agent's
proposal, a confirmation, the build), 16 pilot questions including the two
refusal controls stat-16 (CRISPR in a statistics course) and stat-24 (a proof
of the spectral theorem), 8 formula requests on Brief Calculus and EE I.
Every dev-split request (18) ran twice per arm: 50 runs, 62 turns per arm.
Output is notes with embedded quizzes and flashcards, decks off, Library on
(knowledge base and question bank).

## What shipped before the runs

The six search fixes (plan Part 1) and the section tools behind
`CAPY_LIBRARY_SECTION_TOOLS` (plan Part 2) went to main in cfceb1f7 after two
review rounds (`reports/local/2026-10-intake-eval/review-1.md`, `review-2.md`;
the implementation summary sits beside them). Contract v16 carries the
section arguments in production behind the flag. Two consequences for the
app, both accepted under the no-compatibility decision: UAT chats that hold
library evidence from before v16 fail their next turn, and if section reading
is not adopted v17 removes the section arguments.

The plan's "Decisions Claude took on review 1" (outline pages of 120 lines,
book list in the browse description only when the subject catalog is empty,
section runs bridged over at most two chunks, B/C rules keeping production's
scope lines, the dev repeat covering all 18 dev-split requests) stand as
taken and await Epo's confirmation, as does the arm B rule that keeps the
library on when books exist but no subject holds a tagged excerpt.

## Amendments

All four in `protocol-amendments.json`, with the reasons.

1. Before the first run: every pilot and formula request ends with "Build it
   as a note I can study from" (the build flow answers a "help me learn X"
   question in chat and writes nothing unless asked).
2. Before the first run: the dev repeat is all 18 dev-split requests.
3. Before the first verdict of its kind: the second rater is Claude Sonnet
   5.5 at medium effort on a seeded 20% of the pairs; the locator check uses
   the frozen `materials-locator-prompt.txt` over the first read of each run;
   the multi-chapter checks use `materials-chapters-prompt.txt` over a
   generic request's notes plus mechanical counts from the run record.
4. During the runs: the fidelity judge sees up to 32 cited pages instead of
   10 (29 verdicts taken on sampled pages were discarded and re-judged; none
   so far cites more than 32); a material that cites no library excerpt is
   left out of the fidelity tallies and counted as workspace-sourced; the
   primary fidelity measure is the wrong share of decided claims. With 10 of
   20 to 30 pages shown, claims from the pages left out came back
   "unsupported" (18 to 20% on sampled section-reading materials against 2
   to 4% with every page shown), a judge artefact that penalised B and C.

## The MinerU parse and the parser fidelity audit

MinerU 4.0.10, `mineru-kit parse --tier standard --format zip` in WSL Ubuntu,
small models on Torch CUDA, the 1.2B VLM on vLLM 0.28 at a 0.75 memory
fraction with `VLLM_USE_FLASHINFER_SAMPLER=0`. Inference for the five books,
2,073 pages: 1,534 s, 1.35 pages a second (ahss4 408 s, os4 340 s, lsj 306 s,
brief-calculus 225 s, EE I 255 s); about 43 minutes wall including engine
starts and one WSL GPU reset. The converter `mineru_corpus.py` maps the
middle JSON onto Capy's content list (headings levelled by the PDF outline
and by numbering, chapter openers typed as document titles synthesised from
the outline, inline and display LaTeX, tables as HTML, control characters
from unmapped glyphs as U+FFFD) and runs the production chunker and excerpt
builder; `armb_pipeline.py` indexes (DeepInfra embeddings, same pin as the
live library) and publishes to the scratch database with an all-failed tags
document so every excerpt is kept untagged. No transcription, figure
description, review, tagging, topics or scope stage ran: that is the "minimal
up-front review" the arm measures.

Audit, 3% of pages per book (62 pages, seed 20261006,
`audit-pages.json`), every block judged faithful or not against the page
image for both texts in a per-page random order by Claude Opus 5.5
(`audit/summary.json`):

| Text | Blocks | Faithful | Wrong | Missing | Garbled | Extra |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Reviewed (ODL v12 + review, live versions) | 180 | 134 (74%) | 13 | 5 | 19 | 29 |
| MinerU 4.0 standard, no review | 190 | 133 (70%) | 26 | 12 | 24 | 31 |

By book (faithful of blocks, reviewed vs MinerU): ahss4 40/53 vs 39/56, os4
28/41 vs 29/39, lsj 45/47 vs 36/44, brief-calculus 10/19 vs 9/22, EE I 11/20
vs 20/29. Level on the statistics books, the reviewed text wins on jamovi,
MinerU wins on EE I (the book whose formula pictures ODL catches 42% of),
both poor on Brief Calculus. The silent kinds, wrong and missing, are what
reach a learner: MinerU carries twice as many (38 against 18, on 20 of the
62 pages against 14). "Extra" counts figure text and axis labels both
parsers lift into prose and MinerU's "[Figure]" placeholders. By the plan's
first condition for B (audit error rate at or below the reviewed text's),
MinerU without review does not replace the reviewed path.

## Runs

Three playground processes (A on 8768, B on 8767, C on 8766), one driver
each (`run_requests.py`), outputs
`reports/local/2026-10-intake-eval/<arm>/<request>[-r2].json` with the run
ids, answers, materials, write outcomes and the protocol's counters. The
playground's `lab/playground/local/runs/<id>/run.json` keeps every provider
and tool call.

Environment effects seen in every arm, reported rather than fixed mid-run:

- `inspect_document` always fails in the lab playground (the material
  gateway is the placeholder host `playground.invalid`), so an agent that
  wants to append to a note it wrote earlier cannot, and writes a "Part 2"
  note instead. Counted per arm below; it costs calls equally.
- GLM often builds in the proposal turn without waiting for the
  confirmation; the confirmation turn then adds materials (flashcards,
  mindmaps) or reports completion. Counted as "materials before
  confirmation".
- `create_material` caps `excerpt_ids` at 32; a section reader that read a
  whole chapter run hits the cap and retries with fewer ids.
- Section readers guess bare section numbers ("8.3") that `read_knowledge`
  refuses with the closest outline lines; the agent recovers from the
  outline.
- Writes refused by the validators (quiz YAML, question schema, ledger todo,
  provenance, skills not read) are retried by the agent; the counts are
  friction, not lost materials, unless a material is missing at the end.
- A turn that opens no ledger has eight planning responses, the eighth with
  tools off (`limits.PLANNING_RESPONSES`; the prompt says so and a turn that
  needs more room creates a ledger). Single-note requests whose agent skips
  the ledger and loses one response to a refused write (most often "read
  the skills first") reach the eighth response with the note unwritten and
  answer with a progress report instead. Counted per arm as planning-cap
  hits; a section reader loses responses to refused section paths the same
  way arm A loses them to extra searches.
- The two refusal controls are controls only where the library lacks the
  subject: stat-16 (CRISPR) is answerable from the live library's animal
  science book (A and C) and only unanswerable in B's five-book scratch
  library; stat-24 (spectral theorem proof) is unanswerable everywhere.
- Some turns ended in the app's response guard error ("Response flagged
  due to safety concern", code `response_flagged`): GLM-5.3-Flash wrote a
  tool-call envelope into its answer text instead of calling the tool, which
  the guard treats as protocol leakage and ends the turn. Every case so far
  sat in a section-reading arm right after long section reads or a refused
  long section path, none in arm A. Amendment 5: such a run is rerun once
  after its arm finishes; the flag count per arm is reported as a cost of
  the reading mode with this model.

RESULTS PENDING: per-arm counters table (runs, materials by kind, tool
calls, input and cached tokens, wall time, captures, excerpts and sections
read, books cited, questions copied versus written, write refusals by class,
inspect failures, materials before confirmation).

## Materials fidelity

RESULTS PENDING

## Pairwise preference

RESULTS PENDING

## Locator, chapters and controls

RESULTS PENDING

## Cost

RESULTS PENDING

## Decision by the plan's rule

RESULTS PENDING

## Calls awaiting Epo's confirmation

- The plan's review-1 decisions and the arm B library-on rule (above).
- Amendments 3 and 4 (the second rater model, the two added judge prompts,
  the 32-page fidelity cap and the workspace-sourced exclusion).
- The pre-v16 evidence break for UAT chats; tell UAT users or clear those
  chats before the next deploy.

## Follow-ups

RESULTS PENDING

## Receipts

- Plan, implementation brief, protocol, amendments, requests, audit sample,
  judge prompts: `bench/rag/reports/2026-10-06-*.md`, `bench/rag/intake/fixtures/`.
- Scripts: `bench/rag/intake/scripts/` (`mineru_corpus.py`, `armb_pipeline.py`,
  `audit_sample.py`, `audit_packets.py`, `audit_judge.py`, `run_requests.py`,
  `materials_judge.py`, `claude_headless.py`).
- Local: `bench/rag/reports/local/2026-10-intake-eval/` (MinerU zips and
  logs, scratch corpus runs, audit packets and verdicts, arm outputs, judge
  verdicts, reviews, playground logs).
