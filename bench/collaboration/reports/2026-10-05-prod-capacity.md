# Collaboration capacity on the production box, 2026-10-05

How much editing the collaboration service handles on the production machine,
for Plate notes and Office files, with the service pinned to 1 core and then 2.
Epo approved running on the prod box (nothing deployed there yet) on
2026-10-05.

Code: main `875ab14d` plus this worktree's bench commit (stress options, the
Office engine queue fields on `collab_health`, multipart in the fake S3).
BetterOffice at the pinned `7ec9b41b`. Raw data, scripts and CPU profiles:
`capy-docx-review-harnesses/2026-10-05-prod-capacity/` (`runs/<step>/`
holds `summary.json`, the shard reports, raw latencies, `collaboration.log`
with the 20 s `collab_health` lines, `stats.log`, `mem.log`).

## Short version

- **Big note and DOCX rooms**: one room holds about 130 people typing. At 160
  a note room tips over within about 100 s, on 1 core and on 2 cores alike.
  The trigger is `validateUpdate` copying the whole room for each update it
  cannot place (bottleneck 1). Below the cliff the service is cheap: 2 rooms
  of 130 used 37% of one core.
- **Small rooms (5 people, half of them DOCX)**: 1 core passes 80 rooms
  (400 editors) and fails at 120. 2 cores pass 160 rooms (800 editors, p95
  0.97 s, marginal). What limits this is Office saves running on the main
  thread (bottleneck 3), plus the engine worker sharing the one core.
- **Office saves**: there is one engine worker and it runs one call at a
  time. Edits stay fast. Saves queue up: with the large-file mix the worker
  is 70% busy at 10 rooms and 100% at 20. After that, save time grows
  without bound (80 s at 20 rooms, 166 s at 30). Most of the worker's time
  goes to reopening the original file on every save (bottleneck 2). The
  large XLSX costs about 10 s of worker time per save.
- **Idle connections**: 10,080 idle connections in rooms of 30 used 294 MiB
  RSS (about 215 MiB above an empty service) and about a quarter of a core.
  The "10k idle on a small box" premise holds, at least for small notes.
- **2 cores**: worth it as a cpuset when Office rooms are a real share of the
  load. It gives the engine worker and GC their own core, which roughly
  halves small-room p95 and moves their break point from about 100 to about
  160 rooms. It does not raise the per-room ceiling, the main-thread ceiling,
  or Office save throughput.

## Setup

Box: 4 vCPU AMD EPYC-Rome 2.0 GHz, 7.6 GiB RAM, Ubuntu 24.04, Docker 29.4,
12 GiB swap added by Epo during the run (swappiness 10). CPU steal was 0 in
every sample.

- The stack is `deploy/docker-compose.e2e.yml` plus
  `bench/collaboration/scripts/docker-compose.stress.yml` (fake S3, indexing
  off, no external service), plus a capacity overlay that pins cores, uses
  its own images and points the gateway's token URLs inside the network.
- Compose project `capy-capacity`, work dir `/root/capy-capacity`.
- Images were built on the box from a `git archive` of the bench commit. The
  collaboration image took the Office runtime prebuilt at the pin, since WASM
  does not depend on the architecture.
- Load came from `stress.ts`, bundled into one file and run in 1 to 4
  generator containers (`STRESS_STACK=external`) on the same box.
- Each step got a fresh stack and a seeded owner on the Pro plan (the 24 MB
  PPTX is over the free 10 MiB cap).
- Each generator gets its own seeded workspace, which keeps each workspace
  under 100 files.
- Peers type a 10-character marker every 2 s on average (`STRESS_EDIT_MS=2000`,
  as on UAT). Each one drops offline for 1 to 5 s at 0.02 per second, 3
  minutes per step (Office: 4).

| Config | collaboration | Postgres, Redis, gateway, fake S3 | generators | Coolify |
| --- | --- | --- | --- | --- |
| 1 core | cpu 3 | cpu 2 | cpus 0-1 | unpinned, idle |
| 2 cores | cpus 2-3 | cpu 1 | cpus 0-1 (cpu 1 shared with the infra) | unpinned, idle |

Pass: marker p95 under 1 s, every marker present once, every peer and a late
joiner converged.

How to read the numbers:

- p50 sits near 32 ms because the service batches broadcasts over 30 ms
  (`flushDelay`).
- `collab_health` lag has a floor of about 22 ms, because the histogram's
  resolution is 20 ms.
- "collab CPU" is the container's share of one core (100 = one core).
  Its max is often the startup sample, so read the mean and p90.

**The load generator is a cap in the big rooms.** Every peer integrates every
update, so the generator does N times the server's send work:

- At 2×100 the generators used 154% of their 2 cores. At 2×130 they used
  185%, with their own event loop's p99 at 0.3–1.2 s.
- So the big-room latencies from 2×100 up include generator delay. The
  service's own lag p99 at those steps was 30–100 ms.
- The 2×160 collapse is on the server side: the service was pinned at 100%
  with 12 s of lag while the generators idled.

Excluded steps:

- `small2c-240x5`: memory guard. Swap-out started at 2.4 GiB available,
  with 4 generators holding 2.4 GiB.
- `prof-big1c-2x160`: guard, swap 6 to 8 MiB. Kept only for its CPU profile.
- The first `small1c-80x5`: two generators lost their uploads to the per-user
  ingest lease cap (429 `too_many_ingest_leases`). Uploads are store-only from
  then on (`parseMode: none`, as on UAT) and the step was rerun as
  `small1c-80x5b`. The earlier steps' uploads queued an ingest job that never
  ran. That doesn't touch the collaboration path.

No other step touched swap.

## 1. Plate and DOCX ladder

Big rooms are 2 rooms (one DOCX `exchange-plan.docx`, one Plate note) × N
peers. Small rooms are N rooms × 5 peers, alternating DOCX and Plate.

**1 core**

| step | rooms × peers | DOCX p50/p95/max ms | Plate p50/p95/max ms | missing / unconverged | collab CPU % mean/p90 | lag p99 ms mean/max | lag max ms | updates/s | store p95 max: note / Office ms | collab RSS MiB | DB CPU % mean/max | gateway CPU % mean/max | generator CPU % / its lag p99 ms | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2x20 | 2 × 20 | 32/38/361 | 32/41/280 | 0 / 0 | 14/16 | 24/26 | 272 | 22 | 87 / 1287 | 218 | 9/14 | 2/6 | 15 / 24 | pass |
| 2x40 | 2 × 40 | 31/37/241 | 31/40/247 | 0 / 0 | 17/17 | 23/26 | 220 | 43 | 56 / 1342 | 244 | 12/18 | 3/9 | 39 / 31 | pass |
| 2x60 | 2 × 60 | 31/39/284 | 31/41/237 | 0 / 0 | 21/22 | 25/28 | 215 | 64 | 61 / 1310 | 215 | 9/17 | 3/12 | 74 / 43 | pass |
| 2x80 | 2 × 80 | 31/57/862 | 31/45/778 | 0 / 0 | 25/29 | 25/28 | 183 | 86 | 78 / 1338 | 244 | 14/24 | 4/15 | 115 / 59 | pass |
| 2x100 | 2 × 100 | 37/117/2863 | 32/76/1361 | 0 / 0 | 29/30 | 30/38 | 183 | 106 | 98 / 1585 | 268 | 12/25 | 5/14 | 154 / 123 | pass |
| 2x130 | 2 × 130 | 97/865/26561 | 59/636/2349 | 0 / 0 | 37/82 | 72/315 | 936 | 130 | 1777 / 1673 | 346 | 13/27 | 5/10 | 185 / 709 | pass |
| 2x160 | 2 × 160 | 600/130448/211591 | 442/27623/184867 | 29 / 2 | 69/101 | 3368/11786 | 12256 | 81 | 85073 / 69902 | 436 | 6/27 | 3/16 | 109 / 373 | FAIL |
| 20x5 | 20 × 5 | 32/67/338 | 32/80/873 | 0 / 0 | 21/53 | 60/98 | 212 | 54 | 171 / 1699 | 327 | 13/19 | 3/5 | 18 / 22 | pass |
| 40x5 | 40 × 5 | 32/142/883 | 32/183/1460 | 0 / 0 | 37/101 | 86/126 | 562 | 107 | 561 / 3488 | 550 | 16/27 | 5/15 | 33 / 24 | pass |
| 80x5 | 80 × 5 | 34/392/1788 | 35/402/2144 | 0 / 0 | 61/101 | 148/249 | 699 | 214 | 1874 / 5232 | 754 | 25/38 | 7/11 | 57 / 28 | pass |
| 120x5 | 120 × 5 | 186/3719/10288 | 170/1834/6196 | 0 / 0 | 85/101 | 283/375 | 1128 | 316 | 5058 / 16081 | 909 | 35/62 | 9/30 | 73 / 38 | FAIL |

**2 cores**

| step | rooms × peers | DOCX p50/p95/max ms | Plate p50/p95/max ms | missing / unconverged | collab CPU % mean/p90 | lag p99 ms mean/max | lag max ms | updates/s | store p95 max: note / Office ms | collab RSS MiB | DB CPU % mean/max | gateway CPU % mean/max | generator CPU % / its lag p99 ms | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2x20 | 2 × 20 | 32/37/150 | 32/41/127 | 0 / 0 | 8/12 | 22/22 | 127 | 21 | 42 / 708 | 165 | 9/14 | 2/5 | 20 / 24 | pass |
| 2x40 | 2 × 40 | 32/38/152 | 31/41/171 | 0 / 0 | 17/22 | 22/23 | 109 | 42 | 43 / 744 | 174 | 11/16 | 2/8 | 43 / 33 | pass |
| 2x60 | 2 × 60 | 31/40/358 | 31/41/155 | 0 / 0 | 20/21 | 23/23 | 113 | 64 | 77 / 724 | 176 | 12/18 | 2/10 | 70 / 46 | pass |
| 2x80 | 2 × 80 | 31/59/1344 | 31/46/773 | 0 / 0 | 25/26 | 23/24 | 104 | 85 | 86 / 775 | 195 | 12/20 | 3/7 | 111 / 66 | pass |
| 2x100 | 2 × 100 | 36/160/1004 | 32/97/702 | 0 / 0 | 29/31 | 27/28 | 156 | 105 | 87 / 814 | 232 | 12/17 | 4/15 | 146 / 152 | pass |
| 2x130 | 2 × 130 | 110/1168/75051 | 85/897/2119 | 0 / 0 | 43/90 | 102/272 | 1059 | 125 | 784 / 1066 | 348 | 15/29 | 4/18 | 170 / 1167 | FAIL (generator) |
| 2x160 | 2 × 160 | 443/17544/117606 | 325/13616/125058 | 5 / 1 | 55/107 | 2113/8091 | 8091 | 82 | 28454 / 28564 | 367 | 9/32 | 3/18 | 108 / 586 | FAIL |
| 20x5 | 20 × 5 | 32/62/213 | 32/49/608 | 0 / 0 | 31/80 | 47/67 | 175 | 54 | 89 / 1167 | 309 | 13/19 | 2/7 | 21 / 22 | pass |
| 40x5 | 40 × 5 | 32/84/522 | 32/99/850 | 0 / 0 | 42/122 | 57/82 | 242 | 107 | 128 / 1235 | 506 | 17/38 | 4/8 | 31 / 24 | pass |
| 80x5 | 80 × 5 | 33/155/764 | 33/154/952 | 0 / 0 | 72/152 | 94/131 | 323 | 213 | 453 / 1696 | 692 | 26/34 | 7/11 | 55 / 28 | pass |
| 120x5 | 120 × 5 | 36/293/1900 | 38/284/1542 | 0 / 0 | 78/150 | 125/163 | 484 | 317 | 1169 / 2956 | 825 | 32/46 | 8/14 | 72 / 44 | pass |
| 160x5 | 160 × 5 | 91/967/4333 | 89/652/2497 | 0 / 0 | 110/166 | 166/234 | 806 | 414 | 2120 / 6717 | 905 | 42/62 | 11/25 | 85 / 75 | pass |

Big rooms:

- 2×130 failing at 2 cores but passing at 1 core is the generator: its own
  lag p99 was 1.2 s, against 0.7 s in the 1-core run.
- **The 2×160 failure is the same on both core counts.** Timeline at 1 core:
  - For about 90 s the service sat at 30% CPU.
  - Then the note room's stores jumped from 80 ms to 1.2 s, 2.8 s and 29 s,
    and the service stayed at 100% for 4 minutes.
  - Event-loop lag reached 12 s. The gateway then closed the service's
    access-check requests, and 112 connections were closed on `fetch failed`.
  - Peers fell into reconnect loops, which made it worse.
- The 29 "missing" DOCX markers were each held only by their own author. That
  peer was still unsynced when the 120 s settle window ended. So they were
  undelivered at the deadline, not lost after reaching the server.

Small rooms:

- The DB peaked at 42% (mean) and the gateway at 11%. Neither came near
  limiting.
- Small rooms are slower than big rooms at the same update rate, even with
  lower CPU: 40×5 has p95 142–183 ms at 107 updates/s, while 2×100 has 76–117
  ms at 106 updates/s. The difference is 20 DOCX rooms each saving about
  every 5–30 s (see bottleneck 3).

## 2. Concurrent Office rooms with large files

Each room has 4 editors and runs 4 minutes. The files cycle in this order:

1. `jp_llm2.pptx` (24 MB, 84 slides)
2. `large-gradebook.xlsx` (8 sheets, 16,000 rows)
3. `long-handbook.docx` (62 pages)
4. `lecture.pptx`
5. `course-guide.xlsx`
6. `exchange-plan.docx`

DOCX and PPTX peers type into story text. XLSX peers each write their own cells
in column 40 and up of the first sheet. Every Office save succeeded. There
were no engine timeouts, no slow-save failures and no errors logged.

| step | rooms × editors | DOCX p50/p95/max | XLSX p50/p95/max | PPTX p50/p95/max | collab CPU % mean/p90 | lag p99 mean/max, lag max ms | engine busy % mean/max | engine queue max, wait max ms | engine call max ms | Office saves (n), p95 max / max ms | collab RSS MiB mean/max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 core, 2 | 2 × 4 | - | 32/41/622 | 32/40/265 | 39/101 | 24/30, 556 | 29/45 | 1, 11682 | 8304 | (14) 10061 / 10061 | 560/631 |
| 1 core, 5 | 5 × 4 | 32/57/293 | 32/41/49758 | 32/41/352 | 46/101 | 26/31, 321 | 34/48 | 4, 15939 | 7614 | (36) 10483 / 10483 | 761/906 |
| 1 core, 10 | 10 × 4 | 33/129/996 | 32/180/1103 | 33/148/1103 | 77/101 | 38/51, 1078 | 70/100 | 7, 19170 | 8305 | (73) 24453 / 24453 | 948/1175 |
| 1 core, 20 | 20 × 4 | 33/302/1850 | 33/375/1910 | 33/334/1931 | 101/102 | 58/197, 1092 | 100/100 | 20, 40359 | 8867 | (86) 78666 / 78666 | 1033/1431 |
| 1 core, 30 | 30 × 4 | 33/240/1926 | 33/186/1899 | 33/205/1912 | 101/101 | 77/170, 886 | 100/101 | 30, 61488 | 8990 | (67) 166452 / 166452 | 1032/1472 |
| 2 cores, 2 | 2 × 4 | - | 32/38/315 | 32/39/382 | 42/136 | 22/25, 394 | 24/43 | 1, 6290 | 7542 | (14) 7610 / 7610 | 564/625 |
| 2 cores, 5 | 5 × 4 | 32/47/393 | 32/43/977 | 32/44/523 | 50/109 | 25/30, 543 | 32/55 | 4, 9290 | 7989 | (36) 8149 / 8149 | 685/799 |
| 2 cores, 10 | 10 × 4 | 32/46/459 | 32/61/358 | 32/61/434 | 86/119 | 30/38, 394 | 61/90 | 7, 11246 | 8341 | (70) 18606 / 18606 | 878/1019 |
| 2 cores, 20 | 20 × 4 | 32/184/757 | 32/175/1090 | 32/188/825 | 113/135 | 41/60, 696 | 98/100 | 20, 34746 | 7648 | (99) 62454 / 62454 | 1169/1480 |
| 2 cores, 30 | 30 × 4 | 32/129/1327 | 32/141/1322 | 32/122/1299 | 120/144 | 55/157, 1013 | 98/101 | 30, 52091 | 8299 | (75) 135085 / 135085 | 1096/1568 |

One room per file (1 core, 3 min) separates the engine cost of each file. "Worker
s per save" is all engine time in the step divided by saves, room load included.

| file | worker s per save | engine call max ms | save max ms | share of the worker per continuously edited room | collab RSS MiB max |
|---|---|---|---|---|---|
| `large-gradebook.xlsx` | 10.1 | 7282 | 9244 | about 28% | 312 |
| `long-handbook.docx` | 1.7 | 2614 | 3542 | about 5% | 246 |
| `jp_llm2.pptx` (24 MB) | 1.1 | 1572 | 2237 | about 3% | 373 |
| 3 small rich-content files | 0.8 | 1658 | 1494 | about 2.5% each | 219 (all 3) |

What this shows:

- The XLSX dominates. The 20-room mix holds 4 gradebooks, about 110% of a
  worker, so the worker sits at 100%.
- The queue then grows by one call per room: 20 deep at 20 rooms and 30 deep
  at 30.
- Saves fall minutes behind. On 2 cores they finish about 20% sooner (62 s
  instead of 80 s at 20 rooms), because the worker gets a whole core.
- None of the 120 s per-call timeouts fired, because a call's timeout does not
  count its time in the queue. Saves just take longer and longer.
- Edit latency stays under 0.4 s p95. On 2 cores it is 2–3× lower at 10 to
  20 rooms (p95 61 against 180 ms at 10).

## 3. Idle connections

These are Plate notes in rooms of 30 (29 peers and the watcher). Nobody types.
The provider renews awareness as normal, every 15 s. Collaboration runs on 1
core.

| step | connections | rooms | collab CPU % mean/p90 (join included) | steady CPU % | lag p99 mean/max ms | awareness/s | collab RSS MiB max | generator RSS MiB | MemAvailable min MiB |
|---|---|---|---|---|---|---|---|---|---|
| 1k | 1,080 | 36 | 8/15 | about 4 | 22/25 | 67 | 102 | 232 | 5247 |
| 5k | 5,040 | 168 | 24/41 | 15–20 | 25/32 | 304 | 202 | 669 | 4778 |
| 10k | 10,080 | 336 | 33/51 | 23–30 | 27/36 | 578 (680 steady) | 294 | 1083 | 4243 |

What this shows:

- An empty service is 79 MiB.
- 10k connections add about 215 MiB, that is about 21 KB per connection with
  its share of a small note room.
- Inbound awareness is exactly one frame per connection per 15 s, so provider
  3.4.4's echo did not multiply renewals.
- The memory guard never came near tripping.

## What saturates first

| Load | First limit | Evidence |
| --- | --- | --- |
| Few big rooms | One note room's main-thread cost cliff at about 130–160 typing peers (bottleneck 1). Earlier, on this box, the load generator. | 2×160 collapses on 1 and 2 cores; validate copy 0.1 → 18 s per 20 s |
| Many small rooms with Office files | Main-thread stalls from Office saves (bottleneck 3). On 1 core, also the worker competing with the main thread. | lag p99 22 ms in windows without source saves, 74–126 ms with them (`small1c-40x5`) |
| Concurrent large Office files | The single engine worker (bottleneck 2) | worker 100% busy, queue = rooms, saves 62–166 s |
| Idle connections | Nothing within the box. CPU about 0.25 core and 215 MiB per 10k | idle table |
| Postgres, gateway | Never | DB at most 42% mean, gateway at most 11% |

## Capacity estimate

These figures assume the mix above: an edit every 2 s per person, each edit
one 10-character insertion, Plate and DOCX. Real typing is bursty, and real
cursors add awareness frames these peers don't send, so read them as upper
bounds per core.

- **Active editors, big rooms**:
  - Up to about 130 per room.
  - Below that, a delivered update costs about 20–25 µs of service CPU, all
    included: 2×100 is 10.6k deliveries/s at 0.29 core, and 2×130 is 17k
    deliveries/s at 0.37 core.
  - On paper a core would carry about 40k deliveries/s. In practice the cliff
    stops a single room first.
- **Active editors, small rooms, half of them DOCX**:
  - About 400 per core on 1 core (80 rooms, 214 updates/s, p95 0.4 s).
  - About 600 comfortably, 800 at the limit, on 2 cores.
- **Office rooms**:
  - One engine worker handles about 3 continuously edited 16,000-row
    workbooks, about 20 large DOCX or about 30 large PPTX.
  - For the mixed set that is 10–15 rooms before saves start to lag.
  - RAM is not the limit: 30 rooms used at most 1.5 GiB.
- **Idle connections**:
  - About 45,000 per GB of service RSS, with small notes.
  - About 40,000 per core of awareness work in rooms of 30.

## Is a second core worth it, and how

A cpuset with 2 cores (no code change) is worth it as soon as Office rooms are
in the mix:

| | 1 core | 2 cores |
| --- | --- | --- |
| small rooms, p95 at 40/80/120 rooms | 183 / 402 / 3719 ms | 99 / 155 / 293 ms |
| largest passing small-room step | 80 × 5 | 160 × 5 |
| Office edit p95 at 10 / 20 rooms | 180 / 375 ms | 61 / 188 ms |
| Office save max at 20 / 30 rooms | 79 / 166 s | 62 / 135 s |
| big room collapse | 2 × 160 | 2 × 160 |

Node runs JavaScript on one thread, so what the second core buys is:

- the Office engine worker on its own core;
- GC and libuv off the main thread's core.

It does not raise one room's ceiling, the main thread's throughput, or Office
save throughput. There is still one worker running one call at a time.

Next steps, in order:

1. **cpuset 2 cores now.**
2. **Fix bottleneck 2, or run a pool of 2 engine workers** when more than about
   10 large Office rooms are edited at once. A pool uses the second core for
   saves, which a second instance would also do, but without any routing.
3. **A second instance only when the main thread itself runs out**: sustained
   lag p99 near 100 ms with saves cheap, about 400 small-room editors per
   instance today. It needs document-sticky routing, because the Redis
   extension is gone and a document must live on one instance:
   - The gateway's collaboration-token response already returns the
     WebSocket URL. It can hash the room name to an instance URL.
   - The gateway's internal commands (`COLLABORATION_INTERNAL_URL`) must go
     to the same instance.
   - Traefik can't do this alone. Its sticky sessions follow the client,
     not the document.

## Top 3 code-level bottlenecks

**1. Note rooms copy the whole room for each update they cannot place.**

Code: `collaboration/src/persistence.ts`, `validateUpdate` (567–590) with
`updateKeepsMaterialRoots` (522–532).

- `updateKeepsMaterialRoots` returns `null` in two cases: the room holds
  pending structs, or the update refers to content the room does not hold
  yet. Then `validateUpdate` copies the room, which means encoding it,
  applying it into a scratch doc and applying the update. That happens on
  every such update.
- A reconnecting peer that types before its sync step 2 lands sends only
  such updates. Under lag, syncs take longer, so more updates take the copy
  path. That feedback loop is the cliff.

Evidence, from the 1-core 2×160 profile (`runs/prof-big1c-2x160/prof`):

- `validateUpdate` was 93.5 of 152.8 busy main-thread seconds.
- It went from 0.1 s per 20 s window for the first 80 s to 13.6–18 s per
  window by 120 s.
- A third of it was `mergeUpdates` inside `encodeStateAsUpdate`, which only
  runs when the room has pending structs.
- Plate measurement (`plateValue`, `yTextToSlateElement`) does not appear,
  so this is the copy, not the measure.
- The second core made no difference: 2×160 at 2 cores collapsed the same way.

Direction: when an update cannot be placed, resync that connection, as Office
rooms already do (`resyncUnheld`), instead of copying the room. That needs a
decision on read-only semantics for the one message, as in `officeRoots.ts`.

**2. The Office engine reopens the original file on every save, on one worker.**

Code:

- `vendor/betteroffice/shared/office-checkpoint.ts`: `open()` for XLSX
  (976) is `XlsxDocument.openCollaborative(baseBytes)` followed by
  `applyUpdateJson(checkpoint.state)`. It runs for every
  `xlsxPendingEffects` call (1564).
- `collaboration/src/sourceDocuments.ts`: saves call it at 852 for effects.
  `officeBaseline` at 828 does the same kind of reopen.
- `collaboration/src/officeRuntime.ts`: one worker, one call in flight.

Evidence:

- In the 20-room profile (`runs/prof-office1c-20/prof`, worker thread), the
  worker was busy for 347 s.
- 226 s of that (65%) was `openCollaborative` and 64 s (18%) was
  `applyUpdateJson`.
- `openCollaborativeFromUpdate`, the open from saved state, was only 10 s.
- The profile does not split the opens by format, because async frames hide
  the caller. The one-file runs put most of it on the XLSX rooms: a gradebook
  save costs about 10 s of worker time, against about 1 s for the 24 MB PPTX.

Direction:

- Keep the opened base, or the seed state, per file in the worker, so the
  effects come from the room's overrides without parsing the workbook again.
- Then a second worker, if needed.
- This is a BetterOffice and Capy change. It goes through the capy-ci flow.

**3. Office saves run several full passes over the room on the main thread.**

Code: `collaboration/src/sourceDocuments.ts`:

- `storeSnapshot` (1034–1080): merge the durable state and the snapshot,
  then encode;
- `seedChange` and `rebuildState` (252–300): apply the state, encode the
  change, rebuild seed plus change, then re-encode both and compare.

Also `collaboration/src/contributors.ts`: `roomSnapshot` and
`applyContentUpdate` (87–110).

Each of these runs synchronously between awaits.

Evidence:

- In the small-room profile (`runs/prof-small1c-40x5/prof`, 20 DOCX + 20
  note rooms), these frames take about 21 of 49 busy main-thread seconds.
  In the Office profile they take 23 of 57.
- In `small1c-40x5`, lag p99 was 22–24 ms in 20 s windows without Office
  saves and 74–126 ms in windows with 8–20 of them.
- That is why small-room p95 rises while mean CPU is still at 37–60%.
- GC is next, at 5–11 s per profile.

Direction:

- Pass the encoded bytes along instead of re-applying them.
- Run the rebuild-and-compare check in the worker, or drop it once the seed
  is cached.
- Do the snapshot merge off the main thread.

Smaller items:

- Broadcast socket writes (`sendFrame`/`writev`) were about 13 s of 153 in
  the big-room profile.
- Awareness was cheap in this test, because the stress peers never move a
  cursor.

## Reproduce

Upload the harness's `box/` directory to the box, build the two images there
(`build.log`), then run the plan files with `ladder.sh`:

- `plan-ladder.txt`, `plan-ladder-2c.txt`, `plan-office.txt`,
  `plan-idle.txt`, `plan-rerun.txt`.
- `run-step.sh` runs one step: a fresh stack, a seed, pinned generators, the
  memory and swap guard, logs, teardown. `PROFILE=1` adds a CPU profile.
- `summarize.mjs` and `tables.mjs` build the tables. `owners.cjs` and
  `callers.cjs` attribute profiles.
- After the run, everything was removed from the box: the project's
  containers, networks, volumes, images (including the pulled
  `pgvector/pgvector:pg16`), build cache and work dir.

## Follow-up: bottlenecks 1 and 3 fixed (same day)

Epo approved both fixes on 2026-10-05:

- **Bottleneck 1** (`8b868c40`): a note update the room cannot place yet is
  refused and its connection resynced, as source rooms already did. The room
  is no longer copied for it.
- **Bottleneck 3** (`ff2499bd`): an Office save takes the change over the
  seed from the merged document it already holds. It no longer re-applies
  the state into a fresh document. One event-loop turn now separates two of
  its whole-document passes.

Before is main `a379d7ea`, after is `ff2499bd`. Both ran on the same box with
the same harness, generator bundle and BetterOffice build, sequentially, on
1 core. Raw runs and the profile script (`prof.cjs`) are in
`capy-docx-review-harnesses/2026-10-05-collab-hotpaths/`. Every step below
has a CPU profile (`PROFILE=1`), and none touched swap.

**Note rooms** (one room per generator, typing every 2 s, drops 0.02/s):

| step | busy s (validateUpdate s) | lag p99 mean/max ms | note store p95 max ms | marker p95 ms | verdict |
|---|---|---|---|---|---|
| 2×100 (DOCX + note), before | 36.4 (0.8) | 31/38 | 100 | 88 DOCX, 67 note | pass |
| 2×100 (DOCX + note), after | 32.5 (0.9) | 31/38 | 122 | 98 DOCX, 65 note | pass |
| 1×160 note, before | 113.7 (66.7) | 1010/4664 | 4881 | 11226 | FAIL |
| 1×160 note, after | 20.7 (1.3) | 30/31 | 276 | 579 | pass |
| 1×200 note, before | 257.3 (163.0) | 4701/11560 | 51533 | 53743 (337 missing, 1 unconverged) | FAIL |
| 1×200 note, after | 24.2 (1.5) | 35/39 | 155 | 1041 | FAIL (generator) |

- The cliff is gone. At 160 and 200 peers the service stays at 22% of its
  core, and `validateUpdate` is 1.5 s instead of 163 s.
- After the fix, 1×200 misses the 1 s budget because of the load generator:
  its own lag p99 was 2.6 s, while the service's lag p99 stayed at 39 ms.
- The 2×160 shape from the ladder (DOCX + note) could not be measured today.
  Every attempt tripped the swap guard at 60–80 s, during the join ramp, at
  2.6–2.8 GiB available: before and after, with and without a profile, and
  with two note rooms as well. The 160-peer DOCX generator alone holds
  1.4 GiB. That is why the shape above is one note room per generator.

**Office saves** (main-thread time in the save path, from the profile, divided
by the source saves in the step):

| step | saves | main thread per save ms | lag p99 mean, windows with saves ms | lag max per window mean/max ms | edit p95 ms |
|---|---|---|---|---|---|
| Office 10 rooms (large files), before | 72 | 213 | 37 | 532/975 | 196 DOCX, 236 XLSX, 220 PPTX |
| Office 10 rooms (large files), after | 75 | 153 | 40 | 385/509 | 76 DOCX, 110 XLSX, 142 PPTX |
| 20 DOCX + 20 note rooms × 5, before | 102 | 207 | 101 (23 without) | 404/642 | 219 DOCX, 264 note |
| 20 DOCX + 20 note rooms × 5, after | 105 | 150 | 84 (22 without) | 247/442 | 148 DOCX, 174 note |

- Main-thread time per save fell about 28%, and the longest stalls by 30–48%.
- In the small-room mix, note store p95 max went from 710 to 177 ms.
- On a Mac, per save of `long-handbook.docx`, `seedChange` went from 84 to
  38 ms, and the whole save path from about 154 to 108 ms.
- The engine worker is unchanged at 70% busy, which is bottleneck 2.

What a save still does on the main thread:

- one encode of the room;
- one integration of the durable state;
- one decode of the room's state into it;
- one encode of the merged state;
- the rebuild check: an integration of the seed and the change, plus an
  encode.

The next cut would keep a live document per room in place of the durable
bytes. That saves the durable-state integration, at the memory cost of one
more document per open Office room. It is not done.
