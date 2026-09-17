# ODL broad-spectrum textbook source review

Three new full textbook families, **1,931 PDF pages**, and **18 grouped source checks** frozen for the unchanged shared ODL rules. Biology and economics were frozen at **2026-09-16 11:38:41 UTC** before their baseline/current parser runs. Physics was independently frozen and appended at **11:47:31 UTC**, before its parser runs. The first two source entries remained unchanged.

The machine-readable source of truth is [odl-broad-spectrum-sources.json](../fixtures/odl-broad-spectrum-sources.json). Full PDFs and original-page renders are local under `bench/parsers/fixtures/local/odl-broad-spectrum/`. No production rules, parser outputs, provider jobs or active pilot artifacts were changed in this source-review lane.

## Acquisition and licences

| Book | New family / subject | PDF pages | Bytes | Source and licence |
|---|---|---:|---:|---|
| Fundamentals of Cell Biology, Lauren Dalton and Robin Young, 2024 | Oregon State University / biology | 347 | 59,791,153 | [Publisher](https://open.oregonstate.education/cellbiology/); [actual ZNU academic mirror PDF](https://files.znu.edu.ua/files/Bibliobooks/Inshi83/0062535.pdf). CC BY-NC 4.0 except where noted, visually checked on PDF page 4. |
| Principles of Microeconomics, Douglas Curtis and Ian Irvine, 2021A | Lyryx / economics | 478 | 4,750,605 | [Publisher URL printed in the PDF](https://lyryx.com/subjects/economics/principles-of-microeconomics/); [actual eCampusOntario PDF](https://openlibrary-repo.ecampusontario.ca/jspui/bitstream/123456789/895/3/CI-Principles-of-Microeconomics-2021A.pdf). CC BY-NC-SA 3.0, visually checked on PDF page 5. |
| Simple Nature, Benjamin Crowell, revision May 16, 2020 | Light and Matter / physics | 1,106 | 68,974,604 | [Author landing](https://www.lightandmatter.com/area1sn.html); [author-linked Archive PDF](https://archive.org/download/simple_nature/simple.pdf). CC BY-SA for the text and Crowell illustrations, visually checked on PDF page 4; other illustrations have individual credits. The printed grant does not specify a CC version and also offers GFDL 1.2. |

The OSU publisher download returned HTTP 403 locally. Its complete academic-library mirror was pinned instead; byte identity to the current publisher export is not asserted. OSU's [department page](https://biochem.oregonstate.edu/undergraduate/educational-resources) confirms the title, authors and subject. Figure 01-01 has a separate “used with permission” credit. The intact book and local inspection images are retained; this review does not grant redistribution rights to that photograph.

The initially considered LMU economics download returned HTTP 403, so the source family changed to Curtis/Irvine before any parser output. [BCcampus](https://collection.bccampus.ca/resource/w4MbKEWK/) independently identifies the 2021A edition and licence. These fallbacks change which exact book bytes are being tested; they are not transport substitutes claimed to be identical to an unavailable export.

The physics author page links its current download to Internet Archive. The retired author PDF path returned HTTP 404. A slow initial transfer timed out, then a range request completed with HTTP 206 at `https://dn720005.ca.archive.org/0/items/simple_nature/simple.pdf`. The final byte count matched the archive file size. All three PDFs open without repair and their final pages are readable. Acquisition delay is not parser latency.

SHA256:

- Biology: `3165af33b3a972bb3b8b367a6da3c34126afab2167613cc757bfa1ab372c590b`
- Economics: `5cf8ec9a3989fdeda86c7241105f85cadf42044214558adbec5a2e20b4546aaa`
- Physics: `02843c96c28f06face06a144c89da57f5ae865a8b7ba470c760098377b0db396`

## Frozen source checks

Six grouped checks per book. A grouped check can contain several pages or source texts, so “six checks” is not six independent observations. All pages below are one-based PDF pages. Source text extraction located candidates and bounding boxes; visual inspection of the original rendered page established its role.

| Book | Pages | Source-reviewed expectation |
|---|---|---|
| Biology | 11 | `VISUALIZING CELLS THROUGH MICROSCOPY` is the real chapter title. |
| Biology | 28, 68 | Both occurrences of `CHAPTER SUMMARY` are genuine section headings. Repetition is not permission to demote them. |
| Biology | 11, 31, 151 | `FUNDAMENTALS OF CELL BIOLOGY` is bottom running furniture beside changing folios, never a section parent. |
| Biology | 52 | The all-caps table title and `Integral proteins` / `Peripheral proteins` column labels belong to Table 02-01. Preserve them in the table body without making them parents. |
| Biology | 151 | `Included in coat` occurs in three table cells: COPI adaptor, COPI scission protein and COPII scission protein. All three are body content. |
| Biology | 12 | The original Figure 01-01 caption below the microscopy plate must survive as body content without becoming a parent. |
| Economics | 25 | `Introduction to key ideas` is a real chapter title, although the same text occurs in running banners elsewhere. |
| Economics | 32 | `A model of exchange and specialization` is a real numbered section title. |
| Economics | 33 | The same section text in the top band is a running banner next to printed folio 13. This pairs directly with the preceding genuine-heading control. |
| Economics | 33, 34 | `Vegetable` and `Fish` are repeated plot axis labels, not section parents. Preserve the labels in both diagrams. |
| Economics | 32 | Table 1.1 row labels `Amanda` and `Zoe` are body content. Its source cells are frozen below for a separate exact-table check. |
| Economics | 33 | The original caption `Figure 1.1: Absolute advantage – production` belongs to the plot, not the section hierarchy. |
| Physics | 73 | `Conservation of Energy` is the real chapter title; the same words also occur in running footers. |
| Physics | 80 | `2.1.4 Power` is a real numbered subsection, located between equations and worked-example panels. |
| Physics | 78, 80 | `Conservation of Energy` at the bottom is running furniture beside `Chapter 2` and a changing folio. |
| Physics | 24, 27 | `prefix`, `meaning` and `example` are repeated table headers. Their cells include positive and negative powers of ten. |
| Physics | 78 | The caption beginning `f / A realistic drawing of Joule’s apparatus` belongs to the apparatus drawing. |
| Physics | 77 | The kinetic-energy equation is body content: K = (1/2)mv², with a true fraction and superscript. Its `[kinetic energy]` annotation also belongs to the equation. |

Table 1.1 source cells, read from the original PDF:

| Producer | Hours/fish | Hours/vegetable | Fish specialization | Vegetable specialization |
|---|---:|---:|---:|---:|
| Amanda | 3 | 2 | 12 | 18 |
| Zoe | 2 | 4 | 18 | 9 |

Physics table powers are also frozen independently: kilo 10³, centi 10⁻², milli 10⁻³ on page 24; mega 10⁶, micro 10⁻⁶, nano 10⁻⁹ on page 27. Unruled header spans are not adjudicated. The equation gold is `K = \frac{1}{2} m v^2`. Native source-text anchors such as `K = 1` and `2mv2` locate its content but do not encode correct fraction/exponent structure. An output `K=12mv2` would fail exact equation accuracy even if all structural anchors survived.

The manifest uses `table_header` for two table-body-label entries to reuse the existing structural scorer. The notes explicitly identify their actual source role. `figure_caption` has both body-preservation and no-parent expectations. Per-page `bboxes` override a shared `bbox`. Structural anchor survival alone does not prove that every cell association, formula operator or repeated occurrence survived.

## Freeze and interpretation limits

The first two source entries were released to the parsing agent before those runs started. Their manifest SHA256 was `523a4966637f4c34e12a4bb4e5efde5f4a75355f4ed1a5d4ea517fa4181ab3fb`; the canonical first-two-entry SHA256 was `b90fba044b939f97097349ab5dc3cfa860f248bb59225b10da03f0be2948f073`. The local `source-review/first-two-freeze.json` receipt preserves those values. The physics append verified that both entries were unchanged. Final manifest SHA256 is `d35f2871a6dee4560bb7446733d7d4836e2dffbb7df328a60667219064320fa2`; `source-review/final-freeze.json` records the append and verification. `source-anchor-receipt.json` confirms that every frozen source anchor lies within its source page and is present in the specified region.

This is deliberately chosen source-role coverage across new textbook families, not a random sample of all textbook content. It can expose transfer failures and regressions, but cannot estimate their population prevalence. Biology introduces illustrations and boxed instructional text; economics introduces coloured chapter panels, table rows, and repeated chart labels; physics introduces side captions, repeated unruled-table headings, negative exponents, and display equations. All three books are English, digitally generated PDFs. They add subject and publisher variation, not new language or scan-quality coverage. Full-book context matters because repeated-furniture rules operate across pages.

No source check is inferred from candidate output. No parser-quality or speed result is claimed by this source-only report. Those measurements belong in the parent comparison. The frozen table cell associations and repeated-cell count require separate exact scoring if the general role scorer checks only text presence.
