---
name: review-repository
description: Run an evidence-backed, adversarial review of this repository across security, architecture, correctness, implementation quality, data lifecycles, reliability, performance, accessibility, and operations, including a required Codex Security Deep scan for source and release reviews. Use only when the user explicitly invokes $review-repository and chooses a source, UAT, or release review.
disable-model-invocation: true
---

# Review Repository

This is a costly, manual-only skill. Never invoke it implicitly from an ordinary
coding task, scheduled task, heartbeat, CI workflow, or background automation.
Do not start reviewers, challengers, Codex Security, or Strix unless the user
explicitly invokes this skill for the current task. Repository-native tests may
run automatically outside this skill; agent-driven judgment may not.

Orchestrate a review; do not substitute one broad model pass for evidence. Choose one mode:

- `source`: inspect code, configuration, tests, migrations, and documentation. Do not contact deployed systems.
- `uat`: test only the explicitly authorized UAT targets and synthetic accounts.
- `release`: perform both modes and apply the requested release gate. Never probe production.

If the user does not name a mode, use `source`. Read [SECURITY.md](../../../SECURITY.md) first. Then read only the OpenWiki documents that own the surfaces in scope, using the routing table in [AGENTS.md](../../../AGENTS.md). For execution details, read the corresponding reference:

- Source review: [references/source-review.md](references/source-review.md)
- Non-security lanes: [references/non-security-lanes.md](references/non-security-lanes.md)
- UAT or release review: [references/uat-review.md](references/uat-review.md)
- Frontend/UI lane: [references/ui-quality-review.md](references/ui-quality-review.md)
- Findings and final report: [references/finding-contract.md](references/finding-contract.md)

## Review rules

1. Establish the exact revision, dirty-worktree state, included components, exclusions, and available test infrastructure.
2. Treat documentation as intended behavior, not proof that the implementation satisfies it.
3. Trace important claims through entry point, authorization, state mutation, persistence, cleanup, and observable result.
4. Prefer reproducible evidence: exact file and line, command, response, test, or minimal exploit path.
5. Label untested or unreachable surfaces as coverage gaps. Do not manufacture findings from absence of evidence.
6. Separate pre-existing failures from regressions caused by the reviewed revision.
7. Do not edit application code while reviewing unless the user explicitly requests fixes after reviewing the report.
8. Do not expose credentials, tokens, private fixture content, or raw sensitive responses in prompts or artifacts.

## Adversarial orchestration

Only after this skill has been explicitly invoked, split a comprehensive review
into independent lanes when agent delegation is available and the user has
authorized the requested review:

- security, privacy, trust boundaries, and dependency/configuration risk;
- architecture, implementation seams, maintainability, and API contracts;
- correctness, accounting, concurrency, data lifecycles, and AI/retrieval accuracy;
- reliability, performance, observability, deployment, accessibility/UI, and test adequacy.

Give each reviewer explicit ownership and tell it that other agents share the codebase. Reviewers must not modify files. Do not duplicate lanes merely to increase agent count.

After collecting candidates, run an independent challenge pass. The challenger tries to falsify each high or critical candidate, checks reachability and compensating controls, and identifies missing threat paths. Use a different model family only when one is genuinely available; otherwise report that the challenge was independent but not cross-model. The lead agent adjudicates disagreements and owns the final severity.

For `source` and `release` reviews, the lead must invoke
`$codex-security:deep-security-scan` against the repository root. The explicit
invocation of this skill authorizes that costly scan; do not wait for a second
request or silently substitute a Standard scan. Run the Deep scan as the primary
input to the security lane, then include its validated findings and coverage in
the shared challenge and adjudication process. The Deep scan does not replace
manual review of repository-specific policy or the other review lanes.

A running Deep scan is durable work coordinated outside the local `codex exec`
waiter. If the user asks to stop, cancel, kill, interrupt, or abort a source or
release review, call `cancel_codex_security_scan` for the active scan and wait
for a canceled or terminal result before terminating the local waiter. Killing
the `codex exec` parent, sending Ctrl-C, closing its terminal, or ending the
current turn only detaches the waiter; none of those actions cancels the scan.
If the cancellation call is unavailable or cannot be confirmed, warn that the
scan may still be running and do not report a clean stop. Do not cancel when the
user asks only to detach and leave the scan running.

Skip the Deep scan only when the user explicitly excludes Codex Security or the
Deep scan tool is unavailable. If it is unavailable, fails, or does not
complete, continue any useful independent lanes, mark the required security
engine incomplete, and end with `insufficient evidence`; do not present the
review as clean or release-ready. Record an explicit user opt-out in the final
report. The same manual-only rule applies to Strix, which remains an optional
additional input. Do not describe any scanner as having run unless there is an
artifact or tool result.

## Output

Write generated reports beneath ignored `review-results/`. Produce:

- an executive summary and release recommendation;
- validated findings ordered by severity;
- rejected or downgraded candidates with the reason;
- coverage map and explicit gaps;
- commands and tools actually run;
- deferred checks that require UAT, credentials, or infrastructure.

Follow the finding contract exactly. A clean report means only that the reviewed evidence produced no validated findings; it is not a guarantee of security or correctness.
