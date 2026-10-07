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
- Go/PostgreSQL own metadata, permissions, comments, and content projections.
- `materials.content` is an eventually consistent Plate JSON read projection.
- Viewers and study routes render that projection without joining Yjs.
- Editors edit and comment in Edit mode; View is a static preview without comments.
- Viewers never join a room.

## Package boundary

The browser uses Plate 53, `@platejs/yjs` 53.2.x,
`@hocuspocus/provider` 3.4.x, `@slate-yjs/core` 1.0.2, and Yjs 13.6.x.
The collaboration sidecar uses Hocuspocus server 4.5.x (with a pnpm patch that
skips its awareness scratch copy when no `beforeHandleAwareness` hook is set)
and no Hocuspocus Redis extension: each environment runs one sidecar, and the
sidecar's own Redis use (eviction delivery, handoff and publication locks, the
instance registry) does not sync documents.
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

`materialModePolicy` exposes two modes:

- `view`: static `MaterialPreview`; no token, WebSocket, awareness, or editor;
- `edit`: live editable Plate with a `write` room token.

Files and materials remember their last View/Edit mode separately in localStorage, keyed by item kind and ID. Explicit URL modes take precedence; otherwise the saved mode is used, with View as the default for an uncached item. Viewers only get `view`. The header toggles View/Edit with the current mode icon and identical styling in both states, for materials and uploaded files at every viewport size. Workspace and standalone document URLs accept `mode=view|edit`; a successful toggle replaces that query parameter, so reload and shared links retain the mode. File transitions retain their save/export gates, and a failed transition keeps the editor and URL in their previous mode.

The permission boundary is layered:

1. Go checks `MaterialEffectiveRole` before minting a short-lived token.
2. Viewers receive no collaboration token.
3. Hocuspocus verifies signature, issuer, audience, expiry, exact room, schema,
   access, and browser origin.
4. Hocuspocus marks `read` connections (the downgrade an editor receives
   while the storage owner's account is locked) read-only, so a modified
   browser cannot send Yjs document updates.
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
that unload succeeds. Before unloading, the sidecar waits for the target room's Hocuspocus store hooks and save mutex as well as every queued application save. Intentional discard skips pending stores without reporting a failed save; drain still requires a successful durable save. Each active instance must return a positive delivery
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
List handles measure the first rendered text line to account for internal
numbered/todo wrappers. Todo checkboxes use the CSS line height to center on
the first line, including wrapped rows. Todo rows use only Plate's indent;
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

Text leaves do not need IDs. Runtime values must never be written onto nodes:

- signed asset URLs and browser blob URLs;
- upload progress and errors;
- selection, hover, dialog, or plugin state;
- collaboration presence;
- local AI preview data.

Media nodes persist `assetId` and stable metadata. Uploads go through the
note's material route, so standalone notes upload too (see
[backend-storage-quota.md](../backend-storage-quota.md)). Renderers resolve signed URLs
at runtime.

Each asset belongs to one note, and the server keeps it that way; the browser
does nothing but render. A save that stops using an asset (once it was
completed more than 60 s ago) puts it in a hidden trash for a day, still
charged, and a save that uses it again restores it. A paste, drop, undo, cut
and paste or a draft replayed after reconnect is an ordinary Yjs edit: the
collaboration service's children pass (`collaboration/src/children.ts`, see
[agentic-retrieval](../agentic-retrieval.md) for the AI edit side) reads the
asset and quiz ids each writer's update wrote, asks Go to make them the note's
own as that writer (a copy of another note's asset, the note's own one out of
the trash), then repoints or drops the nodes through a direct connection and
broadcasts `children-ready` with the ids it kept. In an editable note
`MediaAssetView` (given the note as `ownerId`) shows a skeleton while a node's
asset belongs to another material (the resolve answer's `materialId`) or does
not resolve (trashed, waiting for the pass), and resolves again when
`children-ready` names it (`childrenReady.ts`). A copy that does not fit the
payer's storage is dropped and only the writer who pasted gets
`children-refused`, shown as a toast. Nothing is kept in IndexedDB and the
browser never calls an adopt route.

Image, YouTube, mermaid, chart and graph blocks share `MediaFrame`: a toolbar docked top-right
that shows on hover, and in edit mode two side handles that resize the block
symmetrically and store `width` as a percentage string (`"62%"`). Frames stop at
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
under the material title, and flashcard edit mode is the staged card grid
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
embedded mode: Submit grades in place, a flashcard flips when clicked), Edit shows the editors in place (`QuizForm`'s Edit and
Remove per question and Add question; the `FlashcardsEditor` grid with its hover
toolbar and Add card), each change saved at once through the item's content
endpoint, one save at a time. Removing the last question or card removes the
block itself (the item follows the removed-block trash rule; Undo restores both). The static renderer takes the page's embed renderer from
`EmbedViewContext` (the app's reads through the account and loads on demand; the
share page feeds the note's public data). Blocks that need the browser in a read-only
render (images, embeds, diagrams, interactive HTML) sit in an `Island`
(`Island.tsx`, views in `staticViews.tsx`): inert in the app, they are what a
server-rendered shared note hydrates, and equations render MathLive's static markup
there (`StaticMathContext`). Inserting through the slash command or toolbar
creates the row through `POST /api/materials/{noteId}/embedded` (a set with one
blank card) and inserts the reference at the top level, where it opens in place
for editing; nothing is inserted when
creation fails, and with the caret inside a callout, column, table or other container
the quiz, flashcards and mermaid commands do nothing. A reference that lands
nested (a paste) is lifted to the top level by the plugin's normalizer. Edits
save through the quiz or flashcard content endpoint, so note undo covers only
inserting and removing the reference. Another open editor of the note sees an
embed's change when its query refetches (see the freshness item in
`todo-office.md`). Go and the sidecar reject inline `quiz`/`flashcards`
nodes in a note and references anywhere but the top level. A markdown fence
imports as a pending reference (`materialId: ''` plus the fence body in
`pending`); the mounted editor claims it in the shared document
(`resolvingBy`) and the client whose claim survives the merge creates the
row; readable Markdown and DOCX exports resolve references into study handouts
and fail explicitly if a required reference cannot be read. A reference
belongs to its note through the same children pass as media: a block whose
`materialId` an update wrote (paste, drop, undo, redo, a replayed draft; a
pending one is skipped) is answered per block. Every block has its own quiz:
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
after rendering. Preset fonts (Excalifont, vendored Latin subset in
`src/assets/fonts`; Comic Neue from `@fontsource/comic-neue`) load through
`FontFace` before the render, since mermaid measures labels while drawing; a
failed font load draws in the fallback font. In edit mode the hover toolbar has
theme, caption, edit, copy and delete. A resized diagram stretches
past its natural width. The
caption is typed in a field under the diagram that rewrites the
`mermaid_caption` text with `voids: true`. The node stays void, so a DOM
selection inside it maps to the caption element; `fixMermaidSelection` moves
such points onto the caption text. The edit dialog shows source beside a live
preview in the block's theme (Tab indents by two spaces; deleting lives on the
toolbar); a parse error appears under the source while the
preview keeps the last diagram that parsed.

Chart and graph nodes store their question block under `block`, an optional
`width`, and a single empty text child; graphs export their SVG before saving. Inline
and display equations use MathLive in both viewing and editing, including question-editing previews. The math toolbar inserts formulas and common symbol templates.

## Interactive HTML blocks

`html_embed {id, html, caption?}` is a top-level void with one empty text leaf,
shaped like chart and graph (a nested one is lifted by the plugin's
normalizer). The agent writes it as an ` ```html-embed ` fence with YAML
`caption` and `html` and no fallback (`blocks/shared.ts`, `markdown.ts`); the
collaboration service's converter builds the same node. A fence without html,
with html over 64 KB, or an eleventh fence is refused by name. Go
`materialdoc`, the collaboration validator and the browser's
`isMaterialDocument` cap `html` at 64 KB (UTF-8 bytes) and a document at 10
such blocks, and refuse any other field. Retrieval skips the block like
mermaid. There is no insert command; people edit the snippet through the
source dialog.

`HtmlEmbed.tsx` renders it in `MediaFrame` (mock A of
`artifacts/2026-10-04-interactive-blocks.html`, since stripped to a frame
with no border, radius or label): the caption as muted text under the
frame, and a hover toolbar with View source, Copy
and Delete in the editor and View source only in view mode. View source opens
`HtmlEmbedSourceDialog`, titled Source: editors change the caption and snippet and Save within
the 64 KB cap; read-only users only read it. The snippet runs only in
`<iframe sandbox="allow-scripts" loading="lazy">` at `VITE_EMBED_ORIGIN/`, the
wrapper page in `embed/` on its own site (see
[deployment-runbook.md](../deployment-runbook.md)); without that origin the
block shows a notice instead of a frame. On the frame's first load the host
posts `{type: 'render', html, theme, font}` with target `*` (the frame's
origin is opaque), where `theme` holds `--bg`, `--fg`, `--muted`, `--accent`,
`--border` and `--font` (the style's `--font-sans`) read from the app's
tokens plus `--scheme` (the app's computed `color-scheme`), and `font` is the
app's cached Fustat latin woff2, which the frame registers with `FontFace`
because its CSP allows no font request. Before the snippet the wrapper
applies a base sheet: `color-scheme: var(--scheme)` (a scheme differing from
the page would paint the frame opaque), `accent-color: var(--accent)`, and a
body with no margin, `16px/1.5 var(--font)` in `--fg` on a transparent
background, with form controls inheriting the font; the snippet's own CSS
overrides it. The agent guidance names the variables and the base. The share
page hydrates the same `HtmlEmbedView` island (without View source) and
loads the same Fustat file, so it renders identically. The host accepts only `{type: 'resize', height}`
from that iframe's own window with a finite height, clamped to 32 to 600 px;
a taller snippet scrolls inside the frame. The
wrapper writes the snippet over itself, which fires a second `load`; a later
`load` means the snippet navigated its frame (to a page without the
wrapper's CSP), so the frame is replaced by a notice until the snippet
changes. A theme change or a new snippet reloads the frame. Frames mount
within one screen of the visible part of their scroll container and unmount
beyond it, keeping their last height. Opening a note with `?block=<id>`
scrolls that block into view once per page load. Exports never run the
snippet (see Readable note exports).

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
Rich/merged tables use HTML. Images and attachments produce a ZIP containing
`document.md` and relative `assets/`; text-only exports remain `.md`.
DOCX uses blue info callouts, grey quote/divider borders, plain answer keys, images
for formulas/diagrams, and borderless tables for columns. Private audio/file links
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

Hocuspocus provider sync means only that the browser and in-memory server
converged. It does not mean PostgreSQL durably stored the state.

The editor reports:

- `Connecting…`: the first handshake (the note body waits for it);
- `Reconnecting…`: a later drop while the browser is online; the editor stays
  mounted and editable;
- `Syncing…`: edits waiting for the checkpoint debounce or durable acknowledgment;
- `Synced`: the initial room sync completed with no local work pending;
- `Saved`: the sidecar confirmed that a state containing this client's work was
  committed;
- `Offline`: the room cannot be reached (the browser is offline, or
  reconnecting kept failing for 30 s); an editor that synced once keeps
  editing on this device (see [Offline editing](#offline-editing-and-drafts));
- `Not saved. Retrying…`: a store failed and the sidecar is retrying it;
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

Room tokens live five minutes. About a minute before expiry the sidecar asks
the client for a fresh token in band (`connection.requestToken()`); the
provider answers through its `token` function and `onTokenSync` verifies it,
rechecks access and re-arms both timers (`collaboration/src/tokenExpiry.ts`).
A connection that cannot answer is closed at expiry. A room closed on an open
socket (expiry, eviction, an access recheck) only emits the provider's `close`,
never `disconnect`, so `roomReconnector` (`src/features/notes/roomConnection.ts`)
reconnects at once with a fresh token and backs off while refusals repeat.
Authentication refusals carry reasons: `collaboration-read-only` drops to view
under the read-only strip, `collaboration-not-found` (trashed or deleted) and
`collaboration-forbidden` (lost access) replace the editor with the
file-missing or no-access panel, and anything else (an expired token, a room
being reset or compacted) is retried. A loss still unresolved after 30 s while
online puts an editor that synced once into offline mode (before the first
sync it turns the status red). A failed first token request shows the panel for its status (not found,
no access, or unavailable with Retry).

A transient store failure broadcasts `checkpoint-failed`; the editor keeps its
pending receipts (the failed-store retry answers them), shows Not saved and,
with unsaved work, the `delayed` save banner until a receipt covers every
change. The banner also shows when a checkpoint request stays unanswered for
`NOTE_SAVE_DELAY_MS` (25 s) of connected time (see
[error handling](error-handling.md#collaborative-source-failures)).

On a value change, edit mode debounces a `checkpoint-request` stateless message
carrying a random receipt ID. The sidecar keeps the room's outstanding IDs in
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
room with backoff (5 s, then doubling to 60 s,
`collaboration/src/failedStoreRetry.ts`). A source room's live saves wait out
the same backoff, so a state that keeps timing out in the shared Office worker
is tried once per step instead of on every debounce. A room that is still loaded retries
through its own store path (Hocuspocus's debouncer and save mutex, and a
source room's save queue), so a retry never races the live save, which holds
everything the failed snapshot did and answers its pending receipts. Only an
unloaded room retries its failed snapshot directly; that retry carries the IDs
claimed with the snapshot and acknowledges only those IDs if it commits.
Checkpoints queued after that snapshot remain pending for a later store.

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

## Offline editing and drafts

An editor that can edit keeps editing while its room cannot be reached: the
browser went offline, or reconnecting failed for 30 s. Its header shows
Offline and the `offline` save banner reads "Can't connect to Capy. Your edits
are saved on this device and will sync when you reconnect. They may be
rejected or lost." until the room syncs again. Read-only viewers and View
mode never join a room and are unchanged; opening the app offline is not
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
updates it covers. Each editor mount is a session; each of its local Yjs
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
and the exact rows it adopted, so another tab's newer write survives.

On reconnect the provider's normal sync sends the unsent updates. The server
answers a client's step 1 with its own step 1 and handles a connection's
messages in order, so the step 2 carrying them lands before any request sent
at `synced` (`provider-compat.test.ts`). That holds only from `synced`: a
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
for the note itself (token, refusal), and in a once-per-load idle sweep that
asks each stored document's token endpoint. A 403 about the account itself
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

## Document limits and rejection

The collaboration service owns limit enforcement; the browser never measures the
document. `checkpoint-persisted` carries `{contentBytes, nodeCount, maxDepth}`
for the stats footer and a `limitCode` when the committed document is over a
limit. Size metrics strip runtime-only `comment` and `comment_*` text marks in
both TypeScript and Go before measuring the persisted Plate projection. Both
walks remain exact through the structural depth ceiling, including legacy
documents that already exceed the product depth cap.

`beforeHandleMessage` extracts writable updates from both Yjs sync-step-2 and
ordinary update frames before they reach the authoritative document
(`validateUpdate` in `collaboration/src/persistence.ts`). The room keeps the
exact metrics of its last measurement and an upper bound of its metrics now:
each accepted update adds its growth bound (`materialUpdateGrowth` in
`limits.ts`), read from the update's decoded structs against the room. While
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
(`collaboration/src/officeRoots.ts`, see
[Office files](office-files.md)): its step 2 reply carries everything the room
lacks, the dropped update included, with no disconnect, and the room never
holds pending content. Copying the room to check such updates was the cliff of
the 2026-10-05 capacity run (`bench/collaboration/reports/`). Two unplaceable
step 2 replies in a row close the connection (logged as `note_step2_unplaced`,
recorded as a `step2_unplaced` editing incident).
There is no exception for a room stored with pending structs before this rule:
its clients' step 2 replies carry those structs, so their connections hit that
close, which is accepted because no such room holds data worth keeping.

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
the store hook anyway, which with every update checked takes a sum no single
check saw whole (two updates checked against the same room before either
applied, the later one measured exactly without the earlier), the sidecar
broadcasts `document-rejected` to the room and evicts it; Hocuspocus swallows store failures, so leaving the room loaded would
mean it silently never persists again. A structurally invalid snapshot is
discarded the same way (`document-rejected` with code `invalid_document`), and
an `authorization-revoked` eviction makes every editor drop its copy too.
`NoteEditor` responds by remounting `NoteEditorCore` under a new generation
key, which reconnects onto the last durable state. Unsaved edits are kept as
one refused draft first, so the remount shows them read-only for copying until
Reload; a limit also shows the too-large toast, and only edits this device
could not store end in the changes-undone toast. Invalidating the collaboration token alone is not enough, because
an unchanged room string leaves the editor mounted on its forked document.
Failed-store retries use the same terminal path. If a queued snapshot later
fails a document or quota limit, the sidecar drops it, broadcasts the rejection
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
PostgreSQL. The sidecar adds server-owned actor metadata inside the same Yjs
transaction as every writable update; Redis peers therefore receive the edit
and its provenance atomically. It writes under a dedicated marker client id
(moved to a fresh id when a peer's update writes under it), so remote updates
never advance and rotate the room's own client id. Client updates that alter that
metadata are rejected; the check reads the decoded update against the room
rather than applying it to a copy. Because the marker for an update is written
at the marker client's next clock inside the same transaction, the check also
rejects an update that writes under that client, names it as an origin, or
deletes past its held clock; otherwise one crafted update could erase or forge
every later marker. A debounced store snapshots the document and rechecks every distinct
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

`material_yjs_documents.state` stores the encoded Y.Doc and is the durable
content authority. `stored_version` is monotonic. The sidecar converts the
stored `content` root to a Plate envelope and calls the internal Go projection
endpoint.

Go validates the complete envelope, locks the material, ignores stale versions,
updates `materials.content`, increments the material revision, reconciles
flashcard stats, and advances `projected_version`.
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

Quiz and flashcard authoring sends `expectedRevision` from the loaded draft.
The sidecar locks the material row and checks that revision and completed
projection before committing a replacement; its block precondition also checks
the live Yjs content. Rejected saves retain the local draft. Every flashcard set edits through
`FlashcardsEditor` (`src/features/flashcards/`): the workspace file's edit mode,
a standalone set and `/flashcards/$id/edit` for an embedded one. Like the quiz
edit page it stages everything on screen: the card dialog (front, a back of at
most 2,000 characters, one optional image under the front) and Remove change
only the draft, Reset (with a confirmation) restores the loaded set, and Save
(with a confirmation) uploads the picked card images, then writes the whole set
atomically through `PATCH /api/flashcards/{id}/content`, preserving study state
for retained ids and dropping blank cards. There are no single-card endpoints.
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
Commands opened outside the editor retain its stored Slate selection.

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
Hocuspocus sends a stateless `comments-invalidated` room event and clients
invalidate the discussion query.

## Toolbar icons

Plate and PDF toolbar icons use `size-4` (16px) and the shared `Icon` default
stroke width of 1.8, including dropdown chevrons and floating toolbar actions.
`EditorIcon` re-exports `Icon` without a separate stroke override.

`components/ui/Toolbar` shares the fixed toolbar row and groups: 40px height,
8px horizontal padding, zero default button gap, and 28px dividers with 6px
margins. Plate keeps its sticky placement and scrolls enabled groups horizontally with
the shared tabs scroll fade, while settings stay pinned and group preferences
still control visibility. PDF keeps its centered annotation tools, page count,
zoom controls and horizontal scrolling on narrow screens.

Tabs and both toolbar scroll containers share `useHorizontalWheelScroll`.
Vertical mouse-wheel input scrolls overflowing controls horizontally without
React state updates. Horizontal gestures and zoom keep native behavior, and
wheel input passes through at the scroll boundaries.

`components/ui/ToolbarButton` reuses `BASE_BUTTON_STYLE` for shared button behavior
and supplies both editors' 32px buttons, focus/disabled
styles, purple active tint, and dropdown triggers (content width, 4px gap and
16px chevron). Plate's wrapper preserves the editor selection on mouse-down;
PDF supplies its current tool directly. Link, table and column floating actions
reuse the Plate wrapper. Workspace center-header icon actions and Files/Chat/Create
panel actions also use the shared 32px button and 16px icon, including mode and
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
commands through a headless Slate editor (`editCommands.ts`), stores the
inverse and item-run guards of the edited nodes, then fans the committed delta
into the live room as a `service-edit` update; the projection runs on the same
commit.
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

- Viewers never connect, reducing room load.
- Start with one sidecar replica and Redis available.
- Persistence uses bounded debounce/max-debounce and retains failed stores for
  retry. Retry passes do not overlap within a sidecar process, and a retry only
  clears the exact queued snapshot it attempted; a newer failed snapshot stays
  queued.
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
  which is memoized for that reason. The save status is not React state
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
  attributes Plate would. No stylesheet styles those attributes today, so the
  flash itself is invisible.
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

Plate and PDF toolbar popovers share `components/ui/ToolbarPopover`: 8px corners,
4px container padding, gapless 28px rows, 14px medium text and the dropdown
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
using the same fonts and layout as editing and a spoken-math accessible label. This
preserves native placeholders, accents and fractions in notes, question editors and
question/quiz views. KaTeX remains confined to export figures, where empty slots map
to `\square`; saved editable formulas retain their original placeholders.

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
