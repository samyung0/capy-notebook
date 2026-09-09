# Retaining headings that disappear during chunking

The selected benchmark adds 36 source-confirmed headings to indexed content
across the ten development and transfer documents. All 27 frozen substantive
heading checks pass, compared with none before retention. Every existing chunk
remains unchanged. A separate run on three independent PDFs retains ResNet's
missing document title and rejects the NIST scan's footer strings.

This repairs content loss during chunking. It does not reconstruct infographic
relationships or fix existing incorrect ancestor headings. Production remains
unchanged.

## Source evidence and cause

German source page 17 prints the complete panel heading `Stagnation bei
(non-)formalem Lernen, Wachstum bei informellem Lernen`. The same complete text
exists in native block 571. Java then places the adjacent panel's heading at the
same level before either panel's body content. The chunker replaces the first
heading in its stack, and its text never reaches a chunk.

The audit found this loss on 19 substantive German panel titles. Source crops
also confirmed seven Spanish headings and a Hong Kong table heading. Thirty
source crops were reviewed and hashed before implementation: those 27 positive
cases, two NIST footer controls and a vertical Spanish cover legend outside the
horizontal candidate's scope. Their checks are retained in `checks-v1.json`.
German supplied development cases; Spain and Hong Kong supplied document
transfer cases whose source pages were reviewed before implementation.

The baseline follows the [native-text repair](2026-09-09-odl-native-text-experiment.md).
Inputs comprise ten PDFs and 299 pages, bound by source PDF, parsed PDF, content
list and chunk hashes. This experiment consumes the actual completed chunks,
including their existing table handling.

## Bounded rule

[`experiment_odl_heading_retention.py`](../scripts/experiment_odl_heading_retention.py)
considers native headings with at least 12 non-whitespace characters and eight
letters that are absent from indexed content on their source page. A heading
already present in a section path is not copied.

The complete heading must match horizontal source text inside its original box.
Unicode compatibility forms and source line-wrap hyphens are normalized for
comparison; substantive inline hyphens remain distinct. Source text traces must
also show enough opaque, visible letters inside the box. Hidden OCR text alone
cannot authorize retention. Repeated margin strings are excluded using their
source position and recurrence across at least three pages.

Each accepted heading becomes a standalone chunk containing its literal native
text and its exact original page and box. It has no invented ancestor path.
The chunk is inserted at a clean boundary in native block order. Candidates
inside an existing chunk's source span are rejected. All original regions map
back to native blocks in the ten-document run, so no location fallback was
needed. Every original chunk remains byte-equivalent as structured data and
keeps its relative order.

The helper does not modify native blocks or merge headings with neighboring
chart values. It also does not copy already-indexed headings merely to make
their citation boxes appear. Those are different potential changes.

## Results

| Document | Added chunks |
| --- | ---: |
| German education | 20 |
| Spain figures | 12 |
| Hong Kong figures | 3 |
| Japanese migration | 1 |
| Six other development/transfer documents | 0 |

All 27 frozen positive cases are now present with source citations. Both NIST
footer controls and the vertical cover control remain absent. The aggregate
fixture therefore changes from 3/30 to 30/30, but the substantive recovery
result is **0/27 to 27/27**. The three initial passing controls must not be
counted as recovered headings.

Nine additional retained items were visually reviewed after selection. They
include the German cover subtitle, a Japanese chart title, Hong Kong table
labels, Spanish units/provisional-data notes and a contact-location heading.
All match their source crops. They are follow-up reviews, not additional frozen
accuracy checks. Their records are in `supplementary-review.json`.

The earlier 12 section-context checks still pass. All 16 native-text checks now
pass, including the formerly missing German panel title. New chunks have exact
source regions and empty ancestor paths, and a second application adds nothing.
The two local replay outputs are identical.

Existing infographic problems remain. German charts can still attach labels or
values to a neighboring panel's section, and long-lived numerical ancestors
still occur. Retaining a printed title makes its statement recoverable but does
not certify every number, trend, legend or connection in the graphic.

## Independent documents

Both this rule and the native-text rule were frozen before applying them to the
fresh BERT, ResNet and NIST shot-classifier outputs, totaling 36 pages. The native
text rule changes no blocks there. Retention adds only `Deep Residual Learning
for Image Recognition`, with its source page 1 title box. Its source page was
visually reviewed after selection. BERT stays unchanged, and all eight NIST
footer candidates are rejected because their source text is invisible OCR.

The five independently frozen body-fragment diagnostics do not change under
either rule. BERT page 6 and ResNet page 6 still have interrupted column
continuations. BERT page 5's diagnostic also counts a ligature normalization
difference; it must not be presented as a newly introduced transcription error.
The exact BERT page 7 introductory phrase does not certify the accompanying
equations. These remaining failures are recorded for the separate continuation
and mathematical fidelity work.

## Cost and reproduction

The final local replay takes 0.752 seconds for source inspection and chunk
retention across 299 pages. This is one Windows saved-output measurement,
excluding input reads, output writes, imports, and the separate second-pass
idempotence check. It is not ingest-VM parsing latency. The preceding local
repeat took 0.766 seconds with identical chunks.

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_heading_retention.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_heading_retention.py bench/parsers/reports/local/2026-09-09-odl-heading-retention NEW_OUTPUT
```

The reusable entry point is `retain_headings(blocks, parsed_pdf, chunks)`, which
returns augmented chunks and source decisions. Call it after the selected
chunker. The frozen script SHA-256 is
`4580aa433ac1d6fdd58167eff7a2240e49ba0be1e0fd8747d80a1b850cfcb782`.

Artifacts are under `local/2026-09-09-odl-heading-retention/`: source manifests,
frozen checks, all source crops, `r2/<case>/chunks.json`, decisions, the
verification record and source snapshot. The independent outputs and both rule
hashes are in `local/2026-09-09-odl-native-text/independent-r1/`. Focused real-PDF
checks exercise visible-title retention, invisible-OCR abstention, source boxes,
unchanged existing chunks and idempotence. Isolated Ruff checks pass.

## Subsequent 430-page regression review

The later 22-document corpus exposed one duplicate: the German *grosse-sprachmodelle*
page 22 bullet lead-in ending `fest-` was already present in a section path.
Canonicalizing the complete indexed text joined that hyphen to the following
body and hid the exact ancestor label from the presence check. The narrow
revision checks body, section path and indexed text separately, preserving the
existing canonicalization rule. Its SHA-256 is
`df24e2a14a76db178d5591053580bda3fc51abf5f1f97dadf9e618a41a5d0d4c`.

A bounded replay confirms every final chunk on the prior 335 pages is unchanged.
On the additional 430 pages, exactly the one redundant standalone chunk is
removed and all other chunks remain identical. All 17 original selected regions
were reviewed against source pixels; the remaining 16 preserve literal source
content, including titles, contents entries, affiliations and diagram labels.
They should not be counted as 16 verified section headings. The failed frozen
run and corrected replay remain separate under
`local/2026-09-09-odl-third-regression/native-review/`, with details in
`findings.md`, `source-audit.json` and `heading-presence-fix/summary.json`.
