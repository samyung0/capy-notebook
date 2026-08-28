# Non-security review lanes

Use this reference for comprehensive source or release review. Build a coverage
map before reporting findings. For each area, name the entry points, owning
module, persistent state, asynchronous work, external dependencies, tests run,
and unverified assumptions. A checklist item is not evidence by itself.

## Architecture and implementation

Map deployable services, packages, generated code, database ownership, browser
boundaries, queues/workers, storage, and external providers. Verify dependency
direction and whether policy is defined once or duplicated across frontend,
gateway, collaboration, pipeline, workers, SQL, and documentation.

Trace representative flows across component boundaries. Look for circular or
hidden dependencies, ambiguous ownership, transport models leaking into domain
logic, runtime configuration scattered across services, generated/manual schema
drift, unbounded module responsibilities, and seams where a partial deployment
creates incompatible versions. Judge abstractions by whether they make the
important invariants easier to locate and test, not by style preference.

Review implementation details for error preservation, cancellation propagation,
resource cleanup, deterministic behavior, numerical and time handling, locale
assumptions, data conversion, and whether comments/documentation match current
behavior. Identify dead paths and repeated workaround logic only when concrete
maintenance or correctness risk follows.

## API and contract accuracy

Compare registered routes, OpenAPI, generated clients, validators, mocks,
streaming event shapes, webhook contracts, and UI error handling. Check status
codes, optional versus nullable fields, enum evolution, pagination, idempotency,
retry safety, backward compatibility, content types, cancellation, and partial
stream termination. Generated-code freshness proves syntactic alignment, not
semantic compatibility.

For external providers, verify sandbox/live configuration separation, version
pins, event ordering assumptions, retry semantics, rate limits, and how unknown
or newly added fields/events are handled.

## Correctness and data lifecycles

Create an invariant ledger from the owning OpenWiki documents and SQL
constraints. Trace each high-value operation through authorization, validation,
transaction boundary, durable mutation, asynchronous follow-up, observable
result, retry, and cleanup. Exercise state transitions in both directions and
distinguish actor state from storage-owner or billing-owner state.

Inspect concurrency and ordering: compare-and-swap/version checks, row locks,
unique constraints, atomic counters, reservation/settlement, duplicate delivery,
out-of-order events, stale reads, retries after ambiguous success, and jobs
reclaimed after worker death. Check boundary arithmetic, rounding, units,
negative/overflow conditions, clock/time-zone edges, and caps applied before
allocation or provider calls.

Follow create, clone, transfer, reindex, update, cancel, delete, account purge,
and reconciliation paths. Confirm database rows, object storage, indexes,
collaboration state, caches, usage counters, provider resources, and audit
records converge after success and partial failure.

## Reliability and resilience

Build a failure matrix for Postgres, Redis/queues, object storage, Clerk,
Stripe, model providers, parsing/GPU services, collaboration sockets, email,
and browser connectivity. For each dependency, examine timeout, cancellation,
retry classification, backoff/jitter, circuit or concurrency limits, duplicate
effects, user-visible state, telemetry, and recovery after the dependency
returns.

Check queue lease/visibility semantics, poison messages, bounded attempts,
dead-letter or terminal state, backpressure, graceful shutdown, in-flight work,
startup/readiness order, memory/body/document bounds, pagination, fan-out, and
cache invalidation. Verify offline and reconnect behavior cannot silently lose
or duplicate edits. A caught error without a recoverable state is not resilience.

Review backup, restore, migration, rollback, key rotation, reconciliation, and
disaster assumptions. Record any recovery claim that has not been exercised as
a coverage gap, even when a runbook exists.

## AI, retrieval, and generated-output accuracy

Trace ingest normalization, chunking, embedding/model selection, tenant and file
scope, hybrid ranking, context assembly, prompts, tool calls, citations,
structured output parsing, streaming assembly, and usage accounting. Confirm
that every cited span maps back to the correct source/version and that scope
filters cannot be lost between retrieval stages.

Review evaluation evidence for representative languages, document types,
empty/contradictory sources, long context, prompt injection in source content,
model/provider variance, malformed tool output, interruption, retry, and model
retirement. Separate deterministic parser/contract tests from quality evals.
Quality claims require a versioned dataset, scoring rubric, thresholds, and
retained results; a few happy-path cassette replays are not broad accuracy proof.

Check that uncertain or unsupported answers are surfaced honestly, citations
remain usable after source changes, structured generation fails closed or
recovers predictably, and model fallback does not silently change capabilities,
thinking configuration, pricing, or embedding dimensions.

## Performance and scalability

Use existing budgets and traces before static speculation. Review query plans
and indexes, N+1/fan-out behavior, transaction duration, connection pools,
pagination, batch sizes, payload copies, streaming backpressure, collaboration
document growth, model/context size, queue throughput, and provider concurrency.

For browser performance use `ui-quality-review.md`. Distinguish absolute budgets
from environment-sensitive comparisons. Identify the input size, concurrency,
hardware/network profile, metric, baseline, and reproduction for every finding.

## Observability and operations

Trace request/correlation identifiers across browser, gateway, workers,
pipeline/model calls, collaboration, and provider callbacks. Verify logs and
traces expose actionable state without secrets or customer content, metrics
match the owning accounting rules, and failures produce a bounded-cardinality
signal an operator can find.

Review health versus readiness semantics, dashboards, alerts, deployment
ordering, feature/config flags, secret validation, environment parity, manual
operator privileges, audit trails, reconciliation visibility, retention, and
runbook accuracy. For each serious failure scenario, answer how an operator
detects it, scopes impact, stops further harm, repairs state, and verifies
recovery.

## Test and evidence adequacy

Map each invariant to the cheapest reliable layer: pure/unit, database
integration, service contract, disposable-stack browser, deterministic
performance, authorized UAT, or manual recovery exercise. Check that fixtures
represent roles and account states, assertions cover observable effects rather
than implementation calls, negative cases fail for the intended reason, and
cleanup is deterministic.

Call out skipped, flaky, stale-cassette, environment-gated, or report-only tests.
Do not count a test name as coverage without reading the assertion. Recommend a
new test with a precise layer, setup, trigger, expected invariant, and cleanup.
