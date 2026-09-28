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

## Where the parser's memory goes

`scripts/profile_parser_memory.py` ran the parse child's code (`app.run_document`)
in one process inside image `efde3dc8` (bundle v5), 1g heap, six documents in a
row: scan-50, biology-610, jp-llm2, biology-x2-1220, biology-610 again, scan-50
again. A thread read RSS every 20 ms and credited the peak to the refinement
step running.

| | No trim: at rest | No trim: peak | `malloc_trim(0)` after each: at rest | peak |
| --- | ---: | ---: | ---: | ---: |
| scan-50 (first) | 1,283 MiB | 1,825 | 472 | 1,814 |
| biology-610 | 1,361 | 1,896 | 560 | 1,634 |
| jp-llm2 | 1,348 | 1,356 | 544 | 592 |
| biology-x2-1220 | 1,385 | 2,152 | 533 | 2,037 |
| biology-610 again | 1,382 | 1,907 | 546 | 1,640 |
| scan-50 again | 1,387 | 1,922 | 634 | 1,918 |

- No leak: the child levels at about 1.38 GiB. About 0.8 GiB of that is memory
  glibc keeps after onnxruntime and MuPDF free it; `malloc_trim(0)` returns it
  without changing speed. The RapidOCR and layout models are about 0.4 GiB
  (onnxruntime's memory arena is already off in both engines). Each OCR use
  adds 0.5-0.8 GiB while it runs.
- Refinement on 1,220 pages adds 0.8 GiB at peak, mostly native memory:
  `join_split_ligatures` +550 MiB, `repair_text` +225, `styles.annotate` +180,
  `headings.source_headings` +136. With tracemalloc on (biology-610), Python
  objects never exceeded 356 MiB while RSS rose from 105 MiB to 1,146 MiB over
  the refinement steps. `source_text.py` keeps a page's rawdict and text trace
  for every page it touches until the step returns.
- ODL's JSON is 14 MiB for 610 pages and 27 MiB for 1,220; the result 4 and 9 MiB.
- The API process, measured apart from the child in a stress run on the same
  image, peaks at 0.06-0.21 GiB and ends at 65 MiB. The earlier 2.3-3.2 GiB
  "Python" figure summed the API and the child under bundle v4, whose images
  the API held while zipping. v5 bundles are 0.1 MiB (scan-50), 1.0 MiB
  (biology-610) and 2.0 MiB (1,220 pages) against 41.7, 106 and 108 MiB.

## Parse slots with one OCR process

Image `capy-parser-slots:test`, built on the host from the uncommitted tree:
`CAPY_PARSE_WORKERS` parse children plus one OCR process, `malloc_trim` after
each document, per-page release in `source_text.py`, 1g heap. Container
limits as production: 14 GiB, 18 GiB with swap, 8 CPUs, 256 pids, 600 s
deadline. Each level sends N documents at once with `CAPY_PARSE_WORKERS` =
`CAPY_PARSE_QUEUE_DEPTH` = N and stops after the first level with a failure.
`capacity.sh` / `capacity_native.sh` on the host.

With OCR: one scan-150 (through the OCR process) and N-1 biology-x2-1220.

| Slots | OK | Wall | Pages/s | Scan-150 | Book | Peak memory (anon) | Host available, min | Swap | OOM |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 2/2 | 453 s | 3.0 | 418 s | 453 s | 4.49 GiB (2.95) | 9.79 GiB | 0 | 0 |
| 3 | 3/3 | 529 s | 4.9 | 506 s | 529 s | 7.07 (4.46) | 8.30 | 0 | 0 |
| 4 | 1/4 | 600 s | - | 600 s | timeout ×3 | 9.61 (5.96) | 6.65 | 0 | 0 |

Without OCR: N copies of biology-x2 with its four textless pages removed
(1,216 pages, no page reaches the OCR process). Alone it takes about 370 s
(3.3 pages/s).

| Slots | OK | Wall | Pages/s | Java per book | Peak memory (anon) | Host available, min | Host swap | OOM |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 3/3 | 406 s | 9.0 | 256-260 s | 7.87 GiB (4.43) | 8.39 GiB | 0.02 GiB | 0 |
| 4 | 4/4 | 437 s | 11.1 | 284-287 s | 10.37 (5.87) | 6.79 | 0.02 | 0 |
| 5 | 5/5 | 505 s | 12.1 | 348-354 s | 10.97 (7.28) | 5.37 | 0.11 | 0 |
| 6 | 6/6 | 550 s | 13.3 | 386-398 s | 12.09 (8.83) | 3.71 | 0.78 | 0 |
| 8 | 4/8 | 600 s | - | 347-357 s | 12.32 (8.91) | 4.50 | 0.95 | 0 |

- No level reached the OOM killer or container swap. Each 1,216-page book adds
  about 1.45 GiB of anon memory (Java about 1.3 GiB at a 1g heap, the child
  the rest); page cache fills the cgroup up to 12.3 GiB.
- CPU sets the limit. With OCR, the scan's OCR slows from 256 s alone to 568 s
  at four slots (its 8 onnxruntime threads compete with every native parse),
  and the 1,220-page books pass 600 s at four slots. Without OCR, six
  1,216-page books fit inside the deadline at 550 s.
- At eight slots two JVMs failed to start threads (`pthread_create failed
  (EAGAIN)`: `pids_limit: 256` counts threads) and two books timed out.
- Failure isolation held: at four slots with OCR, three books timed out one by
  one and the scan in another slot still returned its bundle.

## OCR threads: 8 against 4

The same slot image with `THREADS` in `parser/odl/ocr.py` at 8 (as shipped) and 4
(`capy-parser-slots:t4`), deadline raised to 1,800 s so nothing timed out.
Alone: scan-150 on one slot. Mixed: scan-150 beside five copies of biology-610
with its two textless pages removed (608 pages, no OCR), six slots.

| OCR threads | Scan OCR, alone | Scan OCR, mixed | Scan total, mixed | Books, mixed |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 259 s | 402 s | 438 s | 263-271 s |
| 4 | 290 s | 369 s | 407 s | 215-223 s |

Four threads cost OCR 12% alone and win under load for both sides: the scan
finishes 31 s sooner and every book 45-50 s sooner. The shared OCR queue adds
no cost of its own (259 s against 256 s before it existed).

## Five parse slots and an OCR stage

Image `capy-parser-ocr-stage:test` from the uncommitted tree: five parse
children hand textless pages to one OCR process (four threads) and take the
next document; the parse deadline (600 s) stops at the handoff, each OCR page
has 60 s, OCR serves documents round-robin, and at most 1,000 OCR pages may
queue. Depth 8, 1g heap, 14 GiB, 8 CPUs, `pids_limit` 512. `stage.sh` on the
host.

Scenario A, sent in this order: scan-300, scan-150, lecture_plus_scan (42
pages, 2 textless), five biology-610 without its textless pages (608 pages).

| Document | Queue wait | Total |
| --- | ---: | ---: |
| lecture (2 OCR pages) | 0 s | 11.6 s |
| books 1-3 | 0 s | 223-230 s |
| book 4 | 17 s | 242 s |
| book 5 | 53 s | 272 s |
| scan-150 | 0 s | 676 s |
| scan-300 | 0 s | 997 s (OCR 628 s) |

All eight succeeded: 3,532 pages, peak 10.35 GiB (anon 7.66), no container
swap, no OOM, host swap 0.95 GiB. The lecture's two OCR pages were read between
the scans' pages; first-come order would have kept it behind 450 pages. Books
waited for a parse slot only while the scans ran Java (28-64 s), not their
OCR. Neither scan could have finished under the old single 600 s deadline.

Scenario B (memory worst case): scan-150 and five biology-x2 without textless
pages (1,216 pages). Only the scan succeeded (659 s, OCR 630 s); all five books
passed the 600 s parse deadline (610-626 s). Without the OCR process the same
five finished in 505 s. Peak 12.65 GiB (anon 9.33), no container swap, no
OOM, host swap 1.38 GiB, host available at least 4.1 GiB.

Under full load the parse cost grows faster than the page count: 608 pages
took about 225 s beside two scans, 1,216 pages more than 610 s beside one.
Fitting t = a·n + b·n² to those two points (a lower bound, since the second
timed out) gives about 455 s at 1,000 pages, 525 s at 1,100, 760 s at 1,400.

Scenario C, after the parse deadline rose to 900 s: scan-150 and five
1,400-page text books (biology-610 without its textless pages, twice, plus its
first 184 pages). All six succeeded: 7,150 pages in 784 s. The books took
766-784 s (Java 523-543 s, structure 123-134 s, repairs 88-92 s), 116-134 s
inside the deadline; the fit above predicted about 760 s. The scan took 749 s,
its OCR 722 s: 4.8 s a page, against the 2.5 s a page next to five 608-page
books. Peak 13.14 GiB of the 14 GiB cgroup (anon 9.53), no container swap, no
OOM, host swap 1.48 GiB, host available at least 4.3 GiB.

At 4.8 s a page a full 1,000-page OCR backlog would outlast the 4,420 s
request bound, so the OCR page cap became 500 (500 × 5 s fits the same bound).

## Not covered

- Parsing beside four busy ingest workers (chunking and embedding need the
  queue, database and providers).
- Office documents (LibreOffice conversion) and the nonprod parser shape.
- Parse slots under a realistic mix of document sizes (the capacity levels
  used only the largest books), and slots beside four busy ingest workers.
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
