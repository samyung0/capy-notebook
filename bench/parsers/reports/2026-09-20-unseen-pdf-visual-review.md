# Unseen PDF visual witness review

The unchanged geometry detector found 2 of 14 missing-math witnesses and falsely flagged 1 of 62 controls. Actual combined output passed 2 of those 14 mathematical facts, failed 10, and partly retained 2 through neighboring prose while omitting the display. A separate audit of 29 inserted native alternatives found one prose-description insertion and six cases of degraded mathematical meaning. These are bounded witness results, not whole-book accuracy estimates.

## Frozen sources and method

The [initial 104 witnesses](../fixtures/unseen-pdf-visual-witnesses-2026-09-20.json) cover 21 documents. A separately frozen [40-witness extension](../fixtures/unseen-pdf-visual-extension-2026-09-20.json) covers the remaining 13 documents in the [source manifest](../fixtures/unseen-pdf-sources-2026-09-20.json). The combined gold contains 144 regions on 70 primary pages, all 34 new PDFs, and 12 conservatively grouped exporter families. Subject differences do not count as separate exporters. Prince versions share one family; pdfTeX/pdfeTeX and dvipdfmx variants are likewise grouped. Adobe PDFMaker, PDF Library, and reprocessed Acrobat composites remain separate.

Each case records a source hash, one-based page, PDF-point rectangle with top-left origin, visible fact or relation, expected behavior, native-layer state, and optional outline level or related source locations. Source renders, exact crops, glyph text, and source outlines were inspected before either freeze. No repaired output, native-alternative decision, or detector result was inspected before freezing. Both gold files remain unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Initial gold | `07c2e8d0391870146d7b9417f7ef04dff0a86ac3e4b11649ebe67fdec81a37c8` |
| Extension gold | `8ca9988a41686fb077a4af3927fe0fa5fe67b4f79f729fc9abfb14e2b33e5d71` |
| Frozen detector | `136de0218bda281e34a50454b5aff6d969c93d7ae5a074f6be7b9ac2cd897e35` |

Cases include English, French, traditional Chinese, Japanese, Korean, Arabic, and Icelandic; display and inline mathematics, tables, diagrams, columns, real repeated headings, margin furniture, and a rotated dictionary thumb tab. The rotated case is rotated content on an upright page, not a complete rotated-page evaluation. Labels are assistant-reviewed, purposive, and not independently human-certified.

Missing-math positive coverage is narrower than document coverage: 12 positives are Prince formulas and two are e.Typist scanned formulas. Both detections are Prince inline formulas. Other families contribute intact-glyph, table, diagram, heading, or ordering controls. They do not establish cross-family missing-math recall.

## Geometry results

`detect()` ran unchanged on the 70 witness pages. A candidate matches a case only by positive-area rectangle intersection, the same rule used in the preceding detector experiment. No shape, size, anchor, or threshold was tuned.

| Tranche | Detected missing regions | Missed missing regions | Flagged controls | Unflagged controls |
| --- | ---: | ---: | ---: | ---: |
| Initial | 1 | 6 | 1 | 46 |
| Extension | 1 | 6 | 0 | 15 |
| Total | 2 | 12 | 1 | 61 |

The other 68 cases are excluded from this binary score, including headings, furniture, and corrupt OCR. Unflagged controls are not extraction passes. Candidates outside frozen rectangles are unjudged. Runtime was 5.44 seconds including opening PDFs and checking source hashes; the relocated runner reproduced the same outcomes in 5.52 seconds.

Detected cases were Statistics p111's `(n+1)/2` and Precalculus p21's `f(March)=31`. All 12 display/raster positives were missed: Statistics mean/expected-value/standard-deviation formulas, Chemistry density fractions, Biology derivatives, Astronomy period formulas, the BCcampus raster equation, and both J-STAGE scanned equations. The false positive intersected a graph on MIT Strang p15. Geometry is therefore useful only within the tested small-inline scope; separate display/image coverage remains necessary.

Per-case, per-family, and page records are in `local/2026-09-20-unseen-pdf-validation/visual/detector-results.json`.

## Actual baseline and combined output

`visual/output-evidence.json` records all 144 frozen witnesses. The final snapshot has 138 with baseline/candidate blocks, native-alternative decisions, and downstream chunks available across 32 completed original documents. Six witnesses have unavailable parses. Surrounding-region matching is evidence collection, not a semantic score. Manual outcomes are separate in `visual/output-judgments.json`: 37 cases assessed, 107 explicitly unassessed. Among the assessed cases, 12 pass their exact frozen fact, 18 fail, and seven are partial. The unassessed count comprises 101 cases with available evidence and the six unavailable cases. This selected subset is not a corpus accuracy denominator.

All 14 missing-math positives were manually assessed. Their combined outcomes are two passes, ten failures, and two partial cases. The following examples show source→raw→chunk behavior:

| Source witness | Actual output | Result |
| --- | --- | --- |
| Statistics p111 median fraction | Raw block 1586 says `using the expression .`; Alt 15963 inserts numerator n+1 over denominator 2 in the matching clause and combined chunks 355–356. | Pass; combined confidence .958/.926, no reasons. |
| Precalculus p21 function | Raw block 228/baseline chunk 63 omit `f(March)=31`; Alt 18198 restores it in combined block 228/chunk 62. | Pass; confidence changes from 1.0 to .857, with no reasons. |
| Statistics p111 display mean; p242 mean and SD | Source `/Placement /Block` alternatives are review-only. Combined chunks still omit the displays; p242 chunk 746 refers to “these formulas.” | Fail; p242 chunk 745 scores 1.0 with no reasons. |
| Chemistry p44 density fractions | Both displays are review-only. Prose still explains mass divided by volume, but the worked 90.7/8.00=11.3 relation is absent. | Simple relation partial; worked calculation fails. Chunks 108/109 score 1.0. |
| Biology p1356 derivatives | Alt 67777/67779 are review-only. The derivative equations are absent from combined chunks 3964/3965. | Fail; scores .996/1.0, no reasons. |
| Astronomy p90 periods | P²=a³ display omitted, but surrounding prose/inline repairs retain much of the relation. Worked `sqrt(125000)=353.6 years` is absent from chunk 249. | First partial, worked example fails; chunk 249 scores 1.0. |
| BCcampus p68 raster formula | Raw/combined image block 579 has no equation text or intersecting chunk. Alt 3880 abstains without a unique containing text block. | Fail; image-only gap needs separate handling. |
| J-STAGE p1/p2 scanned equations | Raw text jumps over the formulas; equation (2) survives only as its label. | Fail; corrected baseline and combined chunk 7 both score 1.0, no reasons. |
| Computer Science p216–217 ranges | Native superscript glyphs survive in the PDF, but raw/combined text becomes `2n−1` and `[−2n−1,+2n−1−1]`. | Exponent scope fails despite detector negatives and scores near 1.0. |
| NIST FIPS203 p14/p29 | `2^8` becomes `28`; BitsToBytes retains floor indexing and step order but flattens `2^(i mod8)`. | Frozen mathematical facts fail; combined scores .996/1.0. |
| NTNU p2/p3 matrices | Entries survive, but brackets, labels, and row boundaries flatten into separate or interleaved pieces. | Partial matrix fidelity, with confidence 1.0. |
| Arabic form p2/p4 | Credit label/value absent; strings have reversed character order and description text receives the next heading's scope. | Fail; low scores flag the loss but neither prototype repairs it. |
| W3C complex table | Raw HTML retains rowspan/colspan; packed text loses the explicit Results header span. Individual Blind/Low-Vision row values remain ordered. | Header relation partial, two row facts pass; .833 flags uneven columns. |
| SNU Korean schedule | Exact frozen date associations survive; general-admission scope exists in `section_path`. Other group cells fragment across chunks. | Frozen facts pass; does not validate the entire merged-cell layout. |
| BOJ p21 adjacent charts | Captions, legends, axes, and ticks from left/right lending charts interleave in raw blocks and combined chunk 57. | Figure separation fails; confidence 1.0. |
| INSEE p56 | Frozen 47.4/29.8 and 36.4/34.0 table facts remain ordered in a flattened list/chunk 165. Bar-chart heights/age relations disappear in chunk 164. | Table facts pass; chart fact fails; both score 1.0. |

Computer Science's printed addition-table last row is `1,1,1,1`; raw and combined output correctly retain it. The source contains the arithmetic error. The gold does not silently replace its printed sum with 0.

The original ECB PDF failed parsing and MHLW timed out. Their three witnesses each remain unavailable and unassessed. A separately repaired development copy of ECB is outside this unchanged source holdout.

### Confidence verification

Baseline collection now scores **all** chunks before selecting witnesses, uses the baseline `parsed.pdf` when emitted, verifies the measured PDF against the parse receipt, and preserves global chunk indices. The v2 cache binds source/measured PDF, parse, blocks, refinement, retrieval-module hashes, and fixture hashes. Earlier `*-baseline-chunks.json` files are invalidated diagnostic v1 records. In particular, the earlier J-STAGE baseline .829→combined 1.0 comparison was caused by scoring selected chunks only and is withdrawn.

The final independent invariant considered all 32 completed original documents and regenerated all baseline chunks on the 20 whose blocks, furniture, and measured PDF were unchanged. All 7,430 full records, including confidence and reasons, equal actual combined records (`visual/zero-intervention-invariant.json`). The record binds baseline/combined content, measured PDF, native summary, and actual combined chunk hashes. This verifies scoring consistency on those inputs; it is not an extraction-quality test.

## Native-alternative insertion audit

After gold freeze, a separate audit inspected Statistics recovered rows 0,100,...,1100; all 11 Computer Science recoveries; and Chemistry rows 0,300,...,1500. These 29 actual insertions are not a random sample or an all-insertion accuracy estimate. Source crops and neighboring output were checked. Twenty-two visibly corresponded to their source mathematical expressions, six degraded mathematical meaning, and one inserted prose description as body text.

- Statistics p835, xref70585: a visible ENTER calculator key becomes a full description of a glowing button, including a speculative “action or gateway” interpretation, inside instructional block 10853. Authentic source `/Alt`, correct location, and character-subsequence retention did not prevent description contamination.
- Statistics p328, xref32239: a natural-log expression becomes `l n times` and fragmented letters for the area-to-the-left variable. Correct placement does not preserve meaning.
- Computer Science p384–386: cardinality is called absolute value; the rename operator gains a multiplication; left and right outer-join symbols both become identical `bowtie` wording. The latter share chunk 1136, confidence .950.
- Chemistry p684, xref38377: chemical state markers `(s)`/`(aq)` become multiplication language and ionic charges are described as powers.

Records and source crops: `visual/statistics-insertion-audit-{sample,judgments}.json`, `visual/more-insertion-audit-{sample,judgments}.json`, and their PNG contact sheets. No candidate was tuned on these failures. Skipped alternatives are not recovered content.

## Reproduction and scope

From the repository root:

```powershell
uv run --frozen python bench/parsers/scripts/evaluate_unseen_visual_detector.py --fixtures bench/parsers/fixtures/unseen-pdf-visual-witnesses-2026-09-20.json bench/parsers/fixtures/unseen-pdf-visual-extension-2026-09-20.json --output bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/visual
uv run --frozen python bench/parsers/scripts/collect_unseen_visual_output.py --fixtures bench/parsers/fixtures/unseen-pdf-visual-witnesses-2026-09-20.json bench/parsers/fixtures/unseen-pdf-visual-extension-2026-09-20.json --input-root bench/parsers/reports/local/2026-09-20-unseen-pdf-validation --output bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/visual
```

Reusable runners live under `scripts/`. One-off source-label builders remain only as non-executable `.py.txt` provenance. Scoped Ruff formatting and lint checks passed; gold hashes and detector outcomes remained unchanged after runner relocation.

The frozen gold occupies 70 primary pages of 11,672; additional insertion-audit pages were inspected separately. Every source has source witnesses, while most semantic output judgments remain unassessed. No whole-book prevalence, all-page accuracy, or calibrated probability follows from these results. Full parse identities, broad heading comparison, and document timings belong to the coordinating report. No production parser, pipeline, live builder artifact, provider call, or remote job was changed by this audit.
