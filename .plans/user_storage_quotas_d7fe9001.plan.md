---
name: User storage quotas
overview: Add owner-based logical storage accounting with 100 MiB free and 1 GiB pro limits. Use a separate counter table, an insert-only delta ledger, and upload reservations for race-safe creation gates, plus daily reconciliation. Bound edit-driven growth with a per-material size/shape cap, Yjs state compaction, and the existing revision retention. Remove the team tier and video uploads.
todos:
  - id: schema-accounting
    content: Add ownership, byte-size, counter table, delta ledger, reservation, and trigger schema
    status: completed
  - id: tier-cleanup
    content: Remove the team tier everywhere and set free/pro limits with MiB logic and MB display
    status: completed
  - id: enforce-writes
    content: Gate all file, asset, material, generation, import, and clone creation paths transactionally
    status: completed
  - id: bound-material-growth
    content: Enforce a 2 MiB per-material cap with node count and depth limits on every save
    status: completed
  - id: yjs-compaction
    content: Add idle Yjs state compaction with a dynamic room schema epoch
    status: completed
  - id: video-to-youtube
    content: Remove video uploads and replace them with a YouTube embed tab
    status: completed
  - id: reconcile-api-ui
    content: Add daily reconciliation, billing usage API, generated clients, and quota UX
    status: completed
  - id: tests-docs
    content: Cover accounting/concurrency/error behavior and document the design
    status: completed
isProject: false
---

# User storage quotas

## Architecture decisions

- Count logical bytes once: raw source files, ready editor assets, and each material's current normalized JSON. Exclude Yjs state, projections, revisions, parsed artifacts, and indexes/vectors — those are bounded separately by the growth-control work below rather than by the quota.
- Charge workspace content to the workspace owner; standalone materials to `materials.user_id`; cloned content to the cloning user. Shared blob paths are charged once per logical cloned file, so two clones of one physical blob are billed twice. This is deliberate: the alternative (reference-counted physical billing) makes a user's usage depend on other users' delete behaviour.
- Use synchronous transactional deltas, not a per-save job queue. A queue would make enforcement stale and permit concurrent overages. Run a daily bulk reconciliation to repair drift.
- Existing material edits may increase usage past the limit and are never rejected by the quota. The quota is a creation gate, not a hard cap: subsequent uploads, generation, creation, and clones are blocked until usage falls below the tier limit. Unbounded growth of a single material is prevented by the per-material cap instead, not by the quota.
- **Because edits are never quota-rejected, edit deltas have no correctness requirement to be synchronous.** Only creation needs an accurate counter. This is what makes the counter design below viable.

## Tiers

- Two tiers only: `free` and `pro`. The `team` tier is removed.
- Enforce in binary units, display in decimal units: free `104857600` bytes labelled "100 MB", pro `1073741824` bytes labelled "1 GB". Define the limits once in Go and once in the frontend formatter; never derive a displayed number from a hand-written string.
- Remove `team` from: `PlanTeam` and the enum ref in [server/internal/store/enums.go](server/internal/store/enums.go); the `plan_tier IN ('pro','team')` predicates in [server/internal/store/material_revisions.go](server/internal/store/material_revisions.go) and [server/internal/store/collaboration.go](server/internal/store/collaboration.go); the price mapping and `STRIPE_PRICE_TEAM` handling in [server/internal/billing/stripe.go](server/internal/billing/stripe.go) and the reconcile command; the `enum:"pro,team"` tag in [server/internal/httpapi/apimodel/requests.go](server/internal/httpapi/apimodel/requests.go); the tier card and label switch in [src/routes/Subscription.tsx](src/routes/Subscription.tsx); regenerated enums and zod validators under [src/api/gen](src/api/gen); and the fixtures in [src/mocks](src/mocks) plus `server/internal/httpapi/webhooks_test.go` and `server/internal/store/material_revisions_test.go`.
- Per-asset caps in the `editor_assets` CHECK must not exceed the tier that is allowed to create them. Today a 100 MiB audio file is allowed but exceeds the entire free quota. Derive per-purpose caps from the tier limit in application code and keep the DB CHECK only as an absolute ceiling.

## Schema and accounting

Destructive rewrite of [server/migrations/0001_init.sql](server/migrations/0001_init.sql) is fine; there is no existing database, data, or deployed server. Every consumer of the old shape must be updated in the same change.

- Make `workspaces.user_id` **NOT NULL**. A nullable owner makes a non-null owner on `files` underivable, and the seed already special-cases it with `WHERE user_id IS NOT NULL`.
- Add non-null owner `user_id` to `files`, `upload_sessions`, `editor_assets`, and `editor_asset_uploads`.
- Add `materials.owner_user_id` as the **charge target**, distinct from `materials.user_id` (the creator). For a workspace material created by a member these are different users, and without a denormalized column every trigger and every reconciliation query has to re-derive the same join — the classic source of permanent drift. One trigger maintains it: workspace owner when `workspace_id` is set, otherwise `user_id`. There is no workspace ownership transfer today, so the value is stable.
- Replace lossy `files.size_kb` with `size_bytes bigint`, and add `materials.size_bytes bigint` maintained by trigger from `octet_length(content::text)`.
- Counters live in their own table, **not on `users`**:
  ```
  user_storage(user_id pk, used_bytes bigint, reserved_bytes bigint, updated_at)
  ```
  Putting a counter on `users` makes every accounting write contend with, and bloat, the row that authentication and every join already touch.
- Add an insert-only ledger for edit deltas:
  ```
  user_storage_deltas(id bigserial pk, user_id, delta_bytes bigint, created_at)
  ```
  with an index on `(user_id)`.

### Which writes take the lock

This split is the core of the design; get it wrong and the `user_storage` row becomes a serialization hotspot.

- **Synchronous, row-locked** (`SELECT ... FOR UPDATE` on `user_storage`, then check `used + pending_deltas + reserved + requested <= limit`): inserts of files, editor assets, and materials; deletes; upload and asset reservations; reservation finalize and expire.
- **Asynchronous, lock-free**: material *content updates*. The trigger writes the new `materials.size_bytes` on the material's own row (cheap, same page, HOT update) and appends one row to `user_storage_deltas`. Nothing locks `user_storage`.

The reason this matters: collaboration debounces at 2s (`COLLABORATION_DEBOUNCE_MS` in [collaboration/src/config.ts](collaboration/src/config.ts)), so every open document rewrites `materials.content` every two seconds. A workspace owner with twenty active documents would otherwise take ten exclusive locks per second on one row.

The creation gate reads `used_bytes + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1), 0) + reserved_bytes`, so it never sees a stale figure. Reconciliation folds the ledger into `used_bytes` and deletes the folded rows.

### Triggers and safety

- Derive material JSON byte size and adjust counters on insert, update, delete, status transitions, and cascading workspace deletion. Pending direct uploads reserve capacity; completion converts reserved bytes to used bytes; expiry releases them.
- **Do not add nonnegative CHECK constraints to the counters.** A single underflow would abort the user's next unrelated operation — including the delete that would have fixed it. Clamp with `GREATEST(0, ...)`, log the anomaly, and let reconciliation repair it.
- Add [server/internal/store/storage.go](server/internal/store/storage.go) with the tier limits, a typed quota-exceeded error carrying used/limit/owner, the locked gate helper, usage reads, and full counter reconciliation.

## Enforce every new logical resource

- Update source paths in [server/internal/store/uploads.go](server/internal/store/uploads.go), [server/internal/store/jobs.go](server/internal/store/jobs.go), [server/internal/store/queries.go](server/internal/store/queries.go), and handlers under [server/internal/httpapi](server/internal/httpapi) to resolve the workspace owner, preserve exact bytes, reserve direct uploads, and gate multipart/cloud/mock inserts transactionally. Delete a just-uploaded blob if the DB gate rejects it.
- Reservations are safe to base on `declared_size` because completion already verifies the actual object size against it ([server/internal/httpapi/uploads.go](server/internal/httpapi/uploads.go) and [server/internal/httpapi/editor_assets.go](server/internal/httpapi/editor_assets.go)). Keep that check; it is load-bearing for the quota, not just for data integrity.
- **Fix `MarkUploadExpired`**, which currently never passes its `id` argument to `Exec` and therefore fails on every call — the error is discarded at the call site, so sessions silently never leave `pending`. Reservation release is built directly on this path.
- Replace the opportunistic `go a.cleanupExpiredUploads()` sweeper with a scheduled one. Today cleanup only runs when *some other user* starts an upload, bounded to 20 rows, so an abandoned reservation can hold quota indefinitely. Apply the same treatment to `editor_asset_uploads`.
- Update [server/internal/store/editor_assets.go](server/internal/store/editor_assets.go) so embedded media uses the same owner reservation/finalize/expire lifecycle.
- Gate `CreateMaterial`, standalone/workspace material clones, and aggregate workspace clones in [server/internal/store/queries.go](server/internal/store/queries.go) and [server/internal/store/share.go](server/internal/store/share.go). **Compute the clone's total size first, gate once, then take the counter lock only for the final update.** Holding the lock across a clone that copies every chapter, file, material, and card-stat row would stall every other operation on that account for the duration.
- Material updates and collaboration projection in [server/internal/store/yjs_documents.go](server/internal/store/yjs_documents.go) only append ledger deltas and never enforce the cap.
- Persist generated flashcard decks as one complete material instead of creating an empty deck and appending cards in [server/internal/httpapi/server.go](server/internal/httpapi/server.go), so the final generated size is checked atomically. Ensure quota failures propagate instead of being swallowed by the pipeline-to-local fallback.
- Map quota failures consistently to HTTP 403 with a stable `storage_quota_exceeded` code and usage/limit details across Huma, raw upload, import, generation, and clone routes. When the charged user is the workspace owner and not the requester, the message must say so — a member otherwise sees an inexplicable rejection.

## Bounding edit-driven growth

The quota deliberately does not gate edits, so three separate mechanisms keep edit-driven storage finite.

### Per-material hard cap

- Cap each material at **2 MiB** of serialized JSON, plus limits on total node count and maximum nesting depth. Enforce on every save in `materialdoc.Marshal` (used by the projection endpoint in [server/internal/httpapi/huma_collaboration.go](server/internal/httpapi/huma_collaboration.go)) and on the direct material update path.
- **The enforcement point matters more than the limit.** The Yjs document is authoritative and the Go projection is downstream of it. If only the projection rejects an oversized document, the Yjs state keeps the content, the projection fails forever, and `projection_error` fills up while the editor happily continues. So enforce at three layers:
  1. **Editor (soft)** — block the paste/insert/upload that would cross the limit and surface a clear message, so the common case never reaches the server.
  2. **Collaboration server (hard)** — check in `YjsDocumentStore.store` in [collaboration/src/persistence.ts](collaboration/src/persistence.ts) before the row is written; reject the transaction and signal the client rather than persisting a document the projection cannot accept.
  3. **Go projection (last resort)** — reject and record `projection_error`, treated as an alerting condition rather than a normal path.
- Store the node count and depth on the material so the file-properties UI can show them (already wanted in `todo` high priority #1).

### Yjs state compaction

Your assumption that Yjs state is bounded by the document size is not correct, and this is worth being precise about.

`gc: true` is already set on every `Y.Doc` in [collaboration/src/persistence.ts](collaboration/src/persistence.ts), so Yjs *does* free the content bytes of deleted text — the item's payload is replaced with a `ContentDeleted` marker holding only a length. What survives is the **item struct itself**: its client id, clock, length, and origin pointers, a handful of bytes each. Yjs merges adjacent structs from the same client, so continuous typing collapses well, but scattered editing and interleaved edits from multiple clients produce runs that cannot merge. On top of that, **every browser session gets a new client id**, and the encoded state carries one state-vector entry per client id that has ever inserted, so the floor rises with session count regardless of content.

So the state grows with *edit history*, not with current content. A 50 KB note edited daily by three people for a year is several MB even though the content never exceeds the 2 MiB cap. It is monotonic, and the 2 MiB cap does not bound it.

Tombstones cannot be dropped incrementally without breaking convergence — a client holding an older state vector would re-insert the deleted content. The safe operation is a full document reset:

- Add a compaction pass that runs when a room has **no connected clients** and has been idle for a threshold, and when `octet_length(state)` exceeds a multiple of `materials.size_bytes` (start at 4x, floor 256 KiB).
- Build a fresh `Y.Doc` from the current projected Plate value, encode it, and replace the row. Take the same `pg_advisory_xact_lock(hashtextextended(materialId, 0))` that `load` and `store` already use, so compaction serializes against concurrent document I/O.
- Drop the `evo:checkpoints` Y.Map rather than re-seeding it. Checkpoint keys are transient save markers that the setting client deletes when it sees the `checkpoint-persisted` broadcast; with an empty room nobody is waiting on them, and any surviving key is a leak from a client that disconnected mid-save. Compaction is the natural place to clear them.
- Set `stored_version` and `projected_version` to the same new value and leave `materials.content` untouched. Compaction does not change content, so it must not make the row look pending to `ProjectionService.retryPending`, which would otherwise re-project and spuriously bump `materials.revision` and rewrite today's revision snapshot.
- Make the room schema a real epoch. `material_yjs_documents.room_schema` already exists but is **write-only today** — `persistence.ts` inserts a literal `1` and nothing ever reads it back, while `schema:1` is hardcoded in five places. All of them must move to the stored epoch:
  - `ROOM_PATTERN` in [collaboration/src/persistence.ts](collaboration/src/persistence.ts) and `MATERIAL_ROOM_PATTERN` in [collaboration/src/auth.ts](collaboration/src/auth.ts) — widen to `schema:(\d+)`.
  - The service-command room in [collaboration/src/server.ts](collaboration/src/server.ts) (`/internal/commands`). This is the dangerous one: a comment or checkpoint command that builds `schema:1` after a bump would `openDirectConnection` on a *different, empty* room and write into a divergent document.
  - The Redis pub/sub room derivation in the same file. It already prefers an explicit `event.room`, so the cheapest fix is to publish the full room name from Go instead of deriving it.
  - Token issuance in [server/internal/httpapi/huma_collaboration.go](server/internal/httpapi/huma_collaboration.go), which must read the current epoch.
- **Key the client `Y.Doc` on the room.** `NoteEditorCore` currently does `useMemo(() => new Y.Doc({ gc: true }), [])`, so a room change re-runs `yjs.init` with a new id against the *same* document instance, which still holds the pre-compaction structs. Key the memo on `collaborationToken.room` (or remount via `key=`) so the epoch bump actually produces a fresh document.
- Token verification is a useful backstop here: `onAuthenticate` checks the token's room claim against `documentName`, so a stale client that reconnects with an old room name is rejected rather than allowed to merge. That surfaces as an `error` status, so the client should invalidate the collaboration-token query and remount on room-mismatch rather than leaving the user on a dead editor.
- Handle the in-memory document lifecycle before compacting. The server runs with `unloadImmediately: false`, documents are shared across instances via the Redis extension, and `failedStores` retries a cached `encodeStateAsUpdate` every 5 seconds. Any of these can write pre-compaction state back over the compacted row. Sequence it as: publish `evo:collaboration:evict` (which already calls `closeConnections`), confirm no instance still holds or has queued the document, then compact under the advisory lock.
- Optional and self-contained: switch stored state to `encodeStateAsUpdateV2`, which run-length encodes history far better. Go never decodes the `state` bytea, so the change is confined to `collaboration/`.
- Note separately that `store()` currently reads, merges, and rewrites the entire `state` bytea every 2 seconds per active document. Compaction reduces the constant, but the O(document) write amplification is worth revisiting on its own.

### Material revision retention

**This is already implemented** — `freeMaterialRevisionLimit = 7` and `premiumMaterialRevisionLimit = 30` in [server/internal/store/material_revisions.go](server/internal/store/material_revisions.go), pruned inline on every upsert and in bulk by `PruneMaterialRevisions`. The only change needed here is dropping `'team'` from the two `plan_tier IN ('pro','team')` predicates.

Two things to be aware of rather than change:

- The rule is "keep the N most recent daily snapshots", not "keep N days". A user who edits once a month keeps seven snapshots spanning seven months. Bounded in count, which is what matters for storage, but the UI copy should say "last 7 versions" rather than "7 days" if it currently claims the latter.
- Retention bounds revisions at 7x (free) or 30x (pro) the per-material content size, entirely uncounted by the quota. With the 2 MiB cap that is up to 60 MiB of revision history per pro material against 2 MiB of accounted usage. Postgres TOAST already compresses `content` jsonb on disk, which takes a large bite out of this, but the multiplier is real and tier limits should be chosen knowing that physical footprint is roughly `(1 + retention) x logical` in the worst case. Also skip writing a daily snapshot when the content hash is unchanged.

## Remove video uploads, add YouTube embeds

Video is by far the worst byte-per-value ratio in the product: the current schema permits a single 500 MiB video, half of the entire pro quota. Drop uploaded video entirely and support YouTube embeds instead, which cost zero bytes.

- Schema: remove `'video'` from the `editor_assets.purpose` CHECK and drop the video size branch. Destructive is fine; there is no existing data.
- Server: reject `purpose='video'` and `video/*` content types when reserving an editor asset upload in [server/internal/store/editor_assets.go](server/internal/store/editor_assets.go) and [server/internal/httpapi/editor_assets.go](server/internal/httpapi/editor_assets.go). Content type is already verified against the reservation at completion, so both ends are covered.
- Frontend: remove `video` from `EditorAssetPurpose` in [src/api/editorAssets.ts](src/api/editorAssets.ts); remove the `video` entries from `MEDIA_ACCEPT`, `editorAssetPurpose`, and `plateMediaType` in [src/features/notes/media.ts](src/features/notes/media.ts); remove the video placeholder copy and the `KEYS.video` branch of `purposeForMediaType` in [src/features/notes/MediaNodes.tsx](src/features/notes/MediaNodes.tsx); update [src/features/materials/MediaAssetView.tsx](src/features/materials/MediaAssetView.tsx) and `src/features/notes/media.test.ts`.
- Add a **YouTube embed** tab to the media insert UI, alongside the existing upload picker. The user pastes a YouTube URL; parse and validate the video id client-side, and persist a node carrying only `{ type: 'video', provider: 'youtube', videoId }` — never a raw arbitrary URL, so the node cannot be used to embed unvetted third-party frames. Render through a privacy-respecting embed origin. No `editor_assets` row, no bytes charged, nothing for the quota to track.
- This dovetails with `todo` high priority #14 (collapsing the separate image/video/audio/file inserts into one control with a dropdown); build the embed tab as part of that control rather than as a fifth top-level insert option.

## Reconciliation and API/UI

- Extend [server/cmd/reconcile/main.go](server/cmd/reconcile/main.go) to recompute used bytes, fold and delete ledger rows, and recompute pending reserved bytes from authoritative rows, daily and independently of Stripe availability. This is a safety net, not the hot-path accounting mechanism.
- **Reconcile per user inside a transaction that locks that user's `user_storage` row**, and re-derive both numbers under that lock. A single bulk `UPDATE ... FROM (SELECT sums)` would clobber a reservation that finalizes mid-pass, which is exactly the drift the job exists to remove.
- Expose `storageUsedBytes`, `storageReservedBytes`, and `storageLimitBytes` through `/api/billing` via [server/internal/store/users.go](server/internal/store/users.go) and [server/internal/httpapi/apimodel/apimodel.go](server/internal/httpapi/apimodel/apimodel.go); regenerate [openapi.yaml](openapi.yaml) and [src/api/gen](src/api/gen).
- Update [src/api/client.ts](src/api/client.ts) to retain stable API error codes, show a quota/upgrade message in upload, create, generate, clone, and editor-asset flows, and display current usage on [src/routes/Subscription.tsx](src/routes/Subscription.tsx). Correct plan copy to 100 MB free and 1 GB pro, and update MSW fixtures in [src/mocks](src/mocks).
- Note the product consequence of full clone charging: a free user cannot clone any public workspace larger than 100 MB. Confirm that is intended given `clone_count` and the Explore route are growth surfaces, or add a cheaper "reference" mode later.

## Consumers of the changed schema

Beyond the files named above, `size_kb` and the tier enum reach further than the original plan accounted for:

- [e2e/fixtures/seed.sql](e2e/fixtures/seed.sql) inserts `size_kb` and will break the e2e suite.
- `File.SizeKb` in [server/internal/store/models.go](server/internal/store/models.go).
- Display paths in [src/routes/Files.tsx](src/routes/Files.tsx) and [src/features/files/FileListItem.tsx](src/features/files/FileListItem.tsx).
- [src/mocks/db.ts](src/mocks/db.ts) and [src/mocks/handlers.ts](src/mocks/handlers.ts), including `refreshMaterialContentBytes`.
- Generated `src/api/gen/model/file.ts` and `src/api/gen/validators.ts`.

## Explicitly out of scope

Tracked in [todo-lifecycle](todo-lifecycle); these depend on the account and asset deletion lifecycle and are deliberately not solved here.

- B2 object deletion. Workspace delete is a bare `DELETE FROM workspaces` relying on cascade, with orphan detection only in `DeleteFileWithOrphanedBlobs`, so logical usage drops to zero while physical bytes stay billed. Configure this when deletion is designed end to end.
- Downgrade behaviour when a pro user over 100 MiB moves to free. Under creation-gate semantics they silently cannot create anything until they delete; the real policy (buffer period, warnings, forced deletion) belongs with the subscription-expiry lifecycle.
- Soft deletion / recycle bin interaction: whether soft-deleted content still counts against quota.

## Tests and documentation

- Store integration tests for exact tier boundaries, concurrent reservations, finalize/expire conversion, ledger folding and gate correctness while deltas are unfolded, material growth while over quota, delete/cascade decrements, workspace-owner charging with a member as creator, clones, and reconciliation drift repair.
- A concurrency test that asserts material saves do **not** take the `user_storage` lock, so the async-delta property does not silently regress.
- Per-material cap tests at all three enforcement layers, including the case where the collaboration server rejects and the projection therefore never sees an oversized document.
- Yjs compaction tests: state shrinks, content and `evo:checkpoints` survive, room schema bumps, a client on the old room cannot merge stale state back in.
- HTTP/client tests for the stable 403 error, the owner-vs-requester message, and UI handling; update existing file/material tests for byte-sized fields; assert no `team` tier remains.
- Document the accounting rules, ownership, the lock/ledger split and why it exists, the reservation lifecycle, Yjs compaction, revision retention multipliers, and the reconciliation procedure in [openwiki/backend-storage-quota.md](openwiki/backend-storage-quota.md).
- Verify with Go tests, frontend unit/type checks, collaboration tests, then `pnpm run fmt` and `pnpm run fix`.
