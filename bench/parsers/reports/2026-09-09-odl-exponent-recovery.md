# Source-confirmed scientific exponents

OpenDataLoader can flatten a raised exponent into the preceding number. In the
ResNet architecture table, `1.8 × 10⁹` becomes `1.8×109`. This changes the value
even when every printed digit survives extraction.

The new offline experiment inserts a caret only where the PDF has a horizontal
scientific-notation expression ending in `×10` or `·10`, followed by an explicitly
raised integer span. The corresponding flattened expression must occur exactly
once in both the native field and its source region. Every participating source glyph center must lie inside that region, and an already-marked equivalent expression causes abstention.
Ordinary powers, units, footnotes and inferred formulas are outside this rule.

## Results

The frozen rule was replayed on 13 documents, 335 pages. It restored 18
occurrences: 12 training costs in Attention, five architecture-table FLOPs in
ResNet, and ResNet's training-iteration count. All 18 survive in actual indexed
chunks. The other 11 documents remain unchanged. Two repeated Attention costs
abstain because the native field has more than one matching occurrence.

All restored values were checked against three source-rendered crops. The five
ResNet FLOPs were already in the source rubric frozen before candidate parsing;
the broader occurrence audit is development evidence, not an additional blind
transfer test. The full source tables' meaning is assessed separately.

The first revision required entire source font boxes inside the native region.
This rejected the five FLOPs because the multiplication-symbol font box extends
below the printed table row. The second revision uses the expression's center,
the same kind of source-position test used in the native text experiment.
All revisions and their results are retained.

Independent review found an ambiguity when a block already contained the correct raised value alongside an ordinary number with the same flattened spelling. A second case clipped the raised glyph out of the citation region. The reviewed rule now requires every participating glyph center inside the region, unique complete source and native occurrences, and absence of an already-marked equivalent. Both saved PDF reproductions abstain, the positive narrow-region check passes, and all 13 documents retain exactly the previous content and chunks. The reviewer confirmed both fixes.

The second replay took 0.179 seconds locally across all 335 pages, excluding
chunking. The reviewed fourth revision took 0.264 seconds. These are single local observations, not VM latency claims. All documents
passed idempotence, unchanged block type/page/geometry, and the invariant that
removing inserted carets reproduces every original field. No glyph, word or
number was replaced or removed.

## Reproduction and evidence

```sh
uv run --with pymupdf==1.28.2 --with 'pypdf[crypto]==6.18.0' \
  python bench/parsers/scripts/experiment_odl_exponents.py \
  --sources bench/parsers/reports/local/2026-09-09-odl-third-pass/all-sources.json \
  --output /new-output-directory
```

The source manifest binds original PDFs, parsed font-repair copies, native
content and prior chunks by SHA-256. The runner verifies the parsed PDF and
content hashes before replay. It writes changed content, actual chunks,
source-position receipts and per-document timing.

Raw evidence is under `reports/local/2026-09-09-odl-exponents/`: `r1` through `r4`,
`source-review.json`, the source PNGs, `verified.json`, the original frozen rule, and `reviewed-rule-r2.py`. The review receipts are `review-guard-check-r2.json` and the independent reviewer evidence in `odl-third-native-review/`.
The frozen script SHA-256 is
`28767d615d59194a0c3954e953d13473e10efe9ad00a4f2461c7a33b25bf1121`.

`--check` creates real PDF cases for ordinary/raised ambiguity, clipped source regions and positive source-position recovery.

The experiment changes no production parser or ingest setting. Composition
with the other third-pass repairs and the matched MinerU comparison remain
part of the continuing evaluation.

## Additional 430-page negative controls

A source-only plan was frozen before reviewing the fresh 22-document regression
candidate. The complete source sweep finds no eligible scientific-notation
exponents under this rule, and the integrated candidate records zero exponent
decisions. Isolated replay preserves all baseline and final content exactly.
The executed script SHA matches the reviewed version above. The VM exponent
phase totals 0.052 seconds across these 430 pages.

This adds negative-control evidence without a new positive transfer claim.
No exponent changes means no citation geometry changes from this stage; other
native refinement stages are outside this check. Source inventories, final
content/chunk hashes and receipts are under
`reports/local/2026-09-09-odl-third-regression/font-exponent-review/`.
