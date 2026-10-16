# Parser v16 recalibration on the ingest host

2026-10-16. Time and memory for `odl-2.5.7-refined-vlm-v16` (main `0cecfcd8`)
in the production parser shape, at 5, 6 and 7 parse children. It is the first
concurrent run since scanned pages moved to the ingest worker's VLM: the parser
renders text-less pages instead of reading them, and the OCR process is gone.
It also carries the parsercaps changes: figure clustering on a grid index, the
2 GiB address-space cap per parse child and LibreOffice, and
`MALLOC_ARENA_MAX=2`. The previous run is
[the v14 stress run](2026-10-15-parser-v14-stress.md).

## Decision

None yet. Findings for the developer:

- **Scanned pages cost the parser almost nothing now.** A 150-page scan
  parses in 5 s (3.7 s of it rendering the page JPEGs, 23 MiB for 150 pages);
  under v14's OCR stage it took 458 s next to five books. A 300-page scan takes
  11–15 s. The reading moved to the worker's VLM, outside the parser.
- **Seven children are the CPU ceiling, and they pay off when the queue is
  full.** A 1,400-page book uses about one core. Seven books at once averaged
  7.0 of 8 cores and each took 293 s, against 275 s for five at once. With
  seven 1,400-page books and a scan queued (a full depth of 8):
  - 5 children: 528 s, the last two books waiting 273 s;
  - 6 children: 535 s, the last book still waiting a whole round (280 s);
  - 7 children: 297 s, nothing waiting, 2,012 pages a minute.

  An eighth child would not help: the CPUs are already saturated.
- **Memory is what an extra child costs, about 1.2 GiB each**, mostly its JVM.
  The worst case (seven books at once) peaked at 10.1 of 14 GiB in the
  container (anon 9.7), with no swap and no OOM kill. With five children it is
  7.8 GiB.
- **The host is the tighter limit.** It has 15 GiB and also runs the UAT
  parser (6 GiB limit) and workers, which were idle here: at seven children the
  host kept 3.3 GiB available (5.8 GiB at five). A busy UAT parse at the same
  moment would push the host into swap at seven children, and probably at six.
  Production on its own host would not have this problem.
- **The 2 GiB caps hold with room to spare.** A parse child's VmPeak was
  0.79–0.84 GiB on the books and 0.50 GiB on the Office mix; LibreOffice's
  0.88 GiB (the gradebook); Java's 2.8 GiB is bounded by its 1g heap, not the
  cap. No `drawing clusters stopped` line appeared.
- **Office files are cheap under load.** The 62-page handbook DOCX converts and
  parses in 7–9 s, the 84-slide PPTX in 18–23 s, and the 224k-cell gradebook
  XLSX (705 pages once converted) in 43–46 s, next to three 608-page books. The
  whole Office mix finished in 92 s at every child count, peaking at 4–5 GiB.
- **The longest parse under any load was 297 s** (a 1,400-page book among
  seven), a third of the 900 s document deadline. The longest queue wait was
  280 s (one round behind 1,400-page books).

### What this means for `PARSER_TIMEOUT`

`PARSER_TIMEOUT` (1,920 s) is one wait for a parse child, the parse, and 120 s.
Both terms are sized from the 900 s document deadline, because a waiting
document can sit behind a document that runs to its deadline. The measured
worst is 297 s for each. Options for the developer:

| Option | Document deadline | Wait term | `PARSER_TIMEOUT` | `CAPY_PARSE_JOB_TIMEOUT` |
| --- | ---: | ---: | ---: | ---: |
| Keep (today) | 900 s | 900 s | 1,920 s | 2,100 s |
| Halve the margin | 600 s (2× the worst parse) | 600 s | 1,320 s | 1,500 s |

Lowering only the wait term, with the deadline still 900 s, would let a
document waiting behind a runaway parse time out on the client while the
parser still holds it, so the two move together.

### Children

| Option | Worst case (full depth of 1,400-page books) | Container peak | Host risk while shared with UAT |
| --- | --- | ---: | --- |
| 5 (today) | 528 s; two books wait a round | 7.8 GiB | low |
| 6 | 535 s; one book waits a round | 9.2 GiB | moderate |
| 7 | 297 s; nothing waits | 10.1 GiB | swap if UAT parses at the same time |

Five and six behave the same for this queue shape; six only helps when the
queue holds exactly six large documents. Seven is the CPU ceiling.

## Setup

- Image built on the ingest host from `0cecfcd8` (`parser/` only, the
  production Dockerfile, `RELEASE_SHA` set), tag `capy-parser-recal:0cecfcd8…`.
- One throwaway container per pass, hardened as in
  `deploy/docker-compose.ingest-host.yml`: read-only root, `cap_drop ALL`,
  `no-new-privileges`, the two tmpfs mounts, its own spool and work volumes.
  Limits 14 GiB, 18 GiB with swap, 8 CPUs, 512 pids. Env as production:
  `CAPY_PARSE_QUEUE_DEPTH=8`, 900 s deadline, 1,400-page cap, 500 text-less
  page cap, 1g heap, `MALLOC_ARENA_MAX=2`, 180 s Office conversion timeout;
  `CAPY_PARSE_WORKERS` 5, 6 or 7.
- Host: 8 vCPUs, 15 GiB RAM, 24 GiB swap. The idle UAT ingest stack ran beside
  it (parser, coordinator, workers), plus the two lab databases.
- Driver: `scripts/stress_parser.py` at `0cecfcd8` in `burst` mode (every
  document sent at once through the production artifact route), sampling the
  cgroup every 250 ms, including VmPeak per parse child, LibreOffice and Java.

## Scenarios

- **C**, as in v14: a 150-page scan and five 1,400-page books.
- **D**, a full queue: the scan and seven 1,400-page books (8 documents, the
  queue depth).
- **O**, Office under load: the 62-page handbook DOCX, the 224k-cell gradebook
  XLSX and the 84-slide Japanese PPTX from the budget fixtures, the 42-page
  lecture with two scanned pages, a 300-page scan and three 608-page books.

The books are the Biology textbook without its text-less pages, concatenated
to 1,400 pages; the scans are its clean 150 dpi renders (inputs of the
2026-09-28 runs).

## Results

| Pass | Wall | Pages/min | Longest wait | Longest parse | Peak (anon) | Java RSS | Children RSS | Host available | Cores avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C, 5 children | 289 s | 1,485 | 2 s | 288 s | 7.69 (6.95) | 5.97 | 3.59 | 6.09 | 5.3 |
| C, 6 | 291 s | 1,473 | 0 s | 291 s | 7.78 (7.01) | 5.97 | 3.71 | 6.03 | 5.3 |
| C, 7 | 282 s | 1,519 | 0 s | 282 s | 7.80 (7.10) | 6.01 | 3.81 | 5.93 | 5.3 |
| D, 5 | 528 s | 1,131 | 273 s | 278 s | 7.79 (7.07) | 5.96 | 3.59 | 5.77 | 3.9 |
| D, 6 | 535 s | 1,115 | 280 s | 289 s | 9.20 (8.35) | 7.15 | 4.37 | 4.57 | 3.9 |
| D, 7 | 297 s | 2,012 | 1 s | 296 s | 10.10 (9.70) | 8.35 | 5.06 | 3.32 | 7.0 |
| O, 5 | 92 s | 1,972 | 9 s | 92 s | 3.98 (3.48) | 2.36 | 1.35 | 9.58 | 4.1 |
| O, 6 | 92 s | 1,981 | 3 s | 92 s | 4.91 (4.57) | 3.50 | 1.44 | 8.42 | 4.2 |
| O, 7 | 93 s | 1,951 | 0 s | 93 s | 4.94 (4.64) | 3.37 | 1.53 | 8.49 | 4.2 |

Memory in GiB. "Longest parse" is the parser's own time for a document minus
its queue wait. Every pass: all documents succeeded, no container swap, no OOM
kill, host swap 0.07 GiB throughout. Every pass touched 7.6–7.9 cores in its
busiest 10 s.

VmPeak, every pass: parse child 0.79–0.84 GiB (books) and 0.50 GiB (Office
mix), LibreOffice 0.88 GiB, Java 2.80–2.83 GiB.

## Not covered

- The VLM side: a 500-page scan through the UAT worker against
  `CAPY_INGEST_TIMEOUT` (1,200 s), 10 pages per job and 20 in flight. That is
  the next run.
- A busy UAT parser beside the production-shaped one.
- Real phone scans, and documents slower than the 1,400-page book per page
  (the parser budget's slowest solo fixtures are the books).

## Reproduction

Runner, manifests, per-document results and 250 ms samples are in the ignored
`reports/local/2026-10-16-parser-v16-recalibration/`. On the host the work
directory is `/opt/capy-parser-recal-20261016`; `recal.sh` runs the passes
(`PASSES="5:c 6:c 7:c 5:d 6:d 7:d 5:o 6:o 7:o"`), scenario C reading the
2026-09-28 `stage-c.json`.
