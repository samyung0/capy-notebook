---
name: review-repository
description: Evidence-backed adversarial review of this repository across security, architecture, correctness, data lifecycles, reliability, performance, accessibility, and operations. Runs the local Codex Security source scan and, for UAT or release, the local Strix UAT scan, and posts their commit statuses. Use only when the user explicitly invokes $review-repository with source, uat, or release.
disable-model-invocation: true
---

# Review Repository

Costly and manual. Never start it from an ordinary coding task, schedule, CI
job, or background automation. Every agent-driven part (reviewer lanes,
challenger, Codex Security, Strix) runs on the developer's machine; GitHub
Actions only runs deterministic checks and reads the statuses these scans post.

Pick one mode (default `source`):

- `source`: code, configuration, tests, migrations, docs. No deployed target.
- `uat`: the explicitly authorized UAT deployment with synthetic accounts only.
- `release`: both, on the exact candidate SHA, ending in a release verdict.

Read [SECURITY.md](../../../SECURITY.md) first, then only the OpenWiki files that
own the surfaces in scope (routing table in [AGENTS.md](../../../AGENTS.md)) and
the matching `human/` decisions. Rubrics live in
[references/lanes.md](references/lanes.md); the report shape in
[references/finding-contract.md](references/finding-contract.md).

## Rules

1. Record the exact revision, dirty state, components in scope, exclusions, and
   available infrastructure before anything else.
2. Documentation is intended behavior, not proof.
3. Trace claims end to end: entry point, authorization, mutation, persistence,
   cleanup, observable result.
4. Evidence is a file and line, a command, a response, a test, or a minimal
   exploit path. Absence of evidence is a coverage gap, not a finding.
5. Separate pre-existing failures from regressions in the reviewed revision.
6. Do not edit application code during review. Do not put credentials, tokens,
   fixture content, or raw sensitive responses in prompts or artifacts.

## Source mode

1. `scripts/review/preflight.sh local` and `node scripts/review/source-snapshot.mjs`.
2. Run `scripts/review/codex-security-scan.sh standard` on a clean checkout. It
   runs the Codex Security Standard scan through the Codex CLI, copies the
   canonical artifacts under `review-results/`, and posts the
   `source/codex-security` status on HEAD. Use `deep` only when the user asks
   for it on a release candidate; Deep repeats independent Standard scans for
   hours. If `codex` or the plugin is unavailable, record the gap and end with
   `insufficient evidence`; never call the review clean without a scan.
3. Split the non-security work into independent lanes when delegation is
   available: architecture and contracts; correctness, accounting, concurrency,
   lifecycles, AI/retrieval; reliability, performance, observability,
   accessibility/UI, test adequacy. Give each lane explicit ownership, tell it
   others share the tree, and forbid file edits. Do not add lanes to raise the
   agent count.
4. Run `scripts/review/run-local-tests.sh fast` (or `full` when the change
   warrants it) and any targeted tests the lanes need.
5. Challenge pass: an independent agent tries to falsify every high or critical
   candidate (reachability, compensating controls, missing threat paths). Use a
   different model family when one is available; say so either way. The lead
   adjudicates and owns final severity.

## UAT mode

Read `review/strix-uat.md` and runbook section 12 first, then
`scripts/review/preflight.sh uat`. Remote work is allowed only when
`UAT_TARGET_AUTHORIZED=true`, HTTP targets are `https://`, the collab target is
`wss://`, every host is listed exactly in `UAT_ALLOWED_HOSTS`, and the target
holds synthetic data. Never infer authorization from a hostname. Never touch
production.

1. `pnpm review:uat:smoke`, then `pnpm e2e:uat` for the authenticated role
   matrix, accessibility, and reflow checks.
2. `scripts/review/strix-scan.sh standard 40` (or `pnpm review:uat:strix`). It
   scans the authorized targets, validates the run with findings enforced, and
   posts `uat/strix` on the SHA the UAT gateway reports in `X-Evo-Release`.
3. No volumetric denial of service, credential attacks, social engineering,
   persistence, or exfiltration. Stripe sandbox and synthetic Clerk accounts
   only. Retain viewport, theme, input method, and trace for UI findings.

## Release mode

Run both modes against the same candidate SHA; stale evidence is rerun. The
production promotion workflow refuses a SHA whose `source/codex-security` or
`uat/strix` status is not `success`, and reruns the deterministic UAT gate and
editor perf itself. Scanner failure, an incomplete run, or missing artifacts is
`insufficient evidence`, never a pass.

## Output

Write under ignored `review-results/`: executive summary and release
recommendation, validated findings by severity, rejected or downgraded
candidates with reasons, coverage map and gaps, commands actually run, and
deferred checks. Follow the finding contract. A clean report means the reviewed
evidence produced no validated finding, nothing more.
