# XLSX effects without a recalculation, and agent memory, 2026-10-05

Follow-up to [2026-10-05-office-engine-replicas.md](2026-10-05-office-engine-replicas.md)
(next steps 1 and 3). Code: BetterOffice `capy/xlsx-engine` on `capy-ci`
71e61f59, Capy `capy-side/xlsx-engine` on main 2e530e72. Scripts and raw
runs: `capy-docx-review-harnesses/2026-10-05-office-batch/xlsx-engine/`
(`bench-effects.mjs`, `memprobe.mjs`, `bench-*.json*`, `memprobe-*.log`).

All numbers are from an 8-core M-series Mac shared with six other agents
(load average 20 to 30 during the runs). Wall times were useless; the tables
give CPU time of the process per call, from runs interleaved before, after,
before, after. The production box was not used.

## Short version

- **XLSX saves on a kept replica take about 0.3 s of CPU instead of 1.3 to
  2 s** on the 16,000-row gradebook, and 40 ms instead of 190 ms on
  `course-guide.xlsx`. Every effect is byte-identical to before.
- **A replica holds about 25% less** (123 MiB per gradebook instead of 160)
  and is never changed by a save, so any state of its base hits it.
- **The replicas are still needed.** Without one, a gradebook save costs
  about 6 s of CPU here (8 s before). Opening the source (unzip, parse, the
  first projection) is about 95% of that.
- **Agent inspection and edits no longer grow the XLSX engine to 1.9 GiB.**
  The engine's linear memory stays at 338 MiB through inspect, edit, locate
  and effects on the gradebook.

## What a save did, and does now

A save's pending effects read the room's Yrs document against the source
and, for each edited cell, its formula and value. On the old path the room
replica (an editing replica) applied the save's state as a remote update:
it staged the update, projected the whole workbook, rebuilt the dependency
graph, recalculated everything and diffed the result against a clone of the
previous projection. A fresh replica projected the same state four times
(a whole-document check, a strict check, then the structure and the model
separately) before recalculating.

The new path (`XlsxEffectsReader`, `Workbook::pending_effects_of_state_json`)
runs the same adoption checks as that apply (schema, base fingerprint,
container identities, chart and preserved-part gates, state size), projects
the state once, and reads the effects off that projection. It skips the
recalculation unless the source has array formulas, whose spilled values
can reach an edited cell's effect; then it recalculates that projection
exactly as the apply did. A state that is not a whole document (never the
case for a checkpoint) is applied to a fresh session as before. The adoption
now also reuses the one strict projection for the editor's own whole-state
restores, which projected the same document four times.

## Per-save engine CPU, gradebook

Six successive one-cell saves of one room (`states-gradebook.json`),
milliseconds of process CPU per call. "First" is the miss that opens the
replica.

| run | load | uncached saves 2-6 | replica, first | replica, saves 2-6 | effects |
| --- | --- | --- | --- | --- | --- |
| before | 21 | 7,338-10,454 | 7,001 | 1,268-1,991 | |
| after | 21 | 5,607-6,827 | 6,056 | 260-312 | identical |
| before | 27 | 9,709-12,794 | 10,256 | 1,806-2,461 | |
| after | 24 | 5,879-7,909 | 6,162 | 258-491 | identical |

`course-guide.xlsx`, load about 4 to 20: uncached 1,014-1,087 ms before and
766-837 after; on the replica 178-207 ms before and 35-57 after; identical.

The engine's own timing (native, `cargo test --release`, load about 30): the
reader's call took 2.3-5.6 s where applying the same full state to a fresh
replica took 34 s and to a kept one 74 s; one projection was 3.2 s and the
full recalculation 6.3 s.

## Memory per replica

Linear memory growth per extra replica kept, in one process:

| file | unzipped | before | after |
| --- | --- | --- | --- |
| `large-gradebook.xlsx` | 8.1 MiB | 159 MiB | 123-124 MiB |
| `course-guide.xlsx` | 1.2 MiB | 18-19 MiB | 13-14 MiB |

The estimate per unzipped byte drops from 20 to 16 (15.2 and 11-12
measured), so `OFFICE_REPLICA_BUDGET_BYTES` (1 GiB of estimates) now holds
eight gradebooks instead of six. Collaboration RSS on the box was not
remeasured.

## Agent inspect and edit memory

`memprobe.mjs`: seed, `inspectOffice`, one `set_cell` through
`applyOfficeCommands`, `locateOfficeTargets`, `xlsxPendingEffects` and a
second inspect on the gradebook, without replicas.

| step | before: XLSX linear memory | after |
| --- | --- | --- |
| seed | 193 MiB | 193 MiB |
| inspect | 1,942 MiB | 338 MiB |
| apply, locate, effects, inspect again | 1,942 MiB | 338 MiB |

What held it: `checkpointProjectionJson` built the whole workbook as one
`serde_json::Value` tree, with each of the 224,157 cells carrying its full
resolved cell format, before writing the JSON string. The inspect, every
edit (one or two projections per `set_cell`) and every locate used it, although
they read only ids, addresses, values and formulas. WASM linear memory
never shrinks, so one inspect kept the worker at 1.9 GiB for good (2.4 GiB
RSS in the earlier per-file benchmark). It was not a second opened copy per
call: each call opens and frees one session, and the allocator reuses it.

Now the projection is serialized straight from the model, and the agent
paths read `checkpointCellsJson` (ids, names, cells without formats). The
full projection, still used for baselines and assets, is streamed the same
way; a test checks both against the old `Value` projection.

## Equivalence

- Rust: each state's effects from the reader equal, as a string, those of a
  fresh replica that applies it (cell, formula, formatting, row insert and
  delete, sheet rename, cleared cell, Undo; a source whose array formula
  spills over a typed and then a cleared cell); an incremental update is
  left to an apply; a foreign state fails as its apply does.
- `shared/office-replicas.test.ts`: saves with and without a room equal what
  `XlsxDocument.applyUpdateJson` then `pendingEffectsJson` read, including an
  incremental update through the fallback.
- Both benchmark files: the six saves' effect hashes are equal before and
  after, cached and uncached.

## Not done

- Production-box ramp (`oe2c-*` steps) not rerun: the brief keeps this
  track off production.
- The open itself (about 95% of a miss) is unchanged. Opening only what the
  reader needs (no projection at open, no shared-string bookkeeping) could
  cut misses and memory further; not attempted.
