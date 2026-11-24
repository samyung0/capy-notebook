# The collaboration server's room memory on the production box, 2026-11-23

Copied from the side-session notes (`canvas-build/audits/2026-11-23-room-memory-prod/`), where its `scripts/` and `records/` stay; the box's address and paths are left out. Pass 2 is [2026-11-24-room-memory-prod-2](2026-11-24-room-memory-prod-2.md).

Epo asked whether the room-memory study ([2026-11-22](2026-11-22-room-memory.md)) had been measured on a real server. It had not: it measured a bench that builds rooms the way the server does. This run measures the collaboration server itself (`collaboration-rs`) on the production box. That covers x86_64, production's cores and production's glibc settings. It compares the code before the room-memory cuts (`79a2d47dc`) with the code after them (`3b4f113bb`). Nothing in any repository was changed. The scripts and raw records stay with the side-session notes (`scripts/`, `records/`).

How to read the numbers:
- **Measured** means run for this report. **est.** means reasoned from those measurements or from code. **code** means read from `3b4f113bb`.
- MiB is 1,024².
- A room's cost is the server process's RSS (`/proc/<pid>/smaps_rollup`) above the same process's idle baseline.
- Its ratio is that cost divided by the file's encoded state.
- Each cell is the median of 3 runs on fresh processes, with the range in brackets when it is wider than 0.05 MiB.

## Short version

- **Loading a room costs half what it did** (measured, cuts 1 and 3). A 4 MiB board loaded from storage:

  | board | state | before | after | load peak (VmHWM) before → after |
  |---|---:|---:|---:|---:|
  | mixed (the recorded hour) | 3.97 MiB | 110.0 MiB (27.7×) | 56.3 MiB (14.2×) | 117.9 → 68.0 MiB |
  | pen, 41-point strokes | 3.96 MiB | 103.3 MiB (26.1×) | 53.2 MiB (13.4×) | 113.0 → 65.1 MiB |
  | typed board notes (old client) | 3.97 MiB | 138.9 MiB (35.0×) | 69.2 MiB (17.4×) | 161.6 → 81.1 MiB |
  | **8 mixed boards loaded at once** | 31.75 MiB | **948 MiB (29.9×)** | **460 MiB (14.5×)** | **1,024 → 478 MiB** |

  - Loading also takes less time. Step 2 of a fresh 4 MiB load took 471 → 295 ms for mixed, 416 → 260 for pen and 742 → 429 for board notes.
  - For the 8 joiners at once, the median step 2 went from 1,992 to 1,181 ms.
- **The bench's prediction holds for loaded rooms** (measured, heap probe, mixed 4 MiB).
  - glibc's own count of the heap in use for a loaded room is 62.9 MiB before and 58.9 MiB after. The bench gave 61.8 MiB, and about 57.5 MiB with cut 3.
  - Against a fresh process trimmed with `malloc_trim`, RSS was 122.2 MiB before (1.94 times the heap; the bench predicted 117.6 MiB, 2.0 times). After, it was 68.8 MiB (1.17 times; the bench predicted 1.0).
- **A room built live costs about three times what the bench predicted, and the cuts barely change it** (measured).
  - A 4 MiB board built in the room sits at 154 to 243 MiB (39 to 61×). The bench predicted 57 to 78 MiB (14 to 19×).
  - The heap probe splits this up. The live room holds 80 MiB in use, and glibc holds about 95 MiB more as free memory.
  - est.: that free memory is what the build's whole-board work left behind. A fold replays the whole board into a scratch document off the room's thread (`note_store::fold`). A larger edit tries itself on a copy (`model.rs` `admit_board`). A pen board, whose edits are small and need no copy, still reaches 169 MiB.
  - RSS stays at that mark after the room unloads.
- **Loading again in the same process:** before the cuts, a reload added 37 to 54 MiB on top of the live mark (mixed 176 → 220 MiB). After, the reload fits in the memory already freed: 0 to 9 MiB more.
- **Some memory is not given back after a room unloads** (measured, not traced).
  - glibc still counts 33 to 38 MiB in use after a room built live unloads, and 8 MiB after a loaded room unloads. Both are still there a minute later.
  - Three loads in turn of the same room left 8, 9 and then 13 MiB.
- **Cut 2 holds on the real server** (measured, after build, the same 1,840 notes):
  - state 3.97 → 1.29 MiB (−68%);
  - live 237.9 → 65.2 MiB (−73%);
  - loaded 69.2 → 22.1 MiB (−68%).

  A full 4 MiB board of quiet notes (5,680 notes, 3.1 times as many) loads in 54.7 MiB (13.7×).
- **A fresh process carries about 17 MiB of free heap from startup** (measured: `malloc_trim` takes 16.5 to 16.8 MiB off its RSS).
  - A 1 MiB room often fits inside that free heap. So after-cut 1 MiB loads read 1.8 to 15 MiB depending on which arena took them, and the 1 MiB columns mostly measure the allocator.
  - The 4 MiB loaded numbers are understated by up to that much. The probe's trimmed numbers above correct for it.
- **A typed Plate note stops at 0.58 MiB.** The 10,000-node cap (`notes::limits` `MAX_NODES`) comes long before 4 MiB of state.
- **Admitting a large board is slow, on both builds alike** (measured, as a side reading).
  - 1 MiB to 4 MiB, typed notes: 77,760 updates in 23 s, then 298,080 in 330 s.
  - Mixed: 6 s, then 78 s.
  - The quiet 4 MiB board: 471,440 updates in 615 s.
  - Pen at 4 MiB: 3 s.
  - The server logged saves of 2.2 to 2.8 s near the end of one board-notes build.

## Setup

- **Box:**
  - The production box. No production service runs there.
  - Hardware: 4 vCPU AMD EPYC-Rome, 7.6 GiB RAM, 12 GiB swap.
  - Kernel 7.0.0-38-generic, Docker 29.4.1, cgroup v2.
  - Swap went from 0 to 18 to 35 MiB used during the run. Available memory never dropped below about 6 GB, and the guard (under 300 MiB available while swap moves) never tripped.
- **Code:**
  - **before:** `79a2d47dc`, BetterOffice `ccb90cc2d`, client protocol 38.
  - **after:** `3b4f113bb`, BetterOffice `ad34459aa`, client protocol 39.
- **How the code was built:**
  - Each tree was streamed to the box with `git archive`, and `vendor/betteroffice` was archived at its pin.
  - Each was built with `collaboration-rs/Dockerfile` as it is: `rust:1.98-bookworm`, release, `debian:bookworm-slim` runtime with glibc 2.36. The builds ran in a buildx builder of the run's own.
  - BuildKit's cache gave the after image the before binary at first, so the after image was rebuilt with `--no-cache`. The two binaries were checked to differ: `loaded_doc` appears only in the after binary.
  - The gateway was built once, from the after tree.
- **Stack:** Compose project `rm-prod`, a fresh stack per step. It combines `deploy/docker-compose.e2e.yml`, the stress overlay and `scripts/rm-prod.yml`. The stress overlay supplies its fake S3 and raised per-user allowances, because every peer is one user on one address.
  - **Collaboration server:** on cores 2-3. It uses production's glibc settings (`MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=131072`, `MALLOC_MMAP_THRESHOLD_=131072`). It uses production's engine pool: 2 save processes and 1 background, at 4 GiB each. It has no cgroup memory limit, as in `deploy/docker-compose.prod.yml`, and writes JSON logs.
  - **The rest:** Postgres, Redis, the gateway and the fake S3 run on core 1. The peer client and the run's scripts run on cores 0-1.
  - Otherwise it is the e2e stack. `APP_ENV` is not `production`. The e2e owner was raised to a pro plan with a 1 TiB storage limit, so the boards never hit a quota.
- **Client** (`scripts/client.mjs`, Node 22, no dependencies): it mints room tokens through the gateway (`/api/materials/{id}/collaboration-token`), as the stress harness does, and speaks capy-sync 1.
  - **build** sends a file's updates in order, as the peers that wrote them would:
    - The server binds a client id only when the room token offers it. So the client mints one token per client id in the file, joins a channel for each, and sends each update on its writer's channel.
    - It keeps up to 1,024 updates unacknowledged.
    - It leaves each channel cleanly after that writer's last update.
    - It asks for a checkpoint at the end.

    A board's first update (the board's first state) is skipped, because the server writes it when the board is created.
  - **load** opens one socket per room, all at once, and sends step 1 with an empty state vector. It writes each answer to a file.
- **Admission check** (`room-memory check`, from the bench crate): every step 2 answer is compared with its file. That covers each room after it was built, after each load and after each reload. Every clock in the file's state vector must be in the room's, with nothing pending. All 196 checks passed (`records.jsonl`, kind `check`).
- **Content** came from the 2026-11-22 bench crate's generators, with stop rules added (`scripts/bench-prod-run.patch`, `scripts/gen.sh`):
  - A board holds at most `CANVAS_BOARD_MAX` (4,194,304 bytes of state). The "4 MiB" boards stop at the last whole unit under 4,177,920 bytes, which leaves 16 KiB for the room's own writes. They come to 3.96 to 3.98 MiB.
  - The typed Plate note stops under 10,000 nodes: 964 paragraphs, 0.58 MiB.
  - `boardnote-quiet` (cut 2's client) was generated on the same 1,840 notes as `boardnote-4m`, and as a full 4 MiB board of 5,680 notes.
  - Before and after got the same files.
- **Procedure,** per build and content (`scripts/run.py`):
  - **Live, 3 runs, each on a fresh server process** (Compose restart, then healthy, then 10 s to settle):
    - Take the baseline, then build a new room.
    - Read RSS 2 s after the last update is acknowledged and the checkpoint is answered.
    - The peers leave, and the room unloads at once: `room.rs` unloads a room with no members once its store is clean, with no grace period (code). Read RSS once its `room_unload` is logged and the process is quiet (under 3 CPU ticks in 2 s).
    - The same process then loads the room again ("reloaded") and it unloads again.
  - **Loaded, 3 runs, each on a fresh process:** one joiner loads the first live room. Read RSS 1 s after step 2 is answered, then again after the room unloads.
  - **8 rooms:** build 8 mixed 4 MiB boards one at a time on one process. Then, 3 times on fresh processes, 8 joiners load them at once.
- **Readings:**
  - `Rss` from `smaps_rollup`, used in the tables.
  - `VmRSS` sampled every 20 ms.
  - `VmHWM`, reset per phase (`clear_refs` 5).
  - The container cgroup's `memory.current`, `memory.peak` (reset per phase) and `memory.stat`.
  - The cgroup tracks RSS within 1 to 2 MiB.
  - Engine children never started, since there was no Office room.
- **Heap probe** (`scripts/probe.py`): gdb ran from a side container in the host's PID namespace and called `malloc_stats()` and `malloc_trim(0)` in the server process. The image was the after image with gdb added. The probe ran once per build on mixed 4 MiB, plus a retention run on pen 4 MiB.

## Results

### Per phase (measured, MiB above the baseline)

| content | build | live | live peak (VmHWM) | live, after unload | reloaded, same process | loaded, fresh process | load peak (VmHWM) | loaded, after unload |
|---|---|---|---|---|---|---|---|---|
| mixed 4 MiB | before | 176.4 (176.3–176.8), 44.4× | 182.4, 46.0× | 188.3 | 219.6 (204.5–232.0), 55.3× | 110.0 (105.8–110.1), 27.7× | 117.9, 29.7× | 106.6 |
| mixed 4 MiB | after | 181.4 (165.4–183.7), 45.7× | 186.8, 47.1× | 179.2 | 179.2, 45.2× | 56.3 (44.9–56.8), 14.2× | 68.0 (56.6–68.4), 17.1× | 57.9 |
| pen 4 MiB | before | 169.2 (164.6–170.2), 42.7× | 173.1, 43.7× | 168.5 | 206.2 (198.9–219.0), 52.1× | 103.3 (99.3–103.5), 26.1× | 113.0, 28.5× | 100.8 |
| pen 4 MiB | after | 153.9 (153.2–154.8), 38.9× | 159.6, 40.3× | 153.6 | 153.7, 38.8× | 53.2 (42.0–57.7), 13.4× | 65.1 (53.7–69.4), 16.4× | 50.8 |
| board notes 4 MiB | before | 243.3 (228.7–247.2), 61.3× | 264.8, 66.7× | 247.1 | 297.0 (282.8–308.0), 74.8× | 138.9 (138.8–142.9), 35.0× | 161.6, 40.7× | 134.4 |
| board notes 4 MiB | after | 237.9 (224.6–284.6), 59.9× | 259.3, 65.3× | 243.2 | 247.1 (236.3–293.2), 62.3× | 69.2 (69.0–79.2), 17.4× | 81.1 (80.8–90.9), 20.4× | 65.0 |
| quiet notes, same 1,840 | after | 65.2 (56.7–65.5), 50.6× | 67.1, 52.0× | 67.7 | 68.4, 53.1× | 22.1 (8.2–23.1), 17.1× | 23.2, 18.0× | 21.9 |
| quiet notes 4 MiB | after | 205.8 (198.5–260.6), 51.7× | 212.5, 53.4× | 213.4 | 217.4, 54.6× | 54.7 (54.1–65.1), 13.7× | 66.4, 16.7× | 57.7 |
| mixed 1 MiB | before | 35.9, 35.2× | 36.8 | 37.1 | 44.4, 43.4× | 18.5 (18.4–32.2) | 21.4 | 18.7 |
| mixed 1 MiB | after | 33.5, 32.8× | 34.3 | 34.8 | 35.7, 35.0× | 2.8 (1.9–15.3) | 5.7 | 2.9 |
| pen 1 MiB | before | 22.9, 22.9× | 24.4 | 23.0 | 36.9, 36.8× | 29.0 (16.5–30.2) | 31.2 | 28.4 |
| pen 1 MiB | after | 19.8, 19.7× | 20.8 | 20.2 | 20.3, 20.3× | 1.8 (1.6–14.3) | 4.5 | 2.8 |
| board notes 1 MiB | before | 50.8, 49.2× | 55.5 | 51.1 | 62.7, 60.7× | 25.7 (25.7–41.2) | 31.1 | 24.7 |
| board notes 1 MiB | after | 48.1, 46.5× | 53.0 | 46.3 | 49.3, 47.8× | 9.5 | 12.4 | 8.2 |
| Plate note, typed, 0.58 MiB | before | 13.4, 23.0× | 14.5 | 16.9 | 20.2, 34.6× | 6.6 (5.6–18.4) | 7.5 | 6.6 |
| Plate note, typed, 0.58 MiB | after | 13.1, 22.4× | 14.1 | 13.7 | 15.7, 26.9× | 2.5 | 2.9 | 2.9 |

- Baselines were 71 to 74 MiB of RSS at idle, of which 40 to 43 MiB was anonymous.
- RSS never falls after an unload. With production's trim threshold, glibc gives back only the top of the heap.

### 8 rooms at once (measured, 8 × mixed 4 MiB, 31.75 MiB of state)

| build | steady | peak (VmHWM) | after all unload | step 2 per join |
|---|---|---|---|---|
| before | 948.0 (946.9–956.4), 29.9× | 1,023.6 (1,017.9–1,025.2) | 926.7 | 1.76–2.39 s |
| after | 459.6, 14.5× | 477.5 (474.6–480.1) | 444.2 | 0.95–1.57 s |

Eight rooms cost eight single rooms: 118.5 MiB each before (the single load's peak) and 57.5 MiB each after.

### Heap probe (measured, mixed 4 MiB, glibc's `malloc_stats`)

| phase | before: RSS / heap in use | after: RSS / heap in use |
|---|---|---|
| fresh process | 72 / 4.3 MiB (glibc holds 21 MiB) | 72 / 4.3 MiB |
| fresh process, trimmed | 55 / 4.3 MiB | 54 / 4.3 MiB |
| live room (over the untrimmed baseline) | +176.1 / +80.5 MiB | +165.6 / +80.1 MiB |
| live room unloaded | RSS stays; +33.4 MiB still in use | RSS stays; +37.9 MiB still in use |
| loaded room (over the trimmed baseline) | +122.2 / +62.9 MiB; arena 1 at 118 MiB system, 59 in use | +68.8 / +58.9 MiB; arena 0 at 55 / 55 |
| loaded room unloaded, then trimmed | +9.8 RSS / +8.1 MiB in use | +9.9 / +8.1 MiB |

- In the live phase, both arenas grew to 83 to 92 MiB each while the room used about 30 to 36 MiB of each.
- Retention run (after build, pen 4 MiB):
  - A room built live, once unloaded: 32.3 MiB in use, and 32.1 MiB a minute later.
  - A fresh process loading the room three times in turn: 8.1, 8.9 and 12.9 MiB in use, and 12.9 MiB a minute after the last.

### Against the 2026-11-22 Linux records (prod glibc settings)

| board | bench: loaded as coded | real, before | bench: loaded without the scratch | real, after | bench: live | real live, before / after |
|---|---|---|---|---|---|---|
| mixed 4 MiB | 29.2× | 27.7× (30.8× trimmed) | 14.9×; 13.7× with cut 3 | 14.2× (17.3× trimmed) | 14.7× | 44.4× / 45.7× |
| pen 4 MiB | 27.7× | 26.1× | 14.2×; 13.1× with cut 3 | 13.4× | 14.1× | 42.7× / 38.9× |
| board notes 4 MiB (synthetic) | 37.9× | 35.0× | 23.5× (scratch dropped first); live with cut 3 19.1× | 17.4× | 19.4× | 61.3× / 59.9× |

- **Loaded rooms:** the prediction holds. The untrimmed numbers sit 5 to 9% under the bench, because the startup free heap absorbs part of the load.
- **Live rooms:** the bench's prediction does not hold on the real server.
- **Cut 2:** the bench predicted −74% heap and −68% state. The server shows −73% live, −68% loaded and −68% state.

## Run

1. Stream each SHA's tree to the box with `git archive`, with `vendor/betteroffice` archived at its pin.
2. Build the generators: the 2026-11-22 bench crate (`canvas-build/audits/2026-11-22-room-memory/bench`) with `scripts/bench-prod-run.patch` applied. `scripts/Dockerfile.gen` builds it and runs `gen.sh`. That writes the `.bin` files, the `.plan` files (each update's client ids), `gen.jsonl`, `plans.jsonl` and the `room-memory` binary for `check`.
3. Build the images: `scripts/build.sh` builds the gateway and both collaboration images in the buildx builder `rm-prod`. This takes about 35 minutes, and the after image needs `--no-cache`.
4. Run the ladder: `taskset -c 0 python3 box/run.py before:mixed-1m after:mixed-1m … after:boardnote-quiet-4m before:rooms8 after:rooms8`. It resumes where it stopped, and 3 runs is the default. The full ladder took 2 h 44 min.
5. Print the tables: `python3 box/tables.py runs/records.jsonl`.
6. Run the heap probe:
   - Add gdb to the after image as `rm-prod-gdb:1`.
   - Run `RM_RUNS=…/probe python3 box/probe.py before after`, then `PROBE=retention PROBE_CONTENT=pen-4m … after`.
   - Print it with `probeshow.py`.

   The probes took about 12 minutes.

## Not measured

- **Office rooms** and their engine children.
- **Boards drawn by people:** every board here is synthetic or a replica of a recording, as in 2026-11-22.
- **A 4 MiB typed Plate note:** the node cap stops it at 0.58 MiB.
- **Several rooms built at once, and rooms with many members:** one peer stream built each room, the 8 rooms were built one after another, and only their loads were concurrent. Fan-out, awareness and outboxes under 30 members were not covered.
- **The build's transients one by one:** folds and trial copies are not separated. The live high-water attribution is est.
- **What holds 8 to 38 MiB after an unload:** not traced.
- **`malloc_trim` as a server change:** only called from gdb.
- **A long-lived process with many rooms in turn**, beyond the 8-room step.
- **Production's `APP_ENV` and Sentry.**
- **CPU and latency:** recorded as side readings only.

## Box state

- **Before (12:05 UTC):**
  - No containers or volumes.
  - 30 GB free (42 of 75 GB used); 6.9 GB memory available; swap 0.
  - Images: `capy-capacity-*` ×3, `node:22-alpine`, `pgvector/pgvector:pg16` and an older pgvector, `redis:7-alpine`.
  - Build cache: 108 entries, 21.13 GB.
  - The home folder: `capy-capacity`, `capy-gwbench`, `idle` and two kernel notes.
- **After (16:45 UTC):** the same, except swap at 18 MiB used.
- **Removed:**
  - the `rm-prod` containers, networks and volumes;
  - the images `rm-prod-collaboration:before`/`after`, `rm-prod-server:G` and `rm-prod-gdb:1`;
  - the buildx builder `rm-prod` with its cache;
  - `moby/buildkit:buildx-stable-1`;
  - the run's folder, `rm-prod`.
- **Kept:** nothing.
