# MinerU pipeline versus current ODL on textbook failures

## Finding

Fresh local MinerU pipeline runs recover useful mathematical structure that the
current ODL parser loses. This supports testing MinerU as a source of candidate
formula repairs. It does not support replacing the shared parser wholesale:
table structure, reading order, source fidelity and downstream confidence still
fail in inspected examples. These findings apply to ordinary uploaded PDFs as
well as the proposed knowledge library.

The warm pass took **17.75 seconds for ODL versus 353.88 seconds for MinerU** on
28 pages: about **19.9 times longer**. No production parser change, model API
call, database write or generated image caption is part of this experiment.

## Protocol

- PC: Ryzen 7 3700X, 32 GB host RAM, Windows with Docker/WSL2. Both engines ran
  sequentially in the same container with a **4 CPU / 10 GiB** limit. The installed
  GPU was not used. This is not a Netcup production latency measurement.
- Baseline: `opendataloader-pdf==2.5.7` with this checkout's `odl.refine.parse_pdf`;
  repository base `b79795b4d4c973f6792405123d7c50d2987c5581`.
- Candidate: `mineru[pipeline]==3.4.5`, explicit `backend="pipeline"`,
  `parse_method="auto"`, formulas and tables enabled, CPU Torch `2.8.0+cpu` and
  torchvision `0.23.0`. This is not MinerU's hybrid or remote VLM backend.
- Independent Python environments preserve ODL dependencies. An initial import
  failed on undeclared dependency `six`; installing pinned `six==1.17.0` resolved
  it before any candidate page completed. The Dockerfile includes that fix.
- Models were downloaded before inference, then model/network lookup was put in
  local/offline mode. PDF-Extract-Kit snapshot:
  `ed6b654c018d742e65a17671e379c5e6ecc87ec9`. Downloads and image construction are
  excluded from parse latency; package freezes and image ID are retained.
- The source fixture and checks were frozen before fresh parser output was read.
  SHA-256 checks bind every original and derived PDF. Two sequential passes per
  engine use byte-identical inputs, language settings and resource limits.
- These are **28 selected diagnostic pages**, not a random accuracy sample or
  an independent new-document holdout. Original page numbers are recorded in the
  fixture. Slicing removes the PDF structure tree and full-book recurrence and
  heading context. In particular, the nine-page OS4 slice retains the standalone
  square root that the full-book furniture filter deletes. Do not transfer slice
  heading levels or furniture counts to whole books.
- Final-output inspection runs current `pack_blocks`, `retain_headings` and
  `score_chunks` on each saved content list. ODL supplies its frozen furniture
  keys. MinerU supplies no such keys, so its native block roles are retained with
  an empty key set. This is a compatibility diagnostic, not a production adapter;
  MinerU tables lack the ODL header-support metadata. The current generic HTML
  packing path can lose spans and header context. Raw and packed failures are
  distinguished below.
- Timers measure parser-API wall time. MinerU includes the requested native JSON,
  Markdown and image output writes; ODL's additional benchmark content-list copy
  is written after its timer. Both exclude input-byte reads, imports and the later
  packing/source-review pass. This is not full ingest latency.

## Quality: source-checked observations

Formula passes require the literal values, variables, operators, numerator /
denominator and square-root scope. Insignificant TeX math whitespace is accepted;
the output is not character-identical typesetting. A formula pass does not certify
the surrounding worked example's reading order.

| Frozen check | Current ODL | MinerU pipeline |
| --- | --- | --- |
| OS4 p54: `s = sqrt(25.52) = 5.05` | Pass in this slice, split across three raw blocks; the full-book deletion is a separate reproduced defect. | Pass, explicit LaTeX root. |
| OS4 p193: population-proportion standard error | Fail: no root scope or fraction structure. | Pass, both roots and fractions plus `0.010`. |
| OS4 p431: `p-hat = 27/212 = 0.127` | Fail: `21227`. | Pass: numerator 27, denominator 212. |
| OS4 p431: estimated standard error | Fail: flattened/interleaved denominator and missing roots. | Pass, roots and fractions plus `0.023`. |
| AHSS p134: Bayes worked-example formula | Fail: numerator and denominator are separate unstructured text blocks in the wrong order. | Pass, conditional expression and all three numeric denominator terms. |
| AHSS p461: source's `0.0431` / `0.431(1000)` inconsistency | Preserves both literals. | Preserves both literals; does not silently correct the printed arithmetic. |
| jamovi p369, Table 14.9 | Four expressions survive as flattened text, with the body misclassified as a heading; no faithful table structure. | Four expressions correctly associated with the two no/yes rows and columns in raw and packed output. HTML is imperfect: `read textbook` spans the blank row-label column too, and `attended? no` is one cell. Useful recovery, not exact cell topology. |
| BERT p6, Table 1 | All 5 numeric rows, task/count headers, caption/metric notes and bold winning values survive in one table chunk. | All 5 numeric rows and task/count/caption context survive. Loses the source dash under Average and the winning-value bold emphasis. No improvement over current ODL on this table. |
| Japanese p49 continuation headers | Header text survives, but the source table is still not a trustworthy reconstructed grid. | Failure already in raw HTML: 10-column parent row above an 11-cell next row; count/percentage and sex scopes split incorrectly, multiple source rows merged into cells. |
| Japanese p51 continuation headers | Header text survives; this is not a claim of correct body-cell associations. | Raw headers have inaccurate spans and mixed groups; packed HTML flattens them further. Missing-value dot leaders are also discarded. |
| OS4 p198 figure labels as headings | Fail: `n = 50 n = 100 n = 250` becomes section ancestry. | Pass on the selected role check: chart plus original caption, no label ancestor. |
| AHSS p134 tree labels as headings | Fail: `Event Garage full` becomes section ancestry. | Pass: image plus surrounding example text, no label ancestor. |
| jamovi p369 table body as heading | Fail: `attended? ...` becomes section ancestry. | Pass: table block, no table-cell ancestor. |
| NIST pp4–5 qualitative scan control | Hidden OCR-layer noise and incorrect symbols remain. The current parser did not route these pages through its own OCR. | Better mass subscripts and readable prose in places; still introduces/retains incorrect characters and numbers. No whole-page accuracy score assigned. |

The five selected formulas are **1/5 versus 5/5**, and the three selected
diagram/table role checks are **0/3 versus 3/3**, in the inspected raw and packed
outputs. These denominators describe known diagnostic cases, not overall parser
accuracy. There is no combined score that treats a retained number as equivalent
to a correct table or a coherent exercise.

The diagram-role gains do not imply text conservation inside images: MinerU's
AHSS tree labels survive in the image, but are not transcribed in its content
list. The surrounding worked example remains. ODL's role-correction experiment
instead preserves the literal label text while removing its heading status.

### Failures outside the narrow formula checks

- **Answer order remains wrong.** In OS4 p431 MinerU starts answer 5.3, inserts
  the continuation of 4.41 and answers 4.43–4.47, then resumes 5.3's standard
  error. The correct formulas survive, but the resulting exercise is incoherent.
  This error is present before packing and persists in chunks 20–23 of pass 1.
- **Exact digits can regress.** The NIST p4 source and ODL both say `0.030-in.`
  in Figure 3's caption. MinerU says `0.630-in.`. The original caption crop is
  retained. Conversely, MinerU improves some other NIST symbols; it is not an
  independent ground truth.
- **Heading hierarchy remains limited.** Passing the three false-role checks
  does not prove the complete hierarchy. MinerU still promotes the running
  `5.3. LEAST SQUARES REGRESSION` banner on AHSS p461 and treats many headings
  at the same level. Other running headers enter packed body text.
- **LaTeX normalization needs care.** The math recognizer emits spaced tokens
  such as `2 5 . 5 2`. These are valid within TeX math, but current chunk cleaning
  leaves many spaces; plain-text retrieval and confidence differ from native
  `25.52`. No embedding or retrieval quality measurement was run here.

### Confidence does not become an accuracy oracle

Current ODL's malformed OS4 answer-key chunk scores **0.946 without reasons**;
the three false-role witnesses have chunks scoring **1.00 without reasons**.
Under the same existing heuristic, MinerU's broken Japanese p49 chunks score
**0.921 and 1.00 without reasons**, while the correctly recovered Bayes formula
appears in chunks scored **0.677 / 0.582** because LaTeX disagrees with native
text-layer tokens. The wrong NIST caption digit is in a **0.864** chunk without
reasons. These are pass-1 MinerU / pass-2 ODL diagnostic values.

The current `ocr_pages` helper recognizes only the parser's `rapidocr-line`
marker. It does not assign the fixed 0.5 OCR score to MinerU's model-derived
output. MinerU scores here therefore test an uncalibrated compatibility path;
they are not a comparison of the engines' own confidence or OCR accuracy.

Review routing needs explicit structural evidence and a high-score audit sample
as well as low scores. Comparing two parsers is useful disagreement evidence;
neither confidence nor agreement guarantees correctness.

## Timing

Both engines completed all eight cases in both passes: **56 page executions per
engine**. Every case's content-list bytes were identical across its two passes;
the quality findings therefore hold on both runs. This is repeatability on fixed
inputs, not independent quality validation.

| Case | Pages | ODL pass 2, seconds | MinerU pass 2, seconds | MinerU / ODL |
| --- | ---: | ---: | ---: | ---: |
| OS4 math | 9 | 3.461 | 155.148 | 44.8× |
| OS4 figure | 3 | 1.760 | 18.342 | 10.4× |
| AHSS tree / Bayes | 3 | 1.762 | 26.748 | 15.2× |
| AHSS regression | 3 | 1.862 | 24.735 | 13.3× |
| jamovi table | 3 | 1.758 | 41.447 | 23.6× |
| BERT tables | 2 | 2.009 | 31.982 | 15.9× |
| Japanese tables | 3 | 2.277 | 28.653 | 12.6× |
| NIST scan with OCR layer | 2 | 2.864 | 26.824 | 9.4× |
| **Total** | **28** | **17.753** | **353.879** | **19.9×** |

Pass 1 totals were **18.245s / 369.672s**. The first OS4 math call was **3.807s /
166.828s** and includes each engine's first-call setup. Import time, reported
separately, was **0.497s / 3.238s**. MinerU's logged initial model construction
was about 3.2s; formula inference on the nine math pages was the dominant cost.
ODL launches its normal Java work per document on both passes. No models are
downloaded inside these timed parse calls.

The benchmark container's cumulative cgroup peak was **4.55 GiB**, including
page cache and setup/model activity. Before MinerU inference that cumulative
peak was **0.94 GiB**. These are not separate per-engine peak RSS measurements.
The run fits this PC under its 10 GiB container allowance, without using the GPU.
Models and native artifacts remain available locally; the benchmark container
was stopped after collecting receipts.

Do not extrapolate this selected, formula-heavy page mix directly to a 500-page
book or production concurrency. GPU latency, selective page/crop recovery,
end-to-end ingest latency and retrieval quality were not measured.

## Recommendation for the shared parsing pipeline

1. Advance the small ODL occurrence/heading repairs from the separate
   [recovery experiment](2026-09-16-odl-textbook-recovery.md), with fresh parser
   integration checks before changing production behavior. These address common
   extraction losses without paying full-page model inference on every upload.
2. Keep native/source-exact text as the primary record. Trial MinerU output as
   candidate formula recovery on flagged pages or regions, preserving the source
   crop, original result and repair provenance. This run did not measure a
   selective-repair implementation or its latency.
3. Source-check numbers, root/fraction scope, table spans and example boundaries
   before accepting a repair. A future visual Batch review can help adjudicate
   candidates, but has not been validated by this offline MinerU experiment.
4. Do not replace complete tables, diagrams or pages solely because the candidate
   looks more structured. Japanese grids and NIST's incorrect digit demonstrate
   why that acceptance rule would fail.

## Reproduction and receipts

- Fixture: `bench/parsers/fixtures/mineru-pipeline-textbook-comparison.json`.
- Runtime: `bench/parsers/scripts/Dockerfile.mineru-pipeline-local`.
- Parse runner: `bench/parsers/scripts/compare_mineru_pipeline_local.py`.
- Packed-output review: `bench/parsers/scripts/review_mineru_pipeline_local.py`.
- Ignored raw root: `bench/parsers/reports/local/2026-09-16-mineru-pipeline/`.
- Successful parse directories: `runs/odl-cpu4-r2/`, `runs/mineru-cpu4-r2/`.
- Receipts include per-case timings, versions, source/runner hashes, content
  lists, native MinerU middle/model JSON, original page renders and packed chunks.
  Initial cross-platform input-path and missing-dependency failures are preserved
  separately; neither is included as completed inference.
- `verification.json` records complete case counts, timing totals and byte-equal
  repeat hashes; `review/summary.json` and per-case `source-review.md` retain the
  final current-code compatibility outputs. Both new Python scripts pass focused
  Ruff checks and were independently reviewed by the Astra recovery subagent.
- Source review is performed by Codex against original PDF renders and the frozen
  source rubric. Independent human validation remains outstanding.
