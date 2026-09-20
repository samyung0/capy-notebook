# Parser handoff investigation and fix experiments

2026-09-20. Local experiments against the source PDF and cached raw parser bundles.
The production parser, chunker, builder runs and deployed services are unchanged.

The missing physics values are reproducible. The most useful new finding is that
the PDF retains many of them in its accessibility structure. A conservative
benchmark recovers the page-99 distances and all four answer associations without
OCR or a model. The heading repairs also work on the measured cases. Geometry
alone is an incomplete and relatively expensive way to select math recovery.

## Why the failure happens

1. The inspected physics PDF draws the missing values as vector paths. Page 99
   has 70 drawing records, but native extraction reads `walks ... to the left`
   and `Distance is ... and displacement is .` without the values.
2. `parser/odl/ocr.py::textless_pages` routes a page only below 40 native
   characters. Ordinary prose on these pages keeps them out of OCR.
3. `pipeline/pipeline/retrieval/confidence.py::score_chunk` compares chunk word
   tokens to the same incomplete text layer. Coverage also measures that layer,
   so neither direction can discover printed information absent from it.
   Operators, expression scope, and reading order are not measured.
4. `parser/odl/headings.py::correct_roles` recognizes recurring margin banners
   through a numeric folio. The repeated `Access for free at openstax.org`
   heading has none. Heading blocks are excluded from ordinary repeated-text
   furniture detection, so this footer survives in ancestry.
5. The PDF outline makes Contents, Preface and chapters peers at level 1.
   ODL's visual levels are 1, 3 and 5. The chunker pops only equal or deeper
   levels, so chapters remain below Contents and Preface.

Confidence 1.0 means text-layer agreement under this contract. It is not a
probability that the extracted passage matches the rendered page.

## The overlooked recovery source

The original PDF has 5,094 reachable `/Figure` structure elements with `/Alt`,
page references and layout bounding boxes. Of these, 3,790 have no explicit
`Placement` attribute and 1,304 have `Placement /Block`. For example:

| Page 99 structure object | Source alternative |
| --- | --- |
| 15551 | `35 meters` |
| 15552 | `18 meters` |
| 15553 | `26 meters` |
| 15558 | `79 m` |
| 15559 | `negative 43 m` |

The values are absent from native glyph extraction, but present in the source
document. No `ActualText` entries were found in the original PDF. This changes
the recovery options in the handoff.

The [native alternative experiment](../scripts/experiment_prince_native_alt.py)
walks reachable structure elements and inserts alternatives only when a unique
existing text/list block contains the entire box, native characters match that
block exactly, and adjacent characters on the same row locate the insertion.
It preserves original item boundaries and strings. Duplicate scopes/boxes,
noninteger marked-content children, rotations, ambiguous ownership, existing
native text and unmatched characters abstain. The absent-Placement filter is a
corpus-specific restriction, not a general proof of inline semantics.

Final run `local/2026-09-20-prince-native-alt/r4` exited successfully:

| Measurement | Result |
| --- | ---: |
| Alternatives inserted | 2,062 |
| Modified cached blocks | 739 |
| Block alternatives left for review | 1,304 |
| Alternatives without a unique containing block | 1,481 |
| Native-character mismatch abstentions | 198 |
| Other abstentions | 49 |
| Tag inventory / insertion time | 5.00 s / 31.68 s |
| Inventory, insertion, packing and scoring | 52.33 s |

These are intervention counts, not an accuracy score. No independent book-wide
visual adjudication was done. Native replay uses `pack_blocks` and confidence;
the heading experiment below also runs orphan-heading retention. Their baseline
chunk counts therefore differ, 3,079 versus 3,106.

The page-99 assertions check the exact walking sequence and all four option
associations. Two unaffected neighboring problem blocks remain byte-identical,
and the graph alternative is excluded. The restored text includes:

> walks 35 meters to the left, 18 meters to the right, and then 26 meters to the left?

> a. Distance is 79 m and displacement is negative 43 m

Visually inspected witnesses on pages 97, 103 and 616 also have their selected
values in the candidate packed text. These latter checks are page-presence
diagnostics, not association scores. Page 98 remains unresolved because its
option formulas lie outside the narrow ODL list box. Page 262's worked display
equation remains unresolved because block alternatives are excluded.

Alternatives are source-authored descriptions. They can be ambiguous or wrong:
the page-99 graph alternative describes coordinates in reversed order relative
to the plotted axes. The prototype keeps spoken mathematics verbatim and does
not invent a conversion to LaTeX. It must not be presented as exact general
formula transcription.

A second, cheaper candidate was rejected. Adding `/ActualText (35 meters)` to
the existing vector marked-content group in memory did not make PyMuPDF 1.28.2
extract the value. This probe modifies no file and tests only that extraction
engine; it does not establish how Java ODL would handle the altered document.

The repaired page-99 chunk scores 0.921 with no reasons against the incomplete
native layer. That score is another demonstration of the old metric's limits,
not evidence for or against the correction.

## Heading experiments

The [heading report](2026-09-20-prince-headings.md) compares cached output across
physics and five prior textbooks. The supported candidate combines exact
source-matched recurring margin-banner removal with outline-root levels. It
requires complete root matching before changing levels, uses outline destination
geometry for ambiguous titles and handles a literal two-block appendix title.

| Physics measurement | Baseline | Combined candidate |
| --- | ---: | ---: |
| Footer breadcrumb chunks | 477 | 0 |
| Contents/PREFACE prefixes on chunks starting at page 17 or later | 3,033 | 0 |
| Stale earlier outline-root ancestry | 3,046 | 0 |
| Matched outline headings retained and readable | 225 | 225 |
| Previously literal-covered body blocks retained | 6,089 | 6,089 |
| Chunks after packing and heading retention | 3,106 | 2,934 |

The candidate discards 434 footer blocks and changes 26 root levels after
matching all 27 roots. It does not change body block payloads. Removing false
heading boundaries changes packing: 2,616 canonical chunk strings remain,
490 old strings disappear and 318 new strings appear. These are regroupings,
not a finding that 490 passages were lost. Existing source coverage is checked
separately.

The experiment also repairs stale appendix ancestry in OS4 and AHSS4 and the
cover-title prefix in Hefferon. LSJ and Exo7 abstain on incomplete root matching.
No previously covered body blocks are lost in the six-book replay. This is
bounded cached-output evidence; it does not measure retrieval quality after
fresh parsing and re-embedding.

Simple name-based demotion was rejected. Removing Contents and Preface levels
lets an earlier cover slogan parent 2,901 paths. Partial root promotion was also
rejected because it nests unmatched chapters below earlier promoted roots.

One boundary defect remains explicit: a chunk spanning pages 15-17 appends the
standalone `CHAPTER 1` label under Preface before the true title starts. Chapter
prose no longer inherits Preface, but the repair is not a claim that every
cross-page front-matter boundary is solved.

## Geometry and warning propagation

The [geometry report](2026-09-20-prince-math-loss.md) freezes 37 rendered-source
regions before implementation, then compares two bounded rules:

| Frozen region category | Final result |
| --- | --- |
| 12 inline-math witness regions | 12 flagged |
| 5 standalone equation regions | 0 flagged |
| 20 negative regions | 2 false positives |

Region recall overstates formula recall. On page 98, choices c/d are detected
while a/b are missed. Small circuit illustrations and a spectrum strip produce
the two false positives. The detector does not recover any values.

Across the 24 selected pages, it adds reasons to 17 raw chunks. All retain
scores from 0.976 to 1.0. Calling the real `Passage.location()` shows none of
those new reasons, because the entire note is gated below 0.9. Attaching a
`[math]` placeholder or a reason alone therefore does not make capture run.
`score_chunks` also overwrites existing reasons, so insertion timing matters.

The full 875-page geometry pass takes 144.36 seconds and produces 2,820
unadjudicated detections affecting 777 chunks, with 50 detections unmatched.
Only six already-low-score chunks expose the added reason. These are warning
volume and runtime measurements, not prevalence or accuracy estimates.

This detector is not ready as an automatic transcription selector. Native
alternatives are the better first experiment where available. Pages without
usable semantics still need an explicitly measured visual recovery path,
including standalone equations and formula regions with no native text anchor.

## What the older benchmarks missed

The handoff overstates the fixture gap. Earlier RAG runs did include scans,
including the NIST equations and newspaper cases in
[the capture-page report](../../rag/reports/2026-09-12-capture-page-playground.md).
The specific missing coverage is mixed native prose plus absent vector math.
Tests against an incomplete native reference can pass by design.

The [September 16 selective comparison](2026-09-16-selective-recovery-comparison.md)
already showed only 2 of 16 manually damaged regions intersecting low-confidence
chunks. It measured transcription on selected crops, not automatic selection
recall. The [September 13 boundary experiment](2026-09-13-section-boundaries.md)
also showed a useful answer falling from dense rank 1 to 19 while page-hit
metrics still looked successful. New tests must check the answer-bearing span,
formula scope and ownership, not just page hits or token presence.

Two smaller handoff corrections matter. `exponents.py` reads glyph geometry;
drawing readers are elsewhere in the parser. Also, comparing Qwen corrections
with original chunks does not yield an exact original-error count. Transcription
and alignment can themselves be wrong. Source adjudication is still required.

## Recommended next implementation

Implement the measured source-matched banner and complete outline-root repairs
first. Keep their body-retention and outline controls, and rerun fresh parsing
before release. The old column-boundary proposal remains rejected on prior
retrieval evidence; it was not revived here.

Develop native alternative recovery next, with explicit alternative provenance,
exact list-item ownership and separate handling for display math. Preserve
abstention when tags, glyph alignment or ownership are unsupported. Evaluate on
additional independently selected PDFs before promoting it from a physics
prototype. CMEX/font repair was not newly benchmarked and cannot restore vector
paths absent from the glyph layer.

Represent detected visual loss separately from text-layer agreement and expose
it to capture regardless of the agreement score. Carry its actual region through
the parse bundle, packing and stored passage evidence. Do not assign an arbitrary
0.89 score and call it calibrated confidence. The display-equation misses mean
this geometry detector cannot be the sole source of that signal.

Any promoted parser/content change needs the corresponding artifact identity
change, reparse/reindex and matched retrieval validation. These experiments do
not deploy or invalidate existing parse donors.

## Reproduction and verification

The source PDF and full raw bundles are local, ignored artifacts, not included
in a clean clone. The source URL, licence and hash are recorded in
`data/knowledge-base/runs/physics/manifest.json`. Source SHA-256 is
`a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e`;
raw block SHA-256 is
`a99e0056d5cdab1109871012686d90782f24bd3babba2423f4c3bdd3b1d52d5b`.
The native run records script/fixture hashes and PyMuPDF version; the other
reports record their own inputs and methods. Corrected `corpus.json` text was
not used as a parser baseline.

```powershell
uv run --frozen python bench/parsers/scripts/experiment_prince_native_alt.py --check
uv run --frozen python bench/parsers/scripts/experiment_prince_native_alt.py --pdf data/knowledge-base/sources/a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e.pdf --parsed data/knowledge-base/runs/physics/books/physics/parsed --output bench/parsers/reports/local/2026-09-20-prince-native-alt/new-run
uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py --self-check
uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py
uv run --frozen python bench/parsers/scripts/experiment_prince_math_loss.py
uv run --frozen python bench/parsers/scripts/experiment_prince_math_loss.py --whole-book
pnpm test:pipeline:offline pipeline/tests/test_confidence.py pipeline/tests/test_odl_role_recovery.py pipeline/tests/test_packing.py
```

The focused test command passed 22 tests. Native insertion self-checks and the
final source run passed, including exact distances and all four page-99 answer
associations. Independent Astra medium review found a list-boundary insertion
bug in the prototype; it was fixed and the original reproduction plus duplicate
and complex-scope abstentions passed recheck. Astra xhigh subagents performed
the heading and geometry experiments. New Python scripts were checked with
targeted Ruff formatting/linting. No provider calls or shared-host jobs ran.
