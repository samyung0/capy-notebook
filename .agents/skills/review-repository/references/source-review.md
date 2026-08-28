# Source review procedure

## Establish scope

Run `scripts/review/preflight.sh local` and `node scripts/review/source-snapshot.mjs`. Before an optional Strix source scan, run `scripts/review/preflight.sh source`; if its scanner or credentials are unavailable, record that coverage gap and continue with the remaining lanes. Record the commit, dirty state, major languages, manifests, workflows, and migrations. Preserve user changes and never normalize the worktree as part of review.

Map externally reachable entry points, privilege boundaries, stateful resources, background jobs, generated clients, and deployment configuration. Use `SECURITY.md` as the threat-model index and the relevant OpenWiki documents as the intended-behavior specification.

## Required Codex Security Deep scan

For every `source` or `release` review, the lead agent must invoke
`$codex-security:deep-security-scan` against the repository root. Starting the
review skill is authorization to start this costly scan. Follow the Deep scan
skill through completion and retain its canonical report, findings, coverage,
and manifest as review evidence. Do not replace it with a Standard scan merely
to reduce time or cost.

Run independent non-security lanes while the review is active when the harness
supports safe delegation. After the Deep scan completes, route its validated
findings through the repository review's challenger and final adjudication.
Codex Security scanner labels and severity remain evidence rather than the
lead's final verdict.

The coordinator can run for up to 96 hours. The `codex exec` process is only a
waiter after it starts the scan. When the user asks to stop, cancel, kill,
interrupt, or abort the review, use `cancel_codex_security_scan` with the active
scan ID and handoff claim token when required. Confirm a canceled or terminal
result before stopping the local waiter. Ctrl-C, killing the parent process,
closing the terminal, a host timeout, or ending the turn merely detaches the
waiter and leaves the scan running. If explicit cancellation is unavailable or
cannot be confirmed, tell the user the scan may still be active and do not call
the shutdown clean. If the user requests detachment rather than cancellation,
preserve the scan and explain how a later turn can rejoin it.

Skip this step only after an explicit user opt-out or when the Deep scan tool is
not callable. A missing, failed, canceled, or incomplete Deep scan makes the
required security engine incomplete. Continue other lanes when useful, record
the exact limitation, and return `insufficient evidence` rather than a clean or
release-ready conclusion.

## Review lanes

Read `non-security-lanes.md` for the detailed architecture, contract,
correctness, lifecycle, reliability, AI accuracy, performance, observability,
operations, and evidence rubric.

Security and privacy should cover authentication, authorization, object ownership, cross-tenant access, input validation, injection, SSRF, file processing, secrets, dependency risk, webhook verification, OAuth, session/token handling, unsafe defaults, information disclosure, and denial-of-service controls.

Architecture and implementation should cover module depth and boundaries, duplicated policy, dependency direction, API/schema drift, generated-code seams, error contracts, configuration ownership, and changes that make correctness difficult to verify.

Correctness and lifecycle should cover role transitions, account states, quota and billing arithmetic, reservations and settlement, retries and idempotency, concurrent updates, cleanup, cloning, deletion, partial failure, indexing/citations, and database constraints.

Reliability and product quality should cover timeouts, cancellation, retry storms, queues, resource bounds, logging and tracing, alertability, cache consistency, localization, offline behavior, browser behavior, disaster recovery assumptions, and test gaps. When browser-facing code is in scope, read `ui-quality-review.md` and use its accessibility, CSS, forms, performance, motion, and visual-design rubric.

## Evidence and validation

Use targeted searches and focused tests before broad suites. Run `scripts/review/run-local-tests.sh --list` to inspect the matrix. Use `scripts/review/run-local-tests.sh fast` for a normal review and `full` only when requested or proportionate to the change.

Run repository-native static analysis, type checks, tests, and scanners when installed. If a tool is missing, record a coverage gap instead of silently replacing it with a weaker check. Do not download or execute unpinned review software without approval.

For each candidate, establish:

1. attacker or triggering precondition;
2. reachable entry point;
3. violated invariant;
4. concrete impact;
5. reproducible evidence;
6. existing controls and why they do not prevent the issue.

Send high and critical candidates to the challenge pass before reporting them as validated.
