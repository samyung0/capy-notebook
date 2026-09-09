# Source-backed heading context

The selected benchmark candidate passes all 12 source section checks, compared
with 3 for the previous combined candidate. It removes page numbers from section
paths, repairs the German chapter context and keeps a continuing subsection
across a page boundary. Both earlier German column-continuation gains survive.
Production code remains unchanged.

The checks cover specific paragraphs and tables in five PDFs. They do not
establish a complete document outline or general parser accuracy. This experiment
replays saved output; the separate integrated run measures fresh parsing.

## Inputs and source checks

Inputs are the previous `odl-accuracy/combined-final` content lists, including the
font, reading-order, native-table and source-style experiments. The five intact
documents contain 167 pages: German education, Attention, French complexity,
Japanese migration and Hong Kong figures. Each PDF and input content list is
bound by SHA-256 in `sources.json`.

Eleven section checks were frozen after visual source review and before the first
candidate implementation. Five concern German source pages 3, 23 and 29. Six
transfer controls concern English/French sections continuing across pages and
the Japanese main heading and prefecture-table title. The Hong Kong document is
an additional unchanged-output control without a new section rubric.

The rule-development review then found that German page 30 continues page 29's
subsection beneath a repeated chapter banner. A twelfth source check was frozen
before implementing running-header handling. It is a development follow-up,
despite the historical `supplementary_transfer` label in its raw fixture; it is
not an independent held-out result. The original eleven checks are unchanged.

Checks inspect actual chunk text, `section_path` and `indexed_text()`. Every chunk
containing a probe paragraph must have the correct context; an incorrect overlap
copy fails the check even when another copy is correct. Checks reject unrelated
sibling headings and numerical-only path components. Source images and their
hashes are retained alongside the fixtures.

## What caused the bad context

Java assigned heading levels to printed page numbers. Those headings stayed in
the stack when the next page continued a section. The Attention and French
examples therefore inherited the previous page number as a subsection.

German chapter tabs have consistent vertical white bold text at the outer page
edge, but Java assigned them deep heading levels. Earlier graph values and titles
survived above the real chapter label. Java also split the first two lines of a
bold inline paragraph label into a heading on page 23, making later paragraphs
inherit that label.

Page 29 exposed a separate order defect: both column headings preceded the
left-column prose. The earlier column repair moved prose blocks while leaving
those headings in place. Finally, the repeated chapter banner on page 30
incorrectly replaced the subsection that continued from page 29.

## Candidate rules

The runner first matches native heading geometry and text against actual PDF
spans. Unmatched source text does not establish a new heading role.

- A numeric footer requires a consistent source font/position and printed-number
  offset across at least three pages. It becomes ordinary text rather than a
  heading. The literal block and its source box remain available.
- Chapter-tab classification requires vertical white bold source text at the
  outer margin and the same source font/style on at least three pages. A new
  chapter label starts a root section; later copies of the same tab are ordinary
  running text. Labels move ahead of their page's prose. The initial version
  required repeated exact tab text and missed a unique chapter label; the final
  rule uses the repeated physical style instead.
- A clipped inline label is recognized when the next tightly spaced source line
  continues the same font/color, ends its bold prefix with a colon and then
  switches to ordinary prose. Its partial native heading becomes body text.
- A repeated top banner loses heading status only when the same actual title
  occurred earlier in another source position or font. The existing subsection
  then continues beneath that banner. There is no unconditional page reset.
- The existing empty-gutter column check also orders headings with their own
  column. It still abstains on native pages containing tables/images/equations.

The selected arm is `structure`. The earlier `footers` and `tabs` arms remain
available as controls. No rule contains a document ID, answer phrase or expected
section title from the rubric.

## Results

| Arm | Source section checks |
| --- | ---: |
| Previous combined output | 3/12 |
| Footer classification only | 7/12 |
| Footer and chapter-tab handling | 8/12 |
| Selected source-role and column-heading rules | 12/12 |

The six original non-German transfer checks pass after footer handling, including
the two Japanese checks that were already correct. The five German checks and
the added page-30 continuation pass with the selected arm. For example, the
social and regional paragraphs on page 23 now belong to the chapter tab rather
than earlier graph values or the preceding paragraph's inline label. Each page-29
column belongs to its own heading, and its right-column subsection continues
into page 30.

The candidate changes heading metadata and block order only. A multiset assertion
verifies every other field, including text, table HTML, page index, box and native
ID. Both earlier German continuations still occupy individual chunks with their
original page regions. The 88 previously supported native-table chunks retain
their text, source regions and explicitly attached titles. No unique alphabetic
word token disappears from indexed output across the five documents. These are
regression diagnostics, not substitutes for source accuracy checks.

Hong Kong produces no heading changes. The candidate does not classify every
graph label or reconstruct missing headings. Attention still carries its arXiv
identifier above the substantive outline. Existing source content that was
already missing or incorrectly recognized is outside this metadata repair.
Only five documents were replayed in this lane; the root integrated experiment
must separately verify coverage of all eight fresh native results.

## Cost and reproduction

Three sequential local repeats measured source inspection plus metadata rewriting
at a median **4.438 seconds for 167 pages** on Windows 11, AMD64 Family 23 Model
113. PDF source inspection dominates this time. The timer includes opening the
PDFs, source-span matching, classification, deep copying and conservation checks.
It excludes input JSON reads, chunking, output writes and Python imports. This
local result must not be treated as ingest-VM latency or combined parsing time.

The later [combined evaluation](2026-09-09-odl-accuracy-second-pass.md) profiles
and optimizes this source-matching loop. It skips disjoint positive-area span
boxes before the unchanged 60% overlap test and preserves the prior handling of
empty boxes. Three alternating local timing pairs reduce `source_headings` alone
from 2.971 to 0.968 seconds on these same five PDFs. All 510 source-evidence
records and 80 downstream files remain exact. That narrower, warm-process phase
timing is separate from the 4.438-second measurement above. The combined report
provides fresh eight-document VM timings and exact output comparisons.

```sh
uv run --with pymupdf==1.28.2 python \
  bench/parsers/scripts/experiment_odl_heading_context.py --check

uv run --with pymupdf==1.28.2 python \
  bench/parsers/scripts/experiment_odl_heading_context.py \
  bench/parsers/reports/local/2026-09-09-odl-heading-context \
  /path/to/new-output \
  --checks bench/parsers/reports/local/2026-09-09-odl-heading-context/checks-v2.json
```

For an integrated fresh run, call `source_headings(blocks, pdf_path)` and then
`rewrite(blocks, evidence, "structure")`. Recompute source evidence for the exact
input list because evidence keys are its integer block indices. Chunk the result
through the existing bounded native-table candidate to retain its table gains.

Artifacts are under
`bench/parsers/reports/local/2026-09-09-odl-heading-context/`:

- `checks-v1.json`, `checks-v2.json` and `sources.json` bind source judgments and inputs.
- `run-final/<case>/structure/` contains the selected raw blocks, actual chunks and changes.
- `run-final/<case>/source-headings.json` records matching source fonts and role evidence.
- `quality-preservation.json` records continuation, table and lexical preservation checks.
- `timing-local.json` records every local timing repeat.
- `source-snapshot/` and `artifact-manifest.json` bind the executed helpers and saved evidence.

The focused executable check creates real PDF source spans and checks footer
sequences, vertical tabs, repeated banners and metadata conservation. Isolated
Ruff formatting/checks passed. No shared package or formatter command was run
for this follow-up lane.
