# Source-bound review of broader ODL outputs

Review date: 2026-09-16. All three sources reviewed on pass 1. All three books reproduce exactly in pass 2 within both arms.

## Method

The source reviewer froze original PDF page images, roles, anchors and source boxes before parsing each new book. This reviewer inspected those pages, then compared the baseline and current full-book raw blocks and packed chunks. Gold was not changed. Source positions distinguish a real heading from an identically worded running banner and distinguish a table cell from surrounding prose.

Artifacts are under `bench/parsers/reports/local/2026-09-16-odl-broad-spectrum`. `manual-review.json` records zero-based raw block/chunk indices, source bounds, source hashes and separate manual role/preservation decisions. Source/check provenance is in `bench/parsers/fixtures/odl-broad-spectrum-sources.json`. These are selected observations, not a whole-book accuracy rate.

## Selected observations

| Source | Heading/body/furniture checks, baseline → current | Searchable body anchors retained, baseline → current |
| --- | --- | --- |
| Fundamentals of Cell Biology | 8/11 → 11/11 | 5/5 → 5/5 |
| Principles of Microeconomics | 9/10 → 9/10 | 3/7 → 7/7 |
| Simple Nature | 9/11 → 11/11 | 7/7 → 7/7 |

Counts expand grouped pages and texts. The biology body-cell anchor additionally requires all three frozen occurrences, which both arms retain. The physics equation is excluded from both columns and assessed separately below. Role success does not imply correct table structure or complete ancestry elsewhere.

For all three books, raw content-list bytes and complete chunk objects are identical between pass 1 and pass 2 within each arm. The observations below therefore apply to both executions, including confidence values.

### Biology

The three real headings remain headings: the chapter title on PDF page 11 and `CHAPTER SUMMARY` on pages 28 and 68. Their following text keeps the corresponding ancestry in both arms. The three inspected running footers on pages 11, 31 and 151 become discarded blocks in the current parser. Whole-book annotations identify 339 such running banners, and chunks with the exact folio-bearing footer/author strings in their paths fall from 651 to zero. This whole-book count measures the transformation, not independently reviewed role accuracy on 339 pages.

The large excerpt-count change has a direct structural explanation. The pilot starts a new excerpt whenever the next chunk's section path changes. Removing recurring folio-bearing headings reduces raw headings from 752 to 413, chunks from 1,086 to 1,053, and contiguous-path excerpts from 735 to 421. An excerpt count is not a content-recall or learning-quality score.

All three frozen table-title/column-label anchors on page 52 remain searchable. The original microscopy caption on page 12 also survives literally. Page 151 retains exactly three source occurrences of `Included in coat`: two in raw block 1184 and one in block 1185, all carried into current chunk 349. These labels are ordinary body text, not section parents.

The membrane-protein table on page 52 remains structurally unsafe in both arms. Raw blocks 376 and 377 emit `Association with lipids after extraction` and `Solubility after extraction` consecutively before the previous row's values in blocks 378 and 379. Current chunk 118 preserves that order. The title and words survive, but row/column associations are not encoded as a table. The generic standalone-header scorer can miss the preserved column labels because raw block 372 contains `Criterion Integral proteins Peripheral proteins` as one line.

This failure is not low-confidence flagged. Current page-52 chunks 117 and 118 both have confidence **1.0**, with empty reason lists. The page-151 flat table in chunk 349 also has confidence **1.0** and no reasons. Literal coverage alone does not establish table correctness.

### Economics

The genuine chapter title on page 25 and the real section heading on page 32 retain their roles and following ancestry. Both rows and all eight numeric values in the frozen page-32 table retain their column associations in both arms: `Amanda | 3 | 2 | 12 | 18` and `Zoe | 2 | 4 | 18 | 9`. Headers contain extra separators from wrapped source labels, but their column meaning and row alignment remain clear. The source caption on page 33 survives in both arms.

All four inspected axis-label occurrences become searchable: `Vegetable` and `Fish` on pages 33 and 34. Baseline raw blocks 212/217 and 233/241 contain these words but have no corresponding packed body regions. Current chunks 55 and 57 retain the words with each original source box. This is actual text recovery, not merely preserving a diagram image. No separate image block covers these vector diagrams in the inspected raw output; the original PDF remains the visual source.

The page-33 running banner remains a real failure. Raw block 210 still has `text_level: 16` and text `1.4. A model of exchange and specialization 13` in both arms. It becomes an extra folio-bearing parent alongside the legitimate page-32 section heading. Current chunks 55 and 56 retain that bad component. They have confidence **0.985** and **0.997**, respectively, with empty reason lists.

A generic substring check cannot adjudicate this case reliably: the valid page-32 heading should remain in page-33 ancestry. The source box and exact folio-bearing block prove that this particular page-33 occurrence is still wrong; inherited ancestry alone would not.

### Physics

The chapter title on page 73 and `2.1.4 Power` on page 80 retain their heading roles and following ancestry in both arms. The two inspected folio footers on pages 78 and 80 become discarded blocks in the current parser, while the legitimate chapter title remains in the path. All six inspected table-header occurrences, `prefix`, `meaning` and `example` on pages 24 and 27, remain searchable body text. The original apparatus caption on page 78 also survives. Whole-book annotations identify 982 running-banner corrections; raw headings fall from 1,685 to 703, chunks from 2,792 to 2,583, and contiguous-path excerpts from 1,515 to 686.

The physics equation remains mathematically wrong in both arms. The source on page 77 is `K = (1/2) m v²`. Raw block 766 stores the fraction as list items `1` and `2`; block 767 stores `mv2 [kinetic energy].`; block 768 stores `K =` after them. Baseline packing omits block 768. Current chunks 189/190 recover it with its source box, producing this order:

```text
1
2

mv2 [kinetic energy].

K =
```

Restoring `K =` does not repair fraction structure, exponent scope or reading order. Exact equation accuracy is **0/1 in both arms**. Of the frozen native-text anchors, `K = 1` remains absent; `2mv2` appears only after joining the flattened lines; `kinetic energy` survives. None of these anchor observations counts as a correct equation. Current chunks 189 and 190 score **0.993** and **0.996**, with no confidence reasons.

The six frozen table powers also remain wrong as mathematical encodings in both arms. Raw blocks 175 and 224, carried into current chunks 46 and 54, contain `103`, `10−2`, `10−3`, `106`, `10−6` and `10−9`, with no superscript or exponent markup. The visible source instead has powers `10^3`, `10^-2`, `10^-3`, `10^6`, `10^-6` and `10^-9`. Digits and signs remain, but exponent scope is lost: **0/6 exact power encodings in both arms**. Current confidence is **1.0** and **0.992**, with no reasons.

## Scope

The shared fix improves these selected recurrence/role failures without solving table reconstruction or every running-header layout. No inference should be made that current confidence automatically routes the remaining errors to review. The broader benchmark's raw-payload and previously-visible-text counters cover different properties and must not substitute for the source checks above.
