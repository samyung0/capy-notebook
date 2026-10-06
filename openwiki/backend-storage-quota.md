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
| Trashed rows  | same as above              | until the 30-day purge        |
| Chat Undo     | `agent_edit_inverses.inverse_bytes` | while Undo is available; released on Undo, trash or invalidation |

Workspace-owned rows resolve the payer from `workspaces.user_id` into
`files.user_id` / `editor_assets.user_id` / `materials.owner_user_id`. A
standalone material sets `owner_user_id` from its creator.

A curated material's `provenance` record is **never charged** — `size_bytes` is
the content JSON alone — and its marshalled bytes are counted by `gateStorageTx`
at material creation only, never on an `edit_document` merge and never on a
clone.
A chat deck's PPTX follows the same rule: `files.size_bytes` is the PPTX
alone, and its provenance bytes are counted with it at creation only
([decks.md](decks.md)).

Storage limits are **100 MB** free and **1 GB** Pro. These use decimal bytes:
100,000,000 and 1,000,000,000 respectively.

Per-file **source upload** caps are separate from that quota and from editor-asset
purpose limits (images 20 MB, audio 100 MB, …). They follow the **workspace
owner's** plan, create-only (no retroactive invalidation): **10 MiB** free,
**30 MiB** Pro (from the startup plan snapshot). GPU/LLM cost is metered
elsewhere. `GET /api/source-upload-policy?workspaceId=` returns the cap the
dialog should enforce.

Office parsing keeps its structured handoff temporarily on the ingest host, with
no durable B2 parse cache or preview PDF. Temporary parse output is a platform
cost and does not increase `files.size_bytes` or user storage usage. Migration
0016 removes the preview columns; migration 0038 releases the B2 parse caches.
Native PDFs reuse `blob_path`.
Google-native imports now store editable Office exports; those source bytes and
saved editing state still count toward the owner's quota. Export sizes can differ
substantially from the previous Google PDF export, in either direction.

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
lifecycle `CanEdit` (active or grace), then enforces
`used + reserved + requested <= plan limit`. The limit is the effective plan's,
which is Free once a paid period has lapsed, so a grace account (over the Free
limit by definition) fails this check exactly like an active account at 100%.
Deletions and shrinks do not go through that gate; they adjust
counters/triggers for accounting only.

Reconciliation locks the counter plus authoritative resource rows, recomputes
both counters from files / ready assets / materials, and deletes the folded
delta rows.

Accounting helpers no-op when the owner user row is already gone, because
foreign-key cascades can fire resource delete triggers after the user is
removed.

Error codes: hard plan overflow, or a content edit while the owner is at its
limit → `storage_quota_exceeded` (with used /
reserved / requested / limit and the owner's user id only when the requester is
the charged account, attached by `reportHandlerError` and `failFor` in
`server/internal/httpapi`; members get the code alone); frozen account →
`account_over_quota` (see authorization doc).

## Usage levels

`StorageUsageLevelFor` in `server/internal/store/account_state.go` is the one
place the level is decided, from stored plus reserved bytes against the
current plan limit (the numbers the quota check uses): `full` at 100% or more,
`near_limit` from 95%, `ok` otherwise. `WithStorageUsage` fills it for the
reporting paths only; write gates skip those reads, except the content
admission (`StorageUsage.Full`), which makes an owner's content view-only at
`full` (see view-only at the limit).

- `GET /api/me` → `account.storageUsage`, with `storageUsedBytes` (used plus
  reserved) and `storageLimitBytes` filled for every account.
- Workspace responses → `storageOwnerUsage`, the owner's level only (never byte
  counts), on every endpoint that reports `storageOwnerState`, resolved once
  per distinct owner.

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

**View-only at the limit.** No save-time storage gate exists for materials
or source checkpoints: growing an existing material or a source's editing
state only updates the ledger. Instead, while the **storage owner** is at or
over its limit (usage level `full`, grace included), everything it pays for is
view-only for owner and members alike:

- `assertContentEditableTx` (`server/internal/store/account_state.go`) refuses
  REST content writes (quiz and flashcard content, cards), comments and PDF
  marks with `storage_quota_exceeded`;
- `SourceSession` and material collaboration tokens come back `read`, and
  `CheckSourceAccess` refuses a source edit with the same code;
- capabilities carry `canEditContent` (edit mode, comments, annotations)
  beside `canEdit`, which keeps renaming, moving, reordering and trashing;
- workspace chat drops the agent's create and edit tools, and generation is refused with `storage_quota_exceeded`
  (`StorageFullErr`) before any credits are reserved or spent.

Enforcement is at admission only, like frozen: the collaboration service's
5 s writer recheck (`fullSQL` in `collaboration/src/persistence.ts`, mirrored
by `StorageUsage.Full`) closes every writer in the owner's rooms with
`room-read-only` once the owner crosses the limit, and up to about 5 s of
edits admitted before that may save. The open editor drops to view mode under
the read-only strip and discards its unsaved edits. When the storage owner or
the actor is `over_quota_frozen`, the same admission points refuse with
`account_over_quota` (see the authorization doc). Creation and upload
reservations (`gateStorageTx`, `reserveStorageTx`) and the Office publication
net-growth check stay.

## Reservations and clones

Direct B2 uploads and editor-asset reservations call `reserveStorageTx`
before the client receives a signed PUT URL. Reserved bytes count toward the
gate immediately so concurrent uploads cannot double-spend remaining quota.
Finalize converts reservation → used (via status transitions / triggers).
Expiry marks the session expired and releases the reservation in the same
transaction before best-effort blob cleanup (cleanup details in the
authorization doc).

A collaborative source is charged its source bytes (`files.size_bytes`) plus
the generated `source_documents.storage_bytes` (migration 0054): its serialized
pending effects (an empty list costs nothing, so opening a file charges only
its source), plus its stored editing state beyond what the file's bytes already
hold (migration 0043 dropped the stored baseline; it derives from the base).
Edits a publication captured are charged once, in the file:

- An Office state is charged as stored: the change over seed(base) that the
  service stores for every Office state, including one a publication rebased
  onto seed(export) (a one-edit DOCX or PPTX row is under 1 KB).
- While a deferred publication waits for its rebuild (`rebuild_pending`), the
  file is the published capture, and the state still holds that capture over
  seed(old base) plus the edits saved since. The state is charged only beyond
  the capture (`max(0, state - published_state)`, both changes over the same
  seed); a refused rebuild keeps that charge, and a republication measures it
  against its own capture. The rebuild's state, a change over seed(published),
  is charged as stored again, and the trigger books the difference.
- A text state keeps its lineage across publications and is stored whole, so
  it is charged its growth beyond `seed_bytes` (`max(0, state - seed_bytes)`).
  The first save records the seed's size, and each text publication adds the
  change in the file's size: the published text is in the file's bytes now,
  and Yjs stores text as its UTF-8 bytes. What stays charged is Yjs history
  (deleted structs and item metadata; source states are never compacted, and
  the 100 MiB state cap bounds them) and edits after the capture. Migration
  0054 gave every existing text state the seed size of its file (seed(text) is
  the text plus 15–18 bytes). `seed_bytes` is recorded for text only (a CHECK
  keeps it 0 for Office rows).

A NULL state is the seed and costs nothing: a save with nothing changed stores
nothing, so opening and saving leaves the state NULL, and a publication without
later edits returns the state to NULL. A refresh candidate, its export, the old
base and the published capture's own copy (`published_state`) are uncharged
while transient: admission does not gate on them, and publication gates the net
change of the file's bytes and its source row. Before a parse is paid for,
finalize refuses (except for system jobs) what publication would certainly
refuse: the new bytes minus the old, plus a source row with no state or
effects, minus the current row. Reconciliation sums the same columns. Owner
changes transfer the charge with the file. A checkpoint is not gated on quota
(edits are admitted by the room, see view-only at the limit); finalize and
publication run under source/workspace/account locks and gate the net growth.
Negative changes remain negative ledger deltas.

Maintenance-window publications (`paid_by='system'`, see the
[deployment runbook](deployment-runbook.md#office-maintenance-window)) skip the
storage gates at finalize and publication, so an over-quota owner's saved edits
still publish; the resulting deltas still land in the owner's ledger. An
export-only publication replaces `files.size_bytes` with the export's size,
returns the state to NULL (seed(export); through the handoff, a later save's
state rebased onto the export instead) and drops the index; the automatic
export of a store-only file is gated at finalize and publication, like a
refresh. A window's reset drops the states of the reset formats and keeps no
copy.

A candidate retains old A and exported B temporarily. Successful Office handoff
rebases the latest saved state onto seed(B), clears Undo/Redo and releases A.
The state keeps no package parts of A: a later edit that needs content B
dropped fails the publication instead. Text retains its existing editing
lineage. Shared caption payloads are platform
artifacts referenced by containing resources; published clones attach their
own references and exclude unpublished captions. A failed candidate cannot remove
the currently published source/index.

Editor assets upload through the material that uses them
(`/api/materials/{id}/editor-assets/uploads`, any editor of the material).
Every asset names that material (`editor_assets.material_id`). A workspace
material's asset also names the workspace and is charged to its owner; a
standalone note or quiz's asset is charged to the material owner, the only
account that can edit it. Images uploaded through a quiz are capped at
2 MB before any bytes are reserved (`quizImageMaxBytes`); the quiz editor
shrinks a larger image first (`src/features/quizzes/quizImage.ts`: long side
to 2000 px, WebP at falling quality, animated GIFs refused) and holds it in
the browser under a local id, previewed from an object URL, until Save
uploads the referenced ones and swaps in their asset ids
(`src/routes/QuizEdit.tsx`); a picked image the user abandons never reaches
storage, and a failed upload fails the save. Notes keep the
20 MB image limit and bank figures keep their own. Every material content
write (the PATCH and the collaboration projection behind live editing, agent
and bank-copy edits) deletes, in its transaction, the material's `ready`
assets the new content no longer references and that completed more than 60
seconds ago (`pruneMaterialAssetsTx`), so the row triggers release the bytes at
once. The minute covers a shared note: the image node's asset id reaches the
server a moment after the upload completes, and a collaborator's save in that
window must not delete it; an image removed within the minute goes at a later
save. The same save deletes an interrupted flow's leftovers: an upload or paste
copy whose node never landed (the tab closed) and quiz or flashcard images
uploaded by a Save whose content PATCH failed. Embedded quiz and flashcard
rows follow the same rule (trashed, see
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md)).
Pending reservations are left to the upload expiry. Purging the material
deletes the rest through the `material_id` cascade, including leftovers of a
material never saved again; there is no periodic sweep. Both write to an `editor-assets/incoming/…` key and are promoted to
an unpresigned stable `editor-assets/{id}/…` key before finalization, so the
still-valid upload URL cannot overwrite a ready object. If creating the
durable DB row fails after a source object was written, handlers delete the
orphan object.

Pasting an image that belongs to another note or quiz calls
`POST /api/materials/{id}/editor-assets/adopt` with `{"assetIds": [...]}`
(1–50 distinct ids, any editor of the target, upload rate class). The response
`{"assets": [{"sourceId", "assetId"}]}` has one entry per requested id in
request order: the same id when the asset already belongs to the target, a new
ready row for the target when the source is ready and readable by the caller
(the resolve rule), and no `assetId` otherwise (deleted, unreadable, pending,
unknown). A copy shares the stored object under blob refcounting and is
charged to the target's payer like an upload, and counts as just completed,
so the 60-second rule keeps it until the pasted node is saved. A bad body is
400, a non-editor 403 (404 without read access), and the whole call fails with
`storage_quota_exceeded` (403) when the copies do not fit. One transaction
locks the target scope, share-locks the source rows, locks their blob paths in
order and gates the quota (`AdoptEditorAssets`).

Workspace clones snapshot the source, gate the total file + material + ready
editor-asset payload against the **cloner's** quota, copy ready asset rows
with new logical IDs (rewriting embedded references; each asset names the
clone of its material, and a trashed material's assets are left out), and reuse physical blob
paths under reference counting. Only `ready` source files are copied; pending,
processing, and failed files are omitted. Material nodes (and quiz image blocks) referring to a pending,
failed, missing, or otherwise uncopied editor asset are removed from the cloned
document instead of retaining an unrenderable source id. The material's
current content and cloned logical assets are the storage-accounted payload.
Before writing cloned rows, the transaction locks every copied source,
and ready editor-asset blob refcount in stable path order. The
last source reference therefore cannot queue and reap a physical object until
the clone commits. A path deleted after the repeatable-read snapshot causes a
transaction retry instead of a clone that points at missing bytes.

A single-material clone is always a new **private standalone** material. It
copies only ready editor assets referenced by the current SQL projection, gives
each asset a fresh logical ID owned by the copy of the material whose content
uses it (a note's embedded quiz keeps its own images), rewrites the document, and
charges the asset bytes to the cloner. Physical object paths remain shared through blob
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

Source text states are not compacted. Their history grows with the number of
separate edits (and the contributor markers each save writes and clears), not
with the file's size: garbage collection drops deleted content and merges
adjacent deletions, leaving a few bytes per edit, so a paste deleted again
costs a few bytes. Three publications of 1 KB typed into a 2 KB `.md` left
195 bytes charged (bench/parsers/reports/2026-10-05-office-storage-charging.md).
Compacting at publication would move the lineage (epoch) every time a text
file auto-publishes, so it is deferred; if history ever matters, compact past
a size threshold while the room is empty, as the Office rebuild does.

Compaction takes a Redis eviction lease so every collaboration instance
flushes, closes clients, and unloads the room; rebuilds a fresh Y.Doc from
the projected Plate `materials.content`; clears in-memory pending
checkpoints; keeps `stored_version` / `projected_version` equal; and
increments `room_schema`. Tokens, Redis events, service commands, and client
Y.Docs bind to that epoch so a stale client cannot merge pre-compaction state
back in. A discard that throws unsaved room state away increments
`room_schema` too, keeping the state (see
[plate-editor.md](frontend/plate-editor.md#document-limits-and-rejection)).

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

A document over a product shape bound must not grow in serialized size, node
count, or depth. Structural validation does not apply those caps, so a valid
document that starts over a limit can still shrink back towards it. The
TypeScript and Go metric walks count every node through the shared structural
depth ceiling, so growth below an already-over-limit deep branch cannot hide
behind unrelated deletions. A live Free subscription by itself is an ordinary
active account. The sidecar treats an account as frozen, and its rooms as
read-only, only when it sees an expired or closed Pro boundary at least 14
days old and usage over the Free limit, matching Go's account resolver. It
treats a material as view-only when its owner's stored plus reserved bytes
reach the current plan's limit (`fullSQL`, matching `StorageUsage.Full`);
`TestCollaborationFrozenSQLMatchesGo` runs both statements against Go.

Sources: [storage gate and reconciliation](../server/internal/store/storage.go),
[material bounds](../server/internal/materialdoc/document.go),
[collab limits](../collaboration/src/limits.ts),
[collab document validation](../collaboration/src/materialDocument.ts),
[compaction config](../collaboration/src/config.ts).

## Text field limits

`server/internal/fieldlimits` is the single source of truth for user-visible
text lengths, counted in runes. Request fields carry them through the named
types in `httpapi/apimodel/limits.go` (a `huma.SchemaTransformer` sets
`maxLength`), so `openapi.yaml`, the orval validators in
`src/api/gen/validators.ts`, and `pipeline/pipeline/generated/limits.py`
(rendered by `cmd/openapi -python-limits`) all derive from the constants.
`0001_init.sql` repeats each value as a `char_length` CHECK and
`TestColumnLimits` fails when a CHECK and its constant disagree, in either
direction.

| Field | Runes |
| --- | ---: |
| Workspace name / description | 80 / 500 |
| Chapter name (add, update, upload, import) | 60 |
| File name (upload, import, rename, editor asset) | 120 |
| Material, quiz, flashcard set, canvas, generate title | 120 |
| Conversation title | 60 |
| Event title / location | 60 / 100 |
| Task title | 80 |
| Label name, tag value | 35 |
| Email (invite identifier, deletion confirm, users.email) | 254 |
| Profile name | 60 |

User-typed values are rejected with a 422; the source details dialog refuses
oversized file names before upload. Values the user did not type are clamped
before insert: Clerk profile names on the first insert (the profile sync runs
on every authenticated request, so a rejection would lock the account out; an
oversized Clerk email is dropped and the stored email kept; a name typed later
through `PATCH /api/me` is user input and gets the 422),
LLM-authored material titles and editor asset names (both
extension-preserving), workspace clone names (suffix-preserving), and
auto-derived conversation titles.

A workspace holds at most 20 chapters (`MaxChaptersPerWorkspace` in
`store/store.go`), checked when a chapter is added and when an upload creates
one by name; the 21st is refused as 409 `too_many_chapters`. The chat agent
lists every chapter on each model call, which is what the cap bounds. A clone
copies its source's chapters as they are.
