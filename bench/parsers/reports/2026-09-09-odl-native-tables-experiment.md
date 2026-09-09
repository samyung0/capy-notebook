# Native OpenDataLoader table context

Repeating existing native headers plus the adjacent printed title and unit fixes
the Japanese 48-row table without OCR or Qwen calls. The bounded candidate keeps
all 384 native numeric cells unchanged and gives every row its eight column
labels, 2025 title and person unit in the same chunk. Eight complete rows frozen
from the source image before scoring all pass. This is a focused recovery result,
not a claim of MinerU-level accuracy across documents.

The Hong Kong labour tables and Attention Table 2 remain incomplete. OpenDataLoader
represents them as paragraphs, so a native HTML packing change has no table
structure to preserve. Production code and services are unchanged.

## Experiment

The source images were rendered from the previously downloaded publisher PDFs.
The source hashes and checks were saved to `frozen-checks.json` before candidate
scoring. Japanese source page 11, screening page 3, is the known failure used for
development. Hong Kong source page 13 and Attention source page 8 are frozen
transfer controls from the earlier validation documents. These are known
documents, not a newly held-out document sample.

Four saved-output arms use the current repository chunkers:

| Arm | Change |
| --- | --- |
| Production | Current `chunk_content_list` |
| Structured | Existing `chunk_structured`, explicit header repetition |
| Native context, strict | Structured packing plus adjacent explicit caption/unit attachment and native body-span scope |
| Native bounded | Applies that change only to well-formed tables with explicit column headers; other blocks use ordinary production packing |

Caption attachment accepts an immediately preceding explicit table label, with
up to two bracketed unit lines, on the same page, above the table and within
60 units in the normalized page coordinate system. It copies source text rather
than generating labels. A positively attached title replaces the table chunk's
inherited section path. The citation rectangle expands to include the title and
unit. `indexed_text()` derives its prefix from the corrected section path.
The original title and unit blocks remain available elsewhere in the document.

The native-span experiment retains the single origin of a merged HTML body
cell and labels its row/column scope through the existing span-aware packer.
The bounded corpus arm has no qualifying body spans, so merged-cell benefit is
demonstrated only by the executable synthetic check. The broader strict arm
annotates 216 body spans over seven intact documents without source verification
of those assignments. It should not be treated as a validated recovery strategy.

## Japanese source and final chunks

The frozen source rows are national total, Hokkaido, Aomori, Tokyo, Osaka,
Kagawa, Kagoshima and Okinawa. Their 64 numeric values and all eight column
labels were checked against the rendered source. The 48-row measurements below
verify retention of the complete native grid. They do not represent a fresh
independent transcription of every numeric cell.

| Screening arm | Native rows retained in complete row strings | Rows with all native headers | Rows with title and unit | Frozen complete source rows self-contained |
| --- | ---: | ---: | ---: | ---: |
| Production | 48/48 | 13/48 | 0/48 | 0/8 |
| Existing structured | 48/48 | 48/48 | 0/48 | 0/8 |
| Native context, strict | 48/48 | 48/48 | 48/48 | 8/8 |
| Native bounded | 48/48 | 48/48 | 48/48 | 8/8 |

In the bounded output, screening chunks 7 through 10 contain the table. Tokyo
retains `451,843 | 386,624 | 150,416 | 74,903 | 13,452 | 28,727 | 125,457 | 140,548`
with the complete headers and title. The final chunk also retains Kagoshima and
Okinawa with their signed changes. All four use Table 2 as the section rather
than the preceding Figure 2. The table-cell grid hash is identical in every Java
arm. The five-page document grows from 17 chunks and 12,214 characters to 18
chunks and 12,722 characters in the bounded arm.

## Transfer limits

Hong Kong's male and female counts still occupy chunk 5 while the years occupy
chunk 4. The under-25 relationship is readable in chunk 6, and unemployment
counts, rates and units are together in chunk 7. Underemployment counts are
misclassified as section text in chunk 9 while their thousand-person unit remains
in chunk 8. These defects already exist in native extraction and are not repaired
by this candidate.

Attention's Table 2 remains a flat paragraph in bounded chunk 18. Scientific
exponents, explicit blank cells and the two shared Transformer training-cost
cells remain structurally wrong. The printed table value 41.8 remains in that
chunk and the printed prose value 41.0 remains in chunk 19. Both source values
are preserved without reconciling the source inconsistency.

A separate native source-table probe tried PyMuPDF 1.28.2 `lines`,
`lines_strict` and `text`. The first two find no table on either transfer page.
Text detection produces a malformed whole-page 62 by 14 grid for Hong Kong and
61 by 6 for Attention, including prose and clipped strings. Those outputs were
rejected and never inserted. The Japanese line detector merges all 48 data rows
into one multiline row, so replacing its already correct OpenDataLoader table
would also be unnecessary.

The existing structured packer rejects one malformed native table in the intact
Chinese document, block 107, as `overlapping or incomplete table span`. Both
strict arms record that document as rejected. The bounded arm preserves that
table with ordinary production packing and completes all eight documents.
Every unsupported table's reason is retained in `context.json`. No new production
fallback was introduced.

## Overhead

These are local Windows, Python 3.12.9 saved-output measurements. Each value is
the sum of per-document medians from three sequential repetitions. Timed work
includes copying, table adaptation and chunking. Imports, disk I/O, parser
execution, OCR, rendering, captions, indexing and VM work are excluded. They
must not be added to the earlier VM parsing times as a measured total latency.

| Corpus and arm | Successful cases | Chunking seconds | Chunks | Characters |
| --- | ---: | ---: | ---: | ---: |
| Screening Java/OCR, production | 15/15 | 0.3069 | 198 | 127,220 |
| Screening Java/OCR, bounded | 15/15 | 0.3926 | 210 | 127,706 |
| Intact Java/OCR, production | 8/8 | 1.4560 | 973 | 552,028 |
| Intact Java/OCR, bounded | 8/8 | 1.8505 | 1,083 | 549,917 |
| Intact Java/OCR, existing structured | 7/8 | 3.3441 | 1,105 | 587,590 |
| Intact Java/OCR, strict context | 7/8 | 3.7015 | 1,132 | 623,053 |

The bounded added cost is 0.0857 seconds over the screening cases and 0.3945
seconds over the intact cases on this machine. More chunks imply unmeasured
embedding and retrieval costs. Character totals also change through packing and
overlap; a lower total is not an extraction-quality score. Only one table gains
adjacent title/unit context in each corpus, the Japanese target. Other eligible
tables gain header repetition. The strict seven-case totals exclude the failed
Chinese document and are not comparable full-corpus totals.

## Reproduction and evidence

Run the focused check:

```sh
uv run python bench/parsers/scripts/experiment_odl_native_tables.py --check
```

It verifies native merged-cell scope, repeated context after splits, citation
coverage, unchanged caller data, cross-page rejection and ordinary handling of
malformed native HTML. Isolated Ruff formatting and checks pass. The experiment
uses the existing `structured_recovery.py` helpers without changing them.

Raw evidence is under
`bench/parsers/reports/local/2026-09-09-odl-native-tables/`.
`evaluation-final/evaluation.json` contains 122 case-arm records, including the
two explicit strict rejections. The 120 successful chunk files were hash-checked.
The 38 original result receipts match the prepared PDF hashes in `corpus.json`.
`source-review.json`, source PNGs, frozen checks, native content, source-table
probes, final chunk lists, timing samples and exact source snapshots are retained.
`verification.json` records the checks. Earlier `evaluation-r1` and
`evaluation-r2` directories are superseded development outputs and are excluded
from the reported results. No model credentials or model calls were used.

This supports adopting the native explicit-header and context approach as the
next candidate to validate. It does not remove the need for geometry or OCR
recovery on paragraph-only tables, and it does not establish retrieval quality
or a parser-wide comparison with MinerU.
