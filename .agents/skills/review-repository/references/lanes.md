# Review lanes

Build a coverage map before reporting: for each area name the entry points,
owning module, persistent state, asynchronous work, external dependencies,
tests run, and unverified assumptions. A checklist item is not evidence.

## Security and privacy

Owned by the Codex Security scan plus manual tracing of repository policy the
scanner cannot know. Cover authentication, authorization, object ownership,
cross-tenant access, input validation, injection, SSRF, file processing,
secrets, dependency risk, webhook verification, OAuth, session and token
handling, unsafe defaults, information disclosure, and denial-of-service
controls. Prioritize the attack paths listed in `SECURITY.md`.

For each candidate establish: precondition, reachable entry point, violated
invariant, concrete impact, reproducible evidence, and why existing controls do
not prevent it. High and critical candidates go through the challenge pass.

## Architecture and contracts

Map services, packages, generated code, database ownership, browser boundaries,
queues and workers, storage, and providers. Check dependency direction and
whether policy is defined once or duplicated across frontend, gateway,
collaboration, pipeline, workers, SQL, and docs. Look for hidden or circular
dependencies, transport models leaking into domain logic, scattered runtime
configuration, schema drift, and seams where a partial deployment produces
incompatible versions. Judge an abstraction by whether it makes the important
invariants easier to find and test.

Compare routes, OpenAPI, generated clients, validators, mocks, streaming event
shapes, webhook contracts, and UI error handling: status codes, optional versus
nullable, enum evolution, pagination, idempotency, retry safety, content types,
cancellation, partial stream termination. Generated-code freshness proves
syntax, not semantics. For providers verify sandbox/live separation, version
pins, ordering assumptions, retry semantics, rate limits, and unknown fields.

## Correctness and data lifecycles

Write an invariant ledger from the owning OpenWiki files and SQL constraints.
Trace each high-value operation through authorization, validation, transaction
boundary, durable mutation, asynchronous follow-up, observable result, retry,
and cleanup, in both directions of every state transition. Distinguish actor
state from storage-owner and billing-owner state.

Concurrency and ordering: version checks, row locks, unique constraints, atomic
counters, reservation and settlement, duplicate delivery, out-of-order events,
stale reads, retries after ambiguous success, jobs reclaimed after worker
death. Arithmetic: rounding, units, negatives, overflow, clock and time-zone
edges, caps applied before allocation or provider calls. Follow create, clone,
transfer, reindex, update, cancel, delete, purge, and reconciliation so rows,
objects, indexes, collaboration state, caches, counters, provider resources,
and audit records converge after success and after partial failure.

## AI, retrieval, and generated output

Trace ingest normalization, chunking, embedding and model selection, tenant and
file scope, hybrid ranking, context assembly, prompts, tool calls, citations,
structured-output parsing, streaming assembly, and usage accounting. Every
cited span must map to the right source and version; scope filters must
survive every retrieval stage. Separate deterministic parser and contract tests
from quality evals; quality claims need a versioned dataset, rubric,
thresholds, and retained results. Unsupported answers surface honestly,
structured generation fails closed, and model fallback never silently changes
capability, thinking configuration, price, or embedding dimension.

## Reliability and resilience

Failure matrix for Postgres, Redis, object storage, Clerk, Stripe, model
providers, parser and GPU services, collaboration sockets, email, and browser
connectivity: timeout, cancellation, retry classification, backoff and jitter,
concurrency limits, duplicate effects, user-visible state, telemetry, recovery.
Queue lease and visibility, poison messages, bounded attempts, terminal state,
backpressure, graceful shutdown, readiness order, body and document bounds,
fan-out, cache invalidation. Offline and reconnect must not lose or duplicate
edits. A caught error without a recoverable state is not resilience. Any
backup, restore, migration, rollback, rotation, or reconciliation claim that
has not been exercised is a coverage gap even when a runbook exists.

## Performance

Use existing budgets and traces before speculating. Review query plans and
indexes, N+1 and fan-out, transaction duration, pools, pagination, batch sizes,
payload copies, streaming backpressure, collaboration document growth, context
size, queue throughput, provider concurrency. Every finding states input size,
concurrency, hardware and network profile, metric, baseline, and reproduction.
Absolute editor budgets are the gate; relative deltas and UAT timings are
environment-sensitive evidence, never a regression claim from one sample.

## Observability and operations

Trace correlation ids across browser, gateway, workers, pipeline and model
calls, collaboration, and provider callbacks. Logs and traces expose actionable
state without secrets or customer content; metrics match the accounting rules;
failures produce a bounded-cardinality signal an operator can find. Check
health versus readiness, dashboards, alerts, deployment order, flags, secret
validation, environment parity, operator privileges, audit trails, retention,
and runbook accuracy. For each serious failure: how does an operator detect,
scope, stop, repair, and verify.

## Frontend and UI quality

Only when browser-facing code is in scope. Combine static tracing, the
Playwright suites, axe, perf budgets, responsive screenshots, and manual
keyboard inspection; automated tools find a subset, so never call a surface
accessible without keyboard, focus, zoom and reflow, contrast, and assistive
technology reasoning. Record route, viewport, theme, input method, browser,
command, and screenshot or trace for every runtime claim.

Accessibility: landmarks, heading order, language, native semantics, names,
alt text, captions, state beyond color, DOM order matching visual and keyboard
order, visible and restored focus, inert background under modals, usable
pointer targets, 200% zoom and 320 CSS-pixel reflow, light, dark, forced-colors,
and reduced motion.

Forms: full workflows including server rejection and retry, native controls
with stable names and labels, correct type, autocomplete, input mode, error
references, no errors on first paint, `aria-invalid`, concise live regions,
duplicate-submit protection, autofill and paste.

CSS and theming: duplicated values, specificity escalation, overmatching
selectors, broad resets, one-off tokens, logical properties where direction
should follow writing mode, intrinsic sizing, long and translated strings,
overflow, viewport units, aspect ratios, layout shift, progressive fallbacks
for new CSS, `color-scheme`, contrast, forced-colors fallbacks.

Performance: LCP, INP, CLS, bundle and request cost, long tasks, editor
interaction latency on a low-end profile; LCP resource discoverable and not
lazy, priority only for critical resources, reserved media space, deferred
below-the-fold work that stays keyboard reachable. Trace evidence before a
finding.

Motion and visual design: animations preserve state, focus, and
interruptibility, prefer transform and opacity, offer a designed reduced-motion
alternative, degrade gracefully. Hierarchy, density, alignment, measure,
typography, contrast, empty, loading, and error states, font loading without
invisible text. Taste calls go in a separate recommendations section unless
they impair a task, accessibility, or a product rule.

## Test and evidence adequacy

Map each invariant to the cheapest reliable layer: pure unit, database
integration, service contract, disposable-stack browser, deterministic
performance, authorized UAT, or manual recovery exercise. Fixtures must cover
roles and account states, assertions must cover observable effects, negative
cases must fail for the intended reason, cleanup must be deterministic. Call
out skipped, flaky, stale-cassette, environment-gated, and report-only tests.
A test name is not coverage until its assertion is read. Recommend new tests
with layer, setup, trigger, expected invariant, and cleanup.
