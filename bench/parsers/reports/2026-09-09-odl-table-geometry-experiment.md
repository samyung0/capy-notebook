# OpenDataLoader source table geometry experiment

Source text and drawing geometry recover the reviewed Attention and Hong Kong tables without OCR or provider calls. Their final document chunks preserve grouped headers, complete rows, units, exponents, notes, and explicit shared cells. CCL feedback's source table is also recovered, including all 64 numeric values and eight bold cells, but conservative replacement **abstains** because two watermark blocks cross its boundary. This remains an integration failure, not a completed automatic fix.

The first frozen rule transferred all 66 COT values and 11 nested numeric headers, but lost the SDS/MDS row groups. A second, explicitly post-transfer development arm recovers those groups from centered source labels between horizontal separators. Children is a clean control: its baseline already contains all 24 counts and headers in one overlapping chunk. No production code, parser settings, provider calls, or VM workloads changed in this experiment.

## Method and evaluation boundary

Runnable extraction code: [experiment_odl_table_geometry.py](../scripts/experiment_odl_table_geometry.py), with document integration and scoring in [evaluate_odl_table_geometry.py](../scripts/evaluate_odl_table_geometry.py). Extraction groups long horizontal source rules with matching endpoints, separates regions at large gaps or intervening headings/captions, and infers numeric columns from repeated source alignments. Source header geometry establishes parent/leaf scope. A numeric cell centered across an explicit parent-header span becomes a merged cell only when the assignment is unambiguous. Font superscript flags preserve numeric exponents; bold flags become explicit `[bold in source]` annotations. Ambiguous shapes reject structured extraction.

The second arm recognizes a narrow additional shape: two stub headers, a left stub label centered vertically inside a band bounded by horizontal separators, and several ordinary row labels to its right. It creates a source rowspan. Multiple ordinary labels in the band keep the original shape; ambiguous singleton scope rejects. No document IDs, page numbers, expected values, or answer strings enter either geometry rule.

Source checks were frozen before candidate scoring for CCL feedback p8, Attention p8, and four Hong Kong p13 tables. All source pages use one-based PDF numbering. The original checks remain unchanged at `local/2026-09-09-odl-table-geometry/frozen-checks.json`, SHA-256 `89facc1006ebf97316fcdb01f56e102d3482667f2c22f3d10c171f1bf426460b`. One transcription error was found during source review: Hong Kong age 65+ / 2018 share is `3.6`, without an asterisk. The scoring receipt records this correction separately and preserves the source crop `hk-65-age-source.png`. The CCL stub header is blank in the PDF; the fixture's explanatory `method` label is not invented in output.

The original rule was snapshotted **before inspecting the transfer checks/PDFs**, SHA-256 `ccefa62436b6fb783063324242df20bbfc50812fa55259edb53d5bc91d6caac9` (`frozen-rule.py`, receipt in `frozen-rule.json`). COT's 66 values, nested headers, and SDS/MDS meaning checks were already frozen by the root experiment in [odl-font-transfer-checks.json](../fixtures/odl-font-transfer-checks.json). Children was reserved as a clean eight-row control; its 24 exact counts were source-reviewed after extraction, so they are not claimed as pre-frozen ground truth. After the COT failure, COT became development data for the revised arm. It is not evidence of unseen generalization for that revision.

Whole-source selection scanned all 129 pages and found 59 regions, of which 25 passed geometry extraction. **Only eight source-reviewed tables were evaluated for complete meaning and document integration.** The integration driver deliberately supplies that reviewed set. Results do not establish precision for the other 17 accepted candidates, recall over all source tables, or safety of replacing every accepted candidate.

## Source and final-chunk results

The three original document baselines are the verified `odl-accuracy/combined-final` content lists. COT starts from the freshly parsed font-repaired PDF; Children starts from its fresh native Java content list. This is incremental evaluation on those baselines, not a fresh ODL-versus-MinerU quality benchmark.

| Source table | Complete source checks | Conservative replacement / final document evidence |
|---|---|---|
| CCL feedback p8 | Eight row labels, 64 numeric values, mBART/mT5 and BLEU/BERTScore groups, all eight bold cells | Abstains. Crossing native blocks contain `24` and `CCL`; the entire baseline document remains unchanged. Explicit oracle replacement gives one complete table chunk, index 40. |
| Attention p8 | All ten rows including blanks, five column scopes, numeric exponents, two shared training-cost colspan cells, four bold cells | Accepts; one complete table chunk, index 36. Table `41.8` and separate prose `41.0` both remain. Shared Transformer costs explicitly cover both language columns. |
| Hong Kong p13, sex and age | Every numeric cell and marker, bilingual row labels, three years and units, blank-stub change rows, attached source population notes | Both accept; complete table chunks 34 and 35. Parenthetical changes retain their printed column placement; no invented row label. |
| Hong Kong p13, unemployment and underemployment | Both rows of each table, all values, years and units | Both accept; complete table chunks 36 and 37. Sex/age population notes are not attached to these tables. |
| COT p6, frozen first arm | All 66 numbers and 11 numeric header scopes correct; **SDS/MDS scope fails** | Source labels fall only on their centered Medical rows; no rowspans. Numeric presence alone would incorrectly report success. |
| COT p6, revised development arm | Same 66 values; Task/Domain split; SDS and MDS each explicitly span AI, Medical and Overall | Accepts; one complete table chunk, index 22, with two three-row shared-cell annotations. |
| Children p4 | Eight complete rows, 24 counts, all four headers | Accepts; complete table chunk 18. Baseline chunk 18 already contains all rows and headers. The printed `图 4` caption remains a separate native block; the table rule does not attach it. |

Chunk indices are zero-based. Complete extracted table text equals the corresponding actual document chunk text for every accepted reviewed table, including explicit source spans and bold annotations. The persisted `indexed_text` contains that same text. The CCL oracle result is separate from the automatic result throughout the artifacts.

The revised arm produces **byte-identical bundles for all 19 originally accepted regions and the Children control** compared with the frozen first arm. COT's repaired grouping is the bounded new gain. Earlier development failures, the frozen failed transfer, and both final arms remain in the artifact directory.

## Replacement and collateral changes

Replacement uses the source table/header/caption/note region. It requires at least one wholly contained native block and abstains on partially overlapping or unpositioned blocks. A six-unit tolerance in normalized 1000-unit coordinates accommodates native font bounding boxes. It does not delete CCL watermark blocks based on their text. The oracle arm explicitly permits partial removal for review; it is not the automatic policy.

| Document | Reviewed tables accepted | Native blocks removed / others unchanged | Entire source pages unchanged | Chunks before → after |
|---|---:|---:|---:|---:|
| CCL feedback | 0/1 | 0 / 319 | 16/16 | 78 → 78 |
| Attention | 1/1 | 4 / 451 | 14/15 | 55 → 56 |
| Hong Kong | 4/4 | 27 / 1,047 | 52/53 | 248 → 244 |
| COT, revised | 1/1 | 5 / 413 | 23/24 | 106 → 107 |
| Children | 1/1 | 2 / 361 | 20/21 | 81 → 82 |

All retained native blocks compare exactly with the baseline, in order. Chunks outside the replaced source pages are identical except for **two Hong Kong chunks on source pages 37 and 48**: the literal note label `註釋： (1) Note : (1)` reappears. Replacing four p13 tables changes the document-wide repeated-furniture count for that label. Source checks confirm these are insertions only; other text and section paths are unchanged. This side effect prevents a blanket claim of unchanged outside-page chunks and needs attention before broader integration.

CCL's oracle arm removes 11 blocks, including the two partial watermark blocks; 308 other blocks and all 15 other pages remain exact. It produces 79 chunks. Automatic acceptance is 7/8 reviewed tables versus oracle 8/8, with the stated review-set restriction.

## Timing and reproducibility

These are local Windows/Python 3.12.9/PyMuPDF 1.28.2 diagnostics. They do not include Java parsing, font repair, OCR, Qwen captioning, or VM scheduling, and are not an end-to-end latency claim. Whole-source selection includes source text extraction and drawing-rule inspection on every page; PDF open is excluded. Candidate work includes extraction attempts, structured chunking for accepted regions, and bundle JSON writes.

| Source | Pages | Selected / accepted regions | Whole-source selection | All candidate work |
|---|---:|---:|---:|---:|
| CCL feedback | 16 | 12 / 4 | 0.247 s | 0.132 s |
| Attention | 15 | 4 / 1 | 0.405 s | 0.041 s |
| Hong Kong | 53 | 32 / 14 | 0.541 s | 0.307 s |
| COT | 24 | 7 / 4 | 0.482 s | 0.300 s |
| Children | 21 | 4 / 2 | 1.500 s | 0.241 s |
| Total | 129 | 59 / 25 | **3.175 s** | **1.022 s** |

A separate known-region measurement skips selection: three consecutive repeats for each of the eight reviewed tables, including text extraction, geometry, rowspan expansion, HTML, and one-table chunking, but excluding PDF open, writes, replacement, and whole-document chunking. The sum of the eight medians is **0.269 s**. This is an oracle-region cost, not a deployable overhead estimate. Fresh whole-document candidate chunking in the integration replay takes 0.090–0.322 s per document; it is measured separately and has no paired parser baseline here.

Artifacts are under `bench/parsers/reports/local/2026-09-09-odl-table-geometry/`: source crops, frozen checks and script, `final/` and `transfer/r1/` first-arm results, `row-spans-final/` and `transfer/row-spans-final/` revised results, `composition-final/` complete before/after chunks and replacement receipts, and `source-score-and-timing.json` complete-grid assertions, correction provenance, byte-equivalence checks and timing scope. The current script SHA-256 is `5cf5f59ba5454a78cb330be53bb38e973c31fe3397b4237d1bf454caa6845d86`, also saved as `revised-rule.py`. Source, baseline, bundle, and evaluator hashes are recorded in the manifests.

From repository root, with the local source artifacts available:

```powershell
uv run --with pymupdf python bench/parsers/scripts/experiment_odl_table_geometry.py --check
uv run --with pymupdf python bench/parsers/scripts/experiment_odl_table_geometry.py bench/parsers/reports/local/2026-09-09-odl-table-geometry bench/parsers/reports/local/2026-09-09-odl-table-geometry/replay-new --row-label-spans
uv run --with pymupdf python bench/parsers/scripts/experiment_odl_table_geometry.py bench/parsers/reports/local/2026-09-09-odl-table-geometry/transfer bench/parsers/reports/local/2026-09-09-odl-table-geometry/transfer/replay-new --row-label-spans
uv run --with pymupdf python -X utf8 bench/parsers/scripts/evaluate_odl_table_geometry.py integrate
uv run --with pymupdf python -X utf8 bench/parsers/scripts/evaluate_odl_table_geometry.py score
```

The first three commands validate the script and create new extraction directories. The evaluator replays the reported final directories rather than automatically adopting `replay-new`. Its hash is recorded in both replay receipts. Archived script snapshots in reports are historical records; runnable code lives in `scripts/`. Ruff lint, isolated format check, the focused synthetic row/header/span/chunk checks, and source-to-final-chunk replay all pass.

The next useful test is a genuinely unseen set of ruled numeric tables, scoring every accepted region before widening replacement. CCL needs a source-grounded way to separate watermark geometry from table content, and Hong Kong exposes the need to keep furniture decisions stable across structural replacement. The present evidence supports further benchmark work on this inexpensive source-geometry arm; it does not establish production readiness or MinerU parity.
