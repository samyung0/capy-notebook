# ODL repair validation on new source families — 2026-09-13

## Result

The fixed-gold validation set completed on four public PDFs from four publisher families. The native candidate completed 4/4 sources and the raster OCR controls completed 4/4 controls. A flag-matched raw Java baseline completed 4/4 sources with the production ODL invocation. On the source-scoped checks, the candidate and matched baseline had equal results: **38/41 rows and 238/256 cells matched in each arm**. The three missing rows are the three checked rows from MDPI Water Table 1, which has no typed native table block and no pipe-table lines in either arm. No matched row-order inversion was recorded.

The candidate produced no source-region block-order improvement. Across the 12 selected pages, matched baseline and candidate are both **12/52 wrong region pairs**. The known Frontiers p9 side-by-side table continuation remains right-panel-first in both outputs (**12/22 block pairs**). After repacking cached candidate blocks with the current production chunker, final packed chunks have the same score, **18/61 wrong region pairs** in each arm. The candidate and matched baseline have the same block counts on each source; their repacked chunk counts differ on Frontiers (88 baseline versus 87 candidate) and match on the other three sources.

The result supports preservation of the checked native rows and cells. It does not establish repair generalization across these source families, table-cell/header semantics, OCR character accuracy, end-to-end parser quality, retrieval quality, or an unseen-training claim.

## Frozen inputs and protocol

The immutable source/gold receipt is:

`bench/parsers/reports/local/2026-09-13-odl-repair-validation/freeze/frozen.json`

It records fixture SHA-256 `3c5a6271b3624bc3638b264bc79609eeb594a1d304093a38e9ea67d6e6f0c7e7`, the pre-output frozen script copy SHA-256 `15dfe2855f685aba24c8fddc7f1d2c7bdd2cfdb40f9acf4e315cf14297cb3032`, four publisher families, 67 native pages, 12 selected source pages, 41 checked rows, four derived raster controls, and four scorer negative cases. Source pages were rendered and viewed before any Java, parser, or model output. The existing-manifest scan found no selected URL or source hash matches. The source PDFs remain in ignored local artifacts.

| Source | Publisher family | Pages | SHA-256 | Publisher URL |
| --- | --- | ---: | --- | --- |
| `frontiers-marine` | Frontiers in Marine Science | 18 | `fd8c52e80bc7766ff25f416f127bc7ef4a2d8f6bd8acf8b314ab6979c75763e9` | https://www.frontiersin.org/journals/marine-science/articles/10.3389/fmars.2024.1497246/pdf |
| `mdpi-water` | MDPI Water | 20 | `f46b48a02cc6d7189aea17cce4c2598ba7fd8ab13b9d8038e07261d212b57544` | https://mdpi-res.com/d_attachment/water/water-16-03654/article_deploy/water-16-03654.pdf |
| `nature-scientific` | Springer Scientific Reports | 11 | `7a12614964f4b9e7eba632b87d865d831497fa007ec890fc442d99d4786e975a` | https://www.nature.com/articles/s41598-024-73154-9.pdf |
| `plos-demography` | PLOS ONE | 18 | `d7cbd4ecc4702bfc3cea2aa8cbb971770bb13abe3e30db8b8fc8c9bbec97f38f` | https://journals.plos.org/plosone/article/file?id=10.1371%2Fjournal.pone.0299464&type=printable |

The fixture is `bench/parsers/fixtures/odl-repair-validation-2026-09-13.json`. The executable and scorer are `bench/parsers/scripts/validate_odl_repairs.py`. The frozen copy remains under the freeze directory; current scorer/script SHA-256 is `c175e1067785b5a39da06a564babce921003f5a39aaead061740a492f6eca352`.

## Native source and chunk checks

The original minimal raw baseline is preserved at `bench/parsers/reports/local/2026-09-13-odl-repair-validation/results/raw-java-baseline-r1.json` (receipt SHA-256 `ffd8d6e649ff027070bf9f72a38eef8a0f1717491724292bea08a3733574a50c`). The flag-matched baseline receipt is `bench/parsers/reports/local/2026-09-13-odl-repair-validation/results/production-java-matched-r1.json` (receipt SHA-256 `17b6eb288d10458e2aa17983023e75423e24209208d92e6fcedb60faee07acf7`). Its Java jar SHA-256 is `74f0d797bea8088bd4a58137e372eb38a5fa24639e06b633cef7f78eba14cd62`; its full ODL flags are `--format json,markdown`, `--image-output external`, `--markdown-with-html`, `--threads 1`, `--table-method cluster`, and `--include-header-footer`, with headless Java and `-Xmx1g`. The final candidate receipt is `bench/parsers/reports/local/2026-09-13-odl-repair-validation/results/production-candidate-final-r3.json` (receipt SHA-256 `6cd0478b4422a1dec819c7a2be168725255e9ead3c1859ed9cd54f69f610ecaf`). The definitive matched comparison is `bench/parsers/reports/local/2026-09-13-odl-repair-validation/results/production-candidate-final-r3-vs-production-java-matched-r1.json` (receipt SHA-256 `6654d343aec07084c63ab1d7e16c624f4e56c5d758ce6516bdff1ef4fd13c2ee`). Candidate and baseline source rejections are empty.

| Checked source table | Block rows baseline → candidate | Block cells baseline → candidate | Final chunk rows baseline → candidate | Final chunk cells baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| Frontiers p8 Table 2 (12 rows) | 12/12 → 12/12 | 72/72 → 72/72 | 12/12 → 12/12 | 72/72 → 72/72 |
| MDPI p3 Table 1 (3 rows) | 0/3 → 0/3 | 0/18 → 0/18 | 0/3 → 0/3 | 0/18 → 0/18 |
| Scientific Reports p3 Table 1 (19 rows) | 19/19 → 19/19 | 114/114 → 114/114 | 19/19 → 19/19 | 114/114 → 114/114 |
| Scientific Reports p4 continuation (2 rows) | 2/2 → 2/2 | 12/12 → 12/12 | 2/2 → 2/2 | 12/12 → 12/12 |
| PLOS p6 Table 2 (first 5 rows) | 5/5 → 5/5 | 40/40 → 40/40 | 5/5 → 5/5 | 40/40 → 40/40 |

The other selected tables are shape/header controls with zero checked rows: Frontiers p4 and p9, Scientific Reports p7, and PLOS p5 and p7. Their native cell text is represented with `<td>` cells; no explicit header tags were present. Header text presence is therefore reported separately from header association, and header association remains unscored. The PLOS controls omit `%` from the observed native header text; this is a measured header-text limitation, not a row/cell pass.

The 21 Scientific Reports continuation rows are deliberate six-cell projections (`No.`, through `Reasons for hospitalization`) from a 12-column table. Thus the reported 126 Nature cells are source-checked prefixes; the remaining six columns for those rows are outside the cell denominator. The row identity and catheter field are present in this projection, but the result must not be read as full-row or full-table cell coverage.

The MDPI p3 source render shows three fully visible checked rows and a fourth row clipped at the page edge. The clipped row is deliberately excluded from the checked-row denominator. Both arms retain the surrounding flattened text, but neither creates a typed table or pipe-table representation. This is an explicit unscored table-structure blind spot.

The original raw Java baseline intentionally used a minimal direct CLI invocation and is retained for historical comparison. The definitive comparison uses `production-java-matched-r1`, whose ODL flags match `parser/odl/java.py`. Both arms were adapted and scored with the same current `odl.adapter` and final packer; baseline packing used an empty furniture set, matching the candidate's recorded empty set. The matched baseline's JVM heap is bounded to `1g` for this host. The final-r3 candidate's heap setting was not recorded, and the production default in `parser/odl/java.py` is `3g`, so heap-size equivalence is not proven. This is a runtime reproducibility caveat; the native table/region checks are unchanged.

The matched baseline and candidate have equal block counts on all four sources: Frontiers 294/294, MDPI 132/132, Scientific Reports 107/107, and PLOS 136/136. Repacking the cached candidate blocks with the current production chunker changed the candidate chunk count from the saved 87/57/56/76 to 87/57/56/75; the matched baseline produces 88/57/56/75. This repack is recorded under `bench/parsers/reports/local/2026-09-13-odl-repair-validation/comparison/production-candidate-final-r3-vs-production-java-matched-r1/`. The current helper snapshot records `pipeline/pipeline/retrieval/chunking.py` SHA-256 `4095bdce47176cfaac3534dd5d6b4e120aa92ab7b5cb2275b1b38814fd6fa0be`; the saved final-r3 artifact was produced with `b1dcc6ac6b1f40ef4a8c5562b7c84eb9479d42227cc877c405ccd1a3b9d0629f`. The current `parser/odl/refine.py` is `b79ab5a4192181ce4d5e6440430bccb7e6e6e7e9e39441a836a19865945c725d`, while final-r3 content lists were produced with `245de32e7d891713ed5aa083d661e5e5ddcfe0eca45528e27ca34971db87d5ec`; that refine change only affects image-path/dedup handling and was not rerun against this holdout. Table and ordering comparisons use the saved final-r3 content lists, with current chunker repacking explicitly separated in the receipt.

## Rubric and scoring limitations

Two region misses repeat in both arms and are annotation geometry issues visible in the saved source renders:

- On MDPI p4, the Figure 1 caption begins around the fixture's y=595 boundary, while the parser text block spans across that boundary; its center falls in the figure region, so the caption region is reported missing.
- On MDPI p6, the `results-heading` box covers the heading, italic subheading, and the first prose block. The next `results-prose` box starts too low, so the prose block is assigned to the heading region.

The final chunk region check also has no text-chunk region for MDPI p4's image-only Figure 2. This metric cannot establish image retention. Long anchor sentences are often split across blocks; the saved anchor probes are diagnostic and were not used as accuracy claims.

The Frontiers p9 continuation defect is source-visible: the left table panel precedes the right continuation panel, but the native candidate sequence begins with right-side fragments. The current native repair intentionally leaves this table block sequence unchanged. The test detects the defect; it does not provide a demonstrated fix.

## Raster OCR controls

The raster controls are one-page PDFs derived from selected source renders at max edge 2560. They reuse the source gold and are not independent examples. Fresh inference used identical recognized lines for the old and guarded orders on all four controls (897 lines total):

| Control | Lines | Layout regions | Decision | Strict active | Old → current wrong pairs |
| --- | ---: | ---: | --- | --- | ---: |
| Frontiers p8 | 149 | 15 | `unmapped-line` | no | 734/1088 → 734/1088 |
| MDPI p3 | 85 | 8 | `layout` | no | 0/1 → 0/1 |
| Scientific Reports p3 | 394 | 6 | `layout` | yes | 0/0 → 0/0 |
| PLOS p6 | 269 | 9 | `layout` | no | 0/1 → 0/1 |

The Frontiers control abstains because one or more recognized lines do not map to a layout region. The Scientific Reports control has one scored region, so its zero denominator carries no cross-region ordering evidence. The raster result shows no measured gain or regression under the frozen model/configuration.

The final candidate used Python 3.12.7, RapidOCR 3.9.2, RapidLayout 1.2.1, ONNX Runtime 1.29.0, PyMuPDF 1.28.2, Pillow 12.3.0, and pypdf 6.18.1. The exact OCR/layout configuration and model SHA-256 values are recorded in the final result under `runtime` and `raster_ocr`; the production helper hashes are under `helpers`. The pypdf version is an isolated-environment caveat. No paid API, shared host, live database, or network call was used during inference.

## Recommendation

Keep the frozen source/gold manifest and all receipts. Treat this run as a preservation and blind-spot report. Do not promote a source-order or table-quality claim from these results: the set shows no new native repair gain, leaves a real Frontiers continuation defect, leaves MDPI's flattened table untyped, and does not score header association. The flag-matched comparison is complete. Separate final-image parser-to-index/capture/citation integration and resource checks also passed; see the [implementation report](2026-09-13-odl-implementation.md). Those checks use a different local fixture and deterministic model substitutes, so they do not extend the quality conclusions for this source set. UAT rollout remains separate.

## Reproduction

Freeze was run before outputs:

```sh
/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/validate_odl_repairs.py freeze
```

The flag-matched baseline was run with the same frozen fixture:

```sh
/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/validate_odl_repairs.py baseline-matched \
  --run-name production-java-matched-r1 \
  --timeout 900 --jvm-heap 1g \
  --java-bin /usr/bin/java \
  --jar /private/tmp/capy-odl-quality-20260913/py312/lib/python3.12/site-packages/opendataloader_pdf/jar/opendataloader-pdf-cli.jar
```

The final candidate artifacts were produced earlier with the same frozen fixture. The matched score reused those saved blocks, repacked them with the current production chunker, and compared them with the matched baseline:

```sh
/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/validate_odl_repairs.py score-candidate \
  --run-name production-candidate-final-r3-vs-production-java-matched-r1 \
  --baseline-run-name production-java-matched-r1 \
  --candidate-run-name production-candidate-final-r3 \
  --model-dir /private/tmp/capy-odl-quality-20260913/models
```

The final candidate run itself was:

```sh
CAPY_RAPIDOCR_MODEL_DIR=/private/tmp/capy-odl-quality-20260913/models \
/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/validate_odl_repairs.py candidate \
  --run-name production-candidate-final-r3 \
  --timeout 900 \
  --model-dir /private/tmp/capy-odl-quality-20260913/models
```

All versioned source/gold and executable additions are limited to the validation fixture, validator, and report. Raw PDFs, renders, parser outputs, chunks, OCR lines, and receipts are under `bench/parsers/reports/local/2026-09-13-odl-repair-validation/`; the source PDFs are ignored local artifacts.

Final validator formatting, Ruff and Python compilation checks passed. Formatting and invalid-input exception-type corrections after scoring do not alter the frozen source/gold or existing run receipts.
