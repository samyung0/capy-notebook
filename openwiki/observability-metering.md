# Observability & Metering

How a request is identified, what happens when it fails, what it cost, and who
is stopped from doing it too often.

Four services in three languages serve one user action. Without a shared
identifier, a chat turn that produces a wrong answer is four unrelated log
streams. Everything here hangs off one id.

Related: `backend-storage-quota.md` owns byte accounting;
`authorization-permissions-lifecycles.md` owns who may act at all. This document
owns the second budget — inference, GPU, egress, mail — and the request identity
all three share.

---

## 1. The trace id

W3C `traceparent`, minted in the browser, forwarded on every hop:

```
browser  →  Go gateway  →  Python retrieval  →  provider
                        →  Node collaboration
         ingest worker (mints its own; no inbound request)
```

| Runtime | Reads / writes | Where |
| --- | --- | --- |
| Browser | mints per request | `src/lib/trace.ts`, attached in `src/api/auth.ts` |
| Go gateway | continues or mints | `server/internal/obs/trace.go` |
| Go → pipeline | injects | `obs.Inject` in `internal/pipeline/client.go` |
| Python | continues | `pipeline/pipeline/obs.py` middleware |
| Python → Modal | injects | `obs.outbound_headers()` in `parse/modal_parser.py` |
| Ingest worker | mints per job | `ingest/worker.py` claim loop |

The gateway echoes it as `X-Request-Id`, so a user can quote the id from a
failed request.

**One id, not two.** Sentry's own distributed tracing is deliberately not
enabled to stitch services together. The W3C id is attached to Sentry events as
a `trace_id` **tag** instead, so a single string searches Sentry, greps the
logs, and joins `usage_events`. Two competing identifiers would mean every
investigation starts by translating between them.

A malformed inbound `traceparent` is treated as absent and a fresh id is minted.
Continuing a trace that does not exist upstream produces orphans that are harder
to debug than a new id.

### Detached work

Anything that must outlive its request — settling a charge, saving a partial
answer after a client disconnect, releasing a stream lease — uses
`obs.Detach(ctx, timeout)`. It keeps the trace and drops the cancellation.
Losing the trace here would mean the most interesting failures are exactly the
ones that cannot be traced to the request that caused them.

---

## 2. Structured logging

| Service | Setup |
| --- | --- |
| Go gateway | `obs.Init` — `log/slog`, and the stdlib `log` package is redirected into it so existing `log.Printf` call sites gain structure without being rewritten |
| Python | `obs.init_logging` — JSON formatter, uvicorn handlers removed so everything shares one shape |
| Node collaboration | `collaboration/src/observability.ts` |

Field names are shared across all three: `service`, `env`, `trace_id`,
`user_id`, `component`, `msg`. `LOG_FORMAT` is `json` outside development.

The gateway emits one access line per request from `obs.AccessLog`, including
`client_aborted` for disconnects. Streaming responses are logged when the stream
**closes**, so `duration_ms` is the life of the stream — the useful number for
finding streams that hang.

`obs.ClientIP` prefers `CF-Connecting-IP`. That header is only trustworthy while
the origin refuses non-Cloudflare traffic; see step 3 of the runbook. If the
origin is directly reachable, an attacker forges it and every IP-keyed rate
limit is bypassed.

---

## 3. Error reporting (Sentry)

Errors that reached the client as a 5xx are captured by middleware. Errors that
were **swallowed to keep a request alive** are the ones that need explicit
reporting, because nothing else will ever surface them:

- the chat fallback that silently replaces an unreachable pipeline with a
  placeholder answer,
- a failed credit settle,
- collaboration persistence failures — the editor stays live and the user keeps
  typing into a document that is no longer being saved.

Use `obs.CaptureErr` (Go), `obs.capture_error` (Python), `captureError` (Node).

Not reported: authentication rejections (expired tokens and stale tabs, high
volume, expected) and client-side `AbortError` / network failures during
streams, which happen every time a user navigates away mid-answer.

`send_default_pii` is off everywhere. Prompts, note content, and chat history
flow through these services.

---

## 4. Product analytics (PostHog)

`src/lib/observability.ts`. Loaded lazily, allowed to fail silently, and
**never** the source of truth for anything a user is charged for — a meaningful
share of users block it.

`autocapture` is off. The failure mode of product analytics is twelve spellings
of the same event across eighteen months, at which point no funnel can be built
retroactively. Events are a closed TypeScript union, named
`object_verb_past_tense`, with flat low-cardinality properties usable as
breakdowns. Adding an event means adding a variant to `AnalyticsEvent`.

Session replay is on **only for sessions that errored**, with text masked and
media blocked.

There is deliberately no server-side PostHog SDK. Everything the backend would
report is either already in `usage_events` (which is transactional and complete)
or in the structured logs (which are not sampled). A third, lossy copy would
only create a fourth number that disagrees with the other three.

---

## 5. Metering

### Why not telemetry

Analytics is sampled, asynchronous, and blockable. None of that is acceptable
for something a user is charged for. Metering is a transactional ledger in
Postgres, written in the same transaction as the counter it feeds.

### Two budgets, two payers

| | Storage | Inference / GPU / mail |
| --- | --- | --- |
| Paid by | workspace **owner** | the **actor**, except ingest (see below) |
| Why | the bytes sit in their account | the cost is the request itself, and it is gone whether or not anything was kept |
| Enforced by | `gateStorageTx` | `ReserveCredits` |
| Error | `storage_quota_exceeded` | `llm_credits_exhausted` |

An editor generating into someone else's workspace spends **their own** credits
and the **owner's** disk. The two errors are deliberately distinct: only one of
them is actionable by the person reading it.

The exception is ingest, which follows the file rather than the uploader —
see "Ingest is billed to the workspace owner" below.

### Tables

| Table | Role |
| --- | --- |
| `usage_events` | append-only source of truth; corrections are new rows |
| `user_credits` | the counter the gate locks; monthly period resets lazily on first read |
| `credit_reservations` | open holds, swept on expiry |
| `usage_daily` | pre-aggregated for the operator dashboard |
| `usage_rollup_state` | watermark so the rollup resumes instead of recomputing |

Shape mirrors `backend-storage-quota.md` on purpose: hot-path ledger, counter
row for the gate to lock, reconcile pass for drift.

### Reserve → settle

```
reserve(estimate)  →  model calls  →  settle(measured)
                                  ↘  release()      (failed before spending)
                                  ↘  sweep          (crashed; expires at 30 min)
```

Reservations exist because a purely post-hoc ledger lets two concurrent requests
both pass a gate that neither would pass alone. The estimate only has to be the
right order of magnitude — settlement replaces it.

**A stream abandoned before its `done` event settles at zero.** Undercharging a
user for an answer they never saw is the right side to err on, and
reconciliation finds the gap.

Estimates live in `server/internal/store/pricing.go`.

### Where tokens are captured

`pipeline/pipeline/retrieval/models.py` is the **only** module that calls a
provider. That makes it the only place capture is needed, and the only place a
missing capture can hide — a new provider call added elsewhere is invisible and
silently free.

A contextvar accumulator (`obs.Usage`) aggregates across every call a request
makes, because the unit of billing is the request: one chat turn is an agent
loop of several completions plus embeddings, and the user asked one question.

Streamed completions send `stream_options={"include_usage": True}`. **Without
it an OpenAI-compatible stream reports no usage at all**, which is how the
single highest-volume path in the product ends up costing an unknown amount.

Usage reaches the gateway as a `usage` envelope: on the SSE `done` event for
chat, and in the JSON body for `/generate`.

### Ingest is billed to the workspace owner, and charged after the fact

Ingest is the deliberate exception to "inference is billed to the actor". A file
in a workspace belongs to that workspace's owner regardless of who put it there,
so the work of making it retrievable — parsing, captioning, embedding — is
billed alongside the bytes it produces, to the same person. Splitting one
upload's cost between two payers would mean an owner could be left with an
indexed corpus whose indexing someone else paid for.

The rule is therefore about *durability*, not about who typed: work that leaves
a permanent artifact in a workspace is the owner's, and ephemeral inference
(chat turns, editor commands) is the actor's. Generate sits on the actor side
because the actor chose to spend on producing it; the material's *bytes* are
still billed to the owner by `gateStorageTx`.

Charging happens after the fact because nothing is waiting on an ingest job, the
file was already accepted, and refusing halfway leaves a half-indexed document.
`_charge_ingest` in the worker can therefore push a user past their limit; the
next interactive request is what refuses.

GPU time comes from Modal's `_server_parse_s`, which measures wall time inside
the container and **excludes queue wait and cold start**. It is the attributable
share, not the invoice.

### Pricing is policy

`server/internal/store/pricing.go`, mirrored in `pipeline/store/db.py` for the
worker. **These two must stay in step**, or the same work costs different
amounts depending on which process did it.

Rates are deliberately not derived from provider invoices. Provider prices move
and are quoted in units not visible at the call site (cached input, reasoning
tokens); deriving user charges from them would let a supplier price change
silently reprice the product. Drift is found by comparing the ledger to provider
dashboards, not by deriving one from the other.

### Background workers

`server/cmd/api/usage_workers.go`: reservation sweep (1 min), rollup (5 min),
reconcile (6 h). All idempotent, so a failure retries on the next tick.

**These run in-process on every replica.** Correct but wasteful with more than
one; they need a leader lock before scaling out.

---

## 6. Rate limiting

Three layers, each doing what the ones below it cannot:

| Layer | Sees | Handles |
| --- | --- | --- |
| Cloudflare | IP, path | volumetric floods, before origin bandwidth is spent |
| Go middleware | Clerk identity, plan, route class | per-user semantic limits |
| Credits ledger | measured cost | spend, in money rather than requests |

The edge cannot express "twenty chat streams an hour for a free account" because
it never sees the Clerk identity. `server/internal/ratelimit` uses Redis GCRA so
limits hold across replicas — the in-process counters it replaces only ever
worked with one.

**Route classes** (`middleware.go`): request cost across this API varies by four
orders of magnitude. Listing workspaces touches one index; a chat turn runs an
agent loop of up to four model calls. AI and upload routes carry a tighter
budget *on top of* the general one, so a caller cannot spend their whole general
allowance on model calls.

**Never limited:** `/webhooks/*`. Stripe and Clerk deliver subscription and
identity changes there, and a 429 becomes billing state that silently drifts.
They authenticate by signature and both providers apply their own delivery rate.

**Concurrency, not just rate**, bounds chat abuse: one stream runs for minutes
and drives an agent loop the whole time, so a requests-per-hour budget alone
still allows arbitrary parallel spend. `AcquireStream` uses a Redis sorted set
whose entries expire, so a replica that dies mid-stream leaks a slot that ages
out rather than one that is lost forever.

**Redis failures fail open.** A limiter outage must not become an API outage;
the edge still bounds the blast radius.

Disabled under `APP_ENV=e2e`, where Playwright drives hundreds of requests per
second through a handful of fixed users.

---

## 7. Operator access

`operators` — membership is the entire authorization model, and there is
deliberately **no API that grants it**. Rows are inserted by hand against the
database. An escalation path reachable from the product would make every bug in
the product a path to everyone's data.

---

## 8. What is still not visible

Worth knowing before trusting a dashboard:

- **Modal queue wait and cold start.** Only in Modal's own metrics. The ledger
  records execution time only.
- **Provider-side retries.** A provider that retries internally bills once and
  reports once; a client-side retry in `caption_image` bills twice and reports
  twice, correctly.
- **Cached input tokens.** Reported as ordinary input by most providers, so the
  ledger overcharges relative to real cost. Safe direction.
- **B2 egress.** Presigned URLs are fetched by the browser directly; the gateway
  never sees the transfer. Only B2's own reporting has it.
- **Aborted streams.** Settle at zero (see above), so real spend slightly exceeds
  the ledger.
- **The gateway's in-process SSE notification cap** (100 global / 6 per user) is
  still per-replica and unrelated to the Redis limiter.

---

## 9. Environment variables

| Variable | Services | Notes |
| --- | --- | --- |
| `SENTRY_DSN` | gateway, retrieval, worker, collaboration | empty disables |
| `VITE_SENTRY_DSN` | SPA | separate DSN, it is public |
| `SENTRY_TRACES_SAMPLE_RATE` | gateway, retrieval | default `0.1` |
| `RELEASE_SHA` / `VITE_RELEASE_SHA` | all | ties errors to a deploy |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | SPA | empty disables |
| `LOG_FORMAT` | all | `json` \| `text` |
| `LOG_LEVEL` | all | default `info` |
| `CORS_ALLOWED_ORIGINS` | gateway | comma separated; empty means `*` |
| `RATE_LIMIT_DISABLED` | gateway | forced true under `APP_ENV=e2e` |
| `RATE_LIMIT_AI_PER_HOUR` | gateway | overrides the default 40 |
| `RATE_LIMIT_CONCURRENT_STREAMS` | gateway | overrides the default 3 |
