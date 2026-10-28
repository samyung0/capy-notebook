# Presence load on the production box, 2026-10-28

Note rooms with carets at 20 Hz, in today's awareness shape and in the
compact shape decided on 2026-10-28 (`todo-presence.md`), against main's Rust
collaboration server on the production box. The question: does compact JSON
suffice, or does presence need a binary format? Epo allows bench runs on the
box; the run started after Coolify was removed from it (Q498), and everything
it created was removed afterwards.

## Short version

- **Compact JSON suffices; a binary format is not worth building.**
  - One caret message is **36 B compact against 305 B today** (8.5× smaller).
  - Server egress per incoming caret, three receivers included, is **194 B
    compact against 886 B today**. Frame and protocol overhead (about 29 B
    per delivered entry) is now most of what is left, so a binary state
    (about 20 B) would save about a quarter of the remaining bytes and no
    CPU.
  - The server's CPU does not depend on the shape: it is per message.
- **The server carries the target load easily.** 200 rooms of 3 typists and
  a watcher (800 connections) with carets at 20 Hz:
  - the collaboration service used **0.6-0.7 of one core** of its two (no
    carets: 0.19), with scheduling lag p99 of 3-5 ms in every step;
  - at 14,700 incoming carets a second (400 rooms) it still used 0.67 core:
    the 30 ms flush window merges more entries per frame as the rate grows,
    so the cost per caret falls.
- **Carets arrive faster compact** at 200 rooms: p95 **67 ms** against
  **685 ms** today. The difference is the receivers' decoding (each
  generator process holds about 200 peers), so it says more about cheap
  clients than about the server.
- **Every typing step past the baseline "fails", and the generators are the
  cause, not the server.** The generators' cores (0-1) were 96-100% busy in
  each of them, while the service's cores (2-3) stayed at 35-46%. They sent
  8,800-12,000 carets a second against 12,000-24,000 planned, and the queue
  in their own sockets delayed the typed markers (p95 1.1-13 s). This box
  cannot generate more than about 200 rooms at 20 Hz; the server's ceiling
  is not reached here.
- **Harness gap found:** with offline drops on (the harness default), main
  refuses the edits a peer typed offline once it reconnects
  (`collaboration-unassigned-id`, Q213 / Epo 2026-10-24): 433 of the smoke
  step's markers were lost and every room failed to converge. Runs here use
  no drops. `stress.ts` needs a decision on how a reconnecting peer's offline
  edits should go (the app holds them as a draft); the `Performance`
  workflow's runs have failed since 2026-10-22.

## Setup

- **Box:** 4 vCPU AMD EPYC-Rome 2.0 GHz, 7.6 GiB RAM, Docker 29; Coolify
  already removed, no other containers.
- **Code:** origin/main e8f36ab6e (BetterOffice pin 502d19fc), with this
  checkout's `bench/collaboration/scripts/stress.ts` (the caret load) laid
  over it. Images built on the box from that stage (collaboration
  `collaboration-rs/Dockerfile`, the gateway `server/`).
- **Stack:** `deploy/docker-compose.e2e.yml` plus
  `bench/collaboration/scripts/docker-compose.stress.yml` (raised per-user
  limits, fake S3) plus the capacity overlay: collaboration on cores 2-3
  with production's engine pool, Postgres, Redis, the gateway and the fake
  S3 on core 1, four generators (`stress.ts` bundled, `STRESS_STACK=external`)
  on cores 0-1. Fresh stack per step.
- **Load:** note rooms of 3 typing peers and a watcher that never types (4
  connections; `x4` steps: 4 typists, 5 connections). A typist types a
  marker every 8 s on average (`STRESS_EDIT_MS=8000`) and, in caret steps,
  publishes its caret 20 times a second, moving one character a tick, a
  selection one tick in four. No offline drops. 3 minutes per step.
- **Caret shapes** (`STRESS_CURSOR_PAYLOAD`):
  - `today`: slate-yjs's `{data: {color}, selection: {anchor, focus}}` with
    JSON `Y.RelativePosition`s inside a block;
  - `compact`: `{s, f?}`, base64 `Y.encodeRelativePosition`, `f` only for a
    selection.
- **Caret latency:** send to receipt by every other peer of the room, timed
  on the same clock (a room's peers share a generator process). **Marker
  latency:** typed by one peer, seen by the watcher.
- Harness: `capy-harness/2026-10-28-presence-load` (`box/`, raw summaries
  in `runs/`).

How to read the numbers: CPU is a share of one core over the typing
minutes (the service has two). Network is the collaboration container's
bytes a second, documents, Postgres and Redis traffic included (the baseline
step shows that part).

## Results

| step | connections | carets sent/s (planned) | bytes per caret | service CPU | service lag p99 ms | egress KiB/s | ingress KiB/s | caret p50/p95 ms | marker p95 ms | generator cores 0/1 % | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200, no carets | 800 | 0 | - | 19% | 1 | 1,053 | 349 | - | 71 | 26/70 | pass |
| 200, today | 837 | 8,780 (12,000) | 305 | 61% | 3 | 8,389 | 3,885 | 50/685 | 2,145 | 99/99 | fail (generators) |
| 200, compact | 800 | 10,200 (12,000) | 36 | 68% | 3 | 2,916 | 1,685 | 36/67 | 1,123 | 96/99 | fail (generators) |
| 200 × 4 typists, today | 1,049 | 9,850 (16,000) | 304 | 59% | 5 | 9,732 | 4,312 | 68/3,294 | 4,888 | 100/100 | fail (generators) |
| 200 × 4 typists, compact | 1,000 | 12,140 (16,000) | 36 | 68% | 4 | 3,284 | 2,012 | 50/2,277 | 3,958 | 100/100 | fail (generators) |
| 400, today | 1,606 | 12,990 (24,000) | 305 | 58% | 4 | 6,747 | 5,152 | 83/≥10,000 | 12,988 | 99/100 | fail (generators) |
| 400, compact | 1,607 | 15,980 (24,000) | 36 | 67% | 5 | 3,035 | 2,391 | 64/8,583 | 11,043 | 98/100 | fail (generators) |

- Carets sent a second is each step's total over the 3 minutes; the
  service's own count of incoming awareness messages (`collab_health`) is
  within 10% of it.
- Every step that typed delivered every marker once and converged.
- The verdict rule (marker p95 under 1 s) marks these `fail` rather than
  `fail-generator` because the generators' event loops stayed under the
  500 ms p99 that rule looks for; the backlog sat in their sockets instead.

Per incoming caret at 200 rooms (baseline step taken out):

| shape | service CPU | egress | ingress |
| --- | --- | --- | --- |
| today | 50 µs | 886 B | 427 B |
| compact | 50 µs | 194 B | 139 B |

At the planned 12,000 carets a second that is about 0.6 core and 10 MiB/s
(about 85 Mbit/s) of egress today, against the same CPU and 2.2 MiB/s
(about 18 Mbit/s) compact. The batching above makes the CPU figure an upper
bound.

## The planned field check

The server will parse each entry and check its fields (`todo-presence.md`,
section A). A serde_json parse and check (with `preserve_order`, as the
server builds it), measured on an Apple M-series Mac:

| state | bytes | per entry |
| --- | --- | --- |
| compact caret | 47 | 0.41 µs |
| caret and pointer | 77 | 0.50 µs |
| caret and 16 block-selection runs | 1,310 | 4.1 µs |
| today's caret, parse only | 280 | 5.0 µs |

Even at three times that on this box's EPYC cores, 12,000 compact carets a
second cost about 15 ms of CPU a second, under 2% of a core, against the
50 µs per caret the relay already costs.

## Reproduce

On the Mac, `box/prepare-P.sh <stage dir> --upload` (it stages origin/main
with this checkout's `stress.ts`), then on the box `bash box/build-P.sh`
(about 20 minutes cold) and
`setsid nohup box/ladder.sh P box/plan-P.txt >runs/ladder-P.out 2>&1 &`.
`run-step.sh P <step> notes <rooms>` runs one step with `EDIT_MS`,
`CURSOR_HZ`, `CURSOR_PAYLOAD`, `PEERS` and `DROPS` from the environment.
Two traps: `pgrep -f`/`pkill -f` with the script's name over SSH match the
SSH command itself (bracket the first letter, `[r]un-step.sh`), and a step
refuses to start when its run folder exists.

A more loaded step needs load from more cores than this box has spare: the
server side measured here would take about twice the rooms before its two
cores matter.
