---
type: Frontend
title: "Frontend: Plate.js and Yjs Editor"
description: "Plate v53, the Rust collaboration server as Yjs authority, comment anchors, projections, and local AI previews."
tags: [frontend, plate, slate, yjs, collaboration, ai]
---

# Frontend: Plate.js and Yjs Editor

Capy Notebook uses Plate/Slate for editing and rendering, but Yjs is the live and
durable authority for material content after a room is initialized.

- Yjs owns live material content.
- Go/PostgreSQL own metadata, permissions, comments, and content projections.
- `materials.content` is an eventually consistent Plate JSON read projection.
- Note View and signed-out or public pages render that projection without
  joining Yjs.
- Editors edit and comment in Edit mode; View is a static preview without comments.
- Flashcard sets and quizzes are live everywhere (live-items, Epo 2026-10-10):
  their editors, View, study and attempt pages and note embeds join the item's
  own rooms; signed-in viewers join read-only, with no presence and no comment
  relays, and never a quiz's keys document.

## Package boundary

The browser uses Plate 53, `@platejs/yjs` 53.2.x, `@slate-yjs/core` 1.0.2, and
Yjs 13.6.x. Plate gets its provider through `registerProviderType`: the room
provider in `src/features/collaboration/` (capy-sync 1, one WebSocket per tab
with each room on its own channel, y-sync and awareness payloads unchanged
inside, no echo of a client's own updates, batched acknowledgements, in-band
token refresh). `@hocuspocus/provider` stays installed only because
`@platejs/yjs` imports it.

The collaboration server is Rust (`collaboration-rs/`) on yrs, the fork's
patched copy in `vendor/betteroffice/third_party/yrs`. Each environment runs
one instance; its Redis use (eviction delivery, comment relays, source
handoff and publication locks) does not sync documents. Each loaded
room is one task that owns its document; Office engines run in child
processes of the same binary (see [Office files](office-files.md)).
`collaboration-rs/crates/server/tests/rooms.rs` drives the real binary over
capy-sync against PostgreSQL and Redis.

`@platejs/yjs` expects the Slate tree in the `content` shared `Y.XmlText`.
The server's `notes` crate reproduces the `@slate-yjs/core` conversions
exactly (`slate_yjs.rs`, `plate.rs`): bootstrap from a Plate value, the Plate
projection of the `content` root, and Slate operations for agent edits and
commands. The browser keeps the relative-position helpers for comment anchors.

Do not initialize clients with `materials.content`. Two clients independently
seeding an empty Y.Doc can duplicate content. Bootstrap happens under a
PostgreSQL advisory/row lock in the collaboration server.

## Material surfaces and permissions

`materialModePolicy` exposes two modes:

- `view`: static `MaterialPreview`; no token, WebSocket, awareness, or editor;
- `edit`: live editable Plate with a `write` room token.

Files and materials remember their last View/Edit mode separately in localStorage, keyed by item kind and ID. Explicit URL modes take precedence; otherwise the saved mode is used, with View as the default for an uncached item. Viewers only get `view`. The header toggles View/Edit showing the mode it switches to (the Edit icon and label while viewing, View while editing; pressed still means editing) with identical styling in both states, for materials and uploaded files at every viewport size. Workspace and standalone document URLs accept `mode=view|edit`; a successful toggle replaces that query parameter, so reload and shared links retain the mode. File transitions retain their save/export gates, and a failed transition keeps the editor and URL in their previous mode.

The permission boundary is layered:

1. Go checks `MaterialEffectiveRole` before minting a short-lived token.
2. Signed-in viewers receive `read` tokens for content documents (never quiz
   keys); the collaboration server joins them read-only, never relays awareness
   to or from them and sends them no comment relays (Epo 2026-10-10). Narrowed
   editors (a frozen account, a full owner) keep presence.
3. The collaboration server checks the browser origin at the upgrade and, per
   room, the token's signature, issuer, audience, expiry, exact room, schema
   and access.
4. It joins `read` channels (a viewer's, and the downgrade an editor receives
   while their own or the storage owner's account is frozen, or the storage
   owner is at its storage limit) read-only: a step 2 or update holding
   anything new closes the channel, so a modified browser cannot send Yjs
   document updates.
5. View mounts only the static preview, without editor plugins or comment controls.
6. Comment REST endpoints independently enforce the editor ACL.

`MaterialEffectiveRole` is the union of the caller's membership and the
workspace share role, so a viewer member of a link-shared-for-editing workspace
mints a `write` token. See [authorization](../authorization-permissions-lifecycles.md)
for the full matrix.

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
connections; account lock events still close them. The server checks token expiry
on inbound messages and persistence rechecks actor/owner lifecycle in the
database, so a missed Redis event cannot authorize another durable write. Each
eviction has an operation id; a process single-flights overlapping eviction of
the same room and briefly deduplicates delivery of the same operation. The
publisher's direct local path and its Redis echo therefore cannot unload one
room concurrently or notify a later reloaded room, while a later distinct
eviction still runs normally. A failed Redis publish or acknowledgement is
reported and the durable sender retries, but it cannot
skip the mandatory local unload; a rejected room remains unavailable unless
that unload succeeds. The room's task runs the eviction in order with its stores (one store at a time per room), so a running store finishes first. Intentional discard skips pending stores without reporting a failed save; drain still requires a successful durable save. Each active instance must return a positive delivery
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

File viewers portal their mode/save controls into the center header. The shared
contexts live in `fileModeContext.ts`, separate from the hot-reloaded control
component, so the header and lazy file viewers retain the same context identity.

Materials opened from Create use the same `CenterContent` frame as workspace
materials, using the same per-item mode preference. The `/materials/:id` route retains the app
sidebar, uses only the navigation back icon before the title, and hides
workspace actions. A newly created standalone note requests `?mode=edit`.

The interactive path is:

```text
CenterContent
└── NoteEditor
    └── EditorRuntimeProvider
        └── NoteEditorCore
            └── Plate + YjsPlugin
                └── CollaborationProvider
                    ├── NoteToolbar
                    ├── scroll box
                    │   └── PlateContainer (relative)
                    │       ├── PlateContent + link actions
                    │       └── FloatingToolbar (edit only)
                    ├── EditorCommandPalette
                    └── AiMenu (edit only)
```

`FloatingToolbar` shares the editor's positioned `PlateContainer`, following
Plate playground's placement beside the editable content. The browser scrolls
the toolbar and selection together immediately; Floating UI still handles
selection changes and collision placement. The fixed toolbar and its portalled
popovers use Plate's `ignore-click-outside/toolbar` class, so formatting a live
selection does not briefly close and reopen the floating toolbar. Merely mounting inside the scroll
box left its absolute containing block outside that box, so it had to catch up
through JavaScript on every scroll. Link actions already use this structure.
Its buttons are the same
`ToolbarButton` the top row uses, so both rows share one icon colour, size and
hover treatment; the Ask AI button only overrides the square width.

Long notes use 32-block chunks with `content-visibility: auto`. Each chunk has
24px inline padding and matching negative margins, keeping text aligned while
including the drag-handle gutter inside its paint containment. Without that
space, handles exist but are clipped and cannot receive pointer input.
Heading handles use the computed line height to center on the first line,
sharing one positioning rule across H1–H6 and wrapped headings.
List and paragraph handles measure the first rendered text line to account
for internal numbered/todo wrappers and paragraph padding. Todo checkboxes use the CSS line height to center on
the first line, including wrapped rows. A block's indent stops at the embed
catalog's `LIST_INDENT_MAX` (8, the indent plugin's `indentMax`); every
validator refuses a deeper one. Todo rows use only Plate's indent;
the checkbox sits 24px before the text in both editable and static renderers,
so empty slash-command hints share the text position without overlapping it.

TOC entries reuse `Button` in Edit and View modes, retaining heading indentation
and hover transitions. Rows are square, full-width and gapless, with a local
override disabling press shrink. The TOC margin sits on its Plate element so
the drag handle aligns with the first text line. The navigation has an accessible
label without a visible caption; selected TOC blocks use accent hover colors.
Both modes scroll to headings with the shared 250ms `--motion-duration-fast`
and `--motion-ease-smooth-out` tokens, leaving 36px above the destination when
scroll bounds allow. Reduced motion jumps immediately; new navigation or manual
wheel, touch, pointer or keyboard input cancels the current scroll. A native
empty animation supplies eased progress to a short animation-frame scroll loop.

`components/ui/BlockToolbar` owns the shared floating surface for selection,
link and block actions, question-dialog blocks and the single-column workspace
controls: full pill radius, border, surface, shadow, 4px padding and zero
button gap, with no vertical dividers. Destructive actions use Button's shared
`danger-light` variant. `FloatingToolbar` uses `PopupMotion` for the retained fade/scale/blur
exit; anchored block popovers use the same CSS motion with Radix positioning and
exit lifetime. Their controls become inert on close. The workspace overrides
padding to 6px and buttons/icons to 40px/20px through className; other floating
actions use 32px/16px.

`NoteEditor` requests the room token only for Edit mode.
`NoteEditorCore` owns one garbage-collected `Y.Doc`, configures remote cursor
identity, and calls Yjs `init` with the canonical room and `value: null`.
Cleanup destroys providers and disconnects the Yjs editor.

The Plate editor initially has a query-cache value so the React tree has a valid
shape before connection, but that value is never supplied as Yjs initialization
data. After sync, Slate-Yjs replaces editor children from the shared root.

Yjs-aware history is installed by `YjsPlugin`; ordinary Slate history must not
be layered on top. Normalizers must be deterministic and idempotent because
they run for remote operations too.
The toolbar subscribes directly to Yjs UndoManager stack events, including
undo/redo and clear, so availability updates without editor focus or selection.
Its actions use the same Yjs history as note editing.

## Stable IDs and persisted node data

All element nodes need stable IDs before entering Yjs. IDs are used by:

- server-origin quiz/flashcard commands;
- block-level comment fallback;
- AI insertion/table targets;
- custom block rendering and relational card state.

The note editor runs without Plate's NodeIdPlugin (`nodeId: false` in
`NoteEditorCore.tsx`). That plugin repaired ids only on its own copy of each
operation, after Slate-Yjs had recorded the original, so a block made by Enter,
a split or Duplicate had one id in the editor and another in the room (or a
duplicate the store refused). `stableElementIdsPlugin`
(`src/features/notes/stableElementIds.ts`) does the work in the operation
Slate-Yjs records instead, so both hold the same ids:

- every element of a local `insert_node` gets a new id when it has none or one
  another element of the note already has (a duplicated or re-pasted block);
  the note's id set is built only when the inserted subtree brings ids;
- a local `split_node` gets a new id;
- `id` counts as metadata, not block state (`isElementStateEmpty`, which the
  empty-note placeholder reads), as NodeIdPlugin declared;
- Plate's `_id` insert marker is dropped at every depth of an insert and from a
  split's properties. The note editor no longer writes it, but content copied
  from an editor that runs NodeIdPlugin (question text) or from a room written
  before can carry it, and the store refuses it on interactive blocks.

Slate-Yjs applies a remote Yjs event without normalizing; the normalization
after it (merging the leaves a remote insert left side by side) runs as local
operations that Slate-Yjs keeps with the tree they were made on and would
flush at the next onChange microtask. `remoteNormalizationPlugin`
(`src/features/notes/remoteNormalization.ts`, after YjsPlugin) flushes them
right after their event: a second remote update in the same task would
otherwise have them applied to the newer Yjs state, writing a wrong change
into the room. The Rust server sends one merged update per room per frame,
each frame its own WebSocket message (its own task), and draft replay is one
merged update before the room connects, so with the server the burst does
not happen; the in-page mock room can produce it.

Text leaves do not need IDs. Runtime values must never be written onto nodes:

- signed asset URLs and browser blob URLs;
- upload progress and errors;
- selection, hover, dialog, or plugin state;
- collaboration presence;
- local AI preview data.

Media nodes persist `assetId` and stable metadata. A note's media are images
and audio only (Epo 2026-10-15): there is no PDF or file block, and the editor
asset purposes are `image` and `audio`, an audio file capped by the payer's
per-file plan cap. Uploads go through the
note's material route, so standalone notes upload too (see
[backend-storage-quota.md](../backend-storage-quota.md)). Renderers resolve signed URLs
at runtime. An `img`, `image` or `audio` node always names its asset
and carries no `url` or `src` (Epo, 2026-10-10): the browser's document check
(`validateMediaElement`), Go (`validateMedia` in `materialdoc`) and the
collaboration server refuse it otherwise. The server refuses it when the
update arrives (`media_assets` in `collaboration-rs/crates/notes/src/limits.rs`,
on the elements whose `type`, `assetId`, `url` or `src` the update set or
deleted), so only that writer's update is lost, and its store checks it again.
The same holds for every key the store requires (`required_keys`, REVIEW5 R2):
an update that leaves an element it touches without a non-empty `type`, a
top-level block without its `id`, or a block without its type's own keys (a
reference's `materialId` and `refKind`, a diagram's `source`, a video's
`provider` and `videoId`, ...) is refused on arrival; a key the element
already lacked is not held against an update that did not create or retype
it. Each key is read as the element holds it after the update, by lookup,
not by scanning the element's attributes (REVIEW5 M3): with no entry written,
the room's current entry unless the update deletes it; otherwise the last of
the update's entries when they follow on from the room's current one (each
written after the one before, as a writer's own sets are) unless the update
deletes it (REVIEW5 R2b). Entries that do not follow on (a stale or concurrent
write, writers merged into one update) are read on the room with the update
applied, off the async workers: a stale or merged update is no small edit, so
its trial copy serves, and a crafted small edit takes its own copy, off the
workers through `heavy`. Every element is checked before a copy is asked
for, so a refusal anywhere answers first and `heavy` and the admission agree
(REVIEW5 final S1, S2). An update that writes or deletes only keys no element
requires is not looked at.

Pasted images take the same asset path (`pastedImages.ts`): clipboard image
files become upload placeholders, as dropped files do. Plate's placeholder
plugin takes files pasted alone; `pastedImagesPlugin`'s `onPaste` takes them
only beside a browser's Copy image HTML, nothing but `<img>` elements
(`onlyImages`), so an Excel, PowerPoint or OneNote copy, whose HTML sits beside
a rendered picture, pastes as HTML (REVIEW5 M2); a drop stays with the DnD
plugin's `onDropFiles`, so it makes one placeholder. An `<img>` in pasted HTML,
a markdown image pasted as text (VS Code's markdown included) or imported from
a `.md` file, and a picture in an imported `.docx` (mammoth gives it as a
`data:` URL; Epo 2026-10-10, main 1be046ea), which Plate's parsers turn into
URL-only nodes, become a placeholder in their place whose element fetches the
URL in the browser and uploads the bytes, or a link to the URL showing the
image's alt text when it cannot. Only absolute http(s) and `data:` URLs are
read, never a path on this app; the file's extension comes from the served
type through the types the server stores (`IMAGE_EXTENSIONS` in
`src/lib/fitImage.ts`), and a type it refuses (an icon, SVG) or any failed
read ends as the link, or nothing for a non-web URL, with the URL forgotten,
so no skeleton stays (REVIEW5 S1). Pasted images read and upload four at a
time; the rest wait as skeletons (REVIEW5 N6). Nothing is fetched by a
server: markdown images in agent-written notes become those links in the
converter (`urlImageLink` in `markdownImport.ts`, shared by the browser's
import and the server's V8 bundle), an image inside a link leaves its alt text
there, and an element left empty by a dropped image (a quote, a cell) keeps an
empty text, a list item an empty item (REVIEW5 S2). Without asset uploads
(`allowExternalAssets` off) a pasted or imported image is a link. The image
plugin's URL embed (`disableEmbedInsert`) is off, so no URL-only image node is
made.

An uploading image is a skeleton (`MediaPlaceholderElement`), from the first
render of a dropped or pasted file and while a pasted URL is read, and the
image takes its place when the asset id returns; a media node is the same
skeleton while its asset resolves (`MediaAssetView`), so nothing flashes in
between (Epo, 2026-10-10). An upload superseded by a newer one of the same
block (its effect run again) leaves the block's state to that one. A refused
upload leaves the empty placeholder (pick again, or delete it) with the
storage notice or the error under it; an audio placeholder keeps the name,
progress and cancel. Every dropped or pasted file gets a placeholder: Plate's
own per-type size and count checks, which dropped a file silently, are off
(the placeholder plugin's `uploadConfig` in `plugins.ts`), so the server's
caps answer. A file that is neither an image nor audio (a PDF, a document, a
video) gets an image placeholder that refuses it with the type message
(`editor_choose_purpose`, or the YouTube hint for a video) and offers its
picker again.

Other clients see the same skeleton through the uploader's presence
(`uploadPresence.ts`, Epo 2026-10-10): while an image uploads, the uploading
tab's awareness names its placeholder by node id (`uploads: [id, ...]`), and
drops the id when the upload finishes, fails or is cancelled (the block's
effect cleanup). Every other client of the room, editable or read-only,
renders a placeholder named in any other client's awareness as the skeleton;
each placeholder subscribes to awareness on its own
(`useUploadingElsewhere`, `useSyncExternalStore` with a boolean snapshot), so
a presence change re-renders only the placeholders whose answer changed, not
the editor. When the uploader disconnects (the room nulls its presence) or
its awareness times out, the block is the empty placeholder again; nothing
about an upload is stored in the note. A tab names at most 100 uploads (an id
is at most 21 characters, so under 3 KiB of the server's 64 KiB awareness
entry, past which the room closes the channel), and a received list counts
only its first 100 ids of up to 32 characters (REVIEW5 E1, E3). The room drops
the list from a read-only channel's presence (`without_uploads` in
`room.rs`), so a viewer cannot show blocks as uploading (REVIEW5 E2; it parses every
such entry, so an escaped key cannot slip past, R1, and relays one it cannot
parse as a removal, since a browser's `JSON.parse` takes some JSON serde_json
refuses, R1b). Viewers
that do not join the room (the static projection) do not see it.

Each asset belongs to one note, and the server keeps it that way; the browser
does nothing but render. A save that stops using an asset (once it was
completed more than 60 s ago) puts it in a hidden trash for a day, still
charged, and a save that uses it again restores it. A paste, drop, undo, cut
and paste or a draft replayed after reconnect is an ordinary Yjs edit: the
collaboration service's children pass (`collaboration-rs/crates/server/src/children.rs`
and the room, see [agentic-retrieval](../agentic-retrieval.md) for the AI edit
side) reads the asset and quiz ids each writer's update wrote, asks Go to make
them the note's own as that writer (a copy of another note's asset, the note's
own one out of the trash), then repoints or drops the nodes in the room, one
pass at a time in update order, and broadcasts `children-ready` with the ids
it kept. In an editable note
`MediaAssetView` (given the note as `ownerId`) shows a skeleton while a node's
asset belongs to another material (the resolve answer's `materialId`) or does
not resolve (trashed, waiting for the pass), and resolves again when
`children-ready` names it (`childrenReady.ts`). A copy that does not fit the
payer's storage is dropped and only the writer who pasted gets
`children-refused`, shown as a toast. Nothing is kept in IndexedDB and the
browser never calls an adopt route.

Image, YouTube, mermaid, chart and graph blocks share `MediaFrame`: a toolbar docked top-right
that shows on hover, and in edit mode two side handles that resize the block
symmetrically and store `width` as a percentage string (`"62%"`), a whole number
from 20 to 100. Go and the collaboration server accept exactly that on these five
blocks (`mediaWidth` and `validate_width`, `^(?:[2-9][0-9]|100)%$`) and refuse any
other width, so a resized block never gets its room refused. Charts, graphs and
interactive blocks are top-level blocks and store only their own fields
(`id`, `type`, `block`, `children`, `width`; `id`, `type`, `html`, `caption`,
`children`): the browser refuses any other field as Go and the server do, with
no compatibility path for the interactive block's old `title` (Epo,
2026-10-10). `diagram` and `mindmap` are material kinds whose document holds a
`mermaid` block; they are not node types. The browser's
document check (`isMaterialNode` in `src/features/materials/document.ts`)
applies the same rule, so a JSON import carrying another width fails on its
own with the import's error toast instead of getting the room refused. Frames stop at
48rem wide and images and diagrams at `min(70vh, 48rem)` tall. Clicking an image
or diagram opens `MediaPreview`, a full-screen view on a dark backdrop with the
name above and the caption below, in every editor mode. It zooms to 8× with the
wheel, pinch, double-click and header buttons (`react-zoom-pan-pinch`), pans on
drag, and closes on a still click outside the media. Exports scale a
percentage against the 560px image cap. In edit mode the image toolbar adds a
caption (Plate `CaptionPlugin`; the field focuses in place and an empty one hides
on blur), open in new tab and replace; replace keeps the node id, width and
caption. The YouTube toolbar has open on YouTube and a link editor that accepts
any link `youtubeVideoId` parses. View mode and read-only editors show only the
open button. A YouTube block shows the video's poster with a play
button everywhere; YouTube's player (about 1 MB) loads only once it is clicked
(`YouTubeEmbed.tsx`; server-rendered shared notes start it with plain script).

Every block embed (`img`, `video`, diagrams) must be a void node. Enter on a
selected void opens an empty paragraph below it (`voidBlockBreak.ts`); a
non-void embed would instead be split into two copies of itself. A void's caret sits at its
top-left corner, so `NoteEditorCore` skips slate's scroll-into-view while any
part of the void is on screen; otherwise re-rendering a tall block (a theme
change) jumped the page back to its top.

Quizzes and flashcard sets never render through Plate. Opened as a file (in a
workspace or standalone) the center pane shows the quiz page's question list or
the flashcard grid (`src/features/flashcards/FlashcardGrid.tsx`: fronts as
tiles, a preview dialog with the front over the back and Previous/Next), each
under the material title, and flashcard edit mode is the live card grid
described under authoring below (`src/features/materials/CenterContent.tsx`).

Standalone quiz, flashcard, mindmap, and diagram titles live only in relational
material metadata. Their stored Plate documents contain the custom block but no
generated title heading. `MaterialRenderProvider` gives the custom block
renderer the material kind and title. The renderer adds a non-editable DOM `h1`
only when the material has no workspace. That heading is not a Slate node, Yjs
update or checkpoint. A workspace-contained custom material already
shows its relational title in the workspace chrome, and an embedded quiz or
flashcard block inside a note does not render the note title.

## Embedded quizzes and flashcards

A note never inlines a quiz or flashcard set. Both are material rows of their
own with `parent_material_id` set, sharing the note's workspace, private and
unfiled, with a random UUID as a name that is never displayed (they are not in
any materials list), and the note stores a void `material_ref` block
(`{materialId, refKind}`) that renders the item itself, with no title row
(`src/features/materials/embeds/`): View (note View and the public note page)
shows the study component in the note's flow (`AttemptBody` / `StudyBody` in
embedded mode: Submit grades in place, a flashcard flips when clicked), Edit shows the live editors in place (`QuizForm`'s Edit and
Remove per question and Add question, editing the quiz's content and keys
rooms; the `FlashcardsEditor` grid with its hover toolbar and Add card, editing
the set's room). An embed joins its rooms only while within about a viewport
of the screen, stays joined 30 s after it leaves (`useNearScreen.ts`) and while
it holds unacknowledged edits. Removing the last question or card removes the
block itself (the item follows the removed-block trash rule; Undo restores both). The static renderer takes the page's embed renderer from
`EmbedViewContext` (the app's reads through the account and loads on demand; the
share page feeds the note's public data). Blocks that need the browser in a read-only
render (images, embeds, diagrams, interactive HTML) sit in an `Island`
(`Island.tsx`, views in `staticViews.tsx`): inert in the app, they are what a
server-rendered shared note hydrates, and equations render MathLive's static markup
there (`StaticMathContext`). Inserting through the slash command or toolbar
creates the row through `POST /api/materials/{noteId}/embedded` (a set with one
blank card) and inserts the reference at the top level, where it opens in place
for editing. The block goes where the command ran, not where the caret is when
the row arrives (`holdInsertPlace` in `insertEditorNode.ts`): over the
command's line while it is still an empty paragraph, otherwise after it, and it
takes the caret only if the caret has not moved, so typing elsewhere during the
round trip is kept. Nothing is inserted when
creation fails, and with the caret inside a callout, column, table or other container
the quiz, flashcards and mermaid commands do nothing. A reference that lands
nested (a paste) is lifted to the top level by the plugin's normalizer. Blocks
pasted while the caret is on a void block (a quiz, an image, an embed) go in
right after that block with the caret following them (`VoidBlockPastePlugin`
in `pastePlugins.ts`); Slate alone drops a fragment inserted into a void. Quiz
and set edits go to the item's own rooms, so note undo covers only inserting
and removing the reference (the question and card dialogs have their own Undo
and Redo). An agent or API write to an embedded item lands in its rooms, which
every open editor and reader holds, so nothing refetches: the `embed-changed`
broadcast of 2026-10-07 is gone (live-items). Go and the collaboration server reject inline `quiz`/`flashcards`
nodes in a note and references anywhere but the top level. A markdown fence
deserializes as a pending reference (`materialId: ''` plus the fence body in
`pending`), which never enters a note: the body holds the answer keys and the
note reaches every reader (live-items REVIEW5). A paste or a toolbar import
holding fences creates their rows first and then inserts the blocks naming
them where the paste or import ran (`notes/pendingRefs.ts`, the held place of
`holdInsertPlace`). Every fence is read by one parser,
`parseEmbeddedFence` (`materials/blocks.ts`), the agent's markdown included: a
quiz needs at least one question and a set needs cards each with a front and a
back (a pasted quiz's questions are checked too, `validateQuestions`). A fence
that does not read is left out with a warning toast naming the kind; one
whose create is refused is left out under the mutation's own error toast. The
slash commands' new empty quiz and one-blank-card set pass their drafts to
`insertEmbedded` without a fence. The
collaboration server refuses an update that writes `pending` or leaves a
reference without its material id or below the top level, the store check refuses one (logged with the room's name, so with the note), Go refuses a
note write holding one, and a stored note holding one is served by
neither: Go's reads refuse it and its room refuses to load; agent
markdown resolves its fences into rows before Go stores the note. Readable
Markdown and DOCX exports resolve references into study handouts and fail
explicitly if a required reference cannot be read. A reference belongs to its
note through the same children pass as media: a block whose `materialId` an
update wrote (paste, drop, undo, redo, a replayed draft) is answered per
block. Every block has its own quiz:
a quiz now in several blocks stays with one of them, the first the update did
not write or else the first in document order, and every other block asks for
a copy (`planChildren`). The note's own row keeps its id (leaving the trash
when it was in it), another note's quiz or set becomes this note's copy, one
per block, its images copied on the server, and a block whose original is
unreadable or purged (over a day in the trash) is dropped. In Edit the block
shows a skeleton while it names another note's material or one that does not
load yet, and reloads when `children-ready` names it.
Removing the reference trashes the row at the next save, hidden for a day (see
[authorization](../authorization-permissions-lifecycles.md)). Embedded quizzes
and sets are quick checks that record nothing (attempts, ratings; see
[study-progress](../study-progress.md)). Mermaid blocks
stay inline. Mermaid, chart and graph embeds render view-only in every editor
mode. A chart or graph's hover toolbar has Edit/Copy/Delete in edit mode; Edit
opens a dialog. Toolbar Copy (charts, graphs, Mermaid, HTML
blocks) fires a real copy event filled by `setFragmentData`, so the clipboard
holds `application/x-slate-fragment` like Cmd+C; `navigator.clipboard.write`
cannot carry that type and its paste inserted nothing. Unresized charts open at 28rem and graphs at their image width;
the chart preview sits on a page-coloured panel because its text uses page
colours. Shared pages still render them as plain figures (no frame).

Mermaid blocks keep mermaid.js and draw in one of five presets ported from
modern_mermaid (`mermaidPresets.ts`): Linear Light, Linear Dark, Brutalist,
Hand Drawn and Kawaii. Every block the editor inserts locally (toolbar,
slash command, paste, import, AI edit) and every new diagram material is
stamped with its creator's default theme, a per-user preference in the editor
settings (General tab, below Display size), so all viewers see the same
theme. Server-created diagrams (generate, agent tools) carry no `theme` and
draw in Linear Light until someone picks one. The block
stores its preset as optional `theme` on the `mermaid` node, and the diagram
sits on the preset's background with no border. `renderMermaid` queues renders,
because `mermaid.initialize` is global: each render sets its own preset, and
mermaid scopes the output CSS to the SVG id, so blocks in one note keep their
own themes. Frontmatter config would scope too, but mermaid's sanitizer blanks
font stacks containing hyphens. Hand Drawn gets per-diagram roughen filters
after rendering.

A diagram loads nothing from outside the page. Mermaid draws into a host that
is already in the document (it measures labels as it draws), so anything that
would fetch does so while it draws; `renderMermaid` therefore makes the source
inert before `mermaid.render`, not after (`mermaidSafety.ts`). It locks the
`strict` security level, HTML labels keep no fetching element or attribute (a
`dompurifyConfig` forbidding `img`, `image`, `source` and the like), and front
matter and `%%{init}%%` directives cannot turn `themeCSS`, a font stack or
those keys back on (mermaid's own `secure` list, extended). Over that, the
source drops what config cannot reach: a line naming a CSS image function
(`url(`, `image-set(`, read through HTML and CSS escapes, character and mermaid
entities, and across mermaid's directive cuts) is blanked keeping its line
number. That is any line containing `url(` or `image-set(`, so a label whose
text writes `url(` loses its line too ("the URL (a link)", with a space, is
kept). This filter, not the sanitiser, is what stops an inline `style` in a
label from fetching: labels keep their inline styles, since mermaid sanitises
its own icon SVGs (architecture icons) and math-label wrappers with the same
config. An image node's `img` or a sequence actor's icon is removed when
mermaid's own parse says the diagram draws an image. A diagram that needed a
removed part still draws, minus that part; one that still names or draws an
image across lines after the pass is refused. Links stay clickable (`click …
href`, Epo 2026-10-15): after `mermaid.render`, every `<a>` in the SVG gets
`target="_blank"` and `rel="noopener noreferrer"`, so the outside page opens in
a new tab and cannot reach the Capy tab; mermaid's strict mode already leaves
a `javascript:` target's anchor with no href. The one `renderMermaid` serves
every surface — chat, note blocks, mindmap and diagram files, shared-page
islands and the export rasteriser — so this covers them all. The app's
report-only image policy (deployment-runbook §2.4) is a backstop, not the fix.
Preset fonts (Excalifont, vendored Latin subset in
`src/assets/fonts`; Comic Neue from `@fontsource/comic-neue`) load through
`FontFace` before the render, since mermaid measures labels while drawing; a
failed font load draws in the fallback font. In edit mode the hover toolbar has
theme, caption, edit, copy and delete. A resized diagram stretches
past its natural width. The
caption is typed in a field under the diagram (at most 300 characters, a
`maxLength` with the x/cap counter beside it from 90%, the catalog's
`BLOCK_CAPTION_MAX`; a mindmap or diagram file's caption field is the same; by decision the servers
bound it only by the document's limits, like any note text, Epo 2026-10-14)
that rewrites the
`mermaid_caption` text with `voids: true`. The node stays void, so a DOM
selection inside it maps to the caption element; `fixMermaidSelection` moves
such points onto the caption text. The edit dialog shows source beside a live
preview in the block's theme (Tab indents by two spaces; deleting lives on the
toolbar) and edits the block live: there is no Save or Cancel, it closes with
its X or Esc, and its footer holds Undo, Redo (CodeMirror's own history; the
note's Undo does not cover the dialog's typing) and the note's save status.
An edit (typing, paste, Undo) that would take the source past the HTML embed
source's 64 KB (UTF-8) is refused with that bound's message ("The snippet is
over 64 KB."; `byteBound`), while other peers' edits and shrinking edits always
land; these bounds are the browser's only.
The source is a trimmed CodeMirror 6 (`MermaidCodeEditor.tsx`: state,
view and history only, ~78 KB gzipped, loaded with the dialog or the editor,
ligatures off) with line numbers; the line mermaid blames gets a tinted
background, a wavy underline and a red number, while the preview keeps the last
diagram that parsed. A live source redraws once typing settles for 250 ms
(`MERMAID_TYPING_DELAY_MS`: the note block, its dialog and a live View's
block; the first draw is at once), and a queued render whose source changed
before its turn is skipped, so only the latest text draws. `mermaidFailure` reads that line out of the parser message
(blank lines trimmed off the top added back, an end-of-source error clamped onto
the last line); a failure with no line says "This diagram could not be drawn".
Wherever a diagram is only read (View, note blocks, shared pages) a failure
shows `MermaidError`: "Syntax error on line N", then the source with that line
marked the same way.

A Mermaid block's source is a strings-only Y.Text held as the `source`
attribute of the `mermaid` element's Y.XmlText (shape A, Epo 2026-10-10), so
two people typing in one source merge per character (9.5 B per keystroke
against about 400 for a rewritten string). Nothing outside Yjs changes:
Slate, the projection, Go, markdown, exports and share pages keep `source`
a string. `@slate-yjs/core` 1.0.2 is patched for it
(`patches/@slate-yjs__core@1.0.2.patch`, registered in `pnpm-workspace.yaml`):
Slate reads the attribute as its string, a remote edit of the text becomes one
`set_node` of `source`, a local `set_node` of `source` edits the text with the
fewest changes, and an insert or a clone (a move) creates the text. The
editors bind CodeMirror to the text itself (`yTextCodeMirror.ts`: local
changes go in under the binding's origin, remote ones come back as one
CodeMirror transaction kept out of its history); the note block's dialog finds
it by the block's path, top-level or nested (`mermaidSourceText`). A source a room still holds as a
string (written before shape A) becomes a text when an editor first binds it,
outside every Undo. The Rust server bootstraps sources as texts, reads them as
their strings in the projection and the metrics, bounds a string typed into
one by its escaped bytes (no copy of the room per keystroke), and writes an
agent's `set_mermaid` (`set_property` of `source`) as a text diff, so typing
that reaches the room meanwhile stays. Its admit lets a text in as `source`
on a `mermaid` block only, with strings and nothing else inside
(`collaboration-rs/crates/notes/src/limits.rs`): a text under another key or
on another element, a block retyped while it holds one, and a format, embed,
nested type or attribute inside a source are refused.

A chart's, plot's or graph's `block` is a live map in rooms (Epo 2026-10-17;
the catalog's `sharedMap` and `sharedLists`, openwiki
[embeds](../embeds.md#live-figures)): a Y.Map whose entries are its fields,
each replaced whole, with a chart's or plot's `series` and a graph's
`elements` as Y.Arrays of Y.Maps, one per series or element. Two editors'
changes to different fields, series or graph elements merge; the same field
takes the last writer. Slate holds the plain block. The same slate-yjs patch
reads the map as its value, turns a remote change anywhere inside it into one
`set_node` of the whole `block` on the owning element (once per
transaction), edits the map with the fewest writes on a local `set_node`
(changed entries only, series by index, graph elements by their `id`), and
makes the map on inserts and clones. Undo is the room's Yjs undo manager, as
for any edit (`figureMap.test.ts`). The note's figure (`VisualBlockElement`)
re-renders on a peer's change and draws the block repaired
(`repairFigureBlock`); its Edit opens `VisualBlockDialog` from the block
itself, so the dialog's draft follows the live block: a peer's change rebases
the draft field by field (`rebaseBlock`: the user's changed fields, series
and elements keep the user's value, the rest follow the peer; the graph
editor's rows follow the rebased elements, keeping a row still being typed),
and Save writes the user's changes onto the block as it is then, so a peer's
change that landed meanwhile stays. No merge is refused (Epo 2026-10-18):
readers draw it repaired, a chart or plot left without series as an empty
frame and a pie without a positive value through the chart's empty state. The
editors show a merge's raw block with its issues: a chart's rows past its
labels and series past the cap, a pie's other series (Remove last series
shows for it), its negative or missing positive value, no series (Add series
shows even on a pie), and a graph's rows past the cap or naming a gone point,
each marked, Save held until they are fixed. A graph's SVG is drawn on Save; an editor in Edit mode that
sees a graph's recipe change (elements, board, size) redraws it in an idle
callback (`graphRedraw.ts`) and writes `image`, outside Undo, only when the
SVG differs, so its own write never redraws again; readers keep the stored
SVG. The Rust server writes the same maps on bootstrap and an agent's insert
and reads them in one place (`plate::map_value`, behind
`plate::block_value`); room admission takes a block as its map only and
refuses a crafted update that puts an unknown key, a wrong type, an oversize
value or another shape into one (`figure_map.rs`; where the relaxed check for
a merge's kept states runs: [embeds](../embeds.md#live-figures)).

Standalone mindmaps and diagrams render without Plate. View
(`MermaidMaterialView`) draws the block's `MermaidView` straight from the
material content, looking as the static renderer did. Edit
(`MermaidMaterialEditor`, no Plate) joins the material's room through
`useItemRoom` (the note document's `content` root, read by `liveMermaid.ts`)
and edits its one block live: a bar with the theme dropdown and, at its
right, Undo and Redo of this user's own edits (the room's Undo manager, which
CodeMirror's Undo keys use too), then source and preview side by side, the
caption bound under the preview; there is no Save or Cancel, the cloud status
follows the title, and editing ends through the View/Edit switch, which hands
the live block to View first. Unsent edits stay on this device like a set's
(offline banner, recovery to copy). On phones one shows at a time behind a
Preview/Code toggle in the bar. Clicking any diagram preview opens `MermaidPreview`, the
same full-screen viewer images use, titled with the material; a diagram that
has not drawn (a syntax error) opens nothing, in View, note blocks and Edit.

Chart, plot and graph nodes store their question block under `block` (a live
map in rooms, above), an optional `width`, and a single empty text child;
graphs export their SVG before saving.
A figure's description shows under it as a muted caption (`MEDIA_CAPTION_CLASS`)
and is the figure's accessible label: optional on every figure, images and
graphs included (Epo 2026-10-14; a blank one is dropped on Save; the chart
and plot editors' Description field; the agent contract does not offer it for
charts and plots), at most `QUESTION_DESCRIPTION_MAX` outside the bank.
Their Markdown fences (` ```chart `, ` ```plot `, ` ```graph `) hold that block's
JSON (`customBlockNode` in `blocks/shared.ts`, checked by the shared question block
schema, so a refused block fails the agent's write); the agent's note format
(`noteMarkdownDescription`) documents the chart and plot fences. A plot (see
[question-bank](../question-bank.md#editing-and-assets)), drawn as curves or, with
`kind: "scatter"`, as dots, comes from the agent, a pasted fence or the Plot
command (slash menu and all-blocks menu, beside Chart and Graph), which opens
the figure dialog on a line through (0, 0) and (1, 1) and inserts the block
on Save, as Chart and Graph do (Epo 2026-10-17); its hover toolbar has Edit,
Copy and Delete like a chart's, Edit opening the plot editor in the figure
dialog (`VisualBlockDialog`), and exports draw it like a chart with its points
as the table. Inline
and display equations use MathLive in both viewing and editing, including question-editing previews. The math toolbar inserts formulas and common symbol templates.

## Interactive HTML blocks

`html_embed {id, html, caption?}` is a top-level void with one empty text leaf,
shaped like chart and graph (a nested one is lifted by the plugin's
normalizer). The agent writes it as an ` ```html-embed ` fence with YAML
`caption` and `html` and no fallback (`blocks/shared.ts`, `markdown.ts`); the
collaboration service's converter builds the same node, reading the agent's
note as plain Markdown so the snippet keeps every character (the MDX pass a
paste goes through rewrites HTML inside fences; see `markdownImport.ts`). A
fence that is not YAML, has no html, has html over 64 KB, or is the eleventh
is refused by name, as is an agent edit that would leave the note with an
eleventh (`invalid_input`, the collaboration service's whole-note check). Go
`materialdoc`, the collaboration validator and the browser's
`isMaterialDocument` cap `html` at 64 KB (UTF-8 bytes), `caption` at
`BLOCK_CAPTION_MAX` (300 characters; Go `materialdoc`, the collaboration
store and room admission) and a document at 10 such blocks, and refuse any
other field. Retrieval skips the block like
mermaid. There is no insert command; people edit the snippet through the
source dialog.

`HtmlEmbed.tsx` renders it in `MediaFrame` (mock A of
`artifacts/2026-10-04-interactive-blocks.html`, since stripped to a frame
with no border, radius or label): the caption as muted text under the
frame, and a hover toolbar with View source, Copy
and Delete in the editor and View source only in view mode. View source opens
`HtmlEmbedSourceDialog`, titled Source: editors change the caption (at most
300 characters, a silent `maxLength`) and snippet and Save within the 64 KB
cap; read-only users only read it. The snippet runs only in
`<iframe sandbox="allow-scripts">` at `VITE_EMBED_ORIGIN/`, the
wrapper page in `embed/` on its own site (see
[deployment-runbook.md](../deployment-runbook.md)); without that origin the
block shows a notice instead of a frame. On the frame's first load the host
posts `{type: 'render', html, theme, font}` with target `*` (the frame's
origin is opaque), where `theme` holds `--bg`, `--fg`, `--muted`, `--accent`,
`--border` and `--font` (the style's `--font-sans`) read from the app's
tokens plus `--scheme` (the app's computed `color-scheme`), and `font` is the
app's cached Fustat latin woff2, which the frame registers with `FontFace`
because its CSP allows fonts only from the four CDNs below. Before the snippet the wrapper
applies a base sheet: `color-scheme: var(--scheme)` (a scheme differing from
the page would paint the frame opaque), `accent-color: var(--accent)`, and a
body with no margin, `16px/1.5 var(--font)` in `--fg` on a transparent
background, with form controls inheriting the font, range inputs without side
margins and `svg`/`canvas` in `border-box` (a `width:100%` slider or bordered
figure otherwise came out 2 to 4 px wider than the frame and scrolled); the snippet's own CSS
overrides it. The agent guidance names the variables and the base. The
frame's CSP (`embed/_headers`) lets a snippet load scripts, stylesheets and
fonts from `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`,
`https://esm.sh` and `https://unpkg.com` and make no other request (no
fetch, network images, frames or workers); the agent guidance names the four
CDNs and asks for exact versions, and the playground's `check_note` refuses any
other origin (SECURITY.md path 11). The share
page hydrates the same `HtmlEmbedView` island without View source (visitors
read the block, they don't need its source) and
loads the same Fustat file, so it renders identically. The host accepts only `{type: 'resize', height}`
from that iframe's own window with a finite height, clamped to 32 to 600 px;
a taller snippet scrolls inside the frame. The wrapper reports its height right
after writing the snippet, on `load` and once fonts are ready, besides a
`ResizeObserver`: Chrome runs no observers in an off-screen cross-origin frame,
so without the eager reports a frame further down kept its 240 px default until
scrolled to. The height is the document's without a vertical scrollbar (read
with `overflow-y: hidden` for that moment, and again whenever the host resizes
the frame: a scrollbar shown while the frame was still short narrows the
snippet, and one that is taller at that width kept the bar with nothing to
scroll), plus the horizontal scrollbar's height when content wider than the
frame has one, so wide content scrolls only sideways. The
wrapper writes the snippet over itself, which fires a second `load`; a later
`load` means the snippet navigated its frame (to a page without the
wrapper's CSP), so the frame is replaced by a notice until the snippet
changes. A theme change or a new snippet reloads the frame. Every frame
loads with the note and stays loaded (at most 10 per note), so none vanishes,
reloads or resizes while the reader scrolls. A chat answer's interactive
(`ChatHtmlEmbed`) uses the same frame and also loads with the answer. Opening a note with `?block=<id>`
scrolls that block into view once per page load. Exports never run the
snippet (see Readable note exports).

## Note imports

The toolbar's Import (Markdown, JSON or DOCX, `importFile` in
`toolbar/NoteToolbar.tsx`) converts the file in the browser and inserts the
document where the import ran, not where the caret is when the conversion
finishes (`holdInsertPlace(editor, { atCaret: true })`). If nothing has touched
the lines the import's selection spans meanwhile, the document goes in at the
remembered selection, replacing it and splitting the line exactly as an insert
at the selection does; otherwise it goes after the last of those lines and
deletes nothing, so text typed into them while the file was read stays. It
takes the caret only if the caret has not moved.

Every markdown import (a paste of text, the toolbar's Import, an agent's note)
runs the same rules (`noteMarkdownPlugin`, `markdown.ts`). Footnotes become
text, as no block draws them (Epo 2026-10-14): a reference `[^1]` is its label
in superscript where it stood, and a definition `[^1]: …` its paragraphs, the
first led by the same superscript label. A ```` ```flashcards ```` fence carries
fronts and backs only: a card `image` in one names another document's asset,
which nothing can upload, so it is dropped, as an image without an asset of
this document becomes an upload or a link everywhere else. Card images travel
by copying the set's block, which copies the set with its images.

## Readable note exports

`documentAdapters.ts` snapshots the live editor, resolves quiz/card projections
through existing authenticated queries, and obtains asset URLs. `export/client.ts`
starts a dedicated module worker for each Markdown or DOCX export. The worker
flattens quizzes into questions followed by answers, marking schemes and worked
solutions, and flashcards into front/back pairs. It serializes the complete
snapshot, downloads assets, normalizes raster images with OffscreenCanvas, and
creates the DOCX or ZIP. No conversion endpoint or server job is involved.

DOM-dependent figures are requested sequentially from the main thread and cached
per export. KaTeX generates markup in the worker; the main thread lays it out and
rasterizes it. Charts include a visible legend and data table. Mermaid renders
through `renderMermaid` in the default theme; exports drop the block theme. Figure rasterization uses an isolated iframe so html2canvas
does not clone the mounted editor. Completion, failure or editor unmount terminates
the worker; duplicate clicks are disabled, and errors appear as a toast.

Markdown uses standard headings, nested lists, links and tables, with labeled
quotes for callouts, sequential columns, LaTeX math and captioned Mermaid fences.
Rich/merged tables use HTML. Images and audio produce a ZIP containing
`document.md` and relative `assets/`; text-only exports remain `.md`.
DOCX uses blue info callouts, grey quote/divider borders, plain answer keys, images
for formulas/diagrams, and borderless tables for columns. Private audio links
return to the note in view mode rather than retaining expiring signed URLs.
Each DOCX outline becomes a native Word TOC field covering heading levels 1–6,
with indented TOC styles, dot leaders and page-number fields. Cached entries retain
the outline before a viewer updates fields; no page numbers are invented in the
browser. The document requests field updates on opening. Word calculates pages,
and its Update Table command refreshes renamed/new headings. Other viewers may
require a manual update. Answer/solution labels use keep-with-next paragraphs,
not heading styles, so they do not enter the TOC. Markdown retains heading links.
Unknown blocks and failed required asset reads stop the export instead of silently
omitting content. Readable exports do not round-trip interactive study blocks.

An interactive HTML block exports in Markdown and DOCX as the link
`[Interactive snippet](<note URL>&block=<id>)`, the note's view-mode URL with
the block id, and never reaches the figure rasteriser.

YouTube becomes a labeled watch link in Markdown. DOCX embeds a poster with a play
button, picture/title hyperlinks and Office's `wp15:webVideoPr` metadata, plus Word
2013 compatibility mode. Desktop Word recognizes a native web-video object; other
viewers may display the linked poster. The video remains online. No raw URL or
internet-requirement caption is printed. Word for the web playback is not verified.

Coverage and large-document measurements: `export/export.test.ts`,
`e2e/editor/exports.spec.ts`, and
`bench/editor/reports/2026-09-27-client-export-implementation.md`.

## Persistence and save status

Room sync means only that the browser and in-memory server converged. It does
not mean PostgreSQL durably stored the state.

The editor reports:

- `Connecting…`: the first handshake (the note body waits for it);
- `Reconnecting…`: a later drop while the browser is online; the editor stays
  mounted and editable;
- `Syncing…`: edits waiting for the checkpoint debounce or durable acknowledgment;
- `Synced`: the initial room sync completed with no local work pending;
- `Saved`: the server confirmed that a state containing this client's work was
  committed;
- `Offline`: the room cannot be reached (the browser is offline, or
  reconnecting kept failing for 30 s); an editor that synced once keeps
  editing on this device (see [Offline editing](#offline-editing-and-drafts));
- `Not saved. Retrying…`: a store failed and the server is retrying it;
- `Collaboration unavailable`: the first connection never synced, or the
  provider could not start.

The header shows these as Hugeicons cloud icons beside the title: Sync for
Connecting, Reconnecting and Syncing, SavingDone01 for Synced, Check for Saved,
Off for Offline, and a red Alert for Not saved and Collaboration unavailable.
Office and text sources report the same states into the same slot
(`EditorStatusContext`, `sourceHeaderStatus`). Localized labels remain in
keyboard-accessible tooltips and the live status text for screen readers.
Pending work preserves Connecting, Offline and error indicators. An older
checkpoint acknowledgment cannot report Saved while newer edits are debouncing.

### Connection lifetime and refusals

Room tokens live five minutes. A minute before expiry the server asks the
channel for a fresh token in band (`TOKEN_REQUEST`); the provider answers
through its `token` function (`TOKEN`), and the server verifies it, rechecks
access and re-arms both timers. A channel that cannot answer is closed at
expiry with code 4401. A room closed on an open
socket (expiry, eviction, an access recheck) only emits the provider's `close`,
never `disconnect`, so `roomReconnector` (`src/features/notes/roomConnection.ts`)
reconnects at once with a fresh token and backs off while refusals repeat.
Authentication refusals carry reasons: `collaboration-read-only` drops to view
under the read-only strip (it names no reason: a demoted viewer, a frozen
account and a full owner all see it, and the account banner explains the
account cases), `collaboration-not-found` (trashed or deleted) and
`collaboration-forbidden` (lost access) replace the editor with the
file-missing or no-access panel, `collaboration-outdated` stops the editor
for the page load (see [Client protocol](#client-protocol-and-the-release-nudge)),
and anything else (an expired token, a room being reset or compacted) is
retried. A loss still unresolved after 30 s while
online puts an editor that synced once into offline mode (before the first
sync it turns the status red). A failed first token request shows the panel for its status (not found,
no access, or unavailable with Retry). A member removed from the workspace gets
the server's hidden `404`, so their editor shows the file-missing panel, not
no access: by decision (Epo, 2026-10-14) the app never tells a user whether
something they can't reach is blocked or gone.

A transient store failure broadcasts `checkpoint-failed`; the editor keeps its
pending receipts (the failed-store retry answers them), shows Not saved and,
with unsaved work, the `delayed` save banner until a receipt covers every
change. The banner also shows when a checkpoint request stays unanswered for
`NOTE_SAVE_DELAY_MS` (25 s) of connected time (see
[error handling](error-handling.md#collaborative-source-failures)).

On a value change, edit mode debounces a `checkpoint-request` stateless message
carrying a random receipt ID. The room keeps its outstanding IDs in
memory, claims them before it reads the document, and after binary persistence
commits broadcasts `checkpoint-persisted` with those IDs, the stored version, and
the current document metrics. IDs that arrived while that store ran are
answered with it too when no writer's update followed its snapshot (no
contributor marker is left): their edits are in it, and nothing would schedule
another store for them. Otherwise the store that update scheduled claims them.
Only that receipt changes the browser status to
Saved. Receipts stay out of the Y.Doc deliberately: a marker written into the
document would be an edit, so acknowledging it would dirty the room and force a
second store and projection for every save. A request that finds nothing
waiting to be saved (no store debounced or running, no failed snapshot, no
writer's update newer than the last store: `nothingToStore`) is answered at
once without metrics, since a store runs only after a change: a request
arriving after the store that already held its edits (one the 10 s max
debounce forced while the request was on its way) would otherwise wait for an
unrelated later change. A writer's sync always writes a contributor marker,
which schedules a store, so a reopened note's request is answered by that
store. Failed stores are retried per
room with backoff (5 s, then doubling to 60 s). A source room's live saves
wait out the same backoff, so a state that keeps timing out in the Office
engine pool is tried once per step instead of on every debounce. The room
retries through its own store path (its debounce and one store at a time), so
a retry never races the live save, which holds everything the failed snapshot
did and answers its pending receipts. A room with a failed store stays loaded
until a store succeeds or the room is discarded.

`mod+s` stays bound so the browser's own save dialog never opens; it flushes the
debounce through the same path rather than running a second one. A client tracks
every outstanding receipt, so editing again before the service answers cannot
orphan an earlier request.

The old REST content autosave, local revision refs, full-document replacement,
draft unload warning, and five-second PATCH debounce do not exist. Public
`PATCH /api/materials/{id}/metadata` updates metadata only. Quiz and
flashcard content has no REST write either: live item rooms are its only
writers. Relational metadata and standalone sharing use separate endpoints so a
privacy or metadata failure cannot be reported as though it rolled back an
already-durable Yjs command.

### Client protocol and the release nudge

Developer Epo decided the gate and the nudge on 2026-10-16 (the version-gate
design, option d), and the nudge's release file on 2026-10-17.

- **The gate.** Every JOIN carries the build's client protocol after the
  token (`room, token, varuint protocol`), and every draft send carries it as
  `X-Capy-Protocol`. The number is `CLIENT_PROTOCOL` in
  `src/features/collaboration/protocol.ts` and
  `collaboration-rs/crates/server/src/protocol.rs`; a vitest keeps them equal.
  - The server keeps one minimum per room family:
    - material rooms (`material:`, `keys:`: notes, mindmaps, diagrams,
      quizzes, quiz keys, flashcard sets): `MIN_MATERIAL`;
    - source rooms (`source:`: Office and text): `MIN_SOURCE`.
  - `socket::authenticate` checks it right after parsing the room name,
    before any lookup. A client below its family's minimum, or above the
    server's own protocol (a newer tab after a rollback), is refused as
    `collaboration-outdated`. A client from before the gate sends none, read
    as 0.
  - A draft send answers `426 {"class":"outdated"}`.
  - Each refusal is logged at warn, never reported, and counted in
    `capy_collaboration_outdated_refusals_total{family}`: how many stale tabs
    remain after a deploy.
- **A refused editor** stops for the page load and turns read-only:
  - notes reuse the `offline-limit` machinery (content `readOnly`, toolbar
    inert, no palette or AI menu, `canEdit` off);
  - item editors show their list or diagram read-only;
  - a source keeps its view, with Office `set-capabilities` turning editing
    off.

  The one-row `outdated` save strip reads "Capy was updated. Reload to keep
  editing. Your edits are saved on this device and will sync after you
  reload.", with Reload in the close button's place. When this device could
  not store the unsent edits (`outdated-unstored`), it says so instead: "This
  device couldn't store your unsent edits, so reloading loses them." The
  header status is Collaboration unavailable, as in recovery. An item room or
  source session
  refused before it synced shows the strip alone (a source shows its base
  and this device's drafts, read-only).
- **Its drafts stay.** Nothing is discarded, refused or marked. The reloaded
  page applies them before it joins (or the sweep sends them), so they go
  through the new version's checks as offline edits do; a refusal there
  gives the usual refused draft. A source whose edits this device stored no
  longer counts as unsaved, so Reload brings no "Leave site?" prompt (a
  source or item editor whose storage failed still asks).
- **The next page change loads the new app**: any refused room (an editor's
  or a reader's) marks the update available, as the nudge below does. Drafts made by a refused client never carry
  normalization damage: it never synced the new content.
- **Readers** (the live View, study pages) are gated too: a refused read
  room stops and keeps what it painted (the stored copy or the last live
  value), with no strip. The nudge reloads the page later.
- **Reload waits for the new app.** It reads the release file below and
  compares it with the tab's `VITE_RELEASE_SHA` (`reloadIntoNewRelease`,
  `src/lib/appRelease.ts`):
  - another release reloads the page;
  - the same release, or a failed check, changes the strip to "The update is
    still being published. Try again in a minute." The new SPA is served
    about 2 to 3 minutes after the new collaboration server starts refusing.
- **The draft sweep** sends `X-Capy-Protocol`. An `outdated` answer stops
  sweeps for the page load, marks no row and marks the update available.
- **The release nudge.** The client build writes its `VITE_RELEASE_SHA` (the
  same value as the HTML's `capy-release` meta) to `/release.txt`
  (`vite.config.ts`); `public/_headers` serves it `no-store`, and it is a
  static asset, so the SPA fallback never answers it on a deploy. Local dev
  and MSW have no release file and read nothing.
  - When the tab becomes visible or regains focus, at most once a minute, it
    fetches `/release.txt` with `cache: 'no-store'` (`checkReleaseOnFocus`).
    Only a full revision counts: a 404, the SPA fallback's HTML or a failed
    fetch change nothing.
  - When it differs from `VITE_RELEASE_SHA`, the next path change becomes a
    full page load, with nothing shown. A `?file=` or other search change
    stays in the page, so a streaming chat turn is not cut. While offline the
    page stays (a load would land on the browser's offline page); the first
    path change back online loads.
  - It loads once per served release per tab (sessionStorage
    `capy-update-load`), so a stale edge cannot loop it.
  - The site's file is the source, not the gateway: the gateway goes live
    minutes before the new SPA. Deployed `/api/*` bypasses the site Worker,
    so a header on API responses could not carry it. The offline round's
    service-worker update check replaces this read when it lands.
- **Rollout.** Refusal starts when the new collaboration server starts. The
  first rollout set `CLIENT_PROTOCOL` and both minimums to 1, so tabs from
  before the gate show Offline until reloaded, with their edits kept. The
  embeds round's live figure maps (a slate-yjs patch change, Epo 2026-10-17)
  raised `CLIENT_PROTOCOL` to 4 and `MIN_MATERIAL` to 4; `MIN_SOURCE` stays 3.

#### When to bump

A change that breaks family F raises `CLIENT_PROTOCOL` to N+1 and sets F's
minimum to N+1 in the same commit. The other family keeps its minimum, so its
editors are untouched. The deploy request names the bump ("client protocol:
material 3 → 4"); the [deployment runbook](../deployment-runbook.md) has the
deploy order.

- **Must bump**, because the damage is otherwise silent or hits co-editors:
  - any capy-sync framing or message change, or a stateless message the
    client acts on (both families);
  - a new element type an older editor would normalize or misplace: any new
    inline type, a void/inline change, a new shared-text key, a slate-yjs
    patch change, an id-plugin change. An older Slate editor unwraps an
    inline element it does not know as soon as it syncs, and admission takes
    that as an ordinary edit;
  - a changed meaning of an existing key or value;
  - a rule the store applies but admission does not;
  - item document shapes an older item editor would rewrite;
  - every BetterOffice pin bump and every `OFFICE_PROTOCOL_VERSION` bump,
    which raise the source family's minimum (office-files "Pin bump
    checklist").
- **Should bump**, because it is otherwise loud but confusing: removing a
  type, key or value an older client can still write; a policy enforced only
  in the client.
- **No bump:** optional data older editors carry through untouched,
  server-only changes, read paths, REST.

## Offline editing and drafts

An editor that can edit keeps editing while its room cannot be reached: the
browser went offline, or reconnecting failed for 30 s. Its header shows
Offline and the `offline` save banner reads "Can't connect to Capy. Your edits
are saved on this device and will sync when you reconnect. They may be
rejected or lost." until the room syncs again. Readers (Note View, study
pages) hold no edits and keep what they painted; opening the app offline is not
supported.

Unsaved work lives in IndexedDB (`src/lib/editDrafts.ts`, database
`capy-edit-drafts`, shared with Office and text sources), written by a
dedicated drafts worker (`src/lib/draftStore.ts`, `draftStore.worker.ts`): the
editor's main thread only posts rows and does no storage work. The decision
(2026-10-06) takes whichever measures faster on the main thread. Typing in one
editor session at CPU x4 with the path switched between interleaved blocks
(same build and document), the main-thread draft code per local edit was, for
the worker against an IndexedDB put on the main thread: small note 0.30 against
1.52 ms, near-limit note 0.44 against 1.12 ms, gradebook XLSX 0.38 against
1.40 ms, small DOCX 0.19 against 0.61 ms, 62-page DOCX 0.45 against 0.75 ms
(the main-thread figure leaves out the browser's own IndexedDB dispatch, so it
is a lower bound). Unthrottled in a bare page: 0.06–0.09 against 0.27–0.34 ms;
an OPFS log behind the worker measured the same as IndexedDB behind it, since
the main thread pays only the message. An earlier in-app run that put the
main-thread path at 0.09–0.11 ms counted only its synchronous call into the
store, not the transaction work queued after it; whole-task deltas between
blocks swing by more than the typing itself (±10–250 ms per key) and decide
nothing. The worker runs requests in the order they were posted, so a
read sees every write posted before it and a receipt's delete lands after the
updates it covers. Drafts come before the device copies of opened source
files in the storage quota (Epo 2026-10-17): a request the quota refuses
(`QuotaExceededError`) deletes the least recently opened copy
(`evictOldestSource`, [office-files](office-files.md)) and runs again, one
copy at a time, until it lands; with no copy left it fails as any storage
failure does. Each editor mount is a session; each of its local Yjs
updates (origin neither the room provider nor a restore) is one `update` row,
posted as it happens; every 64 of a session's rows are merged into the run's
last one (reopening 10k one-edit rows took over a second, 50k 39 s: one
`Y.mergeUpdates` over thousands of updates is quadratic, so `applyDrafts` also
merges in runs of 64). The whole document is one `state` row written once
per offline episode, at unmount and at `pagehide` with unsaved work, and after
a failed write: the base later updates need when they open in recovery
(encoding a near-limit note takes 30–80 ms, too slow for every edit). A
killed tab keeps every update it posted; one killed or crashed while online
leaves no `state` row, so its rows draw only over their own room. While
storage keeps failing (a full disk, a database another tab blocks) the whole
document is retried at once and then at most every 5 s (2026-10-07), not on
every key, and only while something is unsaved. A worker that throws loses what it had not answered: every
session is told (the next write holds the whole document) and the next request
starts a new worker; one that never started fails every request for the page
load. A database open another tab blocks fails the requests behind it at once
(the editor shows it cannot save on this device) until it goes through. Each row carries its
lineage, the room name the token named (`material:<id>:schema:<n>`). Rows are
deleted only by checkpoint receipts: each request records the session's edit
count, and a receipt deletes the session's update rows it covers (it also
answers earlier requests it covers, such as one sent while offline). The room's
sync alone never deletes them. A receipt deletes only its own session's rows
and the exact rows it adopted, so another tab's newer write survives. A
sweep's send from a page without the editor open deletes exactly the rows it
sent, once the service answers (see
[Sending drafts](#sending-drafts-without-the-editor-open)).

On reconnect the provider's normal sync sends the unsent updates. After
JOINED the server sends its step 1, the client sends its own, and the room
handles a channel's messages in order, so the step 2 carrying them lands
before any request sent at `synced`. That holds only from `synced`: a
request sent once the socket authenticated can be stored ahead of the step 2,
and its receipt would claim edits the server never saved. Notes and sources
therefore send checkpoint requests only while the room is synced
(`sendCheckpointRequest` in `roomConnection.ts`); one made before waits, and
the sync sends it. On the
next open of the note `NoteEditor` reads its rows beside the token: rows of
the token's room are applied before the room connects (updates whose base is
missing stay pending until the sync brings it) and saved like any edit; rows
of another room, and refused rows, open read-only in copy-only recovery
(`NoteRecovery`: the static renderer under a `changed` or `refused` banner
whose Reload deletes them, one group at a time). A group with no `state` row
cannot be drawn (a tab closed online, then the room moved): it is dropped
with "Some unsaved edits from your last session couldn't be restored."

While offline a session may hold up to `maxContentBytes` (2 MiB) of unsaved
local updates; past that the editor turns read-only under the `offline-limit`
banner until it reconnects: the content is `readOnly` (block actions follow
Plate's read-only state), the toolbar is inert, the command palette, AI menu
and floating toolbar are not mounted, `canEdit` is off for the rest, and the
recorder stores nothing more. What was stored stays; nothing reaches the
editor through REST-backed dialogs offline anyway. When storage fails
(private mode, a full disk) editing continues in memory under the
`offline-unstored` banner; after a failed write the next one holds the whole
document, and the banner goes back to `offline` only once that lands. `navigator.storage.persist()` is asked once, at the
first row written while offline, except on Firefox, which prompts. Safari
deletes script storage of a site not visited for 7 days, and private windows
delete it on close. Rows of a note the account no longer has go on a 404, or a 403
for the note itself (token, refusal), and in the draft load sweep (below),
once per page load, which asks each stored document's token endpoint. A 403 about the account itself
(`account_suspended`, `account_deletion_pending`: `isAccountForbiddenError`)
keeps them, and so does the collaboration service's forbidden reason alone,
which an account lock gives too; the sweep settles that case
(`refusalDropsDrafts`).

The lineage moves whenever the server throws away room state a client may
hold (see below), so stored or in-memory edits from another lineage are never
merged into a live note.

A group of another lineage entering recovery (once: its rows keep a
`reported` mark), a group dropped as unrestorable, drafts deleted after a 403
or 404, edits a read-only reconnect discards, a failing draft write, the
save-delay warning and each offline episode (after the reconnect) are
reported as editing incidents; the service records its discards, refusals and
lineage moves itself (see
[observability](../observability-metering.md#editing-incidents)).

### Sending drafts without the editor open

Rows left behind (a room or save error, a closed tab, offline) go to their
room from any open Capy page, not only when the file opens again (Epo
2026-10-13). The sweep (`startDraftSweeps` and `sweepDrafts` in
`editDrafts.ts`) runs when the page is idle after load (the load sweep),
when the browser comes back online and when the tab becomes visible; there
is no service worker or Background Sync yet (it comes with opening offline).
The drafts worker starts at app start, while the page is online, since one
that cannot load fails every request for the page load. One sweep runs at a
time per browser (the Web Lock `capy-drafts-sweep`; a trigger that finds it
held does nothing), and it skips every document an editor holds: a recorder
holds `capy-drafts:<key>` (shared) while it records. Without Web Locks
nothing is sent, and the mock service (MSW) has no endpoint to send to. A
sweep stops when the page signs in as someone else.

For each other document of the signed-in account the sweep asks the token
endpoint the editor uses (a file's `POST /files/<id>/collaboration-token`
too). A 403 or 404 deletes the rows (above) in the load sweep only, once per
page load; a later sweep that meets one leaves it for the next load. A read
token sends nothing. A quiz's keys
(stored as `<actor>:material:<id>:keys`) follow the quiz's own token, then
go with the keys token (`{ document: 'keys' }`, room `keys:<id>:schema:<n>`);
flashcard sets and a quiz's content go as notes do. With a write token the
sweep takes the rows of the token's room that are neither refused nor
`held` (left for the editor, below), one group per lineage (an Office file's rows of another base
apart). The drafts worker merges each group (`merged`: the page's main
thread pays about 4 ms for a 20 MB Office state, against 160-192 ms with a
132-158 ms task when it merged there), and the page POSTs it to the
collaboration service's `/drafts` on the host of the token's URL, the same
URL for every document (so one preflight, kept 2 h, covers a sweep):
`Authorization: Bearer <token>`, `X-Capy-Room: <room>`, `X-Capy-Base: <sha>`
for a source, `X-Capy-Protocol: <client protocol>`, the update as the body
(`collaboration-rs/crates/server/src/drafts.rs`). A note group past the
4 MiB sync cap is not uploaded.

The service runs a channel's JOIN checks (origin, token, access, the room's
eviction and pause state), refuses a read-only token, checks the note's
current schema, reads the body within a writer's sync message cap (4 MiB for
a note, the frame cap for a source), checks the eviction lease and a local
reset again (the body may have arrived after them), and hands the update to
the room, loading it if need be: the same writer admission and apply as a
channel's update (`admit_update` in `room.rs`, a read token's draft as a
read channel's), so open editors receive it live, then a store at once. A
source send counts as joining its room meanwhile. It answers only after that
store, and that answer is the receipt for every row the request carried:
only then are the rows deleted. A source room takes no send during a
publication handoff, and an Office file's only over the room's base. A room
whose load failed answers the failure (one load per send). A successful send
is silent: the edits just appear for everyone.

A refusal answers its class alone (`{"class": ...}`); the service logs the
detail with the room and counts it by class
(`capy_collaboration_draft_refusals_total`). Nothing is retried in a loop:

- `limit` (422, over a content limit or a source's state cap) and
  `malformed` (400, not an update a writer may send): the group is marked
  `refused` and opens read-only at the next open, as the editor's own
  refusals do, when it draws on its own (the worker's `draws`); otherwise it
  is marked `held`, left for the editor's next open, where the room
  refuses it again and the editor keeps the whole document as its refused
  row; neither is sent again, so the room records the over-limit incident
  once per open, not per page load;
- `unheld` (409, the room lacks the update's base), `too_large` (413) and
  `lineage` (409, a token for another room, a schema or epoch that moved on,
  another Office base): marked `held`, left for the editor;
- `outdated` (426, the page's client protocol is refused): kept unmarked,
  and no sweep runs again until the page reloads (see
  [Client protocol](#client-protocol-and-the-release-nudge));
- `permission` (403), `unavailable` (503) and any other answer: kept, and
  not sent again until the next page load;
- no answer (offline) or rows that changed meanwhile: kept for the next
  trigger.

`held` is the sweep's own mark: a held group that enters recovery at the
next open (its file moved on) is still reported as another epoch's draft,
which only the recovery's own `reported` mark stops, and rows a recovery
marked `reported` go again once they are current (an epoch kept). A
document whose rows a sweep settled is skipped by later sweeps of the page
load while its row ids stay the same (the `documents` request reads them
from the index without loading a row); the load sweep reads every
document.

## Document limits and rejection

The collaboration service owns limit enforcement; the browser never measures the
document. `checkpoint-persisted` carries `{contentBytes, nodeCount, maxDepth}`
for the stats footer and a `limitCode` when the committed document is over a
limit. Size metrics strip runtime-only `comment` and `comment_*` text marks in
both TypeScript and Go before measuring the persisted Plate projection. Both
walks remain exact through the structural depth ceiling, including legacy
documents that already exceed the product depth cap.

The room checks every writable update, sync step 2 or ordinary update, before
it reaches the authoritative document (`on_update` in
`collaboration-rs/crates/server/src/room.rs`, `Validator::admit` in
`crates/notes/src/limits.rs`). The room keeps the
exact metrics of its last measurement and an upper bound of its metrics now:
each accepted update adds its growth bound (`crates/notes/src/bound.rs`),
read from the update's decoded structs against the room. While
that bound stays within every limit the update goes in without a copy of the
room; otherwise, or when the update holds content the bound does not model
(nothing a Slate edit writes), the room is copied with the update and measured
exactly, and the exact metrics become the new bound. The refusal rule is the
exact one: a candidate over a limit is refused unless it worsens no dimension
against the last exact metrics. Between measurements those may be older than
the room, but the bound then kept the room within every limit, and against any
baseline within the limits an over-limit candidate never recovers. An
over-limit document is therefore measured on every update, and still accepts
edits that do not worsen any dimension, otherwise the deletions needed to
recover would be rejected too and the material would be permanently unsavable.

So an update that would take a note past a limit is refused when it arrives,
however far from the limit the room was: only its writer's connection gets
`document-rejected` and keeps its edits as a refused draft, while co-editors
keep editing. The byte budget the bound replaced let an update far from the
limit in unmeasured (32 KB of control characters escapes to six bytes each and
can cross it); the store then refused the room and discarded it, sending every
co-editor's unsaved edits to copy-only recovery.

The bound prices what slate-yjs writes: a string typed next to a visible
string joins its leaf and adds its escaped bytes; deleting strings, blocks or
attributes never grows the value; an attribute adds `"key":value,`; a new block
is priced from its own structs; anything else that touches a text's formatting
(format items, a deleted format, a block between two strings) re-prices that
text's leaves at the largest attributes its formats can give; each inserted
item adds 4 bytes for a surrogate pair it could split. A text inside a block
that is deleted, before or by the update, is not priced at all, and the
update's delete set is merged once and binary-searched, so selecting all of a
long, heavily corrected note and deleting it costs time linear in the update.
It holds only while every content change to the room is an update it checked
against the room as it was: a service edit (an agent command), or two writers'
updates checked before either applied, drops it, and the next update measures
exactly. Yjs's own cleanup of redundant format items after a remote edit does
not. On the 2 MB load-test note this took the service from ~90 ms of CPU per
keystroke to well under a millisecond.

An update the room cannot place yet (it refers to content
the room does not hold, skips its client's clocks, or deletes a range neither
side holds, as when a reconnecting writer types before its sync step 2) is
dropped and that connection gets the room's sync step 1, as in source rooms
(`resync` in `room.rs`, see
[Office files](office-files.md)): its step 2 reply carries everything the room
lacks, the dropped update included, with no disconnect, and the room never
holds pending content. Copying the room to check such updates was the cliff of
the 2026-10-05 capacity run (`bench/collaboration/reports/`). Two unplaceable
step 2 replies in a row close the connection (logged as `note_step2_unplaced`,
recorded as a `step2_unplaced` editing incident).
There is no exception for a room stored with pending structs before this rule:
its clients' step 2 replies carry those structs, so their connections hit that
close, which is accepted because no such room holds data worth keeping.

### Only update shapes a real editor writes

The room admits only what a real editor (slate-yjs over Yjs, or the Office
engines) writes; a crafted update that is valid Yjs but that no editor produces
is refused at admit, before it can cost the room time or memory
(`ydoc::inspect` in `collaboration-rs/crates/ydoc`, `plain_content` in
`crates/notes/src/limits.rs`). Refused today:

- a struct that refers to its own or a later clock of its client (it could
  never integrate and would stay pending);
- structs of one client that overlap or go back in clock order (two sections
  for one client): fork yrs places an overlapping struct a second time and
  frees the first while the sequence still links it, a crash the fuzz found;
- structs of the update that wait on each other (a cycle across clients): they
  would stay pending in the room. A struct referring to a unit neither the room
  nor the update holds is a missing dependency, not a cycle: the update is
  unheld and the connection resyncs. So a struct of the update that the trial
  below still leaves pending can only be waiting on the update's own;
- an update whose placement costs yrs more than 1,000,000 steps (`MAX_WORK` in
  `crates/ydoc`), the general guard against any shape whose integration is
  quadratic, counted by yrs itself (Epo, 2026-10-08). Past a small edit, admit
  copies the room and applies the update to the copy with the fork's
  `TransactionMut::limit_work`, which counts a step per item a conflict scan
  passes and per step of a map key's walk, one plus one per 128 blocks a split
  or merge moves in a client's list, and one plus one per 64 blocks the struct
  picker scans on its stack (each about 85 ns of work in release); past the
  budget yrs stops before the next struct and the copy is dropped. The copy
  then serves the exact limit check. A small edit applies directly: one
  client, at most 16 structs and 16 delete ranges counting only what the room
  lacks (structs it does not hold, ranges it does not hold deleted; Epo,
  2026-10-08), so a reconnect's catch-up, which repeats the document's whole
  delete set (1,786 ranges on a 248-page DOCX), applies directly in about
  0.3 ms instead of a 160-205 ms, +59 MiB trial. Checking a range walks the
  room's blocks it covers, a step each; past 1,000,000 such steps (a crafted
  update of held deletions near the 4 MiB cap) the update takes the trial.
  Each struct of a small edit is placed where its
  conflict scan can pass only the edit's own items (next to its origin as the
  room holds it, into an empty sequence or key, into a type the edit creates,
  or after an earlier struct of the edit), so its scans pass at most 256 items
  and it splits at most two held items per struct. Measured with yrs's count:
  the 6,524 corpus updates (single writers, three writers, 3,641 deliveries
  made by Yjs itself) cost p50 1, p90 11, p99 44 steps, and the 2,903 of them
  tried on a copy at most 4,395; the most, 63,388, is a one-struct edit
  deleting 11 ranges in a 1.6 MB, heavily split room (block moves, about 6 ms;
  a small edit, so applied directly). On the near-limit
  note (1.8 MB of state) a reconnect bundle of 300 scattered edits costs 18,270
  steps and a 300-paragraph paste 0; copying that room takes 15 to 19 ms and
  admitting either update 32 to 46 ms. A class of 100 typing into one empty
  block at once is never refused (the earlier per-spot cap is dropped);
- in a note text, content other than strings, formats and element texts, and
  non-plain attribute, mark or marker values (invisible to the projection and
  the size metrics).

Decoding refuses an `Any` nested past 128 levels and reserves nothing from
declared lengths (fork yrs), the projection and the measure stop past 1,024
levels, and every walk admit does is linear in the update. Each refused shape
has a crafted-update test in `crates/notes/tests/admit_cost.rs`, which counts
admit's walk steps (`ydoc::steps`, at most 4 per byte of the update and the
room) on every hostile shape the reviews built, never their time (Epo
2026-10-08: security regressions count work), `crates/notes/tests/fuzz_admit.rs`
mutates real and crafted updates with a fixed seed and fails on a panic or a
stall (counted the same way), and `crates/notes/tests/yjs_traffic.rs` admits Yjs-made reconnect diffs
and `Y.mergeUpdates` bundles (`corpus/yjs-traffic.cjs`) without a refusal. A
new kind of update a real editor writes that one of these refuses is a bug in
the rule, not in the editor.

The writable Y.Doc contract permits only the Plate `content` root and the
server-owned `__capy_pending_contributors` map. Every client update checks this
allowlist before application, and load/store paths check it again. Unknown or
wrong-shaped top-level roots are rejected rather than persisted outside Plate
content accounting. Contributor markers have two bounded fields only,
`access` and `nonce`, and name no user: every reader of the room receives
them (a link-share viewer included), so a marker's key holds an opaque id the
room draws for each writer, and only the room maps it back to the user when a
store records its contributors (Epo 2026-10-12; `markers.rs`). Loading
durable Yjs state validates those markers before admitting the room.

A rejected update closes only the offending connection, preceded by a
`document-rejected` stateless message so the client discards its now-forked Y.Doc
instead of reconnecting and resending forever. If an over-limit document reaches
the store hook anyway, which with every update checked takes a sum no single
check saw whole (two updates checked against the same room before either
applied, the later one measured exactly without the earlier), the server
broadcasts `document-rejected` to the room and evicts it; leaving the room
loaded would mean it never persists again. A structurally invalid snapshot is
discarded the same way (`document-rejected` with code `invalid_document`), and
an `authorization-revoked` eviction makes every editor drop its copy too.
`NoteEditor` responds by remounting `NoteEditorCore` under a new generation
key, which reconnects onto the last durable state. Unsaved edits are kept as
one refused draft first, so the remount shows them read-only for copying until
Reload; a limit also shows the too-large toast, and only edits this device
could not store end in the changes-undone toast. Invalidating the collaboration token alone is not enough, because
an unchanged room string leaves the editor mounted on its forked document.
Failed-store retries use the same terminal path. If a queued snapshot later
fails a document or quota limit, the server drops it, broadcasts the rejection
when the room is still live, and discard-evicts the room back to durable Yjs
state.

A discard reloads the room from durable state, and a client disconnected at
that moment still holds what was thrown away: resyncing it would bring it back
attributed to that client. So a discard that threw anything away moves the
room to the next `room_schema` after the unload and before the room opens
again (`evictLocalRoom`, `discardMovesLineage` in `eviction.ts`,
`resetLineage` in `persistence.ts`): one a store-time rejection started, or
one whose room held a writer's unsaved update (a contributor marker) or a
failed snapshot. A clean room keeps its name, so offline editors of it still
sync. If the move fails, the room stays refused and the discard is retried;
the retry remembers that the move is owed (the failed attempt left the room
clean), and a clean room's retry never moves it.
Tokens, outbox events and commands already resolve the current schema, and
`load`/`store` refuse a stale one, so a stale client sees another room before
it syncs anything and opens copy-only recovery; item identities do not change,
so comment anchors and AI Undo guards stay valid. A co-editor still connected
during such a discard, with a few seconds of unsaved typing, lands in recovery
too (Epo, 2026-10-04).

Connection admission, token refresh, and each durable store also re-read actor
lifecycle, membership/share role, owner lifecycle, and quota state from
PostgreSQL. The server keeps server-owned actor metadata (contributor markers
in `__capy_pending_contributors`, `crates/server/src/markers.rs`) so that every
admitted update no committed store holds has a live marker of its writer. A
writer's update writes a marker, in its own transaction just before the
content and in the same flush, only when that writer has no live marker or a
store snapshot has claimed the one it has; typing between stores costs no
marker. Markers are written under the room document's own client id, one the
loaded state does not hold. Client updates that alter that metadata are
rejected; the check reads the decoded update against the room rather than
applying it to a copy, and also rejects an update that writes under the room's
client, names it as an origin, or deletes past its held clock; otherwise one
crafted update could erase or forge every later marker. A debounced store
claims every live marker and rechecks every distinct contributor they name,
not only the last editor. Its row holds the live markers deleted (no stored
row carries one), and after commit it clears only the claimed ones, so an update arriving during the
store belongs to the next batch; a failed store unclaims them, so its retry
keeps the same contributor set. If an authorization change races an already-applied in-memory Yjs update,
persistence rejects the whole snapshot and evicts the room; authorized clients
then reload the last durable state rather than inheriting or later retrying the
revoked user's update.

None of this gates **opening** a document. Limits protect the collaboration
service and the database on write; a document that already exists always opens.
`MaterialBody` reads `sizeBytes` / `nodeCount` from the cached material list and
shows `HeavyMaterialGate` when either passes `MATERIAL_RENDER_WARNING`, offering
read-only (static `MaterialPreview`, no Yjs handshake and no editing plugins) or
open-anyway. Absent list metadata always opens: the gate must never become a
door the reader cannot pass. Nothing downloads the document before the reader
chooses: `GET /api/materials/{id}` carries the whole `content` envelope, so the
viewer header takes the title and kind from the list entry and the capabilities
from the workspace (a workspace material's capabilities come from the same
role), and reads the body only on the standalone page or for a material the
list does not carry, which the gate cannot weigh anyway. The workspace route
loader prefetches an open file for the same reason it leaves an open material
alone. When the API cannot decode stored content it
answers 422 `material_content_unreadable`, which `NoteEditor` and `MaterialBody`
report as "this note could not be loaded" rather than "not found".

## PostgreSQL read projection

The durable content authority is `material_yjs_documents.state` (the base, an
encoded Y.Doc) plus the update log `material_yjs_updates`: a store appends one
row, the change since the room's durable state, and `stored_version` (monotonic)
names it. A room loads by replaying base and rows, and folds the log into the
base when it unloads or the log passes `max(256 KiB, base bytes)` or 1,000
rows. The server converts the `content` root to a Plate envelope and calls the
internal Go projection endpoint: once a store is followed by 30 s without a
change (`COLLABORATION_PROJECTION_IDLE_MS`), at least every 5 minutes while
edits continue without such a pause (`COLLABORATION_PROJECTION_CADENCE_MS`,
projecting the durable state from the store; Epo 2026-10-08), when the room
unloads, and on demand. View asks for one (`ProjectLiveNote`,
`POST /internal/materials/{id}/project`) when the stored version is ahead of
the projection, and serves the stored projection if that call fails
(Epo, 2026-10-07).

Go validates the complete envelope, locks the material, ignores stale versions,
updates `materials.content`, increments the material revision, reconciles
flashcard stats, and advances `projected_version`. The handler parses the
body once: the operation skips Huma's body validation and takes the raw body
(still documented as `ProjectMaterialReq`), `decodeProjectionBody` decodes it
in one pass and refuses what the schema refused with Huma's codes (415 for a
Content-Type Huma has no format for; 400 for what does not decode as JSON at
all, including a number out of float64 range; 422 for a missing, null,
unknown or mistyped field or a `yjsVersion` below 1; names match regardless of
case and `$schema` is ignored, as Huma does), and `materialdoc.NewProjection`
validates the whole document (400). Only a wrong secret answers differently:
401 before the body is read, where Huma's validation answered first. The kind check, metrics, embedded references and editor assets all read
that one parse (`materialdoc.Projection`) instead of re-parsing the canonical
JSON.
Content equal to what is stored advances the watermark without a revision:
it is compared by the sha256 of the canonical JSON against
`material_yjs_documents.projected_sha256`, the hash of what the last
projection wrote or found (once a material has a Yjs document only the
projection writes `materials.content`), and as `jsonb` only on that row's
first projection. The answer carries the row's revision, `size_bytes` and
metrics without reading the content back. On the 2 MB load-test note the
handler's CPU went from ~140 ms to ~30 ms. Its body read deadline is 15 s,
the collaboration service's own timeout for the call, instead of Huma's 5 s.
Rows where `projected_version < stored_version` and no instance holds the room
are projected by the server's 5 s pending scan once they have been idle 30 s
(the same `COLLABORATION_PROJECTION_IDLE_MS`).
Binary persistence and projection have separate failure boundaries. Once a Yjs
version commits, a projection outage does not enqueue that snapshot as a failed
store or advance `stored_version` again. The lag scanner projects the committed
watermark and records each failure. Its timer, pending-row query, per-row
projection, and error-recording paths contain and report their own failures.
An error write includes its failed Yjs version and applies only while that
version remains ahead of `projected_version`, so a slow older failure cannot
restore `projection_error` after newer content succeeds.
A service command commits its row and then projects before it answers; the
handler returns 503 when that projection fails, even though the Yjs change is
already durable and remains eligible for the normal lag retry.

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

Static previews, study views, exports, and domain reads can lag the live room
by the store debounce plus the idle projection. They must never write their
projection back into an initialized Y.Doc.

A mounted editor answers `projection-updated` by marking the material query
stale without refetching, and flushes one real invalidation when it unmounts.
A room sends a store's `checkpoint-persisted` before the `projection-updated`
that covers it, which the footer's credit refresh relies on: the idle and
on-demand projections start from a version the room already confirmed, and the
receipt leaves as the commit returns, while a cadence projection that read the
commit still has its replay and the Go call ahead of it.
The room is the content authority while the editor is open, so refetching there
only re-downloads and re-parses a document nobody is reading — on a near-limit
note that is seconds of main-thread time per save.

Switching a note from Edit to View in the same tab shows that tab's live
document at once: the View toggle (`changeMaterialMode` in `CenterContent.tsx`)
asks the open editor, through `liveNoteHandover.ts` so the View path never
loads the editor, to put its value (co-editors' changes included, normalized
as the projection would be) into the cached material before View renders
(`handOverLiveValue` in `NoteEditorCore.tsx`); the projection the editor's
unmount refetches replaces it when it lands, with no loader in between. Done
at unmount instead, the hand-over came after View had already rendered the
cached copy, so View rendered the whole note twice in one frame, and it ran
on every navigation away as well. It skips a value the room refused or
discarded (a rejected document, a room turned read-only, which goes to View
without the toggle) and one that never synced; a value the document format
refuses is reported to Sentry and leaves the cache alone. `MaterialPreview` is memoized,
so a projected copy equal to the live one (React Query keeps the same
content object) re-renders nothing, and Edit loads its module so View does
not suspend on it (`CenterContent.tsx`). The pane picks the preview's
component type once per mount, at its first View: a note opened straight in
View keeps the lazy wrapper, because swapping it for the loaded component at
the next re-render would remount the whole document (frames reload, an
embedded quiz loses its answer). The refetch reads through `ProjectLiveNote`,
which has a live room store and project first, so it is never older than the
live copy.

A signed-in reader's note View follows the room (Epo 2026-10-10;
`LiveNotePreview` in `CenterContent.tsx`). The projection paints first; then
the live-read module (`notes/liveNoteRead.ts`, a lazy chunk no other path
imports) joins the note room on the tab's socket on a read channel, whoever
the reader is: View asks for one with `{access: 'read'}` on the token request,
as every reader room does (embeds in View, the quiz attempt and set study
pages), so the server refuses anything such a channel sends (it closes a read
channel that writes and sends a viewer no presence). Once the room syncs, its
value is handed over block by block (`notes/liveNoteBlocks.ts`): a block equal
to what the View shows keeps its object (element ids below the block are left
out of the comparison, since normalization gives id-less children random ids),
so the switch redraws only what differs, and after each remote change only the
top-level blocks the events touched are read again (normalized as the
projection is, comment marks left out; read as the patched slate-yjs reads
them, without loading slate, so the chunk adds about 1.4 KB gzipped to a
View). `MaterialPreview` renders the top-level blocks keyed by block id
(PlateStatic keys them by index): a block keeps its element and DOM wherever
an edit above moves it, so an embedded quiz keeps its answers and its room,
frames do not reload and the browser's scroll anchoring keeps the reader's
place, and a block re-renders only when its object changes, so a keystroke
redraws one block. Mermaid sources come through the note document, quizzes and
sets through their own content rooms (`AppEmbed`, joined only while the block
is near the screen, as in Edit), never keys. A room that ends (moved, reset,
or closed because the reader's sync carried changes the room no longer holds)
is joined again with a fresh document, handed over from what the View shows;
one the reader cannot open leaves the View as it is. A tab hidden for 5
minutes leaves its reader rooms and joins again when it shows
(`collaboration/whileVisible.ts`). A heavy note opened read-only from the
warning gate keeps the static View and joins no room. Public share pages and
signed-out visitors stay fresh-on-open: the share renderer has no room code.

Server-origin content mutations use the collaboration server's command
endpoint (`POST /internal/commands`). Commands load the durable document with
the live room's unsaved state and replace one stable custom block through the
`notes` crate's Slate-Yjs transforms with a stale-block precondition. They do not replace the
whole document. If the authority is unavailable, Go returns 503 instead of
falling back to SQL.

Quizzes edit live (live-items, Epo 2026-10-10) through two Yjs documents:
the content document (`material:<id>:schema:<n>`), which readers join too, and
the keys document (`keys:<id>:schema:<n>`), which only editors who can write
join (`POST /api/materials/{id}/collaboration-token` with `{document: 'keys'}`;
a viewer or a read-only editor gets 403, and the collaboration server refuses a
read token for a keys room at JOIN and at refresh). The content document holds
`questions`: question id to `{order, layout, labels, level?, stem, parts}`,
part id to `{order, marks, blocks, answer}`, the answer map holding the type
and what a learner may see (mcq options, a short answer's unit,
matching left items). The keys document holds `keys`: part id to `{type,
solution, correct | accepted | hints | markscheme | gaps | options | pairs |
items}`; an mcq's `correct` is a map of ticks by option id (one or more,
Epo 2026-10-15), a boolean's a plain true or false, and an open part's
`accepted` holds at most one sample answer, which the room refuses past. Editors type ordering items and matching options in the keys
document. Readers get them outside Yjs (D3 as revised 2026-10-10: a reader
copy inside the content document leaked typing order through its tombstones):
the content room keeps a plain list of texts per part (`items::quiz::
ReaderLists`) and pushes it over its channels as a stateless `quiz-items`
message, `{type, full, parts: {<part id>: {kind, items} | null}}`, the whole
set to a channel that joins (`full`) and the parts that changed otherwise. A
part whose entries change as a set is shuffled afresh (a uniform
permutation); a single text edit keeps the order, and a change of several
texts at once (a server write reorders lists by position) shuffles too, so a
reader never sees which text replaced which. So does a text retyped into one
another entry shows, so two retypes in separate windows show no swap. No ids and no history reach a
reader, and neither document holds anything the server writes alone, so an
editor's Undo never re-creates a server-only struct. A reader watching while
items are added one at a time sees each new one appear (live mirroring); one
who joins later gets only the shuffled list. The keys room sends its matching
and ordering entries to the content room once per flush window
(`RoomCmd::Items`); a content room loads the stored keys document for its
lists, and reads it again after a server edit while the keys room is not
loaded (`PeerReload`). Both documents are stored beside each other
(`material_yjs_keys`, `material_yjs_key_updates` for the keys) and every
append of either takes the next `material_yjs_documents.stored_version`, so
the projection's version and Go's rules about it are unchanged; the
projection reads both documents at one version, drops empty text blocks
(stem, body, worked solution; Epo 2026-10-14) and keeps only the questions
that then pass the strict validator (D4), so grading (`POST /api/quizzes/{id}/
attempts` projects a lagging room first, D9) and fresh reads see what a Save
would have stored. The projection also names every editor asset either
document references (`assetIds`), so an image in an incomplete question stays
in use. Lineage compaction never rebuilds a quiz from that projection: it
replays both stored documents and seeds fresh ones from every question as
typed with its keys (`items::quiz::editor_value`, complete or not, blank
blocks included; Epo 2026-10-14), and skips a quiz holding a block this
version cannot read (`rebuilt_quiz` in
`collaboration-rs/crates/server/src/note_store.rs`). The two documents count together against the material's limits: each
room holds the other's metrics (`PeerMetrics`), and Go refuses a quiz
projection over a limit unless it shrank. Admission checks structure, value
caps and counts only (`collaboration-rs/crates/items/src/quiz.rs`): texts,
units, labels and attributions (`QUESTION_METADATA_MAX`), image and graph
descriptions (`QUESTION_DESCRIPTION_MAX`, 500 in quizzes and notes; the bank
keeps `QUESTION_TEXT_MAX`, Epo 2026-10-14), image sizes and ids, whole marks, list and table counts, questions, parts per question and per
quiz, open parts, marking items, ticks and matching pairs, and each chart,
plot and graph value against its kind's caps (`notes::questions::figure_caps`,
sizes only: an unfinished figure is admitted; the block's type and value are
read from the update or the held block, whichever writes them). Nothing past a
limit is stored (Epo 2026-10-14): the question dialog's inputs stop at each
limit and its Add buttons at each count, and everything the store's check
refuses is refused at admission, so a store never discards a room for it. An
answer turned `open` sends its update to the exact check, which holds its
accepted texts to `QUIZ_OPEN_ANSWER_MAX`. A list's count
is bounded like a text's length (held plus added against its cap): only an
update that may pass a cap copies the room for the exact check, whose walk the
step counter counts (`Walk::Exact`). An image block waiting for its upload
(blank) is structure; it only leaves its question incomplete. Live quiz rooms
accept only hosted question images: an image names its uploaded `{assetId}`,
and an image's or a graph's `{url}` is blank or one a stored question keeps
(`figure_url`, `Policy::hosted`: under `BANK_ASSETS_URL`, a copied bank
figure).

`QuestionDialog` edits a live question (`live` prop): its outline, part and
block editors write through `writeQuestion`
(`src/features/quizzes/liveQuiz.ts`: the fewest changes, lists by their common
head and tail, a move as a new order key), a chart or graph stays staged until
the block's Done (one value per block, D8), and the footer holds Undo, Redo and
the live state; there is no Save or Cancel and the dialog closes with its X or
Esc. Undo spans both documents (`pairedUndo` in
`src/features/collaboration/undo.ts`: the latest step of either, and steps of
both made together, such as an answer type change, as one). Inputs stop at
their caps (`maxLength`; a text editor takes back an edit past its cap). A
quiz edits on its material page (`QuizEditor` in the center pane's Edit) with
no Save or Reset: the cloud status follows the title in the header, Undo and
Redo sit beside the View switch, renaming goes through the item's Rename,
Edit (ghost-hover) and Remove (danger-light) sit on a row under each question
at the right, and an
incomplete question shows a line under it saying what it lacks
(`incomplete.ts`); empty text blocks, a blank short-answer unit and blank
open-answer hints never count against it, but a part needs one block with
content. The bank dialog's Save drops them too (`withoutBlanks`). Readers
(the attempt page, the workspace quiz View, note embeds in View) paint the stored questions and then follow the content room
(`liveQuizReads.ts`); a learner's answer that no longer points at what a part
holds (a removed option, a changed set of ordering items) is dropped (D9).
Live rooms are the only writers of quiz content (Epo 2026-10-16: the REST
content write is gone). Agent question commands write what differs in the
questions that differ, texts as the fewest changes and lists by position, so
an editor typing in the same question keeps their characters, with inverses
and question guards.

Item rooms (`ItemRoom`, `src/features/collaboration/itemRoom.ts`) keep an
editor's unsent edits on the device as notes do (`editDrafts`, Epo
2026-10-04): restored and synced on the next open of the same room, the
offline banner while the room cannot be reached, a receipt deleting what it
covers. A first open whose token request fails for want of the network or
the server (anything but a 403 or 404, which leave the item unavailable)
shows the paused state and joins once the browser is back online or the tab
shows again, with no retry loop, its stored edits restored at that join,
which names their lineage (REVIEW5 B1). A quiz's keys document stores under
its own key (`<key>:keys`). An
update the server refuses (or a store refusal for the room) ends the room
here: its edits become a refused draft, a toast says so, and a fresh room
opens with the draft read-only for copying until Reload (`QuizRecovery`,
`LiveFlashcards`); it never rejoins with what was refused. A fresh token
naming another room (compaction, a discard) does the same with the edits as a
draft of the old lineage. An eviction notice's `mode` decides its close: a
drain (access widened; the room stored first) rejoins with the document as
it is, a discard (or compaction) replaces the room as a moved one. Leaving
the tab or navigating in the app while an
item room holds edits the server has not acknowledged asks first
(`unsentItems.ts`).

Flashcard sets edit live (live-items, Epo 2026-10-10). Each set has its own
Yjs document, `material:<id>:schema:<n>` like a note's: the root map `cards`
holds card id to `{order, front: Y.Text, back: Y.Text, image?: {assetId}}`,
ordered by fractional-index keys with the card id breaking ties
(`src/features/flashcards/liveSet.ts`, `src/lib/orderKey.ts`;
`collaboration-rs/crates/items`). The server admits only that shape (a struct
anywhere else, a card id outside 1-128 `[A-Za-z0-9_-]`, a non-text face, rich
text in a face or an image that is not `{assetId}` closes the writer), caps a
front at 4,000 and a back at 2,000 characters, measures the limits on every
card, blank ones included, and projects the set to its Plate envelope with blank
cards left out (a set keeps one card). `FlashcardsEditor` edits it in the
workspace file's edit mode (a standalone set at `/materials/$id?mode=edit`; the
old `/flashcards/$id/edit` page is gone) and inside a note. The card dialog
(front, back, one optional image under the front) writes as you type through
`useBoundText` (`src/features/collaboration/yText.ts`: the fewest changes to the
`Y.Text`, the caret carried through remote changes) and uploads a picked image
at once. There is no Save, Reset or Done: the dialog closes with its X or Esc,
and its footer holds Undo and Redo (this user's own edits: a `Y.UndoManager`
over the item document tracking the `LOCAL_EDIT` origin), the live state and
Remove card. A card added and left blank goes when its dialog closes. On a
set's own page Undo and Redo sit in the center header beside View (portaled into
its actions slot). Rooms ride the tab's shared collaboration socket (`ItemRoom`
in `src/features/collaboration/itemRoom.ts`, one token per room); the socket
holds JOINs past the eight the server authenticates at once (`socket.ts`), since
a ninth pending JOIN closes the whole socket. Readers (the
study page, View, note embeds in View) paint the stored cards first, then follow
the room (`liveReads.ts`), loading the room code after first paint.
Live rooms are the only writers of set content (Epo 2026-10-16: the REST
content write is gone); there are no single-card endpoints. The caps
(`fieldlimits.CardFront` and `CardBack`, counted in runes) hold on every path:
Go's document check (`ValidateCardText`), the agent's
`create_material` cards and card commands (refused up front, contract 19) and
the collaboration server (`CARD_FRONT_MAX`/`CARD_BACK_MAX`, which a Go test
reads), with a card image exactly `{assetId}`.
Explicit quiz/flashcard study and edit opens fetch fresh content before seeding
their view or draft; rendering references in a note does not force all their
detail queries to refresh.

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
With only a cursor, the comment attaches to the containing top-level block,
including an empty block, without text anchors or a quote. The browser captures
the block ID when the comment dialog opens. It reads the current native range
when both endpoints belong to that editor, so a fast Comment click does not
capture an older range while Slate's throttled selection sync is pending.
Commands opened outside the editor retain its stored Slate selection; the
command palette first stores the same live native range when Ctrl+K opens
it, before its search input takes focus (`liveSelection` in
`editorTransforms.ts`), so a shortcut pressed before that sync still acts
on what is selected.

The block's comment count opens a popover (`BlockDiscussionThreads`) listing
its threads, divided by rules. A thread is a flat list of comments in creation
order; the reply row at the bottom adds a comment to it. Each comment's ⋮ menu offers Edit on your own comment and Delete
(own, or any for the workspace owner); on a thread's first comment Delete
removes the thread.

Comment highlighting is local decoration state. It is never applied with
`editor.tf.setNodes`, so opening or hovering a comment cannot create a Yjs
update. If an anchor no longer resolves, the thread remains available at its
stable block and quoted fallback instead of being deleted.

Comment mutations publish `capy:collaboration:comments` through Redis.
The collaboration server sends a stateless `comments-invalidated` room event and clients
invalidate the discussion query.

## Toolbar icons

No icon inside a button draws smaller than 18px (decided 2026-10-14; the
exceptions are select and disclosure chevrons, drag grips, check marks and
decorative row icons). Plate and PDF toolbar icons are 18px with the shared
`Icon` default stroke width of 1.8, including dropdown chevrons and floating
toolbar actions. `EditorIcon` re-exports `Icon` without a separate stroke
override. `ToolbarButton` is 32px, and 30px below `sm` (640px), through the
`--toolbar-button` / `--toolbar-icon` variables in `tailwind.css`, so every
toolbar, floating toolbar and header action follows while a caller's own size
classes still win. The Office runtime is its own document, so
`office-runtime.css` repeats this scale for the DOCX, XLSX and PPTX toolbar
rows, keyed to the frame's width (office-files.md).

`components/ui/Toolbar` shares the fixed toolbar row and groups: 40px height,
8px horizontal padding, zero default button gap, and 28px dividers with 6px
margins; below `sm` 36px height, 4px padding and 20px dividers with 4px
margins. The file header drops from 56px to 48px below `sm` with tighter gaps,
and the question bank's bottom bar (`PageFloatingBar`) uses 44px buttons with
18px icons there. Plate keeps its sticky placement and scrolls enabled groups horizontally with
the shared tabs scroll fade, while settings stay pinned and group preferences
still control visibility. PDF keeps its centered annotation tools, page count,
zoom controls and horizontal scrolling on narrow screens.

Note text sizes above 16px shrink on narrow screens through the `note-fs`
utility: a size keeps 16px plus half its excess at 360px and grows linearly to
its full size at 768px; 16px and below render as written. Headings set their
size as `--note-fs`, and `FONT_SIZE_NODE_PROPS` renders px font-size marks the
same way in the editor and static views (other units render as written). The
font-size control reads a heading's authored size, not the rendered one.
Callout, code block, table cell and column padding also tighten below `sm`.
Paragraphs are 8px top and bottom (16px apart) while list items keep 6px;
code blocks have 8px margins and block equations 4px.

Tabs and both toolbar scroll containers share `useHorizontalWheelScroll`.
Vertical mouse-wheel input scrolls overflowing controls horizontally without
React state updates. Horizontal gestures and zoom keep native behavior, and
wheel input passes through at the scroll boundaries.

`components/ui/ToolbarButton` reuses `BASE_BUTTON_STYLE` for shared button behavior
and supplies both editors' 32px buttons, focus/disabled
styles, purple active tint, and dropdown triggers (content width, 4px gap and
18px chevron). Plate's wrapper preserves the editor selection on mouse-down;
PDF supplies its current tool directly. Link, table and column floating actions
reuse the Plate wrapper. Workspace center-header icon actions and Files/Chat/Create
panel actions also use the shared 32px button and 18px icon, including mode and
action-menu triggers. Their action rows use zero inter-button gap and 8px
right-edge padding, matching the toolbar. Workspace dropdown chevrons retain
their existing styling.

Plate's All blocks, media upload, import/export and table controls use Popover
with icon-only triggers. PDF Draw and Shape also use Popover. Paragraph/block
styles also use Popover, with a current-choice check and no chevron. Table groups open nested popovers
on click or keyboard activation. Popover actions are buttons navigated with Tab;
the table size grid retains arrow-key selection. Command popovers become inert
on close and preserve focus handed to the editor or a command's dialog.
All blocks groups Subscript and Superscript with Inline elements, using shared
Hugeicons; Clear formatting remains in the footer.
The slash popup shares All blocks' group headings, compact icon rows, shortcut
hints and rounded-lg container. Results follow the same group order; arrow
selection scrolls the active row into view while focus stays in the query.
Both use EDITOR_COMMANDS and conditional Comment; All blocks additionally
offers Subscript, Superscript and Clear formatting.

Callout variant and code-language choosers share a muted text trigger and the
Plate popover rows, with a check for the current value. Choosing a value updates
the owning block and returns focus to the editor. Callout icons share their
first-paragraph line alignment between editable and static rendering.

Plate marks subscribe in `MarkToolbarButton`, shared by the fixed and selection
toolbars. Primitive selection results drive list, link, table and column states;
the table trigger follows the selected table, independently of menu visibility.
The top column controls indicate two/three columns, while the column popup
matches the exact width preset. Alignment choices highlight the selected block's
alignment and the trigger shows its icon. Insertion commands retain their behavior.
Column outlines are dashed only in Edit mode; transparent borders retain the
same layout in viewing. Column drag markers use the shared gap midpoint for
both adjacent edges. Layout changes discard a lone empty paragraph in a removed
column before Plate merges its contents, preventing repeated 2↔3 switches from
accumulating blank lines. Authored block sequences and textless embeds survive.
The table menu's cell/merge subscriptions remain inside the unmounted-when-closed
menu body, keeping those reads off the typing path.

## Commands

Editor settings uses the shared workspace-style tabs: General holds Display
size and Commands holds toolbar group visibility. Both preferences apply on
Apply and persist locally in `capy-note-editor-prefs`. Half width retains the
768px centered reading container; Full width fills the pane. Below `md`, both
fill the available width. Note previews use the same preference.

General also holds Note font: Fustat with roomy block gaps, or the system font
with the Plate playground's compact ones (paragraphs 4px padding and 1.5 line
height, my-1 lists, quotes, code, callouts and columns; headings unchanged).
Without a pick the style decides: classroom shows Fustat, notion the system
font. A pick is per browser in `capy.noteFont` (`noteFont.ts`), not the prefs
blob, so the head scripts in `index.html` and `share.html` set
`<html data-note-font>` before first paint; `tailwind.css` maps it to
`--font-sans` and the `--note-*` gap variables on `.note-editor`, which the
editor, View and shared note pages all render in. Applying an unchanged font
stores nothing, so the default keeps following the style. Shared note pages
show the viewer's own choice (visitors without one get classroom, so Fustat)
and carry a server-rendered Aa button that switches it with plain script
(`src/share/main.tsx`); the edge-cached HTML stays the same for everyone.

Slate's editable root spans the pane at either size. A stable `as` component
wraps its children in the width-constrained inner container, leaving margin
clicks inside the editable root and retaining native keyboard handling and
Plate's chunk rendering. Width changes do not recreate the editor.

`editorCommands.ts` is the shared command catalog. Editors can open commands by
typing `/`, through toolbar menus, or with `mod+k`. Commands, document mutations
and commenting are available only in Edit mode.

`mod+shift+m` opens the comment workflow for an active selection.

## Direct AI edits

Chat `edit_document` never touches the browser editor. The collaboration
service loads the durable material state into an isolated Y.Doc, merges the
open live room's state so in-flight typing counts, applies the normalized
commands through a headless Slate editor
(`collaboration-rs/crates/notes/src/edit.rs`), stores the
inverse and item-run guards of the edited nodes, then fans the committed delta
into the live room as a `service-edit` update; the projection runs on the same
commit. A refused edit names its reason and, where the agent can retry, the
target as it reads now (see [agentic-retrieval](../agentic-retrieval.md#tools),
Tools).
A removed flashcard's review state stays in `review_states`, ignored until an
Undo brings the card back. The chat result card shows the effect with an Undo
button (`available`, `undone`, `unavailable`) fed by the receipt's `undo` ref.

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
components must not use editor hooks. `StaticMaterialKit` has no markdown
parser: uploaded `.md` files convert first (`files/MarkdownPreview.tsx` through
`markdownToDocument`), and the markdown converters add `noteMarkdownPlugin` on
top of the kit themselves. Interactive and static component
registries share node vocabulary but have different behavior.

Obsolete `suggestion` and `suggestion_*` properties are rejected by server
validation and are not rendered.

## Operational boundaries

- Signed-out visitors and note View never connect; signed-in viewers of a set
  hold read channels (no stores, projections or markers of their own).
- Run one collaboration server per environment, with Redis available.
- Persistence uses bounded debounce/max-debounce (notes 2 s / 10 s, sources
  5 s / 30 s) and runs one store at a time per room; a failed store retries
  through the same path with backoff while the room stays loaded.
- Redis carries eviction delivery, handoff and publication locks and the
  instance registry; it is not durable storage and does not sync documents or
  awareness between instances. Scaling out later means document-sticky
  routing (every connection to a room reaches the instance that holds it),
  not Redis fan-out.
- Broadcasts merge over 30 ms windows (`flushDelay`), and a note editor
  publishes its cursor at most once per 50 ms
  (`src/features/notes/cursorThrottle.ts`).
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
  which is memoized for that reason. The attribution footer is its sibling in
  the scroll area, after the editable content and outside the Yjs document
  (`NoteAttribution`, memoized on the material's provenance, so neither
  keystrokes nor save acknowledgements render it). It credits the embeds the
  document holds now: the editor rescans the top-level blocks for embeds only
  when an operation touches a top-level path (or a whole new value arrives),
  and the footer recomputes only when that list or an embed's read changes. The save status is not React state
  above the note either: `NoteEditorCore` keeps only "still handshaking", and
  `CenterContent` passes a per-pane store (`createEditorStatusStore`) that only
  the header's status icon subscribes to. Saved to Syncing happens on the first
  keystroke of every edit, so as state it re-rendered the header, toolbar and
  command palette inside that keystroke. `bench/editor/scripts/editor.perf.ts` guards this with
  a save-cycle blocking budget, and `saveCycleProfile.perf.ts` attributes a
  regression to functions. How to run those specs and the manual GitHub Actions
  checkpoint is in [editor-perf.md](../editor-perf.md).
- Nothing per element may subscribe to every editor change. Plate's
  `useEditorSelector` is a jotai atom derived from the editor version, and
  each keystroke and selection change recomputes every mounted one. Plate's
  navigation feedback (the flash on the heading a table-of-contents entry
  scrolls to) injects one into every element, which on a near-limit note was
  about a third of each keystroke. `navigationFeedback.ts` overrides that
  inject: an element reads the plugin's `activeTarget` option, which changes
  only when a flash starts or ends, and renders the same `data-nav-*`
  attributes Plate would. The note editor stylesheet (`src/styles/tailwind.css`)
  fades the target from the highlight colour over Plate's duration, restarting
  on a second jump (`data-nav-cycle`); under reduced motion the highlight
  holds for that time instead.
- React saves the focused element's selection before every commit, and for a
  contenteditable it walks the element's whole DOM to turn it into text
  offsets (`getSelectionInformation`); on a near-limit note that walk was about
  a quarter of each keystroke's main-thread time. React reads the selection
  only when the element's `contentEditable` property is `"true"`, and uses it
  only to put a selection back after a commit moved focus away, which Slate
  does itself. So the editor root's `contentEditable` property reads
  `"inherit"` (`hideSelectionFromReact` in `NoteEditorCore.tsx`); the
  attribute, which editing follows, is untouched, and Slate and Plate read the
  attribute. React still refocuses the editor after such a commit.
- A block's interaction chrome mounts only once the block comes within a
  screen of the note's scroll area or the pointer enters it, and then stays
  (`useNearViewport` in `BlockInteractions.tsx`): the gutter with its drag
  handle, the drop line, and the react-dnd drag source and drop target
  (`BlockDnd`). Each react-dnd registration dispatches to every registered
  monitor, so registering all ~3,600 top-level blocks of a near-limit note on
  open cost O(n²), and the gutters were about three in four of the editor's
  DOM nodes, which React walks before every commit while the editor has focus
  (`getSelectionInformation`). Drops land where the pointer is and dragging
  auto-scrolls blocks into range, so the handle shows on hover and drag and
  drop work as before (`e2e/editor/block-interactions.spec.ts`).
- Remote cursor and comment decorations must match Slate paths structurally
  (`Path.compare`, not dot-joined path strings, which put block 10 before
  block 3). Shared-link editors may be absent from the
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
cargo test --manifest-path collaboration-rs/Cargo.toml
pnpm test:go
```

The collaboration server's tests cover token claims and origin checks,
stable-block command preconditions, the Slate-Yjs and markdown ports against
the TypeScript oracle's corpus, and (with `CAPY_IT_DATABASE_URL`) capy-sync
convergence, read-only enforcement and delta saves against PostgreSQL and
Redis. Docker E2E adds coverage for persistence, projection, reconnect, and
multi-context behavior.

Plate and PDF toolbar popovers share `components/ui/ToolbarPopover`: 8px corners,
4px container padding, gapless 30px rows with 18px icons, 14px medium text and the dropdown
body line height. Plate wraps shared buttons to restore editor/command focus.
Insert adds an 8px top padding plus 4px above its first section label; later
labels have 12px above and all labels have 6px below. Color/input layouts retain
their horizontal insets with 4px vertical padding. Base Button and account Menu
styles are unchanged.

Horizontal rules follow Plate playground: a 2px line inside 24px vertical
padding, with a line-strong ring while selected and focused. The padded area
participates in Slate void selection, allowing Backspace/Delete removal.
Static rendering shares the same line and spacing without selection styling.

The floating link editor uses shared Input rows with leading icons and a
Separator, matching Plate playground's compact layout. Its container uses the
popover's rounded-lg corners; shared confirm/cancel actions remain in the footer.
Plate's FloatingLinkUrlInput composes the shared Input via asChild to preserve
URL state and focus behavior.

MathLive's inline editor removes the internal container's minimum height and
padding; its outline and vertically centered menu trigger do not increase line
height. Inline formulas omit the keyboard button, including question-editor
controls. Block formulas retain both buttons. The keyboard button toggles the keyboard, Escape first hides
an open keyboard, and unmounting any formula editor hides the shared keyboard.
Pointer-down outside the formula, keyboard and its toggles also hides it,
including toolbar controls that preserve editor focus.
Question editors retain external controls, with the menu below the keyboard for
block formulas and a centered menu alone for inline formulas.
The formula menu filters MathLive's native items to Insert Matrix, Insert, Mode,
Copy and Paste. Its shadow-root CSS matches ToolbarPopover's tokens, row spacing,
border and shadow, retaining native matrix grids, templates and clipboard formats.
Checkmarks are 12px, vertically centered, with an 8px gap before aligned labels.
Menu keyboard events remain inside MathLive; Escape closes the menu without
cancelling formula editing. These actions use the existing LaTeX document field.
MathField clears MathLive's menu items before commit/cancel and in layout-effect
cleanup before the field disconnects, closing the shared overlay and cancelling
pending submenu work. Closing before commit also finishes menu focus restoration
before React replaces the editor with its preview.
MathLive 0.110 does not perform that cleanup itself; leaving it open makes the
next field's menu call `showPopover()` on a disconnected element.
MathPreview mounts inert, read-only MathLive fields without keyboard/menu controls,
using the same fonts and layout as editing and a spoken-math accessible label.
It and the shared note's server markup (`mathMarkup` in `src/share/server.tsx`)
pass the LaTeX through `inertTex`, which draws MathLive's HTML commands
(`\style`, `\htmlStyle`, `\class`, `\htmlClass`, `\cssId`, `\htmlId`,
`\htmlData`, `\href`, `\url`, and `\csname`, which builds any command) as
text, so a formula sets no style, class, id, data attribute, link or
background/paint fetch of its own. Those commands are a MathLive feature and
stay raw in every version. The other commands that take a CSS or SVG value
(`\color`, `\colorbox`, `\bbox`, `\enclose`, `\fontfamily`, …) are MathLive's:
its 0.111 strict-grammar validation drops an invalid colour, border,
background or font family, and its `\enclose`/`\href`/`\htmlData` quoting
fixes close the SVG overlay and attribute breakout, so those need nothing from
`inertTex` (a pin below 0.111 would reopen that class, which an `inertTex`
test guards). The stored LaTeX is unchanged. Share pages drop the markup into
the DOM without a sanitizer, so `mathMarkup` also runs a cheap tripwire
(`markupIsInert`, `mathTripwire.ts`): markup carrying an inline event handler
or a `url()`/`image-set()` paint or background (after decoding character
references) is shown as the escaped source instead. The app's report-only
image policy (deployment-runbook.md §2.4) governs `img-src` only; SVG paint
falls under `default-src`, so the policy is not the fix for this class. This
preserves native placeholders, accents and fractions in notes, question editors and
question/quiz views. KaTeX remains confined to export figures, where empty slots map
to `\square`; saved editable formulas retain their original placeholders. The
editors declare the equation nodes and their `$…$`/`$$` input rules in
`notes/equationPlugins.ts` (copied from @platejs/math 53's `MathRules`) rather
than importing @platejs/math, whose entries import KaTeX and its stylesheet.
A display formula wider than its column keeps its size and scrolls sideways in
MathPreview's own box (question views, question-editor and note equation
previews, note View); the inert field leaves wheel and touch to that box, which
is `relative` so MathLive's absolutely positioned screen-reader node cannot widen
the page. Inline formulas stay capped at their line's width. A shared note's
server markup scrolls in the static equation block's own `overflow-auto` box.
Both boxes carry `scroll-fade-x` (as Tabs do): while more of the formula is
hidden at an edge, that edge fades over 28px, driven by the box's own scroll
timeline with no script. The utility's mask exists only while that timeline
is active (its keyframes turn `--scroll-fade-on` to 1, read by an `if()` on
`mask-image`), so a formula that fits has no mask at all and its text keeps
subpixel antialiasing; this holds for every `scroll-fade-x` user, and
HoverActions holds the mask on with `--scroll-fade-on: 1` for its fixed edge.
A box that grows to fit while scrolled keeps its last fade until it scrolls
again (Chromium and WebKit). The note editor's equation wrapper has no mask,
which would break its formula menu.

Block formula previews and MathLive share 16px vertical padding and the same
math font size. Opening an existing block reserves its preview height while
MathLive loads. When MathLive is already registered by a preview, MathField
constructs the editor synchronously in its layout effect before the first paint.
Awaiting even a cached dynamic import left one empty, collapsed frame on opening.
MathPreview also reuses the registered constructor synchronously when editing ends,
with its LaTeX in the initial `value` attribute before connection. Setting the value
after mounting left the first frame empty until MathLive's next animation frame.
New blank formulas still load MathLive lazily. Inline fields use textstyle; block fields use displaystyle.
The shared MathField uses app-theme selection colors, serif text zones without
MathLive's text-zone tint, and a black 1em caret. The caret-height override lives
inside MathLive's shadow root because version 0.110 exposes no CSS part for it.
Text carets use the same zero-height inline-block baseline anchor as math
carets. Both MathLive modes use normal 400 font weight rather than inheriting the
surrounding UI weight. Keyboard/menu columns sit 8px inside the outlines, with
20px controls and a 2px gap. Inline fields cancel their 36px right and 8px left
padding with negative margins, so the outline/menu overlay adjacent text instead
of increasing the formula's layout width. The menu has an opaque surface background
and sits above adjacent text. Existing nonempty formulas do not acquire a minimum
width when opened. Matching negative vertical margins preserve line height. At a text-run
boundary, typing `-` switches to math before MathLive handles the key, allowing
its native `->` shortcut to insert an arrow outside the text. Hyphens inside
a text run keep their text behavior.
Unmodified horizontal arrows skip the redundant first/last child positions of
`\overline` groups using MathLive's public element-info and movement commands,
matching its accent navigation. Internal characters remain editable; modified
arrows and other structures retain native navigation.
