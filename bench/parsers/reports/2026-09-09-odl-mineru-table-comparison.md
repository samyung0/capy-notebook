# OpenDataLoader and MinerU: source table meaning

The refined OpenDataLoader candidate is substantially better on the 26 tables its conservative source-geometry rule successfully repairs. It does **not** establish general table-quality parity with MinerU. On the ten numeric tables from the independent BERT/ResNet source set, MinerU retains more complete tables, while both parsers fail several complex layouts. Keep the cluster detector and header/footer inclusion, then propagate explicit footer ancestry: this removes 49 false footer tables while preserving the reviewed table results. The default detector and global header/footer exclusion each introduce a confirmed regression.

This is a source audit of **37 tables**, not an accuracy estimate for all tables in the 335-page corpus. The first 26 tables were selected by successful candidate recovery and contain 135 source rows. The independent set contains ten numeric tables with 61 rows and one complex architecture table. The revised geometry rule was developed after its first failed independent transfer; this final comparison must not be presented as another untouched holdout result.

## Inputs and scoring

MinerU is the actual fresh **3.4.5** run over all 13 documents, with existing production adaptation and chunking at `local/2026-09-09-odl-third-pass/mineru-production-r1`. The separate `mineru-bounded-r1` outputs are diagnostic and are **not scored here**. OpenDataLoader is `composed-tables-r1`; all 26 recovered blocks are exactly conserved in `composed-cluster-r2`, and the fresh `refined-cluster-r1` replay is exactly equivalent to that composition. Root records those conservation checks separately.

Ground truth is the original source PDFs, the previous complete visual/source audit of all 26 recovered tables, and the frozen `fixtures/odl-independent-checks.json` for BERT/ResNet. Source page renders and selected raw blocks/final chunks are retained in [the comparison raw directory](local/2026-09-09-odl-mineru-table-comparison). No new model or provider calls were needed for this comparison.

**Core meaning** requires every source row label/value, column and group scope, table identifier/title, units and table-local notes to remain interpretable in the actual indexed chunks, with a correct source citation. Source blank continuation labels are legitimate when their parent relation and ordering remain clear. Numeric emphasis is a separate dimension; the audit does not claim all typography is retained. Global document symbol legends are outside the table-local rubric.

Two weaker diagnostics are also reported. Development *ordered rows* require each full span-expanded source row to occur in order; raw HTML and production chunks are scored separately. Independent *literal rows* require the source label and all values, including missing-value marks, to survive together in a source-overlapping block/chunk. This can pass a flattened paragraph and is not proof of correct column/header meaning. Whitespace, ordinary Markdown/LaTeX formatting and typographic punctuation are normalized; missing-value marks and substantive labels are not discarded. The two diagnostics have different definitions and must not be pooled.

## Results

| Source set and dimension | Refined ODL | Existing MinerU |
| --- | ---: | ---: |
| Selected development tables: complete core meaning | 26/26 | 7/26 |
| Selected development rows: ordered rows in raw output | 135/135 | 102/135 |
| Selected development rows: ordered rows in final chunks | 135/135 | 91/135 |
| Development tables with numeric emphasis: all required emphasis retained | 14/14 | 0/14 |
| Independent numeric tables: complete core meaning | 0/10 | 4/10 |
| Independent numeric rows: literal rows in final chunks | 22/61 | 29/61 |
| Independent complex architecture table: complete core meaning | 0/1 | 0/1 |
| Architecture table: correct FLOP power notation | 5/5 | 0/5 |

All 26 development table citations point to the correct source page and body region for both parsers. The 14 tables with numeric emphasis contain **125 bold numeric cells and 136 gray numeric cells**. ODL retains those reviewed marks; MinerU fails to retain the complete required emphasis on every one of these 14 tables. The other 12 tables have no numeric-emphasis requirement and are not counted as style passes. Some row-label font weight, such as Children’s TNC label, is absent from both pipelines; this is why the result is not labeled complete typography fidelity.

The per-table verdicts and their actual MinerU chunk indices are in [source-meaning-verdicts.json](local/2026-09-09-odl-mineru-table-comparison/source-meaning-verdicts.json). [Development diagnostics](local/2026-09-09-odl-mineru-table-comparison/development-diagnostics.json) retain every reviewed source grid, raw MinerU table and actual production chunk. [Independent diagnostics](local/2026-09-09-odl-mineru-table-comparison/independent-diagnostics.json) retain the frozen source rows and both outputs.

## What the selected development tables show

The largest gains concern associations rather than missing digits. CCL feedback page 8 has all 64 numeric values in MinerU, but its BERTScore parent header covers only R instead of P/R/F1. Several CCL table-number captions are also corrupted. On CCL page 16, 98.83 is detached into an unlabeled row and the model/training parent headers are misassigned. The refined ODL chunks retain those source relationships.

COT page 8 contains most of its 192 values in MinerU, but several model names merge across rows, Metric/Model stubs collapse, and 34.44/33.19 merge in one cell. Numeric inventory would hide this failure. On COT pages 6 and 7, MinerU’s raw rowspans are substantially better: all numeric rows survive. Production flattening leaves only the first row of each group explicitly labeled, reducing the strict expanded-row diagnostic from 6 to 2 and from 8 to 2 respectively. Some group meaning remains inferable because the rows share one chunk; the core failures also include corrupted table identifiers. Do not describe all of this difference as raw-parser loss.

Attention page 8 loses the shared EN-DE/EN-FR training-cost cell scopes for the Transformer rows in MinerU, reads GNMT+RL Ensemble as GNMT+RI, and adds a spurious overbar to one cost. ODL preserves the source spans and power notation. Hong Kong’s gas table illustrates a unit failure: `10^12 joules` becomes `1012 joules` in the MinerU production footnote even though the consumption digits remain present.

MinerU passes the core rubric on Children pages 9 and 10 and five Hong Kong tables: households, civil servants, regional offices, postal services and life expectancy. These passes explicitly allow legitimate source blank continuation labels. The civil-servant definition is complete in the actual production chunk despite a truncated raw table-footnote field. Numeric bold is still lost on Children’s two tables and Hong Kong’s regional-office totals.

## Independent source results

| Numeric source table | Rows | ODL literal rows | MinerU literal rows | Complete core meaning |
| --- | ---: | ---: | ---: | --- |
| BERT Table 1, page 6 | 5 | 5 | 5 | MinerU |
| BERT Table 2, page 7 | 10 | 7 | 1 | Neither |
| BERT Table 3, page 7 | 6 | 5 | 2 | Neither |
| BERT Table 4, page 7 | 7 | 4 | 3 | Neither |
| ResNet Table 2, page 5 | 2 | 0 | 2 | MinerU |
| ResNet Table 3, page 6 | 10 | 0 | 7 | Neither |
| ResNet Table 4, page 6 | 10 | 0 | 1 | Neither |
| ResNet Table 5, page 6 | 6 | 0 | 3 | Neither |
| ResNet Table 7, page 8 | 3 | 1 | 3 | MinerU |
| ResNet Table 8, page 8 | 2 | 0 | 2 | MinerU |

BERT Table 1 is a useful MinerU win: the five data rows, training-example counts, metric definitions and caption are together in production chunk 23. ODL retains the rows, but splits the header/body and caption notes between chunks 26 and 27. On BERT Tables 2–4, ODL retains more literal rows, but missing-value marks and group/header context remain incomplete; MinerU merges several model rows and incorrectly attaches Table 2’s caption to Table 3.

MinerU recovers ResNet Table 2 where ODL retains the caption but no table data. It also retains Tables 7 and 8 in chunk 35. MinerU’s raw Table 7 caption is attached to Table 8, but the actual production chunk contains both distinguishable tables and both captions, so this audit credits the final local meaning. Neither parser correctly preserves Tables 3–5: examples include ResNet-101’s 6.05 shifted into the ResNet-152 cell and 3.57 detached into an unlabeled row. All four independent MinerU core passes still lose source numeric bold emphasis.

Both parsers fail ResNet’s architecture Table 1. ODL preserves shared convolution/pooling spans and all five FLOP powers after source exponent repair, but some matrix brackets are missing or misplaced, and the caption/downsampling note is separate from the table chunk. MinerU further splits bottleneck columns, loses bracket/repetition binding, fragments the average-pool/softmax text and merges the last FLOP value into the preceding row. Presence of the repetition digits cannot establish that they multiply the correct block.

## Default versus cluster detector control

The root’s matched full 335-page detector control measured 41.618 seconds for default and 41.182 seconds for cluster. Nine documents have exactly equivalent content/chunks; changes are confined to Attention, Spain, German and Hong Kong. This lane source-audited the Hong Kong and Attention table differences, not all changed Spanish/German prose.

Hong Kong has 69 adapted native HTML tables under cluster and none under default. **50 are repeated footer regions**, not data tables. Every one of the remaining **19 body regions** was source-viewed: four contents pages, two bilingual prose regions and 13 genuine numeric-table regions. The latter contain **91 three-year numeric lines / 273 entries**, including percentage/subset continuations. All 91 lines survive in the actual final page chunks under both modes. That inventory result does not prove row association.

All 14 previously reviewed Hong Kong source recoveries are conserved under default. A fifteenth, source page 41 section 13.1, is valid: the aircraft and ocean-vessel rows retain all six values, year headers, units, `#` marker and bilingual title. However, on source page 43 the default final chunk lists eight English labels, including one parent label with no values, followed by seven numeric triplets. Cluster retains explicit label/triplet pairing for those seven metrics. This is a confirmed structure regression despite perfect numeric-line inventory. Default must therefore not be promoted globally from its lower chunk count or extra accepted table alone.

Attention’s changed source page 6 region is the complexity table. Default rejoins all four rows in source order and fixes a displaced convolutional squared-dimension digit. Both outputs still lack faithful explicit power/log-base notation. The other two native Attention tables are unchanged by this detector switch.

The complete 19-region audit, source renders, both actual chunk sets and the Attention finding are in [default-audit/verdicts.json](local/2026-09-09-odl-mineru-table-comparison/default-audit/verdicts.json).

A cheaper built-in control retains cluster and omits `--include-header-footer`. On Hong Kong this reduces the recursive native table count from 70 to 21: **49 footer tables removed, zero body tables removed, zero additions**. The recursive count includes one nested body table, hence differs from the 69 adapted-block count above. All 21 retained native tables are exactly equal after excluding parser IDs and hierarchy-level numbering, including their text, cell order/spans, fonts, colors and boxes. The 19 adapted body regions, including page 43, are therefore conserved at native-output level; the page 53 footer remains. Input hashes and the full comparison are in [no-footer-native-conservation.json](local/2026-09-09-odl-mineru-table-comparison/default-audit/no-footer-native-conservation.json). This supports a separate cluster/no-footer candidate. It is not yet a claim about full-corpus adapted chunks or the other documents; the root owns that replay.

The remaining useful targets are concrete: preserve complex model/group row scopes, correct missing-value marks, bind captions/notes to independently retrievable chunks, and recover architecture brackets and exponent meaning. The current conservative ODL candidate offers strong bounded gains without claiming those unresolved cases are solved.

## Full-corpus header/footer control: rejected

The completed `refined-nofooter-r1` replay covers all 13 documents / 335 pages with the cluster detector and all current repairs, while omitting `--include-header-footer`. The Hong Kong-only result above does not generalize safely: **the global setting removes two genuine Japanese table-header blocks** as well as the 49 Hong Kong footer tables. Keep the Java inclusion flag.

| Table conservation across 335 pages | With headers/footers | Without headers/footers |
| --- | ---: | ---: |
| Recursive native tables, including nested detections | 275 | 224 |
| Existing adapted native table blocks | 269 | 218 |
| Reviewed source-geometry recoveries | 26 | 26 |
| All adapted table blocks | 295 | 244 |
| Removed Hong Kong footer blocks | — | 49 |
| Removed genuine Japanese column-header blocks | — | 2 |
| Added or changed retained native grids | — | 0 |

All retained native grids match recursively after excluding parser IDs and hierarchy-level numbering; text, cell order/spans, fonts, colors and boxes are unchanged. All retained adapted table blocks match after excluding only `_native_id`. The complete inventory and input hashes are in [table-conservation.json](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/table-conservation.json).

All **26 reviewed recoveries / 135 rows** still pass actual final-chunk checks for complete styled rows, full headers, titles, notes, merged-cell scope and source citations. Among the 218 retained native table blocks, 165 have exactly equal sequences of cited chunk text; nearby prose and packing change for the others. No previously present literal native row or exact citation anchor is lost among these retained blocks. Eight blocks already lacked an exact chunk anchor in the baseline, mostly empty native table detections; they are not credited as new citation passes. This is preservation evidence, not proof that the existing native tables or their surrounding section context are correct. See [actual-chunk-audit.json](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/actual-chunk-audit.json).

The two removed Japanese blocks are on source pages **49 and 51**. Source renders show ruled, multi-level headers for within-prefecture and between-prefecture migration, counts by sex, and year-on-year percentage changes by sex. The baseline includes these headers and the continuation title in the corresponding page chunks. The no-header/footer output contains none of the three parent/header phrases or that full title in any chunk covering either page, while the numerical paragraphs remain. This destroys information needed to distinguish counts from rates and identify the sex groups. Both changed body regions were source-reviewed; the source renders, complete before/after chunks and checks are in [japanese-header-source-review.json](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/japanese-header-source-review.json).

The native JSON provides a narrower option without inventing a footer heuristic. Across the entire corpus, exactly **49 table nodes descend from explicit `footer` nodes**, all on Hong Kong pages 4–52. Exactly **two descend from explicit `header` nodes**, the genuine Japanese headers above. No other table has either ancestry. Each Hong Kong footer is a two-row, two-column table; its adapted block retains the native ID needed to propagate the footer classification. The source-page-53 footer has no footer ancestor and appropriately remains outside this bounded proposal. [Native ancestry inventory](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/native-furniture-table-ancestry.json) and [full examples](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/hk-footer-native-ancestry.json) support testing footer-only propagation while preserving header descendants. That adapter is a separate candidate; the global no-header/footer setting remains rejected.

## Footer-only propagation: supported final candidate

The root implemented the bounded adapter in `refine_odl_output.py` and produced `composed-footer-r3`. It matches a unique native ID and page, requires the exact re-adapted HTML to match, and changes only the adapted block type to `footer` when its native ancestor is explicitly a footer. The original table HTML, bbox and other metadata remain in the content artifact. Header ancestry is left alone. Existing chunking then excludes the footer block.

Across all 335 pages, exactly **49 Hong Kong blocks change only their type**. All other blocks are identical. The other **12 documents have exactly identical content arrays and complete final chunk arrays**, including the Japanese tables and all BERT/ResNet independent cases. All **220 retained native table blocks have identical cited chunk-text sequences**; 212 have exact citation anchors in both versions, while eight pre-existing unanchored detections remain unchanged. All **26 reviewed source recoveries / 135 rows** again pass complete styled-row, header, title, note, merged-scope and citation checks. The 37-table comparison above therefore remains valid for this final candidate.

Hong Kong decreases from **248 to 200 chunks**: 49 footer chunks disappear and one legitimate map heading is retained. The extra heading is source page 10, **“2.4 香港地圖 Map of Hong Kong”**. Before the change, it existed only in the section path of that page’s publisher/footer chunk. After removal of that footer, the source-verified heading is retained as its own chunk with a citation at the actual title near the top of the page. The source crop and before/after chunks are in [new-map-heading.json](local/2026-09-09-odl-mineru-table-comparison/footer-only-r3/new-map-heading.json). This is why the net reduction is 48, not 49. Total corpus chunks decrease from 1,449 to 1,401.

After excluding those 49 old footer chunks and the one new map-heading chunk, Hong Kong's remaining **199 complete chunk objects are exactly equal**, including indexed text, section paths, page bounds and citation regions. [Whole-chunk conservation](local/2026-09-09-odl-mineru-table-comparison/footer-only-r3/whole-chunk-conservation.json) therefore accounts for every final chunk change across all 335 pages.

The historical regression inventory contains **22 documents / 430 pages and zero table descendants of explicit footer ancestors**. This adapter has no selected table regions there; this is a negative control, not another positive generalization result. Every native input hash is recorded in [native-furniture-table-ancestry-430.json](local/2026-09-09-odl-mineru-table-comparison/no-footer-r1/native-furniture-table-ancestry-430.json).

The footer adapter phases total **0.113 seconds** in one local 335-page composition. That measurement includes native traversal and block copying/matching, but excludes Java, other repairs and chunking; it is not an end-to-end speed estimate. The final source snapshot hash, input/output hashes, complete block-change records and actual chunks are retained in [footer-only summary](local/2026-09-09-odl-mineru-table-comparison/footer-only-r3/summary.json) and [actual-chunk-audit.json](local/2026-09-09-odl-mineru-table-comparison/footer-only-r3/actual-chunk-audit.json). The unmarked final-page Hong Kong footer remains a known bounded miss.
