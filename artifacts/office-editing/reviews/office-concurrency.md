# Independent verification of the XLSX pending-update fix

No remaining actionable finding in this bounded re-review. The previously reported synchronous `applyUpdateJson` non-return is fixed on the rebuilt runtime tested below.

Scope was limited to that failure, finite pending-queue draining, mixed-client partial progress, retained delayed updates, and fresh restoration/projection/export/convergence. Review followed the previously read AGENTS/local preferences, human/ponytail/unslop skills and Office decisions. No repository edits, Rust builds, live services, or new feature scope were introduced. Earlier five-fix and sequential-formula checks were not repeated.

## Independent results

- **Exact former failing trace passed.** Ran `/private/tmp/capy-office-rereview-concurrent-trace2.ts` under a 20-second external subprocess timeout. It completed in **3.351 seconds**, exit 0. The formerly blocking row-insertion delivery returned; the remaining queued deliveries drained. Every delivered state matched a fresh replica's projection and deterministic export. This instrumented script runs one 20-action trace, even though its inherited final printed message says 16. Log: `/private/tmp/capy-office-concurrency-exact-final.log`.
- **Full original bounded concurrency probe passed.** Ran `/private/tmp/capy-office-rereview-concurrent.ts` under a 60-second external subprocess timeout. All **16 traces with 20 local actions each** completed in **29.502 seconds**, exit 0. These mix row/column insertions and deletions, cell/formula writes, Undo, arbitrary delta delivery order, full-state exchanges, and final peer convergence. After each delivered delta, the probe verifies that the current projection and deterministic XLSX bytes equal a fresh replica restored from the encoded current state. Log: `/private/tmp/capy-office-concurrency-traces-final.log`.
- **Ready mixed-client changes and retained tails passed.** `/private/tmp/capy-office-concurrency-mixed-final.ts` ports the two existing native mixed-client cases into the actual WASM facade, using Yjs `mergeUpdates`. A merged delta containing one ready client and another client's missing-predecessor tail applies the ready text immediately. When both clients initially have missing predecessors, supplying just one predecessor commits that client's newest text while preserving the other pending tail. Supplying the final predecessor yields both newest values. Duplicate delivery is stable; intermediate and final states match fresh projection/export; final combined state converges. Both cases completed in **2.086 seconds** under a 20-second external timeout. Log: `/private/tmp/capy-office-concurrency-mixed-final.log`.

The tested generated XLSX WASM and shared headless runtime copy have identical SHA-256:

`94b7ffd5541c3e1796f57b5ec8479290fed0b1949e34f8b4c046b8c387d6639d`

## Source review

Inspected `crates/betteroffice-xlsx/src/authority.rs`, `stage_updates_v1`. Pending staging reconstructs the original state plus exactly the before-vector incremental diff that can be committed. Its projected model therefore corresponds to the update installed into live authority. Pending retry progress requires a changed Yrs snapshot, covering either the state vector or deletion set, rather than a transient model difference. The original pending bytes remain queued for missing-predecessor delivery. The two mixed-client probes confirm that this guard does not simply suppress valid ready portions or discard delayed tails.

The implementer's separate native evidence is **163 passing tests**, including the exact schedule under a 10-second timeout and existing mixed-client/deletion cases. Its rebuilt headless suite reports **43 passed, one existing skip**. These results were read in `/private/tmp/capy-office-concurrency-fix.md`, not rerun independently here.

## Limits

These are deterministic bounded schedules, not proof of arbitrary CRDT schedule convergence or a latency guarantee. Native Microsoft Office rendering, maximum-source-size performance, browser transport, and server lifecycle were outside this follow-up. The prior re-review's original five fixes and 120 sequential traces remain separately documented in `/private/tmp/capy-office-fork-final-rereview.md`; its one pending-drain finding is superseded by the passing evidence in this report.
