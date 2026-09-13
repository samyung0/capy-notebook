# ODL review repairs, 2026-09-13

Five of the six confirmed defects in the [implementation review](/private/tmp/uat-odl-capture-review-2026-09-13.md) are repaired. The attempted OCR ordering change was removed after the closing review found a new table regression; that original issue remains open. The stale Tencent model-list test now expects the authorized Guangzhou endpoint. Changes remain in the working tree; no deployment or existing-content refresh was performed.

| Finding | Change | Evidence |
| --- | --- | --- |
| Oversized table context aborts ingest | When repeated title/headers leave no token budget for a row fragment, pack context and annotated rows once in source order through the ordinary bounded splitter. | The original 434-token header reproduction produces two chunks. A long-header case with merged cells checks bounded chunks, retained text, span notes and citation regions. |
| Short orphan headings vanish | Remove the arbitrary character-count gates; retain the existing exact glyph, visibility, geometry, duplicate and furniture checks. | Six short English headings and a CJK heading survive. Invisible, numeric-only and repeated margin labels remain excluded. |
| Fresh OCR interleaves prose columns | Unresolved. The attempted geometric ordering and its tests were removed; the original row ordering remains. | Clear-column tests passed, but the closing reviewer reproduced transposition of wide numeric values with unit suffixes. The attempted change would introduce a new association error. |
| An unsupported unused glyph aborts font repair | Validate each candidate font's entire Unicode mapping before changing the PDF; abstain for that font if unsupported. | A modified real CCL fixture renders identically and returns unchanged bytes/count zero. The original known font still repairs/count one. |
| Canonical deduplication loses confidence | Include confidence and its reasons in the content hash. | Identical text/geometry with different confidence has distinct identities. Disposable SQL tests prove lower-confidence content cannot reuse the ready higher-confidence row, while identical lower-confidence content still reuses. |
| Wrong `passages` shapes bypass answer repair | Validate completed streamed objects through the strict parser before accepting the answer. | Null/scalar/object values trigger the existing repair and final citation path; integers, digit strings, empty/omitted lists and approved unfinished-stream behavior remain covered. |

`CHUNKER_VERSION` is now `v8`; parser and client agree on `odl-2.5.7-refined-rapidocr-v2`. These identities prevent reuse of old derived output on subsequent processing. Existing indexed files receive the fixes when refreshed.

The historical Hong Kong golden fixture was kept intact. All 200 old chunks remain unchanged and in order. The new output has 201 chunks because the source-visible short heading `性別 Sex` on page 13 now survives. Its text and citation region are checked separately instead of rewriting the historical expected chunks.

The parser review caught an introduced alternating-indent reordering error. Requiring concurrent vertical lines fixed that case. A further wide numeric-cell check exposed table transposition; requiring alphabetic evidence on both sides handled pure numbers, but the fresh closing reviewer found that ordinary values such as `1,000,000 kg` bypassed the guard. Both labels then preceded both values in the final chunk. The whole attempted OCR change was removed rather than retaining that regression. Its [source snapshot](/private/tmp/uat-odl-attempted-ocr.py) and [test snapshot](/private/tmp/uat-odl-attempted-ocr-tests.py) preserve the reviewed attempt.

The next OCR decision should follow a comparison of a layout-aware approach against source-rendered prose columns, tables, outlines and mixed pages. Adding unit exceptions would not resolve the underlying ambiguity between text columns and table cells. The repository's `human` review workflow sends new closing-review findings back as a decision batch; this remaining OCR issue is that batch, not an approved new round of heuristic tuning.

## Regression activation investigation

The requested Astra xhigh subagent traced the runners and audited 16 locally preserved historical PDFs, verifying their hashes across 328 pages. See the [full investigation](/private/tmp/uat-odl-regression-activation.md), [source audit data](/private/tmp/uat-odl-source-gates.json), and [inspection script](/private/tmp/uat-odl-source-gates.py).

Low activation has three causes:

- Several qualifying defects were absent. The retained corpus has no fonts matching the specific Type1/CJK contradiction and no expressions matching the scientific-exponent source gate. The historical footer inventory found no explicit footer-table ancestry.
- The native regression excluded fresh selective OCR, raster controls and the full 610-page textbook. Hidden-layer reordering does not exercise recognition of a fresh scan.
- Narrow eligibility gates leave other opportunities unresolved. The overprint selector requires triple repetition; inspected Word-produced examples have double paint. Source-table extraction found 129 candidate regions, rejected 127 and extracted two bundles. Mixed-layout CamemBERT tables exceed the numeric-table assumptions.

The historical raw Java trees and replacement receipts are missing locally. Consequently, the two extracted bundles cannot be assigned a definitive final replacement-rejection reason. Source extraction alone is also insufficient evidence of correct table semantics: one extracted bundle combines distinct source columns.

The next useful experiment is a small production-parser replay on the identified local candidates, retaining raw Java, per-repair rejection reasons and final chunks, followed by a holdout split by producer/template family. Score source-confirmed defects, harmful changes, text loss, citation regions and table cell associations. Raising gates until more repairs activate would repeat the original evaluation problem. No such gate expansion was made here.

## Verification and limits

- `pnpm test:pipeline:offline`: 642 passed, 121 integration cases deselected, after removing the attempted OCR change.
- `pnpm test:pipeline pipeline/tests/test_store_sql.py pipeline/tests/test_indexing.py -q`: 78 passed against disposable local Postgres/Redis.
- `pnpm test:pipeline:replay`: 4 passed with live recording disabled.
- Original reviewers confirmed the disjoint [parser](/private/tmp/uat-odl-parser-fix-verification.md), [packing/heading/confidence](/private/tmp/uat-odl-runtime-fix-verification.md), and [structured-answer](/private/tmp/uat-odl-structured-fix-verification.md) fixes. The [fresh closing review](/private/tmp/uat-odl-closing-fix-review.md) found the unit-bearing table regression in the attempted OCR change and no actionable finding in the other five fixes. That attempted change is excluded from the final patch.
- `pnpm run fmt:py`, explicit Ruff format/check on the changed parser files, and `git diff --check`: passed. The root formatting script does not cover `parser/`.

These repairs do not establish broad parser accuracy. Fresh OCR column ordering remains unresolved. Confidence still measures agreement with extracted tokens and cannot prove table associations or reading order. No full Java/RapidOCR/container replay, live UAT test, production database access, shared-host change or paid model call was performed.
