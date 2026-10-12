# Shipped parser v12 versus MinerU pipeline on unseen library books

Date: 2026-10-12. Benchmark only; no parser, index or bucket change.

## Finding

On 72 random pages from six library books that no earlier parser round had
seen, MinerU's pipeline backend is clearly ahead on **formulas** and
**figures**, a little ahead on **headings**, and level on **section paths**
and **prose**. The shipped parser is **20–250× faster** (MinerU on the M1 GPU: 52×; on CPU: 20× on prose, about 250× on formula-dense pages).

| Element (count) | Shipped v12 good / partial / bad | MinerU good / partial / bad | Score shipped → MinerU |
| --- | --- | --- | --- |
| Formulas (174) | 29 / 118 / 27 | 121 / 32 / 21 | 0.51 → 0.79 |
| Figures (32) | 10 / 11 / 11 | 27 / 5 / 0 | 0.48 → 0.92 |
| Headings (90) | 40 / 4 / 46 | 46 / 23 / 21 | 0.47 → 0.64 |
| Section path, per page (72) | 35 / 20 / 17 | 39 / 21 / 5, 7 without a path | 0.62 → 0.69 |
| Prose text, per page (72) | 41 / 31 / 0 | 43 / 28 / 1 | 0.78 → 0.79 |
| Tables (4) | 1 / 2 / 1 | 2 / 2 / 0 | too few to judge |
| False headings / false tables | 5 / 6 | 8 / 4 | |

Score: good = 1, partial = 0.5, bad or missing = 0.

The two parsers fail in different ways:

- **Shipped formulas are mostly "partial".** The digits are right, but
  fraction structure is flattened and the Symbol-font operators come out as
  private-use glyphs: `` for ×, `` for π. Matrices and display
  formulas are split into pieces out of order. In the waterworks book four
  calculation lines became headings, so every later chunk there carries a
  path like `Practice Problems 1.1b › 217,800.13 ft … = 16.5 ft`. The shipped
  parser scored 0/12 on section paths for that book.
- **MinerU's "bad" formulas are mostly silent misreads.** The LaTeX is
  structurally right but the characters are wrong: `1 SG` → `1 5G`,
  `lbs/gal` → `|bs/ga|`, `1 ppm` → `100 m`, `7.48` → `7.488`. 16 of its 21
  bad formulas are on the waterworks pages. For a study app a confident wrong
  digit is worse than a flattened fraction.
- **Shipped figures fail on vector diagrams.** ODL emits no figure block
  for drawn diagrams; it dumps their labels into the prose. The Industrial
  Instrumentation diagrams scored 0/11, against 11/11 for MinerU. Raster
  figures were good in both parsers.
- **Headings and section paths depend on the book.** The shipped parser wins
  where running headers are the risk: Industrial Instrumentation 1.00 vs 0.54,
  Crystal Ball 0.96 vs 0.58. MinerU promotes running headers such as `12.3.
  COPYING SERIESES` to headings. The shipped parser loses on the waterworks
  book (formula lines as headings) and on Marine Ecology (missed numbered
  headings, so chapter 2 is filed under 1.4). Neither parser recognises
  italic run-in headings or the legal book's `§ X Examples` labels.

## Speed (Apple M1, 8 GB)

| Book | Pages | Shipped, whole book | Shipped, 12-page window | MinerU, window, MPS | MinerU, window, CPU ×4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Industrial Instrumentation | 3,311 | 282.7 s (3 GB heap) | 1.2 s | 64.3 s | |
| MATLAB computation | 157 | 7.9 s | 1.7 s | 112.4 s | |
| Waterworks mathematics | 384 | 15.7 s | 1.0 s | 99.2 s | 265.1 s |
| Marine ecology (11 OCR pages) | 192 | 24.5 s | 4.4 s | 130.3 s | |
| Crystal Ball data science | 314 | 26.4 s | 2.1 s | 139.4 s | |
| Legal citation | 277 | 16.3 s | 1.4 s | 84.8 s | 28.2 s |

Per page, the shipped parser takes about 0.17 s on the windows and
0.04–0.13 s on whole books. MinerU takes 8.8 s per page on the M1 GPU (MPS),
and on CPU 22 s per page for the formula-dense window and 2.4 s per page for
prose. The CPU runs shared the machine with the review agents, so treat them
as upper bounds. The production ingest host has no GPU.

Side finding: with the deployed default `CAPY_PARSER_JVM_MAX_HEAP=1g`, the Java
stage fails on the 3,311-page, 103 MB book ("Parallel page processing
failed"). It completes with 3 GB, at a peak RSS of 2.7 GB.

## Method

- **Sample.** Seeded (20261012) stratified draw from `lab/knowledge/books.json`:
  three math-heavy books, two table/figure books and one prose book. The pool
  excludes every book named anywhere in `bench/parsers` and keeps only books
  with at least 60 pages and under 120 MB. Each book contributes one random
  contiguous 12-page window. Sources come from the library bucket (`books/<sha256>.pdf`),
  checked against their SHA-256. Manifest: `fixtures/v12-mineru-sample-2026-10-12.json`.
- **Shipped arm.** `parser/odl/refine.parse_pdf`, i.e. `odl-2.5.7-refined-rapidocr-v12`,
  with the pinned RapidOCR models. It parses each **whole book**, so outline,
  running-head and furniture context are intact; only the window's pages are
  graded. The window-only parse is used for timing.
- **MinerU arm.** `mineru[pipeline]==3.4.5`, the last 3.x release and the same
  version as the 09-16 report. It runs `backend="pipeline"`, `parse_method="auto"`,
  formulas and tables on, PDF-Extract-Kit snapshot `ed6b654c`, on the
  12-page window. MinerU 4.x (4.0.12) replaced this API with a
  library/server and parse tiers, so it is not tested here.
- **Section paths.** Both content lists go through the shipped chunker v12
  (`pack_blocks` + `retain_headings`). The chunker drops MinerU's `code`
  blocks. That affects only the chunk list; element grades use raw blocks.
- **Review.** Six reviewers (Opus 5.5 subagents, one per book). They first
  read each page image, listing the formulas, tables, figures and headings,
  then graded parsers A and B against `fixtures/v12-mineru-review-rubric.md`.
  A and B were shuffled per page, and reviewers had no access to the key or
  the raw outputs. One spot check against raw output confirmed the MinerU
  `1 5G` misread.

Limits:

- This is a model review with one reviewer per page, not human ground truth.
- 106 of the 174 formulas come from one book (waterworks).
- Tables (4) are too few to judge.
- The sample has no scanned books.
- The shipped parser's whole-book context is an advantage MinerU's window
  run does not get. It is how the product runs, but it is not symmetric.

## Can a parser built on ODL close the gap and keep the speed?

The gaps split into three kinds. Most of them can be fixed without running
models on every page.

1. **Native fixes, near-zero cost.** These are failures of the text layer
   and our rules, not of missing vision:
   - Map Symbol/MT Extra private-use code points to Unicode (× π √ ≤ …).
   - Never promote a line that is mostly digits, operators and units to a heading.
   - Cluster vector drawings into figure regions and render their crops.
     PyMuPDF already exposes `get_drawings`, and figure crops already exist
     for raster images.
   - Rebuild simple stacked fractions from glyph geometry plus the drawn
     fraction bar.

   These address the worst shipped failures seen here: the waterworks paths
   and formulas and the Industrial Instrumentation figures. They do not need
   a fork of ODL's Java core.
2. **Targeted models.** Formula recognition (PP-FormulaNet+, Apache-2.0,
   the model MinerU uses) would run only on detected formula crops, not on
   every page. Its output should be accepted only if its digits and letters
   match the native text layer. This is where an ODL-based parser can beat
   MinerU: the shipped parser kept every digit right while MinerU misread
   them. Cost grows with the number of formulas, not pages: MinerU's
   recognizer averaged about 0.44 s per formula on MPS (432 formulas). CPU
   cost per crop with ONNX was not measured.
3. **Page selection is the unsolved part.** Running the layout model
   PP-DocLayoutV3 (already shipped for OCR ordering) on every page costs
   1.42 s per page on CPU, 15–20× the shipped parser's whole per-page cost.
   A naive native trigger (math fonts, private-use glyphs, math symbols)
   fires on 39% of Industrial Instrumentation's pages and 40% of the legal
   book's, where Symbol and Wingdings bullets set it off. So a selective
   design needs a trigger with much better precision. Without one it
   degrades towards MinerU's per-page cost on math-heavy books.

Licences allow it: ODL is Apache-2.0. MinerU 3.4.5 is Apache-2.0 with an
attribution term and a separate licence above 100 M monthly users or
US$20 M monthly revenue. The PaddleOCR-family models are Apache-2.0.

## Reproduction

Scripts in `bench/parsers/scripts/`: `v12_mineru_fetch.py` (bucket download),
`v12_mineru_run_odl.py <out> book|window`, `v12_mineru_run_mineru.py <out> <tag>`
(needs `MINERU_MODEL_SOURCE=local`, `MINERU_DEVICE_MODE`, `HF_HOME`),
`v12_mineru_packets.py <out>` (repo `.venv`), `v12_mineru_aggregate.py <out>`.
Raw outputs, page renders, blinded packets, the blind key, review JSON,
`summary.json`, `layout_probe.json` and `trigger_probe.json` are in the ignored
`reports/local/2026-10-12-mineru-v12/`.
