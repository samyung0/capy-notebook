---
type: Guide
title: 'Editor performance checkpoints'
description: 'Playwright editor budgets, the manual GitHub Actions snapshot compare, and why relative deltas stay warn-only.'
tags: [frontend, testing, playwright, performance, github-actions]
---

# Editor performance checkpoints

`pnpm perf` measures the Plate editor against a Vite **dev** build and MSW. It
is a regression tripwire, not a production SLO. Absolute `BUDGET` ceilings in
[`e2e/perf/editor.perf.ts`](../e2e/perf/editor.perf.ts) are the only hard fail.
GitHub Actions adds a same-class delta report on top so you can see whether a
checkpoint got slower than the last green run of the same workflow.

File inventory lives in [test-catalog.md](test-catalog.md). Editor architecture
and why a save cycle must not re-render the tree live in
[frontend/plate-editor.md](frontend/plate-editor.md).

## Local run

```bash
pnpm perf
```

Four budget specs always run. Two V8 profile specs run only with
`PERF_PROFILE=1`. Default CPU throttle is `PERF_CPU=4` via CDP after load. Open
cost is measured unthrottled because that path is already tens of seconds.

Numbers from a Windows laptop are not comparable to Linux CI. Different OS,
different Chromium raster path, different CPU. Keep local runs for debugging
(`typingProfile.perf.ts` / `saveCycleProfile.perf.ts`). Use Actions for
deltas.

`.github/workflows/ci.yml` does not run `pnpm perf`.

## GitHub Actions

Workflow [`Editor perf`](../.github/workflows/perf.yml) is `workflow_dispatch`
only. Pin is `ubuntu-24.04`. Typical wall time is 15 to 25 minutes.

1. Run `pnpm perf` with `PERF_SNAPSHOT_DIR` set. `reportMetrics` writes one JSON
   file per budget case.
2. [`e2e/perf/compare-cli.ts`](../e2e/perf/compare-cli.ts) assembles a
   `PerfSnapshot` (commit, CPU model, Playwright version, `PERF_CPU`, cases).
3. Compare against the snapshot artifact from the **most recent successful**
   run of this workflow (`gh run list --workflow=perf.yml --status=success
   --limit=1`). The current job is still in progress, so it cannot pick itself.
   A run that failed the absolute budgets is red and is not used as the base.
4. Write the table to the job summary. Relative deltas never fail the job.
5. Upload `perf-snapshot.json` (90 days). Assemble and upload are hard fails so
   a green run always leaves a file the next dispatch can download.

First dispatch has nothing to diff. That is expected. After that, GHA-vs-GHA
only. Do not check in a laptop JSON.

You can dispatch from any branch. "Last success" is not automatically `main`.

## What the relative table includes

[`e2e/perf/snapshot.ts`](../e2e/perf/snapshot.ts) `RELATIVE_METRICS` (lower is
better):

- large-document interactive `openMs`
- large-document typing `blockingPerKeystrokeMs`
- large-document save-cycle `loafTotalBlockingMs`

Left out on purpose: small-document typing (already 2.5 to 7.7ms of noise), INP (a
single unlucky keystroke), scroll FPS / longest frame (software raster on GHA,
no GPU). Profile specs stay forensic.

The summary still dumps the full case payloads as context. A CPU-model mismatch
gets a warning because the shared Ubuntu pool is mixed Azure hardware. Chrome's
CPU throttle is a multiplier of the host, so it does not cancel that spread.

## Why this stays warn-only

Absolute ceilings have ~2x headroom from the Aug 2026 recalibration. They catch
cliffs. They cannot answer "did this checkpoint make near-limit typing 20%
worse on the same harness?"

Standard GitHub-hosted runners are a mixed CPU pool. Independent PassMark
samples of ubuntu-24.04 x64 (same Azure fleet, mid-2026) land around 2200 to 2670
single-thread. A 1.25x relative fail will fire when the candidate simply draws
a slower host than the baseline. Treat the table as a human-read delta, not a
merge gate.

Other caveats that already apply to the absolute budgets:

- Dev-build inflation (unminified, React StrictMode). Deltas are not
  user-facing SLOs.
- MSW save-cycle work runs on the main thread. A real collab server does that
  work elsewhere.
- Artifacts expire after 90 days. The last success may still exist as a run
  with no file left to download.

If relative fail ever becomes a merge gate, leave the shared `ubuntu-24.04`
pool. Larger GitHub runners need a Team/Enterprise org. A labeled self-hosted
Linux box is the cleanest signal and a snowflake. Do not pay for dedicated
third-party runners until a few manual GHA series show that host mix is what
breaks the deltas.
