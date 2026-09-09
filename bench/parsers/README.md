# Parser benchmarks

This directory contains the reproducible checks for the dedicated ingest host.
The production decision records are:

- [`netcup-2026-08-28.md`](reports/2026-08-28-parser-accuracy.md): superseded. The
  accuracy and capacity decision taken on the parser stack that preceded MinerU,
  kept for the reasoning; its modes and tooling no longer exist.
- [`netcup-2026-08-31-stress.md`](reports/2026-08-31-worker-stress.md): current MinerU
  capacity, OOM, process-pool, timeout, health, and restart behavior.
- [`reports/2026-08-31-capy-ingest-1-netcup-rs-2000-g12/`](reports/2026-08-31-capy-ingest-1-netcup-rs-2000-g12/):
  versionable raw results, machine specifications, artifact inventory, and
  supplemental measurements for the August 31 run.

## Office fixtures

`build_office_fixtures.py` creates deterministic DOCX, PPTX, and XLSX canaries
whose marker strings must survive Office conversion and parsing.

The August 28 accuracy harness belonged to the previous parser stack. The
September 8 OpenDataLoader comparison instead freezes source PDFs and evaluates
native parser outputs plus Capy's actual chunker and figure selector.

## OpenDataLoader comparison

The [September 8 comparison report](reports/2026-09-08-opendataloader-vs-mineru.md)
records the corpus, configuration results, artifact defects and recommendation.

`Dockerfile.opendataloader` adds pinned candidate packages to the retained
MinerU benchmark image. `prepare_opendataloader_corpus.py` freezes the VM inputs,
normalizes Office files once, records hashes and page mappings, and makes
matched raster controls. Keep the original inputs alongside `corpus.json`.

On the idle benchmark host, use an isolated experiment directory containing
`scripts/`, `inputs/`, and a copy of the retained MinerU model cache at
`models/mineru/`. The September 8 experiment uses these container settings:

```sh
experiment=/opt/capy-parser-eval-20260908
docker build -f "$experiment/scripts/Dockerfile.opendataloader" \
  -t capy-opendataloader-eval:20260908 "$experiment/scripts"
docker run -d --name capy-mineru-eval --network none --user 0 \
  --cpus 8 --memory 14g --memory-swap 28g \
  -v "$experiment:/eval" -v "$experiment/models/mineru:/models" \
  -e PYTHONPATH=/eval/scripts -e MINERU_API_OUTPUT_ROOT=/eval/mineru-temp \
  -e OPENBLAS_NUM_THREADS=2 capy-parser-stress:current sleep infinity
docker run -d --name capy-odl-eval --cpus 8 --memory 14g --memory-swap 28g \
  -v "$experiment:/eval" -e PYTHONPATH=/eval/scripts \
  capy-opendataloader-eval:20260908
docker exec capy-odl-eval docling-tools models download \
  layout tableformer code_formula rapidocr easyocr --output-dir /eval/models/docling
```

The candidate needs network access for model downloads. Its hybrid servers bind
to container loopback; neither container publishes a port. Record package freezes
and image digests because the retained base-image tag is mutable. These resource
limits describe the experiment, not a proposed deployment configuration.

`compare_opendataloader.py` runs one configuration in an isolated CPU container.
Each run requires a new output name. MinerU shares loaded models across thread
lanes, matching Capy's parser; the first model load is serialized.
`run_opendataloader_matrix.sh` runs configurations sequentially and prepares
language-specific OCR models outside timed conversions. Whole tagged originals
are used for the structure-tree check because page slicing discards that tree.
`bench_opendataloader_capacity.py` measures repeated warm 1/4-document bursts.
`prepare_opendataloader_capacity.py` copies the retained 26-page digital and OCR
stress fixtures into the experiment. `run_opendataloader_scale.sh` runs the
full/long comparisons and capacity tests sequentially, resetting only the two
benchmark containers between configurations. Full/long runs omit warmup;
their timings include lazy model loading but exclude hybrid server readiness.
Capacity is direct parser work, without HTTP, deduplication, or ingest queueing.
The hybrid server serializes conversions. `--hybrid-workers 4` in the capacity
harness starts four independent local backends; the default tests one shared
backend. The comparison runner supports `--odl-slice-pages 26 --slice-workers 4
--hybrid-workers 4` for the separate bounded long-document comparison. Its
offline check verifies page offsets and image paths across a slice boundary.

```sh
# Inside the matching benchmark container, with the experiment mounted at /eval:
python /eval/scripts/compare_opendataloader.py /eval \
  --config odl-full-rapid-autoocr --suite screen --run screen-odl-full-rapid-autoocr

# At the repository root, after copying the experiment's results and references:
uv run --with 'pypdf[crypto]==6.18.0' python bench/parsers/scripts/check_opendataloader_adapter.py
uv run python bench/parsers/scripts/evaluate_opendataloader.py \
  bench/parsers/reports/local/2026-09-08-opendataloader
```

The evaluator uses `fixtures/opendataloader-checks.json` for source-page text,
structured table rows and reading-order probes. It rebuilds the experimental
adapter from saved OpenDataLoader JSON so adapter fixes do not require parser
reruns. It records the adapter, chunker, figure-selector and fixture hashes.
Character coverage against embedded PDF text is a separate diagnostic, not an
accuracy score. These checks do not run embeddings, caption models or retrieval.
Capacity content checks are saved separately in `capacity-quality.json` and do
not enter the corpus accuracy tables. They reuse verified textbook rows on
page 11 and newspaper checks on pages 1 and 25 of the repeated 26-page scan to
check that successful timed requests retain source content.

`probe_opendataloader_images.py` checks embedded output on the eight-page
biology sample after external-image filename collisions were found. It saves
native JSON/Markdown and decoded images with SHA-256 identities. Use
`--inspect-only` to decode existing output without starting a parser. This
artifact-integrity probe is separate from the timed corpus and capacity runs.

## Java with selective recovery

The [Java recovery plan](reports/2026-09-08-java-recovery-plan.md) extends the
frozen September 8 corpus with header/footer controls, direct RapidOCR and
image-only caption experiments. Production remains unchanged.
The [completed recovery report](reports/2026-09-08-java-recovery.md) covers
the repeated combined trials, source/chunk quality review and caption receipts.
The [Qwen follow-up](reports/2026-09-08-qwen-java-recovery.md) compares Alibaba
Qwen3.8 Flash with the earlier GLM captions, thinking controls, full-page context
and a literal transcription prompt. It also compares both models on eight
additional pages and measures one intact-corpus execution with page captions.

`inspect_java_recovery.py` records source text coverage, scan images, drawing
clusters and Java table boxes. Its selection rules are benchmark heuristics.
Inventory requires a complete native run and fails explicitly on missing output;
the saved-output evaluator counts failed or absent native results as unavailable.
`bench_java_recovery.py` prepares page/crop jobs and records direct OCR or
caption requests, including failures and provider cost receipts. Caption runs
require an explicit prompt file, resolution, concurrency and request limit;
the credential is read locally and never included in artifacts. The
optional `--provider-config` supplies `endpoint`, `key_env` and non-streaming
request `body` fields. The response model must match the requested model.
The `context-pages` command selects pages containing a captionable image,
flagged vector drawing, native table or source-text gap. An inventory prepared
with `--structure` adds source table-layout and duplicate-glyph signals.
`--repaired-encoding` skips encoding-only caption calls; `--ocr-run` inspects saved
scan OCR for wide nearly empty lines, numeric columns and two-column prose.
These are benchmark routing heuristics, not a calibrated accuracy classifier.
Each selected original page is rendered once. Exact-image aliases retain all
page placements.
The `layout-ocr` experiment uses temporary text-only PDFs and does not reconstruct
original fonts or vertical writing. It must not be mistaken for a lossless OCR
layer.

`measure_selective_java.py` measures Java extraction, source inspection,
selective OCR and physical image deduplication together. Each trial needs a
fresh name. `evaluate_java_recovery.py` applies saved responses according to
an explicit variant JSON file, deduplicates image bytes while retaining every
placement, and uses the existing evaluator and Capy chunker. Caption prose
does not count as structured HTML table rows. The separate
`fixtures/java-recovery-checks.json` contains questions for separate source and
chunk review. The executable `--checks` input uses `opendataloader-checks.json`.
Neither set estimates general accuracy. Per-case recovery records separate
native timing from unmeasured combined timing; use the selective trial's
`complete.json` for the measured combined extraction time and memory.
`measure_java_page_context.py` adds fresh full-page rendering and provider calls
after Java/OCR. It deliberately accepts a frozen source-bound page plan, so its
wall time measures execution and does not establish routing generalization.
`fixtures/qwen-page-recovery-checks.json` contains sixteen source questions
frozen before the additional-page caption calls. These supplement the earlier
checks; passing them does not establish complete page transcription.

The [structural recovery follow-up](reports/2026-09-09-structural-recovery.md)
tests typed Qwen3.8 Flash page records and deterministic packing.
`structured_recovery.py` validates typed text/table/figure responses, composes
explicit table header spans, repeats headers across row groups and packs figure
paragraphs with their supplied titles. It also repairs only source-confirmed
zero-width duplicate glyphs and can remove exact recovered/native paragraph
duplicates on the same page. These helpers are benchmark-only.
`evaluate_java_recovery.py --chunking structured --figure-tokens 400` uses the
candidate packing; `--figure-tokens 800` tests a larger figure allowance. Normal
prose still uses the production chunker. Whole-page recovery has whole-page
citations and does not inherit the last unrelated native section heading.
Malformed records are counted and excluded, with the raw response retained.
An explicit variant chooses encoding repair, typed recovery and deduplication.
Saved responses must match the exact `run.json` hash, which includes the prompt,
model and request options. Historical responses require an explicit `binding`
file with that run hash and every selected response hash. Such a retrospective
binding pins the archived bytes; it does not add missing historical provenance.
Native images come from the selected native output unless the variant supplies
an explicit `image_root`. OCR routing can use `--ocr-image-root` for copied VM
artifacts and `--ocr-binding` for pinned historical receipts. All scan images on
a page are inspected, and duplicate request IDs are rejected before requests.
No production chunker version, parser routing or model setting is changed.

```sh
uv run python bench/parsers/scripts/check_java_recovery.py
uv run python bench/parsers/scripts/check_structured_recovery.py

# Inside the isolated recovery container; /baseline is the earlier read-only run.
python /eval/scripts/inspect_java_recovery.py /baseline /eval/inventory-headers \
  --java-root /eval --java-config odl-java-headers --suites screen full long
python /eval/scripts/measure_selective_java.py /baseline /eval \
  --trial fresh-full-run --suite full --threads 8 --max-edge 2560 \
  --models /baseline/models/docling/RapidOcr
```

## MinerU native geometry experiments

The [native geometry experiment](reports/2026-09-09-mineru-native-geometry.md)
follows the [plan](reports/2026-09-09-mineru-native-plan.md) and tests skipping
OCR detection for reliable source-text regions and skipping page models for
simple native prose. These are version-bound benchmark hooks for MinerU 3.4.5,
not production parser changes. `Dockerfile.mineru-native` adds PyMuPDF 1.28.2 to
the retained parser image. `run_mineru_native.py` reuses the comparison and
capacity runners, freezes the executed sources and records bypass/fallback
counters. Run each variant in a fresh isolated container, sequentially on the
shared host, using a new run name.

```sh
# Inside the isolated experiment container with its corpus and retained models.
python /eval/scripts/run_mineru_native.py /eval \
  --variant native-text --suite screen --run screen-native-text-v5 --timeout 600

# Local model-free page guard/boundary check and saved-output evaluation.
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/check_mineru_native_page.py
uv run python bench/parsers/scripts/evaluate_opendataloader.py \
  bench/parsers/reports/local/2026-09-09-mineru-native
```

`check_mineru_native_text.py` additionally needs the inspected MinerU 3.4.5 source
on `PYTHONPATH`, with PDFium, pdftext, OpenCV and loguru installed. It exercises
native-region checks without loading model weights. The VM image already has
these dependencies. The variants are `baseline`, `native-text`, `native-page`
and `combined`; `--capacity` selects repeated warm document bursts. Counters are
cumulative per process, so per-call counter intervals overlap during bursts.
The region check includes upstream text-fill replay and preserved native line
breaks. The page check covers both digital PDFium filling and inspected native
text in OCR mode; source eligibility alone does not prove a page bypassed models.

The report rejects page v5 after a cross-page citation regression. Region v5 is
the final measured candidate, but its intact gain is small and consistent source
spacing makes the current chunker discard three active agenda entries. Its long
run is slower and loses a citation region and an answer-mark value. Neither
variant is promoted to production. `replay_java_page_cache.py` applies a prior
page-response cache to fresh native content lists only when the source and target
PDF/image hashes and original request/response bindings verify. It records
rejected matches and uncaptioned selected pages. This is an offline quality
comparison; it does not measure provider latency.

```sh
uv run python bench/parsers/scripts/replay_java_page_cache.py \
  bench/parsers/reports/local/2026-09-09-mineru-native \
  bench/parsers/reports/local/2026-09-09-mineru-native/replay/java-full-native-structured/fresh-java-ocr-encoding \
  bench/parsers/reports/local/2026-09-09-mineru-native/java-full-r1/context-full/jobs.json \
  bench/parsers/reports/local/2026-09-09-structural-recovery/evaluation-full-verified/cache-reuse.json \
  bench/parsers/reports/local/2026-09-09-mineru-native/replay/java-full-fresh-cache \
  --checks bench/parsers/fixtures/opendataloader-checks.json
```

Use a new output path for each replay. For the matched MinerU control, pass its
completed `results/<run>` directory as the native input instead.

## Native OpenDataLoader accuracy follow-up

The [September 9 accuracy follow-up](reports/2026-09-09-odl-accuracy-followup.md)
tests font-map repair, source-confirmed column continuations, native table
context and literal table-cell background annotations. All are benchmark-only.
They reuse the eight-document corpus and retain failed variants and source
checks. No Qwen request or production change is involved.

`experiment_odl_font_recovery.py` audits embedded Type1 encodings and compares
removing or rebuilding a contradictory Unicode map in temporary PDF copies.
It reruns Java and verifies rendered-pixel identity. `experiment_odl_reading_order.py`
reorders eligible native prose, moves a source-confirmed vertical heading and
splits a continuation sentence while retaining the original citation boxes.
`experiment_odl_native_tables.py` compares production, strict structured and
explicit bounded packing; the bounded arm keeps unsupported native tables on
ordinary packing and records every rejection. `experiment_odl_source_styles.py`
matches opaque yellow rectangles to exact native cell text and geometry.

```sh
uv run --with 'pypdf[crypto]==6.18.0' python bench/parsers/scripts/experiment_odl_font_recovery.py check
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/experiment_odl_reading_order.py --self-check
uv run python bench/parsers/scripts/experiment_odl_native_tables.py --check
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/experiment_odl_source_styles.py --check
```

`replay_odl_accuracy.py` composes explicit completed native experiment directories
and applies bounded table packing. It rejects baseline mismatches and overlapping
font/style and reading-order edits. The result is an offline interaction check,
not a measured combined parser execution. Use fresh output directories and the
exact source/runtime snapshots recorded with each run. The scripts' `--help`
lists required paths; on Windows, use Python `-X utf8` when replaying older scripts
that read source text using the platform encoding.

## Native OpenDataLoader second pass

The [second-pass report](reports/2026-09-09-odl-accuracy-second-pass.md) extends
the native experiments with source-backed heading context, hidden OCR-layer
reading order, fresh integrated timings and a
[neighboring-paper font transfer](reports/2026-09-09-odl-font-transfer.md).
These remain manual benchmark experiments; production parsing is unchanged.

The continuing evaluation adds source-confirmed
[native text repairs](reports/2026-09-09-odl-native-text-experiment.md),
[scientific exponents](reports/2026-09-09-odl-exponent-recovery.md), selective
[formula recovery](reports/2026-09-09-odl-math-recovery-experiment.md), and full-source
table integration audits. Failed table candidates are preserved and excluded
from the selected pipeline. Independent source identities and source-rendered
checks are in `fixtures/odl-independent-sources.json` and
`fixtures/odl-independent-checks.json`. The row/prose diagnostic
`score_odl_independent.py --check` is offline; its run scorer requires completed
content lists and actual chunks, and does not certify complete table meaning.

The [third-pass report](reports/2026-09-09-odl-accuracy-third-pass.md) compares
the composed native candidate with a fresh full MinerU run on 335 pages, with
430 additional regression pages. Its [table comparison](reports/2026-09-09-odl-mineru-table-comparison.md)
separates selected development tables from the independent source rubric.
`refine_odl_output.py --sources MANIFEST --output NEW_DIR --arm tables` replays
the native repairs before one final chunk pass. It binds Java JSON to the
parsed PDF, repairs list descendant geometry before glyph proofs, restores
source scientific exponents and column continuations, integrates fully covered
source tables, and retains omitted source text after chunking.
`measure_odl_native_pipeline.py ROOT NEW_DIR --variant refined` runs this path
with fresh parsing. `--table-method default` and `--exclude-header-footer` are
explicit configuration experiments; existing argument defaults remain unchanged.
`score_odl_refined.py --local bench/parsers/reports/local --runs RUN_DIR... --output NEW.json`
applies the frozen literal/context rubrics to final chunks from either parser.
These scores do not certify general parser accuracy or complete table meaning.
The selected final arm keeps cluster detection and header/footer inclusion,
propagating explicit footer ancestry only. The global exclusion control loses
real Japanese table headers and is rejected. `refine_odl_output.py --check`
verifies footer/header separation, unique identity and unchanged raw fields.

The focused `--check` modes in `experiment_odl_list_text.py`,
`experiment_odl_list_geometry.py`, `experiment_odl_column_continuation.py`,
`experiment_odl_heading_retention.py` and `experiment_odl_exponents.py` exercise
their guards without VM or provider calls. Source selection, all accepted edits,
rejected candidates and actual chunk citations are retained in the dated raw
directories referenced by each report.

[`experiment_odl_heading_context.py`](scripts/experiment_odl_heading_context.py)
compares saved-output heading treatments against frozen source checks. Its
selected `structure` arm uses source fonts, orientation and repeated furniture
to repair section paths while retaining content and citation boxes. It preserves
continuing sections across pages. See the
[heading-context report](reports/2026-09-09-odl-heading-context-experiment.md).

[`experiment_odl_ocr_disagreement.py`](scripts/experiment_odl_ocr_disagreement.py)
has `prepare`, `ocr`, `replay` and `check` modes. The selected helper reorders
existing native blocks only on source-confirmed hidden OCR-layer pages with a
supported column gutter. New OCR text replacement was rejected because even
high-confidence replacements introduced errors. The
[OCR-disagreement report](reports/2026-09-09-odl-ocr-disagreement-experiment.md)
retains the rejected variants, source checks and timing scopes.

[`experiment_odl_table_geometry.py`](scripts/experiment_odl_table_geometry.py)
extracts bounded ruled-table candidates from source geometry and typography;
`--row-label-spans` is a separate experimental variant. Its replacement helper
abstains when native blocks only partially overlap a candidate region or lack
position metadata. Explicit partial-overlap oracle runs are diagnostics, not
accepted repairs. This geometry experiment is not part of the integrated arms.
[`evaluate_odl_table_geometry.py`](scripts/evaluate_odl_table_geometry.py) replays
the eight explicitly reviewed tables with `integrate`, then checks complete
source grids, final chunks and separately scoped timing with `score`. It uses
the retained, fixed experiment inputs and records the automatic and manual
override results separately.

```sh
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/experiment_odl_heading_context.py --check
uv run python bench/parsers/scripts/experiment_odl_ocr_disagreement.py check
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/experiment_odl_table_geometry.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/evaluate_odl_table_geometry.py integrate
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/evaluate_odl_table_geometry.py score
```

[`measure_odl_native_pipeline.py`](scripts/measure_odl_native_pipeline.py) runs
fresh Java parsing, adaptation and one chunk pass. `baseline` uses the original
native path; `native` adds the four first-pass repairs; `extended` also adds the
selected heading and native hidden-layer order repairs. Run arms sequentially
in the pinned Java runtime on an idle VM, using a new directory for each repeat:

```sh
python bench/parsers/scripts/measure_odl_native_pipeline.py /path/to/corpus /path/to/baseline-r1 --variant baseline
python bench/parsers/scripts/measure_odl_native_pipeline.py /path/to/corpus /path/to/native-r1 --variant native
python bench/parsers/scripts/measure_odl_native_pipeline.py /path/to/corpus /path/to/extended-r1 --variant extended
```

The corpus root supplies `corpus.json` and its hashed PDFs. Each run records
source snapshots, phase timings, sampled memory, raw blocks and actual chunks.
This measures the native parser core, excluding OCR, Qwen captions, indexing
and application queues.

The executable evidence scorers consume completed artifacts without rerunning
Java. [`score_odl_font_transfer.py`](scripts/score_odl_font_transfer.py) checks
the frozen neighboring-paper numeric sequences and clean-font control; recovered
values alone do not establish correct table semantics.
[`score_odl_native_pipeline.py`](scripts/score_odl_native_pipeline.py) verifies
three repeats of all three arms, eight-document/254-page coverage, stable output
hashes, conserved blocks and the frozen heading, table and continuation checks.
It expects the related dated experiment directories beneath `reports/local`.
`--extended-prefix extended-prefilter` verifies the final equivalent source-reader
variant and compares its heading evidence and chunks with the original expanded
arm. The report distinguishes output equivalence from observed timing.
Use fresh outputs:

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/score_odl_font_transfer.py bench/parsers/reports/local/2026-09-09-odl-font-transfer/r2 bench/parsers/reports/local/2026-09-09-odl-font-transfer/inputs/ccl-cot.pdf bench/parsers/reports/local/2026-09-09-odl-font-transfer/r2/source-checks.json /path/to/new-font-score
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/score_odl_native_pipeline.py bench/parsers/reports/local /path/to/new-verification.json
```

## Endpoint load checks

`bench_parse.py` measures one request and concurrent bursts against a running
VM. `bench_mixed_lanes.py` fills four digital slots and two OCR-heavy slots,
then verifies representative text in every returned bundle.

```sh
python bench/parsers/scripts/bench_parse.py \
  --file bench/parsers/fixtures/docs/lecture_deck.pdf \
  --parse-method txt \
  --sweep 1,2,4,6,8

python bench/parsers/scripts/bench_mixed_lanes.py
```

Both scripts read `PARSER_URL` and `PARSER_TOKEN`, or accept matching flags.

## Ingest-worker resource checks

`build_worker_stress_fixtures.py` creates four unique 26-page copies in each
of four lanes: digital, 50/50 mixed, 24-of-26 scanned, and all scanned.
`run_worker_stress.sh` then starts four real pipeline containers against the
shared-spool parser API and records host, parser, and per-worker cgroup memory.
It exercises artifact verification, extraction, figure preprocessing, and
chunking without making billable caption or embedding calls. The shell harness
is written for the dedicated ingest host paths recorded in the 2026-08-31
decision report.

```sh
python bench/parsers/scripts/build_worker_stress_fixtures.py \
  --digital /inputs/digital.pdf \
  --ocr /inputs/scanned.pdf \
  --output-dir /opt/capy-ingest/stress-spool/sources \
  --tag candidate-1

bash bench/parsers/scripts/run_worker_stress.sh \
  digital auto digital-candidate 512m 768m 1.0
```

Use a new fixture tag for every measured pass. Reusing a tag reuses the
fingerprint-addressed parser artifact and no longer measures parsing.

`bench_worker_memory.py` streams a large but valid `content_list.json` fixture
to disk, then loads and chunks it in a separate worker container. The split
keeps fixture-builder allocations out of the measured cgroup. The two shell
harnesses measure one candidate limit and concurrent worker-plus-parser overlap:

```sh
python bench/parsers/scripts/bench_worker_memory.py build \
  --output /opt/capy-ingest/stress-current/worker-memory/content-120.json \
  --target-mib 120

MIBS=120 bash bench/parsers/scripts/run_worker_memory_stress.sh 1g 1g 1.0
bash bench/parsers/scripts/run_worker_memory_concurrency.sh 8 120 1g 1g 1.0 5
bash bench/parsers/scripts/run_worker_parser_overlap.sh unique-run-tag
```

The overlap harness is tied to the isolated paths and stress images recorded in
the 2026-08-31 report. It binds its parser only to `127.0.0.1`, uses
byte-distinct PDFs to defeat artifact reuse, and removes every test container
on exit.

## New documents and Beijing OCR

The [new-document report](reports/2026-09-09-java-new-documents.md) records fresh
Java/selective-OCR and MinerU runs on eight publisher PDFs, 254 original pages,
40 screening pages and eight explicitly derived raster controls. Source URLs,
hashes, roles and page selections live in
[`java-new-documents-sources.json`](fixtures/java-new-documents-sources.json).
`prepare_new_parser_corpus.py fetch MANIFEST ROOT` downloads publisher sources;
`prepare ...` verifies hashes, preserves intact PDFs and records all derived
page/image identities. Use a new output directory. `check_new_parser_corpus.py`
checks source rejection, page order, raster lineage and image hashes offline.
The `context-pages --native-run` option names the exact saved native run; the
existing suite-based default is unchanged.

[`image-record-spans.txt`](fixtures/image-record-spans.txt) is an unmeasured
prompt variant with explicit merged body cells and separate table metadata.
Its adapter rejects overlapping spans and independent text in covered cells,
and marks shared cell scope in experimental chunks. The offline check proves
representation behavior, not a model's ability to transcribe spans.

The [Beijing report](reports/2026-09-09-beijing-ocr.md) contains the Qwen3.5-OCR
capability protocol, matched source rubrics and three HTTP 403 entitlement
receipts. The developer paused this region's tests; no successful model
responses or quality/latency comparison are available. `bench_beijing_ocr.py
--check` verifies request construction without making network requests.

Run the corpus check with the recorded PDF dependencies:

```sh
uv run --with pymupdf==1.28.2 --with pypdfium2==5.13.0 \
  --with 'pypdf[crypto]==6.18.0' \
  python bench/parsers/scripts/check_new_parser_corpus.py
```
