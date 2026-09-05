---
type: Backend
title: "Authorization, Permissions, and Lifecycles"
description: "Authorization roles, account lifecycle gates, storage ownership, and file cleanup behavior across workspaces and materials."
tags: [backend, authorization, permissions, lifecycle, storage, quota, files]
---

# Authorization, permissions, and lifecycles

This page documents the authorization behavior implemented as of 2026-09-05.
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

| Capability                                     | Owner | Editor member | Commenter member | Viewer member |
| ---------------------------------------------- | ----- | ------------- | ---------------- | ------------- |
| View a private workspace and its contents      | Yes   | Yes           | Yes              | Yes           |
| Edit material document content                 | Yes   | Yes           | No               | No            |
| Read and create comments                       | Yes   | Yes           | Yes              | No            |
| Create/reorder chapters and materials          | Yes   | Yes           | No               | No            |
| Upload, rename, move, and delete files         | Yes   | Yes           | No               | No            |
| Use workspace chat and generation              | Yes   | Yes           | No               | No            |
| See the workspace member list                  | Yes   | Yes           | Yes              | Yes           |
| Invite/remove members or change their roles    | Yes   | No            | No               | No            |
| Change workspace name, color, tags, or sharing | Yes   | No            | No               | No            |
| View workspace statistics                      | Yes   | No            | No               | No            |
| Delete or transfer the workspace               | Yes   | No            | No               | No            |

The core role hierarchy is `owner > editor > commenter > viewer`. Owner and
editor satisfy `canEdit`; owner, editor, and commenter satisfy `canComment`;
only owner satisfies `canManageMembers`. The API returns these request-scoped
capabilities on workspace and material responses.

Sources: [role definitions](../server/internal/store/enums.go#L62),
[capability calculation](../server/internal/store/share.go#L88), and
[capability contract test](../server/internal/store/contracts_test.go#L9).

## Visibility and shared access

### Anonymous workspace summaries

`GET /api/public/workspaces/{id}/summary` reads live metadata for link/public
workspaces. `HEAD` checks the same visibility without returning a body. Existing
`ws_` identifiers remain the link identity. The response contains the workspace
name, description, color, tags, privacy, owner display name, chapter names and
file names, including unfiled files. It contains no material content, extracted
text, internal content IDs, blob keys, download URLs, member details or account
email. This is a metadata projection, not an AI-generated content summary.

The query reads visibility, owner lifecycle and metadata in one SQL snapshot.
Private, missing or malformed IDs and suspended, deletion-pending or deleted
owners return `404`; an authenticated owner does not bypass private-summary
exclusion. Over-quota owners retain summary reads under the existing read policy.
Success and failure responses use `Cache-Control: no-store`; no summary cache,
queue, R2 or KV invalidation is involved. More than 1000 chapters or a projection
larger than 256 KiB returns `422` rather than a truncated outline.

Owners edit an optional description through ordinary workspace PATCH. It accepts
at most 1000 characters; omission preserves the value and an empty string clears
it. Clones copy the description. Existing name/color/tag and lifecycle
permissions remain in force.

Sources: [public handler](../server/internal/httpapi/huma_workspace_summary.go),
[live projection](../server/internal/store/workspace_summary.go), and
[authentication boundary](../server/internal/httpapi/server.go).

### Private workspaces

Only the owner and explicit members can read a private workspace. Unauthorized
callers generally receive `404`, which avoids revealing whether the private
resource exists.

### Link and public workspaces

Signed-in users with the URL can read link and public workspaces. Only public
workspaces are listed in Explore, which also requires authentication. Files and
materials inherit their workspace visibility, but reading their content requires
a session. Anonymous visitors receive only the minimal workspace summary below.

The workspace's `shareRole` grants an effective role for material
collaboration to every **signed-in** caller:

| Shared visitor                        | Read workspace/materials/files | Edit material document | Comment | Change workspace structure/files |
| ------------------------------------- | ------------------------------ | ---------------------- | ------- | -------------------------------- |
| Signed-in `editor` share role         | Yes                            | Yes                    | Yes     | No                               |
| Signed-in `commenter` share role      | Yes                            | No                     | Yes     | No                               |
| Signed-in `viewer` share role         | Yes                            | No                     | No      | No                               |
| Anonymous visitor, for any share role | No; summary only               | No                     | No      | No                               |

Important boundaries:

- A share role applies to **material collaboration**, not structural workspace
  authorization. Shared editors cannot add chapters, upload files, use
  workspace chat/generation, manage members, or change sharing.
- Anonymous visitors cannot read workspace contents, standalone materials,
  files, previews, editor assets, quizzes, flashcards, or Explore. They cannot
  obtain material collaboration access. The public summary is their only
  workspace read endpoint; write routes still require authentication.
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
- A workspace material has no independent visibility policy. Its stored privacy
  is forced to `private`, and read access always follows the workspace. Only a
  standalone material may be private, link-shared, or public on its own.
- Shared material editors may change document content through collaboration,
  but REST metadata changes such as title, filing, scope, or privacy require an
  explicit owner/editor membership.
- Changing visibility or `shareRole` moves everyone's effective role, so it
  evicts live collaboration connections the same way a membership change does.
- Structural workspace writes lock the workspace and re-read the actor's
  current membership in the same transaction as the mutation. A request that
  began while someone was an editor cannot commit after the owner removes or
  demotes them. Upload and editor-asset finalization apply the same final check
  to the actor who created the reservation.

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
- Over-quota owners cannot create invitations or promote an existing member,
  because either action widens exposure. They may demote or remove members as
  recovery-safe mutations.
- Ownership is not assigned through a normal role change. The owner must use
  **transfer ownership** and select an existing live member.
- On transfer, the recipient becomes owner and assumes the complete storage
  bill. The old owner remains as an editor. Transfer is refused if the recipient
  cannot fit the workspace's used and reserved bytes or file count.
- Workspace creation, clone, and transfer-to-recipient all run the owned-workspace
  plan gate. Both current plans are unlimited (`owned_workspace_limit IS NULL`),
  but the gate is ready for a finite catalog value without changing those flows.
- An over-quota owner may still transfer because giving away bytes is a recovery
  action.
- Invite email delivery is intentionally independent of later workspace
  deletion. A message already queued may still send; its link is the authority.
  A live account without a nonblank email still receives the in-app invite or
  membership notification, but no email-outbox row is created.
  Invite acceptance joins the workspace owner lifecycle, so a missing,
  over-quota, suspended, deletion-pending, deleted, expired, revoked, or
  otherwise invalid invite uses the same non-disclosing unavailable-workspace
  response as a missing shared workspace. There is no separate email-job
  retraction mechanism.
- Acceptance locks the workspace first, then locks the owner and recipient
  accounts in canonical ID order. Reciprocal invitations therefore cannot take
  the same two account rows in opposite order.

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
- Direct cloud-source inspection treats DNS and connection failures as
  retryable provider outages. Request cancellation remains cancellation.

Sources: [chapter and file handlers](../server/internal/httpapi/huma_content.go#L54),
[source upload guard](../server/internal/httpapi/uploads.go#L40),
[editor asset guard](../server/internal/httpapi/editor_assets.go#L164), and
[owner storage gate](../server/internal/httpapi/server.go#L234).

### Notes and other material documents

- Owner and explicit editor members can create materials in a workspace. Their
  visibility is inherited from the workspace and cannot be changed separately.
- Owner, explicit editors, and signed-in shared editors can edit the live
  document body.
- Only explicit owner/editor access can change material metadata through
  `PATCH /api/materials/{id}/metadata`. Publishing a material additionally
  requires a fully writable actor account.
- Owner and explicit editor members can delete a workspace material. For a
  standalone material, only its owner can edit or delete it.
- Material revisions are readable to users who can read the material.
- Revision history keeps one latest snapshot per UTC day, up to 30 daily
  snapshots for Pro and three for Free. A downgrade immediately and permanently
  prunes everything beyond the newest three snapshots. Resubscribing does not
  recover the discarded 27 Pro snapshots.

Sources: [material handlers](../server/internal/httpapi/huma_materials.go#L41),
[explicit metadata restriction](../server/internal/httpapi/huma_materials.go#L184),
and [material editor checks](../server/internal/store/share.go#L209).

### Comments and live collaboration

- Owner, editor, and commenter roles can list discussions, create a discussion,
  reply, and resolve or reopen a discussion. This includes effective
  link/public share roles for signed-in users.
- A user can edit only their own comment.
- A user can delete their own comment or discussion. Owners/editors can also
  delete another user's comment or discussion; commenters cannot.
- Signed-in viewers get static read-only material rendering and cannot join
  the collaboration room. Anonymous visitors must sign in to read materials.
- Discussions and comments carry their author's display name and avatar. The
  client does not resolve authorship against the current member list, so a
  contributor who has since left the workspace stays attributed and a reader
  without a roster still sees who wrote what.
- Collaboration tokens encode `write`, `comment`, or quota-recovery `shrink`
  access. A token's document growth rule follows the material's storage owner,
  not the connecting editor. The collaboration server rechecks actor lifecycle,
  current membership/share role, owner lifecycle, and current quota state when
  admitting a connection, synchronizing a refreshed token, and persisting each
  save. Server-owned provenance travels in the same Yjs transaction as each
  edit, and the durable store rechecks every contributor in its exact debounced
  snapshot. A rejected raced update is never committed; the room is evicted so
  its unauthorized in-memory state cannot be retried later. Workspace saves
  lock workspace, ordered accounts, then material; standalone saves lock
  ordered accounts before material, matching the Go mutation order. The server
  treats Free-only subscription history as ordinary active Free access. It
  restricts an over-limit owner to shrink-only editing only after an expired or
  closed Pro boundary, including when a live Free row also exists. The server
  also closes the connection when the short-lived token expires and checks
  expiry on every inbound update or stateless event.
- ACL and lifecycle mutations enqueue room/user evictions transactionally in a
  database outbox. Redis delivery is retried with one stable eviction ID and is
  complete only after every active collaboration instance returns a positive
  acknowledgement. A negative or lost acknowledgement keeps the item retryable
  and replays a deduplicated eviction. Revocation,
  deletion, ownership/placement changes, plan downgrades, and account locks use
  discard. Provably monotonic ACL changes use drain: they block new room
  traffic, persist accepted pending edits, and refuse acknowledgement when that
  final store fails. Account and plan restoration flushes pending stores but
  leaves the room loaded and every connection open. Workspace monotonicity compares
  the effective nonmember grant; a share role is dormant while the workspace is
  private, so changing that role or widening privacy from private drains rather
  than discarding accepted edits. Restoration user events do not close
  connections. Compaction uses the unload-and-reconnect durability drain. Material outbox
  delivery resolves the current Yjs room epoch and rechecks it after eviction,
  so an event enqueued beside compaction cannot acknowledge only an obsolete
  room. A failed discard keeps the room blocked until a later retry verifies
  that unload succeeded.
- Comment creation, replies, edits, resolution, and deletion also lock the
  workspace and re-evaluate actor lifecycle and effective role in the database
  transaction that writes the row.

Sources: [collaboration token access](../server/internal/httpapi/huma_collaboration.go#L109),
[discussion/comment authorization](../server/internal/httpapi/huma_collaboration.go#L195),
and [commenter end-to-end coverage](../e2e/sharing/material-modes.spec.ts#L29).

### Quizzes and flashcards

- Readable shared quizzes can be attempted by any signed-in user. Attempts,
  mistakes, and review history belong to the user taking the quiz.
- Quiz/flashcard responses distinguish `isOwner` from `canEdit`. Explicit
  workspace editors receive content controls without receiving owner-only
  sharing/privacy controls; commenters, viewers, and link/public visitors do
  not receive mutation controls.
- Owner and explicit workspace editors can modify workspace quizzes,
  flashcards, and cards. The dedicated quiz and flashcard routes apply the same
  account lifecycle and storage-owner gates as the unified material API.
  Standalone quizzes and flashcards remain owner-controlled.
- Mutation contracts keep authorities separate. Material title/filing/scope use
  `/metadata`. Quiz questions/time limit use `/content`, quiz name/scope use
  `/metadata`, and standalone visibility uses `/sharing`. Flashcard-set
  metadata uses `/metadata`, card authored text uses
  `/flashcards/cards/{id}/content`, card study state uses `/study-state`, and
  standalone sharing uses `/sharing`. Content/metadata paths do not accept
  privacy, and sharing rejects workspace-contained materials before writing
  anything.
- Signed-in commenters, viewers, and shared visitors can read a shared quiz or
  flashcards, but cannot change its questions or cards. Anonymous visitors must
  sign in to read this content.
- Cloning a readable shared quiz, flashcards, material, or workspace creates a new
  owner-controlled copy charged to the signed-in cloner.
- Clone source content is one repeatable-read SQL snapshot. Clones never lock a
  source workspace/material or wait for Yjs persistence/projection; a stale SQL
  projection is an explicitly accepted result. Clone counters live on separate
  rows, while source-owner and target account locks are acquired in canonical ID
  order.
- A single-material clone is always standalone and private. Referenced ready
  media is rehomed under fresh asset IDs owned by that clone; it never retains
  authorization-bearing asset IDs from the source workspace.
- Suspension blocks the suspended actor's own API access, but it does not hide
  content they already shared from another active user's clone. Material and
  workspace clones apply that rule consistently; deletion pending and deletion
  still make the source unavailable.

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
  `llm_credits_exhausted`). Ingest claim-time checks owner lifecycle/storage
  and actor lifecycle/credits separately. Ordinary ingest also requires the
  actor to remain the workspace owner or an explicit editor at claim,
  heartbeat, provider admission, and every final write. A demotion or removal
  cancels the exact job attempt and reservation. These boundaries use the same
  lock order as workspace mutations: workspace, ordered accounts, membership,
  file, then job, followed by the exact attempt when provider admission needs
  both. Over-quota actors may still process work in a
  healthy owner's workspace, while suspended, deletion-pending, deleted, and
  access-revoked actors cannot start or continue billed work.

Sources: [chat ownership and editor guard](../server/internal/store/chat.go#L44),
[generation editor guard](../server/internal/httpapi/server.go#L496), and
[generation credit policy](../server/internal/httpapi/generation_credits.go#L3).

### Personal account features

Events, tasks, labels, notifications, integrations, billing, search, quiz
attempt history, and mistakes are scoped to the authenticated user's own rows,
not to a workspace role. Over-quota users cannot create new calendar events but
may update or delete existing events/tasks as recovery-compatible mutations.
Planner, preference, credential, attempt, and canvas writes recheck account
lifecycle under the user-row lock in the mutation transaction rather than
relying only on middleware admission.

Source: [schedule lifecycle gates](../server/internal/httpapi/huma_schedule.go#L47).

## Account lifecycle gates

Account lifecycle is evaluated after identity authentication and before or
during a write. Severity is ordered as deleted, deletion pending, suspended,
then storage state. The same boundary is enforced for Clerk, development, and
E2E identities.

| Account state       | Hold/use a session | Read          | Create/upload/clone                                                                   | Ordinary edits or publishing                     | Delete/rename/reorder | Material document editing                                |
| ------------------- | ------------------ | ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------- | -------------------------------------------------------- |
| `active`            | Yes                | Yes           | Yes, subject to role and hard quota                                                   | Yes                                              | Yes                   | Full write                                               |
| `over_quota_grace`  | Yes                | Yes           | No storage creation where this account pays; some non-storage create routes also gate | No exposure-widening or unrestricted actor edits | Yes, subject to role  | Shrink-only where this account owns the material storage |
| `over_quota_frozen` | Yes                | Yes           | No storage creation where this account pays; some non-storage create routes also gate | No exposure-widening or unrestricted actor edits | Yes, subject to role  | Shrink-only where this account owns the material storage |
| `deletion_pending`  | No                 | No API access | No                                                                                    | No                                               | No                    | No                                                       |
| `suspended`         | No                 | No API access | No                                                                                    | No                                               | No                    | No                                                       |
| `deleted`           | No                 | No API access | No                                                                                    | No                                               | No                    | No                                                       |

Grace and frozen accounts may still open a Pro Checkout session: resubscribing
is a recovery action, not content creation. Checkout completion retrieves the
full Stripe subscription when the event carries only its expandable ID before
projecting paid entitlement. Deletion-pending, suspended, and deleted accounts
remain ineligible, and a raced paid Checkout is compensated instead.

`over_quota_grace` and `over_quota_frozen` currently have the same permission
set. Grace lasts 14 days after a paid period lapses; frozen is the state after
that window. Neither state deletes content. The states exist only when the paid
period has lapsed **and** stored bytes exceed the applicable limit. A concurrent
live Free subscription selects Free limits but does not erase the most recent
expired Pro boundary used to derive grace or frozen.

Suspended, deletion-pending, and deleted identities are rejected by the auth
middleware before resource roles are evaluated. Long-lived notification,
ingest, and collaboration connections re-check expiry or account access and
close after the state changes. Suspension is currently database/operator-only;
the Ops dashboard suspend/unsuspend workflow is a separate roadmap item.
Clerk profile synchronization leaves suspended, deletion-pending, and deleted
rows untouched, so a stale identity token cannot refresh PII before the
middleware rejects the session. An empty email-address list means the refresh
did not supply an email; it preserves the stored address instead of clearing
it. Clerk identity events are claimed before
profile provisioning without assigning an unknown user foreign key. A
successful create/update is associated after the local user upsert. A deletion
for an identity that never had a local account is terminally acknowledged with
its payload redacted. The application retains purged local user rows as its
normal tombstone policy; it does not create a negative-identity row for an
identity that was never provisioned.

Clerk profile retrieval and local identity provisioning are separate gates. A
temporary profile-read failure skips synchronization for an existing local
account, preserving its stored name, email, and avatar. If profile retrieval or
upsert fails while the identity is still unknown locally, the request fails
retryably with `503 account_state_unavailable`. Starter-workspace completion is
stored separately on the user row. A failed workspace insert also returns the
retryable 503, and the next authenticated profile sync retries it. Once marked
complete, deleting every workspace does not recreate the starter workspace.
Starter provisioning locks the same user row as ordinary creation, then checks
for an existing workspace, inserts if needed, and stores the marker in one
transaction. If ordinary creation commits first, provisioning records only the
marker.

If the middleware cannot load account lifecycle state, authenticated requests
fail closed with `503 account_state_unavailable`. Database failure is not
treated as an active account and is distinct from a real `403` account lock.

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

The current limits are 100 MB for free accounts and 1 GB for Pro accounts.
Upload reservations count immediately so concurrent uploads cannot both spend
the same remaining quota. Quota errors use `storage_quota_exceeded`; lifecycle
over-quota errors use `account_over_quota`.

Replacing an existing source reserves only positive byte growth. A replacement
that is the same size or smaller remains available to an over-quota owner as a
recovery action; it still cannot proceed for suspended, deletion-pending, or
deleted owners. The ingest worker receives this recovery mode explicitly and
does not reinterpret it as permission for a growing replacement.

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

| Stage                                | Database/storage effect                                                                                                                                                                                            | Bucket effect                                                                        | Background cleanup                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Upload reserved                      | Creates a pending `upload_sessions` row and reserves the declared bytes against the workspace owner                                                                                                                | Browser receives a presigned PUT for an `incoming/` or `editor-assets/incoming/` key | Pending session is eligible for expiry after its presigned deadline                  |
| Upload finalized                     | Creates the source file or editor asset, converts reserved bytes into used bytes, and marks the session completed                                                                                                  | Incoming object is promoted to its stable `sources/` or `editor-assets/` key         | Completed session remains temporarily as an idempotency record                       |
| Upload abandoned/expired             | Marks the session expired and releases its storage reservation                                                                                                                                                     | Both incoming and possible promoted paths are queued, with a 24-hour presign grace   | Upload sweeper runs at startup and every minute, up to 100 expired sessions per pass |
| File/asset deleted                   | Logical row is deleted; workspace deletion and account purge do this through foreign-key cascades too. Pending/running parse, ingest, import, audio, and provider reservations are cancelled at the same boundary. | The path is queued only when its last database reference disappears                  | Blob reaper runs at startup and every minute                                         |
| Shared blob still referenced         | One row/reference is removed, but the remaining clone/reference keeps the blob live                                                                                                                                | Object is not deleted                                                                | Reaper re-checks references before every claim                                       |
| Stable object has no database record | No row exists to enqueue it, for example after a request dies between PUT and row creation                                                                                                                         | Object remains in the bucket                                                         | Monthly orphan sweep reports it after 48 hours; it currently **does not delete it**  |

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
upload returns the already-created file. Concurrent duplicate completions may
race before either database commit. If one request has already moved the
incoming object, the other accepts the stable object only when its recorded
size and content type match, then converges through the same idempotent
finalization transaction. Source replacements use the same rule.

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
editor assets, and upload-session paths. Caption-cache paths are owned and
referenced by `artifact_cache`; `files.caption_blob_path` is identity/debug
metadata rather than a second reference. The triggers run for direct row deletion and
foreign-key cascades, so deleting a file, deleting a workspace, or purging an
account all reach the same cleanup path without relying on an HTTP handler to
enumerate bucket keys.

A bucket object can be shared by multiple rows, notably after cloning a
workspace. Removing one holder decrements the reference count; the path is
queued only after its last holder disappears. If a queued path becomes live
again before deletion, the queue/reference triggers remove the stale request,
and the reaper independently checks for a current reference before claiming it.
Reference changes and the reaper share one advisory lock per object path. The
reaper holds its locks from the final reference check through the B2 delete and
queue settlement, so a transaction that already started adding a reference
cannot commit inside that remote-delete window.

The reaper runs at startup and every minute. It claims at most one S3 batch at a
time, deletes accepted keys, and leaves rejected or failed keys queued with the
failure reason. Claiming advances a five-minute-per-attempt backoff. After eight
attempts a path is no longer claimed automatically; the monthly report includes
the count of these undeletable queue entries for operational follow-up.

Backblaze B2 hides overwritten/deleted versions by default, so deployment must
also apply the configured `daysFromHidingToDeleting` lifecycle rule. Without
that rule, a successful reaper deletion can leave hidden versions consuming
bucket storage.

Audio follows the same synchronous ingest lifecycle as image captions and
other provider-backed derived artifacts. The worker awaits multipart `POST
/v1/speech-to-text` fields without webhook fields, settles the open provider call,
writes the reusable artifact, then continues indexing in the same attempt.
There is no provider transcript row, polling loop, webhook, or remote cleanup
state. A short `provider_capacity_leases` row only enforces ElevenLabs' weighted
Starter concurrency across worker processes and expires after a crash.

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
- lists `sources/`, `captions/`, `derived-text/`, `parse-bundles/`, `previews/`,
  and `editor-assets/`;
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
- the confirmation presents the `lifecycleGeneration` returned by the deletion
  preflight; and
- no live subscription remains (a subscription set to cancel at period end is
  acceptable).

For an account with a persisted Stripe customer mapping, both preflight and
confirmation must reach Stripe before deletion can proceed. A provider outage
or unavailable Stripe client appears as a retryable unavailable blocker; it is
never treated as proof that the account has no live subscription. An unmapped
account may still be deleted when Stripe is intentionally disabled.

Support cancellation increments `users.lifecycle_generation`. A deletion POST
from an older preflight then receives 409 and leaves the restored account
active. A new preflight reads the new generation, so the user can make a fresh
deletion request immediately after restoration. Duplicate requests from the
same uninterrupted deletion window remain idempotent. Deletion-requested and
deletion-cancelled email keys include that generation: retries within one window
deduplicate, while a restored account's later deletion window receives a fresh
notice with its current purge deadline.

Collaborators do not block account deletion. The owner is the lifecycle
authority for every workspace they own, including workspaces with members.

Once requested, the account enters `deletion_pending`, sessions are revoked,
live collaboration rooms are evicted, and queued or running imports, ingest,
parse, audio, and provider reservations are cancelled. The owner's workspaces
and materials immediately disappear from member lists, Explore, direct shared
reads, and clone endpoints. Long-running chat, generate, editor-AI, and ingest
streams recheck both the actor session and workspace access and cancel when
either boundary closes. Suspension does not hide another user's shared content
this way. Clerk revocation reads explicit pages into a complete sweep before it
revokes them, then repeats until no active session remains. A page or sweep
safety limit is a retryable failure, never success. A confirmed empty active
session listing is success even if an earlier revoke returned an uncertain
error, and revoking an already-missing session is idempotent success. The
deletion transaction
records this work before the first Clerk call. A failed sweep remains visible
on the operator user detail with its attempt count, next retry, and last error.
The account worker retries with backoff, and support restoration returns a
conflict until a complete sweep clears the pending flag. The local
`deletion_pending` gate stays closed throughout.

Cancelling a provider session prevents new external calls. It leaves any call
already sent open until that call's receipt deadline. A response that arrives
inside that window records its measured usage once, even after account deletion
or file/job cancellation closed the session. The provider-call sweeper marks a
call abandoned after the deadline if no receipt arrives. No cancelled job is
resumed to obtain that receipt. The worker heartbeat cancels its current async
task when the exact job-attempt claim is gone, which closes an uncertain active
provider request while preserving settlement if the response already completed.

Workspace deletion applies the same rule transactionally: all open provider
sessions scoped to the workspace are released and their reservations returned
before the workspace foreign key is cleared. Already-open call rows remain
settleable, so deletion cannot erase the receipt for provider work that was
already sent.

Memberships, invitations, workspace privacy, and share configuration remain
dormant during the 30-day window. If support cancels deletion before the
deadline, member and link/public access, listings, editing, invitations, and
cloning become available again with the same structural permissions. No
workspace content is rebuilt or approximated during cancellation.

Purge runs after 30 days. During that grace window the durable content remains
recoverable only by support cancelling the deletion after verifying the request
out of band; there is no self-service cancellation endpoint, and cancellation
is refused once the grace deadline has passed. At purge, all
owned workspaces—including shared workspaces—their share links, files,
standalone materials, planner/history data,
memberships, invitations, notification data, credentials, and other
product-content rows are deleted atomically with the account tombstone.
Remaining cross-account attribution is anonymized. Profile PII is scrubbed;
pseudonymous billing, usage, provider, storage, and audit ledgers may remain
under their own retention requirements. A purged account and the 30-day deleted
data cannot be restored.

For a user with a mapped Stripe customer, Checkout first asks Stripe for the
complete paginated set of active, trialing, and past-due subscriptions. Any
live entitlement returns 409. A failed provider read returns 503, so a stale
local projection cannot create a second paid subscription. Checkout then
commits one per-user local reservation before any Stripe write. That local
reservation remains the concurrent-request guard. Customer/session creation
uses reservation-derived idempotency keys; a
delayed recovery job recreates and expires the same remote session if the
request dies before it can bind the provider id locally. Recovery persists the
recovered customer id on both the checkout reservation and the user under the
same user-row lock, rejecting a conflicting customer mapping. Deletion queues
expiration for every open session. Cancelling deletion suppresses pending or
claimed deletion-only expiration/cancellation work before it can begin; refund
obligations for charges that already occurred remain queued. If support later
restores the account and the user starts a fresh deletion window, currently
open Checkout sessions and live non-period-end subscriptions reopen their
matching suppressed cleanup jobs instead of being skipped by the idempotency
key. Binding the normal Checkout response also suppresses and clears the lease
of a recovery job that was claimed but had not acquired the lifecycle lock, so
the stale worker cannot retry an already-bound reservation. Checkout completion
and local binding use the same account-lifecycle lock. If completion reaches the
server before the request binds the Stripe session id, it upgrades the existing
`creating` reservation to `completed` and suppresses recovery; the later bind is
idempotent instead of creating a second row or returning a false failure. If a
bind has an unknown commit outcome and the request successfully expires the
remote session, a follow-up local write converges either `creating` or `open` to
`expired` and suppresses recovery. That write also persists the new customer id
on the reservation and user before suppression, so daily reconciliation can
still find the customer. Checkout completion rejects any disagreement between
the signed event customer, reservation customer, and user's customer mapping.
Subscription metadata, the existing customer mapping, and any existing local
subscription owner must resolve to the same user. A disagreement leaves the
signed webhook event retryable and makes no association or subscription
mutation. A metadata-attributed subscription binds its Stripe customer, checks
both customer and subscription ownership, writes provider state, reprojects the
plan, and queues any closed-account compensation in one user-row transaction.
This makes the customer visible to daily reconciliation even when Checkout
binding never committed. The store enforces the identity checks again inside
that transaction.

If Stripe completes a checkout after deletion or suspension has closed the
account boundary, the webhook grants no entitlement and durably queues
subscription cancellation plus refund of the paid object on that new
subscription's latest invoice (the checkout's initial invoice).
Refund ids are persisted and polled until terminal; a failed/canceled refund
starts a new idempotency generation. Network failures retry the same generation
with a lease/backoff. Subscription webhooks and daily Stripe reconciliation are
the backstop: neither re-entitles a suspended, deletion-pending, or deleted
user, and they queue compensation for any live provider subscription they
discover unless it was already scheduled to cancel at period end.
Subscription webhooks and reconciliation re-read lifecycle state under the
user-row lock. For a closed lifecycle they preserve Stripe's live subscription
rows as provider truth, force the denormalized user projection to Free/canceled
when provider rows exist, and queue compensation. With no provider rows, the
stored tier remains canonical for revision retention while the lifecycle gate
still denies access. Failed-invoice updates follow the same closed-lifecycle
rule and never move a terminal subscription back to `past_due`, even if the
invoice event has a newer timestamp. Because Stripe does not order
invoice and subscription webhooks, Checkout writes the user id on both the
session and the subscription it creates. A subscription event that arrives
before local customer binding resolves through that provider metadata. A
failed invoice for a known, non-purged customer remains retryable until its
subscription row arrives. A metadata-free checkout completion with no local
customer mapping, a subscription with neither a mapping nor valid application
metadata, and subscription or invoice events for purged tombstones are terminal
orphans and are acknowledged. Their provider bodies are replaced with `{}`
before terminal acknowledgement; associated event identity and processing state
remain for idempotency and diagnostics. Webhook identity uses provider plus
event id, so equal Clerk and Stripe opaque ids are independent. This also
applies when an invoice resolves through a retained subscription row owned by
the purged tombstone. Immediately
before cancellation can touch Stripe,
the worker durably marks the compensation
as provider-started. Support restoration returns a conflict while such a job is
pending or running, because the remote outcome may be newer than local truth.
The worker then re-reads the subscription from Stripe. If provider truth says a
still-live subscription is already scheduled to cancel at period end, the
worker suppresses immediate cancellation without refunding the paid invoice or
writing a terminal local tombstone. A later provider event that removes
period-end cancellation reopens the idempotent cleanup while the account
lifecycle remains closed. Stripe may retain the period-end flag after the
subscription is already canceled; that combination completes the local
terminal tombstone without refunding the consumed period.
A successful remote cancellation marks that local subscription canceled in the
same transaction that completes the compensation job. If its creation webhook
has not arrived yet, completion inserts a minimal canceled ordering row so a
delayed pre-cancellation event cannot grant entitlement after restoration; a
genuinely newer live provider event can still reopen the idempotent cancellation
job. Reversible lifecycle projection does not prune paid material revision
history while the effective tier is Pro, whether that comes from preserved
provider rows or from the stored tier when no subscription row exists. Once no
started cancellation is unresolved, cancelling deletion re-derives the
projection in the restoration transaction, so it immediately adopts whichever
provider transition actually completed: a still-live subscription restores
entitlement, while an already-canceled one remains Free. A concurrent closure
therefore removes local entitlement without making support restoration depend
on a later webhook or daily pass. When no subscription row exists, restoration
preserves the stored tier/status; only an active reconciliation with an
explicitly empty Stripe snapshot establishes Free provider truth.

Existing Plate mentions store their rendered label in the document and do not
depend on the current member directory. If a label is absent, the stored
identifier is the fallback; purging a member therefore does not make a document
unrenderable or block the editor.

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
