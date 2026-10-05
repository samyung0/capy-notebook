# Office engine replicas on the production box, 2026-10-05

The capacity run earlier that day
([2026-10-05-prod-capacity.md](2026-10-05-prod-capacity.md), bottleneck 2)
found the single Office engine worker spending most of its time reopening the
original file on every save. Epo approved caching each room's parsed original
in the worker. This report measures that cache.

Code: Capy main `a379d7ea` plus the replica commit, BetterOffice `capy-ci`
`7ec9b41b` plus the `office-replicas` branch. Raw data, plans and scripts:
`capy-docx-review-harnesses/2026-10-05-office-engine/` (`runs/<step>/`,
`box-logs/`, `perfile-*.log`). The harness is the earlier run's, renamed to
its own compose project (`capy-officeengine`), with `COLLAB_IMAGE` to pick the
collaboration image per step and `SWAP_LOG_ONLY` to record swapping instead
of stopping the step.

## Short version

- **XLSX saves get about 5× cheaper.** The 16,000-row gradebook's pending
  effects take 7.1 s of worker time per save on the box; with the room's
  replica, 1.4 s after the first. The effects are identical.
- **20 large-file rooms are now under saturation.** With XLSX replicas the
  worker sits at 31–46% in steady windows (98–100% before), the queue holds
  2 calls instead of 20, and saves take 2.3–2.5 s at p95 instead of 45–51 s.
  This costs about 520 MB more collaboration RSS (1.9 GiB at most).
- **PPTX and DOCX keep no replica.** A PPTX replica saved 0.3 s per save of
  the 24 MB deck for about 90 MB. Under a shared budget the PPTX replicas
  pushed out the XLSX ones and the cache stopped working at 20 rooms. A DOCX
  open is a small part of its baseline.
- **Plain LRU fails once the workbooks outgrow the budget.** Rooms save in
  turn, so each new replica pushed out the one needed next: at 30 rooms
  there were no hits. A new replica now pushes out only replicas idle for
  2 minutes; with that, 30 rooms got 41 hits to 14 misses.
- **30 rooms did not run cleanly on this box.** With nine workbooks open,
  collaboration RSS reached 2.7–2.9 GiB and the box swapped or ran short of
  memory. Those steps are invalid. Their numbers below show only the trend.
- **The re-applied state is not the cost it looked like.** Applying a
  later state to a kept replica takes about 0.5 s for the gradebook whether
  it is the whole state or the one-cell delta. The engine rebuilds and
  recalculates the whole model on every remote update.

## Setup

As in the earlier run: 4 vCPU EPYC box, collaboration pinned to cores 2-3,
Postgres, Redis, gateway and fake S3 on core 1, load generators on cores
0-1, 4 editors per room (3 where marked), 4 minutes per step, the six files
cycled large first (`jp_llm2.pptx`, `large-gradebook.xlsx`,
`long-handbook.docx`, `lecture.pptx`, `course-guide.xlsx`,
`exchange-plan.docx`).

The box had less memory than in the morning. `dockerd` held 1.4–1.7 GiB of
RSS and 77–500 MiB sat in swap from earlier runs, so a step started with
about 4.7 GiB available instead of 5.6. The "before" steps were rerun on the
same box to compare against: `before2c-20` reproduced the morning's 20-room
step (98% busy, queue 20, save max 68 s against 62 s).

"Steady save p95" is the median of the 20 s windows' Office save p95 after
the first two windows with saves, which hold the room loads.

## Per-save engine time

Six successive saves of one room, each one edit more, on cores 2-3 in the
collaboration image (`perfile/bench-replica.mjs`). Milliseconds per call.

| file | before | replica, first save | replica, later saves | output |
| --- | --- | --- | --- | --- |
| `large-gradebook.xlsx` | 7,013–7,435 | 6,846 | 1,363–1,405 | identical |
| `long-handbook.docx` | 433–555 | no replica | 433–469 | identical |
| `jp_llm2.pptx` (24 MB) | 464–498 | 617 | 193–239 (tested, then dropped) | identical |

On an M-series Mac the same calls take 3.2 s → 0.6 s (XLSX), 0.19 s (DOCX,
unchanged) and 0.25 → 0.09 s (PPTX).

Where the gradebook's time goes (Mac): the open (unzip, parse, full
recalculation) 2.0 s, applying the state 0.7 s, the effects 1 ms. On a kept
replica, applying a later state takes 0.5 s either as the full state or as
the 127-byte delta: `apply_update_v1` materializes the whole model from the
Yrs document, recalculates it and diffs it against a clone of the previous
model on every remote update.

## Memory per replica

Linear memory growth and RSS per extra replica kept, in one process:

| file | unzipped | WASM growth | RSS | estimate (20 × unzipped) |
| --- | --- | --- | --- | --- |
| `large-gradebook.xlsx` | 8.1 MiB | 159 MiB | 87–149 MiB | 162 MiB |
| `course-guide.xlsx` | 1.2 MiB | 18 MiB | 18 MiB | 23 MiB |
| `jp_llm2.pptx` | 24.4 MiB | 91 MiB | 91 MiB | not kept |
| `lecture.pptx` | 0.6 MiB | 3.6 MiB | 3.5 MiB | not kept |

`OFFICE_REPLICA_BUDGET_BYTES` is 1 GiB of estimates, six gradebooks.

## Office room ramp

Before: the morning's 2-core steps (`office2c-*`, re-summarized) and the
reruns (`before2c-*`). After: `oe2c-2/5/10` kept XLSX and PPTX replicas,
`oe2c-10x/20x` XLSX only, `oe2c-20i/30i` XLSX only with the idle rule (the
committed version). Below the budget the idle rule changes nothing.

| step | rooms × editors | DOCX / XLSX / PPTX edit p95 ms | engine busy % mean/max | queue max | steady save p95 s | saves | hits / misses / evictions | replicas, est. MiB | WASM MiB max | collab RSS MiB max | valid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| office2c-2 | 2 × 4 | - / 38 / 39 | 24/43 | 1 | 7.3 | 14 | - | - | - | 625 | yes |
| oe2c-2 | 2 × 4 | - / 39 / 38 | 9/43 | 1 | 1.5 | 14 | 12 / 2 / 0 | 2, 308 | 400 | 678 | yes |
| office2c-5 | 5 × 4 | 47 / 43 / 44 | 32/55 | 4 | 7.2 | 36 | - | - | - | 799 | yes |
| oe2c-5 | 5 × 4 | 40 / 42 / 49 | 13/58 | 4 | 1.6 | 35 | 24 / 4 / 0 | 4, 335 | 418 | 813 | yes |
| office2c-10 | 10 × 4 | 46 / 61 / 61 | 61/90 | 7 | 17.0 | 70 | - | - | - | 1019 | yes |
| oe2c-10 | 10 × 4 | 108 / 123 / 86 | 27/67 | 9 | 1.5 | 70 | 48 / 8 / 0 | 8, 670 | 680 | 1384 | yes |
| oe2c-10x | 10 × 4 | 97 / 73 / 70 | 28/70 | 9 | 1.7 | 70 | 24 / 4 / 0 | 4, 370 | 441 | 1232 | yes |
| before2c-20 | 20 × 4 | 223 / 193 / 190 | 98/101 | 20 | 44.8 | 108 | - | - | - | 1341 | yes |
| oe2c-20sl (XLSX + PPTX) | 20 × 4 | 187 / 180 / 167 | 97/100 | 19 | 45.1 | 111 | 6 / 78 / 66 | 12, 986 | 1205 | 2419 | no, swapped |
| oe2c-20x | 20 × 4 | 186 / 171 / 177 | 55/100 | 16 | 2.3 | 152 | 39 / 6 / 0 | 6, 693 | 759 | 1861 | yes |
| oe2c-20i | 20 × 4 | 182 / 197 / 196 | 57/103 | 19 | 2.5 | 155 | 40 / 6 / 0 | 6, 693 | 762 | 1944 | yes |
| office2c-30 | 30 × 4 | 129 / 141 / 122 | 98/101 | 30 | 90.5 | 75 | - | - | - | 1568 | yes |
| before2c-30e3 | 30 × 3 | 167 / 142 / 188 | 98/100 | 30 | 91.8 | 85 | - | - | - | 1672 | yes |
| oe2c-30x (plain LRU) | 30 × 4 | 116 / 120 / 105 | 98/100 | 30 | 107.5 | 72 | 0 / 36 / 28 | 8, 1016 | 1091 | 2427 | no, swapped |
| oe2c-30i | 30 × 4 | stopped | 98/101 | 29 | 35.6 (21–26 at the end) | 157 | 41 / 14 / 0 | 8, 878 | 1092 | 2796 | no, under 1 GiB available |

The busy figures include the room loads. At 20 rooms (`oe2c-20x`) the
steady windows were 31–46% busy with 2–3 calls queued.

What this shows:

- Saves drop from 7–17 s to about 1.5 s at up to 10 rooms, and from 45 s to
  2.5 s at 20.
- Edit p95 at 10 rooms went from 46–61 ms to 70–123 ms, still far below the
  1 s budget. Main-thread lag p99 rose from 30 to 39 ms on average. Saves no
  longer wait minutes in the worker queue, so their main-thread passes
  (bottleneck 3) come closer together. At 20 rooms edits are as before.
- At 20 rooms with XLSX and PPTX replicas the estimates needed about 1.4 GB.
  Under 1 GiB of plain LRU there were 6 hits to 78 misses, the worker stayed
  full, and RSS grew by 1 GB until the box swapped.
- At 30 rooms nine workbooks need about 1.1 GB of estimates. With plain LRU
  every save missed. With the idle rule eight replicas stayed and the ninth
  room missed each time. Saves recovered to 21–26 s p95 by the last windows,
  but the worker stayed full. RSS reached 2.7 GiB. Available memory fell
  under 1 GiB, which stopped the step.

The earlier attempts at 20 and 30 rooms, with the memory guard stopping the
step at the first swapped page, are in `runs/` (`oe2c-20`, `oe2c-20e3`,
`oe2c-30e3`, `oe2c-20b512`, `oe2c-30b512e3`). The two 512 MiB steps tripped
the guard within a minute, on 1 MiB of swap at 3.6–3.8 GiB available. The
box had started swapping on its own by then.

## A second engine worker

Not built. What it would add, from these numbers:

- **With replicas, up to about 20 large rooms:** nothing for throughput.
  The worker is under half busy, and a second one would only cut queue
  waits.
- **At 30 rooms:** the limit is memory more than the worker. With all nine
  workbooks kept (about 1.1 GB of estimates), the 20-room figures suggest
  the worker would sit near 60%. A second worker would help only once the
  replicas fit, or past about 40 large rooms.
- **Without replicas:** demand at 20 rooms is about 1.2–1.4 workers, so two
  workers would get under saturation.
- **What it costs:** rooms must be routed to workers by room so each keeps
  its replicas. Each worker holds its own engines; the XLSX engine alone
  held 190–330 MiB of WASM before any replica. The collaboration service
  used 0.7–0.85 of its 2 cores at 20 rooms with replicas, and 1.2–1.35 at
  30 rooms or without replicas (main thread plus one full worker). A second
  busy worker would then compete with the main thread unless it gets a
  third core.

## Next steps

1. An effects-only XLSX apply. The pending effects read only the authority's
   Yrs document and the cells it names, so they need neither the full model
   rebuild nor the recalculation that each update pays (0.5 s on the Mac,
   1.4 s on the box). That would make XLSX saves nearly free and replicas
   much smaller. It is a BetterOffice engine change.
2. Decide the budget against the production box's other services. 1 GiB of
   estimates is at most about 0.9 GB of RSS on top of the 1.3–1.7 GiB the
   service peaks at without replicas.
3. `inspectOffice` and agent edits on the gradebook grow the XLSX engine's
   linear memory to about 1.9 GiB, which stays resident on Linux (2.4 GiB
   RSS in the per-file benchmark). That path is unchanged here but is worth
   its own look.
