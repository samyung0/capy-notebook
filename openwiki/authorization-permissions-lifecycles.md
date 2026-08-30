---
type: Backend
title: 'Authorization, Permissions, and Lifecycles'
description: 'Authorization roles, account lifecycle gates, storage ownership, and file cleanup behavior across workspaces and materials.'
tags: [backend, authorization, permissions, lifecycle, storage, quota, files]
---

# Authorization, permissions, and lifecycles

This page documents the authorization behavior implemented as of 2026-08-06.
It uses **commenter**, the role name used by the API and database; "commentor"
refers to the same role when it appears in product discussions.

Authorization is the intersection of four independent questions:

1. **Visibility:** is the resource private, shared by link, or public?
2. **Role:** is the requester an owner, explicit workspace member, signed-in
   shared visitor, or anonymous visitor?
3. **Actor lifecycle:** may the signed-in user still hold a session and perform
   this category of mutation?
4. **Storage ownership:** whose quota is charged if the operation adds bytes?

Passing one layer does not bypass another. For example, an editor has permission
to upload, but the upload is still refused when the workspace owner's quota
cannot accept it.

## Role summary

| Capability | Owner | Editor member | Commenter member | Viewer member |
| --- | --- | --- | --- | --- |
| View a private workspace and its contents | Yes | Yes | Yes | Yes |
| Edit material document content | Yes | Yes | No | No |
| Read and create comments | Yes | Yes | Yes | No |
| Create/reorder chapters and materials | Yes | Yes | No | No |
| Upload, rename, move, and delete files | Yes | Yes | No | No |
| Use workspace chat and generation | Yes | Yes | No | No |
| See the workspace member list | Yes | Yes | Yes | Yes |
| Invite/remove members or change their roles | Yes | No | No | No |
| Change workspace name, color, tags, or sharing | Yes | No | No | No |
| View workspace statistics | Yes | No | No | No |
| Delete or transfer the workspace | Yes | No | No | No |

The core role hierarchy is `owner > editor > commenter > viewer`. Owner and
editor satisfy `canEdit`; owner, editor, and commenter satisfy `canComment`;
only owner satisfies `canManageMembers`. The API returns these request-scoped
capabilities on workspace and material responses.

Sources: [role definitions](../server/internal/store/enums.go#L62),
[capability calculation](../server/internal/store/share.go#L88), and
[capability contract test](../server/internal/store/contracts_test.go#L9).

## Visibility and shared access

### Private workspaces

Only the owner and explicit members can read a private workspace. Unauthorized
callers generally receive `404`, which avoids revealing whether the private
resource exists.

### Link and public workspaces

Both link and public workspaces are readable to anyone with access to the URL.
Only public workspaces are listed in Explore. Files and all materials inside a
shared workspace inherit that readable visibility.

The workspace's `shareRole` grants an effective role for material
collaboration to every **signed-in** caller:

| Shared visitor | Read workspace/materials/files | Edit material document | Comment | Change workspace structure/files |
| --- | --- | --- | --- | --- |
| Signed-in `editor` share role | Yes | Yes | Yes | No |
| Signed-in `commenter` share role | Yes | No | Yes | No |
| Signed-in `viewer` share role | Yes | No | No | No |
| Anonymous visitor, for any share role | Yes | No | No | No |

Important boundaries:

- A share role applies to **material collaboration**, not structural workspace
  authorization. Shared editors cannot add chapters, upload files, use
  workspace chat/generation, manage members, or change sharing.
- Anonymous visitors are always viewers. Write routes require authentication.
- Roles are grants rather than caps, so a member's effective role is the **more
  permissive** of their membership and the share role. A viewer invited to a
  workspace shared for editing may edit documents. Capping them would not
  restrain anyone, since the same link already hands editing to every other
  signed-in account, and it would leave the one invited collaborator with less
  access than a stranger.
- The raise never reaches structure. A raised viewer still cannot rename a
  material, add a chapter, or upload, because those checks read the persisted
  membership rather than the effective role.
- A share role never lowers a membership. An editor member keeps editing on a
  view-only link.
- A material shared by itself from an otherwise private workspace is view-only,
  including for signed-in visitors.
- Shared material editors may change document content through collaboration,
  but REST metadata changes such as title, filing, scope, or privacy require an
  explicit owner/editor membership.
- Changing visibility or `shareRole` moves everyone's effective role, so it
  evicts live collaboration connections the same way a membership change does.

Sources: [workspace versus material access rules](../server/internal/store/share.go#L13),
[effective material role calculation](../server/internal/store/share.go#L107),
[workspace structural guard](../server/internal/store/share.go#L43), and
[sharing end-to-end coverage](../e2e/sharing/workspace-sharing.spec.ts#L34).

## Feature permissions

### Workspace settings and membership

- **Any explicit member** can list the workspace members, which includes each
  member's email and role. Anyone who may comment, shared-link visitors
  included, can instead read the redacted collaborator directory behind mention
  autocomplete, which carries only user id, display name, and avatar.
- **Owner only** can invite a member, change a member's role, remove a member,
  rename/recolor/tag the workspace, change private/link/public visibility or
  `shareRole`, view workspace statistics, and delete the workspace.
- Ownership is not assigned through a normal role change. The owner must use
  **transfer ownership** and select an existing live member.
- On transfer, the recipient becomes owner and assumes the complete storage
  bill. The old owner remains as an editor. Transfer is refused if the recipient
  cannot fit the workspace's used and reserved bytes.
- An over-quota owner may still transfer because giving away bytes is a recovery
  action.

Sources: [membership handlers](../server/internal/httpapi/huma_membership.go#L39),
[owner-only workspace mutations](../server/internal/store/queries.go#L401), and
[transfer transaction](../server/internal/store/workspace_transfer.go#L36).

### Chapters, files, and uploads

- Owner and explicit editor members can create, rename, reorder, move, and
  delete chapters.
- Owner and explicit editor members can add/upload, rename, move, and delete
  source files and editor assets.
- Commenters, viewers, and shared nonmembers can read files when workspace
  visibility permits, but cannot mutate workspace structure or files.
- Upload reservations and finalized bytes are charged to the workspace owner,
  not the editor who uploaded them.

Sources: [chapter and file handlers](../server/internal/httpapi/huma_content.go#L54),
[source upload guard](../server/internal/httpapi/uploads.go#L40),
[editor asset guard](../server/internal/httpapi/editor_assets.go#L164), and
[owner storage gate](../server/internal/httpapi/server.go#L234).

### Notes and other material documents

- Owner and explicit editor members can create materials in a workspace.
- Owner, explicit editors, and signed-in shared editors can edit the live
  document body.
- Only explicit owner/editor access can change material metadata. Publishing a
  material additionally requires a fully writable actor account.
- Owner and explicit editor members can delete a workspace material. For a
  standalone material, only its owner can edit or delete it.
- Material revisions are readable to users who can read the material.

Sources: [material handlers](../server/internal/httpapi/huma_materials.go#L37),
[explicit metadata restriction](../server/internal/httpapi/huma_materials.go#L148),
and [material editor checks](../server/internal/store/share.go#L209).

### Comments and live collaboration

- Owner, editor, and commenter roles can list discussions, create a discussion,
  reply, and resolve or reopen a discussion. This includes effective
  link/public share roles for signed-in users.
- A user can edit only their own comment.
- A user can delete their own comment or discussion. Owners/editors can also
  delete another user's comment or discussion; commenters cannot.
- Viewers and anonymous visitors get static read-only material rendering and
  cannot join the collaboration room.
- Discussions and comments carry their author's display name and avatar. The
  client does not resolve authorship against the current member list, so a
  contributor who has since left the workspace stays attributed and a reader
  without a roster still sees who wrote what.
- Collaboration tokens encode `write`, `comment`, or quota-recovery `shrink`
  access. A token's document growth rule follows the material's storage owner,
  not the connecting editor.

Sources: [collaboration token access](../server/internal/httpapi/huma_collaboration.go#L109),
[discussion/comment authorization](../server/internal/httpapi/huma_collaboration.go#L195),
and [commenter end-to-end coverage](../e2e/sharing/material-modes.spec.ts#L29).

### Quizzes and flashcards

- Readable shared quizzes can be attempted by any signed-in user. Attempts,
  mistakes, and review history belong to the user taking the quiz.
- Owner and explicit workspace editors can modify workspace quizzes, decks, and
  cards, and can create quiz-shaped materials through the workspace material
  API. The dedicated `POST /api/quizzes` route is stricter: selecting a
  workspace there currently requires its owner. The deck creation route allows
  owner/editor membership. Standalone quizzes/decks remain owner-controlled.
- Commenters, viewers, shared visitors, and anonymous visitors can read a shared
  quiz/deck, but cannot change its questions or cards.
- Cloning a readable shared quiz, deck, material, or workspace creates a new
  owner-controlled copy charged to the signed-in cloner.

Sources: [quiz read/attempt rules](../server/internal/httpapi/huma_quizzes.go#L74),
[flashcard guards](../server/internal/httpapi/huma_flashcards.go#L60), and
[clone handlers](../server/internal/httpapi/huma_share.go#L81).

### Workspace chat, AI completion, and generation

- Persisted streaming chat, chat history, editor completion, and generation
  require owner or explicit editor membership. Conversations are private to the
  user who created them, even inside the same workspace. Chat and generate
  model choice is an account preference (**Settings → LLM**), snapshotted onto
  new conversations; the browser cannot pick a model per request. Editor AI
  uses the `users.editor_model_provider_slug` / `users.editor_model_slug` pair
  the same way, including provider-scoped
  single-key BYOK, and is gated by
  `VITE_FEATURE_EDITOR_AI`.
- Shared editors who are not members cannot use workspace chat or generation.
- Generated material storage is charged to the workspace owner. The actor is
  recorded as author but does not become storage owner.
- Inference credits are billed to the actor (`BeginProviderSession` /
  `llm_credits_exhausted`). Ingest claim-time checks owner
  lifecycle/storage and actor credits as two lookups; actor lifecycle is not
  checked, so a `deletion_pending` uploader cannot strand the owner's bytes.

Sources: [chat ownership and editor guard](../server/internal/store/chat.go#L44),
[generation editor guard](../server/internal/httpapi/server.go#L496), and
[generation credit policy](../server/internal/httpapi/generation_credits.go#L3).

### Personal account features

Events, tasks, labels, notifications, integrations, billing, search, quiz
attempt history, and mistakes are scoped to the authenticated user's own rows,
not to a workspace role. Over-quota users cannot create new calendar events but
may update or delete existing events/tasks as recovery-compatible mutations.

Source: [schedule lifecycle gates](../server/internal/httpapi/huma_schedule.go#L47).

## Account lifecycle gates

Account lifecycle is evaluated after identity authentication and before or
during a write. Severity is ordered as deleted, suspended, deletion pending,
then storage state.

| Account state | Hold/use a session | Read | Create/upload/clone | Ordinary edits or publishing | Delete/rename/reorder | Material document editing |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | Yes | Yes | Yes, subject to role and hard quota | Yes | Yes | Full write |
| `over_quota_grace` | Yes | Yes | No storage creation where this account pays; some non-storage create routes also gate | No exposure-widening or unrestricted actor edits | Yes, subject to role | Shrink-only where this account owns the material storage |
| `over_quota_frozen` | Yes | Yes | No storage creation where this account pays; some non-storage create routes also gate | No exposure-widening or unrestricted actor edits | Yes, subject to role | Shrink-only where this account owns the material storage |
| `deletion_pending` | No | No API access | No | No | No | No |
| `suspended` | No | No API access | No | No | No | No |
| `deleted` | No | No API access | No | No | No | No |

`over_quota_grace` and `over_quota_frozen` currently have the same permission
set. Grace lasts 14 days after a paid period lapses; frozen is the state after
that window. Neither state deletes content. The states exist only when the paid
period has lapsed **and** stored bytes exceed the applicable limit.

Suspended, deletion-pending, and deleted identities are rejected by the auth
middleware before resource roles are evaluated. Suspension is currently a
manual state; there is no automatic suspension policy.

Sources: [lifecycle states and gate methods](../server/internal/store/account_state.go#L11),
[session rejection](../server/internal/store/account_state.go#L174),
[middleware enforcement](../server/internal/auth/middleware.go#L174), and
[over-quota API behavior test](../server/internal/httpapi/account_gates_test.go#L128).

## Storage quota and ownership

### Who pays

- All files, editor assets, uploads, and materials inside a workspace are
  charged to the **workspace owner**.
- A standalone material is charged to its creator/owner.
- Editors can therefore add bytes to another user's bill only while that
  owner's account and quota permit it.
- An editor's own over-quota state does not block storage creation inside a
  healthy owner's workspace. Conversely, an active editor cannot grow content
  owned by an over-quota workspace owner.

### What the gate checks

Every storage-**creating** transaction checks both conditions:

1. the storage owner's lifecycle permits creation; and
2. `used bytes + reserved bytes + requested bytes <= plan limit`.

The current limits are 100 MiB for free accounts and 1 GiB for Pro accounts.
Upload reservations count immediately so concurrent uploads cannot both spend
the same remaining quota. Quota errors use `storage_quota_exceeded`; lifecycle
over-quota errors use `account_over_quota`.

Growing an **existing** material does not re-run the plan-byte creation gate;
it only appends size deltas. Over-quota owners are still limited to
shrink-only document edits via collaboration token access (see account
lifecycle gates above). Byte measurement, counters, and material shape bounds
are documented in [storage accounting](backend-storage-quota.md).

Deleting content, transferring a workspace away, and shrinking existing
material content remain available to an over-quota owner so the account has a
path back under the limit. Size-neutral metadata changes such as renaming,
re-filing, and reordering also remain available. Publishing remains blocked
because it widens exposure rather than helping storage recovery.

Sources: [transactional storage gate](../server/internal/store/storage.go#L173),
[storage-owner collaboration test](../server/internal/store/collaboration_owner_test.go#L33),
and [storage accounting details](backend-storage-quota.md).

## File and object lifecycle

The database file or editor-asset row and the physical bucket object have
separate lifecycles. User-facing deletion removes the logical row first; durable
database triggers and background workers remove physical objects only after no
live row references them.

### Lifecycle summary

| Stage | Database/storage effect | Bucket effect | Background cleanup |
| --- | --- | --- | --- |
| Upload reserved | Creates a pending `upload_sessions` row and reserves the declared bytes against the workspace owner | Browser receives a presigned PUT for an `incoming/` or `editor-assets/incoming/` key | Pending session is eligible for expiry after its presigned deadline |
| Upload finalized | Creates the source file or editor asset, converts reserved bytes into used bytes, and marks the session completed | Incoming object is promoted to its stable `sources/` or `editor-assets/` key | Completed session remains temporarily as an idempotency record |
| Upload abandoned/expired | Marks the session expired and releases its storage reservation | Both incoming and possible promoted paths are queued, with a 24-hour presign grace | Upload sweeper runs at startup and every minute, up to 100 expired sessions per pass |
| File/asset deleted | Logical row is deleted; workspace deletion and account purge do this through foreign-key cascades too | The path is queued only when its last database reference disappears | Blob reaper runs at startup and every minute |
| Shared blob still referenced | One row/reference is removed, but the remaining clone/reference keeps the blob live | Object is not deleted | Reaper re-checks references before every claim |
| Stable object has no database record | No row exists to enqueue it, for example after a request dies between PUT and row creation | Object remains in the bucket | Monthly orphan sweep reports it after 48 hours; it currently **does not delete it** |

Sources: [upload reservation and finalization](../server/internal/store/uploads.go#L50),
[expired-upload sweep](../server/internal/store/uploads.go#L202),
[worker schedules](../server/cmd/api/main.go#L259), and
[blob worker design](../server/cmd/api/blob_workers.go#L11).

### Temporary upload cleanup

Source uploads and editor assets share the `upload_sessions` table but use
different targets. Reserving an upload immediately reserves its declared bytes
against the workspace owner. A successful finalize promotes the object from a
temporary incoming key, creates the durable resource row, and marks the upload
session completed. Finalization is idempotent, so retrying a completed source
upload returns the already-created file.

The upload sweeper runs once on server startup and every minute afterward. It
finds pending sessions whose presigned deadline has passed, marks each one
expired, releases the owner's reserved bytes, and queues both the incoming and
stable destination paths in the same transaction. Both paths are included
because a late or partially completed request may have written either one.

Queued upload paths are delayed by a further 24-hour presign grace. This delay
outlasts an already-issued PUT URL so a late upload is collected rather than
appearing after cleanup has already run. Independently, bucket lifecycle rules
expire `incoming/` and `editor-assets/incoming/` objects after one day. The
database sweep repairs quota/accounting state; the bucket rule is the final
backstop for temporary objects that never obtained a database session.

Upload-session records are later pruned: completed sessions after 30 days and
expired sessions seven days after their expiry deadline. Deleting a session
re-evaluates its object paths through the same reference machinery, so pruning
a completed session cannot remove the stable object still held by its file or
asset row.

Sources: [upload expiry and pruning](../server/internal/store/uploads.go#L202),
[abandoned-upload test](../server/internal/store/blobs_test.go#L230), and
[required bucket lifecycle rules](../server/README.md#L30).

### Logical deletion and the blob reaper

Physical deletion is coordinated through `pending_blob_deletions`, a durable
database outbox. Reference-count triggers cover source objects, parsed objects,
caption-cache objects (`files.caption_blob_path`), editor assets, and
upload-session paths. They run for direct row deletion and
foreign-key cascades, so deleting a file, deleting a workspace, or purging an
account all reach the same cleanup path without relying on an HTTP handler to
enumerate bucket keys.

A bucket object can be shared by multiple rows, notably after cloning a
workspace. Removing one holder decrements the reference count; the path is
queued only after its last holder disappears. If a queued path becomes live
again before deletion, the queue/reference triggers remove the stale request,
and the reaper independently checks for a current reference before claiming it.

The reaper runs at startup and every minute. It claims at most one S3 batch at a
time, deletes accepted keys, and leaves rejected or failed keys queued with the
failure reason. Claiming advances a five-minute-per-attempt backoff. After eight
attempts a path is no longer claimed automatically; the monthly report includes
the count of these undeletable queue entries for operational follow-up.

Backblaze B2 hides overwritten/deleted versions by default, so deployment must
also apply the configured `daysFromHidingToDeleting` lifecycle rule. Without
that rule, a successful reaper deletion can leave hidden versions consuming
bucket storage.

Asynchronous audio has a separate provider-side deletion obligation. Its
`audio_transcriptions` row deliberately survives file/job cascades with nullable
foreign keys. File deletion, account/workspace cascade, replacement, or terminal
ingest failure first marks `cleanup_requested`; the Netcup worker retries the
provider DELETE and removes the row only after success (provider 404 also counts
as success). A webhook arriving after deletion records only the provider id and
cleanup deadline. It never restores the file, transcript result, or ingest job.

Sources: [deletion outbox and reference re-check](../server/internal/store/blobs.go#L9),
[reaper loop and retry behavior](../server/cmd/api/blob_workers.go#L26),
[reference-count lifecycle test](../server/internal/store/blobs_test.go#L51), and
[bucket version requirement](../server/README.md#L30).

### Unrecorded stable objects

The scheduled job for unrecorded files is `runBlobSweep`. It covers the failure
window where an object reaches stable bucket storage but the request dies before
creating any database row. Because no reference was ever recorded, no trigger
can enqueue that object for the normal reaper.

The sweep:

- runs once at server startup and then every 30 days;
- lists `sources/`, `captions/`, `previews/`, and `editor-assets/`;
- ignores objects newer than 48 hours so in-flight finalization is not reported;
- treats both live blob rows and upload-session source/destination paths as
  known references; and
- logs each unknown key plus a total count.

This sweep is intentionally **report-only** today. It does not enqueue or delete
unrecorded stable objects because a false negative in the database view would
make an automatic bucket deletion unrecoverable. Temporary incoming prefixes
are excluded because their one-day bucket lifecycle rule already deletes them.

Sources: [orphan sweep policy and schedule](../server/cmd/api/blob_workers.go#L98)
and [known-path calculation](../server/internal/store/blobs.go#L105).

## Account deletion and ownership

Self-service deletion requires all of the following:

- the user confirms their account email;
- no live subscription remains (a subscription set to cancel at period end is
  acceptable); and
- every owned workspace that has collaborators is transferred or has its
  members removed.

Once requested, the account enters `deletion_pending`, sessions are revoked,
and purge is scheduled after 30 days. Content remains intact during that grace
window, but there is no self-service cancellation endpoint. Support can cancel
the deletion before purge after verifying the request out of band. A purged
account cannot be restored.

Sources: [deletion preflight and request](../server/internal/httpapi/huma_account_lifecycle.go#L73)
and [30-day lifecycle implementation](../server/internal/store/account_lifecycle.go#L9).

## Reference index

- [Role enums and share-role mapping](../server/internal/store/enums.go#L62)
- [Canonical workspace/material access decisions](../server/internal/store/share.go#L13)
- [Account lifecycle state machine](../server/internal/store/account_state.go#L11)
- [Workspace membership API](../server/internal/httpapi/huma_membership.go#L39)
- [Workspace and sharing API](../server/internal/httpapi/huma_workspaces.go#L44)
- [Material API](../server/internal/httpapi/huma_materials.go#L37)
- [Comment and collaboration API](../server/internal/httpapi/huma_collaboration.go#L81)
- [Storage quota design](backend-storage-quota.md)
- [Upload session lifecycle](../server/internal/store/uploads.go#L13)
- [Blob deletion outbox](../server/internal/store/blobs.go#L9)
- [Blob reaper and orphan report](../server/cmd/api/blob_workers.go#L11)
