# Intake and retrieval comparison: results

Date: 2026-10-08 (runs 2026-10-06 to 2026-10-08). Results of the experiment
planned in
[2026-10-06-intake-retrieval-comparison-plan.md](2026-10-06-intake-retrieval-comparison-plan.md)
(decisions in `human/agentic-retrieval.md`, 2026-10-06). Protocol frozen in
`bench/rag/intake/fixtures/protocol.json`; six amendments in
`protocol-amendments.json`. Raw run records, judge verdicts and the audit
sit under the ignored `bench/rag/reports/local/2026-10-intake-eval/`.

## Summary

Keep the current intake and the current reading mode. Neither arm beat the
excerpt search over reviewed text:

- Section reading on the reviewed data (C) did not beat A on coherence (A 24,
  C 23, tie 3 over 50 blind pairs; A 16, C 17, tie 1 where both arms built
  something) and lost fidelity (1.3% of decided claims wrong against A's
  0.8%). It also failed more often: 4 guard-flagged turns and 14 runs that
  ended with nothing written against A's 0 and 9, and it wrote 86 materials
  to A's 101. The plan's condition for shipping section reading is not met.
- MinerU without review (B) matched A on fidelity (0.8% wrong) and cost 1.2
  times A per material, inside the plan's two-times rule, but its text fails
  the plan's first condition: twice the wrong-or-missing blocks of the reviewed
  text in the parser audit (38 against 18 on the same 62 pages). Its
  materials also lost to A overall (A 27, B 22) and on level fit (A 28, B 10),
  and one of its answers copied a printed error the reviewed excerpts flag.
- The six Part 1 search fixes shipped before the runs and stay. The section
  tools stay behind `CAPY_LIBRARY_SECTION_TOOLS`; by the plan, contract v17
  removes the section arguments unless Epo keeps them for further work.

What section reading did do: B's two six-chapter builds taught all six
chapters with consistent notation (A 6 of 6 and 5 of 6, C 4 and 2), and C
beat A on coherence for the 26 pilot questions (C 15, A 10). Those gains were
offset by the failure modes below (guard flags, the planning cap, refused
section paths), all of them fixable, so a second round with those fixed is
the follow-up worth considering, not a change of intake.

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

Books, live version at the run start (unchanged at the end: the status
snapshots before and after the runs list the same 182 books, the five at the
same versions and excerpt counts), and the arm B corpus built from the same
PDFs:

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

All six in `protocol-amendments.json`, with the reasons.

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
   10 (29 verdicts taken on sampled pages were discarded and re-judged; one
   material cites more than 32, coverage 0.99 for B); a material that cites
   no library excerpt is left out of the fidelity tallies and counted as
   workspace-sourced; the primary fidelity measure is the wrong share of
   decided claims. With 10 of 20 to 30 pages shown, claims from the pages
   left out came back "unsupported" (18 to 20% on sampled section-reading
   materials against 2 to 4% with every page shown), a judge artefact that
   penalised B and C.
5. During the runs: a run whose turn ends in the app's response guard error
   (`response_flagged`) is rerun once after its arm finishes; the rerun is
   what the judges see and every flagged turn is counted. Two further runs
   were redone once for a provider connection error (`ConnectError` after
   nine calls, B stat-12-r2 and C gen-06's first rerun, both around 12:48 on
   2026-10-08), as a killed run is.
6. Judge transport: from 13:50 on 2026-10-08 the pending judge calls (fidelity
   on 76 materials, 35 pairs, locator on 77 runs, chapters on 15, the 20-pair
   second-rater sample) ran as Claude Code subagents reading packed task
   files (`materials_judge.py --pack`) with the same frozen prompts, schemas
   and content, writing the verdict files directly; the Opus calls on the
   repository's `qb-worker` definition (Opus 5.5, effort medium, as the CLI
   judge), the second rater on a general-purpose Sonnet 5.5 agent at the
   session's inherited effort (max). Reason: from 12:22 the `claude -p` login
   refused every model with a weekly-limit message while the account's usage
   card showed room. Verdicts taken through the CLI before that (222
   fidelity, 64 pairwise, 72 locator, 21 chapters) stand; each verdict file
   records its transport, and `materials_judge.py check` validated all 602
   against their schemas.

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
and tool call. The runs took the evening of 2026-10-06 and the morning of
2026-10-08 (paused in between), 5.2 hours of turn time per arm plus 0.6
hours of failed attempts.

Environment effects seen in every arm, reported rather than fixed mid-run:

- `inspect_document` always fails in the lab playground (the material
  gateway is the placeholder host `playground.invalid`), so an agent that
  wants to append to a note it wrote earlier cannot, and writes a "Part 2"
  note instead, or rewrites the whole note. Counted per arm below; it costs
  calls equally and is behind most of the formatting faults the judges saw:
  notes written twice in full, a "superseded partial draft" left beside its
  replacement, stray quiz lines pasted after a closing fence, companion
  quizzes left empty.
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
  the guard treats as protocol leakage and ends the turn. Every case sat in a
  section-reading arm, most right after long section reads or a refused long
  section path, none in arm A. Amendment 5 reruns each once; the flag count
  per arm is a cost of the reading mode with this model.
- The playground's `edit_document` does not re-check note fences, so one B
  note ended with a quiz fence the editor's import would refuse (an unquoted
  `text: Product rule: ...`); the driver crashed on it once and now counts
  such a fence as no questions (0938183f).
- Two provider connection drops (`ConnectError`) ended runs mid-turn; both
  were redone (amendment 5).

Counters per arm over the 50 final runs (`summary-final.json`):

| Counter | A | B | C |
| --- | ---: | ---: | ---: |
| Runs with material | 42 | 37 | 40 |
| Guard-flagged turns (first attempts and reruns) | 0 | 8 | 4 |
| Reruns (amendment 5) | 0 | 8 | 5 |
| Runs still ending in an error | 0 | 1 (stat-16, flagged twice) | 0 |
| Planning-cap hits (no ledger, 8 responses, nothing written) | 9 | 12 | 14 |
| Materials | 101 | 120 | 86 |
| of which notes / quizzes / flashcards / mindmaps | 66 / 33 / 2 / 0 | 67 / 38 / 9 / 6 | 56 / 27 / 3 / 0 |
| Tool calls per run | 18.6 | 19.6 | 18.5 |
| Input tokens per run | 440k | 632k | 513k |
| of which cache reads | 378k | 506k | 426k |
| Input tokens per material | 218k | 263k | 298k |
| Wall seconds per run | 378 | 372 | 373 |
| Page captures per run | 1.0 | 1.7 | 1.0 |
| Excerpts read per run | 5.3 | 48.6 | 22.2 |
| Sections read per run | 0 | 3.3 | 2.1 |
| Books cited per run | 2.2 | 0.8 | 1.5 |
| Quiz questions written per run | 11.2 | 11.9 | 9.8 |
| Quiz questions copied from the bank | 0 | 0 | 0 |
| Writes succeeded / refused | 110 / 78 | 125 / 90 | 94 / 62 |
| Refusals: skills / validator / ledger / provenance / other | 13 / 44 / 13 / 7 / 1 | 23 / 53 / 10 / 2 / 2 | 12 / 43 / 5 / 1 / 1 |
| `inspect_document` failures | 74 | 54 | 51 |
| Materials built before the confirmation turn (generic flows) | 51 | 52 | 15 |

Section reading did what it was meant to on the reading side: B read 3.3
sections and 48.6 excerpts a run and cited 0.8 books a run (A 2.2), so its
materials come from one book. C read fewer sections (2.1) and fell back to
search more often (22.2 excerpts a run), and cited 1.5 books. The question
bank was never copied from in any arm: every quiz question was written.

## Materials fidelity

Every claim in every library-cited material checked against the rendered
cited pages (up to 32 a material, every cited page shown except one B
material with 36), blind to arm:

| Arm | Materials judged | Workspace-sourced (skipped) | Claims | Supported | Wrong | Unsupported | Wrong share of decided | Unsupported share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 96 | 5 | 2,878 | 2,676 | 21 | 181 | 0.8% | 6.3% |
| B | 120 | 0 | 4,211 | 3,918 | 31 | 262 | 0.8% | 6.2% |
| C | 82 | 4 | 2,893 | 2,715 | 35 | 143 | 1.3% | 4.9% |

Wrong claims by kind:

| Arm | arithmetic | number | rule | quiz answer | definition | flashcard | formula | other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 8 | 2 | 1 | 3 | 0 | 0 | 0 | 7 |
| B | 11 | 4 | 4 | 4 | 0 | 0 | 1 | 7 |
| C | 6 | 6 | 6 | 4 | 1 | 2 | 0 | 10 |

A and B are level; C is worse by a third on the wrong share, with its extra
errors in numbers read off jamovi output (p = .049 where the output says
0.04253, two Shapiro-Wilk rows where the page has one) and over-general rules
("R² is always positive", "SE is always SD divided by root N", "disjoint
events can never be independent"). Across arms the wrong claims are the
agent's own: arithmetic slips in worked examples and quiz solutions, widget
code that computes the wrong value (a Z-score calculator without the root-2
division, a bin-label concatenation), miscounted lists, mislabelled page
references. Unsupported claims are mostly definitions and answers that sit
on pages the material did not cite, plus the author's own examples; the
judge marks these "not shown", not false. Two cases bear on the design
question: B's form-01 answer copies a printed solution of Brief Calculus
(p. 209) that drops two factors, which the reviewed excerpts of A and C flag
in their scope and B's unreviewed text cannot; and C's gen-01 copies an AHSS
footnote's arithmetic error (−1.22), so the scope notes do not catch
everything either. No parser-text defect from the audit surfaced as a wrong
claim in B's materials: MinerU's garbled subscripts and missing lines did not
reach the notes at this sample size.

Judge limits to keep in mind: the fidelity input caps the material text at
40,000 characters, the structured quiz at 8,000 and the flashcards at
4,000, so long quizzes and card sets were judged up to the cap (the judges
noted this on about ten B and C materials). The caps were the same for every
arm and both transports.

## Pairwise preference

Blind pairwise, same request, two arms, random First/Second order, Claude
Opus 5.5 medium; counts of wins:

| Pair (pairs) | Coherence | Completeness | Level fit | Overall |
| --- | --- | --- | --- | --- |
| A vs B (49) | A 26, B 21, tie 2 | A 25, B 19, tie 5 | A 28, B 10, tie 11 | A 27, B 22 |
| A vs C (50) | A 24, C 23, tie 3 | A 25, C 21, tie 4 | A 20, C 12, tie 18 | A 26, C 22, tie 2 |

A pair in which one arm wrote nothing (a planning-cap run) goes to the other
arm by default. Those pairs: A vs B 20 (B empty 12, A empty 8), A vs C 16
(C empty 10, A empty 8, both empty 2). Over the pairs where both arms built
something:

| Pair (pairs) | Coherence | Completeness | Level fit | Overall |
| --- | --- | --- | --- | --- |
| A vs B (29) | A 14, B 13, tie 2 | A 13, B 11, tie 5 | A 16, B 2, tie 11 | A 15, B 14 |
| A vs C (34) | A 16, C 17, tie 1 | A 17, C 15, tie 2 | A 12, C 6, tie 16 | A 18, C 16 |

By request kind (overall, Opus): pilot questions A 14, B 11 and C 13, A 12,
tie 1; generic flows A 6, B 6 and A 7, C 5; formula requests A 7, B 5 and
A 7, C 4, tie 1. On coherence alone the pilot questions are where section
reading shows: C 15, A 10, tie 1 (B 10, A 14, tie 1). The judges' reasons
repeat the same picture on both sides: A's notes carry one running example
through sections, quizzes and sliders in one notation and win level fit
by a wide margin; the section-reading notes more often split into "Part 2"
notes, repeat whole sections, leak build notes or stop early, but when they
hold together they are better grounded in the book (an actual figure, the
book's guided practices) and cover the request's specific question more
often.

Second rater, Claude Sonnet 5.5 on a seeded 20 of the 99 pairs: agreement
with Opus 95% overall, 90% on level fit, 85% on completeness, 70% on
coherence. Coherence is the least stable criterion, and it is the one the
decision rests on; A versus C on coherence is a dead heat under either
reading.

## Locator, chapters and controls

Locator (the first place each run read, judged on topic for the request):

| Arm | On topic | Partly | No |
| --- | ---: | ---: | ---: |
| A (50) | 28 | 19 | 3 |
| B (49) | 31 | 16 | 2 |
| C (50) | 30 | 17 | 3 |

Level. The book outline did not take the section readers to the right place
more often than the first search hit takes A; "partly" is mostly a section
narrower or wider than the request, "no" is front matter (a table of
contents) or the wrong subsection.

Multi-chapter builds (the generic flows, notes judged as a set; 12 runs per
arm):

| Arm | Chapters taught of requested | Notation consistent (yes / mostly) | Repeated explanations (runs with any) | Six-chapter builds (gen-01, gen-01-r2) | Compactions |
| --- | ---: | --- | ---: | --- | ---: |
| A | 35 of 40 | 3 / 9 | 4 | 6 of 6 and 5 of 6; 3.0M and 1.9M input tokens to the last material | 0 |
| B | 40 of 41 | 7 / 5 | 6 | 6 of 6 and 6 of 6; 5.0M and 5.4M | 4 to 5 each |
| C | 30 of 40 | 9 / 3 | 4 | 4 of 6 and 2 of 6; 2.5M and 1.6M | 2 each |

B is the only arm that finished every six-chapter build, on the ledger with
four to five compactions, at 1.7 times A's tokens; its repeats are notes
written twice in full after a failed append (gen-03-r2, 18 repeated
explanations). C's six-chapter builds stalled at four and two chapters (its
runs hit the planning cap or the guard after long reads). Per-material input
tokens in the six-chapter builds did not stay flat with compaction: B's rose
from under 100k for the first materials to 880k to 960k for the last ones,
A's to 590k.

Controls. stat-16 (CRISPR): A answered it from the animal science book (one
and two materials), as expected of a library that holds the subject; C found
the same book and wrote nothing (planning cap, both runs); B, whose library
lacks the subject, was guard-flagged on both attempts of the first run and
wrote nothing on the repeat. stat-24 (spectral theorem for unbounded
operators): B refused in three calls; A and C each wrote a note on the
bounded theorem from a functional analysis appendix, saying the sources do
not cover the unbounded case. The refusal control held only where the library
had nothing at all.

## Cost

| | A | B | C |
| --- | ---: | ---: | ---: |
| Input tokens per material | 218k | 263k (1.21× A) | 298k (1.37× A) |
| Input tokens per run | 440k | 632k | 513k |
| Cache-read share of input | 86% | 80% | 83% |
| Wall per run | 378 s | 372 s | 373 s |
| Input tokens, 50 final runs | 22.0M | 31.6M | 25.7M |
| Input tokens, failed attempts | 0 | 1.8M | 1.0M |

Both section arms stay inside the plan's two-times rule on cost per material;
the extra cost is section text in context (B reads nine times A's excerpts a
run). Wall time per run is level because the section arms spend their
responses on reads where A spends them on searches. The whole experiment
consumed about 82M GLM input tokens, roughly twice the plan's 25M to 45M
estimate: the six-chapter builds cost 2M to 5M each, not the 1M the plan
assumed, and four fifths of every arm's input is cache reads. The judge ran
on the Max subscription and then on the session's subagents, no API cost.
The repository holds no price for GLM-5.3-Flash through Relace, so this
section stays in tokens.

## Decision by the plan's rule

1. The Part 1 fixes shipped regardless (cfceb1f7, contract v16).
2. Section reading ships on the current data only if C beats A on coherence
   with no fidelity loss. C did not beat A (24 to 23 with 3 ties over all
   pairs, 16 to 17 where both built; the second rater agrees with the
   primary only 70% of the time on this criterion) and lost fidelity (1.3%
   against 0.8% wrong, 35 against 21 wrong claims). Not met.
3. B replaces intake for new books only if its audit error rate is at or
   below the reviewed text's, its fidelity is not worse than A's and its
   cost per material is within two times A's. Fidelity equal (0.8%) and cost
   1.21 times: met. Audit: 38 wrong-or-missing blocks against 18 on the same
   pages: not met. MinerU without review does not replace the reviewed path.
4. The fallback (keep ODL plus transcription, drop tagging) applies only if
   C wins. It did not; tagging stays.

Recommendation: keep the current intake (ODL v12, transcription review,
tagging) and excerpt search with the Part 1 fixes; remove the section
arguments in contract v17 as the plan says, unless Epo wants a second
section-reading round with the failure modes fixed first (short section ids
in the outline, the guard's treatment of tool-call text, a planning budget
that does not charge the "read the skills first" refusal, a working
`inspect_document` in the playground). The evidence for such a round is
real but narrow: B's complete six-chapter builds and C's coherence edge on
the pilot questions.

## Calls awaiting Epo's confirmation

- The plan's review-1 decisions and the arm B library-on rule (above).
- Amendments 3 to 6 (the second rater model and effort, the two added judge
  prompts, the 32-page fidelity cap and the workspace-sourced exclusion, the
  single rerun of guard-flagged runs and the two connection-error redos, the
  judge transport switch to subagents).
- The pre-v16 evidence break for UAT chats; tell UAT users or clear those
  chats before the next deploy.
- Whether v17 removes the section arguments now or the flag stays for a
  second round.
- Spot-check (plan Part 6, six materials, two per arm, seed 20261008 over the
  library-cited notes): A gen-01 "Ch5 · Random Variables and Their
  Distributions" and A form-02-r2 "Product and Quotient Rules for
  Derivatives"; B stat-09 "Interpreting a 95% Confidence Interval" and B
  gen-03 "Stats Midterm: Probability & Distributions"; C gen-01 "Ch. 2 ·
  Summarizing Data" and C gen-03 "Stats Midterm: Probability &
  Distributions". The materials and their verdicts sit under
  `reports/local/2026-10-intake-eval/<arm>/` and `judge/fidelity/<arm>/`.
- Cleanup of the scratch containers (`intake-eval-scratch`,
  `intake-eval-pilot`, data kept) and the WSL venv `~/mineru-venv`.

## Follow-ups

- The response guard fires on GLM-5.3-Flash writing its tool-call syntax as
  answer text (B 8, C 4, A 0 turns). Either the guard retries the turn once
  with a nudge, or the section tools are tried with a model that does not do
  this; as it stands the failure rate is a cost of section reading with the
  production model.
- Runs that end with nothing written (A 9, B 12, C 14): the eight-response
  planning cap of a ledger-less turn is spent one response on the "read the
  skills first" refusal in every arm and more on refused section paths in B
  and C. Not charging the skills refusal, or opening a ledger automatically
  on the first refused write, would recover most of these.
- `inspect_document` in the lab playground (`playground.invalid`): A 74, B
  54, C 51 failed calls, and the "Part 2" notes, duplicated notes and stray
  quiz fragments that follow. The playground needs a working material
  gateway or a stub that serves the run's own materials.
- `edit_document` in the playground should re-run `check_note` on the edited
  markdown; the app's structured rows do not have this problem.
- Section readers guess bare section numbers and over-long paths; the outline
  should print a short id per section that `read_knowledge` accepts.
- `create_material` caps `excerpt_ids` at 32, which a whole-chapter read
  exceeds; either raise the cap for section provenance or credit the section.
- GLM builds in the proposal turn before the confirmation (A 51, B 52 of the
  generic flows' materials, C 15); the proposal step is not doing its job
  with this model.
- Materials that stop mid-generation with no cap marker (several per arm):
  the agent ends its turn early; worth a check of the stop reason and the
  note's own "Sections 3 and 4" references.
- Fidelity judge input caps (40k text, 8k quiz, 4k flashcards): raise or
  split long materials before the next judged experiment.
- The plan's token estimate: budget six-chapter builds at 3M to 5M each.
- The refusal control stat-24 was answered by A and C with the bounded
  theorem; the "library has nothing in the requested scope" rule needs the
  agent to say so when the sources cover a neighbour of the request, not
  only when they cover nothing.

## Receipts

- Plan, implementation brief, protocol, amendments, requests, audit sample,
  judge prompts: `bench/rag/reports/2026-10-06-*.md`, `bench/rag/intake/fixtures/`.
- Scripts: `bench/rag/intake/scripts/` (`mineru_corpus.py`, `armb_pipeline.py`,
  `audit_sample.py`, `audit_packets.py`, `audit_judge.py`, `run_requests.py`,
  `materials_judge.py` with `--pack` and `check`, `claude_headless.py`).
- Local: `bench/rag/reports/local/2026-10-intake-eval/` (MinerU zips and
  logs, scratch corpus runs, audit packets and verdicts, arm outputs with the
  rerun attempts under `<arm>/failed/`, judge verdicts and task files,
  `summary-final.json`, the table renderer `scripts/tables.py`, reviews,
  playground and driver logs, the handoff and notes of 2026-10-06 and
  2026-10-08, the live-library status snapshots).
