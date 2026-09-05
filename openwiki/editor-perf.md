---
type: Guide
title: 'Editor performance checkpoints'
description: 'Playwright editor budgets, the GitHub Actions snapshot compare against median-of-5 and best green, and why relative deltas stay warn-only.'
tags: [frontend, testing, playwright, performance, github-actions]
---

# Editor performance checkpoints

`pnpm perf` measures the Plate editor against a Vite **dev** build and MSW. It
is a regression tripwire, not a production SLO. Absolute `BUDGET` ceilings in
[`e2e/perf/editor.perf.ts`](../e2e/perf/editor.perf.ts) are the only hard fail
and they gate production promotion. GitHub Actions adds a delta table on top
so a human can see drift against recent and best green runs.

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

Workflow [`Editor perf`](../.github/workflows/perf.yml) runs on manual
dispatch and by `workflow_call` from `promote-production.yml`, which passes the
candidate SHA as `revision`. Pin is `ubuntu-24.04`. Typical wall time is 15 to
25 minutes.

1. Run `pnpm perf` with `PERF_SNAPSHOT_DIR` set. `reportMetrics` writes one JSON
   file per budget case.
2. [`e2e/perf/compare-cli.ts`](../e2e/perf/compare-cli.ts) assembles a
   `PerfSnapshot` (commit, CPU model, Playwright version, `PERF_CPU`, cases).
   `PERF_COMMIT` carries the measured revision because `GITHUB_SHA` is the
   caller's SHA under `workflow_call`.
3. Download `perf-snapshot` from the last 10 successful runs of `perf.yml` and
   of `promote-production.yml` (promotions call this workflow, so their green
   runs count). Expired or missing artifacts are skipped.
4. [`e2e/perf/snapshot.ts`](../e2e/perf/snapshot.ts) sorts them by creation
   time and writes two columns: vs the **median of the newest 5** ("are we
   drifting") and vs the **best over all retained** (a floor that cannot creep
   upward one checkpoint at a time). Artifacts expire at 90 days, which bounds
   the lookback.
5. Write the table to the job summary. Relative deltas never fail the job.
6. Upload `perf-snapshot.json` (90 days). Assemble and upload run even when
   budgets fail; the job then fails on the budget result.

First dispatch has nothing to diff. That is expected. After that, GHA-vs-GHA
only. Do not check in a laptop JSON.

You can dispatch from any branch. Baselines are not automatically `main`.

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

Absolute ceilings are the gate. They were set on 2026-09-03 to about 1.3x the
median of three GHA runs on the same SHA (large-document INP is held at 1.5x
because one unlucky keystroke sets it). A human lowers a ceiling when a real
improvement lands; nothing raises one automatically. Recalibrate the same way:
dispatch the workflow three times, download the `perf-snapshot` artifacts,
take the median per metric.

Standard GitHub-hosted runners are a mixed CPU pool. Independent PassMark
samples of ubuntu-24.04 x64 (same Azure fleet, mid-2026) land around 2200 to 2670
single-thread. A relative fail against the best green would fire whenever the
candidate draws a slower host than the luckiest baseline. Treat the table as a
human-read delta, not a gate.

Other caveats that already apply to the absolute budgets:

- Dev-build inflation (unminified, React StrictMode). Deltas are not
  user-facing SLOs.
- MSW save-cycle work runs on the main thread. A real collab server does that
  work elsewhere.
- Artifacts expire after 90 days. A green run may still be listed with no file
  left to download; it is skipped.

If relative fail ever becomes a merge gate, leave the shared `ubuntu-24.04`
pool. Larger GitHub runners need a Team/Enterprise org. A labeled self-hosted
Linux box is the cleanest signal and a snowflake. Do not pay for dedicated
third-party runners until a few manual GHA series show that host mix is what
breaks the deltas.
