---
type: Guide
title: "Repository review automation"
description: "Where deterministic checks and agent-driven scans run, how local scan results reach GitHub, and what production promotion requires."
tags: [security, review, uat, strix, codex, playwright, ci]
---

# Repository review automation

Deterministic checks run in GitHub Actions. Agent-driven work runs on the
developer's machine and reports back through commit statuses. Nothing has a
schedule.

| Runs in Actions                                                                   | Runs locally                                                                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ci.yml`: lint, types, unit, Go/Postgres, pipeline, Playwright, boundary contract | `$review-repository` skill: reviewer lanes, challenger, report                                            |
| `uat-quality.yml`: smoke, release SHA, 5-role authz matrix, axe, 320px reflow     | Codex Security source scan, `scripts/review/codex-security-scan.sh`, posts `source/codex-security`        |
| `perf.yml`: editor budgets plus warn-only delta table                             | Strix dynamic UAT scan, `scripts/review/strix-scan.sh`, posts `uat/strix`                                 |
| `promote-production.yml`: reruns both gates, requires the two statuses, deploys   | Ingest capacity benchmarks in `bench/parsers` against the ingest host (UAT is capped at one slice/worker) |

GitHub holds no LLM key and no scanner instructions. Strix is
`uv tool install strix-agent==1.5.3` plus Docker on the developer machine;
Codex Security is the `codex-security` plugin of the Codex CLI.

Manual account and infrastructure setup is in
[`deployment-runbook.md`](deployment-runbook.md#12-uat-review-environment-and-external-service-sandboxes).
The threat model is [`SECURITY.md`](../SECURITY.md).

## Promotion gate

`promote-production.yml` refuses a candidate SHA unless all of these hold on
that exact SHA:

1. `uat-quality.yml` is green after re-staging UAT to the SHA.
2. `perf.yml` is green (absolute `BUDGET` ceilings; deltas are warn-only, see
   [editor-perf.md](editor-perf.md)).
3. Commit statuses `source/codex-security` and `uat/strix` are `success`.
   `scripts/review/require-statuses.sh` reads the combined status endpoint,
   which returns only the latest state per context.

Then the protected `production` environment approval is the release action.

## Local scans and how they reach GitHub

`scripts/review/report-status.sh <context> <success|failure> <description> <sha>`
posts one commit status through `gh api`. It needs `gh auth login` and a
token that can write statuses. Each scan script calls it after validation,
so a failed or incomplete scan posts `failure`, never silence. The one-line
description (140 characters) is the only evidence GitHub keeps; the full
bundle stays under the ignored `review-results/`.

`pnpm review:source:codex [standard|deep]` refuses a dirty worktree, runs the
Codex Security skill through `codex exec`, copies `scan-manifest.json`,
`findings.json`, `coverage.json`, and `report.md` into `review-results/`, and
validates with `scripts/review/validate-codex-scan.mjs`: manifest sealed as
`completed`, findings present, zero high or critical. Status lands on HEAD.
`deep` repeats independent Standard scans for hours; use it only when a
release review asks for it.

`pnpm review:uat:strix [quick|standard|deep] [budget-usd]` reads
`deploy/.env.uat`, requires `UAT_TARGET_AUTHORIZED=true`, secure schemes, and
hosts listed in `UAT_ALLOWED_HOSTS`, then scans the UAT SPA, gateway, and
`openapi.yaml` with `review/strix-uat.md` as rules of engagement.
`STRIX_UAT_AUTH_INSTRUCTIONS`, if set, is appended to a mode-0600 temp file
deleted at exit. Validation always enforces findings: high or critical fails,
an incomplete run fails, and spend at 95% of the budget fails because coverage
may have stopped at the cap. The status lands on the SHA the UAT gateway
reports in `X-Capy-Release`, not on the local checkout.

Other local commands:

| Command                                    | Purpose                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `scripts/review/preflight.sh local`        | Check local review prerequisites.                                         |
| `scripts/review/preflight.sh source`       | Check `codex` and `gh` before a source scan.                              |
| `scripts/review/preflight.sh uat`          | Validate exact UAT authorization and allowed hosts.                       |
| `scripts/review/preflight.sh uat-security` | Also require `strix`, `STRIX_LLM`, `LLM_API_KEY`.                         |
| `scripts/review/run-local-tests.sh --list` | Print the local deterministic matrix.                                     |
| `pnpm review:local` / `review:local:full`  | Fast static/unit/offline matrix; `full` adds Go, pipeline, browser, perf. |
| `node scripts/review/source-snapshot.mjs`  | Record revision and source-tree metadata under `review-results/`.         |
| `pnpm review:uat:smoke`                    | Probe the authorized UAT SPA, gateway, collab, and optional ops edge.     |
| `pnpm e2e:uat`                             | Clerk-backed authz matrix, accessibility, and reflow checks against UAT.  |
| `pnpm review:validate-boundaries`          | Prove no workflow is scheduled or runs a scanner, and promote gates.      |
| `pnpm review:validate-scanners`            | Test the Strix and Codex result validators.                               |

`deploy/.env.uat.example` documents the values; copy it to the ignored
`deploy/.env.uat` or run `scripts/review/setup-uat.sh`.

## The skill

`.agents/skills/review-repository/SKILL.md` has `disable-model-invocation:
true`. Invoke `$review-repository` with `source`, `uat`, or `release`; nothing
else may start reviewer lanes, the challenger, or a scan. Rubrics are in
`references/lanes.md`, the report shape in `references/finding-contract.md`.
Codex Security is one input to the source security lane; a report must say
when it was unavailable or not run, and a clean report without a scan is
`insufficient evidence`.

## Boundary contract

`scripts/review/validate-review-boundaries.mjs` runs in `ci.yml` and fails
when any workflow declares `schedule` or contains a scanner invocation
(`strix-scan.sh`, `strix-agent`, `codex-security-scan.sh`, `codex exec`), when
`uat-quality.yml` or `perf.yml` stops being both dispatchable and callable,
when `deploy-uat.yml` runs on `push`, or when `promote-production.yml` drops
the UAT gate, the perf call, `require-statuses.sh`, either status context, or
the `production` environment.

## Coverage gaps

The deterministic UAT gate proves the fixed role matrix and representative UI
surfaces. It does not yet cover live Stripe lifecycle and webhook ordering,
over-quota/suspension transitions, B2 cleanup, reconciliation repair,
collaboration revocation, restore drills, collaboration load, gateway latency,
or an ingest/index/search/chat journey. The last three are the agreed next
`uat-quality.yml` jobs, each needing a synthetic fixture built once in UAT.
Until then the runbook keeps them as manual release checks.

## Evidence and release decision

Reports follow `references/finding-contract.md`. A scanner label is a
candidate, not a validated finding. For release, every piece of evidence comes
from the exact candidate revision; the SPA exposes it in an `capy-release` meta
tag and the gateway in `X-Capy-Release`. Production is never a scan target.
