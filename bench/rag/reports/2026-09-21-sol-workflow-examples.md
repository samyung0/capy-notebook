# Sol book workflow and example-guided rerun

This report covers candidate-only trials on 2026-09-21. No trial artifacts were
published, no Qwen/GLM calls were made, and the `kb` scheduler remains paused.
Agentic retrieval-loop changes and runtime writing remain deferred.

## Inputs and limits

- *Literary Skills and the Archive*: all 23 excerpts, 25 PDF pages. A controlled
  replay removes this book's three existing topics from the 26-topic subject
  catalog. It tests proposing genuinely absent topics in that snapshot, not
  acquisition of an unseen book or novelty against the actual current catalog.
- *Mathematics for Elementary Teachers*: all 236 excerpts, 457 PDF pages, split
  into 79, 79 and 78 excerpts. A fresh book owner assembles all scopes before
  whole-book topic reasoning. The current eight-topic catalog is supplied.
- Every worker is a fresh `gpt-5.6-sol` agent at medium reasoning. Usage is
  unavailable and recorded as unknown. Existing corrected source and full
  notes are reused; this is not a fresh parser or complete transcription audit.
- The example-guided rerun uses identical source, corpus, baseline-tag,
  full-note and catalog hashes. Fresh agents cannot read prior trial candidates
  or result reports. The examples address observed failures, so this is a
  regression check, not a held-out estimate of library-wide accuracy.

Frozen inputs, assignments, observations and outputs are under
`bench/rag/reports/local/2026-09-21-sol-workflow/` and
`bench/rag/reports/local/2026-09-21-sol-workflow-examples/`.

## First run

All four scope artifacts passed exact assigned-ID coverage and preserved every
full synopsis. Evidence, role/topic shape, same-book links and metadata limits
passed the existing validation. The literature agent inspected 25 pages; the
math workers inspected 8, 14 and 13 pages, 35 distinct math pages in total.

The literature replay proposed three topics and classified seven administrative
excerpts as non-teaching. A refreshed-catalog test then reused all three current
topics with no new proposal. The mechanical merge alone matched two proposals
but would have added a semantically redundant personal-narrative topic. Fresh
Sol reconsideration caught that duplicate. Altered source/review hashes were
rejected, and source, notes, roles and retrieval metadata remained intact.

The large-book scopes exposed failures that structural validation cannot catch:

- Scope 2 repeated two audience-based scope strings across 64 excerpts. One
  Egyptian-fraction task had lost every target fraction, but its retrieval scope
  gave generic applicability instead of warning about the missing inputs.
- Other scopes also reused broad chapter language. Some warnings were only in
  a global unresolved list, which is not returned with an individual excerpt.
- Handwritten packets used inconsistent field names. Some lacked the exact
  `assignment.target_ids` and `source.excerpts` expected by the existing helper.

The first book-owner pass, after parent feedback, assembled all 236 excerpts,
reused eight topics, preserved the notes and replaced all 79 scope-2 scopes.
It retained 18 non-teaching excerpts and exported a full text packet. It did not
repair the underlying missing formulas or inspect new pages. This assisted
result must not be represented as an unassisted first-pass success.

## Changes before rerunning

- `lab/knowledge/sol-examples.md` supplies concrete do/don't cases for scope,
  audiences, roles, full notes, missing extraction, conditional links, topic
  reuse, split coverage, visual claims and packet emission.
- `lab/knowledge/examples/book-review-packet.json` gives a complete synthetic
  packet with one review target and its necessary source-context excerpt.
- The fixed prompt references both files. Assignments freeze them with the
  review contract and record their hashes. The paused scheduler does the same.
- `lab/knowledge/packet.py` exports the fixed fields locally from saved
  artifacts, embeds review text and records hashes of the exact bytes read.
  It preserves baseline notes separately from candidate tags, includes directly
  linked source, rejects unknown links/source mismatches, and refuses to
  overwrite a packet. It has no provider call, polling or submission stage.
- The review contract explicitly requires missing-input warnings on affected
  excerpts and forbids audience-based constraints or generic chapter scope
  replacing passage-specific conditions.

The focused offline suite passed 11 checks, including packet snapshot behavior,
the JSON example's request/response compatibility, topic import/merge and the
existing Qwen request contract. Request construction uses thinking disabled,
strict JSON Schema and no caller token cap; nothing was sent.

## Example-guided scope results

All four fresh workers completed their assigned scopes. Independent local
checks confirmed 259 unique targets across the two books, preserved source
text and locators, matching artifact hashes, and four usable exported packets.
Their source payloads contain 260 entries because the second math scope needs
one excerpt from the third scope. Each packet built the existing strict-JSON
Qwen request offline, with thinking disabled and no caller token cap. No request
was sent.

| Scope | Reviewed | Sol page inspections | Full-note changes |
| --- | ---: | ---: | --- |
| Literature | 23/23 | 9 | All preserved |
| Math 1 | 79/79 | 9 | All preserved |
| Math 2 | 79/79 | 13 | Four documented, image-backed expansions |
| Math 3 | 78/78 | 6 | All preserved |

Math workers inspected 27 distinct pages, with page 286 shared by two scopes.
Page counts describe coverage only; they are not accuracy scores. None of these
runs establishes complete verification of a 457-page math book.

The examples improved several previously weak annotations:

- The Egyptian-fraction exercise now explicitly says its target fractions are
  absent and that the preceding excerpt cannot restore them.
- Math scopes 2 and 3 use distinct passage-specific scope descriptions. The
  audience-based chapter boilerplate in the first run is gone from those scopes.
- The additive-identity passage retains both the symbolic rule and learner task.
  The fraction-division summary records the source's questionable "dividend"
  wording instead of inventing an extraction correction.
- Four diagram-only notes now describe the actual source images rather than
  retaining only labels or a running header. Parent checks of pages 156, 174 and
  281 agree with those observations, within the content visible on those pages.
- The fixed exporter eliminated the manually invented packet-field variants.

First-pass problems remain:

- Math scope 1 repeats three broad scope strings across 38 excerpts, including
  unnecessary "no special software" language. The fixed examples did not stop
  this worker from using boilerplate.
- Excerpt 5 omits the ABC problem needed for its reflection task. Excerpt 43
  correctly recognizes intentionally blank worksheet cells; its short description
  omits the new base-four task, but its section path already supplies the
  base-seven instructions. The parent's initial missing-link objection for
  excerpt 43 was withdrawn after checking that supplied heading. Excerpt 155
  identifies real diagram exercises but omits excerpt
  154, which supplies their instructions. These are failures of context judgment,
  not packet formatting.
- The literature result says its catalog has 22 topics; the actual frozen JSON
  has 23. It also says a year "1772-73" was visually verified, although the PDF
  prints "177273" without a separator. The 112,305-cask count is visible; the
  year interpretation needs qualification. These raw claims are retained for
  audit rather than silently corrected in the candidate.
- Many source formulas and diagrams remain absent from corrected text. Warnings
  make that limitation visible during retrieval but do not repair the content.

The parent reused nine source checks selected before the first trial and added
targeted checks of the four changed notes. This is a qualitative regression
assessment, not an estimated error rate. Raw assessments are saved in
`parent-scope-assessment.json`, `packet-audit.json` and `scope-audit.json` under
the example-guided run directory.

One preparation issue changed only line endings in the frozen prompt, from LF
to CRLF. Its recorded frozen hash is valid and the prompt wording is identical
to the canonical file. Preparation now copies the exact bytes. The current
trial inputs and receipts were left unchanged.

The fresh literature owner proposed three topics against the 23-topic replay
catalog. A separate fresh Sol agent then read the refreshed 26-topic catalog,
reused all three topics, proposed none, and preserved all 23 annotations. The
positive binding checks and isolated stale-source/stale-review rejection tests
passed. In this rerun the proposed IDs already matched the refreshed catalog;
the earlier run, which required semantic reuse despite different IDs, was the
stronger naming-variation check. This remains a controlled replay using an
existing processed book, not a blind test on an unseen acquisition.

## Whole-book assembly and final assessment

The fresh Sol owner assembled all 236 math excerpts exactly once, with 219
teaching and 17 non-teaching excerpts. It reused all eight topics and made 42
documented annotation changes without parent case-specific hints. It removed
the repeated scope boilerplate, corrected a matching-game role and its links,
and removed unnecessary links from a self-contained associativity definition.
Every scope-worker synopsis was retained, including the four documented
image-backed corrections. Structural validation passed.

Two confirmed context-link failures remain after that owner pass: the ABC
reflection in excerpt 5 and the growing-pattern instructions for excerpt 155.
The first needs excerpt 3 only for the reflection; the second needs excerpt
154 in addition to the page image. A repeated-string check cannot detect these
semantic omissions. The owner receipt also contains one prose count error,
"28 distinct" inspected pages; its actual inventory and main result correctly
show 28 records across 27 distinct pages.

The parent's packet audit caught a separate mistake. The owner created a
substitute packet run whose `reviewed-notes.json` contained its revised notes.
Consequently, four changed notes appeared as the baseline as well as the
candidate, hiding their before/after differences. The exporter emitted the
supplied data faithfully, but the supplied baseline was wrong. The first packet
and receipt are preserved as failed test evidence. In a bounded correction,
the same owner exported from the original assigned run. All 236 original notes
now match their frozen baseline, all candidate tags remain unchanged, and the
four before/after differences are restored. The corrected packet and a separate
correction receipt preserve this distinction without changing annotations.

This discovered case was added to the dedicated examples after the four scope
reruns. Their frozen examples remain unchanged; the correction is a separate,
parent-assisted check and must not be counted as an unassisted first-pass pass.

The examples and owner stage are useful, but this is a partial semantic result.
The remaining work is reliable conditional context linking and source recovery,
plus validation on genuinely unseen books. Packet shape, full-scope assembly,
topic reuse and structural checks have stronger evidence than those remaining
judgment tasks. No library-wide quality claim follows from this trial.

## Effect on knowledge retrieval

Reviewed roles and topics determine which teaching excerpts are eligible.
The short summary and applicability text join the indexed text, while the
original quoted source stays intact. `search_knowledge` returns the summary,
scope, context IDs and matching passage; `read_knowledge` supplies the full
excerpt. This is why a general regression explanation can remain useful even
when its book teaches R, while an actual R procedure needs an R-specific scope.
Missing metadata is explicitly labeled unreviewed.

These annotations give the retrieval model evidence for selecting suitable
material. They do not enforce request generality as a hard filter. Better agent
scope selection is the deferred agentic-loop work. This trial changes the
builder guidance and packet export, not the runtime search mechanism, and
does not establish a measured improvement in end-user answers.

## Existing-book backlog

A read-only live snapshot at 04:01 UTC on 2026-09-21 counted 92 current books,
47,717 excerpts and 103 excerpts with retrieval metadata across 14 books.
The local builder has 89 book records, a different inventory boundary.

Existing processed books are not simply waiting for Qwen. Most need Sol to
review legacy roles/notes, add the new metadata/context links and record or
repair source defects before indexing and publishing revised versions. Qwen
is optional review of saved text packets at the developer's chosen time.

## Qwen's observed failures

The saved non-thinking strict-JSON trial's failures remain relevant:

- `01-book-defects` initially missed a full note reduced to "Bootstrap
  resampling." A prompt refinement caught this on recheck.
- `07-scope-control` initially rejected a valid historical/jurisdiction evidence
  limit and returned unnecessary or unassigned findings. The recheck passed.
- `08-real-book-sample`, Chinese Contract Law, still recommended treating an
  upcoming-section transition as teaching, suggested an unnecessary synopsis
  edit, and ignored an explicit catalog source-section inclusion when proposing
  topic removal. Two role findings were useful, both on inherited tags.
- The real sample still missed an explanatory passage labeled reference and a
  synopsis inventing that repayment happened at the creditor's direction.

See [the saved adjudication](2026-09-21-qwen-book-review/results.json) and
[the original report](2026-09-21-qwen-review-proposal.md). No findings were
automatically applied. Strict JSON validates structure, not semantic correctness.

## Reproduction

```sh
uv run --project pipeline python bench/rag/scripts/sol_workflow_trial.py prepare --output bench/rag/reports/local/<new-run>
# Dispatch each saved assignment to a fresh Sol medium agent, then:
uv run --project pipeline python bench/rag/scripts/sol_workflow_trial.py audit --output bench/rag/reports/local/<new-run>
pnpm test:pipeline lab/knowledge/tests/test_packet.py lab/knowledge/tests/test_topics.py bench/rag/scripts/test_knowledge_review_samples.py -q
```

Preparation requires the two local licensed source runs and the live catalog
connection. Audit checks saved artifacts and never publishes them. Owner and
catalog-refresh assignments are saved beside the scope artifacts.

Deduplication research and the recommendation for a bounded repeated-example
test are in [the separate research note](2026-09-21-knowledge-duplicate-strategy.md).
