# Observability & Metering

How a request is identified, what happens when it fails, what it cost, and who
is stopped from doing it too often.

Four services in three languages serve one user action. Without a shared
identifier, a chat turn that produces a wrong answer is four unrelated log
streams. Everything here hangs off one id.

Related: `backend-storage-quota.md` owns byte accounting;
`authorization-permissions-lifecycles.md` owns who may act at all. This document
owns the second budget for inference, document parsing, egress, and mail, plus the request identity
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
| Python → parser VM | injects | `obs.outbound_headers()` in `parse/modal_parser.py` |
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

- a failed credit settle,
- collaboration persistence failures — the editor stays live and the user keeps
  typing into a document that is no longer being saved.

Chat and generate used to invent a local answer when the retrieval service
was unreachable. They now fail the request (`ai_unavailable`). The user sees
that miss; do not reintroduce a placeholder to keep the stream "alive."

Use `obs.CaptureErr` (Go), `obs.capture_error` (Python), `captureError` (Node).

The Ops service uses the same Go trace and Sentry middleware. It creates or
continues the W3C request trace before installing the Sentry scope. Handled Ops
fallbacks, including a failed `touch_operator_seen`, call `obs.CaptureErr`
explicitly because the HTTP response remains successful.

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

`src/lib/observability.ts` loads PostHog lazily and lets it fail silently.
PostHog is never the source of truth for anything a user is charged for. A
meaningful share of users block it. Billing lives in `usage_events`.

There is no server-side PostHog SDK. The backend already writes
`usage_events` (transactional, complete) and structured logs (unsampled). A
third, lossy copy would only create a fourth number that disagrees with the
other three.

`autocapture` stays off. PostHog session replay stays off. Sentry owns
error-only replay. See section 3.

The failure mode of product analytics is twelve spellings of the same event
across eighteen months, at which point no funnel can be built retroactively.
Events are a closed TypeScript union, named `object_verb_past_tense`, with
flat low-cardinality properties usable as breakdowns. Adding an event means
adding a variant to `AnalyticsEvent` and a `track` call site. Never put titles,
prompts, or note content in properties. Workspace and material ids are fine.

`src/lib/analytics.ts` holds the pure helpers (buckets, path, ingest once-per
file, quota gate) so unit tests do not import Sentry or PostHog.

### Identify and pageviews

`src/components/app/AnalyticsRoot.tsx` is the only owner of both.

Identify runs after Clerk `useAuth` and `useUser` are loaded, or after MSW
`useMe` succeeds. The SPA passes the user id and, when it already has it, the
email. It does not fetch email only for analytics. Logout and a failed `/me`
call `identifyUser(null)`.

`identifyUser` is idempotent on `(userId, email)`. PostHog `identify` gets
`{ email }` when email is present. Sentry `setUser` is id-only. There are no
person properties (`plan`, locale, or otherwise). `send_default_pii` stays
off on Sentry.

Pageviews fire once per parameterized TanStack route pattern
(`match.fullPath`), with search stripped. Raw UUID paths are not sent.

### Event catalog

| Event | When it fires |
| --- | --- |
| `workspace_created` | Sidebar create succeeds. `source` is always `sidebar`. |
| `source_uploaded` | `useUploadSource` succeeds. |
| `source_ingest_completed` | File reaches `ready`, including store-only (`indexed: false`). Once per file. |
| `source_ingest_failed` | File reaches `failed`. `reason` is a short code, never the SSE message. |
| `chat_turn_sent` and `chat_turn_completed` | `useChatStream.send`. `hasScope` is `false`. Completed fires once for ok, error, or abort. |
| `material_generated` / `material_generate_failed` | `useGenerate` success or error. |
| `editor_ai_used` | Plate AI menu submit. `continue` vs typed or other actions (`command`). Prompt is not sent. |
| `quiz_attempt_finished` | Grade succeeds, even if persist 401s. |
| `share_link_created` | Visibility becomes `link` or `public`. |
| `collaborator_invited` | Invite create succeeds. |
| `quota_blocked` | User-visible quota or credits block on mutation, clone, or upload. |
| `subscription_checkout_started` | Checkout returns a `url`, before redirect. |
| `note_created` | `useCreateNote` succeeds. |
| `deck_study_finished` | Session queue empties after `sessionTotal > 0`. Once per session. |
| `item_cloned` | Clone succeeds. `source` is `share`, `explore`, or `app` (`/quizzes`, `/flashcards`, and their child routes). Workspace clones still fire only from share or explore call sites. |
| `invite_accepted` | `useAcceptWorkspaceInvite` succeeds. |

Buckets live in `src/lib/analytics.ts`. Size is bytes. Duration is
milliseconds. Score is 0 to 100 percent. Card count does not fire for an empty
session.

### Funnels

Activation is `workspace_created` → `source_uploaded` →
`source_ingest_completed` with `indexed` true → first of `chat_turn_sent`,
`note_created`, or `deck_study_finished`.

Retention is weekly first-time `$pageview`, returning on `$pageview`.

Paywall is `quota_blocked` → `subscription_checkout_started`. That chart is
not created in PostHog. Read it from the event stream when you need it.

`featureEnabled` / PostHog flags stay unused. Compile-time `src/lib/features.ts`
remains the gate.

---

## 5. Metering

### Why not telemetry

Analytics is sampled, asynchronous, and blockable. None of that is acceptable
for something a user is charged for. Metering is a transactional ledger in
Postgres, written in the same transaction as the counter it feeds.

### Two budgets, two payers

| | Storage | Inference / parse / mail |
| --- | --- | --- |
| Paid by | workspace **owner** | the **actor** |
| Why | the bytes sit in their account | the cost is the request itself, and it is gone whether or not anything was kept |
| Enforced by | `gateStorageTx` | `BeginProviderSession` / `BeginIngestSpend` |
| Error | `storage_quota_exceeded` | `llm_credits_exhausted` |

An editor generating into someone else's workspace spends **their own** credits
and the **owner's** disk. The two errors are deliberately distinct: only one of
them is actionable by the person reading it.

Ingest follows the same split: the uploader (the actor on the job payload) pays
for parse/caption/embed, and the workspace owner pays for the stored bytes.
Every inference path is actor-billed.

### Model registry and pinning

`model_configs` rows are immutable and versioned. The provider-facing identity
is `provider_slug` + `model_slug` from the closed elitellm list
(`elitellm_providers.json`). First-party only (`anthropic`, `openai`,
`deepseek`, `gemini`), plus the OpenRouter qwen-embed hop. The typed surface
policy in `server/internal/models/surface.go` lists which product surfaces need
an agentic loop. Assigning a model to any listed surface requires a current
two-turn streaming replay certification for the exact
`(provider_slug, model_slug)` identity. Chat is currently the only listed
surface. The gate also runs when an existing catalog row is saved, so a stale
row cannot bypass a removed certificate.
`pnpm test:pipeline:replay` only replays the checked-in certification tapes and
never records. `pnpm model:certify` makes the paid live calls needed to certify
a new exact model slug or replace an existing certification, then regenerates
the Go agentic-loop certificate embed. It does not write the model registry database.
Both the gateway (`server/internal/models`) and the pipeline
(`pipeline/pipeline/registry.py`) cache `(provider_slug, model_slug, version)` forever and
poll `model_registry_state` every 10 minutes for the current defaults. A
pinned pair that is not in cache is a point read of the table. A cache miss
**never** falls back to the current default — that would quietly reprice an
in-flight pin. Operators disable rows rather than deleting them for that
reason (ops dashboard registry grid). In-flight assistant pins keep resolving
via `Get` of the disabled row. Clearing a preference remaps users to the
surface default. A pref that still names an unusable key fails
`model_unavailable`, except BYOK-only rows that the user still has a key
for.

Conversations do not snapshot a model. Each chat turn calls
`ratesForSurface`, which reads `users.chat_model_provider_slug` and
`users.chat_model_slug` (always set; populated
from the registry surface default at account creation) and resolves the latest
enabled version of that provider/model identity. The
`{providerSlug, modelSlug, modelVersion, modelDisplayName}` tuple
is written onto the **assistant message**. Settings changes apply to the next
message in an existing thread. Generate resolves the
`users.generate_model_provider_slug` / `users.generate_model_slug` pair
the same way per request. The browser cannot choose a model per message.
Chat, generate, editor and quiz preferences are edited in **Settings → LLM**
(`GET /api/models`, `PATCH /api/me/models`). Empty preference writes are
rejected, and a `PATCH` only touches the surfaces it names. Editor AI
(`/ai/command`, `/ai/copilot`) resolves
the `users.editor_model_provider_slug` / `users.editor_model_slug` pair the same
way chat does. It is the highest-call-volume
surface per user, so it is the one where an expensive choice shows up first in
credit burn. Editor thinking is forced to Instant on the Python call.
Settings show Instant as a disabled control for this surface. Quiz marking (`POST /api/quiz-grade`) resolves
the `users.quiz_model_provider_slug` / `users.quiz_model_slug` pair the same way. A
`browser:` prefix is a client-only in-tab GGUF: it is stored on the user row,
skipped by registry lookup, and never metered. Those grades never call
`POST /api/quiz-grade`, write no `usage_events`, and do not appear on
Billing. Attempt points stay on the quiz snapshot for the taker. They are
not a billed or trusted score.

Ingest and vision are pinned onto the job at enqueue (`ingestJobPayload`),
because their defaults are hot-reloadable and a queued job may outlive one.
Embedding is not on the job: it belongs to the workspace
(`workspaces.embedding_provider_slug`, `embedding_model_slug`, and version) for
that workspace's lifetime, and both
ingest and query read it from there. See
[agentic-retrieval.md](agentic-retrieval.md) for why that is not a normal
preference.

Nothing resolves a surface default on the way to a provider call. `resolve_pinned`
in the pipeline requires an exact `(key, version)` for every surface, and a pin
or preference that cannot be loaded fails the request (`model_unavailable`) or
the job. There is no Flash fallback.

Per-model credit multipliers live on the config row as three rates: input,
cached-read input, and output. The 1x reference is DeepSeek Flash (250 / 25 /
1000). There is no USD estimate on `model_configs` or `usage_events`.
`RatesFromConfig` and `credits_for_tokens` compute
`(input-cached)*input + cached*cache + output*output`. A 0 stays 0. Missing or
unproven cache details charge all reported input at the input rate and do not
fail the request. Cache writes are ordinary input under the three-rate design.
Credit micros may be 0 only on BYOK-only rows (`platform_enabled=false`).
(`model_configs_credit_rates_check`). Platform chat/generate/editor/quiz/
ingest/vision rows need input, cached-read, and output all > 0. Embedding needs
input > 0; cached-read and output may be 0.

### Tables

| Table | Role |
| --- | --- |
| `usage_events` | append-only source of truth; includes the actual per-call thinking level; corrections are new rows |
| `user_credits` | the counter the gate locks; monthly period resets lazily on first read |
| `provider_sessions` | request or ingest sessions; owns the concurrency lease, per-session credit reservation, and pinned provider configuration, swept on expiry |
| `provider_calls` | one row inserted before each provider attempt; records lifecycle, measured usage, and numeric-only context composition telemetry |
| `parse_host_samples` | permanent 5-second-active / 60-second-idle numeric host samples; contains no file, user, path, or document identity |

Shape mirrors `backend-storage-quota.md` on purpose: hot-path ledger, counter
row for the gate to lock, reconcile pass for drift.

The signed-in billing page reads this ledger directly. `GET /api/billing` now
includes the current credit counter (`creditsUsedMicros` / reserved / limit /
period start) next to storage. `GET /api/usage` groups this actor's current
month by `kind` and `surface` and returns recent `usage_events` rows. It does
not use a separate analytics table. The page shows credits, tokens, the catalog
provider/model slugs, and `paidBy`. It does not show USD. The operator dashboard
also reads bounded
`usage_events` ranges directly; there is no periodic usage rollup while the
ledger is small enough for indexed live queries.

### Begin, settle each call, close

```
begin(session)  →  provider call  →  settle(call id, measured usage)
                                  →  provider call  →  settle(...)
                →  close session
                ↘  release()      (failed before spending)
                ↘  sweep          (crashed; LLM expires at 30 min)
```

A current session reserves 0 credits in `provider_sessions.reserved_micros`.
The column records the session's contribution when a future workflow takes an
estimated credit hold. Platform
chat, generate, editor, and quiz share `ConcurrentLLMLeases` (5). The gate is
`used + reserved >= limit` plus that cap, the same check as
`AssertCreditsAvailable`. BYOK chat has a session for idempotent usage events
but does not consume a concurrency slot and skips the platform used+reserved
gate. Other BYOK routes skip the LLM lease.

Every outbound attempt inserts its `provider_calls` row before the network
call. A successful response appends its `usage_events` row and marks the call
`applied` in the same transaction. A failed attempt is `abandoned`, so an
applied call without a matching ledger event is an invariant violation rather
than an expected timing window.

After each platform-paid LLM settlement, the gateway compares the new
`used_micros + reserved_micros` balance with the plan limit. Crossing the limit
stamps `provider_sessions.credits_exhausted_at`. The agent loop reads that
result and permits at most one tool-free terminal call.

Immediately before an LLM request, the pipeline applies the provider-specific
request transformation and estimates the resulting variable-sized fields in
three categories: system-prompt content, tool definitions and response schemas,
and conversation content. This includes OpenAI Responses input items, Anthropic
tool and thinking blocks, DeepSeek `reasoning_content`, full tool arguments, and
tool results. Rolling summaries and compactions count as conversation. Only
token counts, the context-window size, and the estimator method/version are
stored on `provider_calls`; prompt, schema, tool argument, and response content
are not stored. Provider-reported `input_tokens` remains authoritative, and Ops
shows the actual-minus-estimated delta. Operators can set a model catalog
`context_safety_margin_tokens` from that observed error. Chat admission uses
the greater of that value and the 512-token protocol minimum. Keeping this
telemetry on the pre-call row means failed and retried attempts remain visible
too.

Ingest is a separate reservation (`surface='ingest'`), cap 20 per actor across
every workspace (`ConcurrentIngestLeases`). Provider sessions do not count
ingest rows. The ingest hold lasts until settle, fail, or release. It does not use the
30-minute LLM TTL. A 24-hour backstop releases an ingest reservation that has
no pending or running job pointing at `payload.reservationId`. A live pending
job is not expired. `GET /api/me/ingest-slots` returns this actor's free/used/
limit. The 21st enqueue fails with `too_many_ingest_leases`, distinct from
`too_many_streams` and `llm_credits_exhausted`. Store-only uploads
(`NeedsIngestJob` false) do not take a lease.

Query embeddings are recorded at zero credits, so those calls cost the actor
nothing to start. Ingest embeddings still bill through the worker.

Every billed LLM path (chat, generate, editor, quiz, complete) opens a
provider session and binds it in Python. Before the provider HTTP call,
Python resolves the thinking level for that specific call, locks the open
session, and inserts an exact `provider_calls` authorization row (`open`) with
that level. Calls after exhaustion must be the one `terminal` LLM call; this
check and terminal-slot claim happen before provider spend. A failed open does
not call the provider. A provider exception marks the row `abandoned` and
releases a claimed terminal slot. Measured usage is then posted to the existing
settle callback.

Settlement is atomic. One database transaction locks the reservation and
actor counter, writes `usage_events`, applies the measured credits, and changes
the provider call from `open` to `applied`. A failure rolls back all of those
writes and returns an error, so Python's same-call-id retry repeats the whole
operation. A committed retry observes the existing event and does not charge
twice. There is no durable `received` state, `unsettled_bill` gate, or credit
reconciliation repair job. `open` rows remain insight for calls that never
reported usage, and provider invoices remain deliberately outside user pricing.

Client disconnects keep usage that already reached the receipt. A late
receipt after the turn is closed still charges and never authorizes
another call. Each event copies the turn trace id from the reservation.
Python retries a failed callback with the same call id. Go requires a
terminal `done` event; an upstream EOF before it marks the assistant
response as an error rather than finalizing a partial stream as complete.

### Where tokens are captured

`pipeline/pipeline/retrieval/models.py` is the **only** module that calls a
provider. That makes it the only place capture is needed, and the only place a
missing capture can hide — a new provider call added elsewhere is invisible and
silently free.

A contextvar accumulator (`obs.Usage`) still aggregates request telemetry.
Chat, generate, editor, and quiz bind a `RequestAccounting` context when the
gateway sends `spendSessionId`. `models.py` opens the pending call, then
posts measured usage to the gateway before returning. The callback carries a
stable call id, call purpose, normalized cache fields, and measured tokens.
`usage_events` has one row per call, and
`(reservation_id, provider_call_id)` rejects duplicate settlement.
A retry with identical usage returns the prior decision. Settlement requires
the exact pre-authorized session, kind, and purpose; it cannot create or
overwrite a stub. Reusing the call id with different usage returns a conflict
instead of silently accepting it.
Provider SDK automatic retries are disabled, so one call id represents one
outbound provider attempt. A future explicit provider retry must use a new call
id; retrying only the settlement callback keeps the original id.
Chat planning retries a pre-byte provider failure twice on a new call id and
`abandons` the failed attempt. After the first provider chunk — even if the
browser has not received SSE yet — the failure is final and the row is
`abandoned`, not left `open`. A client disconnect cancels only the
server→browser SSE write; the in-flight provider call is not cancelled. When
that response returns usage it is settled and billed, and the agent loop does
not start another planning step.
The response says whether the call exhausted credits and whether one terminal
call remains. The session authorizes that tools-disabled terminal call without
another begin gate, so it may overspend. Authorization claims the slot before
the provider request; after that call opens, the session rejects a second one.

Query embeddings use the same callback and are written at **zero credits**.
The product absorbs that cost. The usage row still carries the workspace
embedding pin so the event is labeled. Chat and generate call
`resolveEmbedding` before opening spend. `EmbeddingRates` fails
closed on a nil registry, empty workspace, query miss, empty pin, catalog miss,
or a row that is not embedding. There is no `DefaultEmbeddingRates`. A miss is
`model_unavailable`. Editor and quiz pass empty embed
rates and do not call `resolveEmbedding`. Ingest embeddings still bill the
actor at the workspace pin's rates.

Streamed completions send `stream_options={"include_usage": True}`. **Without
it an OpenAI-compatible stream reports no usage at all**, which is how the
single highest-volume path in the product ends up costing an unknown amount.

Usage reaches the gateway as a `usage` envelope: on the SSE `done` event for
chat, as `data-usage` (stripped before the browser) for
Plate command streams, and in the JSON body for `/generate` and `/plate-ai/copilot`.

### Ingest is billed to the actor

Inference is billed to whoever initiated it. The ingest completion path reads
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

Charging happens after the fact because nothing is waiting on an ingest job,
the file was already accepted, and refusing halfway leaves a half-indexed
document. LLM and embedding calls settle individually when each provider
response returns. The worker records each parse attempt before it marks the job
for retry, failure, or success. Either path can push a user past their limit;
the next interactive request is what refuses.

The parse event uses `kind='parse'`, `unit='pages'`, and one row per job attempt.
`parse:{job id}:{attempt}` is the idempotency key. A repeated bookkeeping write
does not add a second event or increment `user_credits` twice. Cache and donor
hits do not create parse events because they did not run Marker.

The charge is per page, not per container time. Every page gets exactly one of
two rates: 31 credits for a digital page or 52 credits for a page routed through
RapidOCR. The OCR rate replaces the digital rate. It is not a surcharge added
on top.

The 31/52 rates remain the provisional user policy during the VM benchmark.
They must be reviewed after measured throughput is available against the fixed
€20.20 monthly VM cost; a deployment change does not silently reprice users.

The persistent parser returns attributable child-process CPU, wall time, queue
time, B2 download/upload time, current RSS/PSS, and I/O bytes. CPU includes the
LibreOffice child used to normalize DOC/DOCX, PPT/PPTX, and XLS/XLSX. Those fields are operational
telemetry only. Page counts determine the charge.

Host saturation is separate. `pipeline.parse.host_sampler` reads host `/proc`,
polls parser admission counts, and writes compact typed rows every five seconds
while active and every sixty seconds while idle. Raw samples are kept
permanently and the Ops API groups them into one-minute buckets. Shared Marker
layout-server CPU cannot be assigned honestly to one concurrent job, so the
dashboard shows attributable job CPU, parser memory, and whole-host CPU/memory
as distinct series.

### Pricing is policy

`server/internal/store/pricing.go` prices from the resolved `model_configs` row.
The pipeline uses the same rows via `pipeline/pipeline/registry.py`. There is no
mirrored rate table in `db.py`.

LLM rates are deliberately not derived from provider invoices. Provider prices
move and are quoted in units the product does not copy, including supplier cache
prices and reasoning tokens. Cache-read tokens are billed from the catalog
rate, not the invoice. The two fixed parse page rates were calibrated from the
former Modal deployment. They change only in code, with a new policy review and
tests after the VM benchmark is accepted.

### Background workers

`server/cmd/api/usage_workers.go`: reservation sweep (1 min) and reconciliation
queue polling (5 s). The poller idempotently
enqueues one UTC-daily storage run and, when Stripe is configured, one
UTC-daily Stripe run. Manual ops requests use the same queue.

`reconcile_runs` is both queue and history. A runner claims one pending row with
`FOR UPDATE SKIP LOCKED` and a lease, then records status, timing, operator,
counts, and safe error metadata. `reconciliation_report` is sparse: storage and
Stripe jobs write only actual drift repairs or per-item failures worth operator
attention. A clean run has no report rows. Long runs heartbeat their lease;
every repair and report transaction checks the lease token and expiry, so a
reclaimed worker cannot keep writing alongside its replacement.

Stripe reconciliation reads the complete paginated set of active, trialing, and
past-due subscriptions. It compare-and-swaps against the database snapshot from
before the Stripe read and retries if a webhook committed in between. The
provider-read start time is the webhook ordering watermark, so a webhook
created after that read can still supersede the reconciliation result.

These loops run in-process on every replica. Queue claims are replica-safe; the
reservation sweep is idempotent but still duplicates scheduling work until it
gains a leader lock.

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
orders of magnitude. Listing workspaces touches one index. A chat turn is
capped at 12 planning responses and 12 accepted tool calls. Provider completion,
compaction, embedding, and cumulative input counts are telemetry. AI routes
(`/chat/stream`, `/generate`, `/ai/command`) are 200/hour with burst 15, plus
a 15/minute short-window guard so a scripted loop trips immediately. Cheap
editor routes (`/ai/copilot`) have their own 120/minute
class so typing in the note does not consume the chat allowance. Upload
routes carry a tighter budget on top of the general one. Credits remain the
money bound; these limits only stop abuse patterns.

**Never limited:** `/webhooks/*`. Stripe and Clerk deliver subscription and
identity changes there, and a 429 becomes billing state that silently drifts.
They authenticate by signature and both providers apply their own delivery rate.

**Concurrency, not just rate**, bounds chat abuse: one stream runs for minutes
and drives an agent loop the whole time, so a requests-per-hour budget alone
still allows arbitrary parallel spend. `BeginProviderSession` counts open
non-ingest leases in Postgres (cap 5). A replica that dies mid-stream leaves a row the
sweeper releases after 30 minutes. BYOK does not take a lease. Ingest
concurrency is the separate cap of 20 above, not this one.

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

The standalone service at `ops.evonotes.com` adds two identity gates before
that membership check. Cloudflare Access signs the edge assertion, which the
origin verifies against the team JWKS with issuer and audience checks. It
protects both static files and `/api/ops`. The static shell then starts Clerk.
Every Ops API request carries a Clerk bearer token, whose subject must match an
`operators` row. Access and Clerk remain independent gates; their email
addresses do not have to match.

Each accepted API request calls `touch_operator_seen`. That write is
best-effort. A failure is logged and sent to Sentry with the request `trace_id`
and operator `user_id`, but the authenticated request continues. Activity
tracking must not turn a usable dashboard into an outage.

Operator membership does not override product account locks. Deleted,
suspended, and deletion-pending users are denied even while an `operators` row
remains. Over-quota grace and frozen states retain ops access because they are
storage restrictions, not identity revocations.

Routine reads and the last-seen function use `evo_ops`. That role has no access
to message bodies, file bodies, email payloads, job payloads, or usage
metadata, and it cannot update `operators` directly. The shared
`evo_ops_admin` pool opens lazily after a `write_registry` or
`execute_reconciliation_job` token check. It contains the restricted registry
grants and can execute `request_reconciliation`; that function checks
`ops_permissions` again before it inserts a pending storage or Stripe run.
Browser sessions never receive database credentials. Read endpoints require
`read_all`. Tokens are rows on `ops_permissions` keyed by `operators.role`;
the two database login roles stay deploy-time DSNs. Startup validates both role
contracts. Broad owner/gateway credentials, customer-content reads, direct
operator-table updates, direct reconciliation queue writes, and registry
DELETE privileges fail startup.

`operator_audit_events` is the chronological record of accepted Ops mutations.
Registry saves and manual reconciliation requests append an actor-role snapshot,
target, outcome, request trace id, and safe summary in the same transaction as
the action. A missing audit insert therefore rolls back the mutation. Database
triggers reject row changes and truncation. The actor id is durable text rather
than a user foreign key, so account deletion does not remove attribution.
Reconciliation execution status and repair details remain authoritative in
`reconcile_runs` and `reconciliation_report`; the audit row links to the run
instead of copying its lifecycle. Application logs and Sentry retain debugging
details but are not the audit record.

Dashboard aggregates and charts read indexed, bounded `usage_events` ranges.
Overview is fixed to the current UTC month and cached in-process for 30 seconds;
the usage explorer allows current month, current quarter, current year, or a
custom range of at most 366 inclusive days. Month and quarter use daily buckets;
year and longer custom ranges use monthly buckets. Each response carries one
`dataAsOf` timestamp so live rows are not presented as a periodic snapshot.
Provider/model grouping uses the catalog provider, model slug, and version as
the primary billing identity; the transport-observed provider/model is shown as
secondary diagnostic data.

The header's refresh button refetches all active Ops GET queries. It never
calls an LLM provider, the parser, or Stripe and it never starts reconciliation.
Every mounted Ops query polls its database-backed endpoint every 30 seconds,
including overview, health, user lookup, user detail, usage reports, registry,
audit history, and reconciliation. Hidden routes do not keep polling. LLM usage
is event-driven: it appears after the provider response settles into
`usage_events`, not after a separate provider usage poll. The UI labels that
timing on usage views. Reconciliation has its own page because its job output is
periodic. That page separates controls, run history, and sparse repair or
failure reports from live system health.

The health screen joins assistant turn status, reservation status, provider
attempts, and ledger events. It separates active streaming turns, stale or
incomplete turns, failed/aborted terminal turns, and abandoned provider
attempts; the latter shows the eventual turn outcome so recovered retries are
not mislabeled as terminal failures. It also flags completed turns without an
applied LLM call, applied calls without their atomic usage event, and LLM or
embedding usage rows without the provider-call row that authorized them.
`messages_ops_assistant_idx`, `provider_sessions_trace_idx`,
`provider_calls_reservation_idx`, `provider_calls_context_idx`, and the usage
event indexes keep those live queries bounded. The Ops database role still has
a statement timeout as a final guardrail.

---

## 8. What is still not visible

Worth knowing before trusting a dashboard:

- **Exact shared-CPU attribution.** `parse_cpu_milliseconds` measures the child
  that owns one document, including Office-converter children. Shared layout
  helper work appears in host saturation, not in a guessed per-job split.
- **A lost parser response.** A measured parser exception returns its page and
  CPU receipt and is charged before the job retries. If the network loses the
  whole response after the parser did work, the pipeline has no receipt to record.
- **Provider-side retries.** A provider that retries internally bills once and
  reports once; a client-side retry in `caption_image` bills twice and reports
  twice, correctly.
- **Cached input tokens.** Ops shows cached-read and cache-write tokens when the
  provider proves them. Missing or anomalous cache detail is charged as normal
  input, so the safe failure direction is an overcharge relative to cache cost.
- **B2 egress.** Presigned URLs are fetched by the browser directly; the gateway
  never sees the transfer. Only B2's own reporting has it.
- **Abandoned or post-byte failed calls.** The pre-call row and estimated
  context remain, but a provider failure may not expose final token usage. Real
  provider spend can therefore exceed the ledger; health shows these attempts.
- **Context composition accuracy.** Providers report total input, not the three
  local categories. The estimator includes serialized request framing and is
  useful for trends and window pressure, but the actual-minus-estimated delta
  must remain visible and the categories must not be treated as invoice data.
- **The gateway's in-process SSE notification cap** (100 global / 6 per user) is
  still per-replica and unrelated to the Redis limiter.
- **Reindexing a workspace into a different embedding model.** Not implemented,
  deliberately: see [agentic-retrieval.md](agentic-retrieval.md).
- **Ingest retries.** Each parse attempt with a receipt gets one idempotent page
  charge, including attempts followed by later-stage failure. A retry that hits
  the parse-zip or caption cache is not billed for parse or vision a second
  time; a retry that re-embeds is.
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

The reasoning: the alternative was the most expensive path in the product
(document parsing, captions, embeddings, three summarization passes) running against
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
| `IMPORT_RELAY_ENQUEUE_URL` | gateway | Cloudflare Worker `/enqueue`; empty with the secret disables Drive imports |
| `IMPORT_RELAY_SECRET` | gateway, Drive import Worker | shared HMAC key; set with `wrangler secret`, never as a Worker plain-text variable |
| `API_BASE_URL` / `IMPORT_DLQ_NAME` | Drive import Worker | public gateway origin and the configured dead-letter queue name |
| `SENTRY_DSN_GATEWAY` / `_RETRIEVAL` / `_WORKER` / `_COLLABORATION` | compose | mapped onto each process's `SENTRY_DSN` |
| `SENTRY_DSN_OPS` / `VITE_SENTRY_DSN_OPS` | ops | separate operator-service project; empty disables |
| `OPS_DATABASE_URL` | ops | `evo_ops` read/auth role; routine reads plus execute-only last-seen update |
| `OPS_ADMIN_DATABASE_URL` | ops | lazy `evo_ops_admin` pool; restricted registry writes and reconciliation requests |
| `OPS_CF_ACCESS_ISSUER` / `_AUDIENCE` | ops | required Cloudflare Access verification values |
| `OPS_CF_ACCESS_JWKS_URL` | ops | optional; defaults to `<issuer>/cdn-cgi/access/certs` |
| `OPS_ACCESS_DISABLED` / `OPS_AUTH_DISABLED` | ops | fail-closed defaults; bypass requires explicit unsafe development mode |
| `OPS_UNSAFE_DEVELOPMENT` | ops | allows owner DSNs/auth bypasses only when `APP_ENV=development`; false by default |
