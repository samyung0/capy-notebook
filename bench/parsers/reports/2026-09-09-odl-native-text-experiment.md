# Source-confirmed native text repairs

The selected saved-output experiment removes 1,064 duplicated overprint
characters in 76 blocks across three Chinese papers. It also removes two false
heading assignments in NIST prose. The distance paragraph on source page 5 now
fits in one actual chunk. Its existing OCR transcription errors remain.

All ten development and transfer PDFs, 299 pages, were replayed. The 16 new
source checks improve from 7 passing checks to 15. The remaining German panel
title already exists in raw output but disappears during chunking; that is a
separate heading-retention experiment. These scoped checks do not establish a
document-wide accuracy percentage. Production remains unchanged.

## Source audit and frozen checks

The baseline is the strongest `extended-prefilter` native pipeline from the
[second pass](2026-09-09-odl-accuracy-second-pass.md), including fresh equivalent
processing of the two [font-transfer papers](2026-09-09-odl-font-transfer.md).
The canonical inputs are bound by the original PDF, parsed-copy and native-output
hashes in `local/2026-09-09-odl-third-pass/sources.json`.

Source page pixels were reviewed before implementing the repair. Sixteen checks
were frozen for Chinese titles, authors and labels; English and French prose
labels; Japanese, Spanish and Hong Kong headings; a German infographic panel;
and NIST's source page 5 paragraph. CCL feedback supplied development examples.
COT and children are document transfer checks, but their source pages were
viewed before implementation. They are not blind independent documents.

The check for a short label rejects extra copies of its first or last character.
The initial substring scorer incorrectly credited `摘要` inside `摘摘摘要要要`.
This scoring error was corrected before the final canonical replay; the source
annotation itself was unchanged. `r1` records that exploratory result and must
not supply the final baseline denominator.

## Why characters repeated

The source PDF paints the same Chinese glyph three times at almost the same
position to simulate bold. For example, the first CCL feedback title glyph has
origins at x=158.394, 158.609 and 158.824 points at a 14.346-point font size.
Java extracts all three drawings. Source pixels show one bold character, and
PyMuPDF's ordinary text extraction returns one character.

The repair requires complete correspondence between the native text and the
horizontal source text inside its box after ignoring whitespace and collapsing
adjacent character runs. Only run counts may decrease. Every removed copy must
also be supported by identical source glyphs, font and size painted within
0.06 em. Invisible and translucent text does not provide overprint evidence.
Characters, punctuation, digits and whitespace outside those deletions remain
unchanged. The rule contains no document names or expected answers.

Genuine repetitions such as `Booookscore`, URLs and repeated digits remain.
The candidate's initial screen looks for three consecutive non-whitespace
characters; double-only duplication is outside the tested rule.

Using the original corrupted Unicode map for source comparison rejected eleven
otherwise eligible CCL feedback paragraphs and one COT paragraph. The existing
font repair had already fixed their native Latin text, while the original PDF's
map still decoded it incorrectly. The selected replay therefore reads the exact
parsed PDF copy. All 40 pages in the two repaired PDFs render byte-identically
to their originals at 96 dpi. No fuzzy matching was added.

One CCL feedback block on page 14 still abstains. Native text says `GPT3.5` where
the source has `GPT-3.5`; this unrelated missing hyphen breaks the required full
correspondence. Its trailing duplicated `其他原因` label consequently remains.
The evidence is retained in `strict-abstention.json`.

This function processes text blocks only. A subsequent audit found 39 native
list blocks with the same overprint symptom. The separately frozen
[list adapter](2026-09-09-odl-list-text-experiment.md) repairs 25 while preserving
all original list boundaries; 14 abstain. Its whitespace-boundary check also
passes for all 76 text repairs reported here. Thus the single abstention above
is the text-block count, not the remaining count across every native shape.

## Paragraph roles

The separate paragraph arm checks a long native heading followed by lowercase
body text on the same page, with adjacent boxes and aligned right edges. The
complete heading must match one source line, and the beginning of the next
native paragraph must match the immediately following line in the same source
text block. Only the heading level is removed.

Exactly two NIST blocks qualify, on source pages 4 and 5. Visual review confirms
ordinary paragraphs in both places. Page 4 was discovered during candidate
evaluation and is a follow-up review, not a frozen transfer check. Hidden OCR
font metadata incorrectly marks parts of these lines bold, so font styling is
not used as a claim about the printed typography.

On page 5, `Distance I), figure 7, is chosen so that the base` and its continuation
now occur together in chunk 18. The source says `D`, and the candidate retains
the native `I)` error. A blank paragraph separator also remains between the two
native blocks. This is a heading-role and chunk-continuity improvement, not
complete transcription repair.

## Results and limits

| Arm | Changed blocks | New source checks |
| --- | ---: | ---: |
| Strongest prior native baseline | 0 | 7/16 |
| Source overprint deletion | 76 | 14/16 |
| Overprints plus paragraph roles | 78 | 15/16 |

The overprint changes comprise 30 CCL feedback blocks, 21 COT blocks and 25
children-paper blocks. The other seven documents are unchanged by that arm.
All 12 earlier heading-context checks still pass after the selected arm.
Every source box, page and unedited block remains exact. Repeating the repair
produces no further changes, and caller input is unchanged.

Source review also found substantial remaining limitations. German infographic
headings can be overwritten by sibling headings before any body content is
emitted. NIST still has faulty ancestors inherited from diagram labels and page
furniture. Its equations and optical transcription defects remain. Attention's
inline subscripts and mathematical layout require a separate fidelity strategy;
this rule does not reinterpret them. Correct table relationships still depend
on the separate table work.

The heading audit found 19 substantial German titles, eight Spanish headings
and one Hong Kong heading absent from indexed content, plus two NIST footer
strings. Those counts are an audit queue, not validated recovery claims.
`unindexed-headings.json` records their native locations and following blocks.

## Cost and reproduction

The final local replay spent 2.670 seconds inspecting source text and rewriting
all ten documents. This is one Windows AMD64 saved-output measurement, excluding
JSON reads, chunking, artifact writes, imports and the separate pixel-identity
check. It is not VM end-to-end parsing latency. Source-box prefiltering and
requesting text traces only after exact textual correspondence reduced the
earlier 9.232-second rewrite while retaining identical raw outputs and chunks.

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_native_text.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_native_text.py bench/parsers/reports/local/2026-09-09-odl-native-text NEW_OUTPUT --checks bench/parsers/reports/local/2026-09-09-odl-native-text/checks-v1.json --manifest bench/parsers/reports/local/2026-09-09-odl-third-pass/sources.json
```

The selected helper is `repair_text(blocks, parsed_pdf, paragraphs=True)` in
[`experiment_odl_native_text.py`](../scripts/experiment_odl_native_text.py).
It returns copied blocks and source evidence. Its frozen SHA-256 is
`624b890fe28097cdbd4d02420f96f6e72621815e1a1a7d3e5388c2409be68004`.

Artifacts live in `local/2026-09-09-odl-native-text/`. `r3/<case>/paragraph/`
contains the selected content lists, actual chunks with indexed text, and all
source decisions. `r1` and `r2` preserve earlier runs. Source renders, frozen
checks, `pixel-identity.json`, `verification.json`, `prior-heading-checks.json`,
`change-inventory.json`, the source snapshot and artifact manifest retain the
remaining evidence. Focused checks and isolated Ruff checks passed.

## Independent review: whitespace guard

The reviewer found an unsafe case outside the corpus: compacting whitespace
before run matching can merge equal characters from different numeric values.
For example, shortening `100000 0` toward source `1000 0` could instead remove
the final value. Exact whitespace preservation alone did not prevent this.

The reviewed revision rejects a whole block if a shortened compact character
run crosses whitespace in its original text. It leaves source whitespace
normalization and all glyph-evidence thresholds unchanged. Focused checks cover
spaces, embedded newlines, nonempty zero tokens on both sides, and an unrelated
valid repair beside unchanged repeated numeric values. The reviewer's rendered
PDF now abstains and retains both input values.

The selected revised SHA-256 is
`853ba96c59dc3bc131e053ea930a1000c04fed159d8ab391800cb65a859f2c03`.
The original `624b…68004` script and original runs remain in their frozen source
snapshot and directories. The new source snapshot is
`source-snapshot-whitespace-guard/`.

All 13 documents and 335 pages were replayed from their hash-bound native
inputs. Every direct-text output and chunk is identical to the original frozen
run. Applying the list adapter, bounded chunker and heading retention also
produces identical final content and indexed chunks. The previous 12 section,
16 native-text and 30 retention checks pass; the separate list fixture remains
4/8. The fresh BERT, ResNet and NIST shot-classifier documents remain unchanged
by the text and list rules. The revision changes the synthetic failure's
behavior without changing any measured corpus output.

`r4-whitespace-guard/` retains the ten-document three-arm replay; its selected
rewrite phase takes 2.447 seconds locally, under the same restricted timing
scope above. `whitespace-guard-verification/` retains the full 335-page composed
replay, explicit fixture results, original/revised hashes and synthetic PDF
result. The list replay is `local/2026-09-09-odl-list-text/r2-whitespace-guard/`.
Focused checks and isolated Ruff checks passed after the revision.

The later [list geometry experiment](2026-09-09-odl-list-geometry-experiment.md)
also corrected the shared label scorer: a final ancestor `A` could merge with a
correct body `A.1` after whitespace compaction and trigger the repeated-prefix
guard. The scorer now checks body and indexed text independently using the same
boundary rule. Source labels and every repair function remain unchanged; the
current full-script SHA-256 is
`76076811b4e163706bde3054d5005734d307f3f87f28e82ab948ba7a18223434`.
The before/after diagnostic and AST identity checks are retained in that
experiment's `scorer-correction.json`.
