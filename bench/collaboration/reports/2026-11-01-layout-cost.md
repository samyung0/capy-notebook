# Layout cost on the production box, rerun after the load fixes, 2026-11-01

The same layout-cost run as on 2026-10-29 (`scripts/layout-box/`): Plate and
blocks note rooms on the same content, in the offline matrix and against the
branch's real collaboration server. It reruns the run after 1da003cfe, which
fixed the causes the first run found. This run also adds one reading: the
server's RSS once every room has unloaded.

## Short version

- **A near-limit blocks room now costs 29 MiB of server RSS idle**, down from
  72 MiB (Plate: 12 MiB, down from 15). With typists it costs 39-51 MiB,
  down from 97-101 (Plate: 14-15 MiB). The rooms' own heap did not change
  (matrix: 13.3 against 7.0 MiB). The drop is all load-time memory the load
  no longer reaches. The 20-room peak fell from 1,640 MiB to 662 MiB.
- **Loading a blocks room takes 105 ms of CPU** (Plate 50), down from 367.
- **Blocks typing costs about what Plate typing costs.** On the stack:
  - one typist per near-limit room costs 1.26 ms of CPU per update (Plate
    1.01), down from 2.95;
  - five typists cost 0.51 ms per update (Plate 0.43), down from 3.28.

  In the matrix, five typists ran 2 exact checks a minute, down from 18. An
  hour of session edits took 0.77 s of CPU, down from 5.0 (Plate 0.34).
- **Latency is the same in both layouts**: p50 29-32 ms and p95 33-36 ms on
  the near-limit note, flat across the run. The first run's 259 ms p50 for
  five blocks typists came from the generators: their event loop ran at a
  543 ms p50 in that step.
- **Once every room has unloaded, the server keeps the RSS it had loaded**:
  98-101% in the idle near-limit steps, and more than that after typing.
  The registry is empty during that time (0 rooms, 0 connections). This is
  consistent with glibc keeping freed memory, and nothing points elsewhere
  (details below). What is left above the matrix is the high water of
  concurrent loads, held resident.
- **Both five-typist near-limit steps failed, in both layouts.** The note
  filled up to its 2 MiB content limit about 2.5 minutes in. The generators
  now send their full rate, which the first run's generators never did. This
  is the test plan, not a server fault (details below).

## Setup

|                  | First run (2026-10-29)               | This run                                            |
| ---------------- | ------------------------------------ | --------------------------------------------------- |
| Capy             | 0f14edf6d                            | f2ad7b79f (`blocksuite-notes`)                      |
| BetterOffice pin | 502d19fc                             | 383d0056 (one PPTX editor file; not in the server)  |
| Matrix           | exit 0, 32 s                         | exit 0, 17 s                                        |
| Stack steps      | 10 ok                                | 8 ok, 2 fail (five typists, near-limit note)        |

Both runs used the same box, the same plan (`plan-L.txt`) and the same
production allocator settings: `MALLOC_ARENA_MAX=2` and trim and mmap
thresholds of 128 KiB. Collaboration ran on cores 2-3. Between the two runs:

- 1da003cfe changed the load: the seed is encoded after its transaction
  commits, the replay's copy is dropped before the checks, and
  `Model::loaded` checks a stored blocks tree once and sets the bound and
  the parent index from it.
- 1da003cfe also changed typing: a keystroke inside a run is priced at its
  own bytes, and each store's exact metrics restart the bound.
- 1da003cfe changed `stress.ts` to read a note's texts once per doc.
- f2ad7b79f only changes widths to pixels; nothing on these paths.

**The new reading.** After the generators exit, `run-step.sh` waits until
the server has logged one `room_unload` for each `room_load`. A note room
unloads as soon as it is empty and its last edits are stored, with no
further grace. The store waits 2 s after the last edit, and at most 10 s
after the first unsaved one. The step then keeps `monitor.sh` sampling for
60 s. `summary.json` has `rss.afterUnloadMB` (the mean, its range, and the
amount per room above the baseline) beside `holdMB` and `peakMB`. It also
has `unload.healthRoomsMax`: the registry's own room count in that minute's
`collab_health` lines, which was 0 in every step. Every room had already
unloaded by the time the last generator exited. The first run had no such
window: its figures below use its own monitor rows from the last
`room_unload` to the end of the step's 25 s tail (23-27 s).

## Matrix (one process, near-limit note)

| State                                   | Plate, 1st → 2nd      | Blocks, 1st → 2nd        |
| --------------------------------------- | --------------------- | ------------------------ |
| Idle: heap / RSS per room (MiB)         | 7.0 / 8.0 → 7.0 / 8.4 | 13.0 / 15.5 → 13.3 / 15.7 |
| Load CPU per room (ms)                  | 51 → 50               | 367 → 105                |
| Fresh joiner's step-1 answer (ms)       | 4.8 → 4.4             | 6.9 → 7.2                |
| 1 typist: CPU ms/s (exact checks)       | 0.19 → 0.17           | 6.83 (4) → 0.09 (0)      |
| 5 typists: CPU ms/s (exact checks)      | 0.98 → 1.03           | 31.4 (18) → 4.7 (2)      |
| 50 block moves (ms)                     | 9.2 → 8.7             | 102 → 5.0                |
| 150-paragraph paste (ms)                | 20 → 18               | 115 → 41                 |
| Reconnect with a 500-update draft (ms)  | 21 → 19               | 41 → 36                  |
| Session hour: CPU ms (exact checks)     | 346 → 341             | 4,987 (42) → 766 (5)     |
| Unload fold: CPU ms; heap / RSS freed   | 14 → 12; 7.6 / 7.3    | 34 → 34; 14.6 / 14.8     |
| Reload (CPU ms)                         | 82 → 62               | 200 → 134                |

- Dropping 20 idle rooms and trimming leaves 0.4 MiB (Plate) and 0.2 MiB
  (blocks).
- On the small note Plate is unchanged. Blocks loses its last exact checks
  (session hour 6 → 0) and its load CPU goes from 2.3 to 1.3 ms.
- The matrix leaves `SAVE_REFRESH` at its default (off; `matrix-L.yml` does
  not set it), so its typing states never restart the bound at a store, and
  the 2 exact checks come from the price change alone. The server always
  restarts the bound, so the stack steps include both changes.

## Stack steps (the real server)

Per room is the container's summed VmRSS (mean over the loaded hold) less
the idle baseline, divided by the rooms. "After unload" is the same with no
room loaded.

| Step                                    | RSS/room loaded (MiB) | After unload, per room | Peak (MiB)    | CPU (ms/s)  | Typist p50 / p95 (ms) |
| --------------------------------------- | --------------------- | ---------------------- | ------------- | ----------- | --------------------- |
| Idle, near-limit, Plate ×20             | 15.4 → 12.3           | 14.2 → 12.4            | 396 → 330     | 16.5 → 18.5 | –                     |
| Idle, near-limit, blocks ×20            | 72.3 → 29.1           | 64.4 → 28.6            | 1,640 → 662   | 17.7 → 19.3 | –                     |
| Idle, small, Plate ×200                 | 0.05 → 0.05           | 0.05 → 0.05            | 93 → 93       | 23.6 → 26.2 | –                     |
| Idle, small, blocks ×200                | 0.05 → 0.07           | 0.06 → 0.08            | 82 → 97       | 23.8 → 24.0 | –                     |
| 1 typist, near-limit, Plate ×10         | 16.6 → 13.9           | 18.7 → 17.7            | 261 → 249     | 97 → 101    | 32 / 36 → 32 / 33     |
| 1 typist, near-limit, blocks ×10        | 96.7 → 50.6           | 96.7 → 51.0            | 1,081 → 581   | 210 → 126   | 34 / 74 → 32 / 33     |
| 5 typists, near-limit, Plate ×10 (fail) | 16.6 → 15.0           | 19.6 → 21.6            | 268 → 287     | 148 → 241   | 57 / 207 → 29 / 35    |
| 5 typists, near-limit, blocks ×10 (fail) | 100.5 → 38.6          | 96.2 → 43.0            | 1,085 → 511   | 253 → 349   | 259 / 664 → 29 / 36   |
| 5 typists, small, Plate ×10             | 0.84 → 1.03           | 1.30 → 1.82            | 88 → 91       | 147 → 161   | 32 / 77 → 30 / 47     |
| 5 typists, small, blocks ×10            | 1.19 → 0.98           | 1.66 → 1.52            | 97 → 86       | 214 → 246   | 32 / 80 → 30 / 47     |

CPU per second does not compare across the runs for the near-limit typing
steps. The first run's generators fell short of the planned rate:

- blocks with one typist: 71 updates a second of 100;
- five typists: 75 of 500 (blocks) and 227 of 500 (Plate).

This run sent the full rate. Per 1,000 updates received:

| Step                                       | Plate, 1st → 2nd | Blocks, 1st → 2nd |
| ------------------------------------------ | ---------------- | ----------------- |
| 1 typist, near-limit (hold)                | 1,013 → 1,011 ms | 2,952 → 1,258 ms  |
| 5 typists, near-limit (30-140 s, pre-limit) | 616 → 431 ms     | 3,280 → 510 ms    |
| 5 typists, small (hold)                    | 363 → 352 ms     | 539 → 539 ms      |

The CPU of the failed steps, 241 and 349 ms/s, includes the last ~20 s at
the note's limit. Before it (30-150 s) the server ran at 212 ms/s (Plate)
and 255 ms/s (blocks).

## What changed and why

- **Load.** The new load path took a blocks room's load from 367 to 105 ms
  of CPU in the matrix. On the stack, with 20 rooms loading at once, the
  median `room_load` went from 6.3 s to 3.4 s (Plate: 2.1 s to 1.3 s). The
  stack's RSS follows the load's transient peak, which fell from 166 to
  35 MiB on the laptop: the per-room RSS fell from 72 to 29 MiB while the
  live heap stayed at 13 MiB. Plate gained from the dropped replay copy as
  well (15.4 → 12.3 MiB).
- **Typing.** Two changes removed the exact checks: the load sets the bound
  (so the first keystroke is on it), and keystrokes are priced at their own
  bytes. Moves went from 102 to 5 ms and the session hour from 4,987 to
  766 ms. Per update on the stack, blocks typing went from 2.9-5.3× Plate's
  cost to 1.2×.
- **Latency.** In the first run the generators saturated: their event loop
  ran at p50 543 ms (p99 1.5 s) for five blocks typists and 72 ms for
  Plate. Now that `stress.ts` reads a note's texts once, the loop runs at
  p50 20 ms (p99 26-187 ms) and the generators deliver the full rate. The
  markers then arrive in 29-32 ms at p50, from the first tenth of a run to
  the last. That full rate is also why the five-typist CPU per second rose
  while the CPU per update fell.

## Does glibc retention explain what is left?

As far as these readings can tell, yes. Once every room has unloaded, the
server keeps its loaded RSS for the whole minute:

- **Idle near-limit steps:** blocks keeps 641 of 652 MiB and Plate 317 of
  315 MiB (98% and 101% of the RSS above baseline).
- **After typing:** the server holds more than it did loaded (Plate 17.7
  and 21.6 MiB per room, against 13.9 and 15.0). The unload's own
  projection and fold allocate, and that memory stays too.
- **First run:** the same picture, 89-92% after about 25 s.

The memory is held by the allocator, not by rooms, for three reasons:

1. **Freed memory stays.** The loaded RSS per room is 2.2× the room's live
   heap for blocks (29.1 against 13.3 MiB) and 1.8× for Plate (12.3
   against 7.0). The rest is the load's copies, which the code drops. After
   unload, those copies and the live heap stay alike, while the registry
   holds no room.
2. **A trim returns it.** The matrix drops the same rooms and calls
   `malloc_trim(0)`: it gets back all but 0.2-0.4 MiB of 20 rooms (14.8 MiB
   RSS per blocks room at unload). The server never calls it.
   `MALLOC_TRIM_THRESHOLD_` only returns free space at the top of a heap,
   and one live allocation above that space pins it. So the matrix
   comment's premise (the threshold "returns them as it goes") does not
   hold for the server.
3. **RSS follows the load's peak, not the room's size.** The drop from 72
   to 29 MiB came with the load peak's drop from 166 to 35 MiB, and the
   live heap did not change. The near-limit blocks steps hold 29-51 MiB per
   room depending on how much load, store and check work overlapped. The
   matrix, which loads one room at a time, holds 15.7.

These readings can't give an allocator count inside the server. That needs
code in the server (`malloc_info`, or a trim), which was not part of this
run. Two cheap ways to settle it:

- a reload wave in the same step: memory the allocator kept is reused, so
  RSS should not grow;
- a `malloc_trim(0)` after unloads, behind a flag.

## The five-typist near-limit failures

Both layouts failed the same way. From about marker 1,540 of each peer
(about 2.5 minutes in), new markers reached no peer but their author.
About 1,100 of the 8,900 markers per room went missing, and the peers did
not converge.
The cause is the note's limit:

- The load-test note's JSON is 2,018,734 B against the 2 MiB content limit:
  78,418 B of room.
- Five peers typing 10-byte markers at 10 a second fill that in about 157 s.
  The steps type for 180 s, and the server then refuses the growth, as
  designed.
- The first run never got that far: its saturated generators added 14-44 KB
  of markers per room.

This is not a server fault, but these two steps need `MINUTES=2` (or four
peers) to pass.

At the limit, every refused keystroke takes the exact check before it is
refused (for blocks, a copy and a projection of the whole room). In the ten
seconds at the limit with all five still typing (160-170 s), the server
used 730 ms/s for Plate and 1,143 ms/s for blocks, against 212 and 255
before. Those checks also raised the blocks step's peak and after-unload
RSS.

## Box

- **Before:** no containers, 6.8 of 7.6 GiB available, swap unused, 36 GiB
  free disk, a 16.6 GB build cache, and three images (node:22-alpine,
  redis:7-alpine, pgvector).
  - `/root/capy-capacity` and the first run's images had already been
    removed. `/root` last changed on 2026-10-29 at 08:15 UTC, a minute
    after the first run's ladder ended. `prepare-L.sh` created the
    directory again, and the images were rebuilt from the kept cache in
    7 minutes.
- **During the run:**
  - `build-L.sh`'s pull brought a newer `pgvector:pg16`. The first run's
    image is now untagged; Postgres serves only the test stack.
  - The ladder's group rule skipped `type5-small-blocks` after the
    near-limit failure, so that one step was run on its own afterwards
    (`ladder.sh plan-L.txt type5-small-blocks`).
  - The e2e compose binds the test Redis to `127.0.0.1:16379` (loopback
    only), as in the first run. `capacity-L.yml` resets the other services'
    ports but not Redis's.
- **After:** compose project `capy-capacity` has no containers, volumes or
  networks left.
  - Kept: the built images, the build cache (21.1 GB) and
    `/root/capy-capacity`.
  - 31 GiB free disk, 6.8 GiB available memory.
