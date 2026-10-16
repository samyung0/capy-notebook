# Collaboration server memory after peers leave, by allocator, 2026-10-17

The Rust collaboration server keeps most of the memory a load used after
every peer has left and every room has unloaded. This run measures how much,
and what glibc settings or another allocator change. Nothing here is
deployed: the allocator settings wait on Epo's decision (the parser's
`MALLOC_ARENA_MAX=2` was one, 2026-10-15).

## Short version

- **glibc as shipped keeps 410-470 MiB** of the server process's resident
  memory three minutes after the last peer left (78-95 MiB before the load,
  506-545 MiB after).
- **`MALLOC_ARENA_MAX=2` halves it** (194 MiB kept).
- **`MALLOC_ARENA_MAX=2` with fixed 128 KiB trim and mmap thresholds keeps
  87-98 MiB** and also lowers the peak from 506-545 to 177-179 MiB. Marker
  latency and CPU per marker are unchanged.
- **mimalloc (crate 0.1.52, default options) is worse:** it starts at
  158 MiB idle and keeps 282 MiB.
- What the best setting still keeps is mostly the server's own bounded
  caches (Office bases, seeds and baselines; 256 MiB of budgets together).

## Setup

- **Machine:** the Windows PC (Ryzen 7 3700X, 16 threads), Docker Desktop.
- **Code:** branch `editor/perf-server` on main 1a6efa1e3; the collaboration
  image built from `collaboration-rs/Dockerfile` with BetterOffice at the pin
  8b50ac30, glibc from `debian:bookworm-slim`; the gateway image from
  `server/`.
- **Load:** `bench/collaboration/scripts/stress.ts` on its local stack with
  `STRESS_MINUTES=2` and every other default: 20 peers in a DOCX and a note
  room, then 5 peers in the near-limit note and a 4 MiB text source, then
  the cost windows (5 peers per room kind). `E2E_KEEP_STACK=true` kept the
  stack for three idle minutes after the run.
- **Measured:** the `VmRSS` of the server process (`capy-collaboration`,
  without its Office engine process, which stayed at 32-55 MiB) every 5 s
  through `docker exec`; marker p95 and CPU per marker from `stress.json`.
- **Variants:** the same image with an environment overlay
  (`2026-10-17-windows-pc/malloc-*.yml`), and one image built with mimalloc
  as the global allocator (a two-line prototype, not committed). The two
  shipped-glibc runs and the two best-setting runs were interleaved with the
  others.

## Results

| variant | before load MiB | peak MiB | 3 min after peers left MiB | kept MiB | marker p95 office/plate ms | CPU per marker, main/limit phase ms |
| --- | --- | --- | --- | --- | --- | --- |
| glibc as shipped (run 1) | 78 | 545 | 545 | 467 | 40/41 | 2.77/8.49 |
| glibc as shipped (run 2) | 95 | 506 | 506 | 411 | 37/37 | 1.99/5.29 |
| `MALLOC_ARENA_MAX=2` | 79 | 295 | 272 | 194 | 39/38 | 2.34/5.76 |
| `MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=131072`, `MALLOC_MMAP_THRESHOLD_=131072` (run 1) | 81 | 179 | 179 | 98 | 37/38 | 1.98/5.43 |
| the same (run 2) | 80 | 177 | 167 | 87 | 37/37 | 2.01/5.31 |
| mimalloc 0.1.52, defaults | 158 | 571 | 440 | 282 | 37/37 | 1.89/5.31 |

- Every run passed: all markers once, every peer and the late joiner
  converged, no collaboration error logged.
- Marker p95 sits on the local floor (the 30 ms broadcast batch plus the
  loopback); the run-1 limit-phase CPU of 8.49 ms is that run's first DOCX
  seed on a cold engine.
- Why it helps: the room loads replay documents on tokio's blocking threads,
  each of which gets its own glibc arena, and the rooms free that memory
  later from their own task; with up to 8 arenas per core the freed space
  stays spread over arenas that never shrink. Two arenas keep reuse local.
  glibc also raises its mmap threshold each time a large block is freed, so
  later large buffers (update logs, encodes) land in the heap instead of
  being unmapped on free; a fixed threshold keeps them mmapped.

Raw records: `2026-10-17-windows-pc/<variant>.memory.txt` (the 5 s samples:
cgroup memory, then each process's `VmRSS` in KiB) and
`<variant>.stress.json`.

## Proposal (for Epo)

Set `MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=131072` and
`MALLOC_MMAP_THRESHOLD_=131072` on the collaboration service in the UAT and
production compose files (its engine processes inherit them), then compare
the collaboration container's memory on UAT (`docker stats`) before and after
a deploy. It changes no engine process count or memory cap.
