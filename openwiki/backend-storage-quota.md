---
type: Backend
title: 'Backend Storage Quota and Blob Lifecycle'
description: 'Storage accounting, quota enforcement, upload reservations, and blob cleanup behavior in the backend.'
tags: [backend, storage, quota, uploads, blobs, lifecycle]
---

# Backend storage quota

## Accounting contract

Storage is charged once per user's logical content:

- source files use `files.size_bytes`;
- ready editor assets use `editor_assets.size_bytes`;
- materials use their normalized JSON size in `materials.size_bytes`.

Workspace content is charged to `workspaces.user_id`; a standalone material is
charged to its creator. `materials.owner_user_id` and the file/asset `user_id`
columns make that owner explicit for triggers and reconciliation.

`user_storage` contains the folded used and reserved counters. Material content
updates append a delta to `user_storage_deltas` so frequent collaboration saves
do not serialize on the owner's counter row. Creation, deletion, reservations,
and reservation transitions lock the counter row and include unfolded deltas
before making a quota decision. Reconciliation locks the counter and
authoritative resource rows, recomputes both counters, and removes the folded
ledger rows.

The limits are 100 MiB for free accounts and 1 GiB for Pro accounts. The UI
labels these as 100 MB and 1 GB.

## Material bounds and Yjs

Every material is limited to 2 MiB of normalized JSON, 10,000 nodes, and depth
64. Go validates this on direct writes and projection; the collaboration service
checks the same size/shape bounds before persisting Yjs state. Material edits
are not quota-gated, but cannot grow one material without bound.

`gc: true` does not bound Yjs history: deleted structs, clocks, client IDs, and
state-vector entries remain. Idle rooms whose stored state is at least 4x the
current material JSON (with a 256 KiB floor) are compacted only after every
registered collaboration instance acknowledges eviction. A Redis eviction
lease blocks new loads and writes while instances flush stores, close clients,
and unload their cached documents. Compaction rebuilds a fresh document from the
projected Plate value, clears transient checkpoints, keeps stored/projected
versions equal, and increments `room_schema`. Tokens, Redis events, service
commands, and the client Y.Doc all use the dynamic room epoch so stale clients
cannot merge the old state back into the compacted room.

## Upload and lifecycle notes

Direct B2 uploads reserve declared bytes before issuing a signed URL. Editor
assets upload to a temporary key and are promoted to an unpresigned stable key
before finalization; the still-valid upload URL therefore cannot overwrite a
ready asset. Finalize and expiry release reservations transactionally, including
workspace-cascade deletes, and expiry marks the row before best-effort blob
deletion so object-store failures cannot strand quota. Quota failures return
the stable `storage_quota_exceeded` code and usage details, and source objects
are deleted when database persistence fails.

The quota gate measures material content with PostgreSQL's
`octet_length(content::text)` representation, the same representation used by
the accounting trigger. Go's JSON encoder disables HTML escaping so direct
writes and the collaboration service use the same logical byte policy.
Material deletion appends the inverse of its current size to the ledger, so a
grown material cannot leave positive pending deltas after its row is removed.
The migration keeps `files.position` and `materials.position` as `bigint` with a
zero default and normalizes legacy timestamp-based defaults; otherwise an
existing database can fail on its next insert with a 32-bit integer overflow.
Accounting helpers also no-op when an owner has already been deleted, because
foreign-key cascades can run resource delete triggers after the user row is gone.
Workspace clones first capture a consistent source snapshot, gate the complete
file/material/editor-asset payload, copy ready asset rows with new logical IDs,
and rewrite embedded asset/card references while reusing physical blob paths.

The disposable sharing suite is the cross-service check for these collaboration
paths. Remote cursor decorations must match Slate paths structurally (not by
dot-joined strings); shared-link editors may be absent from the workspace member
directory, so cursor labels fall back to the authenticated user's name. Because
decorations split text leaves, editor end navigation uses the Plate document API.
Static `PlateStatic` output still has a `data-slate-editor` marker but is not
editable; editability checks should use `contenteditable`.

