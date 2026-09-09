# OpenDataLoader table integration: exhaustive selection audit and conservative replacement

The broad geometry candidate failed. Its independent transfer run replaced BERT's Table 5 with incorrectly combined task headers, and its development run deleted Hong Kong's 2022–23 fiscal-reserve value, **834.8**, by replacing a block wider than the extracted table. Those frozen failures remain in the raw records.

The revised candidate recovers **24 tables / 115 source rows** across five development documents. Every accepted replacement was source-reviewed; every row, complete header path, title, style annotation and note survives in an actual final chunk with the correct table citation rectangle. It abstains on all 36 former independent pages. This is a bounded development gain, **not successful independent generalization**, a replacement for all native tables, or a MinerU parity claim.

## Scope and provenance

- Benchmark-only code: `../scripts/experiment_odl_table_integration.py`. Production files and parser/provider settings were not changed by this lane.
- Raw evidence: `local/2026-09-09-odl-table-integration/` (ignored, retained locally). Full PDF inputs and canonical content/chunk hashes are listed in `../reports/local/2026-09-09-odl-third-pass/{sources,independent-sources}.json`.
- Development: 10 full PDFs, 299 pages. Independent transfer: BERT 16 pages, ResNet 12 pages, NIST Shot 8 pages, all downloaded and source checks frozen by the parent experiment before this lane inspected them.
- Frozen transfer rule SHA: `0b567302676b12fd3acdd61ab72c8b6fc6f9ddd050b3fb960d17100ab672e42d`, saved as `frozen-rule.py` before source inspection. Frozen independent rubric SHA: `b54930adb3a176e10d561ce93b7bf9cc474307f1a754fe6d1e6564e3dafaeee1` (`../fixtures/odl-independent-checks.json`).
- Revised final script SHA: `0038e917b73c65023e1a4fd8fb6f45dd136c185747977c6134ab0610dc4ff080`, saved as `coverage-final-rule.py`. All 335 pages are development evidence for this revision.
- Source review means AI visual inspection of rendered source pages/crops and complete grids, not human-certified ground truth. No table was accepted using a document ID, target answer, expected value or rubric allowlist.

## The all-candidate audit changed the conclusion

The preceding geometry experiment had 59 selected regions across 129 pages, of which 25 were accepted. This run reviewed **all 25 accepted grids and all 34 rejected regions**, rather than only eight target tables. The frozen `accepted-source-audit.json` retains complete original grids, source crops, spans and findings. Only **13/25** original accepted regions passed complete-meaning review.

The twelve failures were three CCL tables with incomplete group scope or count/percent columns; seven Hong Kong regions missing a title, units, English note, complete footnote, or correct wrapped label scope; and two COT tables missing meaningful gray cell backgrounds. The earlier target-only results remain scoped to those targets.

Rejected-region inspection identified actual missed classes: narrative prompt/example tables, symbolic complexity/architecture cells, single-column tables, numeric annotations and arrows, slash-valued scores, short or fragmented table rules, closely adjacent tables, single-row summaries, wrapped labels, and misplaced caption selection. These are missed coverage, not evidence that all rejection decisions were desirable. The saved candidate files include every source rectangle and its explicit failure reason.

The broad automatic run (`full-frozen/`) selected 188 regions across 299 pages, extracted 48 grids, and replaced 30. Those numbers are diagnostics: the fiscal-reserve deletion and other scope errors disqualify that arm. `independent-source-frozen/` and `independent-full-frozen/` preserve the subsequent unchanged transfer outcome:

| Source | Pages | Selected regions | Extracted grids | Actual replacements | Finding |
| --- | ---: | ---: | ---: | ---: | --- |
| BERT | 16 | 3 | 2 | 1 | Table 1 folded slash-valued MNLI into its stub and abstained on native overlap. Table 5 combined five distinct task names into each header and was incorrectly replaced. |
| ResNet | 12 | 10 | 2 | 0 | Numeric ensemble table conflicted with a native block; detection table retained an existing native table. Architecture, mixed cells and narrow rules were missed or rejected. |
| NIST Shot | 8 | 0 | 0 | 0 | Prose control unchanged; no table selection was expected. |

All 13 selected transfer regions were source-reviewed, including the nine extraction rejections. The ten frozen numeric-table targets contain 61 rows; this arm produced **zero safe new complete-table replacements** among those targets. The erroneous BERT Table 5 replacement was outside those targets and was caught by auditing every replacement.

## Revised acceptance rule

The final arm keeps the original geometry detector. It adds guards before replacing any native blocks:

1. Every non-whitespace source character centered in a removed native rectangle must have matching text in a represented assignment, header or context rectangle and in the output. Native text tokens must also be conserved; caret exponent notation is normalized only for this comparison. The fiscal-reserve failure is detected as missing source characters and the missing native `834.8` token. An aligned numeric continuation outside the selected width also causes abstention.
2. Existing native tables, partially overlapping blocks, unpositioned page content, conflicting replacements, joined multiword headers spanning several data columns, and unresolved wrapped labels retain their original blocks. Native-table preservation deliberately leaves malformed native tables unrepaired.
3. Explicit centered row labels bounded by source rules retain their existing spans. Signed parenthetical lines immediately below a measure receive a stub span only when the source has no separating rule. This keeps their relationship when a table is split into chunks without inventing a percentage description. Unresolved repeated model labels, such as COT's `w/ chain` rows, abstain.
4. Watermark exclusion requires repeated source text on at least three pages, a diagonal angle, large font relative to body text, low source opacity and a matching native rectangle. CCL is recovered without a text or document-name allowlist. Ordinary rotated content is included in the coverage check.
5. Repeated-furniture decisions are frozen from the full original document, and native headings are retained to avoid changing subsequent section paths. All other retained blocks are copied exactly.

Coverage is necessary but does not establish table semantics by itself. That is why the revised candidate also abstains on ambiguous header and row scope, and every eventual replacement is source-reviewed.

## Revised whole-document result

`coverage-final/` contains the final serial replay. The preceding `all-coverage-r4/` run has the same extraction rule and outputs; subsequent edits added the saved-output verifier only.

| Source | Pages | Selected | Extracted | Replaced | Final source rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| Attention | 15 | 4 | 1 | 1 | 10 |
| TALN | 13 | 3 | 2 | 0 | 0 |
| CCL feedback | 16 | 11 | 6 | 4 | 18 |
| Spain figures | 60 | 17 | 0 | 0 | 0 |
| Japan migration | 54 | 60 | 7 | 0 | 0 |
| German education | 32 | 8 | 0 | 0 | 0 |
| Hong Kong figures | 53 | 73 | 16 | 14 | 46 |
| NIST accelerometers | 11 | 0 | 0 | 0 | 0 |
| CCL COT | 24 | 7 | 4 | 4 | 33 |
| CCL children | 21 | 5 | 5 | 1 | 8 |
| BERT | 16 | 3 | 1 | 0 | 0 |
| ResNet | 12 | 10 | 2 | 0 | 0 |
| NIST Shot | 8 | 0 | 0 | 0 | 0 |
| **Total** | **335** | **201** | **44** | **24** | **115** |

All 201 selected regions have extraction receipts: 157 extraction rejections, 44 extracted grids, then 20 integration abstentions and 24 replacements. The denominator is selected regions, **not every real table in the PDFs**. Unselected tables remain a known recall gap.

The 20 integration abstentions comprise 10 existing native tables, four failures of complete native/source coverage, three partial overlaps and three regions without contained native content. All **8,702** retained blocks are exact copies; **317/335 pages** retain their complete original block arrays.

Accepted source locations are Attention p8; CCL feedback p8, p14 twice and p16; COT p6, p7, and p8 twice; Children p4; and Hong Kong p11, p12 twice, p13 twice, p14, p15, p28, p30, p41, p42 three times and p48. Complete reviewed grids, body spans, source styles, title/notes, final row-to-chunk locations and coverage receipts are retained in `coverage-final/final-row-chunk-audit.json`. COT p7/p8 retain all **136** gray cells, as well as numeric values and bold cells. CCL p8 retains all 64 result values under the two model groups.

The 13 canonical baseline chunk arrays equal the experiment's before arrays field-for-field after JSON decoding; file serialization bytes differ. Unchanged blocks and unchanged pages are checked explicitly during every run. Outside-page chunk arrays match on 12/13 documents. Attention has one newly isolated page-number chunk `7`, previously embedded in a chunk spanning the changed page; it is a boundary artifact, not lost text. Hong Kong's outside-page chunks remain exactly equal. This remaining Attention furniture artifact prevents a claim of perfectly identical collateral chunk behavior.

## Timing and reproducibility

All timings here are **local CPU postprocessing**, Python 3.12.9 / PyMuPDF 1.28.2, against saved parser artifacts. They exclude Java parsing, OCR, PDF repair, uploads, captioning, and provider calls. Each manifest separates whole-document source selection, recovery, source watermark/coverage/replacement, and two-arm chunking. Two-arm chunking includes a baseline pass for comparison and is not an inference latency estimate. There is one final serial timing sample; no VM speedup or end-to-end percentage is inferred from it.

| Final serial sample, all 335 pages | Seconds |
| --- | ---: |
| Whole-source text and region selection | 6.059 |
| Candidate recovery, including saved region artifacts | 3.000 |
| Watermark evidence, native/source coverage and replacement | 9.629 |
| Baseline plus candidate chunking | 6.039 |

The first three measured stages total **18.687 s**. These are instrumented stages, not complete script wall time; source opening, some final JSON serialization and the separate verifier are outside the timers.

Run from the repository root with existing local artifacts:

```powershell
uv run --with pymupdf python -X utf8 bench/parsers/scripts/experiment_odl_table_integration.py --check
uv run --with pymupdf python -X utf8 bench/parsers/scripts/experiment_odl_table_integration.py --sources bench/parsers/reports/local/2026-09-09-odl-table-integration/coverage-all-sources.json --output bench/parsers/reports/local/2026-09-09-odl-table-integration/replay
uv run --with pymupdf python -X utf8 bench/parsers/scripts/experiment_odl_table_integration.py --verify-saved bench/parsers/reports/local/2026-09-09-odl-table-integration/replay
```

The output directory must be new. `--check` exercises numeric cells, missing source content, final chunk text, repeated faint diagonal watermark evidence and stable furniture. `--verify-saved` verifies every saved replacement row with its full headers, title, style markers and table citation, plus complete notes. It tests serialization of the reviewed grids, not independent source correctness. Ruff lint and formatting pass for the owned script.

Remaining useful work is concrete: compare OpenDataLoader's alternate built-in table detector; recover short/fragmented rules; handle slash-valued and symbolic cells; repair collapsed existing native tables only with complete source and native coverage; and represent implicit model-group scope. The current rule intentionally leaves these cases native. The parent experiment handles parser timing, alternate detection, composition with text/exponent repairs, and the MinerU comparison.
