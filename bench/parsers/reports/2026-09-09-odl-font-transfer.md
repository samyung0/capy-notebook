# Font repair on two unseen neighboring papers

The unchanged font rule successfully transfers to a second damaged PDF. The
24-page COT paper's source-page-6 table improves from zero readable numeric cells
to all 66 exact values. All six numeric row sequences survive together in one
production chunk. The adjacent 21-page children's-news paper has no qualifying
font and remains unchanged by this repair.

This is evidence for one specific font defect in another document from the same
publisher. It is not independent validation across PDF producers or font types.
Across the original eight documents and these two additions, the rule selects
two fonts in two documents and abstains on the other eight documents, 299 pages
in total.

## Selection and source checks

The two immediately adjacent ACL Anthology papers were selected by identifier
before downloading or inspecting their PDFs. The selection is retained in
`selection-before-download.json`, with the tracked
[source manifest](../fixtures/odl-font-transfer-sources.json) recording URLs and
the resulting hashes.

| Source | Pages | SHA-256 |
| --- | ---: | --- |
| [Cross-lingual Multi-document Summarization Based on Chain-of-Thought](https://aclanthology.org/2024.ccl-1.9/) | 24 | `87bb845a8843bde1527827dcfa2e0070a5207087f9f93739497c5997cf270e0b` |
| [Text Styles and Thematic Framework Guided Large Modeling to Aid Children's News Generation](https://aclanthology.org/2024.ccl-1.11/) | 21 | `e7d6af6e204d97a2ad61730d8fbdd518df227fcd50cc0446e675444d762be80c` |

Source pages 1, 2, 4 and 6 of each document were rendered locally. The
[transfer checks](../fixtures/odl-font-transfer-checks.json) freeze all six rows
and eleven numeric columns of COT Table 1 on source page 6, plus twelve page
identifiers, before any Java candidate extraction. These are AI-transcribed
source checks, not independently certified ground truth. The children document
is a negative control for font eligibility, not a claim of perfect parsing.

The same literal-Type1-encoding rule from the
[first font experiment](2026-09-09-odl-font-recovery-experiment.md) selects only
COT font xref 144, `PFNCUS+CMR10`. It independently supplies Latin glyph names
while its assigned whole-byte Unicode map points into Chinese characters.
The children document has no eligible font. No threshold or font rule was
changed after seeing these documents.

## Fresh results

| Arm | Exact numeric cells in order | Numeric rows together in one chunk | Page identifiers found | Document chunks |
| --- | ---: | ---: | ---: | ---: |
| Original Java | 0/66 | 0/6 | 3/12 | 144 |
| Remove contradictory map | 66/66 | 6/6 | 12/12 | 106 |
| Attach rebuilt map to selected font | 66/66 | 6/6 | 12/12 | 106 |

All six numeric row sequences are in chunk 22, zero based, in both repaired
outputs. The identifier metric counts presence anywhere on source page 6,
including footnotes. Three identifiers were already present in the original
page's readable URLs; this is not a claim that all twelve prose names were
initially absent.

Both temporary repaired PDFs render identically to the original on every page
at 144 dpi, 48 page comparisons in total. The shared original mapping is not
mutated. The two repaired outputs have different full-text hashes, partly
because removing the map retains presentation ligatures. Their scored numeric
values are identical.

The font audit took 0.1599 seconds for COT and 0.0480 seconds for the control
on the ingest VM. Rebuilding the map took 0.1220 seconds; removal took 0.0080
seconds. Fresh Java processes took 2.976 seconds original, 2.724 seconds with
removal and 2.675 seconds with rebuilding. These are one observation per arm
in that order, not evidence that repair speeds Java up. Pixel comparison,
downloads, captions and indexing are outside those component timings.

The existing `capy-java-native:20260909` image ran with eight CPUs, 14 GiB memory,
network disabled and no published ports. It contains OpenDataLoader 2.5.7,
PyMuPDF 1.28.2 and pypdf 6.18.0. The original PDFs were mounted read-only.

## Numbers are only part of table fidelity

Font repair restores Latin text, punctuation and numbers. Java still flattens
the nested Sentences/Words/Tokens headers and separates some SDS/MDS group
labels from their rows. The numeric score explicitly excludes those semantic
claims.

The separate [table geometry experiment](2026-09-09-odl-table-geometry-experiment.md)
froze its rule before receiving these repaired bytes. Its first transfer output
got all 66 values and eleven numeric headers right but assigned SDS/MDS only to
the middle rows. That transfer failed full table meaning. A later rule uses
horizontal separators and vertically centered labels to recover the group
spans; COT is development data for that revised rule. This distinction is
retained in its report and artifacts.

## Reproduction and evidence

Use `prepare_new_parser_corpus.py` with the source manifest to fetch and prepare
the two PDFs. Use a fresh output directory for each run. On the VM:

```sh
python experiment_odl_font_recovery.py prepare --root /transfer --output /transfer/new-run --checks /checks/odl-font-transfer-checks.json
python experiment_odl_font_recovery.py run --root /transfer --output /transfer/new-run
```

Score the full outputs with the transfer-specific scorer, not the original
font scorer, whose source table is the first CCL paper:

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/score_odl_font_transfer.py bench/parsers/reports/local/2026-09-09-odl-font-transfer/r2 bench/parsers/reports/local/2026-09-09-odl-font-transfer/inputs/ccl-cot.pdf bench/parsers/fixtures/odl-font-transfer-checks.json NEW_SCORE_DIRECTORY
```

Raw evidence is under `bench/parsers/reports/local/2026-09-09-odl-font-transfer/`
and `/opt/capy-odl-font-transfer-20260909` on the VM. It includes source PDFs,
download hashes, source PNGs, original and repaired Java outputs, encoding/map
evidence, every pixel hash, timings and scored production chunks.

The first VM preparation stopped before parsing because the Windows-generated
corpus manifest used backslashes. Only path separators were normalized; the
original manifest is retained as `corpus-before-path-portability.json` and the
incomplete `r1` directory remains on the VM. Completed evidence is `r2` and
`score-r1`. PDF bytes and the selected source set did not change.
