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

There is no committed accuracy harness. The one that produced the August 28
record was written against the previous parser stack and was removed with it;
an accuracy check for MinerU has to be written against the artifact endpoint.

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
