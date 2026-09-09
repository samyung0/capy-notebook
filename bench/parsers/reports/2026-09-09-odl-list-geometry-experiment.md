# Native list descendant geometry and strict glyph repair

Using the geometry of text actually flattened from Java list descendants repairs
64 citation boxes across 13 documents and 335 pages. It also enables ten more
strict overprint repairs, removing 482 extra characters. The composed pipeline
now repairs 35 lists and removes 1,012 list overprints. Ten newly frozen source
labels improve from 0/10 to 10/10 in actual chunks. This is a benchmark-only arm.

## Cause, source review and rule

`compare_opendataloader.odl_content_list` includes `node_text(item)` for each
native list item. That function recursively includes child paragraphs, nested
lists and table-like text. The adapter previously kept only the parent list's
box, even when child text extended outside it. Feedback page 4 Java list id 74,
for example, has x=72–145.521 points; its included paragraph id 76 extends to
x=525.543. The saved Java output already contains this geometry.

The first audit used the preceding completed list-repair outputs. It found 62
expandable boxes and 25 changed-list identity mismatches. Final composition must
run geometry before glyph repairs, so the final manifest instead uses the
original extended native outputs. That exposes two more expansions, both only
0.002 units in page-1000 coordinates. All 64 candidate source crops were rendered
with the old and union boxes and visually reviewed before implementing this arm.
Ten Chinese labels were independently read from those source images and frozen
before candidate scoring. `checks-v1.json` preserves the earlier audit;
`checks-v2.json` binds the final source manifest and 64 reviews.

The rule requires a unique native list id, exact `list_items` text matching Java's
existing `node_text` traversal, and an unchanged original parent box. It unions
only boxes of text-bearing nodes reached by that traversal under the list items.
It excludes table rows/cells that `node_text` never flattened. Every contributing
node must have valid geometry on the same source page. Missing, changed,
ambiguous, rotated or cross-page inputs abstain. The old parent box is included,
so the result only expands. All text and unrelated fields remain exact.

No page-width guess or source transcription is introduced. The geometry arm runs
before the unchanged text/list glyph rules; those still require complete source
correspondence, painted duplicate-glyph evidence and whitespace-boundary safety.
Column continuation, bounded chunking and heading retention follow.

## Results

| Document | Expanded list boxes |
| --- | ---: |
| CCL feedback | 7 |
| CCL chain of thought | 15 |
| CCL children | 4 |
| Spanish figures | 10 |
| German education | 2 |
| Hong Kong figures | 6 |
| NIST accelerometers | 1 |
| BERT | 3 |
| ResNet | 1 |
| NIST shot classifier | 15 |

Attention, French TALN and Japanese migration have no geometry selections.
Of the 64 expansions, 53 move an edge by at least one PDF point; four move it by
less than 0.01 point. These counts distinguish structural corrections from
substantial visible changes. The complete source-region fixture passes 64/64
in the actual chunk citations. A larger list box remains a conservative region;
it does not certify table row relationships, OCR transcription or tight
word-level highlighting.

The ten newly repaired lists comprise five feedback blocks, four COT blocks and
one children-paper block. They remove 478 CJK copies and four fullwidth colons.
Combined with the previous list arm, the totals are 35 repaired lists, 990 CJK
copies and 22 fullwidth colons. All numeric sequences remain exact. Every new
accepted repair has complete source text and visible glyph-cluster evidence in
`new-glyph-evidence.json`, and its source region was visually reviewed.

The prior 12 heading-context checks, 16 native-text checks and 30 heading-retention
checks pass. The earlier list-label fixture improves from 4/8 to 7/8. All five
independent prose checks pass, preserving the BERT and ResNet continuations.
The geometry-only phase leaves every chunk's text, section path, page range and
other non-region fields identical. Composing all stages is idempotent. The first
and final replays produce identical raw content and final chunks.

## Remaining failures and scorer correction

Four list blocks still abstain after their geometry is corrected where needed:

| Source location | Independent mismatch or ambiguity |
| --- | --- |
| COT page 14, native block 256 | Native `lowquality` versus source `low-quality` |
| Children page 5, block 62 | Prime/subscript sequence `Di′2` versus `D′i2` |
| Children page 8, block 116 | Native `Gemini-1.0pro` versus source `Gemini-1.0-pro` |
| Children page 16, block 251 | Removing copies would redistribute a caption character across whitespace |

The separate feedback page 14 text-block abstention also remains because of
`GPT3.5` versus source `GPT-3.5`. None of those characters is guessed or replaced.
`remaining-abstentions.json` retains the complete comparisons. NIST optical
errors and mathematical reconstruction remain outside the geometry claim.

The first geometry replay's shared label scorer reported 9/10 because ancestor
`A` was compacted directly against body heading `A.1`. Its repeated-prefix guard
then incorrectly rejected a correct body label. The shared scorer now checks
body text and indexed text separately with the same boundary regex. The source
strings did not change. The final result is 10/10; raw content and chunks are
identical before and after this scoring correction. Focused checks still reject
a genuinely repeated `AAA.1` prefix. AST comparison verifies that every native
text repair function is unchanged. `scorer-correction.json` records both scores,
hashes and the exact source label.

## Inputs, timing and reproduction

The source manifest records the original extended output before text/list glyph
repairs. Its `native_json` is the single Java JSON in `<entry.baseline>/native/`
after excluding `content_list.json` and `result.json`: usually `<document>.json`,
or `repaired.json` for a repaired PDF. The manifest records its exact path and
SHA-256. The CLI loads that recorded file and verifies the native receipt's
`pdf_sha256` against the parsed PDF, along with input and receipt hashes. The
comparison baseline is the completed column-continuation run.

The final local geometry phase takes 0.266 seconds across 335 pages, excluding
JSON reads/writes, imports and all subsequent glyph, column, chunking and
retention work. The preceding runs took 0.289 and 0.260 seconds. These are saved
output timings on Windows, not ingest-VM end-to-end parser latency.

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_list_geometry.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_list_geometry.py bench/parsers/reports/local/2026-09-09-odl-list-geometry NEW_OUTPUT --baseline bench/parsers/reports/local/2026-09-09-odl-column-continuation/r2
```

The helper is `repair_list_geometry(blocks, native_document, parsed_pdf)`, where
`native_document` is the decoded original Java JSON. It returns copied blocks
and decisions. The selected
[`experiment_odl_list_geometry.py`](../scripts/experiment_odl_list_geometry.py)
SHA-256 is `7c4e99275b78e73499c174bede798a8793a82ad06560abaa40bb33e4115a96e4`.
The corrected shared native-text scorer's full-script SHA-256 is
`76076811b4e163706bde3054d5005734d307f3f87f28e82ab948ba7a18223434`.
Focused included-descendant, text-identity, cross-page and idempotence checks and
isolated Ruff checks pass. No production files are changed.

Evidence is under `local/2026-09-09-odl-list-geometry/`: `r3/<case>/` contains the
selected geometry-only blocks, composed content, indexed chunks and source
decisions. `verification.json`, `breadth.json`, source crops, frozen checks,
remaining abstentions, glyph evidence and script snapshots retain the audit.
The final fixture SHA-256 is
`962e51846a38375f1f831a70c3268bb68b316284241d74cefbfc1676d7a9168b`.
Earlier runs retain the scorer diagnosis and intermediate results; `r3` is the
canonical final replay with all dependency hashes recorded.
