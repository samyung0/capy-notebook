# Parser v11 stress on the ingest host

2026-09-28. Time, memory and CPU for `odl-2.5.7-refined-rapidocr-v11` in the
production parser shape, one document at a time and under a full queue. No
earlier gate measured memory; v7 to v11 recorded only summed parse time.

## Decision

None yet. Findings for the developer:

- Memory is not the constraint. The worst document (1,220 native pages)
  peaked at 5.9 GiB of the 14 GiB cgroup, Java at 2.4 GiB of its 8g heap, no
  swap, no OOM kill.
- The 600 s deadline is. A scanned PDF costs about 1.8 s per page, so the
  limit is roughly 320 scanned pages; the 300-page scan took 548 s (91%) and
  its bundle 232 MiB of the 256 MiB artifact cap (measured with bundle v4,
  whose page images v5 no longer ships). Native books fit to roughly
  1,800-2,000 pages, and the refinement phases grow faster than the page
  count.
- Native parsing leaves the CPU idle: 1.1-2.7 of 8 cores, because Java runs
  one thread. OCR uses about 5.6. A second parser on the same host would
  raise native throughput; not measured.
- The 8g Java heap is far more than needed. Heaps from 3g down to 1g parse
  every document, including 1,220 pages, at the same speed; Java's RSS on the
  largest book falls from 2.35 GiB to 1.25 GiB. Per-parser memory is set by
  the Python parse child instead.
- The queue behaves as designed: execution times under a full queue equal the
  solo times, waits add up serially, and the fifth request is a 429.

## Setup

- A throwaway container `capy-parser-stress` from the host's image
  `capy-ingest-nonprod-parser:21a8f996` (v11, no parser commits since), with
  the production parser's limits and env: 14 GiB, 18 GiB with swap, 8 CPUs,
  256 pids, `CAPY_PARSER_JVM_MAX_HEAP=8g`, queue depth 4, 600 s deadline, its
  own spool volume and port. Removed afterwards with its volume and token.
- Host: 8 vCPUs, 15 GiB RAM, 24 GiB swap. Only the idle nonprod stack ran
  beside it (its parser is 6 GiB, 2 CPUs, 3g heap).
- Requests used the production artifact route (`/file_parse` with the
  coordinator's JSON, a fingerprint unique per run so no cached bundle was
  served). `scripts/stress_parser.py` sampled the container's cgroup every
  250 ms. Execution is `_server_parse_s` minus `_queue_ms`; the peaks are the
  samples in that window.
- Documents: the host's earlier bench inputs (it has no copy of the 66-book
  gate corpus), plus generated ones. Scans are Biology for the IB Diploma pages
  rasterised to 150 dpi grey JPEG (`corpus`), since the host has only one real
  26-page scan; `biology-x2` is that 610-page book twice.

## Solo

| Document | Pages | OCR pages | Execution | Java | Peak memory | Java RSS | Python RSS | Cores |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attention | 15 | 0 | 3.3 s | 2.0 s | 0.55 GiB | 0.43 | 0.19 | 2.2 |
| japan-migration | 54 | 1 | 9.1 s | 2.6 s | 1.10 | 0.41 | 1.02 | 2.6 |
| spain-figures | 60 | 2 | 10.9 s | 5.3 s | 1.52 | 0.64 | 1.41 | 2.7 |
| jp-llm2 | 84 | 0 | 11.8 s | 10.6 s | 1.48 | 0.44 | 0.94 | 1.3 |
| lecture-plus-scan | 42 | 2 | 5.4 s | 1.1 s | 1.62 | 0.21 | 1.54 | 5.4 |
| scan-26 (real scan) | 26 | 26 | 53.4 s | 3.2 s | 1.66 | 0.19 | 1.57 | 6.1 |
| scan-50 | 50 | 50 | 97.2 s | 8.3 s | 2.21 | 0.23 | 2.06 | 5.6 |
| scan-150 | 150 | 150 | 279.1 s | 22.6 s | 2.48 | 0.25 | 2.22 | 5.6 |
| biology-610 | 610 | 2 | 157.3 s | 109.0 s | 4.21 | 1.77 | 2.28 | 1.2 |
| biology-x2-1220 | 1,220 | 4 | 368.9 s | 218.8 s | 5.94 | 2.35 | 3.08 | 1.1 |
| scan-300 | 300 | 300 | 547.9 s | 46.4 s | 3.66 | 0.37 | 3.20 | 5.6 |

Peak memory is the cgroup's `memory.current` (anon plus page cache); anon
alone was 0.3-1.4 GiB lower. Swap stayed at 0 throughout.

- OCR runs at 1.7-1.9 s per scanned page (1.9 on the real scan). The first OCR
  page after start also loads the models.
- Native cost is Java plus refinement. Doubling Biology doubled Java (109 →
  219 s) but multiplied `structure` by 3.6 (22 → 79 s) and `repairs` by 2.8
  (22 → 62 s).
- The persistent parse child's Python RSS rose from 1.0 to 2.3 GiB over the
  first run and reached 3.2 GiB after the two limit documents. It levelled
  between documents of similar size; a longer run would show whether it keeps
  climbing.
- Bundles (v4): 42 MiB for 50 scanned pages, 115 MiB for 150, 232 MiB for 300;
  Biology 106 MiB, doubled Biology 108 MiB (identical images stored once).

## Burst

Four documents sent 0.5 s apart, then a fifth.

| Document | Queue wait | Execution | Total | Peak memory |
| --- | ---: | ---: | ---: | ---: |
| biology-610 | 0 s | 158.8 s | 161.8 s | 4.71 GiB |
| scan-50 | 158.3 s | 92.5 s | 252.1 s | 2.95 |
| jp-llm2 | 250.3 s | 11.5 s | 262.4 s | 2.95 |
| spain-figures | 261.3 s | 10.3 s | 272.1 s | 2.94 |
| attention (fifth) | 429 `parser_capacity` | | 0 s | |

Queued sources held in the API process added nothing visible.

## Java heap sweep

The same container restarted with `CAPY_PARSER_JVM_MAX_HEAP` at 3g, 2g, 1500m
and 1g, four documents each. Every run succeeded, and execution time did not
move beyond run-to-run noise (about ±3%).

| Heap | biology-610 | biology-x2-1220 | Java RSS, 1,220 pages | Peak memory, 1,220 pages |
| --- | ---: | ---: | ---: | ---: |
| 8g (solo run above) | 157.3 s | 368.9 s | 2.35 GiB | 5.94 GiB |
| 3g | 157.8 s | 365.6 s | 1.94 | 4.24 |
| 2g | 163.0 s | 371.6 s | 1.88 | 4.36 |
| 1500m | 162.2 s | 368.6 s | 1.74 | 4.11 |
| 1g | 157.9 s | 365.8 s | 1.25 | 3.63 |

jp-llm2 stayed at 11.4-11.9 s and scan-50 at 92.6-94.1 s under every heap.
Java only grows into the heap it is given; a 1,220-page book needs less than
1 GiB of live heap. The Python parse child (1.4-2.5 GiB on a fresh container,
3.2 GiB after the long first session) is the larger share of a parser's
memory, and the heap does not change it.

## Not covered

- Parsing beside four busy ingest workers (chunking and embedding need the
  queue, database and providers).
- Office documents (LibreOffice conversion) and the nonprod parser shape.
- Two parsers side by side.
- Real scans beyond 26 pages: the synthetic ones are clean renders, so real
  phone scans may OCR slower.

## Reproduction

Inputs, manifests, per-document results and 250 ms samples are in the ignored
`reports/local/2026-09-28-parser-v11-stress/`. On the host, in a work
directory holding the script, a token file and the manifests:

```sh
python stress_parser.py corpus SOURCE.pdf scan-150.pdf --pages 100-249 --dpi 150  # in the parser image
docker run -d --name capy-parser-stress --init -p 127.0.0.1:18090:8090 \
  --memory 14g --memory-swap 18g --cpus 8 --pids-limit 256 \
  -e PARSER_TOKEN -e CAPY_PARSE_QUEUE_DEPTH=4 -e CAPY_PARSE_DOCUMENT_TIMEOUT=600 \
  -e CAPY_PARSER_JVM_MAX_HEAP=8g -e CAPY_PARSE_SHARED_DIR=/var/lib/capy-parse \
  -v capy-parser-stress-spool:/var/lib/capy-parse capy-ingest-nonprod-parser:RELEASE_SHA
PARSER_TOKEN=... python3 stress_parser.py solo --manifest solo.json --out results --container capy-parser-stress
PARSER_TOKEN=... python3 stress_parser.py burst --manifest burst.json --out results --container capy-parser-stress
```

The spool volume needs `sources/`, `artifacts/` and `quarantine/` owned by
10001 first, as `parse-spool-init` does in the ingest compose file.
