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

Python `log.exception` / `log.error` do **not** create Sentry events. The worker
and retrieval service initialize Sentry with `LoggingIntegration(event_level=None)`,
so logs are breadcrumbs and `capture_error` is the only reporting path. That is
what stops a retryable provider 503 from opening an issue on its way to being
requeued.

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
| Paid by | workspace **owner** | the **actor** |
| Why | the bytes sit in their account | the cost is the request itself, and it is gone whether or not anything was kept |
| Enforced by | `gateStorageTx` | `ReserveCredits` |
| Error | `storage_quota_exceeded` | `llm_credits_exhausted` |

An editor generating into someone else's workspace spends **their own** credits
and the **owner's** disk. The two errors are deliberately distinct: only one of
them is actionable by the person reading it.

Ingest follows the same split: the uploader (the actor on the job payload) pays
for parse/caption/embed, and the workspace owner pays for the stored bytes.
Every inference path is actor-billed.

### Model registry and pinning

`model_configs` rows are immutable and versioned. Both the gateway
(`server/internal/models`) and the pipeline (`pipeline/pipeline/registry.py`)
cache `(model_key, version)` forever and poll `model_registry_state` every 30s
for the current defaults. A pinned pair that is not in cache is a point read of
the table. A cache miss **never** falls back to the current default — that would
quietly reprice an in-flight pin. Operators disable rows rather than
deleting them for that reason (ops dashboard registry grid). In-flight
assistant pins keep resolving via `Get` of the disabled row. Retiring the
last chat/generate version of a user-facing key remaps prefs and notifies
(`model_deprecated`). There is no request-time fallback — a pref that
still names a disabled key fails `model_unavailable`.

Conversations do not snapshot a model. Each chat turn calls
`ratesForSurface`, which reads `users.chat_model_key` (always set; populated
from the registry surface default at account creation) and resolves the latest
enabled version of that key. The `{modelKey, modelVersion, displayName}` pair
is written onto the **assistant message**. Settings changes apply to the next
message in an existing thread. Generate resolves `users.generate_model_key`
the same way per request. The browser cannot choose a model per message.
Chat, generate, editor and quiz preferences are edited in **Settings → LLM**
(`GET /api/models`, `PATCH /api/me/models`). Empty preference writes are
rejected, and a `PATCH` only touches the surfaces it names. Editor AI
(`/ai/command`, `/ai/copilot`, `/complete/stream`) resolves
`users.editor_model_key` the same way chat does. It is the highest-call-volume
surface per user, so it is the one where an expensive choice shows up first in
credit burn. Quiz marking (`POST /api/quiz-grade`) resolves
`users.quiz_model_key` the same way, reserved at the editor estimate. A
`browser:` prefix is a client-only in-tab GGUF: it is stored on the user row,
skipped by registry lookup, and never metered. Those grades never call
`POST /api/quiz-grade`, write no `usage_events`, and do not appear on
Billing. Attempt points stay on the quiz snapshot for the taker. They are
not a billed or trusted score.

Ingest and vision are pinned onto the job at enqueue (`ingestJobPayload`),
because their defaults are hot-reloadable and a queued job may outlive one.
Embedding is not on the job: it belongs to the workspace
(`workspaces.embedding_model_key`) for that workspace's lifetime, and both
ingest and query read it from there. See
[agentic-retrieval.md](agentic-retrieval.md) for why that is not a normal
preference.

Nothing resolves a surface default on the way to a provider call. `resolve_pinned`
in the pipeline requires an exact `(key, version)` for every surface, and a pin
or preference that cannot be loaded fails the request (`model_unavailable`) or
the job. There is no Flash fallback.

Per-model credit multipliers live on the config row. The 1x reference is DeepSeek
Flash (250 / 1000 micros per input/output token). USD columns are
reconciliation-only.

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

The signed-in billing page reads this ledger directly. `GET /api/billing` now
includes the current credit counter (`creditsUsedMicros` / reserved / limit /
period start) next to storage. `GET /api/usage` groups this actor's current
month by `kind` and `surface` and returns recent `usage_events` rows. It does
**not** query `usage_daily` — that table is the operator dashboard and lags the
ledger by up to a minute. USD is omitted: `cost_micro_usd` is reconciliation
only.

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
chat and `/complete/stream`, as `data-usage` (stripped before the browser) for
Plate command streams, and in the JSON body for `/generate` and `/plate-ai/copilot`.

### Ingest is billed to the actor

Inference is billed to whoever initiated it. `_charge_ingest` reads
`actorUserId` from the job payload (written at enqueue in `jobs.go`) and records
the ledger against that user. The workspace owner still pays for the file's
bytes via `gateStorageTx`.

Claim-time gating is two lookups, not one widened check:

| Subject | Checked for | On failure |
| --- | --- | --- |
| Owner (`files.user_id`) | lifecycle state, storage | refuse the job |
| Actor (payload `actorUserId`) | credits only | refuse the job |
| Actor | lifecycle | **not checked** |

Actor lifecycle does not gate ingest. A `deletion_pending` uploader must not
leave the owner holding an unindexed file whose bytes they already paid for.
Credits are the actor's money; lifecycle is the owner's workspace's business.
A job already running finishes and bills after the fact.

Upload reservation (`createSourceUpload`) checks the same two budgets up front,
with the same distinct errors.

Charging happens after the fact because nothing is waiting on an ingest job, the
file was already accepted, and refusing halfway leaves a half-indexed document.
`_charge_ingest` can therefore push a user past their limit; the next
interactive request is what refuses.

Parse time comes from Modal's `_server_parse_s`, which measures wall time inside
the container and **excludes queue wait and cold start**. It is the attributable
share, not the invoice. Ledger kind is still `parse_gpu`.

### Pricing is policy

`server/internal/store/pricing.go` prices from the resolved `model_configs` row.
The pipeline uses the same rows via `pipeline/pipeline/registry.py`. There is no
mirrored rate table in `db.py`.

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

The edge cannot express "200 AI requests an hour for this Clerk user" because
it never sees the identity. `server/internal/ratelimit` uses Redis GCRA so
limits hold across replicas — the in-process counters it replaces only ever
worked with one.

**Route classes** (`middleware.go`): request cost across this API varies by four
orders of magnitude. Listing workspaces touches one index; a chat turn runs an
agent loop of up to four model calls. AI routes (`/chat/stream`, `/generate`,
`/ai/command`) are 200/hour with burst 15, plus a 15/minute
short-window guard so a scripted loop trips immediately. Cheap editor routes
(`/complete/stream`, `/ai/copilot`) have their own 120/minute class so typing
in the note does not consume the chat allowance. Upload routes carry a tighter
budget *on top of* the general one. Credits remain the money bound; these
limits only stop abuse patterns.

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
- **Reindexing a workspace into a different embedding model.** Not implemented,
  deliberately: see [agentic-retrieval.md](agentic-retrieval.md).
- **Ingest retries.** A retried ingest that hits the parse-zip or caption
  cache is not billed for GPU/vision a second time; a retry that re-embeds is.
  A stream of lease-reclaimed jobs after a worker crash can still over-count
  if the original process was alive and writing. Heartbeat + a lease well
  above typical duration is the mitigation.

Ingest enqueue used to be listed here as two fail-open billing holes and now
fails closed instead, which is worth knowing because the failure is visible to
users. `ingestJobPayload` returns an error — and `CreateSourceWithJob` /
`completeSourceUpload` roll back their transaction — when there is no
`actorUserId`, no registry, or no resolvable ingest/vision default. The worker
does the same at claim time: `_account_allows_ingest` refuses a job with no
actor, and a job whose pins do not resolve is failed with
`stage=ingest_job_pins` rather than run. So an upload can now fail where it
previously succeeded, and the cause is registry state, not the file.

The reasoning: the alternative was the most expensive path in the product (GPU
parse, captions, embeddings, three summarization passes) running against
whichever defaults the worker happened to hold, settling at those rates or at
nothing. An upload the user can retry is recoverable; unpriced work is not, and
the likelihood grew every time the registry was reconfigured.

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
| `RATE_LIMIT_AI_PER_HOUR` | gateway | overrides the default 200; 15/min burst and editor 120/min are code-only |
| `RATE_LIMIT_CONCURRENT_STREAMS` | gateway | overrides the default 3 |
| `SENTRY_DSN_GATEWAY` / `_RETRIEVAL` / `_WORKER` / `_COLLABORATION` | compose | mapped onto each process's `SENTRY_DSN` |
