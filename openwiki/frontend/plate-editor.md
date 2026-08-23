---
type: Frontend
title: 'Frontend: Plate.js and Yjs Editor'
description: 'Plate v53, Hocuspocus/Yjs authority, comment anchors, projections, and local AI previews.'
tags: [frontend, plate, slate, yjs, hocuspocus, collaboration, ai]
---

# Frontend: Plate.js and Yjs Editor

Evo Notes uses Plate/Slate for editing and rendering, but Yjs is the live and
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

ACL changes, sharing changes, and deletions publish an eviction event through
Redis. The sidecar closes matching room connections, and short token TTLs bound
stale access if an event is missed.

The editor never requires the member roster. Comment authorship arrives on the
discussion payloads, and mention autocomplete reads a redacted collaborator
directory that shared-link visitors may also fetch. Neither blocks the first
paint: a failed directory request disables mentions rather than the document.

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
second store and projection for every save.

`mod+s` stays bound so the browser's own save dialog never opens; it flushes the
debounce through the same path rather than running a second one. A client tracks
every outstanding receipt, so editing again before the service answers cannot
orphan an earlier request.

The old REST content autosave, local revision refs, full-document replacement,
draft unload warning, and five-second PATCH debounce do not exist. Public
material PATCH updates metadata only.

## Document limits and rejection

The collaboration service owns limit enforcement; the browser never measures the
document. `checkpoint-persisted` carries `{contentBytes, nodeCount, maxDepth}`
for the stats footer and a `limitCode` when the committed document is over a
limit.

`beforeHandleMessage` measures an inbound update before it reaches the
authoritative document, amortized over a budget of applied update bytes and
tightening to every update near a limit. An over-limit document still accepts
edits that do not worsen any dimension, otherwise the deletions needed to
recover would be rejected too and the material would be permanently unsavable.

A rejected update closes only the offending connection, preceded by a
`document-rejected` stateless message so the client discards its now-forked Y.Doc
instead of reconnecting and resending forever. If an over-limit document reaches
the store hook anyway, the sidecar broadcasts `document-rejected` to the room and
evicts it; Hocuspocus swallows store failures, so leaving the room loaded would
mean it silently never persists again. `NoteEditor` responds by remounting
`NoteEditorCore` under a new generation key, which reconnects onto the last
durable state. Invalidating the collaboration token alone is not enough, because
an unchanged room string leaves the editor mounted on its forked document.

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

Comment mutations publish `evo:collaboration:comments` through Redis.
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

Editor AI (`/ai/command`, `/ai/copilot`, `/complete/stream`) resolves
`users.editor_model_key` the same way chat does, including BYOK. Chrome is
gated by `VITE_FEATURE_EDITOR_AI` (off by default). See
[observability-metering.md](../observability-metering.md) for pinning, leases,
and credit rates.

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
  retry.
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
  regression to functions.
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
pnpm --filter @evo-notes/collaboration typecheck
pnpm --filter @evo-notes/collaboration test
cd server && go test ./...
```

Collaboration tests cover JWT claims/origin checks, stable-block command
preconditions, and v3 browser provider/v4 server convergence plus read-only
enforcement. Docker E2E adds PostgreSQL/Redis/sidecar coverage for persistence,
projection, reconnect, and multi-context behavior.
