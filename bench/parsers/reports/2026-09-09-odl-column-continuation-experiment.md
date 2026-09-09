# Body continuations interrupted by footnotes and figures

The source-supported reorder repairs the two remaining independently frozen
BERT and ResNet page 6 prose continuations. Across 13 documents and 335 pages,
it selects exactly these two pages. The five source prose checks improve from
3/5 to 5/5 in actual chunks. Every original native block, field, character and
source box is preserved. This is a benchmark-only saved-output experiment.

## Source diagnosis and rule

The independently frozen fixture is `fixtures/odl-independent-checks.json`.
Its two failed cases now serve as development examples for this rule. Both
source pages were rendered and visually inspected before implementation; the
other three prose checks serve as unchanged controls. The new manifest covers
the strongest preceding native-text, list and heading-retention outputs.

On BERT source page 6, native block 154 ends `passage from`. Block 155 contains
footnotes 9 and 10, before block 156 continues `Wikipedia containing the answer`.
The source body is 10.909 points and the footnotes are 8.966 points. The source
places the footnotes below the left body column and the continuation at the top
of the right body column.

On ResNet source page 6, block 208 ends `We have shown that`. Blocks 209–217
contain Figure 5's diagram labels, small native tables and caption. Block 218
continues `parameter-free, identity shortcuts help with training.` Body type is
9.963 points; the intervening figure text is at most 8.966 points. The source
shows a continuous sentence around this top-right float.

The rule looks for an unfinished text/list block near the bottom of a left
column followed later by a text block near the top of a similarly wide right
column. The left text and right first sentence must match their source regions.
Their boundary glyphs must have the same visible source font and size. They
must be the last and first body-sized text in their respective columns. Every
intervening block must lie below the left tail or above the right head, have no
heading level, and contain visible printed glyphs no larger than 92% of body
size. Hidden OCR supplies no glyph evidence. There are no document names,
expected-answer strings or caption-label allowlists in the selector.

The complete right native block moves immediately after the left tail. The
intervening material follows it, with its original content and geometry. This
local placement preserves a complete body paragraph and keeps the small-print
material available; it does not assign it a new semantic figure/footnote type.

## Verification and limits

Both target sentences appear consecutively within actual indexed chunks, with
the footnote/figure content outside the sentence. All native blocks are retained
as an exact multiset. Their source-page assignments and boxes are unchanged;
the complete set of citation regions in the final chunks is also unchanged.
The other 333 native pages remain exact. All eleven other documents have
identical raw output and chunks. The two affected documents may repack nearby
chunks because reading order changed.

The previous 12 heading-context checks, 16 native-text checks, 30 retention
checks and 4/8 list-label checks retain their scores. Repeating the operation
changes nothing, caller input stays untouched, and two full replay outputs are
identical. Focused generated-PDF checks accept the visible small-print case and
reject body-sized interruptions and invisible text.

Prose comparison uses NFKC normalization, so BERT page 5's printed `ﬁ` ligature
does not count as a text failure. The five prose checks do not certify BERT's
equations, table structure or full-document accuracy. The rule abstains on
unmatched source text, unequal body fonts, headings, ambiguous source geometry
or interruptions at body size. Broader mixed-layout reading order remains
outside this bounded rule.

## List citation coverage diagnosis

The earlier 12 truncated CCL list boxes are explained by the benchmark adapter:
`odl_content_list` recursively flattens list-item descendants into `list_items`
but takes geometry only from the parent list. For example, feedback page 4 list
id 74 has x=72–145.521 points, while included paragraph id 76 has x=72–525.543.
The original Java JSON retains the missing descendant boxes.

A diagnostic expansion of the source extraction window to the full page width,
retaining each list's vertical bounds, produces exact character-run source
correspondence in 10 of 12 cases, with source-painted evidence for 482 duplicate
deletions. COT page 14 block 256 and children page 8 block 116 still disagree.
This probe changes no native output and is not an accepted citation repair.
Same-page descendant unions provide a more precise next experiment, without
guessing page width; that experiment is separately authorized and recorded.

## Timing and reproduction

The final local saved-output replay takes 1.977 seconds for source inspection and
reordering across all 335 pages. It excludes imports, input/output JSON, chunking,
heading retention and the second idempotence pass. This is a Windows measurement,
not ingest-VM end-to-end parsing latency.

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_column_continuation.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_column_continuation.py bench/parsers/reports/local/2026-09-09-odl-column-continuation NEW_OUTPUT
```

Use `repair_columns(blocks, parsed_pdf)` from
[`experiment_odl_column_continuation.py`](../scripts/experiment_odl_column_continuation.py)
before bounded chunking and heading retention. The frozen SHA-256 is
`e217e2d5dea27be88de5dcf2faf7fc4560ac0aa34bb3d52421773340c47b257e`.
Isolated Ruff checks and focused checks pass.

Evidence is in `local/2026-09-09-odl-column-continuation/`: frozen source manifest
and checks, source page renders, complete page native snapshots, `r2/<case>/`
selected raw content and indexed chunks, source decisions, `verification.json`,
the list coverage probe and frozen script snapshot. `r1` preserves the first
run. The final checks fixture SHA-256 is
`90a8b1b5396695fd75739ec0feee7714b837b5e6b6c0a1e335ff0f86f556729f`.
