# Rust and Node collaboration servers under bench:stress (2026-10-08)

The same stress phases were run against the Rust server (this branch) and the
Node server (origin/main 65a9ae87), back to back on one machine. Both runs used
20 peers in the budgeted phase, 5 in the near-limit phase, and 3 minutes per
phase, with no cost windows. The question was whether the 45 ms p95 budget
still holds, and what stalled the Rust server in the near-limit phase.

## Setup

- **Host:** Windows 11 with Docker Desktop (16 CPUs, 16 GB). The stress
  client ran on the host. Its event loop shows about 30 ms p50 delay on both
  runs (Windows timer granularity), so absolute latencies sit above the CI
  runner's.
- **Rust:** the capy-sync driver of `bench/collaboration/scripts/stress.ts`.
  Images: `rust-core-collaboration:local` sha256:451e4f70 (built from
  d54dc20c's tree on the fork build branch with yrs-hardening) and
  `rust-core-server:local` sha256:fd43d9a5.
- **Node:** main's harness (Hocuspocus provider) with the `capy-e2e-*:local`
  images, unmodified except that named compose overrides were layered.
- **Both runs:** an in-network prober, a node:22-alpine container on the
  stack's network, timed `/metrics` every 250 ms. Each server logged its
  scheduling lag (`collab_health` `lag_max_ms`) every 5 s. Together these
  separate a server stall from the host's port forwarding and from the client.

## Results

Marker latency in ms (p50 / p95 / p99 / max). Both runs converged in every
room, with no missing or doubled markers and no collaboration errors.

| Room | Rust | Node |
| --- | --- | --- |
| office (budgeted) | 35 / 40 / 42 / 57 | 33 / 37 / 39 / 78 |
| plate (budgeted) | 34 / 39 / 43 / 234 | 33 / 37 / 39 / 189 |
| note-limit | 33 / 37 / 39 / 44 | 33 / 40 / 669 / 849 |
| text (4 MiB) | 33 / 37 / 38 / 84 | 33 / 39 / 584 / 837 |

Server responsiveness in the near-limit phase:

| | Rust | Node |
| --- | --- | --- |
| Host `/metrics` probe, max | 63 ms | 640 ms |
| Host `/metrics` probe, p99 | 6 ms | 205 ms |
| In-network probe answers over 100 ms | 1 (startup) | 12 |
| Server lag, max over the run | 87 ms | 822 ms |
| Lag windows of 200 ms or more | 0 | 9, one per text-source save |

- **Budgeted phase:** both servers are within the 45 ms p95 budget on this
  machine. The difference, about 2-3 ms at p95, is inside this host's
  run-to-run noise. Earlier Rust runs while other stacks shared the machine
  gave p95 between 51 and 65 ms.
- **Near-limit phase:** Node stalls its event loop for up to 0.8 s on every
  save of the 4 MiB text source. The Rust server no longer stalls.

## The Rust near-limit stall (fixed in d54dc20c)

- **Before the fix:**
  - The Rust server's scheduling lag rose to 0.8-1.1 s every 30 s, which is
    the text source's maximum save debounce.
  - The `/metrics` probe from the host reached 7.2 s on a busier run.
- **Finding the cause:**
  - A diagnosis build logged every spawned task's poll that held a worker for
    50 ms or more.
  - The stalls were single polls of the source store task, of 0.3-1.1 s each.
  - Stage timings inside the store put all of that time in `effect_tokens`.
- **Why `effect_tokens` was slow:**
  - A text room's pending effect spans every edit since its baseline. Under
    peers typing all over the file, that is about 8 MB of before and after
    text.
  - The token count looked up the Unicode script of every changed character,
    about 0.5 s for that effect.
- **The fix:**
  - No Han, Kana or Hangul code point sits below U+1100, so the lookup now
    runs only above it. That brings the count to about 50 ms, with the same
    token totals.
  - The count runs on the blocking pool.
  - So does the room's delta row with its text effects or Office state.

## Raw records

Both runs' stress.json: [`2026-10-08-rust-node-stress.json`](2026-10-08-rust-node-stress.json)
(`rust`, `node`). Node's run has no server CPU or memory figures: main's
harness reads the Docker Engine API only over a Unix socket.
