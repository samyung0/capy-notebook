---
type: Guide
title: 'Test Catalog'
description: 'Inventory of Vitest, Go, Python, Playwright, and Cloudflare test suites with one-line descriptions.'
tags: [testing, vitest, go, python, playwright, e2e, perf]
---

# Test catalog

One-line descriptions of every automated test file in the repo (excluding build
artifacts under `collaboration/dist` and vendored packages). Run commands are
at the top of each section.

| Suite | Command |
| --- | --- |
| Frontend Vitest | `pnpm test` |
| Ops dashboard Vitest | `pnpm --filter @evo-notes/ops test` |
| Collaboration Vitest | `pnpm test:collaboration` |
| Go server | `pnpm test:go` |
| Python pipeline | `pnpm test:pipeline` / offline: `pnpm test:pipeline:offline` |
| Playwright sharing/API e2e | `pnpm e2e` / serialized: `pnpm e2e:slow` |
| Playwright editor (MSW) | `pnpm e2e:editor` |
| Playwright editor perf | `pnpm perf` |

---

## Frontend Vitest (`src/`, `e2e/perf/`)

### API

| File | About |
| --- | --- |
| [`src/api/client.test.ts`](../src/api/client.test.ts) | Multipart upload client progress/abort, and Huma `llm_credits_exhausted` coded-error parsing. |
| [`src/api/notifications.test.ts`](../src/api/notifications.test.ts) | Reconciles SSE notification cache for re-invites without double-counting. |
| [`src/api/plateAiTransport.test.ts`](../src/api/plateAiTransport.test.ts) | Scopes Plate AI routes to the workspace and strips browser provider credentials. |
| [`src/api/sse.test.ts`](../src/api/sse.test.ts) | Reassembles SSE events that arrive split across response chunks. |
| [`src/lib/errors.test.ts`](../src/lib/errors.test.ts) | Normalizes API, network, cancellation, quota, file-cap, credits, ingest-lease, BYOK key, and chunk-load failures into safe UI error kinds and actions. |
| [`src/lib/onedrivePicker.test.ts`](../src/lib/onedrivePicker.test.ts) | OneDrive picker host from `/me/drive`, personal vs work scopes, `event.origin` allowlist, pick payload to import `fileIds`/`driveIds`, tenant-consent vs user-cancel mapping, and Google Picker env fail-closed. |
| [`src/mocks/scenarios.test.ts`](../src/mocks/scenarios.test.ts) | Validates unique development error scenarios, runtime-handler mappings, and Huma coded error envelopes. |

### Lib

| File | About |
| --- | --- |
| [`src/lib/analytics.test.ts`](../src/lib/analytics.test.ts) | Closed `AnalyticsEvent` union exhaustiveness, size/duration/score/card buckets, parameterized pageview paths, clone/study source, ingest once-per-file, and quota-only `quota_blocked` props. |

### Materials

| File | About |
| --- | --- |
| [`src/features/materials/document.test.ts`](../src/features/materials/document.test.ts) | Plate material normalize/validate/round-trip, stable IDs, metrics, media/YouTube rules, and rejection of `fill`. |
| [`src/features/materials/openItem.test.ts`](../src/features/materials/openItem.test.ts) | Workspace-open search keeps a valid material `mode` and drops it for files / in-workspace navigation. |
| [`src/features/materials/heavyDocument.test.ts`](../src/features/materials/heavyDocument.test.ts) | When heavy documents show an interstitial vs open immediately (render vs write caps). |
| [`src/features/materials/modePolicy.test.ts`](../src/features/materials/modePolicy.test.ts) | View/comment/edit mode allowed by role, including quiz/flashcard defaults. |
| [`src/features/materials/staticNodeComponents.test.tsx`](../src/features/materials/staticNodeComponents.test.tsx) | Read-only static renderers for study blocks, quizzes, flashcards, and unsafe links. |

### Notes / editor

| File | About |
| --- | --- |
| [`src/features/notes/Collaboration.test.ts`](../src/features/notes/Collaboration.test.ts) | Relative comment decorations stay on the selected text after concurrent inserts. |
| [`src/features/notes/documentStats.test.ts`](../src/features/notes/documentStats.test.ts) | Document-stats UI visibility thresholds and saved-size kilobyte formatting. |
| [`src/features/notes/editorCommands.test.ts`](../src/features/notes/editorCommands.test.ts) | Insertion command catalog covers headings, lists, columns, and inline equations. |
| [`src/features/notes/editorMode.test.ts`](../src/features/notes/editorMode.test.ts) | Comment-mode mutation gates, content-only share editors, and status labels. |
| [`src/features/notes/editorTransforms.test.ts`](../src/features/notes/editorTransforms.test.ts) | Code-block toggle/paste/highlight behavior and clear-formatting mark stripping. |
| [`src/features/notes/insertEditorNode.test.ts`](../src/features/notes/insertEditorNode.test.ts) | Inline vs block insert preserves or replaces the current paragraph correctly. |
| [`src/features/notes/linkEditor.test.ts`](../src/features/notes/linkEditor.test.ts) | Link upsert restores the captured selection range before applying the link. |
| [`src/features/notes/media.test.ts`](../src/features/notes/media.test.ts) | Media classification, persistent asset metadata, and upload-purpose rules (no video uploads). |
| [`src/features/notes/noteEditorPrefs.test.ts`](../src/features/notes/noteEditorPrefs.test.ts) | Toolbar command preference ordering and default hidden groups. |
| [`src/features/notes/responsiveToolbar.test.ts`](../src/features/notes/responsiveToolbar.test.ts) | Responsive toolbar hides overflow groups right-to-left, stopping as soon as the rest fits. |
| [`src/features/notes/richBlockConfig.test.ts`](../src/features/notes/richBlockConfig.test.ts) | Callout variant fallbacks, column layouts, and code-language toolbar labels. |
| [`src/features/notes/stableElementIds.test.ts`](../src/features/notes/stableElementIds.test.ts) | Plugin assigns recursive element IDs before inserted nodes enter the editor. |
| [`src/features/notes/tocHeadings.test.ts`](../src/features/notes/tocHeadings.test.ts) | Incremental heading scan: nested paths, stable array identity for unrelated edits, and path recomputation after insert/remove. |
| [`src/features/notes/youtube.test.ts`](../src/features/notes/youtube.test.ts) | Accepts watch/short/embed YouTube URLs and rejects malformed non-YouTube ones. |

### Performance snapshots

| File | About |
| --- | --- |
| [`e2e/perf/snapshot.test.ts`](../e2e/perf/snapshot.test.ts) | First-run reports, warn-only same-workflow deltas, CPU-model warnings, and exclusion of noisy context metrics from relative comparison. |

### Quizzes / workspace

| File | About |
| --- | --- |
| [`src/features/quizzes/QuizForm.test.ts`](../src/features/quizzes/QuizForm.test.ts) | Quiz question validation and round-trip for every supported question type, including open. |
| [`src/features/quizzes/grade.test.ts`](../src/features/quizzes/grade.test.ts) | Points default to 1, half-points snap, closed questions are all-or-nothing, open awards scale by question points. |
| [`src/features/quizzes/judge.test.ts`](../src/features/quizzes/judge.test.ts) | Open-answer judge prompt includes rubrics; parse snaps 0 / 0.5 / 1; blank answers skip the model. |
| [`src/features/files/fileUtils.test.ts`](../src/features/files/fileUtils.test.ts) | `fileIsIngesting` treats pending and processing as in-flight, ready/failed as idle. |
| [`src/features/dashboard/recentItems.test.ts`](../src/features/dashboard/recentItems.test.ts) | Merges files and materials by created time and caps the dashboard recent list. |
| [`src/features/workspace/access.test.ts`](../src/features/workspace/access.test.ts) | Workspace access helpers for read-only viewers, editors, and owner-only share. |
| [`src/features/workspace/useChatStream.test.ts`](../src/features/workspace/useChatStream.test.ts) | Citation SSE versions apply only when the new version is greater or equal. |
| [`src/features/workspace/generateTitle.test.ts`](../src/features/workspace/generateTitle.test.ts) | Numbered generate-file defaults skip taken names; empty/overlong/duplicate titles are rejected. |
| [`src/features/workspace/sourceUpload.test.ts`](../src/features/workspace/sourceUpload.test.ts) | Source-upload extension/parser policy from server limits (10 MB mock cap), image-caption availability per mode, byte-weighted progress, picker cap at workspace room (not the per-request 20), ingest-wave split, chunking, beforeunload only while unsent, concurrency pool, and 429 backoff. |
| [`src/features/settings/settingsSearch.test.ts`](../src/features/settings/settingsSearch.test.ts) | Settings `?tab=` keeps general/llm/subscription and defaults anything else to general. |
| [`src/features/settings/llmOptions.test.ts`](../src/features/settings/llmOptions.test.ts) | Model dropdown sort (available first, locked last), empty stored prefs resolving to catalog `off`, invalid stored effort using catalog `defaultEffort`, and no invented effort when `defaultEffort` is missing. |
| [`src/features/billing/format.test.ts`](../src/features/billing/format.test.ts) | Storage/credit formatters and reserved spend counting toward the usage meter. |

---

## Ops dashboard Vitest (`ops/src/`)

| File | About |
| --- | --- |
| [`ops/src/api.test.ts`](../ops/src/api.test.ts) | Clerk bearer headers, missing-session refusal, response-schema rejection, and empty real-data collections. |
| [`ops/src/registry-domain.test.ts`](../ops/src/registry-domain.test.ts) | Active registry assembly, default/deprecation checks, embedding acknowledgement, and immutable draft state. |

---

## Collaboration Vitest (`collaboration/src/`)

| File | About |
| --- | --- |
| [`collaboration/src/auth.test.ts`](../collaboration/src/auth.test.ts) | Room token mint/verify: claims, expiry, access, signatures, and allowed origins. |
| [`collaboration/src/commands.test.ts`](../collaboration/src/commands.test.ts) | Headless block replace by stable ID and stale-precondition rejection. |
| [`collaboration/src/config.test.ts`](../collaboration/src/config.test.ts) | Config defaults, comma-separated origins parsing, and empty-origins rejection. |
| [`collaboration/src/limits.test.ts`](../collaboration/src/limits.test.ts) | Document size/depth measurement, over-limit recovery edits, and inbound update gates. |
| [`collaboration/src/provider-compat.test.ts`](../collaboration/src/provider-compat.test.ts) | Hocuspocus v3 provider ↔ v4 server converge writes and reject commenter updates. |

---

## Go server (`server/`)

### `cmd` / auth / blob / mail / pipeline client

| File | About |
| --- | --- |
| [`server/cmd/api/email_test.go`](../server/cmd/api/email_test.go) | Strong email secret requirements and log backend blocked in production. |
| [`server/internal/auth/middleware_test.go`](../server/internal/auth/middleware_test.go) | Public-read bypass, disabled-auth dev user, and E2E header auth allow/deny. |
| [`server/internal/blob/blob_test.go`](../server/internal/blob/blob_test.go) | B2 client construction/validation and non-positive read-prefix rejection. |
| [`server/internal/mail/capture_test.go`](../server/internal/mail/capture_test.go) | Recording mail sender keeps bounded history and ignores failed deliveries. |
| [`server/internal/mail/mail_test.go`](../server/internal/mail/mail_test.go) | Invite and model-deprecated email render/localization, role labels, and unsubscribe tokens. |
| [`server/internal/pipeline/client_test.go`](../server/internal/pipeline/client_test.go) | Pipeline HTTP client success, `X-Pipeline-Secret` header, error status, `{code}` / `{detail:{code}}` decode, bad JSON, and connection refused. |
| [`server/internal/ratelimit/classify_test.go`](../server/internal/ratelimit/classify_test.go) | Route class split (AI vs editor vs upload vs exempt), `/quiz-grade` as AI, and default AI/burst/editor budgets. |
| [`server/internal/copytext/copytext_test.go`](../server/internal/copytext/copytext_test.go) | Locale-aware server copy for user/deck/note/quiz titles; unknown locale uses English. |
| [`server/internal/sourceupload/rules_test.go`](../server/internal/sourceupload/rules_test.go) | Source kind-from-name map, upload validation (10/30 MB plan caps), unknown parse modes including retired `accurate`, caption-flag normalization, and policy list parsing. |
| [`server/internal/integrations/oauth_test.go`](../server/internal/integrations/oauth_test.go) | Graph item URL uses `/me/drive` or `/drives/{id}`, and import `driveIds` must match `fileIds`. |
| [`server/internal/models/registry_test.go`](../server/internal/models/registry_test.go) | Load-on-miss of an unseen `(key, version)`, a miss that never degrades to the current default, ResolveUser requiring a non-empty enabled preference, `EmbeddingDim` rejecting a config that declares no width, one default per surface, embedding rows refusing disable/delete/surface-strip/identity rewrite while a new same-width embedding row can insert and chat rows can still retarget or disable, BYOK availability routing, thinking/effort falling back to catalog `defaultEffort` only, empty `efforts` / missing `defaultEffort` not inventing a value, a missing reasoning block staying `off`, `ValidateCatalogReasoning` matching the SQL check, and Postgres refusing a chat row without reasoning or with `defaultEffort` outside `efforts`. |
| [`server/internal/ops/access_test.go`](../server/internal/ops/access_test.go) | Cloudflare Access signature, issuer, audience, expiry, JWKS, and health-only middleware bypass. |
| [`server/internal/ops/config_test.go`](../server/internal/ops/config_test.go) | Ops authentication stays fail closed by default; bypass and owner-DSN mode require an explicit development-only unsafe opt-in. |
| [`server/internal/ops/http_test.go`](../server/internal/ops/http_test.go) | Viewer registry-write refusal before writer lookup, no-store/noindex headers, stale-save snapshots, and safe Postgres registry validation errors. |
| [`server/internal/ops/privileges_test.go`](../server/internal/ops/privileges_test.go) | Exact production read/auth/registry login grants pass startup contracts; the registry role completes Save while DELETE and customer-content reads fail. |
| [`server/internal/ops/read_store_test.go`](../server/internal/ops/read_store_test.go) | Overview, indexed usage-health anti-join, bounded user search/workspaces, user detail, and cost queries execute against production schema; account-locked operators are denied while over-quota operators remain allowed. |
| [`server/internal/ops/registry_test.go`](../server/internal/ops/registry_test.go) | Serializable version insertion/old disable without preference drift across chat/generate/editor/quiz, all-surface deprecation remap and exact idempotent notices, stale snapshots, defaults, aliases, database error mapping, embedding immutability, allowlist/table validation, endpoint-only moves, and acknowledged default retarget to a pre-shipped same-width row. |

### HTTP API

| File | About |
| --- | --- |
| [`server/internal/httpapi/account_gates_test.go`](../server/internal/httpapi/account_gates_test.go) | Over-quota owner gates, storage-owner state on reads, editor deck create, generated authorship and title uniqueness through a stub retrieval service. |
| [`server/internal/httpapi/billing_gates_test.go`](../server/internal/httpapi/billing_gates_test.go) | 403 `llm_credits_exhausted` on chat/generate/editor; client `model` ignored and the assistant message is stamped; upload actor-credits vs owner-storage; `GET /api/me/ingest-slots` is per actor. |
| [`server/internal/httpapi/ai_plate_test.go`](../server/internal/httpapi/ai_plate_test.go) | Plate command/copilot request validation and AI data-stream copy/malformed/done checks. |
| [`server/internal/httpapi/editor_assets_test.go`](../server/internal/httpapi/editor_assets_test.go) | Editor asset metadata validation, signatures, and object keys not using original filenames. |
| [`server/internal/httpapi/email_unsubscribe_test.go`](../server/internal/httpapi/email_unsubscribe_test.go) | GET unsubscribe is read-only and does not mutate preferences. |
| [`server/internal/httpapi/internal_materials_test.go`](../server/internal/httpapi/internal_materials_test.go) | Internal material tools still run after inference exhaustion, POST lookup-before-create replay, same-id payload mismatch 409, concurrent same-id convergence, and GET requiring workspace/actor with a 404 on workspace mismatch. |
| [`server/internal/httpapi/provider_calls_test.go`](../server/internal/httpapi/provider_calls_test.go) | Internal provider-call settlement requires the pipeline secret, deduplicates identical callback retries, and rejects a call id replayed with different usage. |
| [`server/internal/httpapi/helpers_test.go`](../server/internal/httpapi/helpers_test.go) | Kind/content-type helpers, random IDs, account-locale fallback, generate title trimming, query embeddings settling 0 credits (BYOK and platform) without inventing default embed or Flash rates, empty paidBy staying empty, resolveEmbedding failing closed without a store, nil-pipe and premature-EOF chat errors instead of invented completion, and `ErrTooManyIngestLeases` mapping to 429 `too_many_ingest_leases`. |
| [`server/internal/httpapi/llm_credentials_test.go`](../server/internal/httpapi/llm_credentials_test.go) | Pipeline 400 bodies map `invalid_key` / `key_failed` onto store errors, including FastAPI `{detail:{code}}` wrappers, and 502 `generate_empty` maps onto a distinct persist-nothing error. |
| [`server/internal/httpapi/pipeline_unavailable_test.go`](../server/internal/httpapi/pipeline_unavailable_test.go) | Chat and generate fail with `ai_unavailable` when the retrieval client is missing or the handshake returns a non-key HTTP error, and never stream the old placeholder. Empty quiz/deck/mermaid payloads and a pipeline `generate_empty` body are 502, not persisted stubs. |
| [`server/internal/httpapi/huma_collaboration_test.go`](../server/internal/httpapi/huma_collaboration_test.go) | OpenAPI collab contracts, material content decode on read / omit on update, invite/access metadata. |
| [`server/internal/httpapi/huma_limits_test.go`](../server/internal/httpapi/huma_limits_test.go) | Material request body size limit enforcement. |
| [`server/internal/httpapi/huma_validation_test.go`](../server/internal/httpapi/huma_validation_test.go) | Huma 422s for empty/overlong names, >5 workspace tags, owner invite role, empty cards, invalid attempts, generate missing kind/count/levels, count 0, invalid level, missing material kind, and discussion omit/0 `anchorVersion`. |
| [`server/internal/httpapi/fail_closed_test.go`](../server/internal/httpapi/fail_closed_test.go) | Generate unknown file/chapter IDs are 400; missing tag `kind` and models `surface` return empty lists; `listModels` resolves empty stored reasoning to `off` with empty effort; the declared Huma defaults (`types`, `detail`, `diagramType`) reach the pipeline body, while an explicitly empty `types` list is a 422 rather than a silent refill. |
| [`server/internal/httpapi/share_access_test.go`](../server/internal/httpapi/share_access_test.go) | Share HTTP read/write/clone/explore/attempts and free-owner daily revision caps. |
| [`server/internal/httpapi/sse_notifications_test.go`](../server/internal/httpapi/sse_notifications_test.go) | Notification SSE connection limits are per-user and global. |
| [`server/internal/httpapi/webhooks_test.go`](../server/internal/httpapi/webhooks_test.go) | Clerk and Stripe webhook provisioning, signatures, idempotency, and subscription state. |

### Material documents

| File | About |
| --- | --- |
| [`server/internal/materialdoc/document_test.go`](../server/internal/materialdoc/document_test.go) | Quiz/flashcard round-trips including open questions and points, ID rewrite, JSON escaping, validation (including rejection of `fill`), YouTube/diagram, write limits, and generator replay comparing extracted note/mermaid payload rather than reminted block ids. |

### Store

| File | About |
| --- | --- |
| [`server/internal/store/account_cascade_test.go`](../server/internal/store/account_cascade_test.go) | User delete splits ownership from authorship; chapter refs cannot cross workspaces. |
| [`server/internal/store/blobs_test.go`](../server/internal/store/blobs_test.go) | Blob refcount deletion queue (source paths), caption cache surviving file delete, cancel-on-reference, clone survival, abandoned uploads. |
| [`server/internal/store/files_cap_test.go`](../server/internal/store/files_cap_test.go) | Per-workspace 100-file cap, pending upload sessions occupying slots, expired sessions not occupying slots, per-request batch cap of 20, `filesLimit` on the workspace payload. |
| [`server/internal/store/collaboration_owner_test.go`](../server/internal/store/collaboration_owner_test.go) | Collab writes follow storage owner; active editors cannot grow over-quota materials. |
| [`server/internal/store/contracts_test.go`](../server/internal/store/contracts_test.go) | Role/share/invite/comment/material JSON contracts and stable card-ID rewrite map. |
| [`server/internal/store/credits_test.go`](../server/internal/store/credits_test.go) | Credit begin/settle, settle idempotency, per-call chat settlement dedupe, exhaustion response, zero-credit query embeddings, one terminal overspend call, late receipts after turn closure without continuation, BYOK past the platform limit, concurrent LLM lease cap, ingest leases, monthly rollover, billing counters, and actor-scoped usage grouping. |
| [`server/internal/store/chat_pin_test.go`](../server/internal/store/chat_pin_test.go) | Assistant message pin survives finalize; ingest job payload carries actor + ingest/vision pins and refuses to build without either an actor or a registry; a clone inherits the source workspace's embedding pin; CreateWorkspace snapshots the live embedding default and embedding rates stay on the workspace pin after a retarget; EmbeddingRates fails closed on an empty or unknown pin; empty chat/generate/editor/quiz prefs rejected; browser quiz keys store without a registry row; new users get registry defaults; locked BYOK keys are rejected; reasoning prefs are stored per model so DeepSeek rejects `medium` and switching to Pro does not inherit Flash's effort. |
| [`server/internal/store/llm_credentials_test.go`](../server/internal/store/llm_credentials_test.go) | Credential key parse accepts hex/base64 only (raw 32-byte ASCII rejected), AES-GCM encrypt/decrypt round trip, and account purge deleting `user_llm_credentials`. |
| [`server/internal/store/pricing_test.go`](../server/internal/store/pricing_test.go) | Same token counts on two models produce different credit micros; RatesFromConfig and CreditsForTokens keep zeros; proven cache reads discount at the cached-read rate; invalid cache counts charge full input; EmbeddingRates fails without a registry. |
| [`server/internal/store/material_revisions_test.go`](../server/internal/store/material_revisions_test.go) | Daily version overwrite, UTC rollover, tier retention, and downgrade pruning. |
| [`server/internal/store/notifications_test.go`](../server/internal/store/notifications_test.go) | Notification recipient scoping, email outbox/leases, and category disable atomicity. |
| [`server/internal/store/schedule_scope_test.go`](../server/internal/store/schedule_scope_test.go) | Label/task/event patches and deletes only touch the caller's own rows; label delete unlinks its events. |
| [`server/internal/store/share_access_test.go`](../server/internal/store/share_access_test.go) | Workspace/material access matrices, parent-share inheritance, flashcard search via materials. |
| [`server/internal/store/share_test.go`](../server/internal/store/share_test.go) | Card-ID rewrite on share/clone and clone retention using the target owner’s tier. |
| [`server/internal/store/subscriptions_test.go`](../server/internal/store/subscriptions_test.go) | Plan projection, stale webhook protection, past-due, Stripe reconcile, lapsed over-quota freeze. |
| [`server/internal/store/workspace_sharing_test.go`](../server/internal/store/workspace_sharing_test.go) | Default invite role, membership∪share access, invites/expiry, notifications, comment reply depth. |
| [`server/internal/store/workspace_transfer_test.go`](../server/internal/store/workspace_transfer_test.go) | Workspace transfer moves ownership/storage bill, refuses unaffordable recipients, covers owner columns. |

---

## Python pipeline (`pipeline/tests/`)

See also [`pipeline-tests.md`](pipeline-tests.md) for disposable Postgres/Redis cassette setup.

| File | About |
| --- | --- |
| [`pipeline/tests/test_ai_adapter.py`](../pipeline/tests/test_ai_adapter.py) | Plate AI prompt/context bounding, ignores browser provider knobs, rejects oversized context, JSON fence parsing, and generate/comment omit an output token cap. |
| [`pipeline/tests/test_chunking.py`](../pipeline/tests/test_chunking.py) | Heading breadcrumbs, page/bbox regions, table/equation/figure handling, `chart` blocks indexed like images via `chart_caption`, page furniture dropped silently while unrecognised block types are logged, oversized-block splitting, CJK bigram tokenizer, CJK-aware token estimate, malformed bbox coordinates skipped rather than crashing the job. |
| [`pipeline/tests/test_generate.py`](../pipeline/tests/test_generate.py) | Cassette: even scope coverage, file filtering, and flashcard/quiz JSON surviving into the runner shape. |
| [`pipeline/tests/test_agent.py`](../pipeline/tests/test_agent.py) | Offline: live streamed blocks, prime + answer, narration then answer, concurrent reads, serial mutations, tool caps, uncapped search-embedding and completion telemetry, cumulative input not stripping tools, exhausted-credit tool execution followed by one terminal call, checkpoint rewrite, citations, sanitized errors, and deterministic material retries. |
| [`pipeline/tests/test_call_accounting.py`](../pipeline/tests/test_call_accounting.py) | Offline: provider settlement retries reuse one call id, propagate cache usage, return exhausted and terminal-call state, and stay inactive outside chat. |
| [`pipeline/tests/test_ingest_query.py`](../pipeline/tests/test_ingest_query.py) | Cassette: index → search → grounded cited answer, re-index convergence, scope confinement, cross-document concepts, cascade teardown. |
| [`pipeline/tests/test_figures.py`](../pipeline/tests/test_figures.py) | Offline: line diagrams surviving the flatness filters, recurring page furniture dropped by perceptual hash, bbox and duplicate handling, `chart` blocks selected and labelled from `chart_caption`, caption cache keyed by `source_sha256` (not parse route or blob path), prompt carrying the page but not the uploader's file name, and the context preamble present only when there is context to introduce. |
| [`pipeline/tests/test_ingest_worker.py`](../pipeline/tests/test_ingest_worker.py) | Offline: parse-mode → route selection (`fast` only; retired `accurate`/`advanced` are terminal), txt/md/json bypassing the parser, parse zip recorded before captioning, captions reaching the chunker, the source hash coming from the bytes rather than the uploader-settable checksum header, missing model pins failing terminally, a database error during pin read propagating as retryable, a missing ingest payload field or blank job type failing terminally, a full GPU queue putting the job back without spending an attempt (workspace embedding pin stubbed so donor lookup stays off Postgres), and text kinds not taking a parse slot. |
| [`pipeline/tests/test_parse_slots.py`](../pipeline/tests/test_parse_slots.py) | Offline: Redis-down fail-open on parse-slot acquire, and default cap matching 12×6 fast. |
| [`pipeline/tests/test_pool_shutdown.py`](../pipeline/tests/test_pool_shutdown.py) | Offline: ProcessPoolExecutor close terminates a stuck worker and joins the manager thread (the Modal Thread-2 hang). |
| [`pipeline/tests/test_modal_parser.py`](../pipeline/tests/test_modal_parser.py) | Artifact addressing/caching keyed by source sha256, endpoint and version, unknown *and missing* parse routes rejected rather than read as `fast`, rejection of traversal, checksum, version and source mismatches, corrupt-cache recovery, and empty env treated as unset. |
| [`pipeline/tests/test_marker_adapt.py`](../pipeline/tests/test_marker_adapt.py) | Marker JSON → content_list (heading depth, bbox scale including RapidOCR numpy polygons, skip running headers, figure crops), scan-vs-figure probe, image-object bounds, dropping full-page scan rasters, RapidOCR merge skipping duplicate lines, `txt` parse skipping the OCR lane. |
| [`pipeline/tests/test_quiz_grade.py`](../pipeline/tests/test_quiz_grade.py) | Offline: open-answer judge prompt includes rubrics; parse snaps 0 / 0.5 / 1. |
| [`pipeline/tests/test_registry_billing.py`](../pipeline/tests/test_registry_billing.py) | Per-model credits including cached-read discounts, embedding rows ignore the cached-read rate, zeros stay zeros with no `or 50` fill, registry miss never falls back, no surface (chat, generate, editor, quiz, ingest, embedding, vision) resolves its own default in place of a pin, ingest job pins stick after a default change, claim-time owner/actor matrix including a job with no actor, ingest bills the actor and settles the reservation, a terminal fail releases the reservation. |
| [`pipeline/tests/test_provider_byok.py`](../pipeline/tests/test_provider_byok.py) | Unknown slugs never fall through to DeepSeek env, user-key rows require a request secret, `paid_by=user` without a decryptable key does not use the platform DeepSeek key, platform and embedding rows ignore a bound user key, embedding credentials follow the embedding env rather than provider slug, client cache distinguishes full secrets, hidden provider retries are disabled, Anthropic version header, input budget follows the catalog window, OpenAI reasoning kwargs, GPT tool calls force `reasoning_effort=none`, quiz grade stays at 80 tokens, `reasoning=False` disables thinking even when the catalog cannot, OpenAI mode-on with no catalog efforts raises, empty request effort uses the catalog default, Anthropic budget mode-on with no effort or an unmapped effort raises, `xhigh`/`max` map to 32768/65536, and BYOK provider errors classify as `invalid_key` or `key_failed`. |
| [`pipeline/tests/test_compact.py`](../pipeline/tests/test_compact.py) | Short history stays intact, tool groups stay joined, compact triggers at 90% of the pinned input budget, tool schemas reserve input space, compaction and checkpoint model requests are themselves bounded, OpenAI live replay is protected when possible, checkpoint summaries retain source refs, and terminal preparation clips without another model call. |
| [`pipeline/tests/test_stream_assembly.py`](../pipeline/tests/test_stream_assembly.py) | Offline: Chat Completions partial tool arguments and multi-call assembly; OpenAI Responses encrypted reasoning request/replay, item-id dedupe, no synthesized message item, incomplete/failed status, and terminal usage. |
| [`pipeline/tests/test_usage_extract.py`](../pipeline/tests/test_usage_extract.py) | Offline: DeepSeek and OpenAI inclusive cache reads discount; missing, oversized, or unproven cache shapes charge full input. |
| [`pipeline/tests/test_credentials.py`](../pipeline/tests/test_credentials.py) | Credential key parse accepts hex/base64 only, AES-GCM decrypt round-trips, and inbound retrieval rejects a missing or mismatched `X-Pipeline-Secret`. |
| [`pipeline/tests/test_retrieval_helpers.py`](../pipeline/tests/test_retrieval_helpers.py) | Tool scope narrowing, stable citation numbering, per-file diversity cap, JSON extraction and question normalization (legacy `difficulty` dropped, not mapped), empty generate replies rejected instead of stubbed, two-tier file summaries retrying instead of storing a permanent blank, summary/concept prompts excluding the uploader's file name, and Qwen3 query-embed instruct prefix (workspace pin only; lexical terms stay raw). |
| [`pipeline/tests/test_locale.py`](../pipeline/tests/test_locale.py) | Account locale on chat/generate/editor prompts; continue-writing does not force UI language; ingest is out of scope. |
| [`pipeline/tests/test_jobs.py`](../pipeline/tests/test_jobs.py) | Retryable vs terminal errors, capacity-wait is not a failure, backoff, missing/unknown job types are terminal, and per-type attempt budget. |
| [`pipeline/tests/test_store_sql.py`](../pipeline/tests/test_store_sql.py) | Docker (no model calls): hybrid search halves, CJK recall, scoping, canonical duplicate ownership/deletion, concept co-mention, two-tier content summaries on the workspace outline, cascades, job `not_before`/requeue/lease reclaim, capacity yield not spending an attempt, only the claiming attempt writing its outcome, content-claim ownership (a waiter cannot refresh or drop the creator's claim, and never returns a claim it does not own), steal refused while the owner job's lease is live and allowed once it expires or the job is done, `replace_content_chunks` raising when the claim moved, finishing a deleted file leaving the job `done` with no notification, donor copy across workspaces, donor copy without vectors when pins differ, donor lookup prefers a matching embedding pin over a newer mismatch, artifact GC skips in-flight jobs. |
| [`pipeline/tests/test_model_configs_lock.py`](../pipeline/tests/test_model_configs_lock.py) | Docker: Python's vector-table allowlist matches the canonical Go package; embedding rows refuse disable, delete, surface-strip, identity rewrite, and a disabled insert; a new same-width row can insert and move `base_url` but cannot steal the default; chat rows can still retarget or disable; credit-rate and reasoning constraints stay locked. |

---

## Playwright e2e — real stack (`e2e/errors/`, `e2e/sharing/`)

Real stack via Docker (`pnpm e2e`). Editor specs are ignored by the root Playwright config.

The four local workers open up to eight Chromium contexts against one Vite dev
server and the Dockerized API. On a machine that cannot absorb that, API
responses stretch to several seconds and the editor takes tens of seconds to
reach `Synced`, so budgets calibrated for a healthy host expire — the collab and
material-mode specs fail even though the flows complete. Use `pnpm e2e:slow`
(one worker) there; it is a host-capacity workaround, not a fix for a flaky spec.

| File | About |
| --- | --- |
| [`e2e/errors/error-surfaces.spec.ts`](../e2e/errors/error-surfaces.spec.ts) | Primary workspace failure, non-disclosing public 401/404 responses, and browser-offline status surfaces. |
| [`e2e/sharing/deck-sharing.spec.ts`](../e2e/sharing/deck-sharing.spec.ts) | Deck privacy/link/public visibility, Explore listing, clone, and non-member mutation denial. |
| [`e2e/sharing/live-collaboration.spec.ts`](../e2e/sharing/live-collaboration.spec.ts) | Two live editors converge, show remote selections, and project to static view. |
| [`e2e/sharing/material-modes.spec.ts`](../e2e/sharing/material-modes.spec.ts) | Shared material view/comment/edit modes, anonymous static, room tokens, and comment APIs. |
| [`e2e/sharing/quiz-sharing.spec.ts`](../e2e/sharing/quiz-sharing.spec.ts) | Quiz privacy/link/public, Explore, clone, and attempt auth gates. |
| [`e2e/sharing/workspace-membership.spec.ts`](../e2e/sharing/workspace-membership.spec.ts) | Private exact-identifier workspace invite is visible only to its recipient. |
| [`e2e/sharing/workspace-sharing.spec.ts`](../e2e/sharing/workspace-sharing.spec.ts) | Workspace privacy roles, Explore, clone, material-only writes, role raise, mention redaction. |

---

## Playwright e2e — editor feature matrix (`e2e/editor/`)

MSW + Vite only (`pnpm e2e:editor`); no Docker.

| File | About |
| --- | --- |
| [`e2e/editor/block-interactions.spec.ts`](../e2e/editor/block-interactions.spec.ts) | Drag-handle select, context menu duplicate/delete/turn-into, select-all escalate, reorder. |
| [`e2e/editor/formatting.spec.ts`](../e2e/editor/formatting.spec.ts) | Bold apply and clear-formatting for single and stacked marks. |
| [`e2e/editor/insertions.spec.ts`](../e2e/editor/insertions.spec.ts) | Mentions in heading/paragraph, slash-insert table, toolbar table menu, table of contents following a retitle, and column layout widths. |
| [`e2e/editor/toolbar.spec.ts`](../e2e/editor/toolbar.spec.ts) | The all-blocks menu stays painted and hit-testable from 1280px down to 420px, where every other toolbar group is gone. |

---

## Playwright perf (`e2e/perf/`)

MSW + Vite (`pnpm perf`). 6 cases total: 4 budget specs always run; 2 diagnostic V8 profiles are skipped unless `PERF_PROFILE=1`. Budgets are regression tripwires under CPU throttle, not UX targets. How to run the suite, what the GHA snapshot compare does, and why deltas stay warn-only: [editor-perf.md](editor-perf.md).

| File | About |
| --- | --- |
| [`e2e/perf/editor.perf.ts`](../e2e/perf/editor.perf.ts) | 4 cases: open cost (near-limit), typing latency (small), typing + save cycle (near-limit), scroll FPS (near-limit). |
| [`e2e/perf/saveCycleProfile.perf.ts`](../e2e/perf/saveCycleProfile.perf.ts) | 1 case, opt-in (`PERF_PROFILE=1`): V8 CPU profile of the near-limit save cycle (diagnostic, no budget assert). |
| [`e2e/perf/typingProfile.perf.ts`](../e2e/perf/typingProfile.perf.ts) | 1 case, opt-in (`PERF_PROFILE=1`): V8 CPU profile of idle, heading typing, and body typing with per-suspect attribution (diagnostic, no budget assert). |

Supporting (not tests): [`e2e/perf/metrics.ts`](../e2e/perf/metrics.ts) instrumentation and per-case snapshot output,
[`e2e/perf/snapshot.ts`](../e2e/perf/snapshot.ts) typed assembly/comparison,
[`e2e/perf/compare-cli.ts`](../e2e/perf/compare-cli.ts) workflow adapter, and
[`e2e/perf/cpuProfile.ts`](../e2e/perf/cpuProfile.ts) profile capture/attribution shared by the two diagnostics.

---

## Manual / diagnostic (not in CI suites)

| File | About |
| --- | --- |
| [`modal/test_snapshot.py`](../modal/test_snapshot.py) | Manual script measuring Modal CPU memory-snapshot cold-boot vs parse latency on `evo-mineru-fast`. |
| [`pipeline/tests/test_marker_worker_ocr.py`](../pipeline/tests/test_marker_worker_ocr.py) | Lazy RapidOCR: first scan page loads one local engine, later pages reuse it (no ONNX). |
| [`modal/bench_mixed_lanes.py`](../modal/bench_mixed_lanes.py) | Manual mixed-lane load: 6 digital lecture parses + 2 OCR jobs of lecture+newspaper glued together; checks the combined bundle kept slide text and recovered scan lines. |
