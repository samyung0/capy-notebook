# Room memory on the production box, pass 2, 2026-11-24

Copied from the side-session notes (`canvas-build/audits/2026-11-24-room-memory-prod-2/`), where its `scripts/` and `records/` stay; the box's address and paths are left out.

Pass 1 ([2026-11-23](2026-11-23-room-memory-prod.md)) left two questions:
- What still holds memory after a room unloads?
- Does `malloc_trim` give the free memory back, and what does it cost?

This pass answers both on the after code (`3b4f113bb`). Reading rules are as in pass 1:
- **Measured** means run for this report, **est.** means reasoned and **code** means read from `3b4f113bb`.
- MiB is 1,024².
- RSS figures are above the same process's idle baseline unless stated.
- Each cell is the median of 3 runs on fresh processes, with the range in brackets when it matters.

## Short version

- **What stays in use after an unload is the database pool's buffers. It is bounded, not a leak** (measured, heaptrack).
  - Each pooled Postgres connection keeps its read buffer, write buffer and request buffer at about twice the largest message it has carried. For a 4 MiB board that is 8 MiB per buffer.
  - After a live build there are four such buffers (31.9 MiB). After a load there is one (8.0 MiB). Everything else is under 0.4 MiB.
  - It grows with how many of the pool's 10 connections have carried a whole board, not with rooms or loads as such.
    - Ten loads of the same room plateau at 16.8 MiB above idle.
    - Ten different rooms plateau at 17.8 MiB, still 17.8 a minute later.
    - est. ceiling: about 240 MiB at the 4 MiB board cap.
- **Trimming gives back nearly all the free memory, quickly** (measured, gdb `malloc_trim(0)`, mixed 4 MiB):
  - with a live room open: 83 to 99 MiB back in 17 to 29 ms;
  - after it unloads: 98 to 111 MiB back in 15 to 17 ms;
  - after 8 rooms unload: 420 to 434 MiB back in 30 ms;
  - with 8 rooms open: only 1 to 2 MiB, because the 459 MiB they hold is in use.
- **A trim after each unload costs almost nothing** (measured, prototype). After a room unloads, RSS goes from 175.6 to 16.4 MiB for a live-built board, and from 444 to 21 MiB for 8 boards. Build time, edit latency and step 2 times did not change beyond run-to-run noise.
- **Trimming after heavy edits as well** halves a live room's RSS while it is open (168.5 → 86.4 MiB). It costs 4% more build time and about +22 to +32 ms on edit p99. Its peak does not change.
- **One glibc arena** (`MALLOC_ARENA_MAX=1`) takes 47 MiB off a live room and is the only option that lowers the peak (180 → 131 MiB). But 8 loads at once answer 69% slower (step 2 median 1,148–1,181 → 1,995 ms), back to the times before the cuts.
- **Recommendation:**
  1. Trim once after each unload.
  2. Then close pooled connections after large rows.

  Ranked options are at the end.

## Setup

- **Box, stack and content:** as in pass 1. That is the production box, 4 vCPU, 7.6 GiB, the server on cores 2-3 with production's glibc settings (`MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=131072`, `MALLOC_MMAP_THRESHOLD_=131072`), and the e2e stack under Compose project `rm-prod`. The content is synthetic: pen 4 MiB for question 1 (small edits, no trial copies) and mixed 4 MiB, the recorded hour, for question 2.
- **The after build:** `3b4f113bb` with BetterOffice `ad34459aa`, streamed with `git archive` and built with `collaboration-rs/Dockerfile` as it is.
  - The binary's sha256 begins `1a45b7b67e95db18`, the same as pass 1's after binary. The build is reproducible, so pass-1 numbers apply directly.
- **Symbols:** the release profile already has `debug = "line-tables-only"` (`collaboration-rs/Cargo.toml` `[profile.release]`). The production binary therefore is the symbols build: heaptrack resolved every frame to a file and line, and no separate build was needed.
  - **Check that tracing does not change the numbers:** glibc's in-use count from untraced runs, against heaptrack's live bytes in traced runs, both above idle:

    | run | untraced | traced |
    |---|---:|---:|
    | load 1 | 8.1 | 8.0 |
    | live 1 | 32.3 | 31.9 |
    | same room ×10 | 16.8 | 17.7 |
    | different rooms ×10 | 17.8 | 16.0 |

    They agree within 2 MiB.
- **The trim prototype** (`scripts/trim.patch` and `scripts/trim.rs`): `3b4f113bb` plus the patch, applied on the box and never committed. Its binary begins `b0323624cf39caee`.
  - `trim.rs` (91 lines) calls `malloc_trim(0)` on a blocking thread and logs the site, the time taken and RSS before and after.
  - It is off unless `CAPY_TRIM_MIN_MS` is set. It trims at most once per that interval, except that an unload always trims.
  - It has four sites in `room.rs`:
    - after a heavy admission's `block_in_place`;
    - after `maybe_fold`'s fold;
    - after `collect_live`;
    - after the unload task's `tokio::join!(projecting, folding)`.
  - `main.rs` gets `mod trim;`.
  - The workspace lint changes from `unsafe_code = "forbid"` to `"deny"`, and `trim.rs` allows its one FFI call.
  - Variants measured:
    - **trim:** a 1 s interval.
    - **trimunload:** a 1 h interval, so after the first admission only unloads trim.
    - **arena1:** the after image with `MALLOC_ARENA_MAX=1`.
    - **arena1trimunload:** one arena plus unload trims.
- **Tools image:** the after image with Debian's gdb 13.1 and heaptrack 1.4.0 added.
  - **gdb** ran from a side container (`--pid host --cap-add SYS_PTRACE`) for `malloc_stats` and timed `malloc_trim(0)` calls.
  - **heaptrack** ran in LD_PRELOAD mode as `nobody`, with the same binary and allocator. Each traced process was killed with SIGKILL at the moment of interest, so heaptrack's "leaked" bytes are what was live then. Each trace was diffed against an idle trace with `heaptrack_print -d`.
- **Client additions** (`scripts/client.mjs`):
  - The last 2,000 updates of each build are sent one at a time, 20 ms apart, and each acknowledgement is timed.
  - A second socket sends step 1 with an empty state vector (what a new joiner sends) every 500 ms, and each step 2 is timed.
  - "Build" time is the time to the start of that paced phase.

## Question 1: what holds the memory after an unload

### Retention series

Measured, after server, pen 4 MiB. This is glibc's in-use count after each unload. Idle is 4.3 MiB.

| series | in use after each unload (MiB) |
|---|---|
| 3 boards built live, one after another | 36.6, 48.7, 52.8; 52.4 a minute later |
| 1 board loaded 10 times | 12.4, 16.4, 16.4, 17.1, 17.1, 17.1, 21.1, 21.1, 21.1, 21.1 |
| 10 different boards loaded once each | 12.4, 16.4, 17.2, 17.2, 17.2, 17.2, 21.2, 21.3, 22.1, 22.1; 22.1 a minute later |

After 8 mixed boards unload, 36.9 to 37.2 MiB stays in use, mostly as separate mappings.

### The holders

Measured with heaptrack: bytes live at the kill, against idle.

| holder | allocated at | after 1 live build | after 1 load | after 10 loads (same / different) |
|---|---|---:|---:|---:|
| a pooled connection's read buffer | tokio-util `FramedImpl::poll_next` (framed_impl.rs:219) ← tokio-postgres `Connection::poll_read` (connection.rs:102), in the connection task deadpool-postgres spawns (lib.rs:222). It is filled by `note_store::load` reading the state. | 8.00 | 8.00 | 17.73 / 16.00 |
| a connection's request buffer, from the store task's INSERT | postgres-protocol `bind` ← tokio-postgres `encode_bind_raw` (query.rs:311) ← `note_store::append_row` (note_store.rs:705) ← `append` ← the room's store task (room.rs:4280) | 7.96 | – | – |
| another connection's request buffer, from the fold's UPDATE | the same bind encoding ← `note_store::fold` (note_store.rs:931) ← the unload's fold (room.rs:5359) | 7.95 | – | – |
| a connection's write buffer | tokio-postgres codec `encode` (codec.rs:45) ← `Connection::poll_write` (connection.rs:236) | 7.93 | – | – |
| everything else (V8 zones, hyper buffers, prepared statements) | | < 0.1 | < 0.1 | < 0.4 |

### Bounded or leaking

Every holder is **bounded**: a pool of buffers, not a leak.
- Each buffer grew by doubling to hold one roughly 4 MiB message, and keeps that capacity for as long as its connection lives.
- deadpool keeps up to 10 connections (`main.rs` `max_size(10)`), and as configured it never closes idle ones (code).
- Each buffer is above `MALLOC_MMAP_THRESHOLD_`, so it is its own mapping. A trim cannot touch it, but closing the connection unmaps it at once.
- est. ceiling: 10 connections × 3 buffers × 8 MiB, about 240 MiB at the 4 MiB board cap. That needs every connection in turn to carry a whole board both ways.
- The measured series stop growing:
  - same room: from the 7th load;
  - different rooms: from the 9th.
- The pass-1 series (8 → 9 → 13 MiB) is the same thing: more connections picking up a board-sized buffer.

### Fix sketch

Not built. In `note_store::load`, `append` and `fold`: once the transaction has committed, if the bytes moved are over a threshold, drop the connection instead of returning it to the pool:

```rust
// The connection's read, write and request buffers keep the largest
// message's capacity for the pool's lifetime; close it instead.
if moved > LARGE_ROW_BYTES {
    drop(deadpool_postgres::Object::take(client));
}
```

- `moved` is the state plus log bytes read in `load`, `row.len()` in `append`, and the state written in `fold`.
- The threshold needs Epo's sign-off. 1 MiB would catch whole boards.
- The sources store (`crates/sources/src/store.rs`, `self.db.get()` at 566, 1261, 1311, 1389 and 1462) could take the same guard if its rows are large. It was not traced.
- **Alternative:** patch tokio-postgres, as the repo already patches `third_party/tungstenite`, to swap a buffer over 1 MiB for an empty one once it drains. This keeps connections and statement caches, but it is a patch to maintain.

## Question 2: does trimming give it back, and what does it cost

### gdb trims

Measured, after server, mixed 4 MiB. Absolute RSS in MiB; a fresh idle process sits at 70.4 to 71.9.

| moment | RSS before | glibc in use | `malloc_trim(0)` | RSS after | returned |
|---|---:|---:|---:|---:|---:|
| live room open (3 runs) | 236.9–252.6 | 79.8–81.3 | 17.4–29.4 ms | 153.0–154.1 | 82.8–98.6 |
| after it unloads | 185.5–196.3 | 30.1–39.2 | 14.7–16.8 ms | 84.9–89.5 | 97.7–111.4 |
| 8 rooms open (2 runs) | 528.4–528.8 | 475.4 | 2.9–3.1 ms | 526.6–527.6 | 1.2–1.8 |
| 8 rooms unloaded | 509.5–523.9 | 36.9–37.2 | 30.4–30.6 ms | 89.2–90.0 | 420.3–433.9 |

- **Why glibc does not do this itself:** a trim leaves glibc's "system bytes" unchanged while RSS falls. The returned pages lie between chunks still in use, not at the top of a heap (measured).
  - glibc's automatic trim (`MALLOC_TRIM_THRESHOLD_`) only shrinks the top.
  - `malloc_trim(0)` walks every arena and releases the free pages inside.
- **After a trim,** RSS is the trimmed idle process (about 55 MiB) plus what is in use. After an unload, the in-use part is the pool buffers from question 1.
- **Stalls:** gdb stops the whole process while it is attached, so these runs cannot show trim stalls. The prototype measured them.

### Prototype, live

Mixed 4 MiB, 3 runs each, MiB above idle.

| variant | live | live peak (VmHWM) | after unload | build | edit ack p50 / p90 / p99 / max (ms) | step 2 p50 / p99 / max (ms) |
|---|---:|---:|---:|---:|---|---|
| after, as shipped | 168.5 (166.3–169.9) | 180.4 | 175.6 | 71.5 s | 72 / 107 / 221 / 388 | 72 / 216 / 297 |
| trim (all sites, 1 s) | **86.4** (84.5–91.1) | 174.7 | **14.4** | 74.4 s | 72 / 104 / **243** / 411 | 71 / 206 / 341 |
| trimunload | 165.1 (164.1–182.9) | 177.5 | **16.4** | 72.2 s | 72 / 89 / 211 / 412 | 73 / 238 / 362 |
| arena1 | 121.9 (111.1–125.3) | **131.3** | 128.4 | 72.2 s | 41 / 74 / 219 / 346 | 65 / 216 / 325 |
| arena1trimunload | 116.3 (115.3–124.6) | **126.9** | **17.8** | 72.1 s | 41 / 78 / 214 / 395 | 69 / 228 / 308 |

**Reading the latencies:**
- The p50 is bimodal from run to run: 41 or 72–73 ms in every variant, including the after build. The p50 differences are therefore run artefacts.
- Across the variants where no trim overlapped an edit, p99 spreads 211–221 ms for edits and 216–238 ms for step 2. Only the trim variant's edit p99 (243) stands outside that spread.

**Trim cost by site:**
- **trim:** 266 admission trims per 72 s build, median 14.2 ms (1.6–58.2), each returning a median 51 MiB.
  - No fold or collect trims ran: the 1 s throttle had always just been used by an admission.
  - 56 of 6,000 edits overlapped a trim, with p50 306 ms against 72 ms for the rest. This is an upper bound: the overlapping edits include the heavy edits whose admission set off the trim.
  - 32 step 2s overlapped, p50 141 ms against 71.
- **Unload trims:**
  - trim: 10.7 ms, 98.5 MiB returned;
  - trimunload: 26.1 ms (22.2–31.0), 158.5 MiB returned;
  - arena1trimunload: 13.3 ms, 106 MiB returned.
- The one admission trim per run in the unload-only variants took about 2 ms. It returned the roughly 16 MiB of free heap a fresh process carries from startup.

### Prototype, loaded and 8 rooms

MiB above idle.

| variant | loaded | after unload | step 2 | 8 rooms open | 8-room peak | after 8 unload | 8 joiners' step 2, median / max |
|---|---:|---:|---:|---:|---:|---:|---|
| after (8 rooms: pass 1) | 44.7 | 42.2 | 280 ms | 459.6 | 477.5 | 444.2 | 1,181 / 1,573 ms |
| trim | 45.0 | −6.8 | 261 ms | 459.1 | 476.9 | **21.0** | 1,148 / 1,531 ms |
| trimunload | 56.3 (44.9–59.6) | −7.0 | 255 ms | – | – | – | – |
| arena1 | 45.4 | 49.3 | 273 ms | – | – | – | – |
| arena1trimunload | 45.2 | −9.6 | 249 ms | 459.9 | 478.6 | **22.4** | **1,995 / 2,348 ms** |

- After-unload values go negative because the trim also returns the startup free heap, which is part of the baseline.
- Unload trims of a loaded room took 5 to 10 ms and returned 51 to 63 MiB.
- When 8 rooms unload together:
  - The first trim takes 21 to 45 ms and returns about 400 to 425 MiB. The other seven take 0.4 to 10 ms.
  - Trims that overlap each count the others' drop, so the per-trim "returned" figures double count.
  - A real version should merge a burst of unloads into one trim.
- During the 8 boards' builds, the trim build ran 594 admission trims of 1.9 to 21 ms. They returned more as each board grew (7.5 → 80 MiB).

### The cheap alternatives

- **`MALLOC_ARENA_MAX=1`:** measured above. It saves 47 MiB on a live room and lowers its peak by 49 MiB. A single load is not slower. Eight loads at once contend on the one arena, and step 2 goes from 1,148–1,181 ms to 1,995 ms.
- **`MALLOC_TOP_PAD_`, or a lower `MALLOC_TRIM_THRESHOLD_`:** not measured. est. no saving. Both act only on the top of a heap: the top pad defaults to 128 KiB, and the threshold is already 128 KiB. The free memory is between chunks in use, shown by the unchanged system bytes under a trim.
- **The fold's scratch document in its own arena:** not measured, and glibc cannot do it. glibc gives each thread an arena and has no call to choose one per allocation, and with 2 arenas there is none to spare. est.: the ways to do it are a fold in a child process or a separate allocator inside yrs (Rust's allocator API is unstable, and yrs takes none). Neither is cheap.

## How to rerun

Everything runs on the box in a run folder, `rm-prod`, with the scripts in `box/`.

1. **Trees:** stream `git archive 3b4f113bb` from the repository, with `vendor/betteroffice` archived at its pin, into `after/src` as in pass 1. Stream it again into `trim/src` and run `patch -p1 < box/trim.patch` there.
2. **Images:** run `sh box/build2.sh`. It creates the builder `rm-prod`, the content generator and its data if missing (`gen.sh`, `Dockerfile.gen`, `bench-prod-run.patch`), `rm-prod-collaboration:{after,trim}` and `rm-prod-server:G`.
3. **Tools image:**
   - `docker run --name rm-prod-tools-setup --user root --entrypoint sh rm-prod-collaboration:after -c 'apt-get update && apt-get install -y gdb heaptrack'`
   - `docker commit --change 'ENTRYPOINT []' rm-prod-tools-setup rm-prod-tools:1`
4. **Experiments:** `taskset -c 0 python3 box/pass2.py <name>`, in this order. Each appends to `runs/pass2.jsonl` and `runs/records.jsonl`.
   1. `retention`
   2. `heaptrack` (uses the rooms `retention` saved)
   3. `trims`
   4. `proto-after`
   5. `proto-trim`
   6. `proto-arena1`
   7. `proto-trimunload`
   8. `proto-arena1trimunload`
   9. `down`
5. **Tables:** `python3 box/pass2tables.py runs/pass2.jsonl runs/records.jsonl`.
6. **Heaptrack reports:**
   - `docker run --rm -v <run folder>/ht:/ht --entrypoint heaptrack_print rm-prod-tools:1 -f /ht/<trace>.gz -d /ht/<idle>.gz --print-leaks 1 --print-peaks 0 --print-allocators 0 --print-temporary 0 -n 12 -s 2 > out.txt`
   - then `python3 box/htsum.py out.txt`.

**Saved files**, in the side-session notes under `canvas-build/audits/2026-11-24-room-memory-prod-2/`:
- `records/`: `pass2.jsonl`, `records.jsonl`, `timelines.jsonl`, `retention-rooms.json`, `gen.jsonl`, `plans.jsonl` and the run and build logs.
- `records/heaptrack/`: the five traces (idle, live, load1, same10, diff10) and their reports against idle.
- `scripts/`: everything above, plus `trim.rs`.

## Not measured

- Edit latency in *other* open rooms while an unload trim runs. est. up to the trim's length (5–45 ms), since a trim holds each arena's lock while it walks it.
- Several rooms built live at the same time. It is unknown whether their free memory adds up or is shared, so admission trims' value with concurrent live rooms is unknown.
- The connection-closing fix and the tokio-postgres patch were not built. The reconnect cost is est. a few ms.
- `MALLOC_TOP_PAD_`, a lower trim threshold and a separate fold arena: reasoned only.
- Rooms other than canvas (Plate notes, BetterOffice), 1 MiB boards and the before build. mimalloc was out of scope by the brief.
- Production traffic: everything is synthetic.

## Options for Epo, ranked

1. **Trim once after each room unloads.** Recommended, first.
   - **Saving (measured):** after a live-built 4 MiB board unloads, 175.6 → 16.4 MiB. After a loaded board, 42.2 → −7.0. After 8 boards, 444 → 21–22 MiB. Nothing changes while rooms are open.
   - **Cost:** one trim per unload on a blocking thread: 5 to 31 ms for one room, and up to 45 ms for the first of 8 at once. Build time and latency are unchanged within noise (72.2 s against 71.5 s; edit p99 211 against 221 ms).
   - **Risk:** other rooms' allocations can wait on an arena lock during a trim. This was not measured, est. up to 45 ms.
   - **Code:** it needs one `unsafe` FFI call, so the workspace's `unsafe_code = "forbid"` must become `"deny"`, with an allow in one module. That needs your sign-off. Merge a burst of unloads into one trim.
2. **Close a pooled connection after a large row** (`Object::take` in `note_store::{load, append, fold}`). Recommended, second.
   - **Saving:** the 8 to 32 MiB that stays in use after an unload (measured holders). That is most of what is left after option 1: est. about 30 MiB more, down to a trimmed idle process. It also removes the est. ceiling of about 240 MiB.
   - **Cost:** a reconnect after each transfer over the threshold (est. a few ms, not measured), and that connection's statement cache.
   - **Risk:** low. No unsafe code; the threshold needs sign-off. Not prototyped.
3. **Also trim after heavy admissions, at most once a second.** Not now.
   - **Saving:** a live room being built holds 86 MiB instead of 165–169 MiB, 79 MiB beyond option 1. The peak is unchanged (175 against 180).
   - **Cost:** 266 trims per 72 s build (median 14 ms, max 58), build +4%, edit p99 +22 to +32 ms.
   - **Risk:** with several live rooms the throttle is shared. This was not tested.
   - Revisit only if many boards are built live at once, and measure that first.
4. **`MALLOC_ARENA_MAX=1`.** Not recommended.
   - **Saving:** a live room −47 MiB, peak −49 MiB.
   - **Cost:** 8 loads at once answer step 2 69% slower (median 1,995 against 1,148–1,181 ms; max 2,348 against 1,531–1,573), back to the times before the cuts.
   - **Risk:** contention grows with concurrent rooms. It is a one-line config change.
5. **`MALLOC_TOP_PAD_`, a lower trim threshold, or the fold's scratch in its own arena.** Not recommended.
   - **Saving:** est. none for the first two (they act only on the heap's top).
   - **Cost:** the third is not available in glibc and would take a child process or a custom allocator.

## Box state

- **Before** (2026-11-23, 17:09 UTC):
  - no containers or volumes; networks `bridge`, `host`, `none`;
  - 7 images: `capy-capacity-layout-cost:L`, `capy-capacity-server:L`, `capy-capacity-collaboration:L`, `pgvector/pgvector:pg16` plus an older untagged pgvector, `node:22-alpine`, `redis:7-alpine`;
  - build cache 108 entries, 21.13 GB;
  - disk 42 of 75 GB used, 30 GB free;
  - 6,887 MiB memory available, 18 MiB swap used;
  - the home folder held `capy-capacity`, `capy-gwbench`, `containers-before-kernel-20261020.txt`, `idle` and `services-before-kernel-20261020.txt`.
- **During:**
  - free disk fell to 14 GB, from my builder's cache and step folders;
  - the lowest available memory seen was 5,475 MiB;
  - swap moved 18 → 23 MiB;
  - the guard (under 300 MiB available while swap moves) never tripped.
- **After** (19:38 UTC):
  - 0 containers, 0 volumes, the same networks and the same 7 images;
  - build cache 108 entries, 21.13 GB;
  - disk 42 of 75 GB used, 30 GB free;
  - 6,867 MiB available, 23 MiB swap used;
  - the same home folder listing.
- **Removed:**
  - the images `rm-prod-collaboration:after`, `rm-prod-collaboration:trim`, `rm-prod-server:G` and `rm-prod-tools:1`;
  - the buildx builder `rm-prod` and its state volume;
  - the image `moby/buildkit:buildx-stable-1`;
  - the run folder `rm-prod`, including the traces and step folders.
- **Kept on the box:** nothing.
- **Mac:**
  - The local scratch copies are deleted.
  - The repository was only read (`git archive`, `git show`). Its working tree shows changes from other sessions, none from this run.
