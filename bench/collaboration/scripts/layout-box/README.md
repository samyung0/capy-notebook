# Layout cost on the prod box

Server RAM and CPU of a note room in the Plate layout and the blocks layout, on
the same content, for each editing state. It runs on the production machine
(todo-blocksuite-spike.md, D9). This is phase `L` of the throwaway capacity
stacks in the style of the 2026-10-28 presence run
(capy-harness `2026-10-28-presence-load/box/`). Epo's rules for the box: no
deploys; production's deployment, config and data stay untouched; SSH only,
with no port opened; everything a run starts is cleaned up; and Epo is told
beforehand what will run.

There are two parts:

- **Matrix** (`run-matrix.sh`, `matrix-L.yml`, image from
  `Dockerfile.layout-cost`): `../layout-cost` in one offline container. It
  runs real yrs docs with the server's own `model.rs` admission, measuring
  thread CPU and the heap held by the room (counted by the allocator), plus
  RSS under production's glibc settings. It covers these states:
  - idle rooms
  - a fresh joiner's step-1 answer
  - one typist, and five typists, at 10 keys/s for 60 s
  - 50 block moves
  - a 150-paragraph paste
  - a reconnect with a 500-update offline draft
  - an hour of three rotating sessions with held deletions
  - `collect_live` under two windows
  - an unload fold, then a reload

  Each state runs for the near-limit load-test note and for a small note,
  in both layouts.
- **Stack steps** (`ladder.sh plan-L.txt`, `run-step.sh`, `capacity-L.yml`):
  the branch's real collaboration server in a separate e2e compose stack.
  `COLLABORATION_DOCUMENT_LAYOUT` is set per step, and `stress.ts` peers type
  into the rooms (into each block's `prop:text` when the room uses the blocks
  layout). `monitor.sh` samples the cgroup CPU and RSS. The steps cover idle
  rooms, and one or five typists at 10 edits/s, for both note sizes.

## Commands

On the Mac, from this worktree:

```sh
bench/collaboration/scripts/layout-box/prepare-L.sh /tmp/capy-L --upload
```

This stages `blocksuite-notes` (`CAP_REF`), lays this checkout's
`bench/collaboration/scripts` over it, and uploads everything to
`/root/capy-capacity/L` and `/root/capy-capacity/box-L`.

On the box (`ssh -i ~/.ssh/id_ed25519_capy_prod root@49.12.219.255`), run each
step only after the one before it has finished:

```sh
cd /root/capy-capacity
# 1. Images (cold: up to an hour, several GiB of RAM; nothing else running).
nohup setsid box-L/build-L.sh >runs/build-L.out 2>&1 &
# 2. The matrix (about 5 minutes).
nohup setsid box-L/run-matrix.sh full >runs/matrix-L.out 2>&1 &
# 3. The stack steps (about an hour).
nohup setsid box-L/ladder.sh box-L/plan-L.txt >runs/ladder-L.out 2>&1 &
# 4. Clean up: list first, then apply, then the printed prune and rm.
box-L/cleanup.sh; box-L/cleanup.sh --apply
```

Fetch `runs/L-*` (each step has `summary.json`; the matrix has
`layout-cost.jsonl`) before step 4. Write the report as
`bench/collaboration/reports/YYYY-MM-DD-layout-cost.md`.

## Limits

- **Matrix:**
  - Pinned to production's collaboration cores `2,3` (`COLLABORATION_CPUSET`),
    with `cpus: 1`, since it is single-threaded.
  - Hard 2 GiB memory cap with no swap, `network_mode: none`, a read-only root,
    no capabilities, `pids_limit` 16, and a 1 h `timeout`.
  - It reads only the note values in its image and writes JSONL to stdout. It
    opens no DB, socket or room.
  - Peak RSS on the laptop at full scale was 0.7 GiB (macOS malloc, 20 idle
    near-limit blocks rooms); glibc with production's trim settings holds less.
  - Exit 137 in `EXIT` means it hit the cap: rerun with `CAP_ROOMS=10`.
- **Stack steps:**
  - Collaboration runs on cores `2,3` with production's allocator settings and
    engine pool. As in production, it has no memory limit (runbook, 2026-10-08).
  - Postgres, Redis, the gateway and the fake S3 run on core 1, and the
    generators on cores 0-1. No host ports are published.
  - Each step tears its stack down.
  - `ladder.sh` waits for 5 GiB `MemAvailable` before each step.
  - `monitor.sh` aborts a step and kills the generators when `MemAvailable`
    drops under 300 MiB with swap traffic, or when the sampler stalls for 30 s.
  - Each step has a 30-minute timeout.
- **Runtime:**
  - Laptop (M-series), `SCALE=1`: 106 s, of which 66 s is the blocks
    near-limit session hour.
  - Box (4 vCPU EPYC-Rome): expect 3-6 minutes.
  - Stack steps: 10 steps of about 5-7 minutes (stack up, 20 s baseline, joins,
    2-3 minutes of load, settling, teardown), about an hour in all.

## Smoke run without the box

```sh
SCALE=0.1 ROOMS=10 RUNS=3 bench/collaboration/scripts/run-layout-cost.sh
```
