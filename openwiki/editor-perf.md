---
type: Guide
title: 'Editor performance checkpoints'
description: 'Playwright editor budgets, the GitHub Actions snapshot compare against median-of-5 and best green, and why relative deltas stay warn-only.'
tags: [frontend, testing, playwright, performance, github-actions]
---

# Editor performance checkpoints

`pnpm bench:editor` measures the Plate editor against a Vite **dev** build and MSW. It
is a regression tripwire, not a production SLO. Absolute `BUDGET` ceilings in
[`bench/editor/scripts/editor.perf.ts`](../bench/editor/scripts/editor.perf.ts) are the only hard fail
and they gate production promotion. GitHub Actions adds a delta table on top
so a human can see drift against recent and best green runs.

File inventory lives in [test-catalog.md](test-catalog.md). Editor architecture
and why a save cycle must not re-render the tree live in
[frontend/plate-editor.md](frontend/plate-editor.md).

## Local run

```bash
pnpm bench:editor
```

Four budget specs always run. Two V8 profile specs run only with
`PERF_PROFILE=1`. Default CPU throttle is `PERF_CPU=4` via CDP after load. Open
cost is measured unthrottled because that path is already tens of seconds.

Numbers from a Windows laptop are not comparable to Linux CI. Different OS,
different Chromium raster path, different CPU. Keep local runs for debugging
(`typingProfile.perf.ts` / `saveCycleProfile.perf.ts`). Use Actions for
deltas.

`.github/workflows/ci.yml` does not run `pnpm bench:editor`.

## Office runtime (`pnpm bench:office`)

[`bench/editor/scripts/docx.office.ts`](../bench/editor/scripts/docx.office.ts)
runs against a production build ([`playwright.office.config.ts`](../bench/editor/scripts/playwright.office.config.ts)
builds with `NODE_ENV=production`, MSW and `VITE_LOAD_TEST_SEED`, then serves it
with the runtime on the next port of `localhost`: another origin on the same
site, as `office.capynotebook.com` is to the app, so the iframe is cross-origin
and shares the app's renderer process as in production). The build takes a few
minutes. Per DOCX fixture
(15 and 62 pages) it reports:

- open to first paint: the file click to the runtime's `ready`, on the host's
  clock, plus the runtime's own `timings` (`loadMs` frame start to `load`,
  `paintMs` `load` to first painted pages; `OfficeReadyTimings`);
- View to Edit ready: the mode toggle click to the edit frame's `ready`;
- keystroke to frame: 40 keys at 120 ms, each key to the next
  `docx-pages-presented` event in the frame (p50, p90, max, unpainted keys).

It runs unthrottled: CDP's CPU throttle reaches neither the runtime frame nor
the engine workers. It fails on unpainted keys, a worker fallback, or a missed
budget (`BUDGET` in the spec: open, View to Edit, key p50 and p90 per fixture).
The budgets are provisional, ~1.3x the median of three laptop runs at load 7
to 10; an earlier set from runs at load 16 to 24 sat 20 to 50% higher, so a
local miss on a busy machine is noise.
Recalibrate them from three runs of the `office` job below, as the editor
budgets were.

## Collaboration stress (`pnpm bench:stress`)

[`bench/collaboration/scripts/stress.ts`](../bench/collaboration/scripts/stress.ts)
starts the e2e Docker stack through `e2e/global-setup.ts` with
[`docker-compose.stress.yml`](../bench/collaboration/scripts/docker-compose.stress.yml)
layered on (`E2E_COMPOSE_OVERRIDES`). That overlay replaces the memory blob
store, whose `memory://` URLs the collaboration service cannot fetch, with
[`fake-s3.mjs`](../bench/collaboration/scripts/fake-s3.mjs) in the collaboration
image, served over TLS under a `*.backblazeb2.com` name the server accepts with
a throwaway certificate. The owner uploads `exchange-plan.docx` and creates a
Plate note, then `STRESS_PEERS` peers (20) per room, with API tokens, type
unique markers for `STRESS_MINUTES` (3), about one per `STRESS_EDIT_MS`
(1500); each drops offline for 1 to 5 s at `STRESS_DROP_PER_SECOND` (0.02) and
keeps typing, sending on reconnect. A watching peer that never drops times
each marker typed while its peer was connected and synced, scanning only the
text each change inserts, so the client's own cost stays flat. Then:

- every peer and a late joiner hold the same text (convergence);
- every typed marker is there exactly once (no lost or doubled update);
- the collaboration service logged no error;
- p95 marker latency within `STRESS_P95_BUDGET_MS`, provisional 35 ms
  (~1.3x the slower room's median of three runs at load 3 to 17: Office 26,
  Plate 27 ms).

A failed check exits 1, a missed budget alone exits 2. SIGINT and SIGTERM tear
the stack down and remove the throwaway key. Under heavy load
(load 34) a run logged a projection deadlock (`40P01`), a store statement
timeout and a source access 500, with p95 over 40 s: worth a look on the CI
runner before the budget is trusted.

## GitHub Actions

Workflow [`Performance`](../.github/workflows/perf.yml) (named `Editor perf`
before the Office job joined it) runs on manual
dispatch and by `workflow_call` from `promote-production.yml`, which passes the
candidate SHA as `revision`. Pin is `ubuntu-24.04`. Typical wall time is 15 to
25 minutes.

It has three jobs. `perf` is the editor suite below; production promotion's
`editor_perf` job calls the file and `deploy_production` needs it, so these
budgets gate promotion (check name `editor_perf / perf`).
`scripts/review/validate-review-boundaries.mjs` fails CI if promotion stops
calling `perf.yml` or the file stops being dispatchable and callable. `office`
runs `pnpm bench:office` on dispatch only (input `office`, default true; a
`workflow_call` defaults it to false, so promotion skips it) and, while its
budgets are provisional, has `continue-on-error`: a miss shows on the job, the
run stays green, and the run's editor snapshot still counts as a baseline. Its
results go to the job summary and the `office-perf-results` artifact.
`stress` runs `pnpm bench:stress` (below) on dispatch only (input `stress`,
false on `workflow_call`) against the `e2e_stack` images, built from the same
GitHub Actions layer cache. Like `office` it has `continue-on-error`: a failed
check (exit 1) or a missed latency budget (exit 2) fails the job, and its
summary marks a correctness failure as such, but the run stays green.
`stress.json` goes to the summary and the `collaboration-stress-results`
artifact.

Steps of the `perf` job:

1. Run `pnpm bench:editor` with `PERF_SNAPSHOT_DIR` set. `reportMetrics` writes one JSON
   file per budget case.
2. [`bench/editor/scripts/compare-cli.ts`](../bench/editor/scripts/compare-cli.ts) assembles a
   `PerfSnapshot` (commit, CPU model, Playwright version, `PERF_CPU`, cases).
   `PERF_COMMIT` carries the measured revision because `GITHUB_SHA` is the
   caller's SHA under `workflow_call`.
3. Download `perf-snapshot` from the last 10 successful runs of `perf.yml` and
   of `promote-production.yml` (promotions call this workflow, so their green
   runs count). Expired or missing artifacts are skipped.
4. [`bench/editor/scripts/snapshot.ts`](../bench/editor/scripts/snapshot.ts) sorts them by creation
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

[`bench/editor/scripts/snapshot.ts`](../bench/editor/scripts/snapshot.ts) `RELATIVE_METRICS` (lower is
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
