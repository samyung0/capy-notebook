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
| Collaboration Vitest | `pnpm test:collaboration` |
| Cloudflare MinerU relay | `pnpm test:cloudflare-relay` |
| Go server | `pnpm test:go` |
| Python pipeline | `pnpm pipeline:test` / offline: `pnpm pipeline:test:offline` |
| Playwright sharing/API e2e | `pnpm e2e` |
| Playwright editor (MSW) | `pnpm e2e:editor` |
| Playwright editor perf | `pnpm perf` |

---

## Frontend Vitest (`src/`)

### API

| File | About |
| --- | --- |
| [`src/api/client.test.ts`](../src/api/client.test.ts) | Multipart upload client progress reporting and abort via `AbortSignal`. |
| [`src/api/notifications.test.ts`](../src/api/notifications.test.ts) | Reconciles SSE notification cache for re-invites without double-counting. |
| [`src/api/plateAiTransport.test.ts`](../src/api/plateAiTransport.test.ts) | Scopes Plate AI routes to the workspace and strips browser provider credentials. |
| [`src/api/sse.test.ts`](../src/api/sse.test.ts) | Reassembles SSE events that arrive split across response chunks. |

### Materials

| File | About |
| --- | --- |
| [`src/features/materials/document.test.ts`](../src/features/materials/document.test.ts) | Plate material normalize/validate/round-trip, stable IDs, metrics, media/YouTube rules. |
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
| [`src/features/notes/responsiveToolbar.test.ts`](../src/features/notes/responsiveToolbar.test.ts) | Responsive toolbar hides overflow groups right-to-left while keeping persistent ones. |
| [`src/features/notes/richBlockConfig.test.ts`](../src/features/notes/richBlockConfig.test.ts) | Callout variant fallbacks, column layouts, and code-language toolbar labels. |
| [`src/features/notes/stableElementIds.test.ts`](../src/features/notes/stableElementIds.test.ts) | Plugin assigns recursive element IDs before inserted nodes enter the editor. |
| [`src/features/notes/youtube.test.ts`](../src/features/notes/youtube.test.ts) | Accepts watch/short/embed YouTube URLs and rejects malformed non-YouTube ones. |

### Quizzes / workspace

| File | About |
| --- | --- |
| [`src/features/quizzes/QuizForm.test.ts`](../src/features/quizzes/QuizForm.test.ts) | Quiz question validation and round-trip for every supported question type. |
| [`src/features/workspace/access.test.ts`](../src/features/workspace/access.test.ts) | Workspace access helpers for read-only viewers, editors, and owner-only share. |
| [`src/features/workspace/sourceUpload.test.ts`](../src/features/workspace/sourceUpload.test.ts) | Source-upload extension/parser policy from server limits and byte-weighted progress. |

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

## Cloudflare MinerU relay (`cloudflare/mineru-relay/`)

Node’s built-in test runner (`node --test`).

| File | About |
| --- | --- |
| [`cloudflare/mineru-relay/test/index.test.js`](../cloudflare/mineru-relay/test/index.test.js) | Relay auth, host allowlists, oversized/stalled B2 transfers, and streaming upload. |

---

## Go server (`server/`)

### `cmd` / auth / blob / mail / pipeline client

| File | About |
| --- | --- |
| [`server/cmd/api/email_test.go`](../server/cmd/api/email_test.go) | Strong email secret requirements and log backend blocked in production. |
| [`server/internal/auth/middleware_test.go`](../server/internal/auth/middleware_test.go) | Public-read bypass, disabled-auth dev user, and E2E header auth allow/deny. |
| [`server/internal/blob/blob_test.go`](../server/internal/blob/blob_test.go) | B2 client construction/validation and non-positive read-prefix rejection. |
| [`server/internal/mail/capture_test.go`](../server/internal/mail/capture_test.go) | Recording mail sender keeps bounded history and ignores failed deliveries. |
| [`server/internal/mail/mail_test.go`](../server/internal/mail/mail_test.go) | Invite email render/localization, role labels, and unsubscribe tokens. |
| [`server/internal/pipeline/client_test.go`](../server/internal/pipeline/client_test.go) | Pipeline HTTP client success, error status, bad JSON, and connection refused. |
| [`server/internal/sourceupload/rules_test.go`](../server/internal/sourceupload/rules_test.go) | Source kind-from-name map, upload validation, and policy list parsing. |

### HTTP API

| File | About |
| --- | --- |
| [`server/internal/httpapi/account_gates_test.go`](../server/internal/httpapi/account_gates_test.go) | Over-quota owner gates, storage-owner state on reads, editor deck create, generated authorship. |
| [`server/internal/httpapi/ai_plate_test.go`](../server/internal/httpapi/ai_plate_test.go) | Plate command/copilot request validation and AI data-stream copy/malformed/done checks. |
| [`server/internal/httpapi/editor_assets_test.go`](../server/internal/httpapi/editor_assets_test.go) | Editor asset metadata validation, signatures, and object keys not using original filenames. |
| [`server/internal/httpapi/email_unsubscribe_test.go`](../server/internal/httpapi/email_unsubscribe_test.go) | GET unsubscribe is read-only and does not mutate preferences. |
| [`server/internal/httpapi/helpers_test.go`](../server/internal/httpapi/helpers_test.go) | Kind/content-type helpers, random IDs, and quiz question builder defaults/types. |
| [`server/internal/httpapi/huma_collaboration_test.go`](../server/internal/httpapi/huma_collaboration_test.go) | OpenAPI collab contracts, material content decode on read / omit on update, invite/access metadata. |
| [`server/internal/httpapi/huma_limits_test.go`](../server/internal/httpapi/huma_limits_test.go) | Material request body size limit enforcement. |
| [`server/internal/httpapi/share_access_test.go`](../server/internal/httpapi/share_access_test.go) | Share HTTP read/write/clone/explore/attempts and free-owner daily revision caps. |
| [`server/internal/httpapi/sse_notifications_test.go`](../server/internal/httpapi/sse_notifications_test.go) | Notification SSE connection limits are per-user and global. |
| [`server/internal/httpapi/webhooks_test.go`](../server/internal/httpapi/webhooks_test.go) | Clerk and Stripe webhook provisioning, signatures, idempotency, and subscription state. |

### Material documents

| File | About |
| --- | --- |
| [`server/internal/materialdoc/document_test.go`](../server/internal/materialdoc/document_test.go) | Quiz/flashcard round-trips, ID rewrite, JSON escaping, validation, YouTube/diagram, write limits. |

### Store

| File | About |
| --- | --- |
| [`server/internal/store/account_cascade_test.go`](../server/internal/store/account_cascade_test.go) | User delete splits ownership from authorship; chapter refs cannot cross workspaces. |
| [`server/internal/store/blobs_test.go`](../server/internal/store/blobs_test.go) | Blob refcount deletion queue, cancel-on-reference, clone survival, abandoned uploads. |
| [`server/internal/store/collaboration_owner_test.go`](../server/internal/store/collaboration_owner_test.go) | Collab writes follow storage owner; active editors cannot grow over-quota materials. |
| [`server/internal/store/contracts_test.go`](../server/internal/store/contracts_test.go) | Role/share/invite/comment/material JSON contracts and stable card-ID rewrite map. |
| [`server/internal/store/material_revisions_test.go`](../server/internal/store/material_revisions_test.go) | Daily version overwrite, UTC rollover, tier retention, and downgrade pruning. |
| [`server/internal/store/notifications_test.go`](../server/internal/store/notifications_test.go) | Notification recipient scoping, email outbox/leases, and category disable atomicity. |
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
| [`pipeline/tests/test_ai_adapter.py`](../pipeline/tests/test_ai_adapter.py) | Plate AI prompt/context bounding, ignores browser provider knobs, rejects oversized context, JSON fence parsing. |
| [`pipeline/tests/test_helpers.py`](../pipeline/tests/test_helpers.py) | JSON/fence extractors, cognitive levels, SRS shape, graph-name sanitize, config input dir seeding. |
| [`pipeline/tests/test_ingest_query.py`](../pipeline/tests/test_ingest_query.py) | Cassette integration: text/PDF ingest → KG query, plus generate-flashcards JSON (needs Docker Postgres/Redis). |
| [`pipeline/tests/test_mineru_lite.py`](../pipeline/tests/test_mineru_lite.py) | MinerU blob parse relay+retry vs legacy local path without relay. |
| [`pipeline/tests/test_modal_parser.py`](../pipeline/tests/test_modal_parser.py) | Modal parse engine registration, IR/bundle validity, image path rewrite, traversal-safe extract. |

---

## Playwright e2e — sharing / API (`e2e/sharing/`)

Real stack via Docker (`pnpm e2e`). Editor specs are ignored by the root Playwright config.

| File | About |
| --- | --- |
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
| [`e2e/editor/insertions.spec.ts`](../e2e/editor/insertions.spec.ts) | Mentions in heading/paragraph, slash-insert table, and column layout widths. |

---

## Playwright perf (`e2e/perf/`)

MSW + Vite (`pnpm perf`). Budgets are regression tripwires under CPU throttle, not UX targets.

| File | About |
| --- | --- |
| [`e2e/perf/editor.perf.ts`](../e2e/perf/editor.perf.ts) | Open cost, typing latency, save cycle, and scroll FPS for small and near-limit documents. |
| [`e2e/perf/saveCycleProfile.perf.ts`](../e2e/perf/saveCycleProfile.perf.ts) | Opt-in (`PERF_PROFILE=1`) V8 CPU profile of the near-limit save cycle (diagnostic, no budget assert). |

Supporting (not tests): [`e2e/perf/metrics.ts`](../e2e/perf/metrics.ts) instrumentation helpers.

---

## Manual / diagnostic (not in CI suites)

| File | About |
| --- | --- |
| [`modal/test_snapshot.py`](../modal/test_snapshot.py) | Manual script measuring Modal MinerU GPU snapshot cold-boot vs parse latency. |
