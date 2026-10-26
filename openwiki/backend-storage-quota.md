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

`plan_limits` (`server/migrations/0001_init.sql`, image cap added in `0069`, 2 MiB on every plan since `0114`) is the canonical backend
catalog for every numeric limit that may vary by subscription plan:

| Limit                           |                       Free |                        Pro |
| ------------------------------- | -------------------------: | -------------------------: |
| Storage                         | 100,000,000 bytes (100 MB) | 1,000,000,000 bytes (1 GB) |
| Monthly credits                 |                        200 |                     10,000 |
| Source file                     |                     10 MiB |                     30 MiB |
| Material daily-history entries  |                          3 |                         30 |
| Owned workspaces                |                         10 |                         50 |
| Files per workspace             |                        100 |                        100 |
| Files per upload/import request |                         20 |                         20 |
| One uploaded image              |                      2 MiB |                      2 MiB |

Monthly credits are the allowance only: every account also starts with a
one-off 800-credit grant in its never-expiring purchased balance, and top-ups
add to that balance (`observability-metering.md`, purchased credits).

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
limit requires updating that file, the affected Paraglide translations and the
`welcome`, `subscription-started` and `subscription-cancelled` email templates
along with the SQL seed. APIs may still return a requester's effective current value,
such as workspace `filesLimit`, upload-policy `maxBytes`, and billing counters.

Subscription projection remains owned by the Stripe lifecycle code. Request
gates do not trust a stale projected Pro tier past the latest paid
`current_period_end`: Go, Python and the collaboration server apply Free limits
48 hours after that boundary (the renewal tolerance, so a late renewal webhook
never lapses a paying account), even before a delayed webhook reconciles
`users.plan_tier`. Accounts without a
dated subscription retain their stored tier for local/operator fixtures.

## What counts

Storage is charged once per logical row owned by a user:

| Resource      | Counted size               | Charged when                  |
| ------------- | -------------------------- | ----------------------------- |
| Source files  | `files.size_bytes`         | row exists                    |
| Editor assets | `editor_assets.size_bytes` | `status = 'ready'` only       |
| Materials     | `materials.size_bytes`     | always; set from content JSON |
| Trashed rows  | same as above              | until the 30-day purge        |
| Chat Undo     | none                       | never: the loaded room holds it in memory (Epo 2026-10-20) |

**Uploader pays** (Sam 2026-10-18, Google Drive's My Drive model). The payer
of a row is the account that uploaded, imported, cloned or created it, in any
workspace: `files.user_id`, `upload_sessions.user_id`, `editor_assets.user_id`
and `materials.owner_user_id` are set once at insert from the actor (a BEFORE
INSERT trigger fills an omitted one from `created_by`, migration 0095) and
never re-derived. A collaborator's upload, note, quiz, flashcard set, clone or
deck is charged to the collaborator, and so are the images and audio it adds
inside someone else's note, quiz or set, uploaded, pasted or placed by the
chat agent for it (Epo 2026-10-24, M16): `lockEditorAssetScopeTx` returns the
actor, whose plan caps them. An embedded quiz or set row is charged to its
note's payer instead (Sam 2026-10-19): `createMaterialTx` gives an embedded
row its parent's, and a pasted embedded block's copy is the note's payer's
too, while the images it copies are the paster's, under the paster's image
cap (`AdoptEmbeddedMaterials`). A material's view-only state follows only its
own payer: an uploader at its limit just cannot add more, and nobody adds
media to a material whose payer is frozen, or at its limit
(`assertMaterialNotFullTx`, so nobody pays for a node the material could not
save). A workspace
ownership transfer moves no charges (`TransferWorkspace` only swaps roles and
still checks the recipient's owned-workspace and file caps). A member who
leaves or is removed keeps paying for what it added; the items stay in the
workspace, and the Files page (files, blocks, trash), which lists only what the
caller pays for and so adds up to its storage meter (Sam 2026-10-19), still
lists them. One the payer can no longer open is marked `lostAccess`
(`lostAccessSQL`: not the owner and no reach as member, public share or
redeemed link, or the owner's account is no longer live) and shows only its
name, size, workspace and creation time (`lostFile`, `lostMaterialItem`; the
updated and workspace sorts page on those shown values, so no cursor carries
what it hides), the workspace name red behind an error icon, and the payer
may delete it (trash, then purge) but not
open or restore it (`PaysFor`, `lockTrashActorTx`, `lockTrashOwnerTx`). Trash
offers Restore only where the caller may edit the workspace (`canRestore`). A
deleted, deleting or suspended owner's workspace also loses its name there
(`workspaceNameSQL`; the card reads "Unavailable workspace"), as every other
read of it answers 404, yet its payer still trashes and purges what it pays
for there (`lockWorkspacePayerTx`, which needs only the payer live; Sam
2026-10-19). Every image and audio clip it pays for is listed on the Files
page's Embeds tab (Epo 2026-10-24; `GET /api/editor-assets`,
`ListEditorAssets` on `editor_assets_payer_idx`, migration 0110), named by
its note's current title (an embedded quiz's or set's note), with its kind,
size, workspace and added time, and `lostAccess` once the payer can no longer
open that note (`lostAccessSQL` on the note's workspace). The tab's filter
(`access=open|lost`) shows one kind, loaded afresh on each switch; pages are
keyset (newest first, ties by id) within the caller's own rows. Title and workspace name are blank once
that workspace's owner is no longer live. Media in a trashed note or set the
payer can still open are left out; they go with that material's trash and
purge. One it can open opens its note. Every one can be deleted by its payer
(Q273; `DELETE /api/editor-assets/{assetId}`, `DeleteEditorAsset`: the payer
and a ready row, wherever it sits and whatever the payer may still do there;
a frozen payer deletes, a suspended or deleting one cannot). Deleting one is
final, because a trashed asset would come back with the note's next save, and
it does not edit the note: the note keeps the node:
the material response lists the ids its own content references that no
longer exist in `removedAssetIds` (`MissingEditorAssetIDs`), and an embedded
quiz's or set's own response (quiz or material) lists its own, as do the
study reads: the flashcard set (`MaterialRemovedAssetIDs`) and a review
session for the items it has still to answer, while a quiz attempt reads the
quiz's. Graded copies (a past attempt's result, a review result, the answered
items of a continued session) name none and keep the plain empty box, since
their image may have been removed normally (Q270).
The app shows each such block as removed by its uploader instead of loading
it, in the editor, embeds and study screens; when a block fails to load while
the material is open, it fetches the material's list again, so media deleted
meanwhile read as removed too (not in a review session, which a new fetch
would replace).
Deleting an account deletes everything it pays for, in other people's
workspaces too (`PurgeUser`), its images and audio in other people's notes
included, which then read as removed. For a workspace material, `owner_user_id` is only the payer:
access, the owner role and the owner's lifecycle (deleted, suspended) follow
the workspace (`materialEffectiveAccess`, `live_access`).

A curated material's `provenance` record is **never charged** — `size_bytes` is
the content JSON alone — and its marshalled bytes are counted by `gateStorageTx`
at material creation only, never on an `edit_document` merge and never on a
clone.
A chat deck's PPTX follows the same rule: `files.size_bytes` is the PPTX
alone, and its provenance bytes are counted with it at creation only
([decks.md](decks.md)).

Storage limits are **100 MB** free and **1 GB** Pro. These use decimal bytes:
100,000,000 and 1,000,000,000 respectively.

Per-file **source upload** caps are separate from that quota. Editor assets
take the uploader's plan by purpose (`planlimits.Limits.EditorAssetBytes`): images
the plan image cap, audio this per-file cap (Epo 2026-10-15), on upload and on
a pasted copy (`AdoptEditorAssets`); a note holds no other asset. An image
uploaded as a source takes the source cap, not the image cap, after the browser
shrinks it to 5 megapixels ([Image compression and checks](#image-compression-and-checks)). They follow the
**uploader's** plan, create-only (no retroactive invalidation): **10 MiB**
free, **30 MiB** Pro (from the startup plan snapshot). GPU/LLM cost is metered
elsewhere. `GET /api/source-upload-policy` returns the caller's own cap, which
the dialog enforces before it asks for a ticket; an Office file or an image
the browser compresses is checked after compression instead, in its transfer
row, and refused in the dialog only past 256 MB (Q345). The material response
carries the reader's own editor caps, since what it adds is charged to it
(M16), as `imageMaxBytes` and `audioMaxBytes`, which
`uploadEditorAsset` checks the same way (Epo 2026-10-22); the server keeps
its own checks. Uploads stream through the API host, which Cloudflare
proxies with a 100 MB request body limit; the 30 MiB largest per-file cap stays
well under it.

Office parsing keeps its structured handoff temporarily on the ingest host, with
no durable B2 parse cache or preview PDF. Temporary parse output is a platform
cost and does not increase `files.size_bytes` or user storage usage. Migration
0016 removes the preview columns; migration 0038 releases the B2 parse caches.
Native PDFs reuse `blob_path`.
File thumbnails (`files.thumbnail_key`, one small WebP per file), text-source
previews (`files.preview`) and material list previews (`materials.preview`) are
likewise a platform cost: never charged, no reservation, and `size_bytes` stays
the source or content alone ([thumbnails.md](thumbnails.md)).
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

`gateStorageTx` (creations, upload reservations, clones) locks the counter, unfolds pending deltas, checks the owner's
lifecycle `CanEdit` (active or grace), then enforces
`used + reserved + requested <= plan limit`. The limit is the effective plan's,
which is Free once a paid period has lapsed, so a grace account (over the Free
limit by definition) fails this check exactly like an active account at 100%.
Deletions and shrinks do not go through that gate; they adjust
counters/triggers for accounting only.

Reconciliation (`reconcileStorageUserTx`) locks the counter row and the
owner's files, editor assets, materials and pending upload sessions, recounts
used bytes from files, `source_documents.storage_bytes`, ready editor assets
and materials and reserved bytes from pending uploads (`storageRecountSQL`),
and deletes the folded delta rows. Two known gaps, fix deferred: it locks no
`source_documents` row, so a
save committing between its delta read and the recount is counted twice until
the next run; and its `storage_counter_drift` report compares the counter
without the pending deltas, so it reports drift whenever deltas are pending.

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
admission (`StorageUsage.Full`), which makes what an account pays for
view-only at `full` (see view-only at the limit).

- `GET /api/me` → `account.storageUsage`, with `storageUsedBytes` (used plus
  reserved) and `storageLimitBytes` filled for every account.
- Workspace responses carry no storage level: the workspace status (header
  triangle and entry toast) reads the viewer's own `/me`, since what the viewer
  adds is charged to the viewer. Another payer's full storage shows on its
  items instead (`storageFull`, below).

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
`materialdoc.NewProjection`, which still validates and canonicalizes the
Plate envelope but does not apply the product caps.

The browser applies its own, independent render threshold
(`MATERIAL_RENDER_WARNING` in `src/lib/const.ts`) to decide when opening a
document is worth a warning. It is deliberately not derived from these bounds.

**View-only at the limit.** No save-time storage gate exists for materials
or source checkpoints: growing an existing material or a source's editing
state only updates the ledger. Instead, while an account is at or over its
limit (usage level `full`, grace included), every item it pays for is
view-only for everyone, the rest of the workspace staying editable:

- `assertContentEditableTx` (`server/internal/store/account_state.go`) refuses
  REST content writes (quiz and flashcard content, cards), comments and PDF
  marks with `storage_quota_exceeded`;
- `SourceSession` and material collaboration tokens come back `read`, and
  `CheckSourceAccess` refuses a source edit with the same code;
- material capabilities carry `canEditContent` (edit mode, comments,
  annotations) beside `canEdit`, which keeps renaming, moving, reordering and
  trashing; workspace capabilities no longer narrow for storage;
- the material response, the Office/text source session and a file's links
  carry `storageFull` (`self` when the viewer pays, `payer` otherwise) to
  those who could edit the item (a viewer was never editing, so gets none),
  and the item opens view-only under a strip below its header: "Your storage is full."
  or "Owner of the file has insufficient storage." (`StorageFullBanner`); a
  refusal without numbers (another payer's item) toasts the same words;
- workspace chat drops the agent's create and edit tools when the actor (who
  pays for what the agent creates) is full, and generation is refused with
  `storage_quota_exceeded` (`StorageFullErr`) before any credits are reserved
  or spent.

Enforcement is at admission only, like frozen: the collaboration service's
5 s writer recheck (`full_sql` in `collaboration-rs/crates/server/src/access.rs`, mirrored
by `StorageUsage.Full`, both on the material's payer) closes every writer in
the payer's rooms with `room-read-only` once it crosses the limit, and up to
about 5 s of edits admitted before that may save. The open editor drops to view
mode under the read-only strip and discards its unsaved edits. When the payer
or the actor is `over_quota_frozen` (or the payer is suspended or being
deleted), the same admission points refuse with `account_over_quota` (see the
authorization doc). Every write that changes a material's bytes locks the
payer's account row with the owner's and the actors' in one ordered batch:
the collaboration server's saves and agent edits (`lock_boundary`, which
refuses any deleted, deleting or suspended account in that batch, actors
included, before it locks the material, so it never waits on a row `PurgeUser`
holds), and Go's projection
(`ProjectMaterialContent`) and `UpdateMaterial` (`lockWorkspaceMutationTx`'s
extra accounts), and a source edit or checkpoint save locks and checks the
file's payer the same way (`sourceLockTx`, `sourceEditLockTx`). Ingest and source refresh fence the file's payer beside the
workspace owner and the actor (`_pipeline_source_cancellation`,
`_lock_source_candidate`). Creation and upload
reservations (`gateStorageTx`, `reserveStorageTx`) and the Office publication
net-growth check stay.

## Reservations and clones

Source uploads and editor assets stream through the gateway (Epo 2026-10-22):
one multipart request (`POST /api/workspaces/{id}/sources/uploads`,
`POST /api/materials/{id}/editor-assets/uploads`; raw chi routes, outside the
OpenAPI spec) whose first part, `metadata`, is the upload's JSON and whose
second part, `file`, is its bytes (`uploadSource`, `uploadEditorAsset`,
helpers in `server/internal/httpapi/uploads.go`). The request body is capped
(`http.MaxBytesReader`) at the payer's per-file cap plus 64 KiB of metadata
and framing. From the metadata the gateway reserves storage as before:
`reserveStorageTx` on the uploader's counter, for a source and an editor
asset alike (M16). Reserved bytes count toward the gate
immediately so concurrent uploads cannot double-spend remaining quota. It
then spools the file part to a temporary file, hashing it (SHA-256) as it
streams, and refuses a part whose type differs from the metadata's or whose
length differs from the declared size; an editor asset's first bytes must also
carry its type's signature. The spooled bytes go to the final key
(`sources/blob_…`, `editor-assets/{id}/blob_…`) in one PutObject
(`blob.Store.PutObjectOnce`, no SDK retries) bounded at 60 s, which logs one
`upload b2 put` line with the upload id, `duration_ms` and `outcome` (ok,
error, timeout; never keys or URLs; Epo 2026-10-21, kept 2026-10-22). Spooling
first keeps the bound on B2 alone, not on the browser's upload. The same
request finalizes, on a context the browser's leaving cannot cancel (the bytes
are stored by then): a source's file row and first pipeline job, with the hash
as `files.source_sha256` for every source kind (so the first source session
names its base and the device copy works from the first reopen, Epo
2026-10-17), or the editor asset's ready row. Only source files record their
SHA-256: an editor asset is hashed while it streams, but `editor_assets` has no
column for it. Finalize converts reservation → used (via status transitions /
triggers). Any failure after the reservation releases it (`MarkUploadExpired`,
`MarkEditorAssetUploadExpired`), which also queues the key in
`pending_blob_deletions`; the reaper deletes an object a timed-out PUT may
still have landed only once nothing references it, so the request never
deletes inline and answers right after the PUT's bound. A PUT past its bound
answers the generic 500, which the browser shows as a server error to try
again; nothing retries it. A session that expired or changed state while its
body streamed answers 410 or 409. A refusal (400, 413, 403/404) is answered
without reading the rest of the body, with `Connection: close`. The upload's
parse download is its only B2 egress.

An upload first takes a ticket in the gateway's line (Epo 2026-10-22,
`server/internal/httpapi/upload_queue.go`): `POST …/sources/uploads/tickets`
or `POST …/editor-assets/uploads/tickets` with the upload's metadata as JSON
(its body has 10 s to arrive). The ticket keeps the file name, size, type
and, for a source, batch it was issued for; an upload whose metadata differs
is refused (400, its ticket's batch counting the file). The ticket runs the
checks its upload repeats (editor access, the metadata's
bounds, size, type, parse pages and credit headroom) and the reservation's
gates in a rolled-back transaction (`AssertSourceUploadRoom`: the uploader's
account and storage and the workspace's file cap; `AssertEditorAssetRoom`:
the scope's locks and the uploader's storage), so an upload that would be
refused never waits. The reservation itself still happens when the upload
starts, and gates again; a ticket holds none. Running uploads share a
budget of 1 GB of declared size, the temp disk their bodies spool to; at most
256 run at once, a sanity bound on connections, and at most 4 of one user's
(Epo 2026-10-22; no per-user byte share, Epo 2026-10-24, Q245). Held turns
count as running. A ticket whose file fits the budget, whose user is under 4
and that no blocking ticket holds back answers `{ticketId, position: 0}` (its
turn), else it waits with its place (1 is next). Freed bytes go to the line
oldest first: a ticket whose user is at 4 is passed by, so one user's fifth
file waits while other users' files run,
and a file that does not fit is passed by smaller ones that do until it has
waited 30 s; from then on it blocks every file behind it until it fits, so
small files cannot starve a big one. There is no minimum send rate: the
size-scaled body deadline and the 4 per user bound a slow upload. A ticket
past its user's upload rate class (observability-metering § rate limits)
waits in the line too instead of a 429 (Epo 2026-10-24, Q282): the ticket
takes the class itself (`ratelimit.Limiter.TakeUpload`, not the middleware),
and one the class refuses gets a place, asks the class again once its
retry-after passes (every 5 s while Redis cannot answer), and joins the
line's order when admitted; until then it neither gets a turn nor blocks the
line, and the browser shows it queued. A ticket whose class Redis cannot
count is refused (503 `rate_limit_unavailable`). Source and editor-asset
tickets share the line and the class; imports do not take tickets and keep
their 429. The line holds 2,000 waiting tickets that spent their class token
(Epo 2026-10-24, Q318) and 20 of one user's, waiting on the class or not; a
ticket waiting only on its class counts toward its user's 20 alone, and its
wait clock (the 30 s before it blocks) restarts when the class admits it
(Q307). Past either limit the ticket is refused with a typed 503,
`upload_queue_full` (busy, try again), before it spends a class token: a
ticket takes its place under the line's lock, then spends its token outside
it, so a slow Redis delays only that ticket (Q350). While it asks it holds
its place and counts toward both limits, but gets no turn and blocks
nothing. The 2,000 is soft: a ticket the class admits later joins without a
check, and under a burst so can tickets that would start at once as they take
their place but do not once their class answers. Each user's 20 holds from
the moment a ticket takes its place. The browser long-polls
`GET /api/uploads/tickets/{id}?position=N`, which answers at once when the
turn comes, when the ticket's place differs from N but no sooner than 2 s
after the ask (so a fast line costs a browser one poll per 2 s, inside the
per-user rate limit), and otherwise after 25 s, under Cloudflare's 100 s. A
turn holds its bytes for 30 s; an upload that has not started by then passes
them to the line, and its own upload is refused. When waiting or
the upload fails in the browser (a cancel, the row's remove button, a closed
editor or dialog, or a refusal), it gives the ticket back with
`DELETE /api/uploads/tickets/{id}` (its owner only), which hands the
ticket's place, or its turn's bytes, to the line at once. The browser never
retries an upload itself (Q282). A source ticket given back counts at once
as a failed file of its batch, or as a removed one when the user removed its
row (`?reason=removed`). Any other reason is a 400. Giving back a ticket the upload already spent is a
harmless 410. An abandoned tab sends nothing, and its ticket waits for its
turn to pass. The upload carries
`?ticket=` and is refused before its body is read when the ticket is missing,
unknown, another user's or another route's, spent, given back or passed
(410 `upload_ticket_gone`, which the browser shows as "Your turn to upload
passed. Try again."), or still waiting (409). Its bytes go back to the budget when the upload request ends, however it ends (finished, cut off or refused). The upload has
30 s plus its declared size at 100 KB/s, at most 5 minutes, from the
gateway's first read of its body to send it (`bodyDeadline`, Epo 2026-10-22:
a 1 MB file 40 s, a 30 MiB file the full 5 minutes; the connection's read
deadline, lifted once the body is read so it never cuts the PUT); past that
it answers 408 `upload_timeout`, which the browser shows as
"The upload took too long. Try again." (a connection dropped
before the answer reads as a network error), and releases its reservation
like any failure.
The line lives in the API process, which runs as one instance; a scaled-out
API would need it in Redis. A restart forgets it: a waiting browser's next
poll is refused 410 and the user tries again (so is a ticket that a deploy's
overlapping old container issued). A source ticket whose turn passes counts at
once as a failed file of its batch, so the batch's notification does not wait
for the idle sweep (`SourceBatchIdle`, 1 h). The transfer panel shows a waiting file as "Waiting to upload (position
N)"; an editor asset's placeholder waits without a place. Each panel row has
a remove button that cancels its file (Epo 2026-10-22, `removeSourceTransfer`),
labelled "Remove" while the file waits, uploads or imports and "Hide" once it
is finished, failed or in the background.

A removed file counts as removed in its batch (Epo 2026-10-22). A file not
yet sent is never sent:
it asks for no ticket and counts at once as removed in its batch with
`POST /api/workspaces/{id}/sources/batches/{batchId}/removed` (`{source,
total}`, upload rate class, an editor of the workspace only; it opens the
batch when none of its files has reached the server, a batch id held by
another submission is a 409, and a removal that would take the batch past its
total is ignored). A ticket request is never aborted: a file removed while its
ticket request is out gives the ticket back once it answers, and a waiting one
gives its ticket back as removed (`?reason=removed`), so a removed file is
counted once. A running upload is aborted, which the gateway counts as failed.
An importing file's removal aborts its import request; it counts as removed
when the server holds nothing of it (not yet requested, or waiting to retry
after a 408, 429 or 5xx), and is otherwise left to the server, which counts
the import (an import already queued keeps going). So the batch's notification
no longer waits for the idle sweep, and it reports removed files as removed; a
batch whose every file was removed closes without one.

A drive import keeps its own completion (`internalCompleteSourceImport`): the
import worker writes an `incoming/` object, and the gateway checks its size and
type by HEAD (a missing type is a mismatch: the worker writes it), promotes it
to its `sources/` key, and, for a file with source sessions (DOCX, XLSX, PPTX
and text), reads it back once and records its SHA-256 in the finalize
transaction. The gateway hashes the stored bytes itself: Backblaze documents no
checksum header on PutObject that the bucket would verify, and the
collaboration server checks every original it loads against this SHA. Bytes
read back at another size than the HEAD reported refuse the completion (409;
the upload stays pending). Ingest still hashes its own download and writes the
same value (its cache key, and the SHA of files uploaded before this); the
first save no longer writes the file's SHA.
Expiry marks the session expired and releases the reservation in the same
transaction before best-effort blob cleanup (cleanup details in the
authorization doc).

A collaborative source is charged its source bytes (`files.size_bytes`) plus
the generated `source_documents.storage_bytes` (migration 0075, which added
the unfolded update rows to 0054's rule): its serialized pending effects (an
empty list costs nothing, so opening a file charges only its source), plus its
stored editing state and unfolded rows (`log_bytes`) beyond what the file's
bytes already hold (migration 0043 dropped the stored baseline; it derives from
the base). Below, "state" means the stored state plus `log_bytes`; a fold
moves bytes from the rows into the state.
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
  a room's state cap bounds them: its seed plus the 30 MiB export cap less
  the base file and a 1 MiB margin) and edits after the capture. Migration
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
effects, minus the current row, all on the file's payer. The plan file limit
does not refuse a publication (Epo 2026-10-19): an export over it publishes,
up to the 100 MiB source ceiling, and the file freezes at its size limit (no
growth budget; [office-files.md](frontend/office-files.md)). Such a file is
still past the cap a clone checks, so a clone refuses it (`file_too_large`).
Reconciliation sums the same columns. A checkpoint is not gated on quota
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
material's asset also names the workspace. Every asset is charged to its
uploader (Epo 2026-10-24, M16), who alone completes its reservation. Every
editor image (note, quiz, flashcard set, and a pasted copy through the
children pass) is capped by the uploader's plan image cap, checked before any
bytes are reserved; the material response carries the reader's as
`imageMaxBytes`. The browser
compresses every image first (`src/lib/fitImage.ts`, called from
`uploadEditorAsset`; [Image compression and checks](#image-compression-and-checks)),
and the gateway reads its header. An image inserted into a DOCX or PPTX file takes the
same cap from the plan of the file's payer (its uploader): the
Office edit session (`GET /api/files/{id}/source-session`, Office formats)
carries it as `imageMaxBytes`, the edit `load` hands it to the Office runtime,
and the editors' `prepareImage` hook fits the picked file before its bytes
reach the document (`fitImage` with `office`, Epo 2026-10-13). Older Word,
PowerPoint, LibreOffice and Google Docs imports open only PNG, JPEG and GIF
inside DOCX/PPTX, so every other type (WebP, AVIF, BMP, …) is re-encoded
whatever its size. A refused image leaves the document as it was and Capy
shows the "image too large" notice (the runtime's `image-too-large` notice);
one no decoder reads (SVG, or a file the lazy HEIC, TIFF and JPEG 2000
decoders reject) is refused the same way with "This image type can't be
inserted." (`image-type`).
DOCX picture watermarks take the same path. The collaboration server checks
each picture an edit adds (Server checks below).
A note's audio is capped by the uploader's per-file cap (10 MiB Free, 30 MiB
Pro) at the reservation. The browser checks it first against the material's
`audioMaxBytes` (Epo 2026-10-22): a file over it asks for no ticket and its
placeholder shows "The selected file is larger than N MB."; an image still
over `imageMaxBytes` after shrinking is refused the same way. Notes hold no other
asset: the purposes are `image` and `audio` (Epo 2026-10-15; the table's
`purpose` check still lists the old `pdf` and `file`, unused).
Quizzes and flashcard sets edit live (Epo
2026-10-10, D6): a picked image is shrunk and uploads at once, and the block
or card takes its asset id (`quizImageUpload` in
`src/features/quizzes/QuizForm.tsx`, `src/features/flashcards/CardDialog.tsx`;
a card's image is `image: {assetId}` on its `flashcard` node); an image the
user abandons is trashed, hidden, by the next projection, as below. Bank figures have a flat 4 MiB
cap ([question-bank.md](question-bank.md)). Every material content
write (the PATCH and the collaboration projection behind live editing, agent
and bank-copy edits) trashes, in its transaction, the material's `ready`
assets the new content no longer references and that completed more than 60
seconds ago, and restores trashed ones it references again
(`pruneMaterialAssetsTx`). A trashed asset (`editor_assets.trashed_at`) stays
charged and keeps its object; the trash sweep deletes it a day later
(`PurgeTrashedEditorAssets`, from `runTrashSweep`), one row per transaction
under the payer's storage lock, so the row triggers release the bytes then.
The minute covers a shared note: the image node's asset id reaches the server
a moment after the upload completes, and a collaborator's save in that window
must not trash it; an image removed within the minute goes at a later save.
The same save trashes an interrupted flow's leftovers: an upload or paste copy
whose node never landed (the tab closed), including quiz and flashcard
images whose question or card never reached the live room. Embedded quiz and flashcard rows follow
the same rule (trashed for a day, see
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md)).
Pending reservations are left to the upload expiry. Purging the material
deletes the rest through the `material_id` cascade, including leftovers of a
material never saved again. Both are written straight to their stable
`editor-assets/{id}/…` key by the gateway, as above; no presigned URL exists
that could overwrite a ready object. If creating the durable DB row fails
after a source object was written, handlers delete the orphan object.

A library figure the chat agent places in a note is stored by the gateway as
the same kind of asset (`server/internal/httpapi/agent_figures.go`,
[agentic-retrieval.md](agentic-retrieval.md)): the retrieval service sends the
rendered JPEG with the write, Go checks it against the chatting actor's plan
image cap (the actor pays for it, M16),
writes the object and inserts a `ready` row named for the note in one
transaction that gates its bytes with `gateStorageTx` (the note's creating
transaction, or one before an edit's blocks are sent). The bytes are known
before the transaction, so there is no reservation; an object whose row was
never inserted is deleted by the handler, and a refused edit's unreferenced
figures are trashed at once. From then on the 60-second rule, pruning, trash
and clones treat it like an upload.

An image another note's or quiz's id brings into a material (a paste, undo,
cut and paste, replayed draft, AI edit) is made the material's own by the
collaboration service's children pass, through
`POST /internal/collaboration/materials/{id}/children` (service secret, the
writer as `actorUserId`, at most 50 asset ids and 20 quiz blocks a call; see
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md)).
Per asset: the same id when it already belongs to the material (restored when
trashed), a new ready row when the source is ready and readable by the writer
(the resolve rule; a trashed source too), and "" otherwise (purged,
unreadable, pending, unknown), which drops the node. A copy shares the stored
object under blob refcounting, is charged to the writer who pasted it, like
an upload (M16), and counts as just completed, so the 60-second rule keeps it
until the repointed node is saved. Copies over the writer's quota are all
left out and
the answer says `storageRefused`; restores still land. One transaction locks
the target scope, share-locks the source rows, locks their blob paths in order
and gates the quota (`AdoptEditorAssets`).

Workspace clones snapshot the source, gate the total file + saved edit state +
material + ready editor-asset payload against the **cloner's** quota, copy ready asset rows
with new logical IDs (rewriting embedded references; each asset names the
clone of its material, and a trashed material's assets are left out), and reuse physical blob
paths under reference counting. `ready` source files are copied, and partial
ones (`failed` with a served index, parts design Q2) under the same gates;
pending, processing, and other failed files are omitted. A file past the cloner's per-file
plan cap (`plan_limits.source_file_max_bytes`, the upload cap) is left out of
the copy and counted in the answer's `skippedMaterials`, as is a material
whose stored content the current rules refuse or that is over the material
size caps (Epo 2026-10-20); the clone's other limits still refuse it whole. Material nodes (and quiz image blocks; a card keeps its text and loses only its image) referring to a pending,
failed, missing, or otherwise uncopied editor asset are removed from the cloned
document instead of retaining an unrenderable source id. The material's
current content and cloned logical assets are the storage-accounted payload.
Before writing cloned rows, the transaction locks every copied source and
saved-edit base (`source_documents.base_blob_path`, a counted reference of its
own), and ready editor-asset blob refcount in stable path order. The
last source reference therefore cannot queue and reap a physical object until
the clone commits. A path deleted after the repeatable-read snapshot causes a
transaction retry instead of a clone that points at missing bytes.

A single file or material clone lands in a workspace the cloner edits (a
material also standalone, private). The **payer** is the cloner, wherever the
copy lands (`files.user_id`, `source_documents.user_id`,
`materials.owner_user_id` and `editor_assets.user_id`); the quota gate runs on the payer
with the copy's bytes (a file's size plus its saved edit state; a material's
content, its embedded rows and its copied assets), and a file copy also passes
the destination's file-count gate and the payer's per-file plan cap, as an
upload into that workspace does (`FileTooLargeError`, 400 `file_too_large`
with `maxBytes`; the dialog shows the upload's size message). A copy queued
for ingest on an embedding-pin mismatch stays `pending` and charged: file
bytes are charged whatever the file's status. A material clone copies only ready editor
assets referenced by the current SQL projection, gives each asset a fresh
logical ID owned by the copy of the material whose content uses it (a note's
embedded quiz keeps its own images), and rewrites the document. Physical object
paths remain shared through blob refcounting. Source workspace asset IDs never
survive in the copy. A cloned file's saved edits travel as a new
`source_documents` row (epoch 1, same base, state and pending effects) whose
generated `storage_bytes` charges the payer like the source's charged its
own.
Contended clones poll the per-source advisory hierarchy without retaining a
pool connection while they wait, then take the repeatable-read snapshot once
the locks are held; a clone burst therefore cannot starve unrelated database
work. Workspace operations take the workspace fence before material fences.
Public deletion takes the same source fence before account, workspace, or
storage rows, while before-delete triggers also protect direct SQL and cascade
cleanup. The trigger cleans the detached popularity counter only after earlier
clones release the fence, so a clone cannot leave an orphan counter behind.

## Image compression and checks

Every image Capy stores passes one compressor first (Epo 2026-10-20, Q285,
Q286): a note, quiz, flashcard or bank image, a picture inserted in the Word or
PowerPoint editor, every picture inside an uploaded DOCX, PPTX or XLSX, and an
image file uploaded as a source. The browser runs `src/lib/fitImage.ts` (note,
quiz, flashcard and bank images in a worker of their own,
`src/lib/fitImageOffThread.ts`, Q348); the import worker applies the same
rules to imported files (`pipeline/pipeline/ingest/images.py`, inside the
decoder sandbox). Both are tested against the shared fixtures and expected
results in `e2e/fixtures/files/images/manifest.json`. Servers keep only the
formats they can measure (Q344) and check every image they store by its
header (Server checks below).

- The long side is resized within 2,400 px (`IMAGE_MAX_SIDE`, generated from
  the gateway's `imagecheck.MaxSide`) and encoded at quality 0.85. An editor
  image becomes WebP (JPEG, or PNG when transparent, where the browser has no
  WebP encoder); the stored file takes the new extension while the image keeps
  the name the user picked as its alt text (Q371, `uploadEditorAsset`). A picture for an Office file becomes JPEG when it is a photo
  and PNG when it is transparent or a flat graphic (opaque, at most 256
  colours on a nearest-neighbour sample at the output size), never WebP.
- The original is kept when it needs no resize (both sides compared), fits
  the image cap, is a type its target takes (PNG, JPEG or GIF in an Office
  file; PNG, JPEG, WebP, GIF or AVIF as an editor image) and the encode is not
  smaller.
- A result over the cap is shrunk further: a lossy one at 2,000 px with the
  quality falling from 0.85 to 0.4 (an opaque PNG turns into JPEG), a
  transparent PNG at 2,000, 1,400 then 1,000 px. When nothing fits, the image
  is refused ("image too large").
- An animated GIF is kept within 2,400 px and the cap and refused past either,
  since a canvas keeps one frame (Q331).
- An image file uploaded as a source is limited by area instead (Epo
  2026-10-24): a PNG, JPEG, GIF or WebP within 5 megapixels
  (`SOURCE_IMAGE_MAX_PIXELS`) is kept as it is, judged by its bytes; any other
  format (HEIC/HEIF, TIFF, JPEG 2000, BMP...) is re-saved with the Office
  format rules even when small (Q344), and a larger image is resized to fit 5
  megapixels (rounding down) with the same rules, so a PNG photo is stored as
  `<stem>.jpg`. An animated GIF past 5 megapixels is refused with the
  megapixel message. The per-file source cap applies to the result.
- An image no decoder reads is refused before upload (Q333), after the lazy
  decoders below.
- A picked SVG image (a source, or a note, quiz, flashcard or bank image) is
  drawn as a PNG on the page first (Q364, `src/lib/svgImage.ts`), since a
  worker has no image element and `createImageBitmap` refuses an SVG: an
  `<img>` from a blob URL (where an SVG runs no script and loads nothing
  external) onto a canvas, at its own size within 2,400 px when its root
  names a width and a height, else at 2,400 px on the long side with its
  viewBox's ratio (finite numbers only). Only heads are read on the page: 4
  KiB for the detection, up to 64 KiB for the root tag's size attributes. The name takes `.png` and the compressor keeps it
  PNG (`png`: lossless, shrunk at 2,000, 1,400 and 1,000 px past the cap, a
  source resized within 5 megapixels as PNG), so servers receive no SVG
  image. One that does not load, that nothing sizes, or that cannot be drawn
  or encoded (a tainted canvas) is refused as unreadable. An Office file's
  SVG picture is still dropped with its PNG copy kept, and an SVG imported
  from a provider stays refused.

The image cap counts the compressed bytes.

**Uploaded Office files.** Before a DOCX, PPTX or XLSX upload, a worker
(`src/features/workspace/sourceCompress.worker.ts` running
`src/lib/officeImages.ts`) unzips the package (at most 4,096 entries and
256 MiB expanded), compresses every raster picture with the Office rules and
the uploader's image cap, and zips it again; the transfer row reads
"Preparing images…". A pick over 256 MB is refused in the add dialog before
any of this (Q345). A picture whose format changes is renamed (`image1.png` to
`image1.jpeg`, with a numeric suffix on a clash), and its relationship targets
and `[Content_Types].xml` entries follow. Only the compressed file is sent,
stored, charged and downloaded (Q267), and only when it is within the per-file
cap, else the transfer row refuses it (Q345). PDFs stay as uploaded.

The picture parts are the targets of image and HD Photo relationships and the
`word/`, `ppt/` and `xl/media/` parts no other relationship targets (audio and
video stay). Pictures nothing can show are removed with what shows them (Epo
2026-10-24, Q337): EMF and WMF, SVG, HD Photo (`.wdp`), PICT, EPS and any
other format the compressor does not try (it tries PNG, JPEG, GIF, BMP, TIFF
and WebP), and a picture it cannot decode. What goes is, in DOCX, the
`w:drawing`, `w:pict` or `w:object` (with its OLE part); in PPTX the `p:pic`,
the OLE `p:graphicFrame` or a slide background's `p:bg`; in XLSX the drawing
anchor and the sheet's `oleObject`; in a chart or SmartArt part the
`a:blipFill`; a markup-compatibility wrapper around one goes whole. An SVG or
HD Photo beside a picture's own blip (`asvg:svgBlip`, `a14:imgLayer`) goes
with only its `a:ext`, the PNG or JPEG staying and the removal uncounted. EMF
and WMF parts nothing refers to, and document thumbnails in those formats
(`docProps/thumbnail.emf` with its package relationship, Q348), go too,
uncounted. An SVG part outside the picture parts (found by name or root
element) goes as well, uncounted (what shows one is counted). Then every
relationship nothing refers to any more goes, and the parts nothing targets. The count (a fallback copy is not counted twice)
reaches a warning toast after the upload: "N pictures Capy can't show were
removed".

**Imported files.** An import whose original file is over the per-file cap is
refused before the import host downloads or compresses it (the import request
and the download are bounded by it). The import worker compresses an imported
Office file the same way, one sandboxed call per picture with a 10 s CPU limit
and a 20 s wall-clock deadline (the ingest host's parsers share its cores)
inside the 768 MiB sandbox (Q347, `decode.py` mode `picture`); a picture past
its limit, or one Pillow cannot decode, is removed and counted like any other.
The pictures stop at the import job's time limit (`CAPY_IMPORT_JOB_TIMEOUT`,
10 min, less 30 s for the picture in flight, `IMPORT_PICTURE_MARGIN_S`),
checked before and after each picture, before each part's removals, every
65,536 tokens within them (review r6 N2) and before repacking, since the job timeout cannot stop the thread they run in,
so the upload keeps the margin; an import
past it fails without a retry (`import_too_slow`, "This file took too long
to process.", Q363). The worker refuses to start with a timeout within the
margin. A package whose relationships part declares more than 4 MiB is left
unread by the compressor (before any part is inflated) and refused by the
check (Q367).
The completion carries the count (`source_import_jobs.removed_pictures`, read
back as `removedPictures`), which shows the same toast; a completion that only
resumes an earlier attempt's upload names none and keeps the first count
(S10). An imported image source that is not a PNG, JPEG, GIF or WebP, or is
over 5 megapixels, is re-saved the same way and stored as `<stem>.jpg` or
`<stem>.png`: what Pillow reads directly, and HEIC/HEIF through libheif's
decode-only `heif-dec` from the image's Debian packages (`libheif-examples`
and `libheif-plugin-libde265`, LGPL-3.0, no x265 encoder; Q353), run in the
same sandbox with the same limits, which converts a 12 MP iPhone photo to
JPEG in about 0.4 s. The image build converts the shared HEIC fixture with
`heif-dec`, so a packaging slip fails the build. One that still does not
decode is refused with `image_unreadable`.

**Image files the browser cannot decode.** HEIC/HEIF, TIFF and JPEG 2000 go
through decoders loaded only when such a file is picked (Q294, Q333,
`src/lib/decodeImage.ts`): libheif-js for HEIC/HEIF (LGPL-3.0, loaded at
runtime as its own unmodified module, never bundled; the site serves its
licence texts at `/licenses/libheif-js.txt`), utif2 for TIFF (CCITT and
PackBits included) and pdf.js's OpenJPEG decoder for JPEG 2000. A file they
cannot decode is refused before upload, suggesting JPEG or PNG.

**Server checks.** The gateway reads only image headers and an Office file's
zip directory and part heads (`server/internal/imagecheck`, wired in
`server/internal/httpapi/image_checks.go`, `editor_assets.go`, the agent's
figures in `agent_figures.go`, chat decks in `internal_files.go` and bank
figures in `server/internal/bank/assets.go`, Q348); the import worker runs the
same check before storing (`pipeline/pipeline/ingest/image_check.py`). A
refusal is final: a 400 whose first error is the code below, shown in the
transfer row, with no retry.

Both checks hold an Office file to one layout on which every zip reader
(Go's for the gateway, CPython's for the worker, the zip crate's for the
collaboration server) picks the same end record and central directory, so
none reads parts the checks did not:

- local entries from byte 0, each followed directly by the next (after its
  data descriptor, if any), the central directory right after the last, and
  the end record (or its ZIP64 record) right after that, with the entry
  count it names;
- the end record is the only end record signature in the file's last 64 KiB
  and 26 bytes (where the zip crate looks, falling back to earlier ones; Go
  and CPython take the last), and its comment ends the file, so no nested or
  trailing archive offers another;
- a ZIP64 locator precedes the end record exactly when one of its fields is
  maxed out (0xffff entries, or a 0xffffffff size or offset), since the zip
  crate follows ZIP64 only then, Go also for a 65,535-byte directory and
  CPython whenever a locator is there; the ZIP64 record sits right before its
  locator with no extensible data, where Go and CPython both read it.

The entry cap is read from the end record before the directory loads. An entry counts as a folder only when its name ends in `/`,
never by its attributes, and every part, `.rels` included, is classified by
its bytes. An SVG root is looked for in a part's first 4 KiB, past an XML
declaration, comments and a doctype (with one internal subset, as Illustrator
writes; a bracket inside a quoted literal counts for nothing, review r6 N1); a comment ends at its first `-->`, so the match takes linear time in
the worker and the browser (Go's RE2 is linear anyway; review r4 B2, S2).
The compressors' XML tokenizers (`images.py`, `officeImages.ts`) end a tag,
relationship or extension list at the next `<` and a comment, CDATA or
declaration at the end of the text, so unclosed markup is scanned once, and
`[Content_Types].xml` is rewritten in one pass, not a search per part
(review r5 X1). The open elements a reference's container is picked from are
kept as a part is read (each kind's indices, searched by bisection), each
relationships part is rewritten once for its removals and renames, and the
parts nothing targets any more are worked out once, not per removed part; a
renamed picture's new name (`<stem>.jpeg`, then `<stem>-1.jpeg`, ...) is
tried from where the last picture sharing that name stopped (review r5
follow-up). A `[Content_Types].xml` with a namespace prefix (ElementTree's
`<ns0:Types>`) is rewritten with that prefix (review r6 N3).

| Upload or import | Refused when                                                                                                                                      | Code                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Editor image     | not PNG, JPEG, WebP, GIF or AVIF by its bytes, its header gives no size, or over 2,400 px on either side                                        | `image_unreadable`, `image_too_large`                                                        |
| Office file      | not a zip, over 4,096 entries, not one contiguous archive (above), a relationships part over 4 MiB by its declared size (Q367), a part that does not read, or past 256 MiB inflated in all | `office_unreadable`                                                                          |
| Office file      | an EMF or WMF part (by name or signature); an SVG part; a picture part that is not PNG, JPEG or GIF by its bytes, or whose header gives no size   | `office_vector_image`, `office_image_unsupported`                                            |
| Office file      | any part whose bytes are WebP, AVIF, HEIF, BMP, TIFF, ICO or CUR, JPEG XR or JPEG 2000                                                            | `office_image_unsupported`                                                                   |
| Office file      | a PNG, JPEG or GIF part over the image cap (counted as it inflates) or 2,400 px                                                                    | `office_image_too_large`                                                                     |
| Image source     | not PNG, JPEG, GIF or WebP by its bytes, or its header gives no size; over 5 megapixels                                                           | `image_unreadable`, `source_image_too_large`                                                 |

A GIF's size is its logical screen widened to its first frame. A JPEG's size
comes from a baseline, extended or progressive frame (SOF0 to SOF2, what Go
reads); any other frame gives no size, in both checks, and before the frame
both read only DHT, DQT, DRI, APPn and COM segments, restart markers and a
stuffed 0x00, refusing any other marker. The editor
image's byte cap stays the reservation's check; a bank figure keeps its flat
4 MiB cap. The collaboration server refuses a Word or PowerPoint edit that
adds a picture that is not a PNG, JPEG or GIF, is over the plan image cap
(the largest `plan_limits.image_max_bytes`, read with the room's load) or
2,400 px, read from the decoded bytes of the picture's data URL or from
`pendingMedia` (`collaboration-rs/crates/sources/src/pictures.rs`, Q287,
Q344, Q348). A string counts as a picture's data URL only when it names an
image type or base64 data, so text such as alt text starting with "Data:"
passes; pictures the room already holds pass.

**File names.** Upload, import and rename refuse a name with control
characters, bidi override or isolate characters (U+202A to U+202E, U+2066 to
U+2069, as Q313 for comments) or a path separator, and one past 120
characters (`fieldlimits.ValidFileName`, Q346); the 120-character bound and
the trimmed empty-name check existed on all three before. A rename that
changes the file's extension is refused (`file_extension_changed`), since the
extension names the file's kind and the checks its upload passed. Upload and
rename answer 422 `invalid_name`; an import is rejected with `invalid_name`.
Both copies name the 120-character limit. A file the agent stores (a chat
deck, `internal_files.go`) takes the same rule and is refused with 400
`invalid_input`.

## Yjs storage growth

`gc: true` does not bound Yjs history: deleted structs and related metadata
remain in `material_yjs_documents.state` and its update log
(`material_yjs_updates`, one row per store, folded into the state when the room
unloads or the log passes `max(256 KiB, state bytes)` or 1,000 rows; the
document row keeps `log_bytes` and `log_rows`). Source documents keep the same
log in `source_document_updates`, charged in `storage_bytes` with the state
(migration 0075). A source save appends its row through the checkpoint
compare-and-swap; a moved checkpoint re-reads the rows saved meanwhile and
appends again, 3 attempts in all (`collaboration-rs/crates/sources/src/store.rs`).

A compaction never moves the room epoch (`room_schema`): history is
collected in place, at the fold, with no new lineage and no reload for anyone
(Epo 2026-10-22 and 2026-10-23). The collection below is built and stays off
in deployments until the rest of its release lands (**Switch**). Note, quiz and flashcard history is not charged: a
material pays for its content JSON alone (`materials.size_bytes`). No cap
bounds a note room's state: a store appends only the update since the durable
state, each client update is at most `ydoc::MAX_UPDATE_BYTES`, and the shape
bounds measure the content, not its history. A heavily edited note costs load
time and memory instead, and a full answer of at least 256 KiB waits behind
its user's spent open budget (`rate.rs`).

### In-place collection at the fold

Every fold of a note's document, at unload and at the log threshold, replays
its base and rows into a scratch document and, with the collection on,
writes that document without the deleted units no replica can still name
(`ydoc::gc::collect`). Quizzes, flashcard sets and other item rooms keep
their whole history (Q274, 2026-10-24): their folds take no window. An open
room also collects its own document at each threshold fold (Q401), in its
own task (what arrives meanwhile waits), at that fold's window and held set,
and swaps the result in: its state vector, unstored edits and own marker
chains stay, tabs joining get the collected state, and open tabs keep their
tombstones until they reload. With the same W and H it drops only units the
stored pass drops too (a unit newer than W only ends a run), except a deleted
block's children, which Yjs drops with the block either way. It can also
keep units the stored base dropped: a refused or skipped pass, or one that
found nothing while the stored pass did, leaves its document whole. A check
of what a payload names therefore reads both documents (Q419). While the
room keeps agent steps it keeps its
document whole: their live Undo reverts against the room document's own
deleted content and redo links, which a reload drops (durable Undo removes
those steps). Kept list items keep their origins, and a map value drops its
origin only when nothing behind it stays, so tabs holding the full history
and tabs loading the collected state agree.

- **Sessions.** A note's content room keeps its editing sessions
  (`sessions.rs`; [editing sessions](frontend/plate-editor.md#editing-sessions)):
  each session's last acknowledged stored version, when it was last seen,
  and the deletions its own updates made, each held 25 h after it arrived
  (Undo reaches back 24 h, Q2), as columns of the session's client-id row
  (migration 0117), written with the store that holds them; and the
  deletions of agent steps, each held 25 h from its agent edit, an hour past
  the room's 24 h offer of its Undo and Redo (`material_yjs_documents.agent_held`;
  Q385, Q390). A session counts while connected and 24 h after it was last
  seen, and ends earlier on a clean Leave naming it. A session row whose
  held deletions cannot be read is dropped alone, written lost (its tab
  returns as late) and reported, and the note loads (Q382, Q385); so are
  agent holds that cannot be read (Q386). The rows are bounded by the
  document: a held deletion is one the room held undeleted, and the record's
  7-day scan clears an unused id's row with its session.
- **Inputs.** The folded document, a window W (a state vector, delete set and
  stored_version an earlier fold stored) and a held set H, both from the
  room's sessions (`Sessions::holds`). A unit is dead when W deleted it and H
  does not hold it.
  - W is the newest stored window that every counted session has reached; with
    no counted session, W is the folded document itself; with no qualifying
    window, the fold collects nothing. A session has reached the last store it
    acknowledged on its socket, never above the version its oldest unsent edit
    was made at: an edit made before W and not yet stored would otherwise sit
    next to a unit the collection dropped.
  - A `/drafts` group counts no session, so W never passes the oldest group
    the room admitted until a store taken after it commits (the draft floor,
    Q400), whichever trigger folds: a store or a service edit. A group must
    name its version (`X-Capy-Version`, 1 or later): one without is refused.
  - A room never folds while a committed row has not reached it (a direct
    write racing its load, or a service edit's row it hears of after a later
    store's; Q419). The service edit's own fold runs once the row arrives
    and folds up to the stored version, so W never holds a row the live
    document lacks, and a store holding an admitted group is folded with
    that group.
  - H holds what counted sessions deleted (their editor Undo may restore it)
    and what agent steps deleted (their Undo and Redo re-create it, naming
    the deleted items).
- **Late tabs.** A fold that collected keeps its window's stored_version as
  the latest (`material_yjs_documents.collected_window`), and a room loads it
  with the document. A JOIN or `/drafts` group naming an older version, or
  under a lost session's id, is late (`sessions::late`): the late merge takes
  it (logged until that lands). While a fold runs, its room checks JOINs
  against the most that fold may move the window to (the version every
  counted session reached, or the stored version when none counts). A fold
  collects only while no other life of its room is loaded, asked under the
  material's lock: a room that loaded before it holds the older window, and
  one loading after it waits for the lock and reads the new one. That rule
  sees one process's rooms, so the collection requires one collaboration
  process per database (Q400; no replicas, no start-first rollout, see
  [deployment-runbook.md](deployment-runbook.md)): a fold collects nothing
  while another process's heartbeat is in the instance registry
  (`capy:collaboration:instances`, within a minute), or a heartbeat there or
  the registry cannot be read (each value is read on its own, as the source
  handoff reads them). Each such cause is logged and reported to Sentry once
  per process (Q419), tagged `file_id` with the note whose fold first saw
  it. A process removes its heartbeat when it stops.
- **Lists.** In the document's current order, each run of dead units keeps its
  first and last unit: typing names the last unit of a deleted run, a list
  insert the first. Any other unit ends a run, a unit newer than W included,
  since a session that has seen it can type next to it. The rest goes unless a
  kept item names it as origin or right origin, closed over that. List origins
  are never rewritten, so an item goes only whole: one holding an edge or a
  unit that is not dead stays with all its units (a word typed at once and
  deleted again is one item, its edges inside it). Runs are read by clock
  range, so an item costs its ranges, not the units it claims.
- **Maps.** The value current at W is kept. It drops its origin, so the values
  behind it go, only when nothing behind it stays: a value behind it held,
  newer than W, or named by a value after it keeps the origin.
- **Contributor markers.** A marker chain written by an ended room life goes
  whole; the open room's own chains follow the map rule.
- **Windows.** Each fold of a note with the collection on stores the folded
  document's state vector, delete set and stored_version in
  `material_yjs_windows` as a later window candidate, and keeps the newest of
  each hour for the latest 25 hours that have one (Q400), so a collection
  can reach a session counted up to 24 h back. They hold ids only and are
  not charged.
- **Guard.** A collected state that does not load with nothing pending, keep
  the model's roots and hold the folded document's state vector and value is
  refused: the fold stores the folded document uncollected, as without the
  collection, and reports the refusal to Sentry once per material (tagged
  `file_id`) while the process runs, logging every refusal; a panic in the
  collection or the guard is a refusal too. The next fold collects again (Epo 2026-10-24). The open room's own
  collection has the same guard: a refusal keeps its document as it is.
- **Undo.** An item that names a collected unit as origin, right origin or
  parent integrates as collected, so a durable Undo payload whose items name
  one would restore only part of its edit. `ydoc::gc::names_collected` finds
  such a payload; the durable Undo route must refuse it (`undo_unavailable`)
  before the collection is turned on, checking both the loaded room's
  document and the stored state (Q419).
- **Switch.** `COLLABORATION_GC_COLLECT=true` turns the collection on. It is
  off by default, and the server refuses to start with it on outside tests
  (`APP_ENV=test`) until the rest of the release lands: the merge of a tab or
  draft older than the window (without it, a late tab's unsent edits would be
  lost), the durable Undo payloads' holds and the durable Undo route's
  refusal.

On the most churned note measured (1,000 characters after 100,000 edit
bursts in 605 sessions) one collection takes the stored state from 716 KB to
54 KB (12 KB of it the delete set) in about 60 ms, and the next fold writes
49 KB; a collected state collects again in about 2 ms. Ordinarily edited notes
gain 5-12%. Not charged, as note history is not. The open room's swap of its
own document on the same notes (release build, W the document itself) holds
its task 18-42 ms: the collection 10-27 ms, the load 3-17 ms and the guard's
two values 1-11 ms; the churn note's room document goes from 716 KB to 54 KB.

Source text states grow the same way. Their history grows with the number of
separate edits (and the contributor markers each save writes and clears), not
with the file's size: garbage collection drops deleted content and merges
adjacent deletions, leaving a few bytes per edit, so a paste deleted again
costs a few bytes. Three publications of 1 KB typed into a 2 KB `.md` left
195 bytes charged (bench/parsers/reports/2026-10-05-office-storage-charging.md),
within the room's state cap.

Tokens, Redis events, service commands, and client Y.Docs bind to
`room_schema`, so a stale client cannot merge an earlier lineage's state back
in. A discard that throws unsaved room state away increments `room_schema`,
keeping the state (see
[plate-editor.md](frontend/plate-editor.md#document-limits-and-rejection)).

Ordinary persistence embeds server-owned actor provenance in the same Yjs
transaction as each edit and rechecks every contributor in the exact debounced
snapshot, along with current membership/share role, workspace owner, and live
subscription/storage state. Claimed markers are removed from the committed
state; newer generations remain for the next save. A token minted before role
removal, suspension, deletion, or plan expiry cannot bypass the database
boundary. A rejected authorization-race save evicts the room so the uncommitted
update is not retained in memory. Before writing authoritative Yjs state, the
collaboration server applies the same structural and material-kind contract as Go. Invalid
Plate content cannot become a durable state that projection will reject. The
server discards that in-memory room and reloads the last durable state instead
of retrying an unsavable snapshot.

A document over a product shape bound must not grow in serialized size, node
count, or depth. Structural validation does not apply those caps, so a valid
document that starts over a limit can still shrink back towards it. The
Rust and Go metric walks count every node through the shared structural
depth ceiling, so growth below an already-over-limit deep branch cannot hide
behind unrelated deletions. A live Free subscription by itself is an ordinary
active account. The collaboration server treats an account as frozen, and its rooms as
read-only, only when it sees an expired or closed Pro boundary at least 14
days old and usage over the Free limit, matching Go's account resolver. It
treats a material as view-only when its owner's stored plus reserved bytes
reach the current plan's limit (`full_sql`, matching `StorageUsage.Full`);
`TestCollaborationFrozenSQLMatchesGo` runs both statements against Go.

Sources: [storage gate and reconciliation](../server/internal/store/storage.go),
[material bounds](../server/internal/materialdoc/document.go),
[collab limits](../collaboration-rs/crates/notes/src/limits.rs),
[collab document validation](../collaboration-rs/crates/notes/src/material.rs),
[note store and folds](../collaboration-rs/crates/server/src/note_store.rs),
[in-place collection](../collaboration-rs/crates/ydoc/src/gc.rs).

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
| Material, quiz, flashcard set, generate title | 120 |
| Conversation title | 60 |
| Event title / location | 60 / 100 |
| Task title | 80 |
| Label name, tag value | 35 |
| Email (invite identifier, deletion confirm, users.email) | 254 |
| Profile name | 60 |
| Flashcard front / back (content API, Go document check, agent tools, collaboration store) | 4,000 / 2,000 |

User-typed values are rejected with a 422; the source details dialog refuses
oversized file names before upload. Values the user did not type are clamped
before insert: Clerk profile names on the first insert (the profile sync
provisions the account on its first request, so a rejection would lock the account out; an
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
