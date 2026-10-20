---
type: Backend
title: "Authorization, Permissions, and Lifecycles"
description: "Authorization roles, account lifecycle gates, storage ownership, and file cleanup behavior across workspaces and materials."
tags: [backend, authorization, permissions, lifecycle, storage, quota, files]
---

# Authorization, permissions, and lifecycles

This page documents the authorization behavior implemented as of 2026-09-08.

Authorization is the intersection of four independent questions:

1. **Visibility:** is the resource private, shared by link, or public?
2. **Role:** is the requester an owner, explicit workspace member, signed-in
   shared visitor, or anonymous visitor?
3. **Actor lifecycle:** may the signed-in user still hold a session and perform
   this category of mutation?
4. **Storage ownership:** whose quota is charged if the operation adds bytes?

Passing one layer does not bypass another. For example, an editor has permission
to upload, but the upload is still refused when the uploader's own quota
cannot accept it (uploader pays, Sam 2026-10-18).

## Permission matrix

Membership roles are `owner`, `editor`, `viewer`. A link/public workspace also
carries a `shareRole` of `editor` or `viewer` that applies to every signed-in
nonmember of a public workspace, and to a nonmember of a link workspace once
it has presented the signed link (see Link and public workspaces). A caller's **effective role** is the more permissive of their
membership and the share role. Content authority follows the effective role;
workspace settings and membership follow persisted membership only. Migration
`0032_workspace_editor_viewer_roles.sql` applies these role constraints and ACL
triggers to existing databases; unsupported persisted roles fail migration
validation instead of being remapped.

| Capability                                                                                  | Owner | Editor member | Link/public editor | Viewer member | Link/public viewer | Anonymous    |
| ------------------------------------------------------------------------------------------- | ----- | ------------- | ------------------ | ------------- | ------------------ | ------------ |
| Read materials and files, download sources, use workspace chat                              | Yes   | Yes           | Yes                | Yes           | Yes                | Summary only |
| Edit material document content (collaboration `write`)                                      | Yes   | Yes           | Yes                | No            | No                 | No           |
| Create and edit comments; delete **own** comments                                           | Yes   | Yes           | Yes                | No            | No                 | No           |
| Delete **another user's** comment or discussion                                             | Yes   | No            | No                 | No            | No                 | No           |
| Chapters, upload/rename/move/delete files, material metadata and delete, generate materials | Yes   | Yes           | Yes                | No            | No                 | No           |
| Workspace name, description, tags, privacy, `shareRole`, statistics                  | Yes   | Yes           | No                 | No            | No                 | No           |
| Invite/remove members, change roles, delete or transfer the workspace                       | Yes   | No            | No                 | No            | No                 | No           |
| Member roster (`userId`, `name`, `avatarUrl`, `role`; never email)                          | Yes   | Yes           | No                 | Yes           | No                 | No           |
| Mention directory (`userId`, `name`, `avatarUrl`)                                           | Yes   | Yes           | Yes                | No            | No                 | No           |
| Clone the workspace                                                                         | Yes   | Yes           | Yes                | Yes           | No                 | No           |
| Clone one of its files or materials (into a workspace the cloner edits, or a material standalone) | Yes | Yes         | Yes                | Yes           | No                 | No           |
| Clone a standalone link/public quiz, flashcards, or material                                | Yes   | —             | —                  | —             | Yes                | No           |
| Take a standalone link/public quiz or study its flashcards through the signed link           | Yes   | —             | —                  | —             | Yes                | Yes, kept in the browser |
| Record own study progress and review ratings ([study-progress.md](study-progress.md))        | Yes   | Yes           | Yes                | Yes           | Yes                | No           |

Owner and editor satisfy `canEdit`; only owner satisfies `canManageMembers`.
The API returns these request-scoped capabilities on workspace and material
responses. On a workspace response `role` is the persisted membership (absent
for a share-role visitor) while `capabilities` follow the effective role, so a
client keys settings on `role` and content controls on `capabilities`. A
frozen account turns `canEdit` off: the requester's own (everywhere, and
`canClone` with it), and on a material the frozen (or suspended) payer's;
quiz and flashcard `canEdit` follow the same rule. A material's
`canEditContent` (edit mode, comments, annotations, quiz and card edits) is
`canEdit` narrowed further by its payer at or over its limit (usage `full`,
grace included), so organizing stays on while content is view-only; the
workspace's `canEditContent` equals its `canEdit` (uploader pays: storage
narrows items, not workspaces).
The client has no frozen or storage-limit logic of its own for these.

Sources: [role definitions](../server/internal/store/enums.go#L62),
[role resolution](../server/internal/store/share.go#L27), and
[capability contract test](../server/internal/store/contracts_test.go#L9).

## Visibility and shared access

### Anonymous workspace summaries

`GET /api/public/workspaces/{token}/summary` reads live metadata for
link/public workspaces; it takes the share token `{id}.{signature}` and
verifies it again, so a bare id answers 404 (Sam 2026-10-18). `HEAD` checks the same visibility without returning a body. The
browser link is `/w/{id}.{signature}`, returned as `sharePath` on every workspace
response: a 12-byte HMAC-SHA256 of `share:v1:{id}` under `SHARE_LINK_SECRET`,
base64url-encoded ([Go](../server/internal/store/share_link.go),
[TypeScript](../src/lib/shareLink.ts)). The site Worker answers an unsigned or
forged path with the same 404 page before any API call, so guessed IDs never
reach Go or Postgres. The signature only proves the link came from us; the
summary query still decides visibility, so unsharing works as before, and
rotating the secret replaces every link at once. The response contains the workspace
name, stored `iconId`, description, tags, privacy, owner display name, chapter names and,
for every file including unfiled ones, its name, `sizeBytes` and `addedAt`. It
contains no material content, extracted text, internal content IDs, blob keys,
download URLs, member details or account email. This is a metadata projection, not an AI-generated content summary.

The query reads visibility, owner lifecycle and metadata in one SQL snapshot.
Private, missing or malformed IDs and suspended, deletion-pending or deleted
owners return `404`; an authenticated owner does not bypass private-summary
exclusion. Over-quota owners retain summary reads under the existing read policy.
Success and failure responses use `Cache-Control: no-store`; no summary cache,
queue, R2 or KV invalidation is involved. More than 1000 chapters or a projection
larger than 256 KiB returns `422` rather than a truncated outline.

The summary uses one full-width panel with a centered reading column, including
its 404 and loading-error states. The header sits inside the panel with text-only branding on the left and a sun/moon theme
toggle, large ghost-hover sign-in button and equally large sign-up button on the right. The toggle switches
between Light (Latte) and Dark (Mocha), and is also used on authentication pages. Every visitor gets this
header, signed in or not: it never reads the session, so nothing shifts or flashes and the edge copy stays
shared. Its Sign in and Sign up carry no `redirect_url`; a signed-in visitor who presses them lands on the
dashboard. The Worker renders the whole page, header and ⋮ included, and neither needs React: the theme
button shows the moon or sun by CSS and `publicChrome.ts` switches the stored theme (a head script applies it
before first paint), and the ⋮ is a native popover anchored to its button with Clone as a plain link
(`PublicActionMenu.tsx`). The page's script (`src/summary/main.ts`) only wires those, points the file icons at
the sprite and loads analytics after the page (public pages carry no Sentry). Every public page's head comes
from `src/lib/seoHead.ts`: title, description (the workspace description, or for an item a generated line such as
"A quiz by {author}: N questions · M marks", or the first 160 characters of a note's paragraphs), canonical, robots (`index` only for
public items), Open Graph with `og:locale` `en_US` and `article:modified_time` when the item has one, a Twitter summary
card and schema.org JSON-LD (`CreativeWork`, `Quiz`, `LearningResource` for flashcards, `Article` for notes); no
`og:image` until file thumbnails exist. The workspace uses its stored icon and
shows the owner's avatar (`authorAvatarUrl`, 1px high) beside their name in its byline, and a ⋮ beside the
name offers Clone workspace (see Clone from a public page below). Chapter and file rows use the file panel's
Catppuccin sprite and filename icon mapping, with file icons shifted up 1px;
the client supplies the hashed sprite URL. Files outside chapters remain visible
without an “Unfiled files” heading. Workspace Share and Settings → Sharing put
Preview beside Copy for link/public workspaces; it opens the summary in a new
tab. Private workspaces still have no anonymous or owner-bypass summary.

Local MSW development renders signed `/w/` paths from the server's seed data,
with seed `sharePath` values signed by the dev secret in `src/lib/shareLink.ts`, since
browser MSW cannot intercept the server-side fetch. World History (`ws_hist`)
has four chapters and twelve readable source files for previewing the outline.
Biology 101 (`ws_bio`) is also shared by link in the seed, with a sample description for immediate preview.
Browser-only changes to MSW records do not update this server seed snapshot.

Workspace POST accepts optional `iconId` and `description`, with the same catalog
validation and 500-character description limit as PATCH. Omitting the icon keeps
the persisted random Waves default; new workspaces remain private. Create and
edit share the General form fields and SimpleDialog styling; settings embeds that form.
Each frontend creation draft selects a random Waves icon when opened, preserves
it while the draft is edited, and submits the previewed icon with the form.

Owners edit an optional description through ordinary workspace PATCH. It accepts
at most 500 characters; omission preserves the value and an empty string clears
it. Clones copy the description. Existing name/tag and lifecycle
permissions remain in force.

Sources: [public handler](../server/internal/httpapi/huma_workspace_summary.go),
[live projection](../server/internal/store/workspace_summary.go), and
[authentication boundary](../server/internal/httpapi/server.go).

### Anonymous quizzes, flashcards and notes

Standalone quizzes and flashcard sets that are link-shared or public open for
signed-out visitors at `/share/quizzes/{id}.{signature}` and
`/share/flashcards/{id}.{signature}`, the `sharePath` their API responses carry
(notes at `/share/notes/…`; `GET /api/materials/{id}` carries it too, for the
owner's Share item in the open material's ⋮ menu, as the Blocks tab cards' list
rows do). The token is the summary's `share:v1:{id}` HMAC. Workspace materials have no
sharing of their own (a check constraint keeps their privacy `private`) and
embedded ones follow a note visitors cannot open, so neither is reachable.

The site Worker renders these pages (`workers/site/handler.ts`) the way it renders summaries: it verifies the
token before any API call, reads `/api/public/{quizzes|flashcards|notes}/{token}`, renders the page in
English (public pages ignore `Accept-Language`: there are no per-language paths and only a few UI strings
differ), puts the page's own stylesheets inline (`inlineStylesheets`, so first paint waits on no other request;
MathLive's static stylesheet only when the note has math) and caches the HTML at the edge for five minutes, one
copy per item. Images go through
`GET /p/{quizzes|flashcards|notes}/{token}/assets/{assetId}`, verified and cached the same way. A note's
audio takes the same route, which answers `302` to the five-minute bucket link Go signs, with
`Cache-Control: no-store` (Epo 2026-10-15): the player reads it in ranges, which a cached, buffered copy
would not serve, and re-requests the route on a media error, so a seek after the link expired gets a fresh
one (`MediaAssetView`). The share pages' policy has no `media-src` or `default-src`, so the bucket host is
not blocked. Anything else (SVG, any other type) is still refused with `503`. Grading posts
straight to `/api/public/.../grade`, because a Worker subrequest reaches the API without the visitor's IP, which
the per-IP caps need. Go verifies the token again on `/api/public/...` because the API hostname is public, and
reads visibility and the owner's lifecycle in the same statement as the content. Quiz reads are answer-free
(`questions.LearnerView`), like every read for viewing; grading returns the keys for the attempt just graded and
stores nothing on the server. Flashcard reads carry written cards only (a new set's blank starter card is left
out), never the owner's study state. An image is served only when it belongs to the item and appears in its
current content, checked against the full content so a worked solution's images resolve after grading.
Unsharing takes up to five minutes to clear the edge. A forged link, unknown kind, or private, unshared or
missing item gets the summary's not-found page (404), any other failure its unavailable variant (503); owners
preview their items in the app.

The renderer (`src/share/server.tsx`) is built by Vite as its own bundle (`vite build --ssr` into `dist/_ssr`,
kept out of the static assets by `.assetsignore`; `wrangler.jsonc` aliases it as `capy-share-render`), so the page
components keep their browser imports; libraries that only run in effects or on click (Mermaid, MathLive's
editor, jsxgraph, KaTeX, the app's embed editors) are empty modules there. It writes the data it rendered from
into `<script id="share-state">`, and the page's script (`share.html`, `src/share/main.tsx`) never fetches it
again. A quiz or flashcard set hydrates whole (`StudyPage.tsx`, the same tree on both sides, in English). Clerk loads after hydration without its UI bundle (`prefetchUI={false}`) and is asked only when an
attempt is submitted or a card rated (`src/share/session.ts`): signed in, the attempt or rating goes to the
account (`POST /api/quizzes/{id}/attempts`, `POST /api/review/ratings`); signed out, the share route grades and
the browser keeps it. Without a Clerk key (MSW, e2e) `?anonymous` selects the signed-out path; under MSW the dev
server signs the mocks' placeholder links and answers the Worker's API reads from the MSW handlers
(`src/summary/vite.ts`). The pages drop the label
above the title; the owner (`author`: name and avatar, on the public reads and on the single quiz and
flashcard reads) sits under the title with the item's `updatedAt` after a centre dot ("Name · Updated
{date}", in UTC so server and browser agree), then, further down and closer to the content, the question
count, or for flashcards Card N of M just above the card. A ⋮ beside the title offers Clone.

Link and public standalone notes open at `/share/notes/{id}.{signature}` the same way. The API read returns
the note's read projection (Plate JSON) with its owner and update time; the Worker renders it with the static
renderer (`MaterialPreview`) to HTML for good, leaving out a first heading that repeats the title, and the
browser loads no renderer: equations are MathLive's static markup (the page links MathLive's static and font
stylesheets only when the note has math), code is highlighted on the server, a YouTube block is its poster
until clicked, and the contents block scrolls with plain script. Only islands take React
(`src/features/materials/Island.tsx`, `src/share/islands.tsx`): images, charts and graphs (double-click preview),
diagrams (Mermaid draws in the browser), interactive HTML blocks (no View source: its dialog needs the app
router; `PublicPageContext`) and embedded quizzes and sets, each hydrated from the props the server wrote
beside it, all at load so nothing changes size mid-scroll; a note without them loads no React. Public pages
load no zod: `@/i18n` leaves zod's message locale to the app entry (`src/main.tsx`), and grading's number
pattern lives in `src/features/questions/quantity.ts`. Mentions render the name stored in the note.
`GET /p/notes/{token}/assets/{assetId}` serves an image or audio only when the note's current content shows it
(`materialdoc.EditorAssetIDs`). The read also returns `embeds`: each quiz and flashcard set the note owns,
references in its current content and has not trashed, in reference order (quizzes answer-free, flashcards
written cards only); they render in place (`src/share/PublicEmbed.tsx`) and are the only note data the page's
script receives. The note's asset route also serves an image one of those embeds shows, owned by that embed.
Visitors grade an embedded quiz at `POST /api/public/notes/{token}/quizzes/{quizId}/grade`, which has the same
caps as the quiz grade, stores nothing, and returns 404 for any quiz the note does not embed and reference.
Embedded quizzes and flashcard sets are named by a random UUID that is never displayed, and they are left out of
every materials listing, Explore, search and the workspace quiz count.

#### Clone from a public page

Clone opens the dashboard with `?clone=<kind>:<id>` (`src/lib/cloneLink.ts`); the app's sign-in check sends a
signed-out visitor through sign-in and back with the query. The dashboard loads the item into its clone form
(`CloneLinkDialog`: a workspace through the clone form below, a quiz, flashcards or note through `CloneItemDialog`,
whose standalone source defaults to No workspace), shows a refused clone's reason in the dialog (a link viewer
cloning a workspace sees that only members and editors may clone it, a full plan the storage message), and opens
the copy. An item is checked before its form opens: an embedded quiz or flashcards, or an item in a workspace whose
`canClone` is false (a link or public viewer), shows why it cannot be copied instead of a form ending in "not
found". The ⋮ is the same for every visitor and could read auth client
side for future items, since a dropdown cannot shift the layout.

Visitors' attempts and flashcard reviews live only in that browser's IndexedDB
(`src/lib/localDb.ts`) and are never imported into an account on sign-in. Every
part is graded through that API route, by reference to the stored quiz; the
anonymous caps in [observability-metering.md](observability-metering.md) count
only the open parts Jev grades.

Sources: [Worker routes](../workers/site/public.ts),
[public handlers](../server/internal/httpapi/huma_anonymous.go) and
[projections](../server/internal/store/anonymous_materials.go).

### Private workspaces

Only the owner and explicit members can read a private workspace. Unauthorized
callers generally receive `404`, which avoids revealing whether the private
resource exists.

### Link and public workspaces

Public workspaces are open to every signed-in user and listed in Explore,
which also requires authentication. Link sharing copies Google's "anyone with
the link" plus resource key (Sam 2026-10-18): a signed-in nonmember reaches a
link workspace, or a standalone link material, only after presenting its signed
link once (`/w/{id}.{signature}`, the summary's Open going through
`/open/{token}`, a share page's signed-in attempt or rating, or a public
page's Clone, which carries the token as `?clone=<kind>:<token>`). `POST
/api/share/redeem` verifies the token, checks the resource is link or public
now, and records the grant (`workspace_link_grants`, `material_link_grants`,
migration 0096); later calls use the bare id. Members and owners never need it.
Making the workspace or material private deletes every grant, so sharing it
again needs the link again; so does filing a standalone material into a
workspace, which turns it private from a BEFORE trigger (the clearing triggers
are plain `AFTER UPDATE` with a `WHEN` on the final row, since `UPDATE OF
privacy` would miss that). The checks are `workspaceRoles`,
`materialEffectiveAccess`, `linkReachSQL` (source access, chat), the comment
lock, the collaboration server's `live_access` and the pipeline's source
refresh fences. Logs and telemetry keep share and invite tokens out
(`stripUrlTokens`, `obs.LogPath`), and the SPA moves an arriving token out of
the address bar into sessionStorage before anything records the page
(`urlTokenStash.ts`; see the observability doc). Files and
materials inherit their workspace visibility, but reading their content requires
a session. Anonymous visitors receive only the minimal workspace summary below.

The workspace's `shareRole` grants an effective role to every **signed-in**
nonmember; see the permission matrix above for what each column may do.

Important boundaries:

- A share-role editor holds the same content authority as an editor member:
  document body, comments, chapters, files, material metadata and deletion,
  generation and clone. Bytes and inference credits are charged to the actor
  (uploader pays). This is deliberate so users can predict what an edit
  link grants.
- A share role never reaches workspace settings or membership. Renaming,
  tagging, changing privacy or `shareRole`, reading statistics,
  inviting, and deleting or transferring read persisted membership only.
- Anonymous visitors cannot read workspace contents, notes, files, previews,
  or Explore. The public summary is their only workspace read; standalone
  link/public quizzes and flashcard sets (and those quizzes' images) are their
  only material reads, through signed links. Write routes still require
  authentication.
- Roles are grants rather than caps, so a member's effective role is the **more
  permissive** of their membership and the share role. A viewer invited to a
  workspace shared for editing edits like any other editor. Capping them would
  not restrain anyone, since the same link already hands editing to every other
  signed-in account.
- A share role never lowers a membership. An editor member keeps editing on a
  view-only link.
- A link/public viewer reads and chats but cannot clone the workspace, nor
  any file or material in it one by one (Epo 2026-10-11); members of any role
  and share-role editors can. Workspaces are large and cloning is kept rare;
  sources remain downloadable one file at a time. Workspace responses, Explore
  rows included, carry `canClone` computed server-side from the caller's
  effective grant (`CanCloneFrom`); the client offers the workspace action in
  the workspace card menu, the settings General tab, and Explore, and Clone on
  file and material rows, only when it is true. Explore's quiz and flashcard
  rows carry their own `canClone` (true for a standalone public item, else the
  caller's grant on its workspace) and show Clone only when it is true. A viewer member's otherwise empty row
  menu then holds Clone alone.
- The share URL is the permanent `ws_` identifier so bookmarks and search
  listings keep working. Revoking access means setting privacy to `private`;
  re-enabling link sharing re-arms the same URL.
- A workspace material has no independent visibility policy. Its stored privacy
  is forced to `private`, and read access always follows the workspace. Only a
  standalone material may be private, link-shared, or public on its own.
- Changing visibility or `shareRole` moves everyone's effective role, so it
  evicts live collaboration connections the same way a membership change does.
- Content writes lock the workspace and re-read the actor's current effective
  role in the same transaction as the mutation; settings writes re-read the
  persisted membership. A request that began while someone was an editor
  cannot commit after the owner removes or demotes them or narrows the share
  role. Upload and editor-asset finalization apply the same final check to the
  actor who created the reservation.

- Transactions that lock several of these rows take them in one order:
  workspace (`storageOwnerTx`, `FOR UPDATE`), then accounts in ID order
  (`lockAccountSessionsTx`), then the material or file. A foreign key counts:
  inserting a row that references the workspace share-locks it, so a provider
  session or note index job locks the workspace before the account
  (`BeginProviderSession`, `RequestMaterialIndex`); the other order deadlocked
  against source checkpoints and projections. Work under these locks stays on
  its transaction's connection (an ingest job payload reads its rates there),
  since a second pool connection can wait behind requests that themselves wait
  on those locks. Read-only admission rechecks take no locks: a source edit
  recheck (`CheckSourceAccess`, one repeatable-read snapshot) and a note writer
  recheck read committed state. The save that persists the edits rechecks roles
  and locked accounts (deleted, deletion pending, suspended) under the locks;
  frozen accounts and the storage limit are admission-only and rely on the 5 s
  writer recheck window.

Sources: [role resolution and access rules](../server/internal/store/share.go#L13),
[transactional editor checks](../server/internal/store/storage.go#L183), and
[sharing end-to-end coverage](../e2e/sharing/workspace-sharing.spec.ts#L34).

## Feature permissions

### Workspace settings and membership

- **Any explicit member** can list the workspace members: user id, display
  name, avatar, and role. A reader who is not a member gets `403`; a caller
  with no read access gets the non-disclosing `404`. No API response carries
  member emails. Anyone who
  may edit, share-role editors included, can read the collaborator directory
  behind mention autocomplete, which carries only user id, display name, and
  avatar. A user whose display name is empty is shown by user id.
- **Owner and editor members** can rename/recolor/describe/tag the workspace,
  change private/link/public visibility or `shareRole`, and view workspace
  statistics. Tags land in the owner's tag namespace whoever edits them.
  Widening sharing is an edit, refused when the actor or the owner is
  frozen; narrowing (privacy toward private, share role toward viewer) stays
  open to both.
- **Owner only** can invite a member, change a member's role, remove a member,
  and delete the workspace.
- Frozen owners cannot create invitations or promote an existing member,
  because either action widens exposure. They may demote or remove members as
  recovery-safe mutations. Grace owners invite and promote normally.
- Ownership is not assigned through a normal role change. The owner must use
  **transfer ownership** and select an existing live member.
- On transfer, the recipient becomes owner and assumes the complete storage
  bill. The old owner remains as an editor. Transfer is refused if the recipient
  cannot fit the workspace's used and reserved bytes or file count.
- Workspace creation, clone, and transfer-to-recipient all run the owned-workspace
  plan gate: Free owns at most 10 workspaces and Pro 50 (migration
  `0070_owned_workspace_cap.sql`); past it the request fails with
  `workspace_limit_exceeded` and the browser toasts "Workspace limit reached".
  Workspaces already over the cap (after a downgrade) are kept.
- An over-quota owner (grace or frozen) may still transfer because giving away
  bytes is a recovery action; the recipient must be able to edit.
- The emailed invite link's token is minted when the email is sent
  (`MintInviteLink`), so no raw token is ever stored: the outbox payload holds
  only the invite id and the current token hash, and each send rotates the
  invite's hash. A queued email whose invite was accepted, cancelled, expired,
  re-sent or deleted with its workspace is cancelled at send instead of
  carrying a dead link; acceptance stays the authority.
  A live account without a nonblank email still receives the in-app invite
  notification, but no email-outbox row is created. Role changes and removals
  are in-app notifications only; they never email. An acceptance tells the
  owner who sent the invite (a `system` notification coded
  `workspace_invite_accepted` plus the `workspace-invite-accepted` email under
  the invitation opt-out); after an ownership transfer the old owner is not
  told.
  Invite acceptance joins the workspace owner lifecycle, so a missing,
  frozen, suspended, deletion-pending, deleted, expired, revoked, or
  otherwise invalid invite uses the same non-disclosing unavailable-workspace
  response as a missing shared workspace. A frozen recipient is refused with
  `account_over_quota`, since joining is an edit. An invite that belongs to
  another account answers the same 404 as a missing one, by invite id or by
  token, so neither is an existence oracle.
- Role changes and removals refuse an empty actor rather than reading it as the
  owner.
- Acceptance locks the workspace first, then locks the owner and recipient
  accounts in canonical ID order. Reciprocal invitations therefore cannot take
  the same two account rows in opposite order.

Sources: [membership handlers](../server/internal/httpapi/huma_membership.go#L39),
[settings mutations](../server/internal/store/queries.go#L505), and
[transfer transaction](../server/internal/store/workspace_transfer.go#L36).

### Chapters, files, and uploads

- Owner and effective editors (member or share role) can create, rename,
  reorder, move, and delete chapters.
- Owner and effective editors can add/upload, rename, move, and trash source
  files and editor assets. Deleting a file moves it to the workspace trash for
  30 days; the current workspace owner and the item's payer list, restore or
  permanently delete trash, whoever trashed it. A payer who left the workspace
  still trashes and purges what it pays for but cannot open or restore it.
- Viewers can read files when workspace visibility permits, but cannot mutate
  workspace structure or files.
- Upload reservations and finalized bytes are charged to the editor who
  uploaded them (uploader pays), and only that editor completes its
  reservation.
- Direct cloud-source inspection treats DNS and connection failures as
  retryable provider outages. Request cancellation remains cancellation.
- Short-lived read links (a file's `/links`, an editor asset's resolve, the
  Office source session and its refresh) tell the bucket how to answer:
  the type comes from the stored key's extension, never from the type the
  uploader declared. PDF, raster images and audio are `inline`; every other
  file is an `attachment` typed `application/octet-stream`, except SVG, which
  keeps `image/svg+xml` so `<img>` still draws it but downloads when opened.
  The viewers read bytes through `fetch`, `<img>` or `<audio>`, which ignore
  the disposition, so only opening a link in a tab changes: Download original
  saves the file instead of showing it, while a PDF still opens in the
  browser. Hour-stable thumbnail
  links carry no overrides ([thumbnails.md](thumbnails.md)). The e2e stack's
  blob server answers its links the same way. The bank's public figures are
  not presigned and keep their server-detected type.

Sources: [read link headers](../server/internal/blob/s3.go#L165),
[chapter and file handlers](../server/internal/httpapi/huma_content.go#L54),
[source upload guard](../server/internal/httpapi/uploads.go#L40),
[editor asset guard](../server/internal/httpapi/editor_assets.go#L142), and
[owner storage gate](../server/internal/httpapi/server.go#L234).

### Notes and other material documents

- Owner and effective editors can create materials in a workspace. Their
  visibility is inherited from the workspace and cannot be changed separately.
- Owner and effective editors can edit the live document body and change
  material metadata through `PATCH /api/materials/{id}/metadata`. Publishing a
  material additionally requires a fully writable actor account.
- Owner and effective editors can trash a workspace material (30-day trash,
  owner-only restore and purge). For a standalone material, only its owner can
  edit, trash, restore or purge it.
- The chat agent edits materials and sources with the actor's own edit access;
  Undo of such an edit belongs to that actor alone and requires current edit
  access at Undo time.
- Materials keep no snapshot history. `materials.revision` counts content
  versions (collaboration projections and content patches); a title rename
  is last write wins, like a file rename, and carries no precondition.
- Quiz and flashcard authored-content requests require the revision loaded with
  the draft. Stale saves return 409 for standalone, workspace and embedded
  materials, including two tabs belonging to the same owner. Study progress
  and review ratings are separate per-user rows and carry no authored-content
  revision.

Sources: [material handlers](../server/internal/httpapi/huma_materials.go#L41)
and [material editor checks](../server/internal/store/share.go#L209).

### Comments and live collaboration

- Owner and effective editors can list discussions, create a discussion and
  reply in Edit mode. A thread is a flat list of comments with no nesting and
  no resolved state; threads are only deleted.
  View mode has no comment controls. There is no commenter role or separate Comment mode.
- A user can edit only their own comment.
- A user can delete their own comment or discussion. Only the workspace owner
  can delete another user's comment or discussion.
- Signed-in viewers get read-only collaboration tokens for content documents
  (never quiz keys): the collaboration server joins them read-only, relays no
  awareness to or from them and sends them no comment relays (Epo 2026-10-10).
  The app uses them for note View, flashcard sets and quizzes. Any user may ask
  for a read token (`{access: 'read'}`), and every reader room does (View, a
  study or attempt page), so an owner's or editor's reading tab writes nothing
  the server would take (live-items REVIEW5 N2). A
  quiz's keys document (`{document: 'keys'}`) goes only to editors who can
  write: Go refuses the token otherwise (403), and the collaboration server
  refuses a read token for a keys room. An
  embedded item's room is reachable exactly as its note is (the server resolves
  `parent_material_id` first), and a note's access event also evicts its
  embedded items' rooms. Anonymous visitors must sign in to read materials.
- Discussions and comments carry their author's display name and avatar. The
  client does not resolve authorship against the current member list, so a
  contributor who has since left the workspace stays attributed and a reader
  without a roster still sees who wrote what.
- Collaboration tokens encode `write` or `read` access; a `read` token exists
  only as the downgrade an editor receives when the material's payer is frozen,
  locked or at its storage limit (`full`, grace included), or the editor's own
  account is frozen. A deleted, deletion-pending or suspended owner's material
  gets no token (`404`), and the collaboration server refuses its room as not
  found to everyone but the owner. The collaboration
  server rechecks actor lifecycle,
  current membership/share role, owner lifecycle, and current quota state when
  admitting a connection, synchronizing a refreshed token, and persisting each
  save. Server-owned provenance travels in the same Yjs transaction as each
  edit, and the durable store rechecks every contributor's role and account
  lock in its exact debounced snapshot. A rejected raced update is never
  committed; the room is evicted so its unauthorized in-memory state cannot be
  retried later. Workspace saves
  lock workspace, ordered accounts, then material; standalone saves lock
  ordered accounts before material, matching the Go mutation order. The server
  treats Free-only subscription history as ordinary active Free access. It
  mirrors Go's frozen state (an expired or closed Pro boundary at least 14 days
  old, including when a live Free row also exists, and usage over the Free
  limit) for both the owner and the actor, and Go's storage limit
  (`StorageUsage.Full`) for the owner. Frozen and the limit are enforced at
  admission only: authentication and the room token give `read`, and a
  writer's access is rechecked on its updates at most every 5 s
  (`recheck` in `collaboration-rs/crates/server/src/socket.rs`). A refused update
  sends that writer a `room-read-only` stateless message and closes only its
  connection; a reconnect is refused with reason `collaboration-read-only`.
  Co-editors whose access still holds stay connected, while an owner at its
  limit refuses every writer in its rooms, since they share it. The open
  editor drops to view mode under a grey read-only strip and discards its
  unsaved edits (notes and sources alike; network and other failures keep the
  source recovery path). The store (and a source checkpoint, which takes
  `sourceLockTx` without the content admission that `CheckSourceAccess` adds
  for new edits) saves updates already admitted, so up to about 5 s of edits
  may persist; neither refuses or evicts a room because a contributor froze or
  the owner reached its limit. Removed members and locked
  accounts still evict the whole room. The server also closes the connection
  when the short-lived token expires and checks expiry on every inbound update
  or stateless event.
- ACL and lifecycle mutations enqueue room/user evictions transactionally in a
  database outbox. Redis delivery is retried with one stable eviction ID and is
  complete only after every active collaboration instance returns a positive
  acknowledgement. A negative or lost acknowledgement keeps the item retryable
  and replays a deduplicated eviction. Revocation,
  deletion, ownership/placement changes, plan downgrades, and account locks use
  discard; a discard that throws unsaved room state away also moves the room
  (a material's `room_schema`, a source's epoch) so a disconnected client
  cannot resync it (see
  [plate-editor.md](frontend/plate-editor.md#document-limits-and-rejection)).
  Provably monotonic ACL changes use drain: they block new room
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
  that unload succeeded. Within one eviction the room closes every channel
  and refuses joins and messages until it has unloaded (its task runs the
  eviction in order with its stores), and a discard whose lineage move fails is
  retried every 5 s, so a blocked room always has a retry pending. Message
  handling, authentication, token sync and room loads recheck that the room is
  available after each await, so nothing admitted before a reset lands after
  it.
- Comment creation, replies, edits, and deletion also lock the
  workspace and re-evaluate actor lifecycle and effective role in the database
  transaction that writes the row. Comments count as editing: creating,
  replying and editing are refused when the actor or the material's payer is
  frozen (`account_over_quota`) or the payer is at its storage limit
  (`storage_quota_exceeded`); deleting is not.

Sources: [collaboration token access](../server/internal/httpapi/huma_collaboration.go#L109),
[discussion/comment authorization](../server/internal/httpapi/huma_collaboration.go#L195),
and [material mode end-to-end coverage](../e2e/sharing/material-modes.spec.ts#L29).

### Quizzes and flashcards

- Readable shared quizzes can be attempted by any signed-in user. Attempts,
  study progress and review state belong to the user taking the quiz (see
  Study progress below). Signed-out visitors can take standalone link/public
  quizzes and study flashcards; their progress stays in the browser (see
  Anonymous quizzes, flashcards and notes).
- Answer keys follow one rule (Epo, 2026-10-06; details in
  [question-bank.md](question-bank.md#answer-keys-and-server-grading)):
  reading to view or study never sends them, owners and editors included
  (`GET /api/quizzes/{id}`, a quiz through `GET /api/materials/{id}`, Explore,
  signed-out pages, review sessions, the bank's View mode, and the chat agent
  for a user who cannot edit the quiz or the bank). Editing sends them to
  whoever may edit: `GET /api/quizzes/{id}/edit` uses the content-edit check,
  `GET /api/bank/questions/{id}/edit` the bank editor grant, and a clone's or
  copy's new owner edits its keys. Checking or submitting returns the key for
  what was graded; grading is server-side only and retakes are unlimited.
- Quiz/flashcard responses distinguish `isOwner` from `canEdit`. Effective
  workspace editors receive content controls without receiving owner-only
  sharing/privacy controls; viewers do not receive mutation controls.
- Owner and effective workspace editors can modify workspace quizzes,
  flashcards, and cards. The dedicated quiz and flashcard routes apply the same
  account lifecycle and storage-owner gates as the unified material API.
  Standalone quizzes and flashcards remain owner-controlled.
- Mutation contracts keep authorities separate. Material title/filing/scope use
  `/metadata`. Quiz name/scope use `/metadata` and standalone visibility uses
  `/sharing`; flashcard-set metadata uses `/metadata` and standalone sharing
  uses `/sharing`. Quiz questions and a set's cards have no REST write: live
  item rooms are their only writers (Epo 2026-10-16), under the collaboration
  server's writer checks. Ratings go to `POST /api/review/ratings` with read
  access only. Metadata paths do not accept privacy, and sharing rejects
  workspace-contained materials before writing anything.
- Signed-in viewers can read a shared quiz or flashcards, but cannot change
  its questions or cards.
- An embedded quiz or flashcard set (`parent_material_id` set) has no lifecycle
  or sharing of its own: `materialEffectiveAccess` evaluates the parent note,
  the sharing endpoint rejects it, it is hidden from the workspace tree, the
  trash listing and the agent's source list, and it cannot be trashed
  directly. Trashing, restoring, purging and cloning the note carry its rows
  along (clones rewrite the reference ids). Like the note's images, every
  content save of the note trashes the rows it does not reference once they
  were created over 60 seconds ago (`reconcileEmbeddedTx`), hidden and purged
  after one day (`unreferencedRetention`; rows trashed with their note keep the
  note's 30 days), and a save that references a trashed row again restores it.
  The minute lets a new row's block reach the note; a row whose block never
  lands (the tab closed, an undo before the save) goes at a later save, or
  with the note's purge if the note is never saved again. A refused agent edit
  trashes the rows it created at once (`DiscardEmbeddedDrafts`).
- A quiz or flashcard block an update writes into a note (a paste, undo, cut
  and paste, replayed draft, AI edit or Undo) becomes that note's own through
  the collaboration service's children pass (`collaboration-rs/crates/server/src/children.rs`),
  which calls `POST /internal/collaboration/materials/{id}/children` (service
  secret) naming the writer as `actorUserId`; Go checks that user edits the
  note (`AssertMaterialEditor`) and reads each source as them. Every block has
  its own quiz, so the pass sets `copy` on each block but one when a quiz is in
  several blocks. The note's own row answers its id, restored at once when
  trashed, unless the block asks for a copy. A copy of the note's own row, or
  another note's embedded quiz or set, live or trashed (a cut's save may have
  trashed it), whose note the writer can read, is copied under this note, a
  separate row per block in its own savepoint: questions or cards (fresh card
  ids), title as a new embedded row gets, its images as new editor assets
  sharing the stored objects, all charged to the note's payer; attempts,
  progress and review state stay with the original. Anything else (unreadable,
  purged, unknown) answers "" and the pass drops the block. A copy over the
  payer's quota answers "" with `storageRefused`, and only that writer is told.
  A copy is a created row, so one whose block never lands goes at the note's
  next save after its first minute.
- Cloning a readable standalone quiz, flashcards, or material is open to every
  signed-in reader. A file or material inside a workspace, and the workspace
  itself, additionally require membership of any role or an effective editor
  grant (`assertCloneSourceTx` in `store/share.go`); refusals answer 404.
- One file or material clones through `CloneItemDialog` (file and material row
  menus in the workspace, Files and Blocks lists, quiz and flashcard pages,
  Explore, the public page link): a destination workspace the cloner edits
  plus a chapter (existing, none, or new by name), or for a material "No
  workspace"; and the copy's name. `POST /api/files/{id}/clone` takes
  `{workspaceId, chapterId?, chapterName?, name}` (files live in workspaces
  only), `POST /api/materials/{id}/clone` takes `{workspaceId?, chapterId?,
  chapterName?, title}`; an embedded row is never cloned on its own (404). The
  destination is admitted like any workspace write (workspace row, then the
  source owner's, actor's and payer's accounts in ID order): the cloner must
  edit it and neither they nor its owner may be frozen. The source access check
  runs first; the destination's member rows are read `FOR SHARE`, so a removal
  or demotion that committed after the clone's snapshot makes it retry instead
  of landing. A copy in a workspace belongs to that workspace's owner, who pays
  for it (and whose plan's per-file cap applies to a file, as for an upload);
  `created_by` is the cloner. A standalone copy is the cloner's and private.
- File clones (single and workspace) copy ready files and partial ones
  (`failed` with a served index, a part missing), which stay partial in the
  copy so its owner, who alone may Retry processing, can retry them (parts
  design Q2); pending, processing and other failed files are not copied (a
  single clone answers 404). The file row menu, the open file's header and
  the dashboard's recent items offer Clone on those files only
  (`fileCanClone`).
- The dialog prefills `Name (copy)` (before a file's extension) while the
  destination is the source's own workspace and the plain name elsewhere,
  until the user types one. A material title is unique per workspace, so a
  taken one answers 409 `title_taken`, shown under the name field; file names
  are not unique. Clone spins and the dialog stays open while pending (Escape,
  an outside click and the hidden close button do nothing then); any other
  refusal shows in the dialog (`FormAlert`), not as a toast: a storage refusal
  is the cloner's own (the cloner pays), a file past the cloner's cap the
  upload's size message, an exhausted cloner the credits
  message. The workspace clone dialog behaves the same way.
- A copied note keeps a mention live only for a member (or the owner) of its
  destination; any other mention becomes plain `@Name` text, as does every
  mention in a standalone copy and in a workspace clone (whose only member is
  the cloner). Scope chapters and file names are kept only in the source's own
  workspace. References to embedded rows point at their fresh copies; one whose
  row was not copied is dropped.
- Every workspace Clone (card menu, Explore, settings, the workspace picker, the
  public page link) opens `CloneWorkspaceDialog`: the create form prefilled with
  the source's icon, cover, description, tags and name (an owner's copy suffixed
  "(copy)"). `POST /api/workspaces/{id}/clone` takes the create body and the copy
  uses those values; tags travel by value, since their ids are the source
  owner's.
- A material whose stored content the current rules refuse (a later rule
  tightening, e.g. a void element holding text), or that is over the
  material size caps, is not copied (Epo 2026-10-20): a single material clone
  answers 422 `material_content_unreadable`, like its read, and its dialog
  says the item cannot be copied; a workspace clone leaves it out with the
  rows it embeds and their assets (a note whose embedded quiz or set is
  unreadable goes whole, counted once, never copied with the reference
  dropped), copies everything else, and answers `skippedMaterials` (files
  left out), for which the dialog's toast says some files were not copied.
  The source stays as it is. A file past the cloner's per-file cap is left
  out and counted the same way, while a single file clone refuses it with
  `file_too_large`. The 422 belongs to routes that read stored content
  (`storedContentError` in `huma_register.go`: reads, clones, shared pages,
  their images and grades, quiz attempts and sharing, study): content a
  request sends answers 400 and content we generate that fails our own
  validation a 500, which reaches Sentry. "Refuse" is what the reads check
  (`materialdoc.Parse`, plus the size caps for the clone), not every kind
  rule: a stored mindmap missing its Mermaid block is still copied and loads
  read-only, like its source.
- Clone source content is one repeatable-read SQL snapshot. Clones never lock a
  source workspace/material as a source (a copy into the source's own workspace
  takes its row as the destination, like any write) or wait for Yjs
  persistence/projection; a stale SQL projection is an explicitly accepted
  result.
- Clones queue instead of colliding (Epo 2026-10-16). Before its snapshot a
  clone takes session advisory locks on its connection: the source's fence
  (a workspace exclusively; a file or material exclusively under its
  workspace's shared fence) and its payer's (`clone-payer:<id>`: the actor for
  a workspace or standalone copy, the target workspace's owner otherwise).
  Copies of one source, and copies one account pays for, therefore run one
  after another and never meet on blob reference counts or the payer's
  storage counter. The clone counter is bumped after the copy commits, in its
  own statement under the fence, so it cannot fail the copy; a crash in
  between loses one count. Source-owner and target account locks are acquired
  in canonical ID order.
- Writers outside clones still meet a clone's snapshot. The one that matters
  is the payer's storage counter (`user_storage`): an upload reservation or
  release of the payer committing while the clone runs fails the clone's
  storage gate with a serialization failure (measured: with a busy writer
  every clone spent its attempts). The clone then runs again, 3 attempts in
  all, and once they are spent the user gets 409 `clone_source_changed`
  ("The original changed while it was being copied. Try again.") (`retryClone`
  in `server/internal/store/share.go`). Clones of different sources that share
  a blob (a file and an earlier copy of it, or workspaces sharing an editor
  asset) hold different fences, so with different payers they can still meet
  on that blob's reference row and fall to the same backstop.
- A clone reads the new row only after its fence's connection is back in the
  pool, so clones never hold one connection while waiting for another.
- Referenced ready media of a cloned material is rehomed under fresh asset IDs
  owned by the copy (in its destination workspace, or standalone); it never
  retains authorization-bearing asset IDs from the source workspace.
- A deleted, deletion-pending or suspended owner's workspaces and materials
  are no clone source: material, file and workspace clones answer `404`, and
  so does a copy into that owner's workspace (see "What everyone else sees"
  under Account lifecycle gates). Copies other users made earlier are theirs
  and stay readable.

Sources: [quiz read/attempt rules](../server/internal/httpapi/huma_quizzes.go#L74),
[flashcard guards](../server/internal/httpapi/huma_flashcards.go#L60), and
[clone handlers](../server/internal/httpapi/huma_share.go).

### Study progress

Details live in [study-progress.md](study-progress.md).

- Study progress (read, started, stopped tracking), FSRS review state and the
  review log are private to their user. Any signed-in user who can read the
  workspace records their own with read access only: owners, members of every
  role, and link or public visitors, viewers included. Ratings need read
  access to the rated material. Reads and writes never show another user's
  rows; the chat agent reads only the requester's, and only while their
  progress is on.
- Frozen accounts record progress, ratings, Reset and the progress switches
  like anyone else (`requireAccountMutate`), since the rows are their own and
  charge no storage. Suspended, deletion-pending and deleted accounts have no
  API access.
- Rows hold ids, timestamps and FSRS numbers, are never copied by a workspace
  or material clone, and are not charged to storage. They stay when access is
  lost (unreadable until it returns) and when a workspace is transferred
  (`study_progress` and `workspace_study` are in the transfer test's
  `notOwnership`). Trashed items keep their rows, hidden until restored. Rows
  cascade with their file, material or workspace, and `PurgeUser` deletes all
  four tables at account purge.
- Question-bank progress (`bank_progress`, see
  [question-bank.md](question-bank.md#learner-progress-and-retraction)) is
  private the same way: any signed-in user with the bank page's read access
  records their own latest scores, frozen accounts included. Rows name bank
  question and topic ids without a foreign key, belong to no workspace (so
  transfer and clone never touch them), are not charged to storage, stay
  unread when their question is retracted or its prompt edited, and are
  deleted by `PurgeUser`. Published bank questions are retracted by the bank
  owner, never deleted. Copying bank questions into a quiz (`POST
  /api/bank/copy`) is a content write: it needs edit access to the workspace,
  and frozen accounts and full payers of the quiz are refused.
- Signed-out visitors keep their study in the browser only (see Anonymous
  quizzes and flashcards); they record nothing on the bank.

Sources: [study routes](../server/internal/httpapi/huma_study.go) and
[study store](../server/internal/store/study.go).

### Workspace chat, AI completion, and generation

- Persisted streaming chat and chat history are open to any signed-in actor
  with an effective workspace role (`WorkspaceEffectiveRole`: membership raised
  by link/public privacy and share role), so link-shared and public workspaces
  let viewers and editors chat. Conversations are private to the user who
  created them, even inside the same workspace, and are never cloned.
  Revoking privacy leaves old threads in place but unreadable. The owner of a
  thread pins, renames or archives it (`PATCH /api/conversations/{id}`;
  archiving drops the pin), lists archived threads with `?archived=true`, and
  unarchives or deletes all of them per workspace
  (`POST …/conversations/unarchive`, `DELETE …/conversations/archived`); none
  of these count as activity, so `updated_at` keeps the list order. Chat and generate
  model choice is an account preference (**Settings → LLM**), snapshotted onto
  new conversations; the browser cannot pick a model per request. Editor AI
  uses the `users.editor_model_provider_slug` / `users.editor_model_slug` pair
  the same way, including provider-scoped
  single-key BYOK, and is gated by
  `VITE_FEATURE_EDITOR_AI`.
- Generation, the chat `generate_material` tool, and the internal material
  callback follow the effective role: owner, member editor, or share-role
  editor. The gateway sends `canGenerate` to the pipeline, which omits the tool
  from the prompt and refuses calls otherwise.
- Pending-source context: the gateway forwards the `pending_sources` chat event
  only to actors whose effective role can edit, so viewers never see the
  notice. Manual and automatic reprocessing (`RequestSourceRefresh`) are
  owner-only; editors see the label without the process-now button.
- Generated material storage is charged to the actor, who is its author and
  payer (uploader pays).
- Inference credits are billed to the actor (`BeginProviderSession` /
  `llm_credits_exhausted`). Ingest claim-time checks owner lifecycle/storage
  and actor lifecycle/credits separately. Ordinary ingest also requires the
  actor to remain the workspace owner or an effective editor at claim,
  heartbeat, provider admission, and every final write. A demotion or removal
  cancels the exact job attempt and reservation. These boundaries use the same
  lock order as workspace mutations: workspace, ordered accounts, membership,
  file, then job, followed by the exact attempt when provider admission needs
  both. Suspended, deletion-pending, deleted, and access-revoked actors cannot
  start or continue billed work.
- Workspace chat stays open to frozen accounts. A frozen actor or owner leaves
  the agent its read and trash tools (no edit, create or restore tools), and
  generation refuses before spending credits. The chat's Library switch grants
  `library.read` per turn to any role that can chat; it adds no write tools.
- An owner at or over its storage limit (full or grace) leaves the agent
  without its create and edit tools (restoring from trash stays, since it
  grows nothing), and generation is refused with `storage_quota_exceeded`
  before any credits are reserved or spent.

Sources: [chat effective-role guard](../server/internal/store/chat.go#L191),
[chat stream admission](../server/internal/httpapi/server.go#L487), and
[generation credit policy](../server/internal/httpapi/generation_credits.go#L3).

### Personal account features

Events, tasks, labels, notifications, integrations, billing, search, quiz
attempt history, and study progress and review state are scoped to the
authenticated user's own rows, not to a workspace role. Frozen users delete events, tasks and labels but
neither create nor edit them (the Schedule page hides event and label Edit),
and cannot create or save thinking canvases (the Canvas page is read-only);
account settings (profile, locale, model preferences, LLM keys, notification
preferences, account deletion), notification read markers, quiz attempts,
study progress and review ratings stay open. A frozen account edits nothing
else: deleting a single flashcard and saving or deleting a PDF private
annotation are edits and refused, while trashing whole files, materials and
sets stays allowed.
Planner, preference, credential, attempt, and canvas writes recheck account
lifecycle under the user-row lock in the mutation transaction rather than
relying only on middleware admission.

Source: [schedule lifecycle gates](../server/internal/httpapi/huma_schedule.go#L47).

## Account lifecycle gates

Account lifecycle is evaluated after identity authentication and before or
during a write. Severity is ordered as deleted, deletion pending, suspended,
then storage state. The same boundary is enforced for Clerk, development, and
E2E identities.

| Account state       | Hold/use a session | Read, download, chat | Create/upload/clone                                                    | Edits, comments, widening exposure, deleting a card or PDF mark                     | Trash whole items, narrow exposure | Material document editing                          |
| ------------------- | ------------------ | -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------- |
| `active`            | Yes                | Yes                  | Yes, subject to role and hard quota                                    | Yes                                                                                  | Yes                                | Full write                                         |
| `active` at `full`  | Yes                | Yes                  | Storage growth fails the hard quota                                    | Organizing and sharing yes; content, comments, cards and PDF marks view-only where this account pays | Yes                                | View only where this account pays                  |
| `over_quota_grace`  | Yes                | Yes                  | Yes, but storage growth fails the hard quota against the Free limit    | Organizing and sharing yes; content, comments, cards and PDF marks view-only where this account pays | Yes                                | View only where this account pays                  |
| `over_quota_frozen` | Yes                | Yes                  | No                                                                     | No, nowhere for the actor, and for nobody where this account pays                    | Yes, subject to role               | Read only, as actor or as payer                    |
| `deletion_pending`  | No                 | No API access        | No                                                                     | No                                                                                   | No                                 | No                                                 |
| `suspended`         | No                 | No API access        | No                                                                     | No                                                                                   | No                                 | No                                                 |
| `deleted`           | No                 | No API access        | No                                                                     | No                                                                                   | No                                 | No                                                 |

**What everyone else sees** (Epo 2026-10-16). A deleted, deletion-pending or
suspended owner's workspaces and their content answer the same non-disclosing
`404` to members, other signed-in users and anonymous link or public viewers on
every content path: the workspace itself and the lists (workspace list,
search, member-scope Files, Explore), files (source sessions, view sessions,
downloads, previews, thumbnails), notes and materials (reads, collaboration
tokens and live rooms), editor assets, comments, chat, study pages and clone
sources, and a copy into that owner's workspace. The answer comes before
anything that could reveal the owner's state: the role read
(`workspaceRoles`, `materialEffectiveAccess`, `sourceActorsAllowed`) leaves the
workspace out, and a write that locks accounts before reading roles maps the
owner's locked account to not found (`HideOtherAccountLock`). The same holds
for the other accounts a user-facing write checks (review C2): an item's
payer on material and file writes (`lockWorkspaceMutationTx` with its extra
accounts, `assertContentEditableTx`, `UpdateMaterial`, `UpdateFile`, the
source edit lock, editor assets, the bank's copy into a quiz) and a
transfer's recipient. The caller gets a plain not found, never that
account's lifecycle state or suspension reason; the caller's own lock and a
frozen payer (view-only, no reason) still read as such. The collaboration
server's internal checkpoint keeps the payer's lock, as it reaches no person. Becoming locked evicts
the owner's note and source rooms with `discard` (`user_acl_eviction_trigger`,
source rooms since migration 0090), so open viewers reconnect through that
check. A member's unsynced edits in that owner's notes and files are dropped
on the 404, as for a deleted owner: the browser cannot tell it from a
deletion. The owner keeps the locked-account answer of their own session, so
their own drafts are kept. Copies other users already made belong to them and
stay readable. The 404 applies to new requests: presigned links handed out
before stay valid until they expire (about five minutes for file and asset
links, up to two hours for thumbnail links), and shared pages the edge cached
are served for up to five minutes.

Grace and frozen accounts may still open a Pro Checkout session: resubscribing
is a recovery action, not content creation. Checkout completion retrieves the
full Stripe subscription when the event carries only its expandable ID before
projecting paid entitlement. Deletion-pending, suspended, and deleted accounts
remain ineligible, and a raced paid Checkout is compensated instead.

`over_quota_grace` behaves exactly like an active account at 100%: the lapse
applies Free limits, stored bytes are over them, so every storage-creating
write fails with `storage_quota_exceeded`, while sharing and invites keep
working. An owner at or over its limit (usage level `full`, which grace always
is) also makes everything it pays for view-only, for owner and members alike:
edit mode, comments and annotations are off (refused with
`storage_quota_exceeded`, capability `canEditContent`), while renaming,
reordering, moving between chapters and trashing still work (`canEdit`). It is
enforced at admission only, like frozen; see
[backend-storage-quota.md](backend-storage-quota.md). `over_quota_frozen` is read-only apart from reading, downloading,
trashing or deleting whole items, workspace chat, narrowing exposure, transfer,
quiz attempts, the user's own study progress and review ratings, billing and
account settings, in both directions: the frozen user edits nowhere, healthy
owners' workspaces included, and every role is read-only in workspaces the
frozen account pays for. Refusals use `account_over_quota`. Grace lasts 14 days
after a paid period lapses; frozen is the state after that window. Neither
state deletes content. The states exist only when the paid period has lapsed
**and** stored bytes exceed the applicable limit. A concurrent live Free
subscription selects Free limits but does not erase the most recent expired Pro
boundary used to derive grace or frozen.

**Renewals and failed payments.** An `active`, `trialing` or `past_due` row
stays live until `current_period_end` + 48 hours (`renewalTolerance` in
`store/subscriptions.go`, mirrored in `pipeline/store/db.py` and
`collaboration-rs` `access.rs`). Stripe moves the period forward when it
renews, but its webhook can land after the old period end; without the
tolerance an over-Free Pro account would briefly drop into grace, fail ingest
jobs and receive an over-quota notice that cannot be withdrawn. A row still
expired after the tolerance (a missed renewal or cancellation, until the daily
reconciliation repairs it) lapses with grace counted from `current_period_end`.
During Stripe's retries the subscription is `past_due` and keeps Pro, with no
banner or notice; a retry that succeeds turns it `active` with nothing to
revert. After the last failed retry Stripe cancels the subscription (the
configured final action, runbook §12.4) and the 14-day grace starts from its
`ended_at`. A subscription's end time is fixed by its first non-entitling event
(Stripe's `ended_at`, else that event's time, which covers `unpaid`, stored as
`canceled`); later events never move it and returning to an entitling status
clears it, so the grace start and the over-quota notices keyed to it stay put.
A live Pro subscription that ends without cancel-at-period-end, from a webhook
or from reconciliation closing a row Stripe no longer reports, sends the "Pro
ended" email (`subscription-ended`) once per subscription; a cancel-at-period-end
subscription already sent "Pro cancelled" and gets none. Notifications and
emails already sent stay sent when an account recovers.

Store-level enforcement sits in the workspace edit lock
(`lockWorkspaceEditorMutationTx`, which checks the actor; trash and chapter
deletion use `lockWorkspaceEditorRecoveryTx` without the check; a frozen owner
narrows only what it pays for), the
settings and sharing writes, standalone material updates (privacy narrowing
excepted), comment writes, source sessions and the storage gate. Content
admission (`assertContentEditableTx`: material content, comments, PDF marks,
source edits) checks the item's payer: frozen, locked or at its storage limit. Handlers use
`requireAccountEdit` for the actor's own create/edit routes and
`requireAccountMutate` for the actions a frozen account keeps.

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

The stored `name` belongs to the user. The Clerk name (first plus last, else
username, else email, else a localized fallback) seeds the row only when the
local account is inserted, by the request-time sync or the `user.created`
webhook, whichever runs first. Every later sync, including `user.updated`,
refreshes email and avatar only. `PATCH /api/me` stores the name the user
typed, trimmed, 1 to 60 runes, rejected with `422` otherwise. Stripe customers
are created with that same name because no separate legal name is stored.

Every Clerk-authenticated request reads the account once
(`ClerkSession` in `store/account_state.go`): the lifecycle verdict, whether
the starter workspace is pending and whether the profile is due. The API reads
the Clerk profile (`user.Get`, a Backend API round trip of about 180 ms on UAT)
only to provision an identity with no local row, and then at most once an hour
per account as a backstop for missed `user.updated` webhooks (Epo 2026-10-17).
`users.profile_synced_at` (migration 0091) holds the last read; a new row
counts as just read. When it is over an hour old, the request first claims the
read with a conditional update, so one request per account and hour wins it
across gateway processes, a burst of page-load requests reads once, and a
failed read waits for the next hour. A locked account is refused before any
profile read, on every request. Requests that read the profile or create the
starter workspace check the lifecycle state again afterwards, since that work
can race a deletion or suspension.

Clerk profile retrieval and local identity provisioning are separate gates. A
temporary profile-read failure skips synchronization for an existing local
account, preserving its stored name, email, and avatar. If profile retrieval or
upsert fails while the identity is still unknown locally, the request fails
retryably with `503 account_state_unavailable`. An address another live local
account still holds (`users_email_active_uidx`, for example a row that has not
yet seen its owner's address change) is reported to Sentry
(`clerk_email_collision`) and the account is written without an email, instead
of failing provisioning on every request. Starter-workspace completion is
stored separately on the user row. A failed workspace insert also returns the
retryable 503, and the next authenticated request retries it, without a
profile read. Once marked complete, deleting every workspace does not recreate
the starter workspace.
Starter provisioning locks the same user row as ordinary creation, then checks
for an existing workspace, inserts if needed, and stores the marker in one
transaction. If ordinary creation commits first, provisioning records only the
marker.

### Sign-in pages and first-run onboarding

The SPA owns the sign-in UI; Clerk's prebuilt pages are not mounted. Routes
outside the app shell: `/sign-in` (landing page with the auth card: Google,
Microsoft, email plus password, forgot-password and create-account links),
`/sign-up` (same page, sign-up mode with an email-code step and the
`clerk-captcha` container), `/forgot-password` (email, then code plus new
password; the verified reset also signs the user in) and `/sso-callback`
(Clerk's redirect callback, which completes the session or transfers a
first-time OAuth account into sign-up). A same-origin `redirect_url` query
carries the post-auth destination through every hop. `AuthGate` sends
signed-out visitors to `/sign-in?redirect_url=<path>` itself; Clerk's
`RedirectToSignIn` would put the URL in the hash, which the auth pages do not
read. Once a session is active, the landing's signed-in effect is the only
redirect to the destination; `finalize` does not navigate. Links between auth
pages use SPA navigation and preserve search parameters. Sign-up and new-password
forms require 12 characters with a digit and a symbol; sign-in only checks
non-empty. OAuth accounts are never asked for a password.

The dashboard opens a first-run dialog when the Clerk user has no
`unsafeMetadata.onboardedAt`. The profile chooser uses the fixed catalog in
`src/lib/icon-catalog.json`; SVGs ship at `/icons/<id>.svg`. Confirm saves the
name and optional `avatarIconId` through `PATCH /api/me`. Photos preview locally
and upload directly to Clerk on Confirm, accepting PNG/JPEG/WebP up to
10,000,000 bytes. After upload, an empty `avatarIconId` asks the gateway to
verify the current real Clerk photo before clearing the override. Upload or
verification failure preserves the stored icon. Skip writes only `onboardedAt`.

Clerk `hasImage` distinguishes real photos from provider placeholders. Accounts
without a real photo get a stored Avataaars ID on provisioning/sync. A selected
catalog ID takes precedence over `avatar_url` in profile, member, mention and
comment-author projections; Clerk sync preserves that override. Internally, `avatar_icon_id` is NULL until
first sync and an empty string when Clerk is selected, so delayed no-photo
events cannot reassign a default after a confirmed upload. Purge clears
both fields. Workspace `icon_id` is required and validated against the same
frozen catalog, receives a persisted random Waves default, follows existing
member owner/editor settings permissions and survives cloning. Workspace colors are removed by migration `0018_workspace_appearance.sql`; existing Slice workspace/avatar selections become Waves before the catalog constraints narrow. Help and Legal contains support cards, FAQs and contact links and links to the author,
source, artwork license and generator notices on Credits.

Sources: [auth landing](../src/features/auth/AuthLanding.tsx),
[password reset](../src/routes/ForgotPassword.tsx),
[onboarding dialog](../src/features/auth/OnboardingDialog.tsx), and
[name endpoint](../server/internal/httpapi/huma_account.go).

`GET /api/me` carries the resolved lifecycle as `account` (state, plan,
storage used and limit for every account, the storage usage level, grace and
purge dates), which the account banner reads; there is no separate status
endpoint. A locked account never sees that body:
the middleware refuses every route, `/me` included, with the lock code, and the
banner reads the code off the error.

If the middleware cannot load account lifecycle state, authenticated requests
fail closed with `503 account_state_unavailable`. Database failure is not
treated as an active account and is distinct from a real `403` account lock.

Sources: [lifecycle states and gate methods](../server/internal/store/account_state.go#L11),
[session rejection](../server/internal/store/account_state.go#L267),
[middleware enforcement](../server/internal/auth/middleware.go#L237), and
[over-quota API behavior test](../server/internal/httpapi/account_gates_test.go), and
[frozen and grace store matrix](../server/internal/store/collaboration_owner_test.go).

## Storage quota and ownership

### Who pays

- Every file, editor asset, upload, and material is charged to the account that
  uploaded, imported, cloned or created it, in any workspace (uploader pays,
  Sam 2026-10-18; see backend-storage-quota.md).
- Nobody adds bytes to another user's bill, and an owner's transfer moves none.
- A frozen account edits nowhere, and nobody edits what a frozen account pays
  for. Nobody edits the content of an account at or over its limit either,
  though organizing it still works; the rest of the workspace stays editable.

### What the gate checks

Every storage-**creating** transaction checks both conditions:

1. the payer's (the actor's) lifecycle permits editing (active or grace); and
2. `used bytes + reserved bytes + requested bytes <= plan limit`, where a
   lapsed Pro account's limit is the Free one.

The current limits are 100 MB for free accounts and 1 GB for Pro accounts.
Upload reservations count immediately so concurrent uploads cannot both spend
the same remaining quota. Quota errors use `storage_quota_exceeded`, with the
used, reserved, requested and limit bytes and the owner's user id only when the
requester is the charged account (members get the code alone); lifecycle
over-quota errors use `account_over_quota`.

No save-time gate exists for existing materials or source checkpoints; growth
only appends size deltas. Instead an owner at or over its limit (active at
100% or grace) makes its content view-only at admission (collaboration tokens,
edit sessions, the 5 s writer recheck and REST content writes), and a frozen
owner's content is read-only (see account lifecycle gates above).
Byte measurement, counters, and material shape bounds are documented in
[storage accounting](backend-storage-quota.md).

Trashing or deleting whole items and transferring a workspace away remain
available to a frozen owner so the account has a path back under the limit,
as does narrowing exposure; deleting one flashcard or PDF mark does not.
Renaming, re-filing, reordering and publishing are organizing edits, open in
grace and at the limit and closed when frozen.

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
| Upload reserved                      | Creates a pending `upload_sessions` row and reserves the declared bytes against the uploader                                                                                                                       | Browser receives a presigned PUT for an `incoming/` or `editor-assets/incoming/` key | Pending session is eligible for expiry after its presigned deadline                  |
| Upload finalized                     | Creates the source file or editor asset, converts reserved bytes into used bytes, and marks the session completed                                                                                                  | Incoming object is promoted to its stable `sources/` or `editor-assets/` key         | Completed session remains temporarily as an idempotency record                       |
| Upload abandoned/expired             | Marks the session expired and releases its storage reservation                                                                                                                                                     | Both incoming and possible promoted paths are queued, with a 24-hour presign grace   | Upload sweeper runs at startup and every minute, up to 100 expired sessions per pass |
| File/asset deleted                   | Logical row is deleted; workspace deletion and account purge do this through foreign-key cascades too. Pending/running parse, ingest, import, and provider reservations are cancelled at the same boundary.        | The path is queued only when its last database reference disappears                  | Blob reaper runs at startup and every minute                                         |
| Shared blob still referenced         | One row/reference is removed, but the remaining clone/reference keeps the blob live                                                                                                                                | Object is not deleted                                                                | Reaper re-checks references before every claim                                       |
| Stable object has no database record | No row exists to enqueue it, for example after a request dies between PUT and row creation                                                                                                                         | Object remains in the bucket                                                         | Monthly orphan sweep reports it after 48 hours; it currently **does not delete it**  |

Sources: [upload reservation and finalization](../server/internal/store/uploads.go#L50),
[expired-upload sweep](../server/internal/store/uploads.go#L202),
[worker schedules](../server/cmd/api/main.go#L259), and
[blob worker design](../server/cmd/api/blob_workers.go#L11).

### File status and previews

List rows carry a file's thumbnail as `thumbnailUrl`, an hour-stable presigned
link that follows the file's read access: handlers sign only rows their
access-scoped queries returned, so members, link and public readers get links
for the files they can open and nobody else does; the anonymous summary carries
none ([thumbnails.md](thumbnails.md)).

Workspace file status describes processing after upload finalization:
`pending` is queued, `processing` is parsing or indexing, `ready` is finished
(including store-only files with `indexed=false`), and `failed` means processing
failed. These are separate from the upload session's own status. Once
`hasBytes=true`, the workspace file list allows opening the original source
while processing continues; the viewer shows progress above the preview.

### Temporary upload cleanup

Source uploads and editor assets share the `upload_sessions` table but use
different targets. Reserving an upload immediately reserves its declared bytes
against the uploader. Editor assets upload through their material, so
only that material's editors can reserve them, and every asset names it. The
presigned PUT signs the declared size as its Content-Length (`blob.PresignPut`),
so B2 refuses a body of any other size with a 403 (checked on the UAT bucket
2026-10-06); the S3 SDK cannot sign a zero length, so a declared empty source
file stays unbound and finalize's size check still refuses a mismatch. A successful finalize promotes the object from a
temporary incoming key, creates the durable resource row, and marks the upload
session completed. Finalization is idempotent, so retrying a completed source
upload returns the already-created file. Concurrent duplicate completions may
race before either database commit. If one request has already moved the
incoming object, the other accepts the stable object only when its recorded
size and content type match, then converges through the same idempotent
finalization transaction. For a file with source sessions the gateway reads
the promoted object back once and records its SHA-256 in that transaction;
it never takes a hash from the browser, since the collaboration server checks
the originals it loads against it ([backend-storage-quota](backend-storage-quota.md#reservations-and-clones)).

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

Object keys name their blob with 128 random bits (`store.ObjectKeyID`): the
`final_path` uniqueness lasts only as long as the session row, and a deck's
`Put` has no guard, so the key itself must not collide. A source key keeps the
filename's extension only when it matches `^\.[a-z0-9]{1,11}$`
(`keyExtension`), so no control or space character reaches the bucket. The
import worker, which holds full-bucket credentials, writes only under
`incoming/` and refuses any other path the gateway hands it. Entity and share
ids keep their shorter length.

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
editor assets, upload-session paths, source collaboration bases and refresh candidates,
and file thumbnails (`files.thumbnail_key`: a new capture releases the old key;
[thumbnails.md](thumbnails.md)). Image-caption payloads are owned by `image_caption_associations`. Document parse output stays in the temporary local spool; migration 0038 releases its retired B2 cache copies through the same outbox. `files.caption_blob_path` is identity/debug metadata rather than a second reference. The triggers run for direct row deletion and
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

Sources: [deletion outbox and reference re-check](../server/internal/store/blobs.go#L9),
[reaper loop and retry behavior](../server/cmd/api/blob_workers.go#L26),
[reference-count lifecycle test](../server/internal/store/blobs_test.go#L51), and
[bucket version requirement](../server/README.md#L30).

### Trash

`files` and `materials` carry `trashed_at`, `trashed_by`, `trash_episode_id` and
`purge_after` (30 days). Every active-resource query filters
`trashed_at IS NULL` explicitly; maintenance, quota, refcount and trash paths
read trashed rows on purpose. Trashing cancels the file's pipeline jobs, evicts
its collaboration rooms and releases outstanding chat Undo entries; the row
keeps its bytes and stays charged to the owner until purge. Restore bumps the
source epoch or the material `room_schema` so stale clients cannot resume.
`GET /api/trash`, `POST /api/trash/{kind}/{id}/restore` and
`DELETE /api/trash/{kind}/{id}` are owner-only; a background sweep purges rows
past `purge_after`, which then reaches the blob outbox like any deletion.

A note's or quiz's images follow it (their `editor_assets.material_id` names
it, in a workspace too; an embedded quiz's images name the quiz, not its
note): trashing keeps them, still charged, and restore brings them back with
it; purging deletes them through the cascade. An image a save stops
referencing goes to a hidden trash in that save's transaction once it
completed more than 60 seconds ago (`editor_assets.trashed_at`, migration
0065): still charged and holding its object, hidden from resolve, share and
clone reads, restored by a save that references it again, and deleted by the
trash sweep a day later (`PurgeTrashedEditorAssets`), which releases the charge
and sends the object to the blob outbox. The minute lets a just-uploaded
image's id reach a shared note before a collaborator's save. The children pass
above handles images too: the note's own image comes out of the trash at once
(undo, cut and paste, chat Undo of an AI edit within the day), another note's
or quiz's readable image (live or trashed) becomes the target's own copy
sharing the stored object, each copy charged (see
[backend-storage-quota.md](backend-storage-quota.md)), and a purged or unknown
one is dropped from the note, as after a chat Undo replayed past the day.

Trash covers `source_file` and `material` only: there is no workspace trash.
Deleting a workspace is `DELETE FROM workspaces`, so its files and materials go
by foreign-key cascade without passing through trash, and any of its rows
already carrying a `trashed_at` are destroyed with it rather than surviving to
`purge_after`. Both workspace delete confirmations say so.

The Files page's Select mode works in grid and list views. Files, Trash and
Create render items through one `ItemCard`/`ItemList` pair; outside Select
mode each card's link covers the whole card and a top-right menu carries the
item actions (Files: the same Rename/Properties/Delete `ContentActions` as the
workspace tree, without Move; Trash: Restore and Delete permanently). Select
mode replaces sort/filter with selection actions, swaps every card's link and
menu for a toggle, and Select all finishes pagination for the
current filters before updating the selection. Active-file Delete confirms
moving the selected files to trash. Trash offers Restore and confirmed permanent
deletion, plus Empty trash, which loads every page and confirms the collected
item count before deleting that snapshot. Items arriving after confirmation are
not included. Trash targets retain their episode IDs. Actions use the existing
per-item endpoints sequentially, stop at the first failure, and remove only
successful items from the selection. The error toast explains the failed
operation; remaining items stay selected for a manual retry.

Listing scopes outside a workspace (Sam 2026-10-19). `GET /api/files`,
`GET /api/materials` and `GET /api/trash` list by default what the caller pays
for, wherever it sits: the Files page is the storage breakdown. Other people's
uploads in a workspace the caller owns show inside the workspace (its trash
with `workspaceId`, owner only), not there. `scope=member` lists instead what
the caller can open: its own workspaces, those where it is an explicit member
under a live owner (the workspace list's rule), and its standalone materials,
never a row it only pays for; the dashboard's Recent uses it and offers
Rename/Properties/Delete only where the workspace's `capabilities` allow
editing. Global search (`Store.Search`) follows the same rule for workspaces,
files and flashcard sets. Link or public workspaces the caller has only opened
never appear in either. Past reviews and notifications keep the caller's
history but blank the live workspace (and chapter) name once the caller can no
longer reach the workspace (`lostAccessSQL`); a pending invite keeps its name,
and a notice's own snapshot (a removal's `workspaceName`) still shows.

Sources: [trash lifecycle](../server/internal/store/trash.go#L1),
[trash routes](../server/internal/httpapi/huma_trash.go#L1),
[trash sweep](../server/cmd/api/trash_worker.go#L1),
[Files selection](../src/routes/Files.tsx),
[shared item card](../src/components/app/ItemCard.tsx), and
[selection state](../src/features/files/useFileSelection.ts).

### Unrecorded stable objects

The scheduled job for unrecorded files is `runBlobSweep`. It covers the failure
window where an object reaches stable bucket storage but the request dies before
creating any database row. Because no reference was ever recorded, no trigger
can enqueue that object for the normal reaper.

The sweep:

- runs once at server startup and then every 30 days;
- lists `sources/`, `captions/`, `derived-text/`, `parse-bundles/`, `previews/`,
  `editor-assets/` and `thumbs/`;
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
parse, and provider reservations are cancelled. The owner's workspaces
and materials immediately disappear from member lists, Explore, direct shared
reads, and clone endpoints. Long-running chat, generate, editor-AI, and ingest
streams recheck both the actor session and workspace access and cancel when
either boundary closes. A suspension hides them the same way while it lasts
(see "What everyone else sees" under Account lifecycle gates). Clerk revocation reads explicit pages into a complete sweep before it
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

Purge runs after 30 days, except after Clerk `user.deleted`: the identity is
gone, so `MarkIdentityDeleted` pulls `purge_after` to now and the account worker
(every minute) purges on its next pass. During that grace window the durable content remains
recoverable only by support cancelling the deletion after verifying the request
out of band; there is no self-service cancellation endpoint, and cancellation
is refused once the grace deadline has passed. At purge, all
owned workspaces—including shared workspaces—their share links, files,
standalone materials, planner/history data,
memberships, invitations, notification data, credentials, and other
product-content rows are deleted atomically with the account tombstone, as is
the account's job history (job and attempt rows whose payload names its
workspaces; billing rows keep theirs with the attempt link cleared). A job it
ran in another owner's workspace stays with that file, without its id.
Remaining cross-account attribution is anonymized. Profile PII is scrubbed;
pseudonymous billing, usage, provider, storage, and audit ledgers may remain
under their own retention requirements. The account's editing incidents
(`edit_incidents`, see
[observability-metering.md](observability-metering.md#editing-incidents)) are
deleted with it; incidents that name no user, or another user, keep the
purged account's file ids until their 90 days pass. A purged account and the 30-day deleted
data cannot be restored.

Deletion requests, support cancellation, purge, Clerk `user.deleted` handling
and Stripe compensation serialize per account on one session advisory lock and
run their queries on the connection holding it, so a burst of lifecycle events
never waits on the pool for a second connection.

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
stored tier remains canonical while the lifecycle gate still denies access. Failed-invoice updates follow the same closed-lifecycle
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
job. Once no started cancellation is unresolved, cancelling deletion re-derives the
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

## Source editing and private PDF marks

Source collaboration uses the containing workspace's current owner/editor or
shared editor permission. Tokens bind a file and editing epoch. The gateway
rechecks access, account state and source identity when opening a room, saving
a checkpoint and admitting processing; disconnected old-epoch buffers require
explicit recovery. Source deletion, member/account changes and workspace
transfer use the collaboration eviction/outbox and processing fences.

Private PDF annotations belong to one actor and exact source identity. Reading
and mutation require current file access, and one actor cannot read or modify
another actor's marks. Clones and downloads do not include them, and
`PurgeUser` deletes the actor's marks at account purge.

Image-caption reuse checks current containing files. Private workspace reuse
stays within that workspace; link/public workspaces permit global reuse.
Only image-file ingest attaches captions, so every association names a file
(migration `0057` dropped `editor_asset_id`), and a clone copies its files'
published captions only.
Authorized reuse attaches a new resource reference; visibility changes
affect subsequent lookups without moving payloads. A resource's existing
association remains its own grant after the donor becomes private or is deleted.
Captions a refresh candidate copies from a donor stay unpublished until publication. Clones and whole-source
donors copy published associations only, and Office publication promotes the
exact image hashes consumed by that candidate before dropping retired captions.

Candidate source deletion has a one-day grace for a late presigned upload.
Ordinary reference checks still protect current sources, active candidates and
clones. Successful base replacement retains no original source or deleted
package parts solely for Undo; current source and cache references remain.
