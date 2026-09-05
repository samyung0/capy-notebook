---
type: Frontend
title: "Frontend: Plate.js and Yjs Editor"
description: "Plate v53, Hocuspocus/Yjs authority, comment anchors, projections, and local AI previews."
tags: [frontend, plate, slate, yjs, hocuspocus, collaboration, ai]
---

# Frontend: Plate.js and Yjs Editor

Capy Notebook uses Plate/Slate for editing and rendering, but Yjs is the live and
durable authority for material content after a room is initialized.

- Yjs owns live material content.
- Go/PostgreSQL own metadata, permissions, comments, and revision projections.
- `materials.content` is an eventually consistent Plate JSON read projection.
- Viewers and study routes render that projection without joining Yjs.
- Editors join with write access. Commenters join read-only to see live content.

## Package boundary

The browser uses Plate 53, `@platejs/yjs` 53.2.x,
`@hocuspocus/provider` 3.4.x, `@slate-yjs/core` 1.0.2, and Yjs 13.6.x.
The collaboration sidecar uses Hocuspocus server and Redis extension 4.4.x.
Provider/server wire compatibility is covered by the collaboration package
integration test.

`@platejs/yjs` expects the Slate tree in the `content` shared `Y.XmlText`.
The sidecar must use the same `@slate-yjs/core` conversion functions:

- `slateNodesToInsertDelta` for one-time server bootstrap;
- `yTextToSlateElement` for checkpoint projections;
- relative-position helpers for comment anchors.

Do not initialize clients with `materials.content`. Two clients independently
seeding an empty Y.Doc can duplicate content. Bootstrap happens under a
PostgreSQL advisory/row lock in the sidecar.

## Material surfaces and permissions

`materialModePolicy` exposes three modes:

- `view`: static `MaterialPreview`; no token, WebSocket, awareness, or editor;
- `comment`: live Plate in read-only mode with a `comment` room token;
- `edit`: live editable Plate with a `write` room token.

Quiz and flashcard materials still default to their study/view surface.
Commenters default to comment mode for ordinary Plate materials. Editors
default to edit mode.

The permission boundary is layered:

1. Go checks `MaterialEffectiveRole` before minting a short-lived token.
2. Viewers receive no collaboration token.
3. Hocuspocus verifies signature, issuer, audience, expiry, exact room, schema,
   access, and browser origin.
4. Hocuspocus marks comment connections read-only, so a modified browser cannot
   send Yjs document updates.
5. `PlateContent` is read-only before the comment connection starts.
6. Mutating plugins, slash commands, uploads, AI commands, and document toolbar
   actions are not mounted for comment mode.
7. Comment REST endpoints independently enforce comment/edit ACLs.

`MaterialEffectiveRole` is the union of the caller's membership and the
workspace share role, so a viewer member of a link-shared-for-editing workspace
mints a `write` token. Structural authorization is unaffected; see
[authorization](../authorization-permissions-lifecycles.md).

ACL changes, sharing changes, and deletions publish room eviction events through
Redis. Revocation, deletion, ownership/placement changes, and account locks use
discard mode so rejected in-memory state cannot return. Provably monotonic
ACL changes use drain mode: member insertion/promotion and privacy/share-role
widening persist accepted pending edits before unload. Account and plan
restoration instead flushes pending stores without closing connections or
unloading the room; later edits continue through the normal save cycle.
Workspace classification uses the effective nonmember grant: while privacy is
`private`, a dormant share-role change cannot turn a later privacy widening
into discard mode. A
The restoration user event also acknowledges without closing that user's
connections; account lock events still close them. The sidecar checks token expiry
on inbound messages and persistence rechecks actor/owner lifecycle in the
database, so a missed Redis event cannot authorize another durable write. Each
eviction has an operation id; a process single-flights overlapping eviction of
the same room and briefly deduplicates delivery of the same operation. The
publisher's direct local path and its Redis echo therefore cannot unload one
room concurrently or notify a later reloaded room, while a later distinct
eviction still runs normally. A failed Redis publish or acknowledgement is
reported and the durable sender retries, but it cannot
skip the mandatory local unload; a rejected room remains unavailable unless
that unload succeeds. Each active instance must return a positive delivery
acknowledgement. A negative acknowledgement leaves the outbox item retryable.
Durable material events carry the material identity as
well as their original room. Each instance resolves and evicts the current room
epoch after waiting for an in-progress compaction, then rechecks the epoch
before acknowledging delivery. An ACL event can therefore neither reopen a
failed discard nor disappear against a room schema that compaction replaced.

The editor never requires the member roster. Comment authorship arrives on the
discussion payloads, and mention autocomplete reads a redacted collaborator
directory that shared-link visitors may also fetch. Mention nodes persist their
display label and identifier in the document; if a deleted member no longer
resolves, rendering uses that stored value. Neither directory failure nor a
purged member blocks first paint: a failed directory request disables new
mention autocomplete rather than the document.

## Editor lifecycle

The interactive path is:

```text
CenterContent
└── NoteEditor
    └── EditorRuntimeProvider
        └── NoteEditorCore
            └── Plate + YjsPlugin
                └── CollaborationProvider
                    ├── NoteToolbar
                    ├── PlateContent
                    ├── EditorCommandPalette
                    ├── FloatingToolbar (edit only)
                    └── AiMenu (edit only)
```

`NoteEditor` requests the room token only for edit/comment mode.
`NoteEditorCore` owns one garbage-collected `Y.Doc`, configures remote cursor
identity, and calls Yjs `init` with the canonical room and `value: null`.
Cleanup destroys providers and disconnects the Yjs editor.

The Plate editor initially has a query-cache value so the React tree has a valid
shape before connection, but that value is never supplied as Yjs initialization
data. After sync, Slate-Yjs replaces editor children from the shared root.

Yjs-aware history is installed by `YjsPlugin`; ordinary Slate history must not
be layered on top. Normalizers must be deterministic and idempotent because
they run for remote operations too.

## Stable IDs and persisted node data

All element nodes need stable IDs before entering Yjs. IDs are used by:

- server-origin quiz/flashcard commands;
- block-level comment fallback;
- AI insertion/table targets;
- custom block rendering and relational card state.

Text leaves do not need IDs. Runtime values must never be written onto nodes:

- signed asset URLs and browser blob URLs;
- upload progress and errors;
- selection, hover, dialog, or plugin state;
- collaboration presence;
- local AI preview data.

Media nodes persist `assetId` and stable metadata. Renderers resolve signed URLs
at runtime.

Standalone quiz, flashcard, mindmap, and diagram titles live only in relational
material metadata. Their stored Plate documents contain the custom block but no
generated title heading. `MaterialRenderProvider` gives the custom block
renderer the material kind and title. The renderer adds a non-editable DOM `h1`
only when the material has no workspace. That heading is not a Slate node, Yjs
update, checkpoint, or revision. A workspace-contained custom material already
shows its relational title in the workspace chrome, and an embedded quiz or
flashcard block inside a note does not render the note title.

## Persistence and save status

Hocuspocus provider sync means only that the browser and in-memory server
converged. It does not mean PostgreSQL durably stored the state.

The editor reports:

- `Connecting…`: opening or reconnecting;
- `Synced`: provider convergence or a checkpoint awaiting durability;
- `Saved`: the sidecar confirmed that a state containing this client's work was
  committed;
- `Offline`;
- `Collaboration unavailable`.

On a value change, edit mode debounces a `checkpoint-request` stateless message
carrying a random receipt ID. The sidecar keeps the room's outstanding IDs in
memory, claims them before it reads the document, and after binary persistence
commits broadcasts `checkpoint-persisted` with those IDs, the stored version, and
the current document metrics. Only that receipt changes the browser status to
Saved. Receipts stay out of the Y.Doc deliberately: a marker written into the
document would be an edit, so acknowledging it would dirty the room and force a
second store and projection for every save. A failed-store retry carries the
IDs claimed with its snapshot and acknowledges only those IDs if the retry
commits. Checkpoints queued after that snapshot remain pending for a later
store.

`mod+s` stays bound so the browser's own save dialog never opens; it flushes the
debounce through the same path rather than running a second one. A client tracks
every outstanding receipt, so editing again before the service answers cannot
orphan an earlier request.

The old REST content autosave, local revision refs, full-document replacement,
draft unload warning, and five-second PATCH debounce do not exist. Public
`PATCH /api/materials/{id}/metadata` updates metadata only. Study-tool commands
that intentionally replace a stable quiz/card block use content-only endpoints;
relational metadata and standalone sharing use separate endpoints so a privacy
or metadata failure cannot be reported as though it rolled back an
already-durable Yjs command.

## Document limits and rejection

The collaboration service owns limit enforcement; the browser never measures the
document. `checkpoint-persisted` carries `{contentBytes, nodeCount, maxDepth}`
for the stats footer and a `limitCode` when the committed document is over a
limit. Size metrics strip runtime-only `comment` and `comment_*` text marks in
both TypeScript and Go before measuring the persisted Plate projection. Both
walks remain exact through the structural depth ceiling, including legacy
documents that already exceed the product depth cap.

`beforeHandleMessage` extracts writable updates from both Yjs sync-step-2 and
ordinary update frames before they reach the authoritative document. It
measures them amortized over a budget of applied update bytes and tightens to
every update near a limit. An over-limit document still accepts edits that do
not worsen any dimension, otherwise the deletions needed to recover would be
rejected too and the material would be permanently unsavable.

The writable Y.Doc contract permits only the Plate `content` root and the
server-owned `__capy_pending_contributors` map. Every client update checks this
allowlist before application, and load/store paths check it again. Unknown or
wrong-shaped top-level roots are rejected rather than persisted outside Plate
content accounting. Contributor markers have three bounded fields only:
`access`, `nonce`, and `userId`. Loading durable Yjs state validates those
markers before admitting the room.

A rejected update closes only the offending connection, preceded by a
`document-rejected` stateless message so the client discards its now-forked Y.Doc
instead of reconnecting and resending forever. If an over-limit document reaches
the store hook anyway, the sidecar broadcasts `document-rejected` to the room and
evicts it; Hocuspocus swallows store failures, so leaving the room loaded would
mean it silently never persists again. `NoteEditor` responds by remounting
`NoteEditorCore` under a new generation key, which reconnects onto the last
durable state. Invalidating the collaboration token alone is not enough, because
an unchanged room string leaves the editor mounted on its forked document.
Failed-store retries use the same terminal path. If a queued snapshot later
fails a document or quota limit, the sidecar drops it, broadcasts the rejection
when the room is still live, and discard-evicts the room back to durable Yjs
state.

Connection admission, token refresh, and each durable store also re-read actor
lifecycle, membership/share role, owner lifecycle, and quota state from
PostgreSQL. The sidecar adds server-owned actor metadata inside the same Yjs
transaction as every writable update; Redis peers therefore receive the edit
and its provenance atomically. Client updates that alter that metadata are
rejected. A debounced store snapshots the document and rechecks every distinct
contributor represented by that snapshot, not only the last editor. It removes
the claimed metadata from the committed state and clears only the matching
in-memory generations after commit, so an update arriving during the store
belongs to the next batch. Failed-store retries retain the same contributor
set. If an authorization change races an already-applied in-memory Yjs update,
persistence rejects the whole snapshot and evicts the room; authorized clients
then reload the last durable state rather than inheriting or later retrying the
revoked user's update.

None of this gates **opening** a document. Limits protect the collaboration
service and the database on write; a document that already exists always opens.
`MaterialBody` reads `sizeBytes` / `nodeCount` from the cached material list and
shows `HeavyMaterialGate` when either passes `MATERIAL_RENDER_WARNING`, offering
read-only (static `MaterialPreview`, no Yjs handshake and no editing plugins) or
open-anyway. Absent list metadata always opens: the gate must never become a
door the reader cannot pass. When the API cannot decode stored content it
answers 422 `material_content_unreadable`, which `NoteEditor` and `MaterialBody`
report as "this note could not be loaded" rather than "not found".

## PostgreSQL read projection

`material_yjs_documents.state` stores the encoded Y.Doc and is the durable
content authority. `stored_version` is monotonic. The sidecar converts the
stored `content` root to a Plate envelope and calls the internal Go projection
endpoint.

Go validates the complete envelope, locks the material, ignores stale versions,
updates `materials.content`, increments the material revision, upserts the UTC
daily revision, reconciles flashcard stats, and advances `projected_version`.
Rows where `projected_version < stored_version` are retried by the sidecar.
Binary persistence and projection have separate failure boundaries. Once a Yjs
version commits, a projection outage does not enqueue that snapshot as a failed
store or advance `stored_version` again. The lag scanner projects the committed
watermark and records each failure. Its timer, pending-row query, per-row
projection, and error-recording paths contain and report their own failures.
An error write includes its failed Yjs version and applies only while that
version remains ahead of `projected_version`, so a slow older failure cannot
restore `projection_error` after newer content succeeds.
Each service command registers a completion ID before its direct connection
opens. The store hook records projection success or failure against that ID,
and the HTTP handler checks it after disconnect. This explicit result is needed
because Hocuspocus catches store-hook errors. The handler returns 503 when the
synchronous projection fails, even though the Yjs change is already durable
and remains eligible for the normal lag retry.

The final durable store takes the material advisory lock, then follows the same
SQL row-lock order as Go mutations: workspace row (when present), contributor
and owner accounts in ID order, then the material row. It revalidates placement
and every contributor only after those locks are held. It also validates the
complete Plate structure and the custom block required by the material kind
before committing Yjs state. Member removal, role
demotion, lifecycle changes, standalone privacy changes, and clones therefore
cannot form an account/material deadlock or slip a save across the revocation
boundary: the save either commits first or observes the revoked access and is
rejected without advancing Yjs state or the SQL projection.

Quiz `timeLimitMin` uses the same integer range in REST, collaboration, and Go
projection validation: 1 through 180 minutes. Values outside that range never
enter durable Yjs state.

Cloning is deliberately a projection read, not a Yjs synchronization point.
Both workspace and single-material clones copy the `materials.content` visible
when their transaction starts, even when a durable Yjs row is newer or its last
projection attempt failed. A clone must never wait for, flush, or fail because
of Yjs projection lag; accepting a possibly stale copy is the product decision.
The clone receives no `material_yjs_documents` row. Its first collaboration
open or server-side content command lazily initializes a fresh Y.Doc from the
cloned projection, exactly like any other uninitialized material.

The clone transaction uses a repeatable-read SQL snapshot without locking the
source workspace or material. Source popularity counters are stored separately,
so incrementing a clone count cannot block an accepted Yjs store or projection.
Source deletion waits on the same per-resource clone advisory lock in a
before-delete trigger, ahead of cascaded material/blob teardown, then cleans
those counters. This prevents a late first clone from recreating an orphan
counter. Source-owner and target account lifecycle rows are locked in
canonical ID order. Clones also lock only the physical blob refcount rows they
copy, in stable path order, so the reaper cannot delete shared bytes before the
new references commit. None of these locks reads or waits for Yjs state.

Static previews, study views, exports, and domain reads can lag the live room by
the persistence/projection debounce. They must never write their projection
back into an initialized Y.Doc.

A mounted editor answers `projection-updated` by marking the material query
stale without refetching, and flushes one real invalidation when it unmounts.
The room is the content authority while the editor is open, so refetching there
only re-downloads and re-parses a document nobody is reading — on a near-limit
note that is seconds of main-thread time per save.

Server-origin content mutations use the sidecar command endpoint. Commands load
the current Y.Doc and replace one stable custom block through headless
Slate-Yjs transforms with a stale-block precondition. They do not replace the
whole document. If the authority is unavailable, Go returns 503 instead of
falling back to SQL.

## Relational comments with Yjs anchors

Comments and threads remain relational. A discussion stores:

- stable `blockId`;
- encoded start/end Yjs relative positions;
- anchor schema version;
- a short quoted-text fallback;
- comments, resolution state, and authorship.

The JSON API base64-encodes relative positions; PostgreSQL stores raw `bytea`.
Go enforces paired anchors and strict size/version/quote bounds.

When creating a comment, the browser converts the selected Slate range with
`slateRangeToRelativeRange`. Rendering reverses it with
`relativeRangeToSlateRange` against the live shared root.

Comment highlighting is local decoration state. It is never applied with
`editor.tf.setNodes`, so opening or hovering a comment cannot create a Yjs
update. If an anchor no longer resolves, the thread remains available at its
stable block and quoted fallback instead of being deleted.

Comment mutations publish `capy:collaboration:comments` through Redis.
Hocuspocus sends a stateless `comments-invalidated` room event and clients
invalidate the discussion query.

## Commands

`editorCommands.ts` is the shared command catalog. Editors can open commands by
typing `/`, through toolbar menus, or with `mod+k`. Comment mode's command
palette exposes only Comment. Typed slash commands and all document mutations
remain editor-only.

`mod+shift+m` opens the comment workflow for an active selection.

## AI previews

AI output is local until accepted:

- streamed edits retain a Yjs relative target range;
- generated inserts retain a stable block ID;
- table updates retain stable cell IDs;
- proposed text/nodes live in a local weak store, not Slate or Yjs.

`AiMenu` displays removed and proposed text. Reject clears local state without a
Yjs transaction. Accept re-resolves every target; if concurrent changes make a
target invalid, the UI requires retry. A valid accept assigns missing element
IDs and flushes one Yjs transaction.

Copilot ghost text remains plugin-local and continues in the note's language.
Generate/comment replies follow the account locale injected by the gateway; edits
keep the selection's language unless the instruction asks to translate. AI
comments use the same relative-anchor REST path as user comments.

Editor AI is two public routes: `POST /api/workspaces/{id}/ai/command`
(Python `/plate-ai/command`) and `POST /api/workspaces/{id}/ai/copilot`
(Python `/plate-ai/copilot`). Both resolve the
`users.editor_model_provider_slug` / `users.editor_model_slug` pair the same
way chat does, including BYOK. Chrome is gated by `VITE_FEATURE_EDITOR_AI`
(off by default).

The command menu always sends `ctx.toolName`. Missing or unknown values are
`400`. There is no server classify step. Free-form text in the menu input
sends `generate`, so a rewrite-style sentence still inserts new Markdown
instead of replacing the selection. Canned Improve / Grammar / Shorter /
Longer / Simplify send `edit`. `comment` is implemented and kept for a future
Comment action; the current menu never sends it. Retry resends the last
`toolName`.

Thinking is forced to Instant on every editor provider call so typing stays
fast. Settings → LLM shows a disabled Instant control for editor assistance.
That settings lock is UI-only: the prefs schema has no `editorThinking`.
See [observability-metering.md](../observability-metering.md) for pinning,
leases, and credit rates.

## Static rendering

`MaterialPreview` uses `PlateStatic` and the checkpointed Plate envelope. Static
components must not use editor hooks. Interactive and static component
registries share node vocabulary but have different behavior.

Obsolete `suggestion` and `suggestion_*` properties are rejected by server
validation and are not rendered.

## Operational boundaries

- Viewers never connect, reducing room load.
- Start with one sidecar replica and Redis available.
- Persistence uses bounded debounce/max-debounce and retains failed stores for
  retry. Retry passes do not overlap within a sidecar process, and a retry only
  clears the exact queued snapshot it attempted; a newer failed snapshot stays
  queued.
- Redis coordinates multi-instance document/awareness state; it is not durable
  storage.
- Monitor active rooms/connections, Y.Doc size, store/projection latency and
  failures, projection version lag, event-loop lag, RSS, disconnects, and
  Redis/PostgreSQL latency.
- Do not impose an arbitrary room occupancy cap. Add a distributed measured cap
  only when load tests or production usage justify one.
- Keep Yjs garbage collection enabled. Compaction/rebasing requires a separately
  tested maintenance procedure.
- Nothing outside the document may re-render the document. A near-limit note is
  ~7.4k Slate nodes, so one extra render is seconds of blocking. Concretely:
  context values read from inside the tree (`EditorRuntime`, collaboration
  actions) must be identity-stable; the `decorate` and `onKeyDown` props of
  `PlateContent` must be stable, because Plate treats new editable props as a
  full re-render; and save/footer state must not reach `NoteEditorContent`,
  which is memoized for that reason. `e2e/perf/editor.perf.ts` guards this with
  a save-cycle blocking budget, and `saveCycleProfile.perf.ts` attributes a
  regression to functions. How to run those specs and the manual GitHub Actions
  checkpoint is in [editor-perf.md](../editor-perf.md).
- Remote cursor decorations must match Slate paths structurally (not
  dot-joined path strings). Shared-link editors may be absent from the
  workspace member directory, so cursor labels fall back to the authenticated
  user's name. Because decorations split text leaves, editor end navigation
  should use the Plate document API.
- Static `PlateStatic` output still carries a `data-slate-editor` marker but is
  not editable; editability checks should use `contenteditable`.

## Verification

Run:

```bash
pnpm run typecheck
pnpm run test
pnpm --filter @capy-notebook/collaboration typecheck
pnpm --filter @capy-notebook/collaboration test
cd server && go test ./...
```

Collaboration tests cover JWT claims/origin checks, stable-block command
preconditions, and v3 browser provider/v4 server convergence plus read-only
enforcement. Docker E2E adds PostgreSQL/Redis/sidecar coverage for persistence,
projection, reconnect, and multi-context behavior.
