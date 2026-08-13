---
type: Backend
title: 'Backend Storage Quota Accounting'
description: 'How used/reserved bytes are accounted, gated, and measured for materials, uploads, and clones.'
tags: [backend, storage, quota, accounting, uploads, materials]
---

# Backend storage quota

Policy questions (who may create, who pays, over-quota recovery, upload/blob
cleanup) live in
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md).
This page is the accounting contract.

## What counts

Storage is charged once per logical row owned by a user:

| Resource | Counted size | Charged when |
| --- | --- | --- |
| Source files | `files.size_bytes` | row exists |
| Editor assets | `editor_assets.size_bytes` | `status = 'ready'` only |
| Materials | `materials.size_bytes` | always; set from content JSON |

Workspace-owned rows resolve the payer from `workspaces.user_id` into
`files.user_id` / `editor_assets.user_id` / `materials.owner_user_id`. A
standalone material sets `owner_user_id` from its creator.

Plan limits: **100 MiB** free, **1 GiB** Pro
(`FreeStorageLimitBytes` / `ProStorageLimitBytes`). The UI labels them
100 MB / 1 GB.

Per-file **source upload** caps are separate from that quota and from editor-asset
purpose limits (images 20 MB, audio 100 MB, …). They follow the **workspace
owner's** plan, create-only (no retroactive invalidation): **10 MiB** free,
**30 MiB** Pro (`sourceupload.SourceMaxBytes`). GPU/LLM cost is metered
elsewhere. `GET /api/source-upload-policy?workspaceId=` returns the cap the
dialog should enforce.

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
towards the limit.

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

Editor assets write to an `editor-assets/incoming/…` key and are promoted to
an unpresigned stable `editor-assets/{id}/…` key before finalization, so the
still-valid upload URL cannot overwrite a ready object. If creating the
durable DB row fails after a source object was written, handlers delete the
orphan object.

Workspace clones snapshot the source, gate the total file + material + ready
editor-asset payload against the **cloner's** quota, copy ready asset rows
with new logical IDs (rewriting embedded references), and reuse physical blob
paths under reference counting.

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

Sources: [storage gate and reconciliation](../server/internal/store/storage.go),
[material bounds](../server/internal/materialdoc/document.go),
[collab limits](../collaboration/src/limits.ts),
[compaction config](../collaboration/src/config.ts).
