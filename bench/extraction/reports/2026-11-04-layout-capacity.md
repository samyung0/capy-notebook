# Layout pool beside the parser on the ingest host (2026-11-04)

Epo asked how PP-DocLayout_plus-L (ONNX) behaves beside the parser on the ingest
host, and whether two instances can run. They expected the parser's OpenDataLoader
(ODL) to compete with it mainly for CPU. That turned out to be right, and worse
than expected without protection. Epo's design is one shared pool for UAT and
production, with UAT's share minimal, so everything here is sized for one pool in
total. The model choice is in
[the layout models report](2026-11-04-layout-models.md).

## Answers

- **Run it only with low CPU priority.** Without it, one instance on a steady
  stream of bursts failed all seven 1,400-page books at the 600 s deadline
  (`parse_hard_timeout`). Docker gives each container an equal CPU weight however
  many busy processes it has, so four layout threads beat seven parse children.
  `--cpu-shares 128` fixes this. `nice` and spinning off, on their own, do not.
- **Two instances are worth it, for staying up more than for speed.** At the same
  four threads, two instances are 16% faster than one when the parser is idle and
  24% faster beside Scenario A. They tie on a full parser queue, where CPU is the
  limit. They cost 0.55 GiB more, and while one is down the other keeps serving.
- **Settings for the pool:** two instances, two ONNX threads each, spinning off
  (`session.intra_op.allow_spinning=0`), `cpu_shares: 128`, no `cpus` limit,
  `mem_limit: 1g` with no swap, depth 4 per instance.
- **The parser's slowdown at those settings:** 10% on Scenario A and 13% on
  Scenario C, the worst measured. On a full queue it is 2-3% with the pool running
  directly and 4-7% through the service prototype. The slowest document took 395 s
  of the 600 s deadline, against 374 s without the pool. Every document succeeded,
  with no OOM kill and host swap at most 0.37 GiB.
- **40-page extractions an hour, for the whole pool:**

  | Parser | Pages/s | 40-page burst, median | Extractions an hour |
  |---|---|---|---|
  | Idle | 3.1 through the service, 3.3 direct | 12 s | about 280 |
  | Busy (Scenarios A and C) | 1.8-1.9 direct | 19-20 s | about 165 |
  | Full queue, every parse child busy | 0.94 through the service, 0.85 direct | 50 s | about 80 |

  These are bursts of 40 pages of figures. A real paper sends only its figure
  pages, often 6-10, so the same budget of about 3,000 pages an hour at the worst
  covers more papers.

- **It picks itself back up.** A killed instance answers again in about 1.6 s,
  both at once in about the same, and in under 4 s beside a full parser queue. No
  page was lost or answered twice in any test; callers retried, or fell back at
  their bound. Two things need a setting or a warning: a hung process needs a
  health check that kills it (19-24 s), and a `docker kill` by hand stays down.
  Details and settings are under [Crash recovery](#crash-recovery).
- **One thing to settle before building it:** this host's firewall passes only ports
  53, 80 and 443 between containers on a Docker bridge. The prototype used port 80.
  See [Network](#network).

## What this run disturbed

**My throwaway parser made a UAT workflow fail, and left UAT's watchdog unable to do
its job while it ran.** Nothing was broken on UAT.

- **The cause.** The parser image carries the UAT stack's compose labels
  (`com.docker.compose.project=capy-ingest-nonprod`, `service=parser`), and a container
  inherits its image's labels. I did not override them, so my
  `capy-layout-capacity-parser` looked like a second UAT parser to anything that finds
  it by label.
- **The workflow.** "Deterministic UAT quality" on `main` at `d39c967d` (run
  41789327636) failed in two jobs, billing at 07:23:05 UTC and office at 07:28:00 UTC,
  with `parser must have exactly one container` from
  `scripts/uat/verify-journey-releases.sh after`. Both fall inside my full-queue crash
  pass (07:21:30-07:28:11). Every test had passed: billing 7 of 7, office 11 of 11, app
  12 of 12. The app job's check ran at 07:42, after my container had gone, and passed.
  The failed jobs need a rerun, not a redeploy, whatever the error text suggests.
- **The watchdog.** `capy-ingest-watchdog@nonprod` finds its parser the same way, so it
  failed 613 checks between 03:41 and 07:28 UTC, about 2.5 hours in total, whenever my
  parser was up. UAT's parser had no watchdog for those stretches. It stayed healthy with
  0 restarts, and the watchdog needed no restart once my container was gone.
- **A near miss.** No parser of mine happened to be up when UAT was deployed at about
  07:00 UTC. The same check would likely have failed that deploy.
- **The fix.** `layout_capacity.py` now overrides both labels. Earlier parser stress
  runs started this way may have had the same effect, so anyone starting a container
  from these images should override them too.

## What the brief had out of date

- **The deadline is 600 s, not 900 s.** Epo decided this on 2026-10-16
  (`human/agentic-retrieval.md`). I ran 600 s and measured against it.
- **There is no 60 s OCR page limit, and no OCR in the parser.** The OCR stage went
  in v16: the parser renders text-less pages and the ingest worker's VLM reads
  them. The image has no OCR module. A scanned page costs the parser about 25 ms.
- **`CAPY_PARSE_WORKERS` is 7 in production.** Epo decided this on 2026-10-16 and
  reaffirmed it on 2026-10-21. The compose default and env example agree; the v14
  report's 5 is old, and `deployment-runbook.md` §7.2 still says five. I ran 7, with
  depth 8.
- **Scenario A's lecture file has moved.** The old `/opt` path is gone, so I copied
  `bench/parsers/fixtures/docs/lecture_plus_scan.pdf` from the repository, the same
  42 pages with 2 text-less. The stress inputs under
  `/opt/capy-parser-stress-20260928` were only read.
- **Scenario A is not the CPU worst case.** Its scans finish in 10 s, which leaves
  five parse children, about 5.4 cores. I added the v16 report's Scenario D: a
  150-page scan and seven 1,400-page books, a full queue with every child busy, 7
  of 8 cores.

## Setup

- **Host.** Debian 13, 8 vCPUs (AMD EPYC 9645), 15.6 GiB RAM, 24 GiB swap. The UAT
  ingest stack stayed up beside the tests, along with both lab databases.
- **Parser.** A fresh throwaway container per pass, image
  `capy-ingest-nonprod-parser:e200b841…` (`odl-2.5.7-refined-vlm-v20`), then the
  newest on the host. Production shape from `deploy/docker-compose.ingest-host.yml`:
  8 CPUs, 14 GiB, 18 GiB with swap, 512 pids, read-only root, no capabilities, its
  own spool and work volumes. `stress_parser.py` drove it from inside its network
  namespace, so the container had no network and no port was opened.
- **Layout, capacity passes.** Each instance in its own container with no network,
  running `scripts/layout_burst.py`: 59 page images (37 scan, 22 born-digital) at
  the windows' 1,568 px, in one shuffled order. Instances share one page counter,
  so two instances split each burst, as one queue would. A page's time runs from
  opening its JPEG to the regions.
- **Safety.** Each pass waited for the UAT stack and `capy-library-db` to be quiet.
  Host swap past 8 GiB or a change in a UAT container stopped the run.
- **Which passes ran on which parser image.** UAT was deployed at 07:00 UTC,
  during the crash tests, from `e200b841` to `d39c967d`. Every parser pass used
  `e200b841`, including those run after the deploy, so they compare with the
  baselines. The only parser change between the two is `pypdf` 6.21.4 for security
  advisories (`d39c967d3`), so nothing needed rerunning. UAT's parser port did not
  change: the nonprod compose file has always defaulted to 8091. The deploy did
  trip the safety stop; see Crash recovery.

## Baseline: the parser alone

Each kind of Scenario A document alone, then all of Scenario A sent 0.5 s apart.
CPU is the container's for that document's run.

| Document | Pages | Alone: time | CPU | Peak memory | In Scenario A, two runs |
|---|---:|---:|---:|---:|---:|
| scan-300 | 300 | 9.3 s | 10 s | 0.95 GiB | 9.7, 10.4 s |
| scan-150 | 150 | 5.1 s | 6 s | 0.82 GiB | 5.4, 5.8 s |
| lecture (2 text-less pages) | 42 | 1.4 s | 3 s | 0.57 GiB | 1.9, 2.0 s |
| book, five copies | 608 | 93 s | 115 s | 1.67 GiB | 111-123 s |

No document used container swap, and host swap stayed at 0.06 GiB.

| Scenario | Wall | Slowest document | Share of 600 s | Peak (anon), GiB | Host available, min | Cores, average |
|---|---:|---:|---:|---:|---:|---:|
| A, two runs | 120, 124 s | 118, 121 s | 20% | 6.34 (5.96), 6.18 (6.08) | 7.3 GiB | 5.4 |
| C: scan-150, five 1,400-page books | 337 s | 334 s | 56% | 8.04 (7.32) | 5.9 GiB | 5.2 |
| D, two runs: scan-150, seven 1,400-page books | 369, 378 s | 364, 374 s | 62% | 10.85 (10.10), 9.64 (9.04) | 3.0, 4.0 GiB | 7.0 |

**A full queue has less margin than the earlier reports say.** Seven 1,400-page books
took 357-374 s here, against 293-301 s in the
[v19 report](../../parsers/reports/2026-10-21-parser-v19-sandbox-stress.md) on the same
host and inputs. Every phase is 20-30% slower at seven at once, while a 608-page book
alone (92 s) is about as fast as before. That points to contention on the machine more
than to the code, but I did not investigate it. It leaves a full queue only about 1.6
times its normal time before the deadline.

## Layout alone

Bursts of 40 for 120 s, on a quiet host. Each instance peaked at 553-557 MiB RSS
(0.51 GiB anon) and loaded in 0.55-0.85 s.

| Instances × threads | Pages/s | Page p50 | Page p95 | 40-page burst | Cores used |
|---|---:|---:|---:|---:|---:|
| 1 × 1 | 0.93 | 1.07 s | 1.15 s | 42.9 s | 1.00 |
| 1 × 2 | 1.65 | 0.60 s | 0.64 s | 24.4 s | 2.00 |
| 1 × 4 | 2.94 | 0.34 s | 0.36 s | 13.5 s | 4.00 |
| 1 × 4, spinning off | 2.83 | 0.34 s | 0.42 s | 14.1 s | 3.42 |
| 2 × 1 | 1.85 | 1.07 s | 1.15 s | 21.9 s | 2.00 |
| **2 × 2** | 3.26 | 0.61 s | 0.68 s | 12.3 s | 4.00 |
| **2 × 2, spinning off** | **3.29** | **0.60 s** | **0.65 s** | **12.4 s** | **3.81** |
| 2 × 4 | 5.19 | 0.38 s | 0.43 s | 7.8 s | 7.95 |

Two instances give about twice one at the same thread count (1.8 times at four
threads, where they fill the host). At the same cores, splitting gains 11-12%, since the model scales a little under linearly with threads.
Spinning off costs nothing at two threads and saves 5% of the CPU.

## Together: the pool beside the parser

Bursts ran continuously for as long as the parser pass lasted. That is much harder
than real use. Slowdown is against the baseline's mean wall time.

| Parser | Layout, protection | Documents OK | Parser wall | Slowdown | Slowest document | Layout pages/s | Page p50, p95 | Burst p50, max | Bursts an hour |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 1 × 4, none | 8/8 | 183 s | +50% | 181 s | 2.32 | 0.42, 0.57 s | 17, 19 s | 208 |
| A | 2 × 2, none | 8/8 | 214 s | +75% | 212 s | 3.11 | 0.64, 0.70 s | 13, 14 s | 280 |
| A | 1 × 4, shares 128, no spin | 8/8 | 139 s | +14% | 135 s | 1.46 | 0.59, 1.33 s | 25, 49 s | 131 |
| A | **2 × 2, shares 128, no spin** | 8/8 | 135 s | **+10%** | 131 s | 1.81 | 0.99, 2.84 s | 19, 33 s | 163 |
| C | **2 × 2, shares 128, no spin** | 6/6 | 381 s | **+13%** | 376 s | 1.89 | 0.99, 1.34 s | 20, 45 s | 170 |
| D | 1 × 4, none | **1/8** | 608 s | failed | 600 s | 2.44 | 0.39, 0.53 s | 16, 19 s | 220 |
| D | 2 × 2, none | **1/8** | 609 s | failed | 600 s | 3.17 | 0.63, 0.69 s | 13, 14 s | 285 |
| D | 2 × 2, spinning off only | **1/8** | 609 s | failed | 600 s | 2.94 | 0.66, 0.81 s | 14, 15 s | 265 |
| D | 2 × 2, `nice 19` only | **1/8** | 609 s | failed | 600 s | 3.26 | 0.61, 0.66 s | 13, 14 s | 293 |
| D | 2 × 2, `--cpus 1` each | 8/8 | 539 s | +44% | 530 s | 1.54 | 1.29, 1.42 s | 27, 29 s | 139 |
| D | 2 × 2, shares 128 | 8/8 | 399 s | +7% | 396 s | 0.72 | 3.15, 4.43 s | 65, 85 s | 65 |
| D | **2 × 2, shares 128, no spin**, two runs | 8/8, 8/8 | 381, 384 s | **+2-3%** | 376, 379 s | 0.86, 0.85 | 2.4, 3.8 s | 49-51, 65-69 s | 77-78 |
| D | 2 × 2, shares 2, no spin | 8/8 | 378 s | +1% | 370 s | 0.83 | 2.38, 2.68 s, one 15 s | 48, 98 s | 75 |
| D | 2 × 1, shares 128, no spin | 8/8 | 364 s | none | 361 s | 0.92 | 2.21, 3.16 s | 46, 60 s | 83 |
| D | 1 × 4, shares 128, no spin | 8/8 | 392 s | +5% | 384 s | 0.86 | 1.25, 2.90 s | 51, 96 s | 78 |
| D | 1 × 2, shares 128, no spin | 8/8 | 384 s | +3% | 380 s | 0.77 | 1.21, 2.83 s | 49, 92 s | 69 |

The run-to-run noise in Scenario D alone is about 3%. In the four failed passes, the
scan succeeded and every book was killed at the deadline, so "slowest document" is
the deadline itself. Every pass: no container swap, host swap at most 0.37 GiB
(idle UAT pages, moved out once and never grown), no OOM kill.

### Why CPU share works and the others don't

- **The cause.** Each container is a cgroup with weight 100, whatever it holds. On a
  full host, four layout threads in one or two containers take their four cores,
  and seven parse children and seven JVMs share the other four: the parser fell
  from 7.0 cores to 3.9-4.1, waiting for CPU 62-77% of the time.
- **`--cpu-shares 128`** sets the layout containers' weight to 5, against the
  parser's 100. The parser then gets what it asks for (6.8 cores), and the pool gets
  what is left (1.05 cores), waiting 84% of the time. When the parser is idle, the
  pool has the whole host, so it pays nothing for the protection.
- **`nice 19` does nothing here.** It ranks processes inside one cgroup. Each layout
  container only competes with itself.
- **`--cpus 1` on each** protects less and slows the pool more. A cap limits the
  pool to 2 cores even when the host is idle, and on a full host it still takes
  those 2 at equal weight. With spinning on, the parser rose to 539 s, and the slowest
  document reached 88% of the deadline.
- **Spinning off matters under contention.** A spinning thread holds a core while it
  waits for its partner, which may be off CPU. With shares 128, turning it off took
  the parser from +7% to +2-3% and the pool from 0.72 to 0.85 pages/s.
- **Shares 2 are no better than 128.** The parser gains nothing measurable, and a
  page occasionally stalls for 15 s.
- **The 10-13% on Scenarios A and C remains even with low priority.** The parser is
  not short of cores there. The pool uses the idle ones, 2.4-2.6 cores, and the two
  appear to slow each other through shared resources on the machine. I did not
  isolate which. It costs far less than the deadline's margin: 131 s and 376 s.

### Two instances or one

| Four threads in total | Parser idle | Beside Scenario A | Beside a full queue |
|---|---:|---:|---:|
| 1 × 4: pages/s, parser wall | 2.83 | 1.46, 139 s | 0.86, 392 s |
| 2 × 2: pages/s, parser wall | 3.29 | 1.81, 135 s | 0.85, 381-384 s |

A single page is faster on one instance when idle (0.34 s against 0.60 s), but a
burst finishes sooner on two. 2 × 1 is the most efficient on a full queue (0.92
pages/s, no parser slowdown) but reaches only 1.85 pages/s when idle, so 2 × 2 is
the better all-round choice. Three or more instances would add memory and no CPU.

## Resource picture

What each part uses at each stage, from one sample a second. CPU is average cores
over the pass. "A + pool" and so on use the recommended settings.

| CPU, cores | Idle | Scenario A | Scenario D | Pool alone | A + pool | C + pool | D + pool |
|---|---:|---:|---:|---:|---:|---:|---:|
| Parser: Java (ODL) | – | 1.22 | 1.10 | – | 1.23 | 0.79 | 1.05 |
| Parser: children (flatten, refine, page renders) | – | 4.03 | 5.81 | – | 4.00 | 4.32 | 5.72 |
| Parser: API | – | 0.06 | 0.05 | – | 0.05 | 0.04 | 0.05 |
| Parser: OCR | none | none | none | none | none | none | none |
| Layout pool | – | – | – | 3.81 | 2.44 | 2.62 | 1.05 |
| UAT parser | 0.005 | 0.004 | 0.004 | 0.005 | 0.004 | 0.004 | 0.004 |
| UAT coordinator, worker, import worker, sampler | 0.003 | 0.003 | 0.003 | 0.003 | 0.003 | 0.003 | 0.003 |
| `capy-library-db` | 0.006 | 0.006 | 0.006 | 0.006 | 0.005 | 0.006 | 0.005 |
| `capy-odl-agentic-db` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Host busy** | **0.05** | **5.49** | **7.05** | **3.87** | **7.84** | **7.85** | **7.95** |

| Memory, GiB at peak | Idle | Scenario A | Scenario D | Pool alone | A + pool | C + pool | D + pool |
|---|---:|---:|---:|---:|---:|---:|---:|
| Parser: Java RSS | – | 4.90 | 7.21 | – | 4.99 | 4.44 | 7.55 |
| Parser: children RSS | – | 2.22 | 5.42 | – | 2.24 | 4.03 | 5.45 |
| Parser: API RSS | – | 0.53 | 0.83 | – | 0.42 | 0.59 | 0.98 |
| Parser container: anon (real) | – | 5.86 | 9.04 | – | 5.96 | 5.90 | 9.34 |
| Parser container: file cache | – | 0.27 | 0.90 | – | 0.34 | 0.74 | 1.04 |
| Layout pool: anon (real) | – | – | – | 1.01 | 1.01 | 1.01 | 1.01 |
| UAT stack: anon (real) | 0.43 | 0.43 | 0.43 | 0.38 | 0.24 | 0.24 | 0.24 |
| `capy-library-db`: anon (real) | 0.01 | 0.01 | 0.01 | 0.01 | 0.00 | 0.00 | 0.01 |
| `capy-library-db`: file cache | 2.89 | 2.89 | 2.35 | 1.58 | 0.81 | 0.81 | 0.81 |
| `capy-odl-agentic-db`: anon, cache | 0.00, 0.04 | 0.00, 0.04 | 0.00, 0.03 | 0.00, 0.02 | 0.00, 0.01 | 0.00, 0.01 | 0.00, 0.01 |
| Host: anon | 0.69 | 6.68 | 10.15 | 1.64 | 7.58 | 7.69 | 11.25 |
| Host: page cache, lowest | 9.42 | 7.13 | 3.22 | 2.32 | 1.45 | 1.54 | 1.42 |
| Host: available, lowest | 13.49 | 7.49 | 3.98 | 12.54 | 6.68 | 6.56 | 2.98 |
| Host: swap in use | 0.06 | 0.06 | 0.07 | 0.12 | 0.37 | 0.37 | 0.37 |

| Disk and network | Scenario A | Scenario D | Pool |
|---|---:|---:|---:|
| Parser writes in the pass | 0.9 GiB | 2.1 GiB | – |
| Parser reads (inputs once cached: about 0) | 117 MiB | 152 MiB | – |
| Spool + work at peak | 226 + 342 MiB | 431 + 1,066 MiB | – |
| Layout disk | – | – | none after loading; 130 MB model, 179 MB venv on disk |
| Host network in a pass (SSH, WireGuard) | under 1 MiB | under 3 MiB | under 1 MiB |

**Real demand against cache:**
- **The lab databases need almost nothing.** `capy-library-db` holds 0.01 GiB of its
  own memory. The 2.9 GiB it shows is page cache up to its 3 GiB limit, which fell
  to 0.8 GiB under load with no effect, since nothing was reading it. `capy-odl-agentic-db`
  uses a few MiB. Neither took CPU in any pass.
- **The host's real demand when idle is 0.7 GiB.** The other 9.4 GiB in use is cache,
  and 13.5 GiB is available.
- **The pool's real demand is 1.0 GiB, and it shows up directly.** The lowest
  available memory on a full queue fell by about 1 GiB when the pool was added.
  Through the service it is 1.4 GiB (0.72 GiB an instance), since an instance also
  holds the page images waiting their turn.

**Not measured:** the UAT stack was idle, so these numbers hold nothing for busy
ingest workers or the coordinator, or for a busy UAT parser. Their limits are below.
They run at the same weight 100 as the parser, so busy workers can take CPU from it
the way the unprotected pool did, though each is capped at 1 CPU. Layout network
use is small: a page is about 120 KB, so a 40-page burst is about 5 MB.

### Limits against the host

| Stack | CPU limit | Memory limit (with swap) |
|---|---:|---:|
| Production shape: parser | 8 | 14 GiB (18) |
| Production shape: coordinator | 1 | 1.25 GiB (1.5) |
| Production shape: four ingest workers | 4 | 4 GiB (5) |
| Production shape: two import workers | 1 | 0.5 GiB (0.75) |
| UAT as deployed: parser, coordinator, worker, import worker | 4 | 7.75 GiB (10.25) |
| `capy-library-db` | none | 3 GiB (6) |
| `capy-odl-agentic-db` | 2 | 2 GiB (4) |
| Layout pool, as recommended | none (4 threads) | 2 GiB (2) |
| **All together** | **20, plus two with no limit** | **34.5 GiB (47.5)** |
| **The host** | **8** | **15.6 GiB (39.6)** |

So the limits say nothing about whether everything fits at once. On a full parser
queue with the pool, 3.0 GiB was left (2.1 GiB in one run). That is not enough for
busy production workers at their limits (5.75 GiB) without using swap, which is
already true of the parser without the pool. The pool makes that margin 1 GiB
smaller.

## Crash recovery

**Verdict: yes, it picks itself back up, with no pages lost.** The service holds
nothing, so a restart only costs the model load (0.5-0.9 s, 2.4 s beside a full
parser queue) and the requests in flight, which callers retry. Two cases do not heal
under a restart policy alone. A hung process needs a health check that kills it, and
a `docker kill` by hand stays down.

### The prototype

Epo's design follows the parser's pattern: a small stateless service, page image in
and boxes out, one page a request, with a depth limit and no queue of its own. Past
the depth it answers 429, and the caller waits about 2 s and tries again.
`scripts/layout_service.py` is that design, for the test only.

- **Instances.** Two, 2 threads each, shares 128, spinning off, with `--init`,
  `--restart unless-stopped` and a Docker health check. The port opens only after
  the model has loaded, so "answering" includes the load.
- **Callers.** `scripts/layout_callers.py`: two callers, one 40-page burst at a time,
  four pages in flight each. A page is retried after about 2 s on a 429, a refused
  or reset connection, a failed name lookup or a timeout, at a random instance. Past
  its bound it returns `use fallback`, standing in for the box call. Each answer is
  checked against the page it asked for and the boxes that page gave before.
- **Network.** A private `--internal` Docker network with no published port.

**Depth,** with 16 pages in flight and the parser idle. All three lose 5-9% against
running the model directly (3.29 pages/s) to HTTP and page transfer.

| Depth per instance | Pages/s | Page p50 | Page p95 | 429s per 100 pages |
|---:|---:|---:|---:|---:|
| 2 | 2.99 | 1.3 s | 14.8 s | 158 |
| **4** | **3.13** | **2.5 s** | **12.7 s** | **101** |
| 8 | 3.01 | 4.8 s | 7.3 s | 22 |

Throughput barely moves. A deeper limit is fairer, because a page waiting in line
beats one sleeping 2 s between tries. But the wait in line is also what a request
timeout has to cover, so I kept 4.

**Beside a full parser queue,** with depth 4 and 8 pages in flight, all 8 documents
succeeded in 400 s (slowest 395 s). The pool did 0.94 pages/s. A request took 8.0 s
at the median and 15.7 s at p95, and one of 400 passed the 20 s timeout then in use,
which is why the request timeout below is 30 s. The self-killing health check made no false kills across 13 minutes
of two full-queue runs, with the pool at weight 5.

### Each fault

The first seven rows ran with a 20 s request timeout. The rest ran with the
recommended 30 s, and with callers that skip an address that just failed this page.
The 450 MiB case ran both ways. Every case ran under steady bursts.

| Fault | Answering again after | Model load | Requests in flight | Pages | The other instance meanwhile |
|---|---:|---:|---|---|---|
| `kill -9` the serving process, 3 times | **1.55, 1.58, 1.60 s** | 0.58-0.66 s | 3-4 reset at once, all retried | all answered, slowest 4-6 s | too short to matter |
| PID 1 killed, the whole instance dies | **1.55 s** | 0.52 s | 4 reset, retried | all answered, slowest 8.5 s | too short to matter |
| `docker kill` | **not restarted**; 31.9 s, started by hand at 30 s | 0.78 s | 3 reset, retried | all answered, slowest 31 s | 1.69 pages/s alone, p50 2.4 s, p95 30 s |
| Out of memory: one spike past an 800 MiB limit | **2.31 s** | 0.88 s | 3 reset, retried | all answered, slowest 4.6 s | too short to matter |
| Out of memory: limit 450 MiB, under the model's need | killed on each page until raised: 9 restarts in 60 s, then 11 s after the limit was raised | 0.56-0.79 s each | reset each time, retried | all answered, slowest 37-52 s | 1.66-1.72 pages/s alone, p95 12 s |
| Hang (`kill -STOP`), restart policy only | **never**; unhealthy at 18 s, nothing restarts it; resumed by hand at 45 s | – | timed out at 20 s, retried | all answered, slowest 49 s | 1.0 pages/s for the pool |
| Hang, the ingest watchdog's logic, 20 s timeout | 71.5 s | 0.56 s | timed out, retried | 4 fell back at 60 s, the rest answered | 0.41 pages/s for the pool |
| Hang, the ingest watchdog's logic, 30 s timeout | 71.5 s | 0.51 s | timed out, retried | 1 fell back at 60 s, the rest answered | 0.39 pages/s for the pool |
| **Hang, the health check kills it** | **19.4 s** | 0.57 s | 4 reset at the kill, retried | all answered, slowest 22 s | 0.31 pages/s for the pool |
| Both killed at once, twice | **1.53-1.60 s** | 0.54-0.69 s | 5 reset, retried | all answered, slowest 3.7-4.5 s | none left |
| `docker restart` of both | **1.55, 1.76 s** | 0.57-0.58 s | 5 reset, 1 answered | all answered, slowest 5 s | none left |
| Full parser queue: `kill -9` | **2.43 s** | 0.77 s | 4 reset, retried | all answered, slowest 19 s | too short to matter |
| Full parser queue: hang, the health check kills it | **24.2 s** | 2.42 s | 4 reset, retried | all answered, slowest 41 s | 0.21 pages/s for the pool |
| Full parser queue: both killed | **2.72, 3.90 s** | 0.64, 2.41 s | 6 reset, retried | all answered, slowest 16 s | none left |

All 8 parser documents succeeded through the three full-queue faults, in 389 s with
the slowest at 383 s. The faults did not disturb the parser.

**What the rows mean:**

- **A crash is the easy case.** The kernel resets every connection at once, including
  requests waiting in line, so callers know straight away and retry.
- **`docker kill` is a manual stop to Docker.** It set the container to stay down, as
  `docker stop` does: `exited restarts=0`, with `unless-stopped` doing nothing. It
  needs a person. Killing PID 1 from outside, which is what a real crash looks like,
  does restart it.
- **A limit below the model's need makes a crash loop.** Docker doubles the wait
  between restarts (0.3, 0.5, 0.7, 1.1, 1.9, 3.4, 6.6, 13, 26 s), so raising the limit
  still waited 11 s for the backoff to finish. The pool stayed up on the other
  instance throughout. An instance peaks at 0.72 GiB, so the limit must stay above
  that.
- **A hang is the only fault that hurts the whole pool.** A stopped process still
  accepts connections, so its requests wait for their timeout, and new requests keep
  picking it. Callers spent most of those 19 s stuck on it, so the pool's throughput
  fell far below what the other instance could do. Ending the hang sooner matters
  more than the timeout's exact value.
- **One instance alone copes, with a long tail.** It does about half the pool's
  throughput, as expected, but a 429 and a 2 s wait is not a queue: a page that keeps
  losing the race waited up to 52 s. Past the 60 s bound it would take the box call,
  which is harmless.

### Nothing lost, nothing doubled

| Run | Bursts whole | Pages answered | Fell back | Lost | Answered twice | Wrong page |
|---|---:|---:|---:|---:|---:|---:|
| Faults, first run | 32 of 34 | 1,296 | 4 | 0 | 0 | 0 |
| Faults, second run | 23 of 23 | 919 | 1 | 0 | 0 | 0 |
| Fallback cases | 14 of 14 | 544 | 16 | 0 | 0 | 0 |
| Service beside a full queue | 10 of 10 | 400 | 0 | 0 | 0 | 0 |
| Faults beside a full queue | 8 of 8 | 320 | 0 | 0 | 0 | 0 |

The two partial bursts in the first run are the ones my safety stop cut when UAT was
deployed: it removed the callers mid-burst. Every page had one set of boxes in each
run. Retrying is safe because the service keeps nothing. The cost is a little
repeated work when a request times out but the instance finishes it anyway: 4 pages
in the first run, 1 in the service run and 1 after the whole pool hung.

### A caller that gets no answer

With a 30 s request timeout and a 60 s bound, I took the whole pool away for 75 s,
twice:

| Pool | Pages that fell back | Returned `use fallback` after | How they ended | Pool back after it was restored |
|---|---:|---:|---|---:|
| Both hung (`kill -STOP`) | 8 of 8 in flight | 60.0 s, all | two 30 s timeouts | 0.3 s |
| Both stopped (`docker stop`) | 8 of 8 in flight | 58.0-59.9 s | reset, then failed name lookups | 1.2-1.5 s |

The bound held exactly, because a caller's last try gets only what is left of it. Those
8 pages would take the box call. The next pages sent were answered once the pool was
back, every burst stayed whole, and no page fell back afterwards.

### Hung instances and the ingest watchdog

`deploy/ansible/ingest-host/files/capy_ingest_watchdog.py` runs per stack under
systemd. Every 15 s it finds the container labelled with that stack's compose project
and `service=parser`. It checks only when the stack has an active release and none
pending, and the container's revision label matches. After three polls in a row with
Docker's health at `unhealthy`, it takes the release lock and runs `docker restart`.

**It could not cover this service as written.** `service=parser` is hard-coded, two
matching containers raise `expected exactly one parser container`, and it belongs to
one stack's release state, while this pool is shared by UAT and production. Giving it
a service name, a loop over containers and a state of its own is a small change.

**It is also slower.** I ran its logic against one instance. Of the 71.5 s, 60 s went
on reaching the third poll and 10 s on `docker restart` waiting out a SIGTERM the
stopped process cannot act on. That is with a 5 s health interval. With the parser's
health settings (15 s, 8 retries), it would be about 3 minutes.

**The simplest thing that works is the health check itself.** `scripts/layout_health.py`
sends the serving process SIGKILL after three failed checks in a row. The container
exits and the restart policy does the rest: 19-24 s, and nothing on the host. It needs
`--init`, so that the killed process is not PID 1. I recommend this and no watchdog.

### Network

The host's `inet capy_ingest_filter` forward chain has `policy drop`, and
`net.bridge.bridge-nf-call-iptables=1` sends bridged traffic through it. So containers
on a Docker bridge can reach each other only on ports 53, 80 and 443. The first try, on
port 8091, passed its own health check and timed out on every request from another
container. The prototype uses port 80, and I changed no firewall rule.

The real service needs a decision here. The parser avoids this with `network_mode: host`
on the WireGuard address, and callers on the app host will have to reach the pool over
WireGuard too. Two instances on the host network need two ports, and callers need to
know both, where the prototype used a Docker DNS alias.

### Settings

| Setting | Value | Why |
|---|---|---|
| Instances, threads | 2, 2 each | see Answers |
| CPU | `cpu_shares: 128`, no `cpus` limit, `allow_spinning=0` | protects the parser |
| Memory | `mem_limit: 1g`, no swap | peak 0.72 GiB; 450 MiB made the crash loop above |
| Restart policy | `unless-stopped`, with `init: true` | a crash is back in 1.6 s |
| Health check | `/healthz` from its own thread; interval 5 s, timeout 3 s, retries 3, start period 10 s; kills the serving process after 3 failures | a hang is over in 19-24 s; no false kills at full load |
| Depth | 4 per instance | see the depth table |
| Request timeout | 30 s | worst request 27.9 s beside a full queue; a rare timeout only costs a retry; two tries fit the bound |
| Retry | about 2 s with 10% jitter, on 429, refused, reset, failed lookup or timeout; skip the address that just failed this page | as the parser's callers |
| Retry bound | 60 s per page, hard, then the box call | covers every crash and a hang with room; the box call costs little |

### Not covered

- **Restarting the Docker daemon or rebooting,** which would have hit the shared stack.
  `docker restart` of my own containers stands in. The August stress report found a
  daemon restart stops running containers; `unless-stopped` brings them back, and the
  service has nothing to lose.
- **Callers on another host.** These ran on the host's private bridge. WireGuard adds
  some latency and about 5 MB a burst.
- **A shared memory of bad addresses between callers.** Each page skips an address only
  after that page failed there. Sharing that across pages would cut the stall during a
  hang; I did not test it.
- **The safety stop and the deploy.** UAT was deployed at about 07:00 UTC, in the middle
  of the first fault run, and my watcher stopped that run as designed, with nothing
  wrong on either side. I reran what it cut. The second fault run, the fallback cases and
  the faults beside a full queue (07:05-07:28 UTC) overlapped the workflow
  "Deterministic UAT quality", which started at 07:00:58 UTC. During them, UAT's parser
  averaged at most 0.03 cores and its worker 0.01, so its load did not affect these
  numbers. My load did not visibly slow it: it took 41 minutes, against 39 for the last
  run. Its failure is explained under
  [What this run disturbed](#what-this-run-disturbed).

## Reproduce

Scripts are in `bench/extraction/scripts/`, inputs and pass lists in
`bench/extraction/fixtures/layout-capacity/`. On the host, under
`/opt/capy-layout-capacity-20261104`, with `scripts/`, `manifests/` (the fixtures),
`pages/`, `venv/` and `models/PP-DocLayout_plus-L_onnx/` in place:

```sh
python3 scripts/layout_capacity.py run plan-1-baselines.json
python3 scripts/layout_capacity.py run plan-2-together.json
python3 scripts/layout_capacity.py run plan-3-protected.json
python3 scripts/layout_capacity.py summarize results > summary.json
python3 scripts/layout_crash.py run depth4 --threads 2 --depth 4 --callers 2 --window 8 \
  --shares 128 --no-spin --cases steady:90
python3 scripts/layout_crash.py run service-d --scenario d --threads 2 --depth 4 --shares 128 \
  --no-spin --kill-after 3 --timeout 20 --cases steady:30
python3 scripts/layout_crash.py run faults --threads 2 --depth 4 --shares 128 --no-spin \
  --avoid-failed --timeout 30 --bound 60 --cases steady:30,kill9:1,docker_kill,kill_init,oom_spike,oom_loop,hang_nothing,hang_watchdog,hang_selfkill,kill_both:1,restart_set
python3 scripts/layout_crash.py run fallback --threads 2 --depth 4 --shares 128 --no-spin \
  --avoid-failed --timeout 30 --bound 60 --fallback-timeout 30 --fallback-bound 60 \
  --fallback-hold 75 --cases fallback_hung,fallback_down
python3 scripts/layout_crash.py run faults-d --scenario d --threads 2 --depth 4 --shares 128 \
  --no-spin --avoid-failed --kill-after 3 --timeout 30 --bound 60 --cases kill9:1,hang_selfkill,kill_both:1
python3 scripts/layout_crash.py summarize results/crash-faults > faults.json
```

Every container, volume, network, image and folder the bench made was removed
afterwards. The summaries of every pass are in
[`2026-11-04-layout-capacity.json`](2026-11-04-layout-capacity.json).
