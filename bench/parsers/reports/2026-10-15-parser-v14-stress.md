# Parser v14 stress on the ingest host

2026-10-15. Time and memory for `odl-2.5.7-refined-rapidocr-v14` (image
`02f83a57`, which includes the MuPDF store release `982639ec` and extract-once
`7acd2e7f`) in the production parser shape. It repeats
[the v11 stress run](2026-09-28-parser-v11-stress.md) on the same host and the
same inputs. Since v11, CI's `Parser budget` has measured memory one document
at a time on a 4-CPU runner. Nothing had run concurrent parses since v11.

## Decision

None yet. Findings for the developer:

- **Memory is far from the limit.** The worst case is five 1,400-page books
  plus a 150-page scan at once. It peaked at 8.6 GiB of the 14 GiB cgroup
  (anon 8.17), against 13.14 GiB on v11. No pass touched container swap or
  the OOM killer, and host swap stayed at 0.06 GiB.
- **Native books are about twice as fast.** Java dropped from 109 s to 8 s on
  the 610-page book, because it no longer writes image files (`c6c88bd0`).
  Refinement got slower (44 → 82 s on that book), but Java's saving is larger.
  The five 1,400-page books took 375–395 s at once, against 766–784 s on v11,
  so they finish at under half the 900 s deadline.
- **OCR alone is 15–20% slower per page**: 2.2 s against 1.8–1.9 s. This is
  the expected cost of 4 OCR threads instead of 8 (v11's thread test measured
  +12%). Under load the scan finishes sooner, because the books release the
  CPU earlier: 3.0 s a page beside five books, against 4.8 s on v11.
- **Per-process peaks, for the security audit's RLIMIT_AS caps.** The audit
  patch caps each parse child and the OCR process. The largest single
  Python child (parse or OCR; the sampler can't tell them apart) reached
  1.44 GiB RSS and 4.91 GiB virtual size. RLIMIT_AS limits virtual size, so a
  cap must clear about 5 GiB plus headroom; a cap set from RSS would kill
  normal parses. Java is a separate process: about 1.0 GiB RSS each at the
  1g heap.
- **The peak is now the JVMs.** In scenario C the anon peak came at 64 s, with
  five JVMs at 4.93 GiB together and the Python children at 2.44 GiB.
  Refinement, which set the peak on v11, no longer does.
- **Memory held after a parse.** On a fresh container, the second parse of
  jp-llm2 peaked at 1.08 GiB. After the scans and the 1,400-page book, the same
  file peaked at 1.91 GiB. The children ended at 1.11 GiB of RSS, most of it
  the OCR process keeping its models loaded. This is not a leak: scenario C
  ended at 1.33 GiB after 7,150 pages.

## Setup

- Throwaway container `capy-parser-stress` from
  `capy-ingest-nonprod-parser:02f83a57…`, which is the same Dockerfile as the
  production parser. It ran with the production compose limits and env:
  - limits: 14 GiB, 18 GiB with swap, 8 CPUs, 512 pids;
  - `CAPY_PARSE_WORKERS=5`, `CAPY_PARSE_QUEUE_DEPTH=8`, 900 s document
    deadline, 60 s per OCR page, OCR page cap 500, 1,400-page cap, 1g heap;
  - its own spool volume.

  It was removed with its volume after each pass.
- Host: 8 vCPUs, 15 GiB RAM, 24 GiB swap. The idle UAT ingest stack ran beside
  it (a 6 GiB, 2-CPU parser, the coordinator and workers), plus the two lab
  databases. There is no production parser deployed yet, so this is the
  production shape, not the production container.
- Inputs: the v11 inputs in `/opt/capy-parser-stress-20260928/inputs`. The
  scans are clean renders of the Biology book at 150 dpi; `scan-26` is the one
  real scan.
- `scripts/stress_parser.py` now also samples the largest single parse
  child's RSS and VmSize (`child_max_rss`, `child_max_vm`).

## Solo

One document after another on one container, in this order.

| Document | Pages | OCR | Execution | Java | Refine | OCR s | Peak (anon) | Java RSS | Children RSS | One child RSS / VM | v11 execution | v11 peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attention | 15 | 0 | 3.6 s | 1.4 | 1.3 | 0 | 0.58 (0.28) | 0.39 | 0.12 | 0.12 / 0.17 | 3.3 s | 0.55 |
| japan-migration | 54 | 1 | 12.2 | 2.3 | 6.4 | 3.0 | 1.27 (1.14) | 0.31 | 1.28 | 0.93 / 3.81 | 9.1 | 1.10 |
| spain-figures | 60 | 2 | 12.1 | 2.0 | 5.9 | 3.4 | 1.40 (1.22) | 0.36 | 1.38 | 0.96 / 4.21 | 10.9 | 1.52 |
| jp-llm2 | 84 | 0 | 3.7 | 1.2 | 1.8 | 0 | 1.08 (0.90) | 0.27 | 0.83 | 0.35 / 3.63 | 11.8 | 1.48 |
| lecture-plus-scan | 42 | 2 | 7.1 | 0.8 | 0.2 | 5.8 | 1.49 (1.31) | 0.13 | 1.52 | 1.01 / 4.20 | 5.4 | 1.62 |
| scan-26 (real) | 26 | 26 | 68.9 | 0.4 | 0.1 | 68.3 | 1.47 (1.30) | 0.08 | 1.49 | 0.99 / 4.20 | 53.4 | 1.66 |
| scan-50 | 50 | 50 | 117.3 | 0.4 | 0.9 | 115.9 | 1.83 (1.60) | 0.07 | 1.79 | 1.29 / 4.56 | 97.2 | 2.21 |
| scan-150 | 150 | 150 | 336.7 | 0.6 | 2.6 | 333.2 | 1.97 (1.70) | 0.10 | 1.88 | 1.35 / 4.78 | 279.1 | 2.48 |
| biology-610 | 610 | 2 | 95.7 | 8.4 | 82.0 | 2.0 | 2.28 (1.97) | 1.13 | 1.60 | 0.99 / 4.78 | 157.3 | 4.21 |
| biology-x2-1220 | 1,220 | 4 | 248.3 | 14.2 | 223.5 | 4.4 | 2.73 (2.33) | 1.22 | 1.72 | 1.00 / 4.71 | 368.9 | 5.94 |
| biology-1400 (no OCR) | 1,400 | 0 | 285.1 | 17.0 | 260.6 | 0.1 | 2.94 (2.50) | 1.22 | 1.75 | 0.75 / 4.27 | — | — |
| scan-300 | 300 | 300 | 653.8 | 0.6 | 5.1 | 647.4 | 2.72 (2.26) | 0.12 | 2.13 | 1.35 / 4.81 | 547.9 | 3.66 |
| jp-llm2 again | 84 | 0 | 3.3 | 1.2 | 1.8 | 0 | 1.91 (1.50) | 0.25 | 1.15 | 0.35 / 4.30 | — | — |

Memory is in GiB. "Peak" is the cgroup's `memory.current`; "Children RSS"
sums every parse child and the OCR process. v11's solo pass ran at the 8g heap.
Its 1g row from the heap sweep put the 1,220-page book at 3.63 GiB, against
2.73 here.

- **Refinement grows faster than the page count.** It costs 0.13 s a page at
  610 pages, 0.18 at 1,220 and 0.19 at 1,400. Java stays near 12 ms a page.
- **The API process** reached 0.55 GiB while it held the 1,400-page book and
  its result (v11: 0.06–0.21 GiB).

## Scenario A: two scans, a lecture and five books

Sent 0.5 s apart in this order: scan-300, scan-150, lecture-plus-scan (2 OCR
pages), then five copies of biology-610 without its text-less pages
(608 pages).

| Document | Queue wait | Total | v11 total |
| --- | ---: | ---: | ---: |
| lecture (2 OCR pages) | 0 s | 24.7 s | 11.6 s |
| books 1–5 | 0 s | 131–136 s | 223–272 s |
| scan-150 | 0 s | 685.6 s | 676 s |
| scan-300 | 0 s | 1,013.2 s | 997 s |

8 of 8 succeeded, 3,532 pages. Peak 6.58 GiB (anon 6.03; v11 10.35, anon
7.66). Java peaked at 3.90 GiB and the children at 3.09. No container swap, no
OOM, host swap 0.06 GiB, host available at least 7.1 GiB.

- No book waited for a slot. On v11, books 4 and 5 waited 17–53 s while the
  scans ran Java.
- **The lecture's two OCR pages took 15.7 s** against 5.8 s alone. Round-robin
  OCR still serves it between the two scans' pages, but each page now costs
  more at 4 threads.

## Scenario C: the memory worst case

Sent at once: scan-150, then five 1,400-page text books
(`biology-1400-noocr`).

| Document | Total | Java | Structure | Repairs | OCR | v11 total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,400-page books ×5 | 375–395 s | 31–45 | 161–176 | 151–154 | 0.1 | 766–784 s |
| scan-150 | 457.8 s | 0.5 | 2.5 | 0 | 453.7 | 749 s |

6 of 6 succeeded, 7,150 pages in 458 s (v11: 784 s). Peak 8.60 GiB of 14
(anon 8.17; v11 13.14, anon 9.53). Java peaked at 4.99 GiB and the children at
4.75, though not at the same moment. No container swap, no OOM, host swap
0.06 GiB (v11 1.48), host available at least 4.77 GiB.

- Refinement under full load costs 0.23 s a page against 0.19 alone (+23%),
  and Java 1.8–2.6× its solo time. Five books and the OCR process share
  8 CPUs.
- **Headroom.** The deadline has room: the slowest book used 395 of 900 s.
  Memory has about 5 GiB left in the cgroup. A sixth slot or a larger page cap
  would fit on both counts, but neither was measured here.

## Not covered

- Office documents (LibreOffice conversion) under load.
- Busy ingest workers beside the parser (chunking, embedding).
- More than five slots, and the nonprod shape (6 GiB, 2 CPUs, one slot).
- Real phone scans; the synthetic scans are clean renders.
- The audit's RLIMIT_AS values themselves. This run gives the observed
  ceiling (4.91 GiB virtual per child); the caps still need a test with the
  limit set.

## Reproduction

The script, manifests, per-document results and 250 ms samples are in the
ignored `reports/local/2026-10-15-parser-v14-stress/`. On the host the work
directory is `/opt/capy-parser-stress-20261015`. `v14.sh` runs the passes in
order: `PASSES="solo a c"`. Scenarios A and C read the 2026-09-28 manifests
`stage-a.json` and `stage-c.json`.
