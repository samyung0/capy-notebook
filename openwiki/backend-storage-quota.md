---
type: Backend
title: "Backend Storage Quota Accounting"
description: "How used/reserved bytes are accounted, gated, and measured for materials, uploads, and clones."
tags: [backend, storage, quota, accounting, uploads, materials]
---

# Backend storage quota

Policy questions (who may create, who pays, over-quota recovery, upload/blob
cleanup) live in
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md).
This page is the accounting contract.

## Product plan limits

`plan_limits` in `server/migrations/0001_init.sql` is the canonical backend
catalog for every numeric limit that may vary by subscription plan:

| Limit                           |                       Free |                        Pro |
| ------------------------------- | -------------------------: | -------------------------: |
| Storage                         | 100,000,000 bytes (100 MB) | 1,000,000,000 bytes (1 GB) |
| Monthly credits                 |                      1,000 |                     20,000 |
| Source file                     |                     10 MiB |                     30 MiB |
| Material daily-history entries  |                          3 |                         30 |
| Owned workspaces                |         Unlimited (`NULL`) |         Unlimited (`NULL`) |
| Files per workspace             |                        100 |                        100 |
| Files per upload/import request |                         20 |                         20 |

Material history retains at most one snapshot per UTC day. A Pro-to-Free
downgrade permanently deletes snapshots 4 through 30 in the same transaction
that projects the Free tier. Material saves, API startup, and the daily sweep
are backstops for a missed billing webhook. Upgrading again cannot recover those
27 deleted snapshots. A reversible suspension or deletion-pending projection is
not itself a downgrade: while preserved provider rows still grant Pro, webhook,
failed-invoice, reconciliation, and daily-prune paths retain the Pro history.
When an account has no subscription rows, its stored tier is the effective tier
for retention, so a reversible closed-lifecycle projection also preserves
no-row stored-Pro history through support restoration. An active Stripe
reconciliation whose provider snapshot is explicitly empty establishes Free
provider truth and performs the irreversible prune.

The Go gateway and ops process load and validate the complete two-row catalog
once during startup. The Python ingest worker does the same before it starts its
model registry or claims a job. Request paths read only the immutable process
snapshot; they do not query `plan_limits`, and a missing, unknown, or malformed
plan makes startup fail.

The frontend intentionally has no plan-catalog endpoint. Product copy uses the
explicit snapshot in `src/features/billing/planLimits.ts`; changing a displayed
limit requires updating that file and the affected Paraglide translations along
with the SQL seed. APIs may still return a requester's effective current value,
such as workspace `filesLimit`, upload-policy `maxBytes`, and billing counters.

Subscription projection remains owned by the Stripe lifecycle code. Request
gates do not trust a stale projected Pro tier past the latest paid
`current_period_end`: Go and Python both apply Free limits at that boundary,
even before a delayed webhook reconciles `users.plan_tier`. Accounts without a
dated subscription retain their stored tier for local/operator fixtures.

## What counts

Storage is charged once per logical row owned by a user:

| Resource      | Counted size               | Charged when                  |
| ------------- | -------------------------- | ----------------------------- |
| Source files  | `files.size_bytes`         | row exists                    |
| Editor assets | `editor_assets.size_bytes` | `status = 'ready'` only       |
| Materials     | `materials.size_bytes`     | always; set from content JSON |

Workspace-owned rows resolve the payer from `workspaces.user_id` into
`files.user_id` / `editor_assets.user_id` / `materials.owner_user_id`. A
standalone material sets `owner_user_id` from its creator.

Storage limits are **100 MB** free and **1 GB** Pro. These use decimal bytes:
100,000,000 and 1,000,000,000 respectively.

Per-file **source upload** caps are separate from that quota and from editor-asset
purpose limits (images 20 MB, audio 100 MB, …). They follow the **workspace
owner's** plan, create-only (no retroactive invalidation): **10 MiB** free,
**30 MiB** Pro (from the startup plan snapshot). GPU/LLM cost is metered
elsewhere. `GET /api/source-upload-policy?workspaceId=` returns the cap the
dialog should enforce.

The parser-generated Office citation PDF is a platform artifact and does not
increase `files.size_bytes` or user storage usage. Its object path is held by
both `artifact_cache` for cross-file reuse and `files.preview_blob_path` while a
ready file needs it. Blob refcounting keeps a live preview through cache expiry,
clone, and donor reuse, then queues deletion after its last file/cache reference
is gone. Native PDFs reuse `blob_path` and do not create another preview object.

Per-workspace **file count** is a separate bound from byte quota: it exists so
the chat catalogue (`list_sources`) fits in one tool result. Both plans currently
allow 100. Open unexpired source upload sessions count toward the cap so concurrent
session creates cannot all pass a check against 99; `SweepExpiredUploads` returns
those slots. The per-upload limit is 20 and is enforced server-side per request
(the browser picker is only the first line). Both gates run in
`gateWorkspaceFilesTx` at session creation and on every other file-insert path
(cloud import preflights the whole batch). Clone and ownership transfer also
check the recipient plan's workspace-file cap. The workspace payload reports `fileCount` and
`filesLimit`. Overflow is `files_limit_exceeded`; a too-large batch is
`files_batch_exceeded`.

## Counter model

`user_storage` holds folded `used_bytes` and `reserved_bytes`.

- File and ready-asset inserts/updates/deletes adjust `used_bytes` directly.
- Material size changes append rows to `user_storage_deltas` so frequent
  collaboration projections do not serialize on the counter row.
- Effective used bytes for decisions and reporting are
  `used_bytes + sum(pending deltas)`.

`gateStorageTx` (creations, upload reservations, clones, transfers onto a
recipient) locks the counter, unfolds pending deltas, checks the owner's
lifecycle `CanCreate`, then enforces
`used + reserved + requested <= plan limit`. Deletions and shrinks do not go
through that gate; they adjust counters/triggers for accounting only.

Reconciliation locks the counter plus authoritative resource rows, recomputes
both counters from files / ready assets / materials, and deletes the folded
delta rows.

Accounting helpers no-op when the owner user row is already gone, because
foreign-key cascades can fire resource delete triggers after the user is
removed.

Error codes: hard plan overflow → `storage_quota_exceeded` (with used /
reserved / requested / limit); lifecycle over-quota → `account_over_quota`
(see authorization doc).

## Material bytes vs plan quota

Material content size is `octet_length(content::text)` in PostgreSQL — the
same expression the BEFORE trigger writes into `materials.size_bytes` and that
Go uses via `octet_length($1::jsonb::text)`. Go's JSON encoder disables HTML
escaping so direct writes and the collaboration projection share one byte
policy. On material delete, the trigger appends `-OLD.size_bytes` to the
delta ledger so pending growth deltas cannot leave stranded positive usage.

Per-material shape bounds:

- 2 MiB normalized JSON
- 10,000 nodes
- depth **16**

These bounds are independent of plan quota, and they gate **writes only**.
`materialdoc.Parse` decodes without applying them; write paths pair
`materialdoc.Metrics` with `DocumentMetrics.LimitError` (`Marshal` does both).
A read never refuses an over-limit document, because content can legitimately
exceed a bound — an operator import, an account allowed to bypass, a bound
lowered after the fact — and returning an empty envelope for it is
indistinguishable from data loss. Reads that genuinely cannot decode answer
422 `material_content_unreadable` instead of substituting `Empty()`.

The Yjs projection (`ProjectMaterialContent`) is the one write that does not
re-check the bounds: the collaboration service already refused every update
that grows an over-limit document, so re-rejecting here would strand
`materials.content` behind the Y.Doc for exactly the documents recovering
towards the limit. The internal projection handler uses
`materialdoc.MarshalProjection`, which still validates and canonicalizes the
Plate envelope but does not apply the product caps.

The browser applies its own, independent render threshold
(`MATERIAL_RENDER_WARNING` in `src/lib/const.ts`) to decide when opening a
document is worth a warning. It is deliberately not derived from these bounds.

**Growing an existing material does not call `gateStorageTx`.** Size deltas
only update the ledger. Separately, when the **storage owner** is in
`over_quota_grace` / `over_quota_frozen`, collaboration tokens are mintable
only as `shrink`, so the document cannot grow until the account recovers.
Actor over-quota does not block edits inside a healthy owner's workspace.

## Reservations and clones

Direct B2 uploads and editor-asset reservations call `reserveStorageTx`
before the client receives a signed PUT URL. Reserved bytes count toward the
gate immediately so concurrent uploads cannot double-spend remaining quota.
Finalize converts reservation → used (via status transitions / triggers).
Expiry marks the session expired and releases the reservation in the same
transaction before best-effort blob cleanup (cleanup details in the
authorization doc).

Explicit source replacement keeps the logical file. Ordinary collaborative Office saves use durable checkpoints, as described below.
Its upload session reserves `max(new_size - current_size, 0)`, so unchanged or
smaller saves do not need free quota they will not consume. Finalization locks
the file, verifies its expected revision, swaps the blob and size, then releases
the growth reservation. The normal file-size trigger applies the signed used
byte delta. A same-size or smaller replacement is explicitly permitted while
the storage owner is over quota, so Office editing provides a replacement-based
recovery path. Suspended, deletion-pending, and deleted owners remain blocked.
A stale editor or a file that is no longer ready cannot finalize.

Collaborative source saves account `source_documents` state, indexed state and
serialized pending JSON through generated `storage_bytes` and the same storage
delta ledger. `source_refresh_candidates` accounts its captured state, new
source bytes and fresh seed while processing. Owner changes transfer those
charges with the file. Admission, checkpoint growth and publication run under
source/workspace/account locks. Publication accounts the net size after
replacing the old base and removing candidate storage, including any larger
fresh Office seed. Negative changes remain negative ledger deltas.

A candidate retains both old A and new B temporarily. Only a successful current
Office handoff replaces A, clears Undo/Redo and releases old references. Text
retains its existing editing lineage. Shared caption payloads are platform
artifacts referenced by containing resources; published clones attach their
own references and exclude pending captions. A failed candidate cannot remove
the currently published source/index.

Editor assets write to an `editor-assets/incoming/…` key and are promoted to
an unpresigned stable `editor-assets/{id}/…` key before finalization, so the
still-valid upload URL cannot overwrite a ready object. If creating the
durable DB row fails after a source object was written, handlers delete the
orphan object.

Workspace clones snapshot the source, gate the total file + material + ready
editor-asset payload against the **cloner's** quota, copy ready asset rows
with new logical IDs (rewriting embedded references), and reuse physical blob
paths under reference counting. Only `ready` source files are copied; pending,
processing, and failed files are omitted. Material nodes referring to a pending,
failed, missing, or otherwise uncopied editor asset are removed from the cloned
document instead of retaining an unrenderable source id. Retained daily
material history is copied from the same repeatable-read snapshot, capped by
the cloner's plan, and uses the same fresh editor-asset/card ID map as current
content. Revision rows are not separately charged by byte; the material's
current content and cloned logical assets are the storage-accounted payload.
Before writing cloned rows, the transaction locks every copied source,
Office-preview, and ready editor-asset blob refcount in stable path order. The
last source reference therefore cannot queue and reap a physical object until
the clone commits. A path deleted after the repeatable-read snapshot causes a
transaction retry instead of a clone that points at missing bytes.

A single-material clone is always a new **private standalone** material. It
copies only ready editor assets referenced by the current SQL projection or the
revision rows retained for the cloner's plan, gives each asset a fresh logical
ID owned by the clone, rewrites every retained document, and charges the asset
bytes to the cloner. Physical object paths remain shared through blob
refcounting. Source workspace asset IDs never survive in standalone content.
Contended clones poll the per-source advisory hierarchy without retaining a
pool connection while they wait, then take the repeatable-read snapshot once
the locks are held; a clone burst therefore cannot starve unrelated database
work. Workspace operations take the workspace fence before material fences.
Public deletion takes the same source fence before account, workspace, or
storage rows, while before-delete triggers also protect direct SQL and cascade
cleanup. The trigger cleans the detached popularity counter only after earlier
clones release the fence, so a clone cannot leave an orphan counter behind.

## Yjs storage growth

`gc: true` does not bound Yjs history: deleted structs and related metadata
remain in `material_yjs_documents.state`. Idle rooms whose stored state is at
least `max(256 KiB, material.size_bytes * 4)` are compaction candidates.

Compaction takes a Redis eviction lease so every collaboration instance
flushes, closes clients, and unloads the room; rebuilds a fresh Y.Doc from
the projected Plate `materials.content`; clears in-memory pending
checkpoints; keeps `stored_version` / `projected_version` equal; and
increments `room_schema`. Tokens, Redis events, service commands, and client
Y.Docs bind to that epoch so a stale client cannot merge pre-compaction state
back in.

Ordinary persistence embeds server-owned actor provenance in the same Yjs
transaction as each edit and rechecks every contributor in the exact debounced
snapshot, along with current membership/share role, workspace owner, and live
subscription/storage state. Claimed markers are removed from the committed
state; newer generations remain for the next save. A token minted before role
removal, suspension, deletion, or plan expiry cannot bypass the database
boundary. A rejected authorization-race save evicts the room so the uncommitted
update is not retained in memory. Before writing authoritative Yjs state, the
sidecar applies the same structural and material-kind contract as Go. Invalid
Plate content cannot become a durable state that projection will reject. The
sidecar discards that in-memory room and reloads the last durable state instead
of retrying an unsavable snapshot.

Once a lapsed owner is over the Free limit, the next state must not grow in
serialized size, node count, or depth. Structural validation does not apply
those caps, so a valid document that starts over a limit can still shrink back
towards it. The TypeScript and Go metric walks count every node through the
shared structural depth ceiling, so growth below an already-over-limit deep
branch cannot hide behind unrelated deletions. A live Free subscription by itself is an ordinary active account.
The sidecar switches to shrink-only access only when it sees an expired or
closed Pro boundary and usage exceeds the Free limit, matching Go's account
resolver.

Sources: [storage gate and reconciliation](../server/internal/store/storage.go),
[material bounds](../server/internal/materialdoc/document.go),
[collab limits](../collaboration/src/limits.ts),
[collab document validation](../collaboration/src/materialDocument.ts),
[compaction config](../collaboration/src/config.ts).
