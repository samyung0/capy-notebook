# Parser benchmarks

This directory contains the reproducible checks for the dedicated ingest host.
The production decision records are:

- [`netcup-2026-08-28.md`](netcup-2026-08-28.md): parser accuracy and the
  earlier Marker/RapidOCR capacity decision.
- [`netcup-2026-08-31-stress.md`](netcup-2026-08-31-stress.md): current MinerU
  capacity, OOM, process-pool, timeout, health, and restart behavior.
- [`results/capy-ingest-1-netcup-rs-2000-g12-2026-08-31/`](results/capy-ingest-1-netcup-rs-2000-g12-2026-08-31/):
  versionable raw results, machine specifications, artifact inventory, and
  supplemental measurements for the August 31 run.

## Production accuracy and capacity

`accuracy_report.py` calls the ingest-host parser endpoint in `marker_only`,
`selective_rapidocr`, and `all_rapidocr` modes. It renders source pages, draws
returned bounding boxes, places extracted text beside each page, checks native
text and explicit visual canaries, and runs a concurrency sweep.

```sh
python bench/parsers/accuracy_report.py \
  --url http://10.77.0.2:8090/file_parse \
  --docs bench/parsers/docs \
  --canaries bench/parsers/canaries.example.json \
  --sweep 1,2,4,6,8 \
  --out bench/parsers/out/netcup
```

The command writes `report.html` for visual review and `report.json` for the
decision record. A mode is rejected when it loses most healthy native text,
misses a required canary, drops too many bounding boxes, duplicates substantial
text, degrades a native table, or makes all-page OCR substantially slower
without recovering useful content. Smaller OCR errors stay visible in the
side-by-side report without automatically rejecting a mode.

`build_office_fixtures.py` creates deterministic DOCX, PPTX, and XLSX canaries.
The measured decision was to use generous selective OCR. All-page OCR recovered
no additional text from native and mixed documents while taking 84 to 127
percent longer.

## Endpoint load checks

`bench_parse.py` measures one request and concurrent bursts against a running
VM. `bench_mixed_lanes.py` fills four digital slots and two OCR-heavy slots,
then verifies representative text in every returned bundle.

```sh
python bench/parsers/bench_parse.py \
  --file bench/parsers/docs/metabolic_pathway.pdf \
  --parse-method marker_only \
  --sweep 1,2,4,6,8

python bench/parsers/bench_mixed_lanes.py
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
python bench/parsers/build_worker_stress_fixtures.py \
  --digital /inputs/digital.pdf \
  --ocr /inputs/scanned.pdf \
  --output-dir /opt/capy-ingest/stress-spool/sources \
  --tag candidate-1

bash bench/parsers/run_worker_stress.sh \
  digital auto digital-candidate 512m 768m 1.0
```

Use a new fixture tag for every measured pass. Reusing a tag reuses the
fingerprint-addressed parser artifact and no longer measures parsing.

`bench_worker_memory.py` streams a large but valid `content_list.json` fixture
to disk, then loads and chunks it in a separate worker container. The split
keeps fixture-builder allocations out of the measured cgroup. The two shell
harnesses measure one candidate limit and concurrent worker-plus-parser overlap:

```sh
python bench/parsers/bench_worker_memory.py build \
  --output /opt/capy-ingest/stress-current/worker-memory/content-120.json \
  --target-mib 120

MIBS=120 bash bench/parsers/run_worker_memory_stress.sh 1g 1g 1.0
bash bench/parsers/run_worker_memory_concurrency.sh 8 120 1g 1g 1.0 5
bash bench/parsers/run_worker_parser_overlap.sh unique-run-tag
```

The overlap harness is tied to the isolated paths and stress images recorded in
the 2026-08-31 report. It binds its parser only to `127.0.0.1`, uses
byte-distinct PDFs to defeat artifact reuse, and removes every test container
on exit.

## Local backend comparison

`run_bench.py` is the earlier CPU comparison harness for Marker and Docling.
It measures throughput per vCPU and how much of the shared `content_list`
contract survives. Each backend should run in its own container because model
memory retained by an earlier backend can distort later results.

```sh
docker build -t capy-parse-bench bench/parsers
docker run --rm --cpus=4 \
  -v "$PWD/bench/parsers/docs:/bench/docs:ro" \
  -v "$PWD/bench/parsers/out:/out" \
  -v capy-parse-models:/models \
  capy-parse-bench --threads 4
```

Available backends:

| Backend                | Purpose                        |
| ---------------------- | ------------------------------ |
| `marker-fast-noocr`    | Marker without OCR.            |
| `marker-fast`          | Marker with its CPU VLM path.  |
| `docling-textonly`     | Layout and reading order only. |
| `docling-tables`       | Adds TableFormer.              |
| `docling-ocr`          | OCR on bitmap regions.         |
| `docling-ocr-fullpage` | OCR on every page.             |
| `docling-formula`      | Adds formula-to-LaTeX.         |

`normalize.py` maps candidate output into the active contract. Bounding boxes
use `page-1000-topleft`: `[x0, y0, x1, y1]` on a 1000 by 1000 page with a
top-left origin.

`--max-pages N` clips PDFs into `out/_capped/` before parsing so every backend
receives byte-identical bounded input. `--doc-timeout` limits pathological
documents that would otherwise stall a run.
