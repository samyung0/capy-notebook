# Java recovery on eight new documents

The new corpus confirms that Java extraction is fast, but its current recovery
rules miss corrupted text and its chunks can lose table meaning. Eight newly
sourced publisher PDFs contain 254 original pages. The Java plus selective
RapidOCR run completed in 28.37 seconds. A separate 48-page screening set,
including eight deliberate raster controls, took 32.51 seconds.

Beijing model tests produced three HTTP 403 `AccessDenied.Unpurchased` responses.
The developer then paused that region pending business validation. No successful
Qwen3.5-OCR or new Qwen3.8-Flash output exists for this experiment. The temporary
credential was removed. See the [OCR protocol and receipts](2026-09-09-beijing-ocr.md).
Production parsing and services remain unchanged.

## Sources and method

| Publisher/source | Original pages | Screening source pages, one based | Role |
| --- | ---: | --- | --- |
| [Attention paper, arXiv](https://arxiv.org/pdf/1706.03762) | 15 | 2, 3, 4, 6, 8 | Validation |
| [French complexity paper, ACL](https://aclanthology.org/2024.jeptalnrecital-taln.27.pdf) | 13 | 2, 5, 6, 8, 9 | Development |
| [Chinese feedback paper, ACL](https://aclanthology.org/2024.ccl-1.10.pdf) | 16 | 2, 3, 5, 8, 10 | Development |
| [España en cifras 2024, INE](https://www.ine.es/prodyser/espa_cifras/ant/espcif24.pdf) | 60 | 3, 7, 8, 15, 26 | Validation |
| [Japan migration report, Statistics Bureau](https://www.stat.go.jp/data/idou/2025np/jissu/pdf/2025all.pdf) | 54 | 6, 9, 11, 16, 17 | Validation |
| [German education report](https://www.bildungsbericht.de/de/bildungsberichte-seit-2006/bildungsbericht-2024/pdf-dateien-2024/bildungsbericht-2024-kompakt.pdf/@@download/file/Bildungsbericht-2024-kompakt.pdf) | 32 | 3, 5, 9, 15, 23 | Development |
| [Hong Kong in Figures, Census and Statistics Department](https://www.censtatd.gov.hk/en/data/stat_report/product/B1010006/att/B10100062024AN24B0100.pdf) | 53 | 8, 10, 13, 17, 51 | Validation |
| [1948 accelerometer paper, NIST](https://nvlpubs.nist.gov/nistpubs/jres/041/5/V41.N05.A01.pdf) | 11 | 1, 3, 4, 5, 9 | Validation |

Sources cover English, French, Chinese, Spanish, Japanese and German. All eight
PDFs were downloaded successfully and retained intact. An additional NCERT
textbook download failed and is excluded, with its failed receipt retained.
Public availability is not a claim of unrestricted redistribution rights. Raw
PDFs and derived images stay in ignored benchmark artifacts.

The [source manifest](../fixtures/java-new-documents-sources.json) binds publisher
URLs, SHA-256 hashes, explicit page selections and development/validation roles.
Forty original screening pages were extracted, with eight additional raster
controls made at 150 dpi, JPEG quality 85 and blur radius 0.25. Raster controls
are derived copies, not eight independent scanned documents. The NIST original
is a genuine historical scan that already contains a damaged OCR text layer.

A [40-page review rubric](../fixtures/java-new-documents-review.json) was frozen
before reading candidate output. Its general questions are not certified ground
truth. Source-topic corrections made before candidate review are recorded, with
the initial draft retained. The OCR reviewer separately froze 29 checks on eight
new pages, then four photograph checks on a ninth page. Main review additionally
inspected the German prose pages, Japanese contact page and French factor table.
These purposive, AI-reviewed cases do not yield a population accuracy score.

## Extraction and selection cost

Java uses OpenDataLoader 2.5.7 with cluster tables and header/footer inclusion,
one Java extraction thread, eight RapidOCR threads and exact-image deduplication.
Runs used an isolated container on `159.195.61.195`, eight CPUs, 14 GiB memory
and 28 GiB memory-plus-swap. Existing services were not restarted. The address
`159.195.250.206` did not contain the prior benchmark archives.

| Measured phase | Screening, 48 pages | Intact documents, 254 pages |
| --- | ---: | ---: |
| Java execution | 19.20 s | 24.28 s |
| Basic inspection | 0.59 s | 2.88 s |
| OCR job preparation | 0.01 s | 0.02 s |
| Direct OCR | 12.65 s, 8 images | 1.04 s, 1 image |
| Adaptation and deduplication | 0.07 s | 0.15 s |
| Complete measured Java/OCR run | **32.51 s** | **28.37 s** |
| Peak sampled container memory | 0.82 GiB | 0.64 GiB |
| Peak sampled swap | 0 | 0 |

MinerU 3.4.5 with `method=auto` completed the same 15 screening cases in
357.43 seconds, with peak sampled memory 3.24 GiB and no swap. It used the same
CPU/memory bounds, retained local models, no warmup and no captions. That is
about 11 times the Java/OCR screening duration, but these parsers do different
amounts of recognition work. The first MinerU case includes lazy model loading.
No intact 254-page MinerU run was needed for this quality comparison.

All 15 screening cases and eight full-document Java cases completed. The full corpus
is faster because it has fewer raster-only pages requiring OCR. This does not
mean its existing text is trustworthy, particularly for the Chinese font mapping
and historical OCR layer. Timings are one run per set, not percentile estimates.
They exclude structural inspection, page-context rendering, captions, chunking,
indexing and queue/network latency.

The later structural inventory cost another 8.16 seconds for screening and
54.48 seconds for full documents on the VM. Context rendering took 8.93 and
30.90 seconds on the local Mac, with the two render jobs overlapping. These are
separate stage observations, not a combined end-to-end latency measurement.

| Document | Selected for page recovery / original pages |
| --- | ---: |
| Attention | 10 / 15 |
| French complexity | 5 / 13 |
| Chinese feedback | 6 / 16 |
| Spain figures | 55 / 60 |
| Japan migration | 50 / 54 |
| German education | 31 / 32 |
| Hong Kong figures | 51 / 53 |
| NIST accelerometers | 11 / 11 |
| Total | **219 / 254, 86.2%** |

The screening selector chose 37 of 48 pages: 32 original pages and five raster
controls. A successful model call on each selected page would be substantial
additional work. The corpus has no measured caption latency because live model
tests stopped at entitlement errors. Earlier caption timings should not be
substituted for a measurement on these new pages.

## What the source review found

**Corrupted embedded fonts can escape every recovery rule.** The Chinese paper's
Latin model names and numbers map to unrelated CJK characters. Original source
pages 2, 3, 8 and 10 are all unselected in the screening run. Page 8 contains a
large results table that the source-table detector also misses. The previous
zero-width duplicate-glyph repair addresses a different defect and does not
repair these mappings. Direct selective OCR does not run on these originals.
On the matched rasterized source page 8, RapidOCR recovers all 64 expected
numeric cells exactly. It still flattens grouped headers and table geometry.
This supports testing better OCR selection before replacing the OCR model.

**Successful table extraction can still produce unusable later chunks.** Java
retains the Japanese table's 48 rows and eight numeric columns in raw HTML.
Later chunks containing Tokyo through Okinawa lose the column headings, units
and current table title, and inherit the preceding figure's section context.
The initial header-containing chunk does not make the later chunks self-contained.

**Native text preserves values more reliably than visual relationships.** The
Attention performance table becomes one flat paragraph. Exponents such as
10^20 become `1020`, while merged training-cost cells lose their scope. Its
41.8 table value and 41.0 prose value are an actual source inconsistency and
must both be preserved. The encoder/decoder image exists, but its chunk retains
only the printed caption rather than all arrows and connections.

**Prose reading order needs its own evaluation.** German source pages 3 and 23
are plain two-column prose, yet the selector flags `source_table`. Their native
block order really is damaged: right-column continuations appear before the
left-column paragraphs they continue. Dropping these pages merely because they
contain no table would hide a different recovery need. The Japanese contact
page's image trigger, meanwhile, comes from a logo/search graphic rather than a
substantive study figure. Its native methodological text is readable.

**Color can carry test results.** On the French paper's source page 8, native HTML
and one current chunk retain all 49 signed model/factor values and seven factor
proportions. They lose which cells are yellow. The caption explains that yellow
means statistical significance but cannot reconstruct which entries are marked.
Passing all numeric row checks would miss this loss.

A controlled Java configuration experiment ran both development documents with
cluster tables, first with normal reading order and then with `reading_order=off`;
header/footer inclusion was off and Java used eight threads in both arms.
These were two new 10-page runs,
3.35 and 3.41 seconds. Two source-verified German column-continuation checks
were frozen after control review and before this candidate ran. The current
headers configuration and the matched cluster control pass 0/2; order-off
passes 1/2, while MinerU passes 2/2. On source page 23, order-off begins with the
right-column continuation and still places the preceding left-column text
later. This is a failed general configuration fix, not a reason to change the
production setting. MinerU also loses the French table's yellow significance
annotations despite correctly retaining its numeric grid.

The nine-page independent source review compares native blocks, selective output
and actual production chunks, with exact artifact hashes. Native and selective
outputs are identical on those nine original pages after image path normalization;
therefore selective OCR did not repair their losses. Its detailed findings are
in the [Beijing report's native baseline review](2026-09-09-beijing-ocr.md).

## What MinerU improves and still misses

The same nine-page source judgments were applied to the completed MinerU control.
Its detailed evidence is alongside the Java review in the Beijing report.

| Source content | MinerU compared with Java |
| --- | --- |
| Attention performance table | Restores table rows, blanks and exponents, but assigns each shared Transformer training-cost cell to English-to-German alone. The complete table reaches one chunk with that wrong scope. |
| Attention architecture | Still supplies the printed caption without the complete diagram relationships. |
| NIST formulas and graphs | Recovers equation 2 exactly. Equation 1 substitutes alpha for a, equation 3 remains corrupted, and all seven extracted plot blocks have empty chart content. |
| NIST instrument photograph | Improves surrounding prose, reading order and labeled parts, but adds no visual description of the photograph. |
| Chinese feedback results | Recovers all 64 numeric cells and retains them in two complete table chunks. Original prose still has broken font mappings; diagram dialogue becomes image-only. |
| Japanese prefecture table | Only 44 of the 48 source-verified row numeric sequences match. Hokkaido/Aomori values and Kagoshima/Okinawa rows merge; a subtraction sign and a prefecture label are also damaged. Java's raw table was more faithful here. |
| Hong Kong labour tables | Unemployment and underemployment tables become correct self-contained chunks. The sex and age tables introduce false associations despite retaining numbers. |
| German prose | Both column-continuation checks pass, compared with 0/2 for current Java and 1/2 for Java with reading-order detection off. |

These results do not justify a parser-wide quality ranking. MinerU spends more
recognition time and fixes some failures, but it also introduces errors where
Java's raw extraction was already correct. Neither parser's image files alone
supply the missing visual meaning to text retrieval.

## Merged-cell experiment

The benchmark-only [span prompt](../fixtures/image-record-spans.txt) adds explicit
zero-based body spans and separate table metadata to the existing structured
format. Covered cells must be empty; overlapping spans, out-of-range spans and
independent text in covered cells are rejected. The adapter emits HTML spans
and annotates shared source-cell scope when experimental chunks expand the grid.
Existing responses without these new fields remain accepted.

The focused offline test preserves a single `5.96` cell shared by two treatments
without claiming two independent measurements, and retains its sample metadata.
It also rejects ambiguous span records. This proves representation behavior only.
No model has produced or been scored against the new span prompt. Shared scope
annotations consume tokens, and table footnotes are still separate packing units.
No production schema or chunker was changed.

## What to test next

1. Detect broken font mappings using visible-source/OCR disagreement on a small
   development sample, then test a frozen rule on different documents. A larger
   character count alone is not proof that extracted text is valid.
2. Separate reading-order repair, formula/table recovery and decorative-image
   exclusion. Keep the German prose failures as positive repair controls and the
   Japanese contact graphics as a negative substantive-caption control.
3. Run the old and span-aware prompts on matched development pages through an
   enabled provider region. Score complete merged-cell scope, highlighted cells,
   units, footnotes and formulas before evaluating the held-out documents.
4. Re-evaluate final chunks for every recovered relationship, including inherited
   section headings, and measure a complete cold execution only after the output
   passes source review. A 219-page model plan could erase much of Java's native
   speed advantage.

## Reproduction and verification

Raw artifacts are in
`bench/parsers/reports/local/2026-09-09-java-new-documents/` and the matching
isolated `/opt/capy-java-new-documents-20260909/` VM directory. They include source
PDFs, download receipts, page maps, rendered images, native JSON/Markdown, OCR
responses, current chunks, inventories, selected-page jobs and run receipts.
`evaluation.json` uses an empty anchor fixture solely to generate artifact and
chunk diagnostics. Its zero probes are not an accuracy result.

All 23 prepared PDF cases and all source/context image hashes were verified.
The corpus preparation check verifies exact page ordering, raster lineage and
rejection of changed source bytes, manifest changes during preparation and exact
non-default native-run provenance. The existing Java recovery and adapter checks
passed, as did the extended structured-packing check. `pnpm run fmt:py` passed;
explicit isolated Ruff checks cover these benchmark scripts, which the root
configuration excludes. No application-wide test run was needed for these
isolated benchmark-only changes.

Independent code review found two provenance gaps and an empty merged-cell origin
case in the new helpers. They were corrected and rechecked. A fresh closing
review also corrected the report's Java/OCR thread counts against the receipts.
Context selection
was rerun with explicit native-run receipts; selected pages and rendered-image
hashes were unchanged. The first selection's exact evaluation bytes are retained
in `native-selection-evaluation.json`, verified against the original receipt hash.

Both raw archives were verified member by member against their SHA-256 manifests:

| Archive under `reports/local/` | Files verified | Archive SHA-256 |
| --- | ---: | --- |
| `2026-09-09-java-new-documents.tar.gz` | 1,569 | `934f4a1728d33402c46c33fc4e731b4326a004cd3e6dcd585d5cce962f89d677` |
| `2026-09-09-beijing-ocr.tar.gz` | 73 | `21ed21adf1b8aa13e5ac09a334fb19c5397ab9ad107e50b9ec54efbf965803ea` |

The main archive retains both the script used by the original selection and the
corrected final script, each matching its corresponding receipt hash. Sources
and raw VM outputs remain available. The Java experiment container was removed;
the MinerU container used automatic removal after completion. No temporary
Beijing credential or running benchmark container remains.
