# Rust collaboration server capacity on the production box, 2026-10-11

The Node/Hocuspocus collaboration server (main 3d549fb4, measured
2026-10-08) and the Rust server that replaces it (`capy-side/rust-core`
065ad3d1) ran the same capacity ladder on the production machine. Both had
production's collaboration cpuset (cores 2-3). The method is the
[2026-10-05 run](2026-10-05-prod-capacity.md)'s. The Rust server ran with
production's Office engine pool: 2 save and 1 background process, at 4 GiB
each. Epo allows bench runs on the prod box. Nothing is deployed there.

## Short version

- **As configured, the Rust server refuses connections past about 1,000
  sockets.**
  - It keeps the container's default open-file soft limit, 1024. Node and
    the Go gateway raise theirs at startup (the gateway ran at 524287 of a
    524288 hard limit).
  - With 200 small rooms (1,200 sockets), joins were refused, 1,648 typed
    markers were lost and 32 rooms did not converge.
  - With 10,080 idle connections it stopped at 1,002, and its healthcheck
    failed.
  - The fix (raise `RLIMIT_NOFILE` at startup in `main.rs`, plus compose
    `ulimits`) is committed on `capy-side/rust-core` (a234cfef), after the
    measured 065ad3d1. **The runs marked "open files raised" used a
    compose overlay (`ulimits: nofile: 524288`) in its place.**
- **With the limit raised, the Rust server beats Node on pass/fail,
  latency and CPU in every shape** (memory per connection is the exception,
  below):
  - **Small rooms of 5 (half DOCX):** it passes 280 rooms (1,400 editors)
    with p95 560/459 ms, at 0.76 core. Node failed at 200 rooms (p95 2.4 s,
    1.29 cores). Up to 160 rooms its p95 is 41-54 ms, against Node's
    125-606 ms. CPU per editor is about half (0.05-0.07% of a core against
    0.13-0.16%).
  - **Office large-file mix, 30 rooms:** edit p95 is 39 ms (Node 171 ms) and
    steady save p95 0.77 s (Node 2.0 s). The slowest save is 5.6 s (Node
    12.2 s). The service holds 1.65 GiB (Node 2.03 GiB).
  - **Big rooms (one DOCX and one note room):** it uses 0.20-0.28 core
    (Node 0.27-0.34), with scheduling lag p99 of 4 ms or less. The load
    generators on this box saturate from 2×130 people per room. So the
    per-room ceiling is still not measurable here.
  - **Idle 10,080 connections:** the same CPU as Node (0.27 core).
- **But each connection costs 151 KB, against Node's 27 KB:** 1.5 GiB for
  10k idle connections, against 0.3 GiB, and the memory is not given back
  after they leave.
  - The cause is tungstenite's default 128 KiB read buffer, allocated for
    every socket.
  - It is a one-line setting in `http.rs` (`read_buffer_size`), not yet
    measured.

## Setup

- **Box:** 4 vCPU AMD EPYC-Rome, 7.6 GiB RAM, 12 GiB swap (swappiness 10),
  Docker 29.4.1 (containerd image store), Compose 5.1.3. CPU steal was 0
  throughout.
- **Code:**
  - before: main 3d549fb4 with main's harness, on 2026-10-08;
  - after: `capy-side/rust-core` 065ad3d1 (rebased on main 4aede055) with
    the branch's harness, the capy-sync driver, on 2026-10-10 17:45-20:47
    UTC;
  - BetterOffice was at each branch's pin (00f1ccfe before, 42280746
    after).
  - The images were built on the box from a `git archive` of each SHA. The
    Rust image is `collaboration-rs/Dockerfile` as is: it compiles the
    Office engines natively, so it uses no prebuilt WASM.
- **Stack:** `deploy/docker-compose.e2e.yml`, plus
  `bench/collaboration/scripts/docker-compose.stress.yml` (fake S3, no
  indexing, no external service), plus a capacity overlay. The overlay pins
  cores, sets the 20 s `collab_health` interval, points room tokens inside
  the network, and for Rust sets production's engine pool. Each step ran on
  a fresh stack in Compose project `capy-capacity`.
- **Cores:**
  - collaboration on 2-3 (production's `COLLABORATION_CPUSET`);
  - Postgres, Redis, the gateway and the fake S3 on 1;
  - the load generators on 0-1 (`stress.ts` bundled, 1-4 containers,
    `STRESS_STACK=external`).
- **Load:** an edit every 2 s per peer and drops of 1-5 s at 0.02/s. Each
  step types for 3 minutes (Office 4), after a 20 s quiet baseline.
  Shapes, as on 2026-10-05:
  - big N: one DOCX and one note room of N;
  - small R: R rooms of 5, alternating DOCX and note;
  - Office R: R rooms of 4 over a six-file large mix (84-slide PPTX,
    16,000-row XLSX, 62-page DOCX and the three rich-content fixtures);
  - idle: 336 note rooms of 30, joining 64 at a time.
- **Pass:** marker p95 under 1 s in every format, every marker present once,
  every peer and a late joiner converged. `fail-generator` means it failed
  while the service's lag stayed under 250 ms and a generator's own event
  loop p99 reached 500 ms.
- **Guard:** a step would abort if MemAvailable fell under 300 MiB with swap
  thrashing, or if SSH stopped answering within 30 s. Neither happened.

How to read the numbers:

- **CPU** is a share of one core (100 = one core; the service has 200),
  hold-window mean/p90. **CPU per editor** is that mean over the editors
  (2N, 5R, 4R).
- **Lag:** Rust's lag is a 20 ms timer's lateness (floor about 1 ms).
  Node's was an event-loop histogram (floor about 22 ms). Read low values as
  "no stall", not as ratios.
- **Store p95 while typing** leaves out the opening interval, when every
  room loads and stores at once.
- **Working set** is the cgroup's (docker stats), and includes the Rust
  server's engine processes.

## Results (before → after)

### Big rooms: one DOCX and one note room

| people per room | verdict | typed share | p95 DOCX/note ms | service CPU % | CPU per editor | lag p99 max ms | working set MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | pass → pass | 99% → 99% | 115/77 → 76/69 | 27/34 → 20/24 | 0.14 → 0.10 | 60 → 2 | 188 → 304 |
| 130 | pass → pass | 91% → 91% | 428/330 → 645/272 | 31/41 → 24/30 | 0.12 → 0.09 | 61 → 3 | 256 → 282 |
| 160 | pass → fail-generator | 79% → 77% | 671/716 → 983/1104 | 32/45 → 25/32 | 0.10 → 0.08 | 104 → 3 | 219 → 334 |
| 200 | fail-generator → fail-generator | 68% → 63% | 926/1447 → 1221/2102 | 34/45 → 28/38 | 0.09 → 0.07 | 127 → 4 | 210 → 305 |

- From 130 people per room, the two generator cores are 95-100% busy and
  type below the nominal load (the typed share).
- The capy-sync generator is heavier than the Hocuspocus one. It stalls one
  step earlier, so 160 reads `fail-generator` on Rust.
- The service figures are what compare: CPU about 20-25% lower, no stall,
  every marker present and every room converged.

### Small rooms of 5, half DOCX

| rooms | verdict | p95 DOCX/note ms | service CPU % | CPU per editor | lag p99 max ms | store p95 while typing, note/Office ms | working set MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 80 | pass → pass | 125/146 → 41/47 | 64/153 → 29/77 | 0.16 → 0.07 | 124 → 3 | 193/1270 → 36/257 | 736 → 562 |
| 120 | pass → pass | 214/241 → 43/47 | 84/159 → 38/84 | 0.14 → 0.06 | 145 → 6 | 410/2681 → 38/227 | 860 → 764 |
| 160 | pass → pass | 399/606 → 47/54 | 108/158 → 46/85 | 0.14 → 0.06 | 181 → 7 | 509/2669 → 84/267 | 935 → 915 |
| 200, as configured | fail → **fail (open files)** | 2392/1327 → 44/51 of the markers that arrived | 129/164 → - | 0.13 → - | 386 → 6 | 1622/7610 → - | 1330 → 1110 |
| 200, open files raised | fail → pass | 2392/1327 → 59/59 | 129/164 → 60/125 | 0.13 → 0.06 | 386 → 7 | 1622/7610 → 147/507 | 1330 → 1183 |
| 240, open files raised | (not run) → pass | 145/97 | 71/119 | 0.06 | 10 | 170/585 | 1366 |
| 280, open files raised | (not run) → pass | 560/459 | 76/142 | 0.05 | 6 | 343/1570 | 1519 |

- **Node's limit** at 200 rooms was the service: the main thread, Office
  saves and the engine worker on its two cores.
- **Rust at 280 rooms:**
  - its two cores are 57% busy;
  - the save processes are 23% busy each;
  - the lag p99 is 6 ms.
- **What grows is store time**, and the box causes much of it:
  - Postgres shares core 1 with the gateway and half of the generators, and
    core 1 was 96% busy;
  - the generators held 3.7 GiB, leaving 858 MiB available.
- So 280 rooms is where this box stops being a fair load source, not the
  Rust server's ceiling.

### Office rooms, large-file mix

| rooms | verdict | edit p95 DOCX/XLSX/PPTX ms | service CPU % | steady save p95 mean/max ms | slowest save ms | engine busy while steady | working set max MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | pass → pass | 62/48/92 → 37/37/38 | 29/78 → 11/35 | 1021/1370 → 343/446 | 4783 → 2012 | 10% → 3% per save process | 969 → 856 |
| 20 | pass → pass | 129/118/120 → 38/38/38 | 48/106 → 19/45 | 1362/1601 → 569/818 | 8654 → 3442 | 20% → 6% | 1555 → 1330 |
| 30 | pass → pass | 170/173/171 → 39/38/39 | 66/141 → 29/106 | 2020/3477 → 771/1322 | 12221 → 5589 | 30% → 10% | 2026 → 1653 |

- No save failed, timed out or crashed an engine.
- At 30 rooms the two save processes held 1.2 GiB, including 9 XLSX
  replicas of 839 MiB (Node's one worker: 10 replicas, 740 MiB).
- **The background engine process was never called** by this ladder, so it
  never started. Its load is not measured here.

### Idle connections, 10,080 in rooms of 30, joining 64 at a time

| | verdict | connections | service CPU % | lag p99 mean/max ms | working set MiB (empty service) | per connection |
| --- | --- | --- | --- | --- | --- | --- |
| Node | pass | 10,080 | 25/38 | 26/30 | 308 (42) | 27 KB |
| Rust, as configured | **stopped at 1,002 (open files)**, service `unhealthy` | 1,002 | - | - | - | - |
| Rust, open files raised | pass | 10,080 | 27/40 | 2/2 | 1538 (48) | 151 KB |

## Finding 1: the open-file limit (fixed on the branch, a234cfef)

- **Cause:**
  - The `capy-collaboration` process ran with `Max open files 1024 524288`
    (soft, hard). That is the default Docker 29 with containerd 2 gives a
    container process.
  - Go and Node raise the soft limit to the hard one when they start: the
    gateway in the same stack showed 524287. The Rust server did not.
- **What happens past about 1,000 descriptors** (WebSockets, the Postgres
  pool, the gateway's HTTP pool, engine pipes):
  - new WebSockets are not accepted;
  - the server's own requests to the gateway fail ("Source access failed:
    error sending request for url …/internal/collaboration/files/…/access"),
    so joins to Office rooms are refused, markers are lost and rooms do not
    converge;
  - the container's healthcheck fails.
  - At 160 small rooms the service held 944 sockets, just under the limit,
    and passed.
- **Fix (rust-core):** raise `RLIMIT_NOFILE` to the hard limit at startup in
  `main.rs`, and set `ulimits: nofile` on the collaboration service in the
  compose files. The open-files-raised runs above used only the compose
  overlay (`nofile: 524288`, Node's effective limit), not the coming code.

## Finding 2: 151 KB per connection

- **Cause:**
  - tungstenite 0.29 allocates each socket's read buffer when the socket
    opens (`read_buffer_size`, default 128 KiB).
  - `crates/server/src/http.rs` sets only the message and frame size limits
    on axum's `WebSocketUpgrade`, which also has a `read_buffer_size`
    setter.
- **The numbers:**
  - 10,080 × 128 KiB = 1,260 MiB of the 1,490 MiB measured above an empty
    service. That leaves about 23 KB per connection, near Node's 27 KB.
  - The memory grew in step with connections while peers joined.
  - It stayed at 1.52 GiB after all of them had left.
- This explanation comes from the source and the arithmetic. It has not
  been measured with a patched build.

## Recommendation

1. **Cut over only with the open-file fix in the build**, and check it
   where it runs:
   - after the UAT deploy, `/proc/<pid>/limits` of `capy-collaboration`
     should show the hard limit;
   - give the fix a regression test that fails when the startup call is
     removed (for example, the server's own soft limit read back from
     `/proc/self/limits`).

   With the limit raised, the Rust server is better than Node on pass/fail,
   latency and CPU in every shape measured on this box. Capacity gives no
   reason to delay the cutover.
2. **Keep the production settings measured here:** the cpuset 2-3 and the
   2 save + 1 background engine processes at 4 GiB.
   - At 280 small rooms the service used 0.76 of its 2 cores.
   - The save processes were at most 25% busy while steady.
   - The service's working set peaked at 1.65 GiB (Office, 30 rooms).
3. **Set the WebSocket read buffer before relying on many idle or viewing
   connections.**
   - Use `read_buffer_size` on the upgrade, for example 4-16 KiB:
     tungstenite grows it for large frames.
   - Then rerun the idle step and look at the memory kept after
     disconnects.
   - On this 7.6 GiB box, 10k idle sockets now take 1.5 GiB next to engine
     processes capped at 4 GiB each.
   - This is not a blocker while there are no production users.

## Open questions

- **A load source off this box.** The generators saturate from 2×130 in big
  rooms and at about 280 small rooms (cores 0-1 89-96% busy, 858 MiB
  available). So neither the per-room ceiling nor the small-room ceiling of
  the Rust server is known. The 2026-10-08 decision was "no second
  machine".
- **The background engine lane** (production's third engine process) did no
  work in this ladder. Which workload should exercise it in the next run?
- **The read buffer:** change it before the cutover or after?

## Raw data

The raw data is not committed. Per step it holds `summary.json`,
`monitor.tsv`, the `collab_health` logs, generator reports and `meta.json`.
It is on the developer PC under
`capy-harness/2026-10-06-rust-round/prod-capacity/`:

- `PHASE-A.md`, `PHASE-B.md`;
- `runs/A-*`, `runs/B-*`;
- the scripts, in `box/`.

`node box/compare.mjs runs A B` rebuilds the before/after tables, and
`node box/tables.mjs runs A B` the full per-step ones.
