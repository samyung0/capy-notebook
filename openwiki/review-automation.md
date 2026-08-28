---
type: Guide
title: "Repository review automation"
description: "Source, UAT, and release review orchestration, safety boundaries, workflows, gates, and evidence."
tags: [security, review, uat, strix, playwright, ci]
---

# Repository review automation

The review system separates deterministic engineering checks from agent-driven
judgment. Deterministic tests run in CI, after a UAT deployment, or by manual
dispatch; there are no nightly or weekly review schedules. The
`$review-repository` skill, delegated reviewers, challenger agents, Codex
Security, and Strix are costly and manual-only; they start only after an
explicit user invocation or GitHub workflow dispatch.

Source review inspects the repository without contacting a deployment. UAT
validation probes only an isolated, explicitly authorized deployment with
synthetic identities. Release review combines fresh evidence from both.
Production is never a penetration-test target.

Manual account and infrastructure setup is centralized in
[`deployment-runbook.md`](deployment-runbook.md#12-uat-review-environment-and-external-service-sandboxes).
The repository threat model and review invariants are in
[`SECURITY.md`](../SECURITY.md).

## Coverage model

| Category                        | Deterministic source/CI evidence                                                      | Isolated UAT evidence                                     | Manual repository review                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Architecture and implementation | Type/lint checks, generated OpenAPI/client drift, package tests                       | Deployment topology and route behavior                    | Boundaries, dependency direction, policy duplication, maintainability             |
| Correctness and data lifecycles | Vitest, Go/Postgres, Python, collaboration, Worker, and Playwright suites             | Authenticated role and tenant assertions                  | End-to-end invariant tracing, concurrency, cleanup, accounting                    |
| Reliability and resilience      | Failure, retry, idempotency, offline, queue, cancellation, and integration tests      | Service smoke and authenticated browser flows             | Retry storms, recovery assumptions, partial failure, resource bounds              |
| API and schema contracts        | Server-generated OpenAPI diff and generated client diff                               | Browser/API status and response assertions                | Semantic compatibility and versioning review                                      |
| AI accuracy and retrieval       | Offline/cassette pipeline tests, grounding/citation tests, model replay certification | Synthetic golden journeys once their UAT fixtures exist   | Prompt/data-flow review, evaluation adequacy, hallucination and citation analysis |
| Performance                     | Editor latency/FPS/open/save budgets and snapshots                                    | No stable live budget yet; retain traces for release      | Bottleneck tracing, bundle/query/resource review                                  |
| Accessibility and UI quality    | Playwright + axe on representative dashboard, workspace, share, and dialog surfaces   | Axe plus 320 CSS-pixel reflow on the Clerk-backed fixture | Keyboard/focus, zoom, themes, forced colors, forms, motion, and visual hierarchy  |
| Observability and operations    | Ops, logging, metering, reconciliation, and configuration tests                       | Health endpoints and operator-edge reachability           | Alertability, runbooks, recovery, dashboards, and telemetry gaps                  |
| Security and privacy            | Repository-native authz/webhook/input tests                                           | Fixed authz matrix                                        | Explicit-only Codex Security, Strix, threat tracing, and adversarial challenge    |

Automated accessibility checks and performance budgets are evidence, not a
complete usability or performance review. The frontend lane in the skill adds
the manual checks adapted from the local Modern Web Guidance material.

## Local commands

| Command                                           | Purpose                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `scripts/review/preflight.sh local`               | Check local review prerequisites.                                                       |
| `scripts/review/preflight.sh source`              | Check prerequisites before a manually requested Strix source scan.                      |
| `scripts/review/preflight.sh uat`                 | Validate exact UAT authorization and allowed hosts.                                     |
| `scripts/review/run-local-tests.sh --list`        | Print the local deterministic matrix.                                                   |
| `pnpm review:local`                               | Run the fast static/unit/offline matrix.                                                |
| `pnpm review:local:full`                          | Add Go/Postgres, full pipeline, browser, editor, accessibility, and performance suites. |
| `pnpm e2e:quality`                                | Run representative local accessibility checks in the disposable E2E stack.              |
| `pnpm perf`                                       | Run deterministic editor performance budgets.                                           |
| `node scripts/review/source-snapshot.mjs`         | Capture revision and source-tree metadata under `review-results/`.                      |
| `pnpm review:uat:smoke`                           | Probe the authorized UAT SPA, gateway, collab, and optional ops edge.                   |
| `pnpm e2e:uat`                                    | Exercise Clerk-backed authz, accessibility, and narrow-viewport checks.                 |
| `scripts/review/strix-scan.sh source standard 40` | Manually run a source-only Strix scan.                                                  |
| `scripts/review/strix-scan.sh uat standard 40`    | Manually run a source-aware, authorized UAT Strix scan.                                 |
| `pnpm review:validate-boundaries`                 | Prove agent workflows are dispatch-only and the skill is explicit-only.                 |
| `pnpm review:validate-strix`                      | Test the scan-result parser and release-gate contract.                                  |

`review/.env.uat.example` documents local values. Copy it to the ignored
`review/.env.uat`, or run `scripts/review/setup-uat.sh`. Remote scripts refuse
to run unless `UAT_TARGET_AUTHORIZED` is exactly `true`, required URLs use
secure schemes, and every hostname matches `UAT_ALLOWED_HOSTS`.

Strix is pinned in CI. Its UAT instruction file is materialized as a mode-0600
temporary file and deleted at exit. Generated `review-results/` and
`strix_runs/` directories are ignored; CI uploads sanitized evidence with a
bounded retention period. SARIF upload is best-effort because repositories
without GitHub Code Security may reject it; the retained Strix artifact and
validation gate remain authoritative.

## Manual Codex skill

The skill metadata sets `allow_implicit_invocation: false`. Invoke
`$review-repository` with `source`, `uat`, or `release`. Only that explicit
invocation authorizes reviewer agents or an independent challenge pass. No CI,
heartbeat, scheduled task, or ordinary implementation request should invoke the
skill or spawn its review lanes.

Codex Security, when installed and callable, is one input to the manually
requested source-security lane. It does not replace repository-native tests,
data-flow tracing, the threat model, authenticated UAT checks, or adversarial
adjudication. A report must say when it was unavailable or not run.

The Codex Security Deep scan coordinator may run for up to 96 hours. Its
`codex exec` parent is only a waiter once the scan starts. Killing that process,
sending Ctrl-C, closing the terminal, or reaching a host timeout detaches the
waiter but does not stop the scan. A stop request must call
`cancel_codex_security_scan` for the active scan and confirm a canceled or
terminal result before terminating the waiter. If cancellation cannot be
confirmed, report that the scan may still be active instead of claiming a clean
shutdown. A later task can rejoin an intentionally detached scan.

## GitHub workflows

- `ci.yml` runs deterministic source and disposable-stack checks on push and
  pull request and supports manual dispatch. It includes the automation-boundary
  contract; the root Playwright suite includes the accessibility checks.
- `perf.yml` runs deterministic editor performance budgets only when manually
  dispatched.
- `deploy-environment.yml` is a reusable, non-dispatchable deployment adapter.
  It checks out an exact SHA, builds and deploys the SPA, pins Coolify to that
  SHA, waits for completion, and verifies the public release markers.
- `deploy-uat.yml` runs after a successful `CI` run on `main` when
  `UAT_DEPLOYMENT_ENABLED=true`, or by manual dispatch. It calls the reusable
  deployment adapter and then `uat-quality.yml`.
- `uat-quality.yml` is the single deterministic UAT gate. It runs bounded
  smoke, revision, authorization, accessibility, and reflow checks when called
  by a deployment flow or when manually dispatched. It has no schedule.
- `promote-production.yml` is dispatch-only. It pins the requested main-branch
  SHA back onto UAT, calls the same UAT gate, then deploys that SHA through the
  protected `production` environment.
- `repository-review.yml` is dispatch-only and runs the pinned Strix source
  scanner. It can never be scheduled without failing the boundary contract.
- `uat-review.yml` is dispatch-only because it contains Strix. It calls the
  same reusable deterministic UAT gate so a manual security assessment retains
  one evidence bundle.

Both Strix workflows default to report-only. A release operator opts into
`enforce_findings`, which fails on validated high or critical findings. Scanner
failure, absent results, or a non-completed run always fails validation. An
enforced run also fails when reported LLM spend reaches 95% of the configured
hard budget because coverage may have stopped at the cap.

## Remaining coverage gaps

The deterministic UAT suite proves its fixed role matrix and representative UI
surfaces. It does not yet automate live Stripe lifecycle and webhook ordering,
over-quota/suspension transitions, ingest/index/search golden journeys, B2
cleanup, reconciliation repair, long-lived collaboration revocation, or restore
drills. These require purpose-built synthetic fixtures and deterministic cleanup
before they become unattended jobs. Until then, the deployment runbook keeps
them as explicit manual release checks rather than pretending they are covered.

## Evidence and release decision

Reports follow
`.agents/skills/review-repository/references/finding-contract.md`. A scanner
label is a candidate, not a validated finding. Serious claims need a reachable
path, violated invariant, concrete impact, reproducible evidence, and challenge
verdict.

For release, generate evidence from the exact candidate revision. The deployed
SPA exposes that SHA in an `evo-release` meta tag and the gateway exposes it in
`X-Evo-Release`; a mismatch fails the gate. A clean source scan with missing
UAT remains `insufficient evidence`. Production deploy verification is bounded;
do not point Strix or the UAT Playwright suite at production.
