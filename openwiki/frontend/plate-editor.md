---
type: Frontend
title: "Frontend: Plate.js and Yjs Editor"
description: "Plate v53, the Rust collaboration server as Yjs authority, comment anchors, projections, opening an item, and device copies."
tags: [frontend, plate, slate, yjs, collaboration, ai]
---

# Frontend: Plate.js and Yjs Editor

Capy Notebook uses Plate/Slate for editing and rendering, but Yjs is the live and
durable authority for material content after a room is initialized.

- Yjs owns live material content.
- Go/PostgreSQL own metadata, permissions, comments, and content projections.
- `materials.content` is an eventually consistent Plate JSON read projection.
- A note opens one way (see [opening a note](#opening-a-note)): it paints static
  from its device copy or that projection, then a signed-in reader follows its
  room on a read channel and an editor's Plate takes over. Signed-out and public
  pages render the projection and join nothing.
- Everyone gets the highest mode they may have, with no Edit/View switch
  (materials; Office and text files keep theirs until the ribbon lands).
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

A material has no mode to choose (Epo 2026-11-04): `canEditContent` decides. An
editor gets the live Plate with a `write` room token, a viewer the static renderer
following the room on a read token. `view` remains only as what an editor drops
to when the room turns read-only (frozen, full, an unsupported block), under its
strip. `?mode=` on a material's link is dropped and the saved per-item mode is
gone, so old links open as any link does; the question bank keeps its own Edit
button. Office and text files keep theirs: they remember their last View/Edit in
localStorage, keyed by item kind and ID, take `mode=view|edit` from the URL, and
the header toggle shows the mode it switches to; a successful toggle replaces
that query parameter and a failed transition keeps the editor and URL as they were.

The permission boundary is layered:

1. Go checks `MaterialEffectiveRole` before minting a short-lived token.
2. Signed-in viewers receive `read` tokens for content documents (never quiz
   keys); the collaboration server joins them read-only, never relays awareness
   to or from them and sends them no comment relays and no room presence (Epo
   2026-10-10, 2026-10-20). Narrowed editors (a frozen account, a full owner)
   keep presence.
3. The collaboration server checks the browser origin at the upgrade and, per
   room, the token's signature, issuer, audience, expiry, exact room, schema
   and access.
4. It joins `read` channels (a viewer's, and the downgrade an editor receives
   while their own or the material's payer's account is frozen, or the payer
   (its creator, uploader pays) is at its storage limit) read-only: a step 2 or update holding
   anything new closes the channel, so a modified browser cannot send Yjs
   document updates.
5. A viewer mounts only the static preview, without editor plugins or comment controls.
6. Comment REST endpoints independently enforce the editor ACL.

`MaterialEffectiveRole` is the union of the caller's membership and the
workspace share role, so a viewer member of a link-shared-for-editing workspace
mints a `write` token. See [authorization](../authorization-permissions-lifecycles.md)
for the full matrix.

ACL changes, sharing changes, and deletions publish room eviction events through
Redis. A widening of access publishes nothing, and a narrowing a `revoke` that
closes only the people it took something from (Q634, see
[authorization](../authorization-permissions-lifecycles.md)). Deletion, placement
changes and account locks use discard mode so rejected in-memory state cannot
return. A moved file and a hidden item use drain mode, persisting accepted
pending edits before unload. Account and plan
restoration instead flushes pending stores without closing connections or
unloading the room; later edits continue through the normal save cycle.
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
epoch, then rechecks the epoch before acknowledging delivery. An ACL event can
therefore neither reopen a failed discard nor disappear against a room schema
that a discard replaced.

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
materials. The `/materials/:id` route retains the app sidebar, uses only the
navigation back icon before the title, and hides workspace actions.

The interactive path is:

```text
CenterContent
└── NoteEditor
    └── EditorRuntimeProvider
        └── DndProvider (one for every editor it mounts)
            └── NoteEditorCore (per room and generation: two in a room swap)
                └── Plate + YjsPlugin
                    └── CollaborationProvider
                        ├── NoteToolbar
                        ├── scroll box
                        │   └── PlateContainer (relative)
                        │       ├── PlateContent + link actions
                        │       └── FloatingToolbar (edit only)
                        ├── EditorCommandPalette
                        └── GhostTextSync (edit only)
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
validator refuses a deeper one, and an import (Markdown, DOCX, JSON, an
agent's markdown) clamps it on entry (`clampIndents`). Todo rows use only
Plate's indent;
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

`NoteEditorCore` owns one garbage-collected `Y.Doc`, sends its caret in the
compact [presence](#presence-payloads) shape, and calls Yjs `init` with the
canonical room and `value: null`.
Cleanup destroys providers and disconnects the Yjs editor.

Co-editors' selections arrive through awareness as base64 Yjs relative
positions, the caret's anchor `s` and focus `f` ([presence
payloads](#presence-payloads), `RemoteCursors.tsx`). `useRemotePeers` puts
them in React state only when a peer's selection or label changes, so
heartbeats, pointers and block selections re-render nothing, and
`decorate` resolves them against the document once per document version (or
peer change), so an edit before an idle peer's caret moves it, as comment
anchors do. They are returned for the root entry only: slate-react hands the
root's decorations down to every node they cover, and returning them per block
and text drew each caret three times. A selection is a tinted range
(`data-remote-cursor`); every peer also gets a caret at its focus, a collapsed
decoration that renders as an empty, zero-width leaf with `data-remote-caret`.
Both carry the peer's colour and its label from the [room
presence](#room-presence), never from its awareness: the colour is
`--remote-cursor: var(--peer-<n>)`, n the connection's person number modulo 8,
so every co-editor sees a person in the same colour (Epo 2026-10-28; the
cursors design's eight colours, a light and a dark shade, set on `:root`
and `.dark` in `tailwind.css`), and the label is the verified name
it gives the client id (a listed connection without a name reads
"Collaborator"); a client the presence does not list yet is not drawn. The
`.note-editor` stylesheet paints them: the tint through `color-mix` and the
caret's 2 px bar as a
`::before`, so the caret adds no DOM node to the text and leaves Slate's
DOM-to-point mapping and native caret movement alone. slate-react renders no
decorations inside a void, so a caret on an inline equation is drawn right
after it; a caret on a block void (a block equation, an image, an embed) is not
drawn. Positions beside an inline element resolve through the slate-yjs patch
(Mermaid source below). A peer's `s` or `f` that decodes to a position on a
root type (`tname`) instead of an item is skipped (`decodePosition`; Epo
2026-10-29, Q546): resolving it would make this tab's note `Y.Doc` create
that root type and keep it, one per name a peer sends. Carets always name
items.

The Plate editor initially has a query-cache value so the React tree has a valid
shape before connection, but that value is never supplied as Yjs initialization
data. After sync, Slate-Yjs replaces editor children from the shared root.

Yjs-aware history is installed by `YjsPlugin`; ordinary Slate history must not
be layered on top. Normalizers must be deterministic and idempotent because
they run for remote operations too.

**Opening writes nothing** (Epo 2026-11-04, `roomBinding.ts`). Binding
force-normalizes the whole tree, and each remote change normalizes the blocks
it touched, as local operations slate-yjs sends to the room. Measured in the
browser: a note ending in a table got a trailing paragraph from whoever opened
it (two people opening together left two), and an ordered list without its
`listStart`s got them. So until the person's first real edit in this mount
(`edited`: a local operation outside a normalization that is not a selection)
only Slate's own normalizer runs, and only with operations Yjs holds nothing of
(an empty leaf beside an inline, two leaves of equal marks merging); any other
is dropped. The plugins' normalizers wait for that edit and then see only what
it dirtied. The trailing paragraph comes with the first edit, written straight
into the document under its own origin so it is no part of that edit's Undo
(as an ordinary edit, the Undo would bring it back as a new edit and empty
Redo). Later, `trailingBlockPlugin` adds one only behind a real edit in the same
batch, never for a co-editor's or an agent's change. The note always ends
with "Type / for commands" (Epo 2026-11-17, `trailingHint.ts`): an empty last
paragraph shows it whether or not the caret is in it, and a note ending in
anything else draws it after its last block (`data-trailing-hint` on the
editable, the column's `::after` in `tailwind.css`), written nowhere. A click
below the last block puts the caret in that empty paragraph, or adds one and
puts the caret in it (`openTrailingParagraph`), which counts as the first edit;
from the keyboard Mod+Enter leaves the last block as before. The
checkpoint debounce starts only for a real edit (this person's or an Undo's,
`takeLocalEdit`): a co-editor's change no longer reads Syncing or asks for a
receipt here.
The toolbar subscribes directly to Yjs UndoManager stack events, including
undo/redo and clear, so availability updates without editor focus or selection.
Its actions use the same Yjs history as note editing.

Undo and Redo restore a deleted list item as a copy placed by tracing its old
neighbours' `redone` links. The copy keeps the right neighbour its trace finds
only when that lies after its left neighbour; otherwise it takes the item now
after the left, as a local insert does (Epo 2026-10-24). A traced right with
more than 4,096 items between the left and it gives way to the item after the
left too, which bounds the walk. Without the rule a trace through a copy an
earlier Undo made, later split by typing, can give a right origin before the
origin, and each replica then places the copy by its own block boundaries, so
peers and reloads read the text in another order.
Yjs has it through our pnpm patch (`redoItem` in `patches/yjs@13.6.31.patch`)
and the fork's yrs in `Item::redo` (`third_party/yrs/src/block.rs`), so
browser notes and items, the server's agent Undo and the Office editors all
follow it.

Undo reaches back at most 24 h (Epo 2026-10-23, the in-place collection's
Q2): every stack item of the note editor's history and of the item rooms'
managers records when it was made, and steps older than 24 h by the tab's own
clock are dropped before each Undo and Redo, whoever calls it (`limitUndo` in
`src/features/collaboration/undo.ts`). The server keeps the deletions an Undo
may restore 25 h after they arrived (see [editing
sessions](#editing-sessions)). The toolbar can still show Undo for a step past
the horizon; pressing it drops the step and undoes nothing older. Office
editors keep their own history.

### Room presence

Developer Epo decided the avatar group and verified cursor labels on
2026-10-20, and for privacy the same day that the group has no tooltip and
nothing about a device reaches anyone. The collaboration token names who a
connection is by the user's display name and avatar alone
(`collaboration_tokens.go`): the name without bidi controls, the zero-width
space, word joiner or BOM (`claimName`; the joiner and non-joiner stay, for
Persian names and emoji sequences) and cut to the 60-character user name limit, the
avatar left out past 1,024 bytes (co-editors then see initials). The server
keeps them in each channel's `Context` (`auth::Identity`).

Each room sends its editors a stateless `room-presence` message
(`send_presence` in `room.rs`, `PRESENCE_TYPE`) a flush window after a join, a
leave, a token whose identity changed, or a change in a channel's awareness
client ids, and at most once a second (`PRESENCE_EVERY`). It lists the room's
other connections of people who can edit (`in_presence`: in a material room
every non-viewer channel, an editor's reading tab and a narrowed editor
included; in a source room, which knows only the token's access, its write
channels; a quiz's keys room has none, its page showing the content room's),
oldest first and at most 64 (`MAX_PRESENCE`): each one's person (a number the
room keeps per user while they are in it, never the user id, which a reader
may not learn: Epo 2026-10-12), name, avatar and the awareness client ids it
holds. Only those channels hear it, and an embed's channel inside its note's
hears none (its page's header shows the note's). A member's own connection is
never in its list, so its user appears only for their other tabs and devices.
The ids come from the room's own map of which channel holds which client id,
so a client cannot label a cursor as someone else: labels and the group read
only this message. A channel's awareness lives only under its own bound client
id ([client ids](#client-ids)), so no other user's channel can take it.

The browser (`presence.ts`) hands it to the open editor (`onPresence` on
`RoomProvider`; it goes empty when the channel ends): notes keep it for cursor
labels (`useRemotePeers`), Office files for theirs (below), and both report
it, with items (quiz, set, Mermaid) and text sources (`PresenceContext`), to
the pane's presence store, which the header's avatar group reads
(`RoomPresence.tsx`, labelled "Also in this document"): one avatar per person,
at most three, then +N, with no tooltip; hidden below sm. Hovering spreads the
group as transitions.dev's avatar group does (the hovered avatar lifts 4 px
and grows 5 %, neighbours lift 0.45 as much per step, 320 ms in on the
smooth-out curve and back on the strong bounce; reduced motion keeps them
still).

### Presence payloads

Developer Epo decided on 2026-10-28 that presence payloads are compact,
listed per room kind and checked on both ends (todo-presence.md, measured in
bench/collaboration/reports/2026-10-28-presence-load.md: compact JSON, no
binary format). A note room's awareness state (`notePresence.ts`) holds only:

| field | value | bounds |
| --- | --- | --- |
| `s` | caret anchor: base64 of `Y.encodeRelativePosition` | ≤ 64 base64 characters |
| `f` | focus, the same; absent when the selection is collapsed | ≤ 64 |
| `p` | pointer `[blockId, x, y]` or `null` | id ≤ 64 characters; x, y integers 0–1000 |
| `b` | block selection runs `[[firstId, lastId], ...]` | ≤ 16 runs, ids ≤ 64 |
| `uploads` | upload placeholder ids ([uploads](#stable-ids-and-persisted-node-data)), writers only | ≤ 100 ids ≤ 32 characters |

A source room's holds only `cursor` ([Office cursors](#office-cursors)); a
canvas's room holds a board's `p`, `b`, `s` and `f` (Epo 2026-11-18,
`Fields::Board`: the pointer in whole board units and the selected ids as a
flat list; [the canvas's room](#the-boards-tools), Presence) and a note's
`uploads`, writers only, with the same bounds; an
item room (quiz, set, mindmap, diagram) and a quiz's keys room hold none.
The collaboration server (`presence.rs`, called from `on_awareness` in
`room.rs`) keeps and relays a state only when every field is one its room
kind lists, within bounds, and the state is at most 4 KiB
(`MAX_AWARENESS_ENTRY`); it drops any other silently (presence is best
effort, the channel stays joined) and relays the bytes the sender wrote. A
removal is always taken; a malformed frame is still refused. A read-only
channel's `uploads` is a field it may not send, so its state goes whole. The
browser reads peers' states through the same list (`readNotePresence`, cached
per state object; `officeCursors.ts` for sources) and skips any other.

The tab writes its presence through `setNotePresence`, which sends only when
a field changed and, when the state would pass 4 KiB, leaves out `b` and
sends the rest (Epo 2026-10-28, Q524; the runs go again once they fit). With
real ids it never needs to: 100 upload nanoids, 16 runs of UUIDs, a selection
and a pointer make 3,800 bytes; only ids near their bounds pass the cap (at
most 5,920 bytes, 3,738 without `b`). A caret alone is about 24 bytes. The
caret replaces slate-yjs's `sendCursorPosition`,
inside the 50 ms throttle (`sendCaret`, `cursorThrottle.ts`). The pointer
(`sendPointer`, mouse and pen only) names the innermost block under it by its
stable `data-block-id` and x and y as 0–1000 of its box, at most every 50 ms,
read in an animation frame with that frame's layout, not in the timer (Q547),
and `p: null` when it leaves the editor, the page scrolls (a still pointer
fires no pointermove, so it would name a block it left) or the tab is hidden
or the window blurred, until it moves again; an id the room would refuse goes
as null. `BlockSelectionPresence` folds `BlockSelectionPlugin`'s selected ids
into runs of adjacent siblings in document order (`blockRuns`), at most 16,
none past that. It visits only the selected blocks (Q547): each id resolves
through `blockIndex` over the rendered note and slate's element map, and the
paths order them, an ancestor before its descendants. On the 2 MB load-test
note at CPU x4 a selection change cost the old walk of the whole note about
58 ms, and costs well under 1 ms this way.

`RemotePresenceMarks` draws co-editors' pointers and block selections as Epo
picked from the mocks (2026-10-28, capy-harness
2026-10-28-followups/presence-mocks, P1 and B3): a pointer is hugeicons
Cursor02Icon (`pointer` in `Icon.tsx`) filled with the peer's colour, its
tip at x and y of the block's box, with the name in a pill below and right
of it (left of it within 142 px of the editor's right edge, the widest pill
and its gap). It glides to each new position in 120 ms at one speed (a
`transform` transition, Epo 2026-11-18; a first position, and every one under
reduced motion, is shown at once). Positions are sent every 50 ms and, as
measured on UAT that day, leave the collaboration server and reach
cloudflared one frame per segment 47 to 69 ms apart, but past Cloudflare
reach a far browser in pairs about 100 ms apart (gaps of 0 to 221 ms), so the
tab drew 8 to 11 positions a second in jumps of 27 to 85 px at a hand's speed.
With a 120 ms linear transition put on UAT's own page it moved every frame in
steps of about 4 px and settled about 90 ms later; 80 ms still paused between
pairs, and Liveblocks' cursor guide also finds a linear transition smoother
than an eased one. A block
selection is a 2 px outline 4 px outside each run, from its first block's
top to its last block's bottom, its corners half the theme's
`--radius-button` (capy 4 px, fisheye 6 px, notion 3 px), with the name in a
flag at its top right. A name past 128 px is cut with an ellipsis, in the pill
and the flag. Both use `--peer-<n>` and `--peer-fg` (white on the
light shades, #11111b on the dark), and a block the note does not render
draws nothing. They sit in an overlay in the editor's container, so they
scroll with the note; it lays out at most once a frame and never re-renders
the editor. A peer's marks are placed again (`placeMarks`) only when its
pointer, runs, name or colour change, not on its caret moves; every peer's
when the room's presence, the note's size or the document changes (an edit
can move a block without resizing the note). Marks find their blocks through
`blockIndex`, a map of the note's `data-block-id` elements filled in one pass
and filled again only when an id has no live element, at most once a layout,
instead of a search of the note per mark (review P1, 2026-10-28: on the 2 MB
load-test note at CPU x4 a co-editor's caret move cost the marks about 46 ms
and a pointer move about 70 ms before, nothing and about 38 ms after).

One switch, "Show others' cursors" in Settings › Customizations › Editor
(`EditorSection`, below Chat; `showOthers` in `noteEditorPrefs.ts`, a device
setting, on by default; Epo 2026-10-28, Q542), decides only what this device
draws, in every document type: off, notes draw no co-editor carets,
selections, pointers or block selections and Office files no cursors
(`createOfficeCursors` sends the frame no peers); the header's avatar group
stays, and every tab keeps sending its own presence.

### Office cursors

Developer Epo decided on 2026-10-20 that Office files draw co-editors'
cursors through BetterOffice's own overlays, labelled like notes. Each fork
editor takes a presence object (DOCX `collaboration.presence`, XLSX
`collaboration.provider`, PPTX `collaboration.presence`); the runtime gives
it one over the frame (`officePresence.ts`, an adapter per editor host), so
the fork's providers, which would read names from awareness, are not used.
The editor's cursor goes out as a `cursor` message (at most every 80 ms, the
last always; a DOCX edit's move waits for the next) and Capy puts it in the
source room's awareness (`officeCursors.ts`, `useSourceSession`). Capy sends
the frame the co-editors' cursors as `peers`: each client id with a cursor in
the room's awareness and a name in the room's presence, under that name,
never one from awareness; an id the presence does not list (a reader, or a
peer not listed yet) is not drawn, and neither is a state the source room's
field list drops. A cursor is a DOCX story and its encoded positions, an XLSX
sheet and cell range, or a PPTX slide and shape, each bounded
(`isOfficeCursor` for the frame's messages). In awareness the adapter writes
DOCX positions as base64 (at most 1,368 characters, 1,024 bytes) and the
frame gets its byte arrays back (Epo 2026-10-28); it writes each field by
name, and a state holding anything beside `cursor`, or a cursor with any
other field, is dropped by the server and by `officePeers`. The show-others
switch ([presence payloads](#presence-payloads)) hides them. PPTX `shapeIds`
and Office pointers wait on a BetterOffice change. The flags look as the fork
draws them.

### Idle close

The browser closes a page's collaboration connections after 60 minutes
without keyboard, pointer, touch or wheel input (`idle.ts`, Epo 2026-10-20);
a hidden page gets no input, so 60 minutes hidden closes them too, and
scroll events do not count since pages scroll themselves. Input inside an
Office frame never reaches Capy's page, so the runtime reports it
(`activity.ts`: an `activity` message at once, then at most once a minute)
and Capy counts it as its own (`frameInput`). Each room's channel ends first,
quietly, as a room closed as its user's oldest does (no close or drop
reported; it waits not synced), then the tab's socket closes and stays closed
(`CollabSocket.sleep`). The next input or window focus opens it (`wake`) and
every room joins again, catching up with its step 1 (the small-answer path).
The server keeps no idle timer of its own: the per-user caps bound a client
that ignores this.

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
- the ghost-text suggestion.

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
type through the types the upload takes (`PICKED_IMAGE_EXTENSIONS` in
`src/lib/fitImage.ts`: the stored ones, and AVIF, which the upload re-encodes
as WebP, Epo 2026-11-23), and a type it refuses (an icon, SVG) or any failed
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

A chat answer copied into a note keeps its blocks. The browser's copy of an
answer holds only its rendered DOM, so `copyAnswer` (`chat/answerCopy.ts`, the
answer's `onCopy`) also writes `application/x-capy-answer` when the selection
lies inside one answer: a list of plain-Markdown blocks in the note format,
a callout carried as its variant plus its body (`chat/answerClipboard.ts`).
Each answer block renders inside a `display: contents` element that knows its
Markdown segment (`chat/MarkdownAnswer.tsx`, `answerCopy.ts`). Only the blocks
holding the selection's two ends can be partly selected: every block between
them is rebuilt from its source without its citation markers (every tab, a
closed reveal's body, a chart, plot or html-embed as its fence), and a partly
selected one is read from its DOM up to the selection's end, keeping its shape
(a callout stays a callout with the selected text). Charts, plots, embeds and formulas
(`data-tex`) copy whole once touched; citations, buttons and asked questions
are left out; tabs and reveals become a bold title over their content; a
library figure copies as its caption. `ChatAnswerPastePlugin` (`pastePlugins.ts`) reads each block
like agent Markdown (plain, no MDX) and wraps callout blocks. A selection
that runs past the answer into its own message's model label or sources (a
triple-click on the last line, `data-chat-message`) stops at the answer's
end; one reaching anywhere else, a paste inside a code block or blocks that do
not convert take the ordinary path. For other apps the copy carries the
selection's text and its HTML without the stylesheet: bold spans become
`<strong>`, a formula its `$TeX$`, and buttons, icons and skipped parts
(citations, the incomplete-answer notice) go; some formatting loss there is
accepted.

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
about an upload is stored in the note. A tab names at most 100 uploads of at
most 32 characters (an id is a 21-character nanoid), the note's field list
([presence payloads](#presence-payloads)): a state with a longer list or id is
dropped whole, by the room and by every receiver (REVIEW5 E1, E3). A read-only
channel's state naming uploads is dropped whole, so a reader cannot show
blocks as uploading (REVIEW5 E2; the room parses every state, so an escaped
key cannot slip past, R1, and drops one serde_json cannot parse, though a
browser's `JSON.parse` takes some of it, R1b). Viewers
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
the flashcard grid (`src/features/flashcards/FlashcardGrid.tsx`: numbered
fronts as `CardTile`s; a click turns a tile in place to the front header over
the back (the image left out, an image-only front reading "No text", as on the
study card's back), fading the new face in like the study card, and another turns it
back; a link to a card opens with that tile turned and scrolled to), each under
the material title, and flashcard edit mode is the
live card grid described under authoring below, its tiles turned like the
result pages' (front header over the back, the image small in the header,
Edit/Remove beside the number) (`src/features/materials/CenterContent.tsx`).
Every flashcard grid (View, edit, flashcard and review results) is
`CardGrid` and `CardTile` in `src/features/flashcards/CardView.tsx`, except a
note's flashcards block in Edit, which lists Quick review's small front-only
cards (`CompactCardGrid`, `CompactCardTile`: as many 144px, 160px past phones,
columns as fit, the front cut at the padding, no toolbar: a click opens the
card dialog; a dashed Add card tile of the same size; Epo 2026-10-25).

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
it holds unacknowledged edits. Its rooms join inside the note's channel (Epo
2026-10-20; see [Socket and channel caps](#connection-lifetime-and-refusals)):
the note editor and the live View hold the note's `NoteSeat`
(`noteSeat.ts`, `NoteSeatContext`), and an embed's providers join only while
the note's channel is joined, end with it and join again when it does. Removing the last question or card removes the
block itself (the item follows the removed-block trash rule; Undo restores both). The static renderer takes the page's embed renderer from
`EmbedViewContext` (the app's reads through the account and loads on demand; the
share page feeds the note's public data). Blocks that need the browser in a read-only
render (images, embeds, diagrams, interactive HTML) sit in an `Island`
(`Island.tsx`, views in `staticViews.tsx`): inert in the app, they are what a
server-rendered shared note hydrates, and equations render MathLive's static markup
there (`StaticMathContext`). Inserting through the slash command or toolbar
creates the row through `POST /api/materials/{noteId}/embedded` (a quiz with
one starter question to edit, "What is 2 + 2?" as multiple choice, Epo
2026-10-25; a set with one blank card) and inserts the reference at the top level, where it opens in place
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
and set edits go to the item's own rooms, so the note's own history covers only
inserting and removing the reference. In Edit the embed shows no Undo, Redo or
Saved of its own (Epo 2026-11-17): the embed last pressed lends its quiz's or
set's history to the note (`embedUndo.tsx`: `EmbedUndoLender` around
`AppEmbedEdit` gives its `UndoSink` the embed's box, and `EmbedUndoHost` in
`NoteEditorCore` keeps the one pressed), so the toolbar's Undo and Redo and ⌘Z
and ⇧⌘Z (Ctrl+Y) on the page, not in a field nor a portaled dialog, act on it
as a canvas card's do; a press anywhere else (the note's title, its text,
another block, or outside the note) or the caret moving into the note's text
gives them back to the note. An embed lends only while it edits (not read-only,
in recovery or stopped), and one pressed while still loading lends once it can. The embeds report
their rooms' save state (`embeds/embedStatus.ts`) to the note's frame
(`PaintedFrame`), and the header shows the most pressing of the note's and
theirs (Saved, then Syncing, a draft syncing, Offline, Unsaved, Error); a note
still connecting or opening says so alone, and an embed still opening says
nothing. A question's or card's dialog keeps its own Undo. An agent or API write to an embedded item lands in its rooms, which
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
slash commands' new one-question quiz and one-blank-card set pass their drafts to
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
cannot carry that type and its paste inserted nothing. Unresized charts open at 28rem and graphs at their stored width;
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
sits on the preset's background with no border. Renders run one at a time,
because `mermaid.initialize` is global: each render sets its own preset
(`drawMermaid` in `mermaidDraw.ts`), and mermaid scopes the output CSS to the
SVG id, unique on the page, so blocks in one note keep their own themes.
Frontmatter config would scope too, but mermaid's sanitizer blanks font stacks
containing hyphens. Hand Drawn draws in Excalifont with plain strokes; its
roughen filters are gone (Epo 2026-10-23): they never applied on the page,
and in the worker their bounding-box region erased straight lines (sequence
lifelines, messages, loop boxes) in Chromium and WebKit. `drawMermaid` also sets mermaid's top-level `fontFamily` to the
theme's (mermaid's default ends in `;`, so the page used to drop it and
measure some ER, class and sequence labels in the app's body font) and
`handDrawnSeed: 1` (the class and ER shapes mermaid draws with rough.js came
out different each time).

**Rendering in a worker** (Epo 2026-10-22). mermaid.js runs in one dedicated
module worker (`mermaid.worker.ts`) on a DOM shim (`mermaidShim.ts`): linkedom
for the tree, and the geometry mermaid reads (`getBBox`,
`getBoundingClientRect`, `getComputedTextLength`, client sizes) computed from
attributes and OffscreenCanvas text metrics. The shim has no layout engine: a
small cascade (inline styles, the diagram's own stylesheet with `!important`
and specificity, presentation attributes) gives each element its font and
side padding; an HTML label is laid out as mermaid's `createText` styles it
(nowrap up to its max-width, then wrapped at its width, line height 1.5,
inline widths rounded up to 1/64 px as Chromium does), in its text element's
font, with a padded span's line kept and a block inside it splitting the
line; an SVG text box collapses white space, takes a tspan's `dy` over its
text's, and spans the ink past the advance (`actualBoundingBoxRight`). A
worker has no font settings, so its `sans-serif` is another face: the page
finds the faces its generic families draw in (`genericFaces` in
`Mermaid.tsx`) and sends them with each draw; theme fonts load into the
worker's `self.fonts`. The page sends one draw at a time
(`renderMermaid`): a queued draw no caller wants when its turn comes is
skipped (a newer source superseded it), and one already drawing finishes
into the cache (Epo 2026-10-23). The worker posts `started` once everything
the draw needs is in: mermaid, the theme preset and its fonts, the diagram
type's code and its layout's (mermaid has no loader per type, so the worker
draws the type's small source in `MERMAID_TYPES` once before its first
diagram of that type), and KaTeX for a source with `$$` math. A draw still
running 30 s after that (`MERMAID_RENDER_LIMIT_MS`) stops, the worker with
it, and the block says "This diagram is too large to draw on this device."
A worker that has not started 30 s after the request, any failure before
`started` (a download: the worker tells it from a source error by where it
happens, never by the error's message, which can echo the source; review r3
L1, L5), the page's DOMPurify failing to load, or an error escaping the
worker says "Diagrams couldn't load." and stops (Epo 2026-10-23, review r2
M1/M2, r3 L3). A theme font that fails to load fails the draw the same way,
and the next draw loads it again. Neither result is cached, nor is a
missing worker: only failures the source causes are kept, so the next view
draws again, in a new worker. The page sanitizes the worker's SVG (`forPage`: DOMPurify with
mermaid's foreignObject setup, our forbid lists and no form controls, then
every `<style>` but mermaid's root stylesheet removed, then `withSafeLinks`):
DOMPurify finds no document implementation in linkedom, so mermaid's label
pass does nothing in the worker and the page's pass is the sanitizer (review
H1 and L6, Epo 2026-10-23). Each inserted copy makes every id the SVG
defines its own (`ownIds`): the root id, which prefixes most ids and scopes
the stylesheet, becomes the copy's, and every other defined id (the ids
mermaid counts per worker, such as sankey gradients and sequence actors, and
any id a label's HTML sets) takes the copy's id as a prefix, with every
`url(#…)`, `href="#…"` and aria reference, so a block and its full-screen
preview, or two drawings from different worker lifetimes, never share one,
and no label can claim another diagram's ids (review L1, r2 L2, r3 L2). Drawn diagrams are cached in memory by theme and source (and
width for a gantt chart, which spans its box), up to about 8 million
characters of SVG in all (`CACHE_CHARS`, oldest dropped first), shared by
the block, the full-screen preview, View/Edit and exports, so opening full
screen or switching mode does not draw again. The worker ends after 60 s
without a draw (`WORKER_IDLE_MS`); a warm-up extends that. A block draws once it comes within a
screen of the viewport (`useNearScreen`), showing "Rendering diagram" until
then; any mounted diagram starts the worker (which loads mermaid as it
starts), the page's generic-face probe and DOMPurify at idle (`warmMermaid`,
Epo 2026-10-23), so a diagram scrolled to later waits on neither.

The worker draws only the types the geometry check covers (`MERMAID_TYPES` in
`mermaidTypes.ts`, one source each in `e2e/fixtures/mermaid-sources.ts`, a
unit test keeping the two equal; Epo 2026-10-23): every type mermaid 11.16.1
registers, by detected id: architecture, block, c4, class and classDiagram
(`classDiagram` and `classDiagram-v2`, one renderer), cynefin, er, eventmodeling, flowchart-v2 and
flowchart-elk, gantt, gitGraph, info, ishikawa, journey, kanban, mindmap,
packet, pie, quadrantChart, radar, railroad (plain, ABNF, EBNF and PEG),
requirement, sankey, sequence, stateDiagram, swimlane, timeline, treemap,
treeView, venn, wardley and xychart. A type mermaid does not ship (an add-on
such as ZenUML) or misspells fails mermaid's own detection: "This diagram could
not be drawn". A registered id outside the list, the renderer-v1 `flowchart`
that a `defaultRenderer` directive picks, is unsupported: the worker refuses
it before drawing (`mermaid.detectType` against mermaid's site config, which
a diagram's directives never reach, review r2 H1) or after (by the drawn
`diagramType`). `drawMermaid` clears mermaid's directives
(`mermaidAPI.reset`) before it initializes, so no diagram's config reaches
the next draw by any path, the image check's type detection included
(review r3 M1). There is no main-thread drawing path. An unsupported type
says "This diagram type isn't supported." and a browser without a 2D
OffscreenCanvas (Safari before 16.4) or module workers (a `Worker` that never
reads its `type` option) says "This browser can't draw diagrams.", both
checked on the page (review r3 L4); every Mermaid error shows in
`MermaidError` as a source error does, everywhere (block, preview, chat). A
Word export writes a diagram that cannot be drawn, for any of these reasons,
as its source in a code block, as Markdown export does (Epo 2026-10-23). The geometry check (`e2e/editor/mermaid-geometry.spec.ts`) draws
each type in the worker and on the page (`drawMermaid`, then the same
`forPage`) and compares the detected type and every element's numbers
(positions, sizes, path points, transforms, the viewBox) within 1.5 px, in all
five themes, so a mermaid upgrade or a shim change that moves anything fails
CI. That exact check runs in Chromium, where Windows and Linux both match;
only the timeline's title (font-size `4ex`) is about 1 px off, since canvas
exposes no x-height. Firefox and WebKit lay text out a few pixels apart, so
there the same spec (`e2e/editor/playwright.mermaid-engines.config.ts`, CI
job `e2e_mermaid_engines`) lays both drawings out and checks every worker
label with text against its box: an HTML label against its foreignObject,
an SVG text against the drawing and the smallest rect, polygon or path whose
box holds its centre (a node, a bar, a cell). A label may reach past its box
by no more than the same label on that engine's own page drawing, plus 1 px,
which keeps mermaid's own placements (info's version line and a radar's axis
names past the drawing, a sequence `loop` tab), and no two labels may overlap
more than there; labels pair up by their place in document order (Epo
2026-10-23, review r3 M2). Info, radar, sankey and treeView have no box
around any text (a version line, axis names around the web, names beside
the bars, a tree drawn in lines), so their texts are checked against the
drawing only, as are titles, axis ticks, legend entries and edge labels in
other types. The check's first WebKit run found that WebKit does not pass a
text's `dominant-baseline` down to its tspans, as Chromium, Firefox and the
shim do: ishikawa causes drew about 4 px above their boxes there. Every
drawing's stylesheet now says a tspan without its own inherits it
(`TSPAN_BASELINE` in `mermaidDraw.ts`), which changes nothing in Chromium or
Firefox.

**Scale.** A block never shows a diagram below half its natural size
(`MIN_SCALE`, Epo 2026-10-22): the SVG keeps a minimum width and height of
half its viewBox, and the box (at most `min(70vh, 48rem)` tall) scrolls both
ways instead, centred while it fits (`justify-center-safe`). Large diagrams
stay inline SVG. The full-screen viewer fits the diagram and zooms to at
least its natural size (`maxScale` = max(8, natural / fitted width),
`MermaidPreview`).

A diagram loads nothing from outside the page. In the worker nothing can
fetch (linkedom loads nothing and there is no document), and `drawMermaid`
makes the source inert before `mermaid.render` (`mermaidSafety.ts`). It locks the
`strict` security level, keeps a `dompurifyConfig` forbidding `img`, `image`,
`source`, `style` and the like (a no-op in the worker; `forPage` applies the
same lists on the page), and front
matter and `%%{init}%%` directives cannot turn `themeCSS`, a font stack or
those keys back on (mermaid's own `secure` list, extended). Over that, the
source drops what config cannot reach: a line naming a CSS image function
(`url(`, `image-set(`, read through HTML and CSS escapes, character and mermaid
entities, and across mermaid's directive cuts) is blanked keeping its line
number. That is any line containing `url(` or `image-set(`, so a label whose
text writes `url(` loses its line too ("the URL (a link)", with a space, is
kept). This filter, not the sanitiser, is what stops an inline `style` in a
label from fetching: labels keep their inline styles. An image node's `img` or a sequence actor's icon is removed when
mermaid's own parse says the diagram draws an image. A diagram that needed a
removed part still draws, minus that part; one that still names or draws an
image across lines after the pass is refused. Links stay clickable (`click …
href`, Epo 2026-10-15): after `mermaid.render`, every `<a>` in the SVG gets
`target="_blank"` and `rel="noopener noreferrer"`, so the outside page opens in
a new tab and cannot reach the Capy tab; mermaid's strict mode already leaves
a `javascript:` target's anchor with no href. The one `renderMermaid` serves
every surface — chat, note blocks, mindmap and diagram files, shared-page
islands and the export rasteriser — so this covers them all; a worker's SVG
is sanitized on the page before any of it is inserted. The app's
report-only image policy (deployment-runbook §2.4) is a backstop, not the fix.
Preset fonts (Excalifont, vendored Latin subset in
`src/assets/fonts`; Comic Neue from `@fontsource/comic-neue`) load through
`FontFace` into the worker's (or the page's) font set before the render,
since mermaid measures labels while drawing; a failed font load draws in the
fallback font. Inter, first in the Linear stacks, is not shipped: both
threads fall through to the next installed face. In edit mode the hover toolbar has
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
A source is capped at `MERMAID_SOURCE_MAX`, 50,000 UTF-16 units (mermaid's own
`maxTextSize`), one embed-catalog limit on every layer (Epo 2026-10-22): an edit
(typing, paste, Undo) in the dialog or a diagram file's editor that would take
the source past it is refused with "This diagram is over 50,000 characters."
(`lengthBound`), while other peers' edits and shrinking edits always land;
`renderMermaid` refuses a longer source before drawing it with the same
message, and mermaid's 500-edge limit ("Edge limit exceeded") says "This
diagram has more than 500 links."; the browser's document check, Go's
`materialdoc` and the collaboration server's store and room admission refuse
a longer source ([embeds](../embeds.md)).
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
fewest changes, and an insert or a clone (a move) creates the text. The patch
also resolves a position that falls on an inline element (the empty text before
or after an inline equation or a link), which stock 1.0.2 returns as no point,
to the text beside it, so a co-editor's caret there is drawn. The
editors bind CodeMirror to the text itself (`yTextCodeMirror.ts`: local
changes go in under the binding's origin, remote ones come back as one
CodeMirror transaction kept out of its history); the note block's dialog finds
it by the block's path, top-level or nested (`mermaidSourceText`). A source a room still holds as a
string (written before shape A) becomes a text when an editor first binds it,
outside every Undo. The Rust server bootstraps sources as texts, reads them as
their strings in the projection and the metrics, bounds a string typed into
one by its escaped bytes (no copy of the room per keystroke), and writes the
source of a block an agent's `replace_block` puts in as a text too (Epo
2026-10-21: `set_mermaid` is gone, so an agent replaces the whole block). The
rewrite expects the source the agent inspected, so typing in it since makes
the edit stale, and keeps the block's caption, width and theme as they read (Epo
2026-10-22, `keep_caption` in `crates/notes/src/edit.rs`). Its admit lets a text in as `source`
on a `mermaid` block only, with strings and nothing else inside
(`collaboration-rs/crates/notes/src/limits.rs`): a text under another key or
on another element, a block retyped while it holds one, and a format, embed,
nested type or attribute inside a source are refused.

A chart's, plot's or graph's `block` is the figure map a quiz room's block
entry holds, without the entry's `order` (Epo 2026-11-16, D15; the catalog's
`sharedMap`, openwiki [embeds](../embeds.md#live-figures)): plain fields each
replaced whole, a graph's `board` a map of its fields and its `elements` a map
of element id to `{element, order}`, a chart's `series` and `labels` maps of
id to order key with `names` (id to name) and `values` ("series/label" to
number, an empty cell no entry), a plot its fields alone. No Y.Array sits
inside a figure. One reader, one diffing writer and the one-entry writes serve
both rooms (`src/features/figures/figureMap.ts`, its Y.Map helpers in
`figures/yMaps.ts`; `quizzes/liveFigures.ts` re-exports them). A graph's
element entries have one writer wherever they are held, quiz, note and the
canvas plane alike, and so do a canvas chart's bars, pie labels and pie
lines (`writeElements` in `src/features/graph/keyed.ts`, for any item with
an id; D10, Epo 2026-11-22; the one-entry `setElement` and `moveElement` go
through it too): an element
alike its stored one (the same object, or equal JSON, as a note's Slate value
hands fresh objects) keeps its entry, and order keys come from `risingOrders`
(`src/lib/orderKey.ts`), which keeps every held key that still rises in the
wanted order (the longest such run), comparing `(order key, id)` as readers
sort, so appending re-keys nothing held, a tie two editors' adds left stays
(re-keying it would rewrite the whole entry over a peer's edit), a moved
element alone takes a key between its neighbours, a new element placed
between tied neighbours re-keys the later tied neighbours, and each gap is
placed the same way between its neighbours, so a held key inside it stays;
each entry is written at most once. A chart's series and labels are aligned by `alignPlaces`
(`figures/align.ts`, used by `alignAxis`). One Rust
module (`collaboration-rs/crates/notes/src/figure_map.rs`) reads, writes and
admits them for notes and `items::quiz`. Two editors' changes to different
fields, elements, series, labels or cells merge; a reorder and an edit of
another element both land; the same field takes the last writer. Slate holds
the plain block. The slate-yjs patch hands a figure's `block` to a codec that
`src/features/notes/figureBinding.ts` registers (`setFigureCodec`: create,
edit, read; a figure met before the binding loads throws): it reads the map as
the plain block (unrepaired, `heldBlock`), turns a remote change anywhere
inside it into one `set_node` of the whole `block` on the owning element (once
per transaction), writes a local `set_node` as a diff onto the held map
(`writeFigure`: only the entries that changed), and makes the map on inserts
and clones. A table view keeps the patch's shared lists. Undo is the room's
Yjs undo manager, as for any edit (`notes/figureMap.test.ts`). The note's
figure (`VisualBlockElement`)
re-renders on a peer's change and draws the block repaired
(`repairFigureBlock`). A chart's or graph's Edit opens the quiz's figure
dialog live (Epo 2026-11-16, D15; `LiveFigureDialog` in
`blocks/VisualBlockDialog.tsx`, `BlockDialog` in its binding mode): no draft,
no Save or Cancel, Done only closes, Remove block takes the element out, the
same dialog and behaviour as in a live quiz (see the quiz's figure dialog
below). Its binding (`noteFigureBinding.ts`, over `localFigureBinding`)
writes each change as one Slate `set_node` of the figure's `block` in the
note's own editor, an ordinary note edit: bound, the codec writes only the
entries that changed (one moved point is one element entry, one chart cell
one value entry; `noteFigureBinding.test.ts`); unbound (the editable saved
copy before the room joins) it is a copy edit like any other. Writing the
figure's map directly under the editor's local origin was measured and
dropped: slate-yjs skips its own origin's events, so Slate would hold the
old block until mirrored, and an unbound editor has no map to write. The
element hands each change of its block from elsewhere (a peer, an Undo) to
the binding (`receive`), so the open dialog follows it. The binding gives a
chart's series and labels handles of its own (the plain block has no ids):
its own changes keep them, and `receive` carries them across a change from
elsewhere by `alignPlaces`, the rule the room's chart writer keeps its ids
by, so a cell left after a peer inserted a series above it still writes its
own series, and a handle that went meanwhile writes nothing. Undo is the note's (Cmd+Z in the note, its
toolbar): the dialog's writes join the note's Yjs history, transactions
within the undo manager's 500 ms merged into one step (a typed row writes at
most once a frame, a drag once on drop, a typed field once left), and an
Undo while the dialog is open reaches it as any change does. The dialog's
fields keep their own undo: the element stops a React `input` from the
portaled dialog (a field's `historyUndo`) before slate-react, which would
run the note's Undo. A chart or graph inserted from the slash menu or
toolbar goes into the note at once and its element opens the dialog as it
mounts (`openFigure.ts`); Remove block is the way out (there is no Cancel
that leaves nothing). A new graph holds no blank description, which a
note's figure check refuses. A viewer, or a note that is read-only, shows no
Edit and renders no dialog. A plot keeps its draft dialog (`PlotDialog`):
its draft follows the live plot field by field, series by index
(`rebasePlot`: the user's changed fields keep the user's value), and Save
writes the user's changes onto the plot as it is then; a new plot goes in
at its Save. No merge is refused (Epo 2026-10-18):
readers draw it repaired, a chart or plot left without series as an empty
frame and a pie without a positive value through the chart's empty state. The
editors show a merge's raw block with its issues: a chart's rows past its
labels, a pie's other series (Remove last series shows for it), its negative
or missing positive value, no series (Add series shows even on a pie), and a
graph's rows naming a gone point, each marked (a plot's Save held until they
are fixed). Series and graph rows two editors' adds merged past the cap, or a pasted or
duplicated figure that held them, are
no issue (Epo 2026-11-22, "Yes, A everywhere"): readers and editors keep them
up to twice the cap (`mergedCap`, `src/api/mergedCap.ts`) and each edits as
any other. An add stops at the cap as the figure reads when written
(`addChartItem` gives no id, `graphFull` hides the graph's new row), a
whole-figure write (`writeFigure`) removes only the series and elements its
read showed, so a pie's other series or a row a read leaves out stays, and
Remove last column takes the last series on screen. A graph stores no picture (Epo
2026-11-16): every view, the editor's and readers', draws its elements (repaired)
with the graph engine (`GraphView`, [embeds](../embeds.md)), so a co-editor's
change shows as it arrives and nothing is written back. The Rust server writes the same maps on bootstrap and an agent's insert
(`figure_map::insert`, then `figure_map::sync`, the diffing writer quizzes'
`sync_block` uses) and an agent's `replace_block` of a figure with the same
keys writes a diff too (`set_nodes_at`); it reads them in one place
(`plate::map_value` through `figure_map::block`, behind `plate::block_value`),
so projections, checkpoints, search text and exports see the plain block.
Room admission takes a block as its map only and refuses a crafted update
that puts an unknown key, a wrong type, an oversize value, a stray map or a
list into one (`figure_map::check_field`, `check_entry`, `check_held`; where
the relaxed check for a merge's kept states runs:
[embeds](../embeds.md#live-figures)). Rooms stored with the old list layout
were reset by migration 0179 ([runbook](../deployment-runbook.md)).

A note's table view (`table_view`, Epo 2026-11-12, AFFiNE's database look:
`src/features/notes/tableView/`) is a top-level void like a figure, edited in
place rather than in a dialog. `TableViewElement` writes every edit the same
way a figure's Save does: the pure edit in `edit.ts` runs on the block as the
editor holds it at that moment and the result goes through one `setNodes` of
`block`, so only the columns, rows and views it touched change in the room's
map (an edit that would break `isTableViewBlock` throws). Lists two people's adds
merged past a cap (options, columns, rows, views, a row's keys) are kept and
read up to twice it, as every layer's check takes them (Epo 2026-11-22, "Yes,
A everywhere", replacing the 2026-11-12 refusal); such a block takes edits as
any other. Text, title and number cells write on Enter or
leaving the field, select and date cells from a popover (`SelectEditor`, the
schedule's `MiniCalendar`), a checkbox on click; a column header opens
`ColumnMenu`; the title cell's pill opens the record's menu, whose Open (and a
Kanban card's click, or a read-only title cell) opens `RecordDialog`: the title
as a large field, every other column a labelled row with the same editors, and
Delete record (the app's Dialog, a full-screen page on phones). The editor's
table and the read-only `TableViewTable` (View, Preview, share pages) share
their layout through `display.ts` and `cells.tsx`: fixed column widths (the
title 140px on phones) and an end column (the editor's + sits in it) that takes
the rest, so every row's line runs the block's width as AFFiNE's does (Epo
2026-11-12), 36px rows, one-line cells cut with an ellipsis, so a
note's table keeps its shape between View and the editor. The open view is
each reader's own state; Sort and Group by are stored on the view. The block's
own buttons (+ view, Sort, Group by, New record above it, + column, the
+ New record row and a Kanban lane's + New) are muted and take the text's ink
on hover with no background (Epo 2026-11-19); tabs and cells keep theirs. A view's
menu (its name and Delete view, never the last view) opens on a press on the
open tab or a right-click on any tab, which also opens that view, as Notion's
and AFFiNE's do (Epo 2026-11-17); the right-click is the tab's alone, not the
block's menu. A selected table view, like a figure, draws the block
selection's tint: a void block keeps the overlay in its spacer span, which the
tint rule in `tailwind.css` also reads. A Kanban
card drags with its own data type (`application/x-capy-table-view-record`) and
stops the event, so neither Slate's drop nor the block drag reads it. A
read-only note draws the same component with only its tabs live. The slash
menu's Table view (searchable by "database") inserts `newTableViewBlock` with
translated names, refused past `TABLE_VIEW_MAX_COUNT` with a toast; the
`blockCountCaps` plugin's `insertNodes` and `insertFragment` leave out table
views and interactive blocks past `TABLE_VIEW_MAX_COUNT` and
`HTML_EMBED_MAX_COUNT` the same way for block Duplicate and paste
(`blocks/countCaps.ts`, checked on the note as it reads now; a merge of two
people's inserts may pass a cap, up to twice it, Epo 2026-11-22). A pasted or
duplicated table view keeps the rows, columns and texts it holds, up to twice
their caps, as a figure or Mermaid diagram does. An edit
that would pass a cap against the block as it is when written does nothing. The block's
fields keep their own undo: the wrapper stops React `input` and native
`beforeinput` from reaching slate-react (which would run `editor.undo()`), and
`fieldHistory.ts` holds back Cmd+Z in a field once its text is back to what it
held when focused, since the page's single native undo stack would otherwise
undo the note's own typing next.

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
a graph's block holds its elements and no picture; the note export draws it
to SVG (`exportGraphSvg`, a formula's glyphs as outlines) and then to PNG like
the other figures.
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
on Save (Epo 2026-10-17; Chart and Graph go in at once, above); its hover toolbar has Edit,
Copy and Delete like a chart's, Edit opening the plot editor in the figure
dialog (`PlotDialog`), and exports draw it like a chart with its points
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
is refused by name, as is an agent edit that would leave the note with more
than twice the ten (`invalid_input`, the collaboration service's whole-note
check, which takes up to 20, what two people inserting at once may leave: Epo
2026-11-22). Go
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

- a spinner with no words (`opening`): the first handshake, behind the painted
  note. Only Office and text files still read `Connecting…` and `Reconnecting…`,
  until the ribbon lands;
- nothing new for a later drop while the browser is online (Epo 2026-11-04): the
  last state stays for 30 s and the editor stays mounted and editable, and
  unsent work reads `Syncing…`;
- `Syncing your draft…` with the spinner (`syncing-draft`): a stored draft's send
  while it opens, view-only, with no strip;
- `Syncing…`: edits waiting for the checkpoint debounce or durable acknowledgment;
- `Saved`: the server confirmed that a state containing this client's work was
  committed, or the room synced with nothing of this client's to store (Epo
  2026-10-20: the same in every format; only the PDF annotations' REST save
  still shows `Synced` before its first write);
- `Offline`: the room cannot be reached (the browser is offline, or
  reconnecting kept failing for 30 s); an editor that synced once keeps
  editing on this device (see [Offline editing](#offline-editing-and-drafts));
- `Not saved. Retrying…`: a store failed and the server is retrying it;
- `Cloud unavailable`: the first connection never synced, or the
  provider could not start.

The header shows these as Hugeicons cloud icons beside the title, on its
top row at every width, phones included (Epo 2026-10-20): CloudUpload
for Syncing (and a source's Connecting and Reconnecting), the plain Cloud for Saved (and the
PDF's Synced), CloudOff for Offline, and a red CloudAlert for Not saved and
Cloud unavailable; a live item's footer status uses the same icons.
Office and text sources report the same states into the same slot
(`EditorStatusContext`, `sourceHeaderStatus`). Localized labels remain in
keyboard-accessible tooltips and the live status text for screen readers.
Every file's header (notes, quizzes, flashcards, diagrams, text, Office and
other files) also shows the label beside the icon from md up (Epo
2026-10-22; `EditorSaveStatus` `labelFromMd`: one span, screen-reader text
below md and visible from md).
Pending work preserves Offline and error indicators. An older
checkpoint acknowledgment cannot report Saved while newer edits are debouncing.

Saved means stored in the database (Epo 2026-10-19): the debounced store's
receipt (`checkpoint-persisted`, the same receipt that deletes the stored
drafts it covers), at most about 10 s after the last edit for notes and live
items and 30 s for Office and text files, never the room's acknowledgment.
Until it, the state shows Syncing. Notes and sources report Saved only on that
receipt (`NoteEditorCore.tsx`, `useSourceSession.ts`). A live item (a quiz, a
flashcard set, a live Mermaid diagram) shows Syncing while the room has not
acknowledged its updates and then until a receipt covers them (`itemRoom.ts`
asks for it once they are acknowledged), then Saved, as it is when it joined
with nothing of this device's to store. A press with no edit sends nothing, so
it never shows Syncing ([office-files](office-files.md)).

### Connection lifetime and refusals

Room tokens live five minutes. A minute before expiry the server asks the
channel for a fresh token in band (`TOKEN_REQUEST`); the provider answers
through its `token` function (`TOKEN`), and the server verifies it, rechecks
access and re-arms both timers. A channel that cannot answer is closed at
expiry with code 4401. A room closed on an open
socket (expiry, eviction, an access recheck, one person's access change) only emits the provider's `close`,
never `disconnect`, so `roomReconnector` (`src/features/notes/roomConnection.ts`)
rejoins with a fresh token after `reconnectDelay`
(`src/features/collaboration/reconnectDelay.ts`, Epo 2026-11-24): a random
wait up to a ceiling of 1 s, doubling to 30 s while refusals repeat ("full
jitter"), so the clients one close cut off do not all join at once. The tab's
socket waits the same way after a drop, and the browser's `online` event
starts its backoff over: it opens within the first attempt's random 0–1 s.
Authentication refusals carry reasons: `collaboration-read-only` drops to view
under the read-only strip (it names no reason: a demoted viewer, a frozen
account and a full owner all see it, and the account banner explains the
account cases), `collaboration-not-found` (trashed or deleted) and
`collaboration-forbidden` (lost access) keep the page, a reader's as it was and
an editor's read-only under the "You no longer have access" strip, and the
page asks for its read, after a 4403 close too (Epo 2026-11-20, "the page
should itself refetch and show the 404 error", narrowing Q644): a refused read
shows "This item is unavailable" (see
[authorization](../authorization-permissions-lifecycles.md)), a read that
still answers keeps the strip, and a demotion (a read token) is unchanged.
A demotion's notice comes first: the role-change notification reads the
workspace and its open items again at once (`recheckWorkspace`), view-only now,
while the rooms' 4403 comes 1 to 2.5 s later through the outbox. An item a live
answer said this person may edit (its read answered a fetch on this page or in
the 10 s before it opened, `freshAnswer` and `answeredAt`; never its device
copy, the kept workspace read or a cache write such as a mutation's rollback;
nor a trashed read, every right off, so one deleted and restored while open
edits again) drops to view when that read or the workspace's says they may
not (`canEdit` false; a full payer's storage takes no right and keeps its own
strip), under the same read-only strip (`MaterialContentBody` in
`CenterContent.tsx` reports it as its rooms' read token would). Its rooms'
close and read token after it change nothing more; the view then opens as any
reader's, a quiz's dropping its keys copy. Without the notice first (none, or a
late one; UAT 2026-11-20) the rooms say it: a quiz, set or diagram editor
reports a room turned read-only to the page (`useReportReadOnly`) once a token
on this page gave it write access, so someone demoted while away opens with no
view-only cue (D1), their copy's editor paint going quietly to the reader's
view. A first token that reads while the item's read says they may edit
(demoted between the two) asks for that read again, which then lowers the page
as above. A quiz's keys asking a token as the demotion lands, at their first
(`ItemRoom.start`) or at a rejoin after the 4403, are refused as read-only (403
`collaboration-read-only`), which reads, joining nothing more, never as lost
access or a retry into the offline strip; the quiz then reads on its content
room alone (`useQuizRooms`). A quiz or set lowered here edits again once a read
answered after it says this person may (Q642 C): raised again (the notice's reads) or its
payer's storage freed, the page drops its strip and the editor opens anew. A
note or a diagram stays read-only until a reload, and every kind keeps a
code's strip (lost access, an unsupported block).
When the item had worked on that page first (a room of it synced, an
editor's or a reader's, any kind: notes, quizzes, sets, diagrams, canvases,
Office and text files; or the page's read answered a fetch showing the item
live, not trashed, while it showed the item or in the 10 s before it opened,
such as a hover's preload or the route's loader, whatever the read's stale
time, so an answer from an earlier visit does not count; never a cache write
such as `setQueryData` or a restored store: a cache subscription that skips
manual updates, and `freshAnswer` in `queryClient.ts` over the query cache's
`onSuccess`; `markItemWorking` in `roomRefusals.ts`, which marks only an item a
page watches, so an embed's or a card's room marks nothing, and the mark lasts
while the page shows the item, past a room replaced meanwhile, such as a tab
hidden for 5 minutes), a read then refusing access (403 or 404,
`isAccessRefused`; a 410 deleted, 409, 422 or 401 still shows the page's own
state but toasts nothing, and so does a 404 for an item whose read had shown
it trashed, its purge being a deletion) also shows an error toast titled "You no longer have
access" with no body, once per item, under the one id `access-lost` the
workspace's removal toast has too, and the lists showing the item read again
(its workspace's Files panel tree, the Files page, Recent, block, canvas,
Study and Continue lists), since the tree event hiding or unsharing raises
refetches only the open workspace's file, material, topic and canvas lists,
and a removed member's page shows the workspace unavailable (Epo 2026-11-20,
`useAccessLostNotice` in `accessLostNotice.ts`, used by `CenterContent`, a
canvas's board, the canvas picker and the account Canvas page's quiz or set
dialog). That holds in either order: the tree event reaches members at commit
and the room's drain or 4403 comes 1 to 2.5 s later through the outbox, so a
hidden note's list may drop it first and its header's read (the list no longer
carrying it) refuse before the room does. A file with no room (a PDF, an image,
or a viewer who never joins one) hears it from its list alone: its header reads
the file again once its workspace's files list no longer holds it. A kicked
canvas's board goes for the unavailable panel and its picker, read again, shows
another canvas; when the picker's list drops the canvas on screen first, its
read of it refusing toasts before another canvas shows. A member's shared
canvas its maker trashed answers that read 410 `item_deleted` (review
2026-11-20), so the picker keeps it on screen while it asks and once deleted,
and its board shows what its room says: the deleted strip with Download over
the unsent strokes, no toast. The picker asks that read afresh each time its
list drops the canvas on screen, never taking an earlier answer for it. Edits a board shows to copy stay whatever the
read says. An item simply opened unavailable, a stale copy painted before its
read refused included, an item opened from the Trash, one deleted, or one whose
content cannot be decoded, says nothing more.
The service's not found alone, an item room's or a source's, and a source
save failing `lostAccess: "not_found"` (a trash only queues the room's
eviction, so a save may land first) ask a fresh token first (review
2026-11-20): `item_deleted` keeps the edits under the deleted strip, a granted
token or a 409 (restored since) rejoins, and only a 404 (an item room's 403
too) goes on as above (a source save's back to the last save, its drafts
dropped). No answer (offline, a server error) keeps everything: an item room
joins again with its device copy, a source keeps its edits for the file's
read.

`collaboration-outdated` stops the editor
for the page load (see [Client protocol](#client-protocol-and-the-release-nudge)),
`collaboration-unassigned-id` is not retried (see [client ids](#client-ids)),
and anything else (an expired token,
a room being reset, a client-id clash) is retried. A loss still unresolved after 30 s while
online puts an editor that synced once into offline mode (before the first
sync it turns the status red). A join, first or after a reload, has the same
30 s from its start, which is its collaboration-token request (or the new
mount, for a new mount of the same room; Epo 2026-10-23): `NoteEditor` keeps
that start and the editor's `roomReconnector` counts from it (`started(at)`).
A first open whose token has not answered by then shows a strip with Retry over
the painted note instead of loading for ever (Epo 2026-11-04); an editor not
synced by then, a JOIN never answered on the open socket included, turns the
status red under the same strip, and after a reload that failing editor replaces
the paused one.
The editor binds to the room's document (`YjsEditor.connect`) only at the
room's first sync (`roomBinding.ts`, CAPY-WEB-7). Plate's init binds after
waiting at most 5 s; bound to a document the room had not filled, the editor
showed it empty and kept a paragraph the document never got, which broke
every later Yjs mapping. Until it binds, an editor painted early (red because
its join ran out first, or offline with no earlier sync on the device) shows
the saved copy, editable (Epo 2026-10-24, Q229): the projection, or the
newest copy this device kept. Binding replaces that tree, merges what was
typed into the copy (see [the editable saved copy](#the-editable-saved-copy)),
then keeps a caret placed on it by block id where its text still exists, else
drops it; history maps the selection onto the room only once bound (the
@slate-yjs/core patch).
Item rooms (quizzes, flashcard sets, standalone diagrams and mindmaps) have
the same 30 s from their token request (`ItemRoom.start`); one not synced by
then goes offline, the room's connection error (Epo 2026-10-23).
A slowed open and offline wait. A reload pauses only once its new token has
answered, so a reload whose token hangs keeps the old editor on screen,
unpaused and editable. A discard evicts the old room, so its own reconnect
(whose token request hangs too) goes Offline at about 30 s like any lost
room, its edits kept on the device, and the swap runs once a token answers;
no e2e waits for the Offline part. A failed first token request shows the panel for its status (not found or no
access), or the strip with Retry. A member removed from the workspace gets
the server's hidden `404`, so their editor shows the file-missing panel, not
no access: by decision (Epo, 2026-10-14) the app never tells a user whether
something they can't reach is blocked or gone.

**Update allowance and pieces** (Epo 2026-10-18, 2026-10-19). Each user
may send SYNC messages (updates, step 2 replies, step 1s), awareness updates,
awareness queries and JOINs at a burst of 10,000 messages or 8 MiB, then 200
messages and 2 MiB a second (`rate.rs`, `COLLABORATION_UPDATE_BURST`,
`COLLABORATION_UPDATE_BURST_BYTES`, `COLLABORATION_UPDATES_PER_SECOND`,
`COLLABORATION_UPDATE_BYTES_PER_SECOND`, the same in every environment; test
and stress stacks raise them; a lower value makes every tab time out, since
the client paces by the defaults). An update costs its body's bytes, an
awareness update its payload's, a JOIN one message (after its token and
access checks), so a JOIN/LEAVE loop runs into a timeout. The allowance is
the user's: every socket of theirs and every draft send (`POST /drafts`)
takes from one allowance in the server process, kept at least a minute
after its last use and until it has refilled (ten minutes after a timeout
ends), so a reconnect goes on from what was left rather than with a fresh
burst. Stateless, token and LEAVE messages do not count. A message is over
the limit when either bucket holds less than it costs (one message, its
bytes). The sizes come from what the editors send
(`bench/collaboration/reports/2026-10-18-update-rates.md`, `pnpm bench:rates`):
notes and PPTX send one update per key, at most 68 a second with a key held
at macOS's fastest repeat and 105 when keys come as fast as the page takes
them; DOCX coalesces keys; a note, XLSX or PPTX paste, a photo, a redo and a
reconnect's replayed drafts are one update each (about 2 MB at most
measured, 5 MB for a Pro photo); a DOCX paste is a burst of two updates per
paragraph (4,999 in 0.8 s for 2,500 lines) and Replace All one per
replacement, which the burst covers to a paste of about 5,000 paragraphs.

**Open budget** (Epo 2026-10-19). The full-document answers a user's opens
receive draw on a separate per-user budget of 80 MiB (`OPEN_BYTES`,
`COLLABORATION_OPEN_BYTES`), enough to browse 3-4 large documents, refilled
continuously back to full over 5 minutes from empty (`OPEN_REFILL`,
`COLLABORATION_OPEN_REFILL_SECONDS`, about 0.27 MiB a second): the room
charges a step 1's answer (up to the whole state), an awareness query's and
the awareness it sends on JOIN by their bytes once encoded, so the budget may
go below zero. A step 1 answer under 256 KiB (`SMALL_ANSWER`, a returning
member's resync) is charged too and skips the wait while the user owes less
than a full budget (80 MiB of debt, `Allowances::small_skips`, Epo
2026-10-20); past that it waits like a larger one. A larger one waits in its
room while the budget is spent, slowed, never refused, and so does an
awareness query: the room checks the budget when it takes the step 1 off its queue,
where the answer is charged, so a burst read before the first charge lands
gets one answer, and each channel keeps only its latest step 1 and query
while it waits (`room.rs` `on_step1`, `release_openings`). Whether an answer
is that large is known from a walk over what lies past the asker's state
that stops at 256 KiB (`ydoc::answer_at_least`), so a waiting step 1 costs no
encode; the encode checks it again. A user's large answers are encoded one at
a time (`Allowances::open_turn`): one waits while another is encoded, so
answers waiting as the budget refills are released one by one, each charged
before the next is looked at. A user in a timeout meanwhile asks again when it
ends, so their waiting opens are dropped. The awareness sent on JOIN is
charged too and, past the small-answer floor, waits like an awareness query
(kept per channel, released as the budget refills; Epo 2026-10-20, r6 S-1);
nothing else waits, and the edit allowance is untouched. The budget is the
user's across rooms and sockets (in each server process), so rejoining spends
it too: a user's step 1 answers, queries and JOIN awareness fetch at most the larger of two
budgets (160 MiB) and one budget plus the largest document, plus one resync
per open room (small answers encoded before their charges land), at once,
and then the refill rate, per process, however many files they open or
however they slice their asks.

A step 1 that begins to wait tells its channel once (a stateless
`{"type": "open-slowed"}`, `OPEN_SLOWED_TYPE`, with no numbers), also when it
joins the wait of its JOIN's awareness (rate-limit review r7 S-1). The editor
keeps its normal loading state, and after 5 s it adds the line "Opening is
slowed because many large files were opened recently." in the header's sync
indicator tooltip, held open (`NoteEditorStatus.slowed`, `EditorSaveStatus`,
`useSlowedLine`; Epo 2026-10-20, 2026-11-04): a note, a quiz, a set or a diagram
opening or reconnecting, and an Office or text source. Under an embed's skeleton
it stays a line of its own (`SlowedOpenLine`). The room is reachable, so the
reconnector never counts the wait as stuck (`roomReconnector().slowed`), and
an editor that went offline before (a socket drop) leaves offline mode when
the notice arrives instead of when the answer does: notes, items and sources
alike.

No room takes an update over 8 MiB (`ydoc::MAX_UPDATE_BYTES`, the byte
burst, which `COLLABORATION_UPDATE_BURST_BYTES` may not go below): the
server reads WebSocket frames only up to it and its framing, puts the user
who sends a larger update on a socket or a draft send in a timeout (below),
and refuses an agent edit or a replace-block command whose update would be
larger before it commits (the agent hears `quota_rejected`, "make it as
several smaller edits"; the content command's 413 is a document limit).
Capy's send path therefore cuts every update over 2 MiB into pieces
(`splitUpdate`, `src/features/collaboration/pieces.ts`), for every format
(notes, items, DOCX, PPTX, XLSX and text sources), the step 2 after a
reconnect and draft sends alike: the update's structs go in dependency
order, each piece a clock range per client, a struct only after the structs
of the update its origin, right origin and parent name, so pieces applied in
order never leave anything pending; a text or value run over the limit
becomes runs of the same item, as Yjs splits items (never inside a surrogate
pair); a new type (a note's block, an embed's figure map, an Office map) goes
in one piece with its whole nested subtree (its attribute entries and every
map, text and array inside them, as Yjs writes them in one transaction), so
a room's admission never sees a block without its `type`, `id`, figure or
asset, whatever the order its editor wrote them in; a subtree larger than
the server's 8 MiB cap is cut as the rest; the delete set goes last. A
resync's state holds a deleted nested type's children as garbage-collected
structs that name no parent (a chart whose series was replaced); the subtree
walk carries over a run of them when a nested item follows, so the figure's
`id` and `type` after them stay in its piece. A struct that cannot be cut (a
photo's binary, a format mark, a type) goes whole; one over the server's cap
is never sent: the room stops and closes (`collaboration-update-too-large`)
and joins again only when remounted, keeping the edit in the document and its
drafts, instead of looping on timeouts. The room provider sends an update's
pieces as one group: each its own SYNC message of type `PIECE` (3, after
y-sync's three), naming what was cut (step 2 or update), its place and the
group's count (`pieceMessage`, `sync::PIECE`); an update of one piece goes as
before. The room keeps a group's pieces on their channel and admits them as
one update after the last (`Room::on_piece`): peers and the store see
nothing of a group before, then all of it, or nothing at all when a piece is
refused (its writer refused as for any refused update). The writer's first
piece goes alone: the room acknowledges it once it holds it, and only then
does the provider send the rest (`RoomProvider.sendRest`), so a busy answer
costs one piece, not the 8 MiB burst it raced the user's own group with
(review round 4, finding 5); one more round trip a group, the socket's one
group at a time kept, a step 2 in pieces the same. Updates and stateless
messages (a checkpoint request) made meanwhile wait behind the group and go
after its rest. The rest is acknowledged with the last piece. A channel that
ends mid-group (a dropped socket, a Leave, a rejoin after a timeout) leaves
nothing applied, and its next step 2 carries the edit again. Every piece is
acknowledged, its first once held and the rest with the group, or its
channel closes or joins again (review of 43fae032a, findings 1, 3, 6 and 7,
and its rounds 2 to 4, all wrong behaviour with no product decision):

- A read-only channel's piece is checked on its own (a piece decodes alone)
  and never kept: one that changes anything is refused, so a reader pins no
  memory with groups it never finishes.
- A group gathers at most what one sync message carries in a note room
  (`NOTE_MAX_SYNC_BYTES`, 4 MiB) and a source room's state cap
  (`Room::group_cap`). Bytes are the bound; the count is only a sanity bound,
  cap ÷ 256 KiB + 2 pieces (`max_pieces`): the browser packs a piece to 2 MiB
  by its own estimate, which counts a delete range as 16 bytes against the 2
  to 7 it encodes in, so a delete-heavy piece may hold an eighth of that
  (round 2, finding 6; round 3, finding 9). The piece past the cap is refused
  before anything of the group is read, with the bytes that came: a note
  room's with `document-rejected` `document_size_exceeded` (class `limit`),
  as admission refuses a document past its size, so the editor shows its
  size refusal instead of joining again to resend the group (it looped on
  the earlier `malformed update`); a source room's with its state-size
  refusal. A group naming more pieces than `max_pieces`, which no client
  cuts, is refused at its first as malformed with its own reason naming the
  count and the bytes that came (`Room::too_many_pieces`): a note room's
  `document-rejected` `invalid_document`, a source room's unrecoverable
  `source-checkpoint-failed`, a draft's `malformed`.
- A piece out of its group's order, or a new group over an unfinished one,
  drops the group: its pieces are acknowledged and the channel hears step
  1, as for an update the room cannot place, whose step 2 answer brings the
  edit; the rest of a dropped group is acknowledged and let go as it comes.
- A group not finished by its deadline (the later of its first piece plus
  what the update allowance takes to carry the room's group cap,
  `Room::group_carry`, and its latest piece, plus
  `COLLABORATION_GROUP_SLACK_MS`, 90 s) gets the slack again while a message
  is arriving on its socket: bytes came since its latest piece or renewal,
  after the socket's last whole message (`seats::Traffic`,
  `Room::drop_late_groups`; round 4, finding 9). A browser sends a 2 MiB
  piece as one frame, so a slow but live uplink lands it however long it
  takes, and a group whose pieces wait behind another message lives on too.
  Pongs come whole, so they never renew it. While its first piece waits
  for its acknowledgement (nothing more of it came), the tab's heartbeat
  renews it too (a text frame every 20 s, `HEARTBEAT`; round 5, finding 1,
  and the CI rerun of 2026-11-23): a long send to the client (another
  room's whole state, a peer's large update) holds back that
  acknowledgement, which stays in the socket's one ordered outbox (moving
  it ahead would reorder it against the channel's `stored` notices, whose
  order after an acknowledgement the provider counts), and the heartbeat
  says the tab's code still runs. That is the one wait a long send causes,
  so a group stalled after its second piece gets nothing from heartbeats
  and is dropped as late (review of 2026-11-24: else a live tab's stalled
  group held its user's one slot to its limit, minutes on a note, hours on
  a source file). The socket reads while it sends, so a heartbeat is heard
  however long a send to a slow downlink takes, and the time a send takes
  counts for nothing: behind cloudflared or Traefik, and on Linux's large
  socket buffers, the server's send ends at once whatever the client's
  link. None of these renews a group past its
  limit, its room's group cap at the slowest uplink (8 KB/s, or its carry
  if longer) plus the slack (`Room::group_limit`; round 6, finding 4): a
  client that reads slowly or trickles bytes holds its user's slot and its
  room's group bound no longer, and is dropped as late. A group whose tab stopped
  sending (a frozen tab whose browser still answers pings) is dropped as
  late (`Room::drop_noticed`): the channel hears `group-dropped`, then the
  acknowledgement, and no step 1. A resend would stall the same way with no
  end (round 2, finding 5), so the provider sends nothing more on that
  channel (`resendHeld`): what was in flight is unsent again, the group's
  pieces still waiting in the socket's outbox are dropped
  (`CollabSocket.dropQueued`, their allowance given back, round 3, finding
  2), the room's step 1 and later edits send nothing, and one unsynced change
  stands for it, so no receipt is asked for. The editor shows its save strip
  `unsynced` (Epo 2026-11-23): "Couldn't sync your edits. Retry or reload the
  page." in the error tone, with no close, Discard (`ghost-hover`, first) and
  Retry (`dark`, as recovery's Download, Epo 2026-11-23), and no Download.
  - A late drop while the user is in a timeout raises no strip, and a
    timeout clears one: the join after the timeout carries the edits, and a
    Retry meanwhile would join nothing (round 5, finding 3).
  - Retry (`RoomProvider.retry` through `onHeld`): the same channel joins
    again now, its step 2 carrying all of it. It is disabled while its join is
    pending (`HeldEdits.retrying`, cleared once the channel joins or ends;
    round 4, finding 4), so a second click sends no second JOIN. Nothing
    retries on a timer; a reconnect or a reload joins again too.
  - Discard (`HeldStrip.discard`, the owner's): the held edits go from the
    device, this session's draft rows with them, and the editor continues
    from the last saved version, as the deleted strip's Discard does (a
    board asks first, with the same dialog). An item room discards its
    recorder's rows and opens a fresh room (`ItemRoom.discardHeld`, a quiz
    both rooms); a note's editor discards its rows and copy, then reports
    `discarded` for a fresh mount (`NoteEditorCore` `discardHeld`); an Office
    or text file discards its session's rows and opens a new session
    (`discardDraft`).
  - A Retry the room refuses for good shows what that refusal shows
    elsewhere, never `unsynced` again: `refused` (an update over a limit, a
    malformed or unassigned one), `access-lost` or the page's access-lost
    strip (a permission loss), the read-only strip, the deleted strip, or a
    note's merge view. The provider clears the strip whenever its owner lets
    it go (`RoomProvider.disconnect` ends the channel, which reports
    `onHeld(null)`), which every such refusal does; another late drop shows
    `unsynced` again.
  Notes, boards, quizzes, sets, diagrams, and Office and text files show it;
  a note's goes at a room swap with the paused editor, which reports no more
  (`useHeldEdits`, round 4, finding 3), an Office or text file's with its
  session (`useSourceSession` starts each one clear), and every other
  editor's with its provider. At phone width the strip's message wraps
  beside its actions (round 4, finding 8).
- The room's unfinished groups, with the admitted groups' pieces it has not
  sent out yet, hold at most twice its group cap: a piece past that drops
  its own group alone as busy (round 2, finding 1: timing its writer out let
  a co-editor's held groups pause another writer's every room; round 3,
  finding 6: step 1 made the client resend at once, past the bound again).
- A user has one unfinished group at a time across rooms and paths: a
  channel's update or step 2 in pieces, or a draft send's (Epo 2026-11-23,
  in place of a 100 MiB hold per user; the review's reader with 22 channels
  on 27 MiB DOCX rooms pinned about 600 MiB). The first piece claims the
  user's slot (`GroupSlots`, given back however the group ends), so what
  one user holds is one group, bounded by its room's group cap: 4 MiB in a
  note room, an Office room's state cap. Another group's first piece
  meanwhile is busy, which is not abuse, so no timeout: on a channel the
  room sends `group-busy`, then acknowledges the group's pieces and lets
  them go, and the provider holds the edit as for a late drop, unsynced,
  drops the group's waiting pieces, and joins the same channel again
  `GROUP_BUSY_RETRY_MS` (10 s) later, silently, its step 2 carrying the
  group and the edits made meanwhile; a draft piece is answered `busy`
  (below). The same group claiming again (a draft resend under its rows'
  id, a channel's JOIN session on another connection) takes its own place.
  Busy groups queue first come, first served (round 3, finding 8): a busy
  group is queued once, a freed slot goes only to the head, and one not
  back within its patience leaves the queue. A channel waits under its room
  and JOIN session id (`channel_slot`), so a busy tab keeps its place on its
  next connection, with a patience of twice the 10 s retry; a draft under
  its room and group id (`draft_slot`), with the 10 s retry plus
  `COLLABORATION_GROUP_SLACK_MS`. Each patience also takes one 2 MiB piece
  at the slowest uplink, 262 s, since a busy group claims again only once
  its first piece came again (`GroupClaim::channel_patience`,
  `draft_patience`; round 6, finding 2): a slow uplink keeps its place. A
  channel that leaves waits no more, unless
  its session is still in the room on another connection, and a user left
  with no slot and no waiter has no entry (round 4, finding 2: an orphaned
  head, a reconnect's new key or a tab gone, held up all its user's groups
  for up to 100 s). A user's drafts wait once a room: a draft group stands
  in for its room's draft waiting already, the older edits of its page (the
  page names a group by its rows, so new edits make a new group and the
  older is sent no more) or another lineage of the same document, both at
  its place in line and at its head (round 6, finding 1: two lineages of a
  document, which one sweep sends, replaced each other at the head and
  neither ever claimed). A draft group refused for good, by its room or
  before it (the note moved on, a read-only token, too many sends), waits
  no more (`drafts::leave_line`; round 5, finding 4; round 6, finding 6).
  The queue looks at the users whose places are due, kept soonest first,
  never at every user under its lock. The slots and their queue are per server process, as
  the rooms are. A tab sends one group at a time on its socket
  (`CollabSocket.groupTurn`): another room's group waits, one unsynced
  change, until the first is acknowledged (round 3, finding 4, several notes
  reconnecting with large offline edits). A group is taken over only by the
  same JOIN session on another connection, a reconnecting tab's whose old
  connection the room has not seen close (`Room::claim_channel_group`; the
  old one hears `group-busy`; the JOIN's own takeover, Q472, usually ended
  it already), never for a quiet connection: below about 70 KB/s a 2 MiB
  piece outlasts the pings, and two tabs on a slow link took each other's
  groups over with neither finishing (round 4, finding 1).
- A source room's admitted group, a channel's or a draft send's, reaches
  peers as its pieces, each a SYNC message of its own in yrs's encoding that
  applies alone, at the update allowance's pace (its burst, then its bytes
  per second; `outgoing`): a whole group at once could close a slow reader
  (an outbox past max(4 MiB, its largest frame)), and its writer could have
  sent no faster. Plain updates go out at once meanwhile (round 2, finding
  3): one that builds on pieces not sent yet waits pending in the peer's
  Yjs until they come, so a queued group no longer holds every typist back.
  A member that joined or was answered after the group's admission holds it
  in its step 2 and skips its pieces (`Outgoing::admitted`, round 3, finding
  7). The pieces go to the broadcast with their update, never kept beside
  it, so a panic in its admission leaves none for the next (round 3, finding
  5). A note room's group, at most 4 MiB, goes as one.
- One group is one admission: its limits and its work budget
  (`ydoc::MAX_WORK`, a million steps) apply to the whole, as to an update
  sent in one message. The budget counts the splits it makes in held items
  (the content copied and walked to each cut), which grow with the points it
  types or deletes inside held content, not with its bytes, and the browser
  cuts an update in pieces only for its size (new content past 2 MiB), so no
  honest group nears it; admitted as n budgets, one action could take n
  million steps.

Draft sends stay one request per piece of at most 2 MiB (Epo 2026-10-18,
below), each naming its group (`X-Capy-Group`), which the room holds and
admits whole under the same bounds, and whose pieces reach a source room's
peers as above (round 2, finding 2). The tab's socket paces SYNC
and awareness frames under the same allowance (`allowance.ts`, mirroring the
defaults; a load generator's own socket has its own): a frame waits while the
allowance is spent, and every frame sent
after it, a checkpoint request among them, waits behind it, so a receipt
never covers a piece still waiting. Draft groups are cut in the drafts
worker and sent one request per piece, in order, under the tab's allowance.
Another tab of the same user is not paced against this one; both together
can still go over, and then the user is in a timeout.

**Held back.** While the tab holds back messages, every editor (notes,
items, DOCX, PPTX, XLSX and text) takes no input: frames wait in the socket
for the allowance, a split update's pieces wait for the server's
acknowledgement of their group, a draft send waits for the allowance, or the
user is in a timeout (`held.ts`). `CollaborationHold` wraps the note
editor and its toolbar, the quiz form, the flashcards editor, a live Mermaid
diagram and the text editor: its content is `inert` and `aria-busy`, with a
loading cursor over it, and an editor's own state is untouched. What portals
out of it consults the same flag: inside an editor (`EditorHoldScope`, at the
note editor's root and in every `CollaborationHold`) the shared dialogs,
popovers, dropdown and context menus, selects, floating toolbars and popups
(`useEditorHeld` in `src/components/ui`) turn inert, an open one included
(it stays open and takes input again once sent; its overlay and Escape still
close it, dropping only the dialog's own form state, never document edits); the Ctrl+K palette neither
opens nor runs a command (its listener is on `window`); the quiz and flashcard Undo and Redo buttons in the page header are
disabled (no Undo or Redo button shows on phones, in any editor or dialog but
Office's; Epo 2026-11-04, and their keyboard shortcuts stay). A DOCX or PPTX editor pauses as for any other pause
(`set-capabilities` with `canEdit: false`: read-only, selectable), and the
XLSX editor takes the runtime's `sending` message instead: the runtime keeps
it in state and passes it to `XlsxEditorHost` and the fork's `XlsxEditor`,
which refuses edits with a busy cursor once the BetterOffice pin carries the
prop ([office-files](office-files.md)).

**Timeouts** (Epo 2026-10-18). A user over the allowance, or sending an
update over 8 MiB, is put in a timeout instead of disconnected (closing would
protect nothing, since a script reconnects at once): no SYNC, awareness,
query or stateless message of theirs goes on, on any socket, and a draft
send is refused `too_fast` (429) with `remainingMs`, until it ends. A draft
send over 8 MiB answers `too_large` (413), which the page leaves to the
editor, and starts a timeout as an update over the cap on a socket does
(Epo 2026-10-20, replacing the too-fast answer). A socket
misses an announcement only when too many users time out at once (the
broadcast lags, logged); its channels learn at their next join. It lasts
until the allowance covers the refused message, at least 3 s so it is seen,
the least doubled for each further timeout starting within ten minutes of
the last one's end, at most 5 minutes (`TIMEOUT_MIN`, `REPEAT_WINDOW`,
`TIMEOUT_MAX`). Each joined channel of the user hears it when it starts, and
a channel joining during one hears it instead of joining (checked right after
the token, before any lookup; it joins again when the timeout ends): a
stateless `{"type": "update-timeout", "remainingMs": n}`, never the
allowance's numbers. The room provider pauses: it sends nothing, counts as not synced
(so no checkpoint request goes, and a note resends its pending ones once
synced again) and keeps the edits made meanwhile in the document and its
drafts. When the time is up the socket's allowance is full again (the
defaults kept in code), and each paused room sends JOIN again on the same
channel of the same socket: the server leaves and rejoins the room, sends
its step 1, and the client's step 2 carries everything the server lacks, in
pieces. A socket that drops during a timeout forgets it; the server tells
the channels again when they rejoin. Sockets still close for malformed
frames. The server logs each timeout at warn and counts it
(`capy_collaboration_timeouts_total`, [observability](../observability-metering.md)).

**Socket and channel caps** (Epo 2026-10-19). A socket that has joined no
room after 10 s, with none authenticating, is closed (1008, "no room
joined"); a client joins as soon as it opens one, and a warmed socket's
hold is 8 s. A JOIN's token is checked when it arrives (CPU only): a bad one
is refused before any lookup, so it never holds the deadline open, and the
user's timeout is checked next, before a source room's eviction lease (Redis)
and the database. A client address holds at most
`COLLABORATION_SOCKETS_PER_ADDRESS` open sockets (500): one more is refused
429 before the upgrade. The address is read as the gateway's limiter reads
it (`CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else the
peer's), an IPv6 one by its /64; the headers are trusted only while the
origin is reachable through the tunnel alone
([deployment runbook](../deployment-runbook.md)). A user holds at most 22
joined documents over all their sockets (`JOINED_PER_USER`,
`COLLABORATION_JOINED_PER_USER`, about 7 per device on 3 devices): one more
JOIN closes that user's oldest joined channel (`collaboration-oldest-closed`,
counted in `capy_collaboration_oldest_closed_total`) instead of being
refused. A user also holds at most 4 connections to any one document or
embed over all their sockets (`CONNECTIONS_PER_DOCUMENT`,
`COLLABORATION_CONNECTIONS_PER_DOCUMENT`, Epo 2026-10-20;
an embed channel counts toward its own room, not its note's): a fifth closes
their oldest connection to it the same way. The closed room waits, not synced, and joins again once the user
comes back to it: its tab shows again, or an edit is made in it (a local
transaction; an applied update such as a restored draft is none); joining at
once would close the user's next oldest. The server pings every socket every
30 s and closes one that sends no byte for 60 s (`PING_EVERY`, `SILENT_CLOSE`,
`COLLABORATION_PING_SECONDS`, `COLLABORATION_SILENT_SECONDS`; Epo 2026-10-20).
Any byte counts: the browser's automatic pong, a frame that waited while the
socket was busy elsewhere, and a frame still arriving, since a slow uplink's
2 MiB piece is one frame its pong waits behind (round 4, finding 9). A long
send to a slow downlink holds back the server's pings, so the tab sends its
own heartbeat, a text frame of `HEARTBEAT` every 20 s while its socket is
open (`CollabSocket`, `HEARTBEAT_MS`; protocol 41), straight on the socket
past the update allowance. Its clock is a dedicated worker's timer, one a
tab, running while any socket is open (`heartbeat.ts`; the worker is built
from an inline blob, its URL revoked once it starts, so a tab whose first
socket opens after a deploy changed the bundle's hashes still starts it;
`worker-src blob:`): Chrome runs the
timers of a page hidden for 5 minutes once a minute (intensive wake-up
throttling, which its documentation scopes to the page's `setTimeout` and
`setInterval`), right at the silent window, and a hidden tab that keeps its
socket (unsent edits, an Office or text file) is the one with a group to
lose. Measured 2026-11-24 in Chrome for Testing 151 on macOS with a local
probe: in a tab behind another tab of its window, the page's own 20 s
`setInterval` came at gaps of 52, 60 and 60 s once the tab had been hidden
about 5 minutes, while a dedicated worker's 20 s ticks, and the page's
message handler for them (where the heartbeat is sent), stayed at 20 s
throughout, 25 ticks over 8.5 minutes. No automation was attached, since
Playwright keeps its pages focused and visible. A worker that cannot start
or fails is reported to Sentry (an `Error` saying so; a load failure's
event has no message) and no heartbeat goes; no page timer stands in. The bench's Node clients pass their own
`setInterval` clock to `CollabSocket.create` (`nodeHeartbeat.ts`), a
dependency the bench gives, not an app fallback. Each socket logs one Info
line at close, `socket heartbeats`, with its `beats` and
`longest_beat_gap_ms`, so a hidden tab's beats are checked on UAT from the
logs (deployment-runbook). The server reads while it sends
(`Connection::write`, `seats::send_reading`), so it hears the heartbeats
however long the send takes and however the kernels and proxies between
buffer it; a client that sends nothing, not even a heartbeat, closes at the
window during a send too. Meanwhile the socket's other work (token timers,
closings, auth and join answers) waits for the send to end; the room still
refuses an update or stateless event whose token has expired, and the writer
recheck, every 30 s on a writer's updates, still enforces access, so an
expired token only stretches its grace. The server refuses to start with
`COLLABORATION_SILENT_SECONDS` or `COLLABORATION_GROUP_SLACK_MS` under two
heartbeats (40 s, 40,000 ms; `config.rs`; a debug build takes
`COLLABORATION_IT_HEARTBEAT_MS` for the 20 s, so the rooms tests scale their
windows down, and `COLLABORATION_IT_RECHECK_MS` for the writer recheck's 30 s;
a release build refuses both). So a
dead connection (a laptop that
changed networks) frees its places through the normal close; the client takes
that close (1001) like any drop and reconnects. A send has no total time limit,
since a whole-state answer is one frame that a slow link takes long to receive,
but a send that moves no bytes for the silent window closes the socket the same
way (logged `stalled socket closed`; Epo 2026-10-20, rate-limit review r7): the
listener's connections record when their kernel last took bytes and when
bytes last came in (`seats::TrackedListener`, `Traffic`, `watched`), so a slow link that keeps taking
bytes stays open however long one frame takes. The server refuses to start when
the silent window is not longer than the pings.

**Embeds in their note's seat** (Epo 2026-10-20). An embedded quiz's or
flashcard set's room (content, and a writer's quiz keys) joins inside its
note's channel on the same socket: its JOIN names the note's channel after
the client protocol (`joinPayload(room, token, note)`), and its token names
the note (`parent`, which Go reads from the material's `parent_material_id`).
The server joins it only when that channel is a joined note channel of the
same user on this socket whose material is the token's `parent` (another
note's embed is refused `collaboration-forbidden`; a channel that is not a
joined note `collaboration-note-closed`). An embed channel takes no place
among the user's 22 joined documents; a note channel holds at most 64
(`EMBEDS_PER_NOTE`), and one more closes its oldest
(`collaboration-embed-closed`). It holds a room once: joining the same room
again under it closes the earlier channel the same way (rate-limit review r5
S-a), so the client shares one item room per material and document among a
note's copies of it (`NoteSeat.hold`, `openItemRoom`; r6 S-2): a quiz embedded
twice joins once and both copies are live. That close comes before the new
channel takes its places, and a join whose per-document close ends a channel
holding one of the user's 22 places takes that place and closes nothing more
there (r6 S-3); one that ends an embed's channel, which holds none, still
closes the user's oldest joined document (r7 B-1). A channel's places share one
membership id (`seats::membership_id`), so a place another close already gave
back is not given twice. A closed embed's
room waits, as one closed as the user's oldest does, and joins again when its block comes near the screen again
(`useNearScreen().entered`, `RoomProvider.wake`), its tab shows again or an
edit is made in it. When the note's channel goes (left, closed, expired,
joining again after a timeout) the server closes its embed channels
(`collaboration-note-closed`) and the client ends them too, reporting no
close; they join again once the note has joined. Each embed keeps its own
document, storage, history, keys room and id; its own token refreshes and
expiry apply as for any channel, and a JOIN costs one message of the
allowance. With no note channel (an embedded set opened on its own study
page, or under MSW) an item room joins as any document does; it keeps no
awareness state ([presence payloads](#presence-payloads)). A room keeps at most 256 awareness
client ids (`MAX_CLIENTS_PER_ROOM`); a new id past it is not kept. The room's
cap counts removed ids until their removal went out (the next flush forgets
them), so adding and removing ids in a loop stays capped and needs no scan.
A channel writes awareness only under the client id its JOIN bound (see
[client ids](#client-ids)); entries under any other id are ignored, and its
leave removes its entry unless a later channel of its user took it over.

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

### Client ids

Epo decided on 2026-10-23 (Q213) that the collaboration server assigns each
editing session its Yjs client id and admits a writer's changes only under
ids assigned to that writer's user, in every room (notes, items, keys,
Office and text files); on 2026-10-24 (Q226 M3, Q236) that an id is
recorded at the first accepted write under it, and that a reconnect keeps
its id by presenting its previous token; on 2026-10-24 (Q288) that stored
drafts keep their tab's last token, which re-grants their id to a draft send
from any page; on 2026-10-28 (Q472) that a reconnect of the same editing
session takes over its own channel a dropped socket left behind.

- **Assignment** (`newClientID` and `regrantedClientIDs` in
  `server/internal/httpapi/collaboration_tokens.go`). Every collaboration
  token (material, keys and source rooms; read and write) offers a client id
  (its `clientId` claim, 1 to 2^32-1 other than the fork's seed ids 0 and
  1): a fresh random one, or, when the request carries the session's
  previous token (`previousToken`), that token's id again. Go re-grants only
  a token with our signature, for the same user and the same room (document,
  schema or epoch), issued at most 7 days ago; its expiry is otherwise
  ignored, and the endpoint's own access check runs first, so a previous
  token never grants access. Anything else gets a fresh id.
- **The browser** (`RoomProvider`). The provider presents its last token on
  every token request (each JOIN and each in-band refresh). Its document
  takes the id each JOIN's token offers until the document (or its DOCX
  layout worker) wrote under it, then keeps that id for the document's life
  and names it in every JOIN, so the Undo stack survives. A reconnect's token
  offers the same id again, so a session that never wrote keeps it too: an
  Office editor, whose replica and layout worker took their ids at the edit
  `load`, needs no reload. A new id comes with a new Y.Doc (a new editor or
  item room, a room swap's renderer), or when a document that never wrote
  gets a fresh token (its previous one too old, or dropped at a
  `collaboration-client-id` refusal). Edits a document made before its first
  JOIN stay under the id Yjs drew, and the room refuses them as they are (Epo
  2026-10-24, see Refusal); a document whose `clientID` no longer matches the
  id it took stops its channel with an error instead of sending (Q226 L3).
  Each provider (one editing session and its Y.Doc) also draws a random
  128-bit session id when it is made (`sessionId`, Q472) and sends it with
  every JOIN, its embeds' and item rooms' providers their own. It lives only
  in the provider's memory, never in drafts, storage or tokens.
- **Binding** (`ClientIds::bind` in
  `collaboration-rs/crates/server/src/client_ids.rs`). A JOIN binds its
  channel to the id its Y.Doc names, in memory. An id recorded to the
  joiner's user binds as it is, whichever id the token offers (a reconnect).
  An unrecorded id binds only when it is the one the token offers, has no
  structs in the document's history (its state vector) and no live channel
  holds it (nor the room's own client). One recorded to another user, one the
  token does not offer, or one in the history (its row cleared or expired) is
  refused as `collaboration-unassigned-id`: no retry binds it, so the editor
  does not retry (`roomRefusal` reads it as `unassigned`; until the catch-up merge
  re-applies its edits, a note or item keeps its unsent edits as refused and
  remounts, a source session goes to recovery). One a live channel holds is
  refused as `collaboration-client-id`: two sessions presenting one
  previous token, or a client too old to send a session id whose dropped
  socket's channel the server has not closed yet (at most 60 s,
  `SILENT_CLOSE`). At the first such refusal the provider drops its previous
  token (Q475, Epo 2026-10-28): its next JOIN takes a fresh id, or, when its
  document already wrote, names its own and hears
  `collaboration-unassigned-id`. A channel whose token
  turns writable writes under the id it bound (Q226 M1); a token refresh
  naming another user than the channel's is refused (the channel closes at
  its token's expiry), so a bound id stays its user's.
- **A reconnect after an unseen drop** (Q472, Epo 2026-10-28). A socket can
  drop without the server seeing a close (through the Cloudflare tunnel, for
  one), and its channel then looks live until its silent close. A JOIN
  naming a session id takes over the channels of the same user and room
  with the same session id that joined before it (an earlier socket, or an
  earlier channel of the same socket) and hold its client id or its DOCX
  worker id (`Room::stale_channels`): they do not count as live for the
  binding. Once the JOIN binds (recorded id or not) the new channel joins
  and takes each stale channel's awareness entry under the session's id, so
  collaborators keep seeing the user's cursor instead of hearing it removed
  (Q477, `Room::take_over`); then each stale channel closes as a Leave
  would, its socket hearing CLOSED `collaboration-rejoined`. The browser
  already left that channel, so the reconnect rejoins in one round trip
  instead of waiting up to 60 s. A JOIN whose session id differs or is
  missing (an older client) takes over nothing and is refused as before, so
  two documents never write under one id; the session id is the client's
  word, so another user's JOIN naming it takes over nothing either. A draft
  send (`grantable`) carries no session id and keeps the rule above. A
  rejoin after the old channel already closed is unchanged: that close
  removed the cursor one clock past the state the tab resends, so
  collaborators see it again from the tab's second awareness change.
- **A DOCX session's worker id** (Q219, Epo 2026-10-23). The DOCX editor
  lays out and applies typing in a resident worker, a yrs document of its
  own, so a DOCX write token also offers `workerClientId` (Go mints it only
  for DOCX write tokens, other than the session's id, and re-grants it from
  the previous token as it does the session's). The JOIN binds it with the
  session's id under the same rule. The provider keeps the worker id with its
  document's (`RoomProvider.workerClientId`), the source session hands it to
  the edit `load`, and the fork's resident worker writes under it
  (`workerClientId` in the DOCX editor's collaboration options) instead of a
  random id. A DOCX edit load without a worker id fails explicitly (Q226
  L4); other formats carry none.
- **The record.** `material_yjs_client_ids` (material, document `content` or
  `keys`, id) and `source_document_client_ids` (file, id), each row naming
  the user (indexed) and deleted with its document and by the account purge
  (migration 0115). A room loads its rows once and keeps them in memory, so
  reconnects and update checks read no database. An update accepted and
  applied (after admission, the validator and the limits) records the ids it
  wrote under as the writer's user's the first time in a room's life, and
  refreshes their `last_write_at` once a day after; a JOIN or a refused
  update records nothing. Rows are recorded in memory at once and in the
  database off the room's task (a slow database stalls no channel, Q226 M4),
  in order through one queue per room that the room's unload waits on; a
  batch still failing after its retries (about 15 s), or a queue a closing
  room drops, is logged as an error. A Leave says whether the tab still holds unsent edits for the
  document (one byte: 0 when it holds none, beyond the provider's
  unacknowledged updates and the drafts not yet covered by a receipt), then
  names the session's client id (see [editing sessions](#editing-sessions)); a
  clean Leave expires the recorded ids its token offered, so they never bind
  again (an id it bound otherwise, its user's other tab's, stays), and a
  socket drop or a Leave with unsent edits keeps them. Each room load
  first deletes the document's expired rows and rows unwritten for 7 days:
  no scheduled job (Q226 M3). The server's own writers (the room client, the
  edit scratch documents) take ids outside the recorded set, the ids bound
  to live channels and the room's history (Q226 L2). Ids never enter the Yjs document, whose readers must
  not map ids to users.
- **Admission** (`client_ids::foreign`, after the marker check). Every block
  an update adds beyond the room's held clock for its client must be under an
  id the writer's user holds: one recorded to the user (any of them, so
  drafts of their earlier sessions still apply), one bound to a live channel
  of the user (a draft send from another page of a tab that is still
  joined), or one a draft send's stored token re-grants (see draft grants). Blocks at clocks the room holds pass as duplicates, and delete sets
  are not bound. Server-side writers (the room client, Office engine
  children, seeds) do not go through admission.
- **Reserved copy ids** (Epo 2026-10-24, M5). Ids from 2^32 up to the PPTX
  bootstrap id (2^53-1) are reserved for derived override-seed copies; no
  session is assigned one. Until override-seed copies exist, every room
  refuses structs under them like any unassigned id, a source file's editors
  included.
- **Draft grants** (Epo 2026-10-24, Q288). Stored draft rows keep their
  session's last signed room token (`grants` in `src/lib/editDrafts.ts`; a
  merged row keeps each of its rows'). A draft send presents its group's
  tokens in `X-Capy-Grants`, newest first and one per client id they offer
  (a session's refreshed tokens take one slot), at most 16. The server
  re-grants the ids each offers under the reconnect rule: our signature,
  the same user and room, issued at most 7 days ago, expiry ignored
  (`auth::granted_ids`, `auth::granted_by` reads the first 16), and
  recorded for no one else, absent from the history and held by no live
  channel (`ClientIds::grantable`). The write records them. So the drafts
  of a closed tab whose edits never reached the room go in from any page. A
  group still refused `unassigned` (a token over 7 days old, an id recorded
  to another user) is held and opens copy-only (see opening with stored
  drafts). Stored drafts and their
  short-lived tokens stay in the browser through sign-out and an account
  switch, as the drafts always did; an expired token grants nothing, and a
  grant needs the sender's own user.
- **Opening with stored drafts** (Epo 2026-10-24, Q319, Q326, Q327, Q328).
  The recorder marks a session's rows `accepted` once a receipt covers one
  of its own edits (`covered > start`: adopted rows do not count), since the
  room then recorded the session's id. On open (`draftGroups`,
  `splitOpenDrafts`) a note, item room or source session applies accepted
  rows and syncs them over its live channel; rows of a never-accepted
  session with a stored token go through the draft send (`draftSender`)
  while the editor joins. Never-accepted rows no send delivers (held after
  one, or with no stored token) join the refused rows when they draw on
  their own (the drafts worker's `draws` decides, so the main thread merges
  and applies them once): a note's become the merge view's pieces, other
  kinds open them copy-only (Epo 2026-10-25, Q360, Q251), reported once as
  the edit incident
  `other_epoch_draft`/`held` (never sent, so no service log has them); ones
  that need the room's document are applied, and the room's live refusal of
  them keeps the whole document as a refused group (pieces for a note,
  copy-only otherwise). Restored rows the room's document
  cannot place either (their base is gone) go at the first receipt with the
  drafts-lost notice, reported `draft_unrestorable`/`base_missing` as
  recovery reports a group nothing can draw (an item room too, under its
  material). Until the send settles (every group stored or held) the editor
  shows the syncing status and is view-only: notes lock the content and
  toolbar, items set `sending` (`itemEditingStopped`), sources return
  `draftsSending`. A request is cut only when its upload moved no byte for
  30 s, or when its answer has not come within 30 s plus its size at the
  slowest uplink, 8 KB/s, of its upload's end (`postDraft`,
  `DRAFT_STALL_MS`, `draftSendTimeout`, `SLOWEST_UPLINK`; Epo 2026-10-25,
  Q360; round 4, finding 9; round 5, finding 2, the rate Epo 2026-11-23):
  the browser's upload counts bytes handed to its network stack,
  which may still drain them at that pace. fetch reports no upload progress, so pieces go by XHR; under
  MSW they go by fetch within that limit, as `client.ts` uploads do, since
  the e2e specs stand in for `/drafts` by patching fetch. The room gives a
  draft group its slack again while a piece's body is arriving
  (`RoomCmd::DraftArriving`, at most once a second), so a slow but live
  uplink lands a 2 MiB piece, and a body that stops lets the group go at its
  deadline. A draft group's deadline between pieces is at least the slack
  plus one 2 MiB piece at the slowest uplink (`Room::draft_wait`,
  `COLLABORATION_SLOWEST_UPLINK_BYTES`, 8,000; 352 s), since an edge or
  tunnel in front of the service may take a whole body before the room
  hears any of it (round 5, finding 2). None of these renews it past the
  limit a channel's group has, its room's group cap at the slowest uplink
  plus the slack (`Room::group_limit`; round 6 review): a client sending a
  held piece again, or trickling a body, holds its user's slot no longer.
  Cutting smaller pieces after a timeout would not hold:
  `splitUpdate` keeps a new block's subtree whole up to the update cap and
  cannot cut binary, format or embed content. One that fails or is cut goes again
  30 s later, doubling to 5 minutes, and at once on the browser's `online`
  event or when the room connects (`now`, from the `beforeJoin` hooks),
  never twice at once: one asked during a try goes as it ends. While steps
  are held no socket is open, so a server that comes back is noticed only by
  the next try: the hold's own connect, the browser's `online` event and the
  backoff are its triggers. A send that settles before the hold with a group
  the room did not take opens it at once (a note remounts with it as
  pieces, an item room is replaced, a source session opens again, both
  copy-only). Not settled 30 s after
  the open (`DRAFT_SEND_WAIT_MS`) with the room synced, or at a first sync
  after that, the editor closes its channel, applies those rows, adds them
  to its recorder's adopted rows and edits on: every edit is stored as a
  draft and nothing goes live, since the room would refuse the old steps on
  the channel. Its provider's `beforeJoin` then holds every JOIN until the
  send settles, and no socket opens for the room meanwhile. The hold shows
  syncing and is no editing incident (the recorder's `disconnected(true)`
  reports no `offline_episode`); a browser that goes offline in it shows
  offline, and syncing (a source saving) again once back online. Once a send
  is accepted the editor joins and continues; one the room refused leaves
  the steps in the document, so the live sync is refused `unassigned` and
  the edits become pieces (copy-only recovery for items and sources). Before a first sync the join's
  own 30 s connection error stands. A live refusal has no automatic
  fallback: an accepted session is refused only once its record and its
  tokens are past 7 days.
- **Duplicate draft sends** (Epo 2026-10-24, Q321). A draft send whose
  update the room already holds in full (`ydoc::contains_changes` is false
  over the room's state vector and delete set) is accepted as a no-op on the
  room's task, before the allowance is charged: no charge, and no new store
  or gateway checkpoint. Its answer still waits for the store that holds
  the group when one is due or running (Epo 2026-10-25, Q360), since the
  browser deletes its rows on it. So the page sweep, an opening editor and
  other tabs may send one group without a lock, a resend after a lost answer
  costs nothing, and simultaneous duplicates count once since a room handles
  writes in order. Draft sends count against their own limit of 60 a minute
  per user instead (see the draft sweep).
- **Refusal.** An update under another id goes the refused-on-entry way:
  material rooms send `document-rejected` with code `unassigned` (the editor
  keeps its unsaved edits as a refused draft), source rooms
  `source-checkpoint-failed` with `recoverable: false` and code `unassigned`
  (recovery), and a draft send answers 409 `unassigned` (the group is held,
  never sent again: its next open makes it pieces (copy-only for items and
  sources), or applies it when it needs the room's document, which the live
  refusal then keeps as a refused group).
  Each is logged at warn and recorded as
  the edit incident `save_refused`/`client_id`. So after the server lost
  state a tab restores only its own user's unsaved edits; another user's are
  lost (accepted, Q213). Edits under an id the server never assigned (made
  before the tab had one) or no longer holds are refused as they are, never
  bound. Until the catch-up merge re-applies them under the tab's id (Epo
  2026-10-24, `human/frontend/error-handling.md`), they open for copying:
  this covers a session that typed without a write accepted and reconnects
  with a fresh token (its previous one over 7 days old). An open tab within
  7 days gets its id re-granted by its previous token, after a network drop
  too, and its edits land; a closed tab's drafts carry its last token (see
  draft grants). Drafts stored before the binding, under ids nobody was
  assigned, are refused once and kept for copying.
- **The unassigned signal** (for the catch-up merge's re-author mode). Edits
  under an id the room does not hold for the user are answered apart from an
  invalid document on every path: a room write gets `document-rejected` code
  `unassigned` (material rooms) or `source-checkpoint-failed` code
  `unassigned` (source rooms), a draft send class `unassigned` (409), and the
  JOIN of a document that wrote under such an id `collaboration-unassigned-id`
  (`collaboration-client-id` means only that a live channel of another
  session holds the id, a reconnect of the same session taking over its own;
  the browser retries at once with a fresh token, and a document that wrote
  then hears `collaboration-unassigned-id`).
- **Awareness.** A channel's awareness entries are kept only under its bound
  id; entries under any other id are ignored.
- **Browser writers.** Notes, items and text sources write under their
  provider's document id; the text editor's IME merge writes its scratch copy
  under the same id. The Office editor's replica takes the id from the edit
  `load` message (Office protocol 13, `collaboration.clientId`), and the host
  applies its updates as the document's own (`applyOwnUpdate` in
  `src/features/files/sourceState.ts`): Yjs moves a document to a new id when
  its own id arrives in an applied update.

### Editing sessions

Epo approved the in-place Yjs collection on 2026-10-23
([storage quota](../backend-storage-quota.md#yjs-storage-growth)): a note's
stored state is collected when a room folds it, and an open room's own
document at its threshold folds (Q401, Epo 2026-10-26), keeping what an open
session or an Undo may still name; the sessions below are its bookkeeping,
and the collection stays off until the rest of its release lands. Notes only
(Q274, 2026-10-24): quiz, flashcard and other item rooms and source rooms
keep no sessions and their full history.

- **A session is one Y.Doc**, named by its client id (see [client
  ids](#client-ids)): one editor in one tab, whose Undo stack lives as long.
  A viewer, who never edits, has none; one whose token turns writable (a
  raised role closes nothing, so a token refresh after it) gets one at its
  first write, at the version it last named.
- **Versions.** Every JOIN names the stored version its document holds after
  the client id (0: a new document that holds nothing; one that took stored
  drafts before its first JOIN names theirs, `unsentFrom`). A note room tells
  a synced editor the stored version it holds right after answering its step
  1 and after each store commits, once every update the store holds went out
  (`{"type": "stored", "version": v}`, `STORED_TYPE` in `room.rs`): the latest
  version the room holds every version up to. A store whose version passed a
  service edit the room has not applied yet goes unannounced, and only stores
  announce (review r1 M1); a gap still open at the next store is logged at
  Warn, once per gap (review r3 N3). A service edit whose committed row the
  room cannot apply reloads the room from the stored document instead of
  counting its version (Q389, Epo 2026-10-26, `Room::reload`): joins wait as
  for a drain, every channel closes as the room is reset (its tab rejoins and
  resyncs), and the room stores what it holds and unloads, so the next room
  loads every row. The tab answers `{"type": "ack", "version": v}`
  whenever the version it may report changes. The room counts the session at
  its JOIN's version, then at each `ack` (never above the room's own
  version). A new session (version 0) that never synced is left out of the
  fold's reached version (review r1 H2), and a session that never
  acknowledged a store, holds nothing and has no row is forgotten with its
  last channel (review r2 L1). Acks, deletions and Leaves act only on the
  channel's own user's session (review r2 N3).
  A socket whose outbox dropped a frame sends nothing more and closes, so no
  notice follows a broadcast its reader missed.
- **The oldest unsent edit.** A tab never reports a version above the one its
  oldest unsent edit was made at (`RoomProvider.reportedVersion`): an edit
  stays unsent from the moment it is made until the second store's `stored`
  after the room's ACK of the message carrying it (review r1 H1, Editor
  2026-10-26, a plan change: admission is not durable, and the first notice
  may be a store that began before the edit arrived; the first notice on a
  channel answers its step 1 and counts for nothing). Before that it is in
  flight, admitted and not yet surely stored, held for a resend after a
  dropped channel, or not sent yet (offline, in a timeout, parked). An empty
  step 2 (a new document's) carries no edit, but takes a mark: the room
  already holds what it marks, which clears by the same rule (review r2
  N1). Drafts applied later (`unsentFrom`) mark the next update sent, which
  clears by the same rule (M2). Its JOIN, its `ack`s and its stored drafts carry at most that, and a
  document holding unsent edits reports at least 1. Each stored draft row
  keeps the version the tab reported when it was made (`EditDraft.version`, a
  merged row its oldest), and a draft send names its group's oldest in
  `X-Capy-Version` (a row from before versions, or made before the tab's
  first stored version, counts as 1, older than any collection; an
  unreadable one is refused as malformed, review r2 N2). A Leave
  while drafts are marked says unsent, so a draft send's hold keeps its
  session (N3).
- **Held deletions.** A session holds the deletions its own channel's updates
  made: what the room held undeleted, so a reconnect's step 2, which resends
  the whole delete set, adds only the session's own (`ydoc::apply_deleting`).
  They are what its Undo may restore. Each is stamped with its arrival (to
  the minute, the batch's latest) and released 25 h after it, since Undo
  reaches back 24 h on the tab's clock. A draft send's deletions are held for
  no one: its session ended.
- **Counted.** A session counts while connected and for 24 h after it was
  last seen. It ends at that cap, or on a clean Leave naming it, only the
  session bound to the leaving channel (a user ends only their own); its held
  deletions go then. A Leave with unsent edits or a dropped socket keeps it.
  A live session stays its user's: a JOIN of its id by another user changes
  nothing (the binding refuses that first).
- **Agent holds** (review r1 M3, Editor 2026-10-26, a plan change: in-place
  collection step 1 owns them). An agent edit's Undo and Redo are offered
  24 h after the edit, whether or not a room is loaded (Q385, Epo
  2026-10-26): the durable payload carries the edit's time, the server
  refuses it after its day, and the chat hides its buttons (see [agentic
  retrieval](../agentic-retrieval.md)); a step spanning rooms (a quiz's
  content and keys) ends as a whole (Q389). What the edit, its Undo and its
  Redo deleted is held 25 h from the edit, an hour past the offer as a
  person's holds are, whatever the sessions do (`AGENT_HELD_FOR`; an Undo or
  Redo keeps the edit's time; review r3 N8), so every payload the server
  accepts is held. They are not room state: the write records them in
  `material_yjs_documents.agent_held` (the same encoding) in its own
  transaction, under the document's row, loaded room or not
  (`note_store::hold_agent`, Q390), and a fold reads them under the same lock
  (`note_store::fold`) for collection to add to the sessions' holds. Agent
  holds that cannot be read are dropped and reported to Sentry, and the
  write or fold goes on (Q386, Epo 2026-10-26).
- **Stored** (migration 0117) as columns of the session's client-id row
  (`material_yjs_client_ids`: `acked_version`, `seen_at`, NULL when there is
  no session or it ended, and `held`, the batches as arrival times and Yjs
  delete sets). A store writes the sessions changed since the last one in its
  own transaction, in one statement, so a held deletion is durable with the
  state that holds it; the unload writes what changed after the last store,
  taking the document's row first as a store does (review r2 L5). A store
  takes the document's row `FOR NO KEY UPDATE`: a new id's queued row insert
  checks its key against that row, which a stronger lock would deadlock
  with (review r2 M1). A session's held deletions are written only when they
  changed (review r2 L4); a repeated `ack` changes nothing to write. Never
  for an account whose deletion began: a store locks the sessions' users
  with its accounts, in their order before the material (review r2 M2), and
  writes only live ones, so a purge waits for it and then deletes what it
  wrote. Only sessions whose id is recorded
  have a row: a deletion is an accepted write, so a session that only deleted
  is recorded too. A session that never wrote is counted in memory for its
  room's life. A room load reads the sessions seen within 24 h; a row whose
  held deletions cannot be read is dropped alone, written lost
  (`acked_version` -1, `sessions::LOST`, the other columns NULL) and reported
  to Sentry, and the note loads (Q382, Epo 2026-10-26). A moved lineage (a
  discard) ends the old lineage's sessions in its transaction (review r2
  L3).
- **The fold's input** (`Sessions::holds`): the oldest version every counted
  session reached (none when no session counts), never past the oldest draft
  group the room admitted and has not stored yet (Q400), and their held
  deletions with the agent holds, which choose the collection's window and
  what it keeps.
- **Late.** A JOIN or a draft group naming a version below the latest
  collection's window has missed what that collection discarded (`late` in
  `sessions.rs`, version 0 never is; a draft group must name 1 or later).
  So has one under the id of a session
  whose record was lost, whatever version it names (Q385, review r2 M1): its
  held deletions were not kept; for a draft group, an id its grants name or
  one it writes under, which the room admits through its record (review r3
  L4). The latest collection's window is stored with the document
  (`collected_window`); while a fold runs, the room checks against the most
  it may move to. Such a JOIN is refused before it makes a session and such
  a group answers `late`; the tab merges ([the late path](#the-late-path)).
  Until a collection records its window only lost ids are late.

### Client protocol and the release nudge

Developer Epo decided the gate and the nudge on 2026-10-16 (the version-gate
design, option d), and the nudge's release file on 2026-10-17.

- **The gate.** Every JOIN carries the build's client protocol after the
  token (`room, token, varuint protocol, varuint clientId, varuint version,
  varuint note, varbytes sessionId`: the note is an embed's note channel, 0
  outside a note, and the session id 16 random bytes from protocol 23; the
  client id is the Y.Doc's and the session id its provider's, see [client
  ids](#client-ids), and the version the stored one it holds, see [editing
  sessions](#editing-sessions)),
  and every draft send carries it as
  `X-Capy-Protocol`. The number is `CLIENT_PROTOCOL` in
  `src/features/collaboration/protocol.ts` and
  `collaboration-rs/crates/server/src/protocol.rs`; a vitest keeps them equal.
  - The server keeps one minimum per room family:
    - material rooms (`material:`, `keys:`: notes, mindmaps, diagrams,
      quizzes, quiz keys, flashcard sets, canvases): `MIN_MATERIAL`;
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
    inert, no palette or ghost text, `canEdit` off);
  - item editors show their list or diagram read-only;
  - a source keeps its view, with Office `set-capabilities` turning editing
    off.

  The one-row `outdated` save strip reads "Capy was updated. Reload to keep
  editing. Your edits are saved on this device and will sync after you
  reload.", with Reload in the close button's place. When this device could
  not store the unsent edits (`outdated-unstored`), it says so instead: "This
  device couldn't store your unsent edits, so reloading loses them." The
  header status is Cloud unavailable, as in recovery. An item room or
  source session
  refused before it synced shows the strip alone (a source shows its base
  and this device's drafts, read-only).
- **Its drafts stay.** Nothing is discarded, refused or marked. The reloaded
  page applies them before it joins (or the sweep sends them), so they go
  through the new version's checks as offline edits do; a refusal there
  gives the usual refused draft. A source whose edits this device stored no
  longer counts as unsaved, so Reload brings no "Leave site?" prompt (a
  note, source or item editor whose storage failed still asks).
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
    stays in the page, as does a move between one workspace's pages
    (`/workspaces/<id>/study/practice` and the like, `workspaceOfPath`), so
    a streaming chat turn and the docked chat's draft are not cut. While offline the
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
  The Office protocol 11 (the edit `load`'s growth budget, Epo 2026-10-17)
  raised `CLIENT_PROTOCOL` to 5 and `MIN_SOURCE` to 5; `MIN_MATERIAL` stays 4.
  Its deploy request names "client protocol 4 -> 5, source 3 -> 5".
  The rate-limit round (the open-slowed notice in both families, an embed's
  note channel in its JOIN; Epo 2026-10-20), landing with the XLSX pin and
  Office protocol 12, raised `CLIENT_PROTOCOL` to 6 and both minimums to 6.
  Its deploy request names "client protocol 5 -> 6, material 4 -> 6, source
  5 -> 6, Office 12".
  The room presence (a stateless message both families act on, cursor labels
  from it instead of awareness; Epo 2026-10-20) raised `CLIENT_PROTOCOL` to 7
  and both minimums to 7: an older client would keep reading names from
  awareness. Its deploy request names "client protocol 6 -> 7, material
  6 -> 7, source 6 -> 7".
  The DOCX engine round (every DOCX seed changes, Word rooms reset; Epo
  2026-10-20) raised `CLIENT_PROTOCOL` to 8 and `MIN_SOURCE` to 8;
  `MIN_MATERIAL` stays 7. Its deploy request names "client protocol 7 -> 8,
  source 7 -> 8".
  The BetterOffice pins landed since then without a bump (Office DOCX
  edbb81eea, PPTX b50fc6f4f, DOCX speed 9664f2ff9); the speaker notes cap
  (pin ceecaec31) raised `CLIENT_PROTOCOL` to 9 and `MIN_SOURCE` to 9 for all of
  them; `MIN_MATERIAL` stays 7. Its deploy request names "client protocol
  8 -> 9, source 8 -> 9".
  The yrs block lookup fix (pin 3fdc52f50: a lookup outside a client's blocks
  finds nothing instead of panicking) raised `CLIENT_PROTOCOL` to 10 and
  `MIN_SOURCE` to 10; `MIN_MATERIAL` stays 7. Its deploy request names
  "client protocol 9 -> 10, source 9 -> 10".
  The Office agent DOCX id parser (pin 45d17fc72: every DOCX command reads
  its id through one parser, refusing a bare paraId, table or cell id by
  naming the read's id; UAT 2026-10-22) raised `CLIENT_PROTOCOL` to 11 and
  `MIN_SOURCE` to 11; `MIN_MATERIAL` stays 7. Its deploy request names
  "client protocol 10 -> 11, source 10 -> 11".
  The Office agent's short table id and format_text's `text` (pin
  337896d27: delete_table takes `body:t0` naming one table, format_text names
  its span `text`; Epo 2026-10-23) raised `CLIENT_PROTOCOL` to 12 and
  `MIN_SOURCE` to 12; `MIN_MATERIAL` stays 7. Its deploy request names
  "client protocol 11 -> 12, source 11 -> 12".
  The room swap (pin 86237e2c1: BetterOffice going read-only and a
  document's first frame keep the view, reader actions still bring the caret
  into view, a peer's change never does; Epo 2026-10-22, 2026-10-23) raised
  `CLIENT_PROTOCOL` to 13 and `MIN_SOURCE` to 13; `MIN_MATERIAL` stays 7. Its
  deploy request names "client protocol 12 -> 13, source 12 -> 13".
  Phase 0 of the tombstone work (pin 870dc1661: yrs collects an item next to
  a collected unit, as Yjs does; Epo 2026-10-23) raised `CLIENT_PROTOCOL` to
  14 and `MIN_SOURCE` to 14; `MIN_MATERIAL` stays 7. Its deploy request names
  "client protocol 13 -> 14, source 13 -> 14".
  The Office agent's short paragraph ids and malformed-id refusals (pin
  faacf7887: a DOCX paraId alone names its one paragraph, and a malformed
  slide, shape, paragraph or table id is refused as malformed, showing the
  read's form; Epo 2026-10-24, Q222 and Q223) raised `CLIENT_PROTOCOL` to 15
  and `MIN_SOURCE` to 15; `MIN_MATERIAL` stays 7. Its deploy request names
  "client protocol 14 -> 15, source 14 -> 15".
  The Undo redo rule (pin d5b87cd17 and the yjs patch: a restored copy
  keeps its traced right neighbour only when it lies after its left; Epo
  2026-10-24, Q247-Q250) raised `CLIENT_PROTOCOL` to 16 and both minimums to
  16, so note and item tabs without the rule reload. Its deploy request names
  "client protocol 15 -> 16, material 7 -> 16, source 15 -> 16".
  The DOCX typing fixes (pin 88b28baa4: a page whose positions only shift
  keeps its mirror and overlay nodes, charts, shapes and content controls are
  named by their embed, and the position projection follows typed text; Epo
  2026-10-24, Q351) raised `CLIENT_PROTOCOL` to 17 and `MIN_SOURCE` to 17;
  `MIN_MATERIAL` stays 16. Its deploy request names "client protocol 16 -> 17,
  source 16 -> 17".
  The client-id binding (Q213: every JOIN names its Y.Doc's client id after
  the protocol, Office protocol 13; pin 58518dfdb: the DOCX layout worker
  writes under its assigned id, Q219) raised `CLIENT_PROTOCOL` to 18 and both
  minimums to 18. Its deploy request names "client protocol 17 -> 18,
  material 16 -> 18, source 17 -> 18".
  The Office agent's pictures and charts (pin 13f70b8f6: the reads list
  pictures and charts and a by-id read returns their bytes and series; Epo
  2026-10-24, Q240 phase A, with the review fixes of Q381, Q384 and Q388)
  raised `CLIENT_PROTOCOL` to 19 and `MIN_SOURCE` to 19. The editing sessions
  (the in-place collection's bookkeeping, Epo 2026-10-23: every JOIN names the
  stored version its Y.Doc holds after the client id, note rooms send `stored`
  and take `ack`, a Leave names its session) raised `CLIENT_PROTOCOL` to 20
  and `MIN_MATERIAL` to 20; `MIN_SOURCE` stays 19, since a source JOIN or
  Leave from an older build carries no version or session and still reads.
  The two landed together, so their deploy request names "client protocol
  18 -> 20, material 18 -> 20, source 18 -> 19".
  The UI branch's reading layouts (pin 502d19fc9: the DOCX reading layout
  for narrow viewers and the PPTX strip and Notes button below the slide;
  Epo 2026-10-26, Q394) raised `CLIENT_PROTOCOL` to 21 and `MIN_SOURCE` to
  20; `MIN_MATERIAL` stays 20. Its deploy request names "client protocol
  20 -> 21, source 19 -> 20".
  The in-place collection release (Epo 2026-10-26: the collection on, the
  late path's `collaboration-late` JOIN refusal and `late` draft class, the
  `hidden` draft class of hidden typing, the merge view, Q229's editable
  copy, Q402's agent edits through the open room) raised `CLIENT_PROTOCOL`
  to 22 and `MIN_MATERIAL` to 22: an older note tab reads `collaboration-late`
  and `late` as retryable and rejoins with its stale version forever, reads
  `hidden` as `later` and holds every JOIN behind a draft send that never
  settles, and holds tombstones the room may collect (Q410, the late path's
  protocol note). `MIN_SOURCE` stays 20: source rooms are never collected,
  an older source tab reads no new answer, and Q402's room-admitted agent
  edits reach it as ordinary updates. Its deploy request names "client
  protocol 21 -> 22, material 20 -> 22".
  The session id on every JOIN (a reconnect of the same session takes over
  its own channel; Epo 2026-10-28, Q472) raised `CLIENT_PROTOCOL` to 23 and
  neither minimum: an older tab sends no session id and is answered as
  before. A JOIN outside a note now names note channel 0, which a server
  before it looks up as a note channel ahead of its version gate: after a
  backend rollback below 23, such a server refuses a newer tab's JOINs as
  `collaboration-note-closed`, not outdated, so the tab shows no outdated
  prompt and its rooms stay unjoined, drafts kept, until a reload (Epo
  2026-10-28, Q476: accepted with no client handling; the normal deploy
  order, backend before site, avoids it). Its deploy request names "client
  protocol 22 -> 23".
  The PPTX Edit strip's scrollbar fit (pin 383d00566: a strip thumbnail
  takes the width its button leaves; Epo 2026-10-30, Q588) raised
  `CLIENT_PROTOCOL` to 24 and `MIN_SOURCE` to 24, so every source tab on the
  older pin (protocols 20 to 23) reloads; `MIN_MATERIAL` stays 22. Its deploy
  request names "client protocol 23 -> 24, source 20 -> 24".
  The BetterOffice 0.5.1 pin raised `CLIENT_PROTOCOL` to 25 and `MIN_SOURCE` to
  25, so source tabs on the older pin (protocol 24) reload; `MIN_MATERIAL` stays
  22. `OFFICE_PROTOCOL_VERSION` stays. Its deploy request names "client protocol
  24 -> 25, source 24 -> 25".
  The zip 9.0.5 pin raised `CLIENT_PROTOCOL` to 26 and `MIN_SOURCE` to 26, so
  source tabs on the older pin (protocol 25) reload; `MIN_MATERIAL` stays 22.
  `OFFICE_PROTOCOL_VERSION` stays. Its deploy request names "client protocol
  25 -> 26, source 25 -> 26".
  The Office ribbon (`OFFICE_PROTOCOL_VERSION` 13 -> 14: `set-banner`,
  `banner-action`, `ribbon-focus`, `load`'s `ribbon`, `menu-file` gone) raised
  `CLIENT_PROTOCOL` to 27 and `MIN_SOURCE` to 27, so source tabs drawing the old
  header reload; `MIN_MATERIAL` stays 22. Its deploy request names "client
  protocol 26 -> 27, source 26 -> 27".
  The second upstream sync's pin (2ddee4002: packed fonts, regenerated engine
  types) raised `CLIENT_PROTOCOL` to 28 and `MIN_SOURCE` to 28; `MIN_MATERIAL`
  stays 22 and `OFFICE_PROTOCOL_VERSION` stays 14. Its deploy request names
  "client protocol 27 -> 28, source 27 -> 28".
  The note's table view (`table_view`, Epo 2026-11-12: a new shared-map element
  whose `columns`, `rows` and `views` are id-matched shared lists) raised
  `CLIENT_PROTOCOL` to 29 and `MIN_MATERIAL` to 29, so a note tab from before it
  reloads instead of writing a table view's block as a plain value;
  `MIN_SOURCE` stays 28. Its deploy request names "client protocol 28 -> 29,
  material 22 -> 29".
  The Q691 pin (f1848de46: DOCX View and Edit load only the CJK slices their
  pages draw, the XLSX viewer opens without the save capture, the DOCX page
  mirror is patched per key and reads whole words, the XLSX cell editor takes
  the cell's fill) raised `CLIENT_PROTOCOL` to 30 and `MIN_SOURCE` to 30 on
  `main`, so source tabs on the older pin (protocols 28 and 29) reload;
  `MIN_MATERIAL` stayed 29 and `OFFICE_PROTOCOL_VERSION` stays 14. Its deploy
  request named "client protocol 29 -> 30, source 28 -> 30".
  Quiz figures held as maps (Epo 2026-11-16: a chart, plot or graph in a live
  quiz room is a map of its fields, a graph's elements keyed by id) raised
  `CLIENT_PROTOCOL` to 30 and `MIN_MATERIAL` to 30 on its own branch, at the
  same time, so a quiz tab from before it, which writes a figure as one value
  the room now refuses, reloads. Stored quiz rooms are dropped at that deploy
  and seed again from their questions (migration 0178,
  [deployment-runbook](../deployment-runbook.md#quiz-figure-maps-reset-migration-0178)).
  Canvas rooms (Epo 2026-11-18: a canvas's board is a room in the `material:`
  family, no longer a saved board asset) raised `CLIENT_PROTOCOL` to 31 and
  `MIN_MATERIAL` to 31, since the family's minimum is the only gate before any
  lookup: a tab from before saves a canvas through a route that is gone.
  Existing canvases are deleted at that deploy (migration 0181,
  [deployment-runbook](../deployment-runbook.md#canvas-rooms-migrations-0181-to-0183)).
  The two 30s met in one merge; 31 covers both, and `MIN_SOURCE` stays 30.
  The quiz-figure and canvas changes land together, so their deploy request
  names "client protocol 30 -> 31, material 29 -> 31".
  The second Q691 pin (b3b0e6bc8: DOCX View's screen readers read a
  whole-word layer beside the per-letter text layer, View starts the painting
  CJK face's core as layout starts, a CJK face failing to open while editing
  is the slice notice and opens again online, the XLSX viewer builds its grid
  geometry once and a wrapped cell's row refits after recalculation, a PPTX
  key reads only its slide) raised `CLIENT_PROTOCOL` to 32 and `MIN_SOURCE`
  to 32, so source tabs on the older pin (protocols 30 and 31) reload;
  `MIN_MATERIAL` stays 31 and `OFFICE_PROTOCOL_VERSION` stays 14. Its deploy
  request names "client protocol 31 -> 32, source 30 -> 32".
  The C6 and Q789 pin (bbbde1d4e: DOCX View hands over its first pages before
  the rest are laid out, the DOCX editor's per-key reads touch only the
  paragraphs and stories that changed) raised `CLIENT_PROTOCOL` to 33 and
  `MIN_SOURCE` to 33, so source tabs on the older pin (protocol 32) reload;
  `MIN_MATERIAL` stays 31 and `OFFICE_PROTOCOL_VERSION` stays 14. Its deploy
  request names "client protocol 32 -> 33, source 32 -> 33".
  Keyed chart lists (Epo 2026-11-22: a canvas chart's `bars`, `labels` and
  `spokes` are maps of id to `{element, order}`, and `fills` is gone, each
  line carrying its slice's fill) raised `CLIENT_PROTOCOL` to 33 and
  `MIN_MATERIAL` to 33: the same keys changed shape, and each build's load
  check refuses the other's, so a tab from before and a newer tab on one canvas
  would each show the other's charts as "cannot be shown". The tab from before
  reloads instead. A chart already stored in the old shape draws as that
  placeholder on a workspace canvas; on a question board (a drawing answer)
  `checkSavedBoard` throws on it, so a saved answer or a device draft holding
  one fails to open. Both are accepted, since there is no production data (no
  shim).
  The two 33s met in one merge before either was deployed, so 33 covers both:
  `MIN_MATERIAL` and `MIN_SOURCE` are both 33, and their deploy request names
  "client protocol 32 -> 33, material 31 -> 33, source 32 -> 33".
  The first Q608 landing and the Q667 pin land together (Office protocol 15:
  every reader place carries its frame's zoom, viewers answer
  `position-request`, and an XLSX place may name its sheet by name; pin
  eb7d8b4f7: chat citations are highlighted inside the DOCX, XLSX and PPTX
  editors). They raised `OFFICE_PROTOCOL_VERSION` to 15, `CLIENT_PROTOCOL` to
  34 and `MIN_SOURCE` to 34, so source tabs from before them (protocol 33)
  reload; `MIN_MATERIAL` stays 33. Their deploy request names "client protocol
  33 -> 34, source 33 -> 34".
  The Q801 pin (bda081c71: DOCX View lays out the first screen of pages
  before the rest, the page count and scroll height growing as pages come,
  and `painted` sent again as the count grows; short files, bodies all in
  columns, cited opens and prints lay out whole) raised `CLIENT_PROTOCOL` to
  35 and `MIN_SOURCE` to 35, so source tabs on the older pin (protocol 34)
  reload; `MIN_MATERIAL` stays 33 and `OFFICE_PROTOCOL_VERSION` stays 15 (the
  runtime messages keep their shape). Its deploy request names "client
  protocol 34 -> 35, source 34 -> 35".
  The Q813 and Q814 pin (ccb90cc2d: the DOCX editor's worker lays out every
  pass and the page adopts its layout, the table-of-contents pass and a
  failed worker laying out on the page; a pass over an unchanged input, such
  as a web-font load, is skipped in the worker and in the page's engine)
  raised `CLIENT_PROTOCOL` to 36 and `MIN_SOURCE` to 36, so source tabs on the
  older pin (protocol 35) reload; `MIN_MATERIAL` stays 33 and
  `OFFICE_PROTOCOL_VERSION` stays 15 (the runtime messages keep their shape).
  Its deploy request names "client protocol 35 -> 36, source 35 -> 36".
  Merges past a cap (Epo 2026-11-22, "Yes, A everywhere": readers, the room
  and the stores keep a list or text two people's edits merged past its cap,
  up to twice it, and editors stop at the cap) raised `CLIENT_PROTOCOL` to 37
  and `MIN_MATERIAL` to 37. A tab from before reads a chart's series and a
  graph's elements cut to the cap, and its whole-figure write deletes the ones
  it left out, a peer's merged edits; its validators hide a quiz question a
  merge took past a cap and its question text fields undo typing in a text
  over one. The tab from before reloads instead. No source room changed, so
  `MIN_SOURCE` stays 36 and `OFFICE_PROTOCOL_VERSION` stays 15. Its deploy
  request names "client protocol 36 -> 37, material 33 -> 37".
  The board rules in the browser (Epo 2026-11-22, B: every viewer reads a
  canvas by one strict rule set, `boardRules.ts`, and draws what breaks it as
  "This block cannot be shown"; the room-side content check was dropped)
  raised `CLIENT_PROTOCOL` to 38 and `MIN_MATERIAL` to 38. The board catalog
  changed (the emoji list; images under a paragraph, list or image in a
  note), and a tab from before draws content the rules refuse, such as a
  chart axis top past `AXIS_MAX`, where a new tab shows the placeholder. The
  tab from before reloads instead. No source room changed, so `MIN_SOURCE`
  stays 36 and `OFFICE_PROTOCOL_VERSION` stays 15. Its deploy request names
  "client protocol 37 -> 38, material 37 -> 38".
  The yrs decode pin (capy/yrs-decode-capacity: a decoded list of values
  reserves its declared length up to the bytes left, so its `Vec` keeps no
  spare capacity; room memory report cut 3) raised `CLIENT_PROTOCOL` to 39
  and `MIN_SOURCE` to 39, as every pin bump does (office-files "Pin bump
  checklist"); the wire format and every stored shape are unchanged, so
  `MIN_MATERIAL` stays 38 and `OFFICE_PROTOCOL_VERSION` stays 15. The number
  is set at merge, since other branches also want 39. Its deploy request
  names "client protocol 38 -> 39, source 36 -> 39".
  The DOCX Find pin and the agent admission land together (pin f18e63f35,
  Q825 A and Q828 A: DOCX Find focuses its box the moment it opens and loads
  with the editor, so the keys typed right after Ctrl+F reach it, and every
  Ctrl+F opens it seeded from the editor's selection; Q826 A and Q827 A: an
  agent edit a room opened for goes through that room's admission, and a
  person's update refused for size and the store's size reset carry
  `reason: "source_state_bytes"` on `source-checkpoint-failed`, which a
  source tab shows as the size-limit banner, while `authorization-revoked`
  naming a source tab's room sends its unsaved edits to recovery). They
  raised `CLIENT_PROTOCOL` to 40 and `MIN_SOURCE` to 40, so source tabs from
  before them (protocol 39) reload; `MIN_MATERIAL` stays 38 and
  `OFFICE_PROTOCOL_VERSION` stays 15 (the runtime messages keep their
  shape). Their deploy request names "client protocol 39 -> 40, source
  39 -> 40".
  Groups of pieces (2026-11-22, a wrong behaviour with no product decision:
  a room admitted an action's pieces one by one, so a later piece refused
  left the earlier ones with peers and in the store) add SYNC type 3,
  `PIECE` (see **Update allowance and pieces** under
  [Connection lifetime and refusals](#connection-lifetime-and-refusals)),
  in both families. A server before it refuses a piece as a malformed sync
  message, and a tab before it sends its pieces as plain updates the room
  admits one by one, the partial actions again. It raised `CLIENT_PROTOCOL`
  to 41 and both minimums to it (material 38 -> 41, source 40 -> 41),
  `OFFICE_PROTOCOL_VERSION` staying 15.
  Draft sends name their group on the same change (`X-Capy-Group` on each
  piece of a group of more than one, listed by the preflight): a page
  before it, whose pieces a room would admit one by one, is refused as
  outdated with the minimums raised, and a page after it cannot send a
  group to a server before it (the preflight refuses the header), so its
  sweep retries until the server is updated. Its round 2 changed draft
  sends again (a group's id is its rows' and the same at every send, a send
  goes on from the piece that failed, a repeated piece answers
  `piece-held`, a group past the room's bound answers `unavailable`, and a
  second group of the user's answers `busy`, Epo 2026-11-23) and added the
  stateless `group-dropped` and `group-busy` notices, which a tab before it
  ignores: it would resend a late group at once, late again on a slow
  uplink, and never resend a busy one. The same bump covers it. Its round 3
  changed them once more: a group past the room's bound answers `busy`
  (a draft, 409) or `group-busy` (a channel) instead of `unavailable`, a
  group naming more pieces than the cap allows answers `malformed` with its
  own reason instead of a size limit, and a resumed draft group answered
  `unavailable` starts over from piece 0. A tab before it would take a busy
  group's ACK as its admission and delete the group's draft rows, so the
  same bump is needed for correctness, not only for behaviour. Round 4 kept
  the bump: a channel group's first piece is acknowledged on its own once
  held, the rest with the last (a tab before it adds the two up as one),
  and a tab after it sends the rest only on that acknowledgement, which a
  server before it never sends, so its group would stall; a channel's busy group
  waits under its JOIN session; a draft piece the group does not expect
  answers `unavailable` without dropping the group. The heartbeat rides the
  same bump (2026-11-24): a tab sends the text frame `HEARTBEAT` every 20 s
  (`HEARTBEAT` and `HEARTBEAT_MS` in protocol.rs and protocol.ts, a test
  keeps them equal), which keeps its socket open, and its group alive while
  the first piece's acknowledgement waits, through a long frame to it. A
  server before it ignores text frames, and a tab before it sends none, so
  such a tab's group would be dropped as late behind a long frame.
  Its deploy request names "client protocol 40 -> 41, material 38 -> 41,
  source 40 -> 41".
  The DOCX worker and caret pin (pin 45d220dcd, Q815 C step 1: the DOCX
  editor's engine worker starts as the session opens and loads the state the
  page loaded, so its first frame request ships only what changed since;
  Q833 B: an edit the reader makes before the session's first caret pass,
  typed or from the ribbon, Find or Undo, brings the caret into view) raised
  `CLIENT_PROTOCOL` to 42 and `MIN_SOURCE` to 42, so source tabs from before
  it (protocol 41) reload; `MIN_MATERIAL` stays 41 and
  `OFFICE_PROTOCOL_VERSION` stays 15. It took the next number after the
  groups of pieces (the first of the two to land takes the next number).
  Its deploy request names "client protocol 41 -> 42, source 41 -> 42".
  Canvas questions (the Canvas part type, a part's `answer.shared` canvas
  graded once, drawings stored under the shared canvas's lead part, and the
  room's question validator capping images and canvases; Epo 2026-11-23,
  the Canvas questions picks) raised `CLIENT_PROTOCOL` to 43 and
  `MIN_MATERIAL` to 43, so material tabs from before the format (protocol
  42) reload; `MIN_SOURCE` stays 42 and `OFFICE_PROTOCOL_VERSION` stays 15.
  Its deploy request names "client protocol 42 -> 43, material 41 -> 43".
  Binary pen points (Epo 2026-11-24: a canvas stroke's points are one binary
  value of Float32s, `strokePoints.ts`, vendored BlockSuite local change 79)
  raised `CLIENT_PROTOCOL` to 44 and `MIN_MATERIAL` to 44: a tab from before
  draws a stroke stored so as a placeholder, as its rules refuse bytes, and
  writes number arrays a newer tab draws as one. No source room changed, so
  `MIN_SOURCE` stays 42 and `OFFICE_PROTOCOL_VERSION` stays 15. Nothing reads
  the number arrays any more and no production data holds them: UAT's canvases
  are deleted by hand at the deploy (a saved drawing answer or drawn sample
  with strokes from before is refused as it opens, as any misfit is). Its
  deploy request names "client protocol 43 -> 44, material 43 -> 44".

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
are saved on this device and will sync when you reconnect." until the room syncs again. Readers (Note View, study
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
of another room, refused rows and a session's rows past the expiry become
the merge view's pieces once the room synced (see [the merge
view](#the-merge-view), Q251); nothing of them is applied. A session's rows
expire 7 days after its newest row (`draftGroups`, Epo 2026-10-24), and the
draft sweep never sends them; items, Office and text files show an expired
group once under the `expired` banner and delete it as it opens
(`dropExpiredGroup`). A group with no `state` row
cannot be drawn (a tab closed online, then the room moved): it is dropped
with "Some unsaved edits from your last session couldn't be restored."

While offline a session may hold up to `maxContentBytes` (2 MiB) of unsaved
local updates; past that the editor turns read-only under the `offline-limit`
banner until it reconnects: the content is `readOnly` (block actions follow
Plate's read-only state), the toolbar is inert, the command palette, ghost
text and floating toolbar are not mounted, `canEdit` is off for the rest, and the
recorder stores nothing more. What was stored stays; nothing reaches the
editor through REST-backed dialogs offline anyway. When storage fails
(private mode, a full disk) editing continues in memory under the
`offline-unstored` banner; after a failed write the next one holds the whole
document, and the banner goes back to `offline` only once that lands. Until
then closing or reloading the tab asks while an edit has no receipt (Q561). `navigator.storage.persist()` is asked once, at the
first row written while offline, except on Firefox, which prompts. Safari
deletes script storage of a site not visited for 7 days, and private windows
delete it on close. Rows of a note the account no longer has go on a 404, or a 403
for the note itself (token, refusal), and in the draft load sweep (below),
once per page load, which asks each stored document's token endpoint. A 403 about the account itself
(`account_suspended`, `account_deletion_pending`: `isAccountForbiddenError`)
keeps them, and so does the collaboration service's forbidden reason alone,
which an account lock gives too; the sweep settles that case
(`refusalDropsDrafts`). A note that was deleted (moved to the Trash) is not
lost: its token answers 410 `item_deleted` to whoever could read it (see
[authorization](../authorization-permissions-lifecycles.md), What a refusal
shows), and its rows stay (Epo 2026-11-19 and 2026-11-20, Q39-Q41). Its trash
readers (its payer, the workspace's owner) are read the trashed item instead,
which a page not opened from the Trash takes as deleted too: the creator
trashing their own note in another tab sees the same strip, never the Trash's.
The open editor writes its whole document once more (`snapshot`, so the rows
draw without the room) and turns read-only as for a refusal, the recorder
keeping the rows until it unmounts; the page, whose read answers the same,
keeps the item on screen under "This item was deleted. Your unsaved edits are
shown here to copy until you discard them." while this device holds unsent
edits to it (`useDeletedEdits` in `lostEdits.ts`, holding their documents so no sweep
offers or deletes them meanwhile, and dismissing a toast already offering
them), and says "This item is unavailable" when it holds none or cannot read
its store. A deleted note, quiz, set or diagram never reads as lost access: a
room that hears of it first (its rejoin's or fresh room's token answering 410
while the page's read is still out) holds what it showed read-only, with no
strip and no save status, and reports nothing to the page
(`ItemRoomSnapshot.deleted`; a note's in `NoteEditorCore`), so the page's read
alone says what shows; once that read said deleted, the item restored and read
again opens its editor anew on a fresh room. A not-found from the
collaboration service alone, which a deleted item says too, asks one fresh
token: an item room's (`notFoundByRoom`) reports lost access only on a 404 or
403 and rejoins on a live token or no answer, and a note's, whose editor stays
read-only, reports it unless that token is a 410. An item counts
as shown once its read or its device copy painted it, on its workspace's page
and on its own (`/materials/:id`, which keeps the page mounted instead of its
error or Trash view). A note is drawn from its
stored rows alone, as its Download draws it (`deletedNote`): the newer of the
room document its Yjs rows draw (`deletedDocument`, the newest lineage and
base group) and its newest saved copy (Q229), its merge view's pieces last,
painted static, with each image, audio, embedded quiz or set and interactive
block a line saying it is not included. Office and text files show the same
strip as their session banner (`deleted`), and quizzes, sets, diagrams and
canvases as their recovery view's (`ItemRecovery.deleted`, drawn the same
way); a quiz's writer keeps its keys room while a fresh token is asked, so
edits to its keys alone show beside its questions as last read. While
deleted, nothing that writes or needs the server stays: the View/Edit
toggles, a note's Preview, the ⋮ item actions that ask the server (rename,
move, Shared with members, clone, its usual download, delete), a quiz's or
set's Practice. The ⋮ keeps Properties, from the item's last read, and
downloads made from what the page shows (Epo 2026-11-20): a note's Download
Markdown and Download Word, an Office or text file's Download, each the
strip's file; other kinds have none there. The deleted strip has Discard
then Download for every kind (Epo 2026-11-21: Discard the `ghost-hover`
Button, Download the `dark` one, neither underlined; `DeletedDownload` in
`SaveBanner`, Office's in its frame drawn alike, a canvas's on its board's
strip, where Discard asks first and its confirm reads Discard; Discard alone
where the page has no Download). Discard (`discardDeleted`) deletes the rows
the page shows and loads the page again. Download saves the toast's file
(`saveShownEdits`) from the rows the page shows (`shownDeletedRows`, matched
by id and seq as Discard matches them), deleting nothing, so Discard still
ends them; a file that cannot be made says "Your edits couldn't be downloaded.
They're kept on this device.". The strip's Download and the ⋮ entries show
once the room, session or note drawing shows the edits
(`useShowsDeleted`), before which they would draw nothing. A canvas's board
menu keeps its Download as image of the board shown, and Office its menu
bar's Download of the open document.

What shows, what Download writes and what the strip's Discard deletes come
from one drawing (`ShownDrafts`): `deletedDocument` draws one group of rows (one
lineage and base, a board's hidden edits from Q33 always a group of their
own, since they copy the early board with what still showed deleted), and
the strip's Discard or the toast's Download deletes the rows of that group as
drawn (by id and seq; the open page's Download deletes none);
an open session's own document deletes the rows it holds. Rows of another
group, another tab's lineage, an older base or an unreviewed piece stay and
come back as the next page load's toast. The toast acts on the rows it
offered (`DeletedDrafts.offered`, the ids each document held then): its
Download draws only those, and its Discard deletes only those, neither
touching a document an editor holds (`deleteUnheldDrafts`), so a toast left
open across a restore and a live open never takes that session's edits.
Online, a note's unacknowledged typing is update rows only, which no
drawing places without the room: the discard's notice writes its whole
document before the page's read is asked again, so the page, which hears
`item_deleted` from that read before the rejoin's token, draws it. Item
rooms and file sessions draw from their own document. A quiz whose keys
alone have edits takes its questions from this device's copy of its
content room, which the copy sweep keeps while any edits to the item are
stored (`sweepDeviceCopies`); with none, its file says the questions are
not included. The strip's and the toast's Discard are counted as
`discard_unsaved` with the reason `item_deleted`, apart from a lost item's
silent `not_found`. A read of the store that fails deletes nothing and shows
the item unavailable. The collaboration service's "not found" alone (no API
answer behind it) keeps the rows and asks a fresh token, whose 410 or 404
decides (`refusalKeepsDrafts`); only the API's 404 drops them. A file whose
session cannot open because it was deleted (410 at open) shows unavailable,
its rows kept for the next page load's offer.

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

### Device copies

Epo decided on 2026-11-04 (C1, ahead of the offline round's order) that a device
keeps the Yjs state of what it opened, so an item paints at once and only the
difference downloads. "Copy" alone means Q229's rows below; this one is a device
copy (`src/features/collaboration/deviceCopy.ts`, stored by
`src/lib/sourceCache.ts`).

- **Who** (C2): members, viewers included (`keepsCopyOf`: `isOwner` or a `role`,
  which a link visitor's read does not carry). Not someone who came through a
  link. Under MSW only `mock-scenario-` fixtures keep one, since only their rooms
  survive a reload, and the load-test notes, whose rooms reseed the same state; a
  copy of a reset room would merge back into it.
- **Which** (C8): a note's room; a set's and a diagram's room; a quiz's content
  and keys rooms for whoever may read keys, since they already have them. Every
  item also keeps its last material read (`document: 'read'`, `useMaterialCopy`),
  the answer-free one, which paints it before its read answers. That read is a
  viewer's whole copy of a quiz, a set or a diagram: a quiz's ordering and matching
  lists reach a reader outside Yjs (`quiz-items`), and a diagram's reader joins no
  room. Someone gone from editing to viewing loses the keys copy when the quiz
  next opens for them (`QuizPreview`).
- **Limits** (C6): the source cache's. One budget of 200 MiB with the source
  bytes, least recently opened out first, a store that would leave under 100 MB
  free is skipped, and a draft write the quota refuses deletes entries here. No
  count, per-note cap or age limit.
- **Owner** (C1, C7): every row names its account and a read for anyone else
  deletes it. Signing out wipes the store with the source bytes
  (`claimSourceCache`, `claimAccountData`). No separate account-switch rule.
- **Lost access** (C3): a brief stale glimpse is accepted and there is no remote
  wipe. A person refused on connecting loses the copy (`dropDeviceCopies`), and
  at each page load `POST /api/materials/readable` answers which kept ids the
  account can still read, in one query, and the rest go (`sweepDeviceCopies`),
  but for one whose drafts that load's draft sweep kept (`loadSweepKept`: a
  deleted item's, answered `item_deleted`; one a page here or another tab's
  editor holds; one it could not answer). A deleted quiz's Download reads its
  questions there (Q43); the readable check cannot tell deleted from lost
  access, so the device-copy sweep waits for the draft sweep and does nothing
  when it did not run (another tab swept), nor one whose drafts a page or
  editor here holds as it goes (`materialHeldHere`: deleted after the draft
  sweep, that page decides). A material read answered 403 or 404 removes
  them at once, the last read included.
- **Deleted** (review 2026-11-20): every path that drops a deleted item's copy
  (the room's `item_deleted` refusal or 410 token, a discard's eviction, the
  page's deleted read, a note's deleted token) keeps it while this device holds
  stored edits to the item (`dropDeletedCopies`, `draftMaterials`), read once
  the editor's last rows landed (its recorder's dispose or snapshot); the next
  load's sweep drops it once they go. An unknown account or an unreadable store
  keeps it for that sweep.

- **What a copy is.** The room's state as one row per document, written whole:
  never per key, and only when nothing of this device's is unsent
  (`keepDeviceCopy`), so a discarded or refused edit cannot come back. A note
  writes on hide, on `pagehide` and as its mount goes, one encode (30-80 ms on a
  near-limit note), only if the document changed since it was seeded or last
  written (a document that did not start from a copy writes once even if nothing
  changed, as its room may have filled it first). Its row travels with its bytes in one response, so a write as the page
  goes lands whole: Chromium drops a `Cache.put` after an `await` in `pagehide`
  and keeps one issued in the event's own task (measured on reload, navigation
  and close), which is why the open store and its quota are kept ready
  (`prepareDeviceCopies`). The index learns of such a copy at the next store.
- **Joining from one.** The document is seeded before the room joins and takes
  the token's fresh client id as any new one does (the seed is no write of this
  session). The JOIN names the copy's stored version (`storedFrom`), and the room
  answers what lies past its state. A token naming another room drops the copy
  and starts empty (the lineage moved). A refusal (unassigned or a store's
  rejection, not-found, forbidden, a read channel closed for what it holds, or a
  late answer to a clean copy) drops the copy and remounts or rejoins with none,
  so it can never fail twice; a server crash that lost a co-editor's update ends
  this way.
- **The read without its body.** A note this account's store holds reads
  `GET /api/materials/{id}?noContent=true`: everything but its document, and the
  room is not asked for a fresh projection. So a reopen downloads the copy's
  difference and no body. The store's note ids are read when it is claimed, before
  any route loads (`holdsNoteCopy`); a read in another tab that does not know of a
  copy just reads the body. A body a read already holds stays. When the copy cannot
  paint after all (evicted, bytes that no longer read, a moved room, a refusal, a
  heavy note opened read-only), the mount waits for one full read
  (`forgetNoteCopy`). An export always reads the body (`materialWithBodyQuery`).
  Items read in full: their reads are small, and a viewer's copy is that read.

### Opening a note

Epo decided on 2026-11-04 that a note opens one way (`NoteBody`). It paints at
once, static and read-only: from the device copy when there is one, before its
material read answers and while that read cannot answer (the browser offline, the
server down, a timeout or rate limit; a refusal shows its panel), else the stored projection, else a
wordless skeleton (`NoteSkeleton`). Offline with nothing to paint it reads "Waiting
for connection" (C9).

- **Its token** is asked for as the note opens, beside its read rather than a
  round trip behind it (Q618, `MaterialContentBody`): everyone opening a note
  needs one but a heavy note opened read-only, which joins no room. It needs the
  kind known at the open, from the list or the copy's row; otherwise the frame asks
  once the read answers. It's one request: `materialTokenQuery`'s, which the
  editor reads, and which a viewer's first read channel takes from the cache (a
  viewer's token says read either way, `readToken` in `liveNoteRead.ts`). An
  editor's View holds a write token and asks for its own read channel. A read token
  nothing took goes when the note closes, so someone raised meanwhile doesn't start
  an editor from it. Someone refused gets that one extra refused request, which
  nothing shows or retries: the read decides the page (Q644), and opening it again
  once let in asks afresh.
- **A viewer** stays on the paint, which follows its room on a read channel
  (`LiveNote`, `readNoteLive`, Q158), from its copy when it has one. No cue says
  it is read-only (D9). A reopen loads no editor: a copy's row keeps its reader's
  last `canEditContent` (`copyLabel`), which decides until the read answers.
- **An editor** builds Plate behind the paint: `NoteEditor` mounts `invisible
  absolute inset-0` and `inert`, and asks for its discussions and drafts
  meanwhile. The mount doesn't wait for the discussions (Q680): their anchors land
  on their text when they answer, the caret left where it was. With the token at
  open (Q618) that took a note to editable about 0.8 to 1.3 s sooner under the
  mock on 2026-11-06 (production build with MSW, the paint unchanged); MSW adds
  about 1.1 s to each API call, so the real saving is unmeasured. Edits are held until there is an editor (C4, no spare client ids):
  keys are dropped and a phone shows no keyboard. Plate stays static until the
  first sync (C5): no early bind. Once `NoteEditorCore` painted (`onShown`) the
  paint goes and the editor shows in the same commit, at the block under the top
  edge (the paint's blocks by value order, `paintedPosition`) and with a caret
  placed in the paint moved onto it. Embeds in that paint hold their place
  (`HeldEmbed`): the editor's own join theirs, and a study view would flash.
- **So it is no slower than before** (near-limit and small notes,
  `bench/editor/reports/2026-11-04-open-paint.md`): one frame holds the paint
  before the read answers and for an editor, so it is never painted twice
  (`PaintedFrame`); the token and the editor's chunk start next to the paint, not
  behind one another (`materialTokenQuery`); the frame paints the first 100 blocks
  until the reader nears their end (`PAINT_BLOCKS`, a citation paints them all);
  the editor shows as it finishes, with no wait on a paint behind the note; and the
  paint's DOM goes when the page is idle, hidden meanwhile.
- **The status** beside the title is a spinner with no words while it opens
  (`opening`) and, with the draft's words, during a draft send (`syncing-draft`,
  D10, no strip). A slowed open says so in its tooltip.
- **At 30 s** a strip with Retry shows over whichever is on screen (`unreachable`,
  D5). A token that never answered or failed leaves the paint and a red status;
  a token that answered with a join that never did paints the editable saved copy
  (Q229), its base the copy's value where it started from one. A refused token
  (403, 404) shows the panel, as before.

### Opening an item

A quiz, a set or a diagram opens like a note (Epo 2026-11-04): painted at once from
its device copy or its read, as the editor lays it out and taking no input, its
status the same spinner, until its room synced. A quiz is its questions in one
column; at the sync the editor's page (the question list and the open question)
replaces them, opening at a link's question. A set is the editor's
turned tiles. A diagram is the split, source left and preview right, read-only.
An item room has no saved-copy path: it stays read-only until it joined, and at
its 30 s goes offline under its banner, still showing what it painted. Only a note,
or an open whose kind the list does not know, loads the static renderer ahead
(`loadPreview`, about 1.2 MB minified that no other kind draws).

**Hidden tabs** (D11). The server model is unchanged. A tab hidden for 5 minutes
with nothing unsent in any note or item room, and no Office or text room on its
socket, sleeps through `CollabSocket.sleep` (`watchIdle`'s `mayHide`), never
`disconnect()`: a clean Leave would expire the session's ids. It wakes when it
shows, and the room rejoins from its in-memory document with the previous token's
id, by its step 1. The status does not move; its 30 s start as the tab shows.
A tab holding unsent edits asks again every 30 s. A reader's rooms keep their own
5 minutes (`whileVisible`), rejoining from the copy they wrote as they left.

**Citations and deep links** work in the one mode: a chat citation scrolls and
flashes its passage in the paint, and again in the editor once it shows; a
question or card from a review summary scrolls into view in the quiz's list or
the set's grid. The header's Preview shows the whole note as its readers read it,
with embeds answerable and cards to study; the button turns into Edit, which goes back.
The editor stays mounted, joined and undoable behind it (its mounts hidden and `inert`).
`NotePreview` portals into a host under the editor's save strips, so the strips and their
actions stay reachable (Review leaves Preview first), and it reads none of the editor's
contexts. It draws `PaintedNote` from the editor's own value, so it reads no note body,
opens offline and shows text not yet saved; images use the links the editor already holds
(`resolvedAssetLinks.ts`). It
redraws at most every 250 ms from the editor's value changes (`subscribeNoteValue`), which
a collaborator's typing runs through too, and only changed blocks draw again. A room swap
hands it the next editor without moving the reader.

**Its code** (Epo 2026-11-20: pressing Preview loads the whole note first). Most of it is
there once the editor is: the static renderer comes with the editor's chunk, and
`loadEditor` (`NoteBody.tsx`) loads the question text editor beside it, which an embedded
quiz's long answers take in Preview (`QuestionRunner` loads it with the first long answer
anywhere else). Embedded quizzes and sets, a drawn sample's picture and the full-screen
views of images, figures and diagrams come with the editor too. The rest the note's blocks
need, what they draw with and what their buttons open, Preview loads as it opens and draws
once all of it has loaded or failed, or 30 s passed (`PREVIEW_CODE_LIMIT_MS`, Epo
2026-11-20). `codeOf` (`blockCode.ts`) walks the editor's value and each embedded quiz's
questions as Preview draws them: the synced content room the editor's seat holds of it
(`NoteSeat.contentRoom`, `ItemRoom.learnerQuestions`, read once an open), else the
embed's stored read (`qk.quiz`; a quiz not read yet adds nothing). It keeps a top-level
block's needs while the block is the same object, and a quiz's while its questions are the
same array:

| Kind | Code | For |
| --- | --- | --- |
| `graph` (a note's figure, a question's block) | the graph engine (`graphPaint`) | drawing it |
| a graph's `formula` | KaTeX | laying out its formulas |
| `html_embed` | `HtmlEmbedSourceDialog` | View source |
| a quiz part's `canvas` answer, a drawn canvas | the drawing board (`DrawingBoardScreen`, BlockSuite) | Answer in Canvas, Open canvas, Edit canvas |
| `equation`, `inline_equation`, a formula in a quiz's text, a quiz part's `open` answer | MathLive | drawing formulas; a long answer's Formula |

Each loads once (`BlockCode`), for its lazy component and the preload alike. Until they
settle (`Promise.allSettled`) the pane shows `PaneLoading` ("Loading preview") at once,
and nothing when all of it is here already: a load that settled earlier, or MathLive
registered by another import, counts at once. Each open waits afresh, a reopen before the
last one's DOM left included. Code a block added while Preview is open needs loads without
the loader. Edit from the loader goes back to where the editor was.

A load is asked for (`load`) by Preview's walk, a drawn graph and a pressed button (Answer
in Canvas, Open canvas, Edit canvas, a drawn sample's, View source); the
board's idle load ahead of a canvas part or a quiz editor's canvas (`useBoardAhead`) is a
preload (`preload`), whose failure marks nothing, so the part keeps its button and a press
asks again. What an asked load could not bring (offline, a
failed chunk) shows "This block cannot be shown" (`CannotShow`, the words of a note's
unknown block) in place of what needs it, read from how its load settled
(`useCodeFailed`), never from a thrown error (a lazy component whose load failed draws the
notice itself), and the rest of Preview stays: a graph shows it in its place; a canvas
part in place of Answer in Canvas or Open canvas, its canvas, its verdict and
an answer already made staying; a quiz editor's canvas in place of Edit canvas; a canvas
only looked at drops its Open canvas; a drawn sample's field in place of its button, closing an
open one, and the quiz editor's footer in place of Draw sample answer (the phone's ⋮ item
disabled); an HTML embed in its toolbar where View source was, the embed itself still
running. Those hold wherever the graph, the board or the source view show once their code
failed, Edit included, and the error toast says why, with Reload (once a chunk; a load
that failed offline shows "Some blocks couldn't load" with Reload once the connection is
back). The browser keeps a failed import for the document (Chromium 151
fails a second `import()` of the URL without a request), so a notice stays until a reload,
which is what the toast offers. Code still loading at 30 s is given up for that open
(`GivenUpCode`): what needs it shows the notice in Preview as for a failed load, even if it
arrives meanwhile, until Preview opens again and checks again.

MathLive and KaTeX are quiet: their users keep their own lines (a formula's TeX as text,
the formula field's could-not-load line, a graph without its formulas), a failure marks
nothing and is not kept, so `loadKatex` and a formula's `drawing` try again as they do. A
Mermaid diagram, which draws in its worker, says "Diagrams couldn't load." itself; Preview
waits for neither the worker nor an HTML embed's frame, which loads from its own site.

Its embeds join inside the editor's `NoteSeat`, whose `writer` makes a reader under it take
the editor's room of the embed rather than a read channel (the server closes the earlier of
a read and an edit channel to one document). So an embed the editor had open costs no token
or channel and answers offline from its held document; one never opened joins once, on the
key the editor then shares, and only its keys room is new at Edit. A try in Preview's embed
stays in memory and records nothing, as in any note's embed; nothing is written to the room.

While it's open `EditorPreviewing` makes `useEditorHeld` true: overlays go inert and the
command palette stays shut. The selection is cleared, which closes selection-driven toolbars
and removes this tab's caret for peers; a range ref carries it through other people's edits.
Media pauses and a YouTube player goes back to its poster.

Opening runs in a transition, with `aria-busy` on the button. Closing first settles the
place behind Preview (`settleNotePlace`, up to about 300 ms: blocks off screen have no size
until they come near), then shows the editor; Preview's DOM leaves when idle. Both directions
keep the same block at the same height, inside the block if it's shorter on this side. A tall
embed still loading in the editor can't land exactly until it has its height. When the note
can't be edited at all the button reads Close preview.

### The editable saved copy

Epo decided on 2026-10-24 (Q229) that a note shown from its saved copy
before its room joins stays editable. Its edits are not Yjs edits (the
editor is not bound), so they are kept apart, merged by block id when the
room joins (`src/features/notes/merge/`):

- **The copy row.** While the editor is unbound, each value change records
  the edited tree, written at most once a second and at once at `pagehide`,
  a pause, unmount or the bind (`recordCopy`), as one `copy` row of the
  draft store: JSON holding the tree the copy started from (`base`, the
  projection, with its `revision`), and the edited tree (`mine`). No Yjs
  reader takes a copy row (`yjsRow`: `draftGroups`, the sweep), the 7-day
  expiry applies to it from when it was written and is checked first,
  whichever tab holds it (Q412), the load sweep's lost-document delete takes
  it, and a read-only room or lost access discards it with the other unsaved
  edits. A copy keeps the offline bound drafts keep (Epo 2026-10-26, Q397):
  one grown more than 2 MiB over its base is not written further, the editor
  stops under the `offline-limit` strip, and the bind merges the copy as
  last written. An edit that inserts more than one character, which no
  keystroke does (a paste of text or of blocks, `insertsMany`), writes the
  typing before it first, so the bound drops only that edit (Q410, Q421). A
  write storage refuses is reported (`onUnstored`) until one lands or the
  copy stops: meanwhile closing or reloading the tab asks (Q568). The
  refused value is written again at the copy's next save moment (`pagehide`,
  unmount, a pause, the bind), unless newer typing replaced it, with no
  retry timer; what still-failing storage refuses at an in-app unmount is
  lost, as Q465 accepts (Q569).
  A paused editor
  (a room swap before its bind) writes its copy, stops recording and lets go
  of its lock, so the next mount adopts it (Q409). An unreadable copy
  row is dropped with the drafts-lost notice and reported
  (`draft_unrestorable`, `unreadable`). Copy rows record the room they were
  made in but merge into whichever room the note joins: the merge compares
  block trees against the copy's own base, not Yjs lineages.
- **Each tab owns its copy** (Q397). A tab holds the Web Lock
  `capy-copy:<session>` while it is mounted (`holdCopy`), and an opening
  editor leaves out every copy row a lock is held for (`heldCopies`,
  `noteCopies`): another open tab's copy is never adopted, merged or
  deleted, and merges when its own tab joins (or at the next open once that
  tab closed). A reopened note shows the newest copy no tab holds and goes
  on with that row (same id, a higher `seq`); older ones (closed tabs')
  merge first. Every copy a tab takes is locked as it is read, only if free
  (`lockCopies`, `takeCopy` with `ifAvailable`): the adopted one (Q410) and
  each older one it merges (Q421), so two tabs opening together never show
  or merge one row twice; a row another tab took meanwhile is left to it.
  The editor asks for its own lock before the adopted one's goes
  (`takeOverCopy`). Without Web Locks, or when they fail, no copy is adopted
  and each merges as an older one, another open tab's too: that tab's later
  typing then shows as conflict pieces at its own bind (Q410).
- **A late mount** (Q406, Q408) shows the projection, never the adopted
  copy, records no copy edits, and merges the copies only once its late
  merge applied (`boundWaiting`). After a failed merge, or when the mount
  goes stale, pauses, is rejected or unmounts while its merged document is
  being stored, it never merges them and their rows stay for the next mount
  (Q451).
- **Undo before the bind** (Q397). The Yjs history works on the bound
  document only, so until the bind Undo and Redo walk Slate's own history of
  the copy (`roomBindingPlugin`).
- **The merge** (`mergeBlocks`, pure). At the bind (`whenBound` in
  `roomBinding.ts`) the editor compares, by top-level block id, the copy's
  base, its edited tree and the room's tree; a block counts with everything
  nested in it, and blocks compare without the ids of elements inside them
  (`sameBlock`, Q397: the room holds table rows and cells, columns, toggles
  and Mermaid captions without ids that normalization gives the copy). A
  block without an id is left as the room has it. The diff and its steps
  run in the bind's own task on the main thread (`mergeAtBind`, Q408): the
  steps are ordinary Slate edits of the bound editor, one local transaction
  and one Undo step under the session's id (`asOneStep`), so they sync as
  any edit and save through the normal checkpoint (Q410; the bind schedules
  it too when a step applied, since a bind before the mount's first paint,
  a swap's hidden build, reports no value change). Nothing (typing, a merge
  view choice) can run between the room's tree and the merged one, and the
  caret, placed by block id after the merge, lands in the merged text. A
  block only the copy changed (edited,
  inserted, deleted, moved) is applied: of the same type the block keeps its
  element and only the changed run of each text is rewritten when the
  children keep their shape (`replaceBlock`, Q397), so comment anchors and
  peers' carets in it hold; otherwise its children, or the block of another
  type at its index keeping its id, are replaced. Inserts and moves go after
  the previous block of the copy the room still holds, else at the start. A
  block only the room changed, or neither, stays as the room has it; one
  both moved keeps the room's place. A block both changed differently is a
  conflict: the room's version stays, and the copy's version becomes a piece
  of the merge view (`conflict`, carrying its base; one the copy deleted is
  a piece with no version of the user's). The pieces are stored before the
  copies' rows are deleted (`deleteOnceStored`, Q397): a failed write keeps
  the copies for the next open and shows the drafts-lost notice. A copy past
  the 7-day expiry is never merged: each block it changed becomes a piece
  (`expired`), at the next open's read or, for a copy whose last edit
  passed the expiry while its tab stayed unbound, the tab's own included,
  at the bind (`editedAt`, Q421). Within a tab the first applied wins; two tabs whose binds
  race over the network can both apply, and Yjs keeps both texts (accepted,
  as the merge view's plan does). A merge that throws is reported to Sentry
  (`note-copy-merge`) and the rows stay for the next open, with the last
  second of typing (`stop` writes what is pending); a toast says the
  offline edits are kept and will be added when the note reopens (Q433).
- **Cost** (measured 2026-10-26 and 2026-10-27 on the developer PC, Chromium
  at CPU x4, Vite dev build, the 2.0 MB load-test note of 3,652 blocks,
  bound headless with no render). The diff takes 41-56 ms on the main
  thread; a worker's message clone cost the same, so the merge has none
  (Q408). 154 steps (125 edited blocks, 30 inserts): the apply 299-375 ms
  with only changed text rewritten (654-992 ms when children were replaced
  whole). 1,116 steps (817 edited, 300 inserts): 3.1-3.4 s (9.2-11.4 s
  before). A whole-note replace (select all, paste a different near-limit
  note; 7,303 steps: 3,651 removes, 3,652 inserts): 68.8 s median of three
  (65.3-74.0 s), the diff 0.18-0.64 s of it, nearly all the rest Slate's
  per-operation apply and the Yjs flush. There is no time or step cap
  (Q411); the replace is on the perf track. A typical session (under 50
  blocks) stays well under 100 ms.

### The merge view

Epo decided on 2026-10-24 (Q251, Q252, Q253-Q265 as recommended, Q261
amended) that a note's edits that could not sync open the live note with a
merge view instead of copy-only recovery (`src/features/notes/merge/`).
Items, Office and text files keep copy-only recovery.

- **Pieces** (`types.ts`). Each is one top-level block of the user's
  version (`mine`, null when the user deleted it), the block before it there
  (`after`, where a restore goes), its source (`refused`, `changed`,
  `expired`, `conflict`, `hidden`) and, for a Q229 conflict, the base. A piece holds no
  Yjs ids, so id expiry, collection and lineage moves never invalidate it;
  the room's version is read live by block id. Its status is derived, never
  stored (`pieceStatus`): `conflict`, `theirs-deleted`, `mine-deleted` or
  `resolved` (the current block equals `mine`, both deleted, or the copy it
  inserted is in the note).
- **Stored** as `piece` rows of the draft store (`pieceRows.ts`): JSON kept as
  bytes, one row per block and content per document
  (`piece:<key>:<block>:<hash of mine>`, Q409): a block may have several
  pieces, a piece never replaces a different one of its block, and one equal
  to a listed piece of its block (`sameBlock`) is not added, so a repeat
  conversion never duplicates; a different piece whose hash matches takes
  the key with `:2` after it. A rewrite (Insert's mark) keeps the row's id
  with a new `seq` from the time and a per-tab counter, unique across tabs,
  so another tab's exact delete never removes it (Q410). Rows are never sent
  by the sweep (`yjsRow`), kept through sign-out, deleted with the
  document's rows when the account loses it. Pieces never expire (Q254).
- **What becomes pieces.** At the room's first sync and after its paint
  (`convertSources`), each refused, other-lineage, expired or undelivered
  (Q360) Yjs group read at open (`useNoteDrafts` in `noteDrafts.ts`) is drawn
  and compared with the synced room (`piecesFromDrafts`): a top-level block
  is the user's to review when the user's document shows something the
  room's does not, past the room's state vector (typing, inserted elements,
  attributes), or deletes something the room still shows (`changedBlocks`);
  of those, blocks whose version equals the current one are left out, so a
  move alone makes none. Rows the service held as hidden typing (marked
  `hidden`, below) are a group of their own and a `hidden` source; refused
  rows beside them keep their own reason (Q421). The pieces are written,
  then the group's rows deleted (the drafts worker keeps the order; a repeat
  converts to no new rows). An expired saved copy becomes a piece per block it changed
  (`piecesFromCopy`), and a copy's conflicting blocks at the bind become
  pieces at once. A conversion that throws is reported to Sentry
  (`merge-view`) and its rows stay for the next open.
- **The strip and the sheet** (Q252). While unresolved pieces exist the save
  banner shows `review` ("Some of your edits couldn't sync into this note."),
  with Review and Discard in the close button's place; it cannot be closed
  and comes last (outdated, offline, delayed, review): while the offline
  strip shows, Review is out of reach, so Copy and Discard work offline only
  in a sheet opened before. Discard drops every piece after a
  confirmation. Review opens `NoteMergeView` (lazy-loaded),
  non-modal over the note: the bottom 60% on phones, a 400 px right sheet
  from md (below the strip, so its actions stay in reach), never docked,
  since re-flowing a large note costs seconds. Rows list the pieces in
  document order: a status chip, the source and a text excerpt; expanded,
  "Yours" and "Current" as static renders. A row's header scrolls the note
  to its block (else the block before it) and marks it for 1.5 s with a DOM
  attribute (no Slate render); a phone's sheet closes for it, and Review
  reopens it on the same piece. Esc and the close button close the sheet.
- **Choices** (`applyPiece.ts`, Q253): a conflict offers Apply mine, Keep
  current, Insert as new block and Copy; a block someone deleted Restore
  mine, Discard and Copy; a block the user deleted Delete current and Keep
  current. Apply, Insert, Restore and Delete are ordinary edits of the bound
  note, one local Yjs transaction and one Undo step each under the session's
  id (`asOneStep`): Apply keeps a same-type block's element; Insert and
  Restore put a copy under a new top-level id (nested ids clashing with the
  note's are renewed by `stableElementIds`) after the current block, else
  after `after`, else at the end. They need the live, synced, bound note,
  never paused, refused, locked, held or offline (Q255: "Reconnect to
  apply"); Keep, Discard and Copy always work. Copy writes the block as text
  and as its static render's HTML.
- **Kept current** (`mergeStore.ts`). Each change of the note (local or
  remote) re-reads the pieces' blocks a frame later, O(pieces): the cached
  index first, and a block object seen before (Slate nodes are immutable)
  costs no comparison. An applied piece stays listed as Applied until the
  sheet closes or the mount ends, so Undo makes it a conflict again (Q256);
  then resolved rows are deleted. A choice compares the block it was shown
  with the note's: one changed since applies nothing and the row says "This
  block just changed. Review it again." (first applied wins, no lock; two
  Applies within milliseconds both land, accepted).
- **Hidden typing** (`hiddenTyping.ts`, Q237, Q258). Typing the room never
  saw that lands in a block someone deleted meanwhile never shows: the
  room's deletion takes it too. After a JOIN the server sends its step 1
  (its state vector) before its step 2, and `RoomProvider` hands that vector
  over (`onStep1`) before it replies, so whatever the tab holds past it is
  what the room never saw. Only a join's step 1 arms the watch: one once
  synced (the room's answer to an update it could not place) does not
  (Q409). With nothing past it the watch stays idle; otherwise, until the
  sync, each room transaction first marks the typed
  content past the vector (text, embeds, inserted elements; not attributes
  or formats, Q259) shown inside a top-level block the room already holds
  and draws that block once, and afterwards (Yjs emits it before collecting
  deleted content) a marked item the transaction deleted makes its drawn
  block a `hidden` piece. Rows that were pending until the sync (restored
  without a state row) and integrate into a deleted block keep only their
  text: a `plain` piece per parent, a paragraph that can be inserted or
  copied, never applied over the block; only clients this mount's stored
  update rows carry count (Q410), so a peer's text typed and deleted within
  one update the room forwards is none. This covers restored rows at mount,
  an offline episode, a socket blip and typing between the two steps; a new
  block can
  never be hidden, and text the room had seen and then deleted is never a
  piece. Yjs drops a deleted block's contents with it, so a draft send
  typing next to any of its letters names collected history and its group
  is answered `late` (409; Developer Epo, 2026-10-27, Q444 over Q237's
  direct `hidden` answer, Q443): the tab's late merge ([the late
  path](#the-late-path)) lists that block in `hidden`, kept as one refused
  row flagged hidden that the next open shows as `hidden` pieces, so the
  typing is never lost. A connected tab's live typing there is admitted as
  plain Yjs admits it and goes with the block, with no late answer and no
  merge view (Q446, reversing Q444's live part). Typing that names only the deleted block itself (a
  block that was empty) is not late: a draft send cannot see it (it holds
  no room state), so the service refuses a note's draft whose typing would
  land in a deleted holder (`ydoc::inspect`'s `hidden_units`) as `hidden`
  (409); the send (a sweep's or the editor's own) holds the group for the
  editor's next open and marks its rows `held` and `hidden` in one write:
  applied there, the join finds the typing; drawn on its own, the group
  becomes `hidden` pieces (Q410). Over a socket such typing is admitted and
  the watch above draws it. Hidden typing is never an incident (Q261).
- **Lifecycle.** The live mount's store is the sheet's, and a paused one's
  while it is on screen, its choices off; a standby mount registers none, and
  the sheet's open state lives in `NoteEditor`, so it survives a room swap.
  Before the first sync stored pieces show with their choices off and groups
  wait. Each tab re-diffs from the room on its own; a dismissal shows in
  another tab at its next open (Q264). Q261: only an unexpected failure is an
  incident, a choice that throws (`merge_view`, the piece's source as the
  reason); pieces entering the view are none.

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
page load; a later sweep that meets one leaves it for the next load. A 410
`item_deleted` keeps them, and the load sweep offers each such item once it
ends (`onDeleted`, its quiz keys with it), unless a page here shows it: one
error toast, "Edits to “{title}” can't sync" / "It was deleted.", with
Discard (plain, ringed), Download (filled) and × (Epo 2026-11-20, Q40 A,
Q44 1; `offerDeletedEdits` in `deletedEditsToast.ts`, apart from `lostEdits.ts` so the rooms that import the latter never reach the file writers, which the board's typecheck would then take in, with @types/hast newer than vendored BlockSuite's pin. The rule: nothing the drawing board reaches imports `deletedEditsFile.ts` or `deletedEditsToast.ts`, statically or dynamically, as tsc follows both. The recovery strip's Download, which a board's embedded quizzes and sets show, is `downloadRecovery` in `recoveryDownload.ts`, whose writer the app's entry `main.tsx` hands in; with none handed in, it fails with the download-failed toast). Rows that make no file (no group draws, or an
Office file's base is gone; `canSaveDeletedEdits`, checked before the toast
shows) get Discard and × alone, the body "It was deleted, and these edits
can't be downloaded." (review 2026-11-20). Download saves the file made from the rows alone
(`deletedEditsFile.ts`, loaded with the toast; no server call) and then deletes
them uncounted; Discard deletes them, counted; × keeps them for the next page
load's toast. The file is "{title} (unsaved edits).{ext}", a file keeping its
own extension: an Office file through the export worker over the base
stored with the rows (no seed: the rows hold the whole state), a text file's
source, a note as Markdown with images, audio, embedded quizzes and sets and
interactive blocks as lines saying they are not included (Q42 A), a canvas
as the PNG Download as image draws, on a read-only board mounted off screen
on the rebuilt document (Q43 A), a quiz's questions with its keys as JSON, a
set as .tsv, a diagram as .mmd. A file that cannot be made keeps the rows and
says so. A read
token sends nothing. A quiz's keys
(stored as `<actor>:material:<id>:keys`) follow the quiz's own token, then
go with the keys token (`{ document: 'keys' }`, room `keys:<id>:schema:<n>`);
flashcard sets and a quiz's content go as notes do. With a write token the
sweep takes the rows of the token's room that are neither refused nor
`held` (left for the editor, below), one group per lineage (an Office file's rows of another base
apart). The drafts worker merges each group and cuts it into its pieces of
at most 2 MiB (`merged`: the page's main thread pays about 4 ms for a 20 MB
Office state, against 160-192 ms with a 132-158 ms task when it merged
there), and the page POSTs each piece in order, paced under the tab's update
allowance (see [Connection lifetime](#connection-lifetime-and-refusals)), to
the collaboration service's `/drafts` on the host of the token's URL, the
same URL for every document (so one preflight, kept 2 h, covers a sweep):
`Authorization: Bearer <token>`, `X-Capy-Room: <room>`, `X-Capy-Base: <sha>`
for a source, `X-Capy-Protocol: <client protocol>`, the piece as the body
(`collaboration-rs/crates/server/src/drafts.rs`). A piece over the service's
8 MiB cap (a struct that cannot be cut) is not sent: the group is left for
the editor (`held`). A group of more than one piece names it on each
request (`X-Capy-Group: <id>,<index>,<count>`): the room holds the pieces
by user and id (`Room::draft_piece`) and admits the whole after the last,
or none of it (review of 43fae032a, finding 2: a third piece refused had
left the first two with peers and in the store). The id is the group's
rows' (32 hex characters of the SHA-256 of each row's key, id and seq,
`groupId`), the same at every send and in every tab, so a send of the same
rows takes the place of the group the room holds instead of holding a
second one beside it, and two tabs sending them share one (round 2,
finding 1). A piece before the last answers `piece-held` once held, which
holds nothing for good; the last answers as a single send does. The room
holds a draft group under the bounds of a channel's (its count, its group
cap, the user's one unfinished group, its deadline), stays loaded while it
holds one, and charges each piece to the allowance as it comes, except one
the room holds in full, which it neither charges nor keeps (Q321). A piece
taking the room's unfinished groups past twice its group cap drops the
group and answers `busy`, uncharged and with no timeout (round 3, finding
6). A first piece while another group of the user's is unfinished, a
channel's or a draft send's, answers `busy` (409) with no timeout, and the
sweep (or the opening editor's send) tries the group again
`BUSY_RETRY_MS` (10 s) later, silently (Epo 2026-11-23). A count past
`max_pieces` answers `malformed`, its message naming the count and the
bytes that came. A piece the
room holds already (the same count, an index
below the next it expects, a first piece included) answers `piece-held`
again, its deadline renewed and nothing charged; a first piece of another
count, or of a group the room does not hold, begins the group again. A
piece the room does not expect otherwise (its group dropped at its
deadline, refused or never begun, or another tab's send of the same rows
further along) is refused `unavailable`, and the group the room holds stays
as it is (round 4, finding 6: a stray index dropped the group another send
was building). A piece the
service does not take stops the send, and every row of the group stays,
the answer below applying to all of them; after `too_fast` or no answer
the next trigger goes on from that piece under the same id (round 2,
finding 4: sending the whole again cost the group's allowance again). A
refusal or the deadline drops the group in the room, so a resumed piece
answered `unavailable` starts the send over from the first piece at once,
in the same send (round 3, finding 3).

The service counts the send against the user's draft sends once its token
checks out, at most 60 in any minute apart from the update allowance (Epo
2026-10-25, Q360; `take_draft` in `rate.rs`; over it answers `too_fast`
before any lookup, with no timeout). It runs a channel's JOIN checks
(origin, token, access, the room's eviction and pause state), refuses a
read-only token, checks the note's current schema, refuses the send while
the user is in a timeout (checked right after the token, before any
lookup), reads the body within 8 MiB (a larger one answers `too_large`,
which the page leaves to the editor, and times the user out) and a note's
4 MiB sync cap, checks a source room's eviction lease and a local reset
again (the body may have arrived after them), and hands the update to the room, loading it
if need be. There a group the room holds in full is a no-op (see duplicate
draft sends); any other takes from the user's update allowance (the one
their sockets take from) and goes through the same writer admission and
apply as a channel's update (`admit_update` in `room.rs`, a read token's
draft as a read channel's), so open editors receive it live, then a store
at once. A source send counts as joining its room meanwhile. It answers
only after the store that holds the update, and that answer is the receipt
for every row the request carried: only then are the rows deleted. A source room takes no send during a
publication handoff, and an Office file's only over the room's base. A room
whose load failed answers the failure (one load per send). A successful send
is silent: the edits just appear for everyone.

A refusal answers its class alone (`{"class": ...}`, a timeout's with
`remainingMs`); the service logs the detail with the room and counts it by
class
(`capy_collaboration_draft_refusals_total`). Nothing is retried in a loop:

- `limit` (422, over a content limit or a source's state cap) and
  `malformed` (400, not an update a writer may send): the group is marked
  `refused` and opens at the next open as the editor's own refusals do
  (pieces for a note, copy-only otherwise), when it draws on its own (the
  worker's `draws`); otherwise it
  is marked `held`, left for the editor's next open, where the room
  refuses it again and the editor keeps the whole document as its refused
  row; neither is sent again, so the room records the over-limit incident
  once per open, not per page load;
- `unheld` (409, the room lacks the update's base), `unassigned` (409,
  structs under a client id not assigned to the user, Epo 2026-10-24),
  `hidden` (409, a note's typing that names only a block the room deleted
  since, which the room would never show; only the editor's join finds it;
  typing next to the block's letters is `late` instead, see [hidden
  typing](#the-merge-view), Q237, Q444), `too_large` (413) and `lineage` (409, a
  token for another room, a schema
  or epoch that moved on, another Office base): marked `held`, left for the
  editor's next open, which applies a held group of an accepted session and
  shows any other as pieces or copy-only (see opening with stored drafts,
  Q360);
- `late` (409, the rows grew from a state older than the room's collection
  window, or under a session whose record was lost): marked `late`, which no
  sweep sends; the editor's next open merges them
  ([The late path](#the-late-path));
- `outdated` (426, the page's client protocol is refused): kept unmarked,
  and no sweep runs again until the page reloads (see
  [Client protocol](#client-protocol-and-the-release-nudge));
- `permission` (403), `unavailable` (503) and any other answer: kept, and
  not sent again until the next page load;
- `busy` (409, another group of pieces of the user's is unfinished, Epo
  2026-11-23, or the room holds too many unfinished groups): kept, and sent
  again 10 s later; the document's later groups wait for that retry too,
  as each would be busy (`sendGroups`; round 6, finding 1);
- `too_fast` (429, the user is in a timeout or sent 60 drafts in the last
  minute), no answer (offline, or none within the request's 30 s) or rows
  that changed meanwhile: kept for the next trigger.

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
- an item that names as its parent an item holding no type: yrs fails to
  integrate it (`InvalidParent`; Yjs collects it) after the structs before it
  went into the room's document. Under an item of the same update it is
  refused by `ydoc::inspect` itself (it had been taken as a small edit and
  left the room holding part of an update its writer was told was refused);
  under one the room holds, the update is no small edit, and its trial fails
  on the copy. Under a unit the room holds deleted or collected, yrs collects
  the item, and the room stores its own document's delta, which holds it
  collected, so the stored rows still replay in one transaction (a board,
  which stores its writers' bytes, refuses an item under a value deleted
  since its base on its own: `Board::parent_type`,
  [the canvas's room](#the-boards-tools)). An admitted update whose live apply
  still fails is reported to Sentry (stage `live_apply`, with the material and
  its kind), since part of it may be in the room's document, which the room
  keeps: discarding it would drop the other editors' unsaved changes;
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

A broken rule is first repaired cheaply on entry, else refused on entry,
else handled at save: a canonical repair, otherwise the room reset (Epo
2026-10-18 and 2026-10-19). An update room admission refuses (a limit, a key
or structure rule, an update outside the document's shape) answers its writer
alone with a `document-rejected` stateless message (a limit's code and metrics,
else `invalid_document`, no eviction id), then closes that channel only: the
socket stays, the client swaps to a new editor on a fresh Y.Doc and a new
channel ([room swap](#room-swap); its old Y.Doc holds the refused structs, so
no later edit of it could be placed) and keeps its unsaved edits as a refused
draft, and co-editors and the room are untouched. Right after an admitted update goes in, the room
repairs what a canonical form fixes cheaply, in one server transaction every
editor gets in the same flush (`Model::repair_on_entry`,
`notes::repair::on_entry`, `items::flashcards::repair`): an element's `text`
and `suggestion` keys are removed, a note left with no block gets an empty
paragraph with an id of its own (two writers each deleting one of the last
two blocks leave it so; an agent edit removing the last block gets it in its
own transaction instead, Epo 2026-10-21, so no editor sees the note empty,
and an agent Undo or Redo emptying the note gets it right after its revert,
Epo 2026-10-22),
and a set left with no card, after an update that
deletes, a blank card under a fresh id (a card id is a global key). A key
held at null is absent to the store as to the catalog and admission (Rust
`material.rs` and Go `document.go`), so a key set to null and a retype that
later forbids it leave a document both take. When the store's check still
refuses the document, the store repairs once (`Model::repair`: the same
emptied note or set, and a fresh `<id>-2` for each top-level block repeating
an earlier one's id, which no entry check sees cheaply), broadcasts it and
checks again; the row it stores holds the repair. `tests/admission_parity.rs`
(notes, from the seeded rooms and from a dirty seed holding every key the
store tolerates) and `items/tests/flashcards_parity.rs` (sets, single writes
and pairs) hold that no admitted update leaves a document the store refuses
once these repairs ran. If an over-limit
document reaches the store hook anyway, which with every update checked takes a
sum no single check saw whole (two updates checked against the same room before
either applied, the later one measured exactly without the earlier), the server
broadcasts `document-rejected` to the room and evicts it; leaving the room
loaded would mean it never persists again. A structurally invalid snapshot no
repair fixes is discarded the same way (`document-rejected` with code
`invalid_document`), and an `authorization-revoked` eviction (a discard: deletion,
trash, a move, an account lock) makes every editor drop its copy too; an access
change sends none, it closes only those who lost access, with 4403 and no notice
([authorization](../authorization-permissions-lifecycles.md)). `NoteEditor` responds to a `document-rejected` (its writer's
or the room's) by swapping in a new `NoteEditorCore` under a new generation key
([room swap](#room-swap)), which reconnects onto the room's state (after a
discard, the last durable state). Unsaved edits are kept as one refused draft
first, so what the swap brings in offers them as the merge view's pieces
(Q251); a limit also shows the too-large toast, and only
edits this device could not store end in the changes-undone toast.
Invalidating the collaboration token alone is not enough, because an unchanged
room string leaves the editor mounted on its forked document.
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
so comment anchors stay valid. A co-editor still connected
during such a discard, with a few seconds of unsaved typing, lands in recovery
too (Epo, 2026-10-04).

### Room swap

Developer Epo decided on 2026-10-22 that a room reload swaps renderers
instead of remounting in place: a discard that moves the room to a new
`room_schema` (the token names another room), a `document-rejected`
(a new generation), and Reload from recovery. `NoteEditor` keys each renderer
by room and generation (`useRoomSwap`, `roomSwap.ts`) and gives each
`NoteEditorCore` a phase:

- **Paused**: the one on screen once the note wants another room or
  generation. It stops edits without Slate's readOnly, since readOnly
  re-rendered every block and dropped the reader to the top: its model takes
  only selection changes (`holdModel` wraps `editor.apply` and `tf.apply`,
  so a portalled block menu, a column or figure resize, or an IME
  composition the pause ends changes nothing), and `pauseEdits` turns the
  editable root `contenteditable=false` and stops typing, paste, drops,
  drags, right clicks and clicks on controls in the capture phase. Its
  toolbar is inert, the palette and ghost text unmount, it leaves its room
  (no reconnect), writes its unsaved edits as one whole document (its child
  effect runs before `useNoteDrafts` reads the next room's drafts, so another
  lineage's edits still become pieces) and reports nothing
  more: no status, presence, banners or refusals. Reading, scrolling,
  selecting, copying and links still work.
- **Standby**: the next editor once the next room's stored edits are read.
  It mounts `invisible absolute inset-0` and `inert` beside the paused one,
  so its layout is real, connects and syncs, and its header status reads
  Reconnecting (with a slowed open's line); `NoteEditor` reports Reconnecting
  itself until then.
- **Live**: after the standby renderer's first paint (`onPainted`, two
  animation frames after its content rendered, an error state included) its
  slot loses the hidden classes (the DOM is never moved), the paused one
  unmounts, and the reader's place comes back by block id
  (`captureNotePosition`/`restoreNotePosition`): first the selection by
  top-level block id plus path and offset, with the focus when the editor
  held it as it paused (`noteFocusAtPause`, read before the pause makes the
  root non-editable and blurs it) and the reader has not focused something
  else since, then the first top-level block under the scroll box's top
  edge at the same offset (else the old scroll offset), last, so the
  reading place wins over the caret. Yjs ids are never used: the next room's
  document need not hold them.

A hidden tab swaps at once (no paused phase; a tab that hides meanwhile
swaps then). A phone (below sm) holds one renderer: the paused view is
copied as plain DOM (`copyPausedView`: nothing editable, no frames, Slate and
block-id markers removed, its toolbar inert, scroll kept) over the editor
remounting in place, which stays in standby under the copy until its first
paint. The copy does not carry canvas bitmaps or shadow roots: charts and
plots drawn to a canvas and math fields show blank in it until the swap. The
path (beside, a phone's copy, or at once) is decided once per swap, when the
next mount is ready, so a breakpoint crossing during the build keeps it. The banners of the paused editor's room (offline, delayed) go with it.
All renderers share one react-dnd `DndProvider` in `NoteEditor`: two
providers, each with an HTML5 backend, throw. `room-swap.spec.ts` covers a
discard (`discardMockMaterialRoom`: the room moves on and its editors' channels
close), a hidden tab, a phone and a refused update.

### The late path

The in-place Yjs collection (Developer Epo, 2026-10-23,
[storage quota](../../human/backend-storage-quota.md)) discards tombstones no
session inside its window can name. A session older than the window may name
one, so its edits never sync raw: they are merged in the tab, by the Rust merge
compiled to WASM, into one ordinary update the room admits like any edit.

- **Detection** is the room's (`Room::late`, `crates/server/src/room.rs`), in
  note rooms only: a stored version below the latest collection's window, or
  an id whose session record was lost (Q385, [editing
  sessions](#editing-sessions)), whatever version it names. A late JOIN is
  refused with `collaboration-late` (`socket::LATE_REASON`) after the client-id
  binding and before the member joins, so it makes no session and a lost
  record's marker survives the next store (P1 review r3 N9); viewers too, as a
  viewer's token can turn writable before its eviction lands. Any update
  that names a unit the room holds collected (`ydoc::gc::named_collected`,
  at admission, before the validator; a note's content room only, Q445:
  item, diagram and mindmap rooms admit it and Yjs drops it) is answered
  late (Q443), told apart by the delete set of the latest collection's
  window (loaded with the document, then each collecting fold's), which
  holds every unit a collection discarded. A unit inside it is collected
  history: a live update naming one gets `collaboration-late` on its
  channel, so the tab goes late as for a JOIN; a `/drafts` group the class
  `late` (409, counted); an agent Undo `undo_unavailable` and an agent edit
  `unavailable_target`. A collected unit outside it was dropped by yrs
  under a block deleted since (typing into a block someone deleted names
  its contents, which Yjs drops with it): a connected tab's update is
  admitted as plain Yjs admits it and goes with the block (Q446); a
  `/drafts` group is still `late`, and the merge turns it into `hidden`
  pieces (Q444, [hidden typing](#the-merge-view)); an agent edit is refused
  `stale_target` so the agent re-reads, its Undo `undo_unavailable`, as is
  an agent edit the validator finds typing into a deleted empty block. In
  practice the late answer reaches a tab only for edits it made offline and
  sends on reconnect (gc_views seed 8462), or an Undo of a deletion another
  tab made first. A group naming nothing collected is admitted as an
  ordinary draft, late or not (Q436). Until a collection records its window only lost ids are late.
  An older build reads `collaboration-late` as a retryable refusal and would
  rejoin with backoff forever, so the release that turns lateness on ships
  with client protocol 22: its raised `MIN_MATERIAL` (22) refuses the older
  build as outdated first, and it reloads.
- **The tab** (`roomRefusal` gives `late`, and a draft send answered `late`,
  Q406): the editor leaves its room, keeps
  its document as one stored row flagged `late` (`recordDrafts().late()`) and
  hands the document to a new mount through the room swap. The new editor (a
  new Y.Doc, so a new client id and an empty Undo) joins with nothing
  restored, as a new session at version 0 (`joinedFrom`: the rows' version
  would be answered late again), with the header reading Getting ready
  (`preparing`, standby too) and its toolbar inert, and once synced merges:
  the handed document and every stored draft found for the note, a
  never-accepted session's pending steps included, are the old document
  (Developer Epo, 2026-10-27, Q406, [error
  handling](../../human/frontend/error-handling.md)), except rows another
  open tab records: each recording session holds its own Web Lock
  (`capy-draft-session:<session>`, exclusive, from its first row until it
  stops recording, online too), the note's draft read lists the held ones
  (`heldDraftSessions`), and the late mount leaves their rows alone, never
  merging or deleting them (Q420). A browser without Web Locks holds none,
  so its late merge may take another open tab's rows (Q420). The synced one is the
  current, and `mergeLate` (`src/features/collaboration/lateMerge`) runs the
  merge in a worker that is gone afterwards (and stopped when the editor
  goes). Meanwhile no draft is applied raw or sent: a late mount runs no
  draft send, so no Q360 hold. Before any merge code the rows it took go
  once as ordinary drafts (Q436): the note opens afresh, with no merge, only
  when every one of them went in a group the room admitted (a held or
  refused row the send skips keeps the merge, Q451), and a room sync while
  that try waits (a reconnect) waits for its answer instead of starting the
  merge (Q451). The tab's own copy shows read-only: the paused
  note beside the late mount (the swap waits for the merged editor, which
  paints once and takes the caret and focus back), or, where nothing paused
  shows it (an opening editor, a hidden tab), the late mount's static copy
  (`data-testid="late-copy"`). Neither the worker nor the WASM is
  in the main bundle; they load only here, and not at all when the old
  document holds nothing the current one lacks (no unit past its clocks, no
  deletion it has not made). The download has no time limit (Developer Epo,
  2026-10-24, Q295): the own copy stays until the code loaded. A download that
  failed (the worker or its WASM did not load: `LateMergeUnloaded`) swaps the
  late mount in with its static copy, everything kept, and a strip "Couldn't
  sync your edits. Retry or reload the page." offering Retry; the browser's
  `online` event tries again too (Q398), and so does a room sync. The strip
  is the note's save strip, one at a time: outdated, offline, then this one,
  then delayed (Q252 as amended by Q420; the merge view's review strip comes
  last). Code that
  does not load while the browser is online goes to Sentry once a page
  (`late-merge`, stage `load`): a cause no retry fixes (a CSP block) shows
  there. Once the code loaded, the current document is read (`mergeBase`) and
  the session marks an unsent edit at the version it holds then
  (`RoomProvider.unsentFrom`; required, Q406: without a room provider to mark,
  the merge fails), so its acknowledgements stay there until a store holds
  the merged update and no collection passes the units it names (late merge
  review r2 S6). A result that arrives after another send took the mark and a
  store cleared it (the session reports past the base) is dropped and the
  merge runs again (review r3 L1), and the mark is taken again at the base
  just before the result applies, for a send that took it but whose record
  the next store has not cleared yet (Q420, review r4 L1). The update is
  applied as this session's
  edit (sent and stored); the merged document is then written whole (not
  when nothing needed merging) and the
  rows it stands for go once that landed (else at the receipt), so a reload
  never merges them again; then the note paints and swaps in. What
  the merge would hide, because someone deleted the block around it (Developer
  Epo, 2026-10-24, Q237, [error handling](../../human/frontend/error-handling.md)),
  is kept as one refused row holding those top-level blocks of the old
  document whole (text, inline elements, images, embeds), each once and in
  its order, and the editor remounts into the copy-only recovery with it after
  the merge applies (the merge view takes this over once it exists). That row
  is written before the adopted rows go; when it cannot be stored, they stay,
  the note does not open live, and the storage failure is shown. Until the
  merge applies the editor is not shown (the own copy is, and the swap shows
  it as soon as it painted), its toolbar is inert and it asks for no receipt,
  so a reload during the merge still finds the stored rows, and they never
  reach the room raw. Once it applied, the session is late like
  any other: a later `late` answer keeps its document (the edits since
  included) as one late row for the next mount to merge.
- **Failure is explicit**: a failed merge, one that has not answered 10 s
  after its WASM loaded (`LATE_MERGE_DEADLINE_MS`, Developer Epo, 2026-10-24,
  Q281, [error handling](../../human/frontend/error-handling.md); the worker
  posts `ready` once loaded, so a slow download is not merge time; the worker
  is stopped),
  or a late answer to the new session before its merge applied keeps the old
  document as one refused row, shown read-only for copying after the remount
  (the `refused` banner), and goes to Sentry (`late-merge`). The old document
  holds every draft the merge took, so every stored draft stays, in that row
  (Q406); no edit is dropped. A mount already set aside (paused,
  outdated) leaves the rows to the next one. A room eviction while the merge
  waits (`document-rejected`, `authorization-revoked`) touches no draft row,
  writing nothing and deleting nothing: none of them is in the late mount's
  document yet, and the reopened note takes the late path again (Q420). The
  room turning read-only then (a frozen account, storage full) likewise keeps
  every row instead of discarding unsaved edits: the note drops to View, and
  the next open that can write merges them (Q426). A
  row rewritten from others (the late row, a refused or hidden row) keeps the
  newest date of the rows it replaces (this session's last edit, the adopted
  rows'), so the 7-day expiry runs from the edits, not the rewrite (Q420); an
  expired late row opens once as the expired copy instead of merging (Q413).
  A re-authored late row (a merged update refused `unassigned`) keeps the
  newest date of the rows the mount took when it started, and what the mount
  did after its merge applied (a copy merged at the bind, typing) is kept
  beside it whole as one refused row under a session of its own, the next
  open's pieces (Q451).
  Once the merge view lands, a failed late merge opens the live note with
  merge view pieces instead of the copy-only recovery (Q420).
- **Stored drafts**: a sweep or draft send answered `late` marks the group's
  rows `late`, and a draft send with a late group settles at once (its
  editor goes late, stopping the send) even when another group waits for a
  retry (review r4 N5).
  Sweeps never send them, and an editor opening with any late row merges every
  restored row the same way instead of applying them. Late rows go to the
  merge whoever's session they are: `draftGroups` never shows them copy-only
  as undeliverable and `splitOpenDrafts` never hands them to the draft send.
  Under an id the room never recorded, the merged update is refused
  `unassigned` and the document opens copy-only until the re-author route
  (Q406, below) lands with the collection.
- **The merge** (`collaboration-rs/crates/late-merge`, the prototype's
  `rejoin::merge_unsent`): each unsent run goes right after the nearest unit on
  its left, in the old document, that the current document still holds.
  Tombstones count as neighbours, a run landing after a tombstone moves to the
  end of its deleted run (as typing does), and a map value written over a
  collected one follows the key's current value. Every item keeps the tab's
  id. Units the current document holds are skipped, so sending or merging
  again is a no-op; what it holds is what the room acknowledged, since the
  collection keeps every client's clock. Text the tab never saw is a tie.
  Every walk goes by ranges, so a deleted item or GC struct claiming any
  length (the room admits one) costs what its bytes cost; the walk to the end
  of a deleted run visits each item once. Each merge also names the
  top-level blocks (their item ids in the old document) holding what it would
  hide: anything the tab shows (text, embeds, attribute values) inside a block
  the current document holds deleted (written into the tombstone, where it
  does not show) or no longer holds (left out).
- **Re-authored** (`reauthor`; `mergeLate(old, current, author)`): unsent
  edits under a client id the room never assigned (made before the tab had
  one) or no longer holds are refused as they are (Developer Epo,
  2026-10-24, [error handling](../../human/frontend/error-handling.md)), so
  the same placement writes them as new edits under the session's assigned
  id, from the first clock the current document lacks for it. New ids on
  every run make this mode not repeat-safe: the caller runs it once per
  group of stored edits and replaces those rows with the applied update at
  once (a reload before the receipt then resends fixed ids instead of
  re-authoring again). Its hidden blocks go to the same copy-only recovery. A
  clock that would run past the largest one refuses the merge.
  Q406 routes a merged update refused for an unrecorded id here (the editor
  remounts into the late path with `author` = its own client id); that
  routing ships with the collection as merge view phase 2, and until then
  only the merge and its worker carry this mode.
- **Expiry**: unsent edits older than 7 days get the copy-only notice instead
  (Developer Epo, 2026-10-24); the late path reads its rows through the same
  draft groups, so the expiry covers late rows.
- **Build**: `scripts/build-late-merge.mjs`, run by `office:prepare`, builds
  the crate with wasm-pack (profile `late-merge-wasm`: no unwinding, no debug
  info, arithmetic overflow traps as in the native tests) on the workspace's
  yrs, which is the pinned fork's, into the gitignored
  `src/features/collaboration/lateMerge/generated/`. A fingerprint of the
  crate, the workspace's cargo config and manifests, the fork's yrs, the
  script and the toolchain skips it when nothing changed (a missing tool
  fails it), and CI keeps it in the `cache-betteroffice` cache under a key of
  the same files.
- Notes take the late path. Item rooms have none: their late rows open
  read-only for copying and are never applied raw, and source rooms retry a
  late refusal like any other. A note's View follows the note room through
  an `ItemRoom` read channel (`notes/liveNoteRead.ts`), which hears the
  stored version only in its step 1's answer: rejoining after a drop it names
  that version, so once a collection passed it the room answers late. The
  read channel holds nothing of its own, so it ends (`moved`) and a fresh
  document joins naming no version, as a first open does (Developer Epo,
  2026-10-27, Q425).

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
claims every live marker and rechecks the account of every distinct contributor
they name, not only the last editor. Its row holds the live markers deleted (no stored
row carries one), and after commit it clears only the claimed ones, so an update arriving during the
store belongs to the next batch; a failed store unclaims them, so its retry
keeps the same contributor set. If an account lock races an already-applied in-memory Yjs update,
persistence rejects the whole snapshot and evicts the room; authorized clients
then reload the last durable state rather than inheriting or later retrying the
locked user's update. A lost role does not reject it: what the room admitted saves
(Q635), so a removed person's last edits until the outbox's revoke closes
them can survive, at most the 30 s writer recheck's worth when it has not
delivered.

None of this gates **opening** a document. Limits protect the collaboration
service and the database on write; a document that already exists always opens.
`MaterialBody` reads `sizeBytes` / `nodeCount` from the cached material list and
shows `HeavyMaterialGate` for a note when either passes
`MATERIAL_RENDER_WARNING`, offering read-only (static `MaterialPreview`, no Yjs
handshake and no editing plugins) or open-anyway. Notes only (Epo 2026-10-22,
`heavyMaterial`): the gate spares a note's Plate editor, which a flashcard set
or quiz has no copy of in View (a 1,400-card set is about 7,000 nodes), and a
diagram draws in the Mermaid worker. Absent list metadata always opens: the gate must never become a
door the reader cannot pass. Nothing downloads the document before the reader
chooses: `GET /api/materials/{id}` carries the whole `content` envelope, so the
viewer header takes the title and kind from the list entry and the capabilities
from the workspace until the body opens, then from the body the pane read (its
query cache, no second request): Edit is per item, since the item's payer at
its storage limit or frozen makes it view-only (uploader pays). It fetches the
body itself only on the standalone page or for a material the list does not
carry, which the gate cannot weigh anyway. The workspace route
loader prefetches an open file for the same reason it leaves an open material
alone. When the API cannot decode stored content it
answers 422 `material_content_unreadable`, which `NoteEditor` and `MaterialBody`
report as "this note could not be loaded" rather than "not found". A stored
note a later rule refuses (a void element holding text, from before the void
rule) reads the same way: it stays listed and searchable, while its content
read, shared page and shared images, a single clone and a grade of a quiz its
shared page embeds answer that 422; the site Worker renders the shared page as
"this note could not be loaded" with no retry (422, uncached) and passes the
422 for its images; its index text answers 422 too, which ends the ingest job;
a workspace clone leaves it out and reports it
([authorization](../authorization-permissions-lifecycles.md)). Broken
materials are kept as they are (Epo 2026-10-19). The room's load check reads a
reference's `pending` held at null as absent, as the store and Go do.

## PostgreSQL read projection

The durable content authority is `material_yjs_documents.state` (the base, an
encoded Y.Doc) plus the update log `material_yjs_updates`: a store appends one
row, the change since the room's durable state, and `stored_version` (monotonic)
names it. A room loads by replaying base and rows straight into its own
document (`room::loaded_doc`): they are decoded first, the room takes a client
id none of them names and no user was assigned, and they are applied in one
transaction, nothing left pending. No scratch copy is built beside it and no
whole state encoded: a scratch kept alive while the room's document was built
doubled a loaded room's RSS on glibc, and the direct replay is about twice as
fast ([room memory report](../../bench/collaboration/reports/2026-11-22-room-memory.md)
cut 1). It folds the log into the
base when it unloads or the log passes `max(256 KiB, base bytes)` or 1,000
rows. The server converts the `content` root to a Plate envelope and calls the
internal Go projection endpoint: once a store is followed by 30 s without a
change (`COLLABORATION_PROJECTION_IDLE_MS`), at least every 5 minutes while
edits continue without such a pause (`COLLABORATION_PROJECTION_CADENCE_MS`,
projecting the durable state from the store; Epo 2026-10-08), when the room
unloads, and on demand. View asks for one (`ProjectLiveNote`,
`POST /internal/materials/{id}/project`) when the stored version is ahead of
the projection, and serves the stored projection if that call fails
(Epo, 2026-10-07); every material kind's `GET /api/materials/{id}` asks,
diagrams and mindmaps included (Q453), so a person's or an agent's edit
shows at once. Public pages read the stored projection.

Go validates the complete envelope, locks the material, ignores stale versions,
updates `materials.content`, increments the material revision, reconciles
flashcard stats, and advances `projected_version`. The handler parses the
body once: the operation skips Huma's body validation and takes the raw body
(still documented as `ProjectMaterialReq`), `decodeProjectionBody` decodes it
in one pass and refuses what the schema refused with Huma's codes (415 for a
Content-Type Huma has no format for; 400 for what does not decode as JSON at
all, including a number out of float64 range; 422 for a missing, null,
unknown or mistyped field or a `yjsVersion` below 1; names match regardless of
case and the `$schema` link the spec lists is ignored), and `materialdoc.NewProjection`
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
(the same `COLLABORATION_PROJECTION_IDLE_MS`). The scan
(`note_store::pending_projections`) leaves out materials in Trash, whose
projection the gateway refuses (404); a restored material lags again and is
taken up once idle (Q778 A, after Sentry CAPY-BACKEND-1Y: 25 trashed rows
would otherwise be retried every 5 s and hold back every newer one). A
projection refused for a material the database has in Trash (a room's idle,
unload or on-demand projection, or a server edit's, racing the move) is
logged at info as `projection refused` and neither recorded, reported nor
warned about (`projection::IN_TRASH`); any other 404 stays a failure. A
canvas's board room projects through the same paths, so the same holds for a
canvas in Trash.
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
already durable and remains eligible for the normal lag retry. A refusal for a
material in Trash, there and on the on-demand projection, is the explicit
in-Trash refusal, 503 `unavailable_target` with `projection::IN_TRASH` as its
message (Q784 A): unreported on both sides, the gateway answers the
replace-block edit as applied (`store.inTrashRefusal`) and serves a Trash read the stored projection, and the projection waits for a
restore.

The final durable store takes the material advisory lock, then follows the same
SQL row-lock order as Go mutations: workspace row (when present), contributor
and owner accounts in ID order, then the material row. It revalidates placement
and every contributor's account only after those locks are held. It also validates the
complete Plate structure and the custom block required by the material kind
before committing Yjs state. Member removal, role
demotion, lifecycle changes, standalone privacy changes, and clones therefore
cannot form an account/material deadlock. A lifecycle change cannot slip a save
across its boundary: the save either commits first or observes the lock and is
rejected without advancing Yjs state or the SQL projection. A lost role is
enforced at admission instead, so what the room admitted saves (Q634).

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
channel that writes and sends a viewer no presence). A viewer's first join takes
the read token its note's open already asked for instead ([opening a
note](#opening-a-note)), once. Once the room syncs, its
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
`questions`: question id to `{order, layout, labels, level?, stem, groups?,
parts}`, group id to `{blocks}`, part id to `{order, marks, blocks, answer,
group?}`, the answer map holding the type and what a learner may see (mcq
options, a short answer's unit, matching left items). A group has no order of
its own and no keys, so its text and figures merge entry by entry as a stem's do.
What a merge leaves reads repaired (Epo 2026-11-04; `repairGroups` in the
browser, `questions::repair_groups` in Rust, both on
`testdata/repairs/groups.json`): a part naming a group that is gone has no group,
a group with no parts goes, and a group's parts come together at the first one's
place, in their order. Admission holds structure and caps only, as for the rest
of the document, and the next write settles the order keys and takes a group no
part names. The limits still measure such a group and its images stay in use
(`held_question_json`) until then. The keys document holds `keys`: part id to `{type,
solution, correct | accepted | markscheme | gaps | options | pairs |
items}`; an mcq's `correct` is a map of ticks by option id (one or more,
Epo 2026-10-15), a boolean's a plain true or false, and an open part's
`accepted` holds at most one sample answer, which the room refuses past. Every
writer (`writeSample`, `quiz::sync_sample`) keeps it under the fixed entry key
`sample` (`SAMPLE_KEY`), so two first sample answers typed at once set one key
and one of the two wins (Epo 2026-11-22, "then last save wins? if we change the
question data structure now we need to change the UI as well, dont"; Yjs keeps
the entry of the client with the higher id), and a removal wins over typing at
the same moment: the other's first keystrokes are dropped, and later typing
merges into the one text; an entry under another id is edited in place.
A block entry holds its fields in both documents (a solution's in the keys
document). A chart, plot or graph is a map of plain fields, each replaced
whole (Epo 2026-11-16, D2, D3, D9; client protocol 30): a graph `{order,
type, width, height, description?, board: {bbox, axis, grid, polar?},
elements: element id -> {element, order}}` (the shape of
`src/features/graph/keyed.ts`, read by order key then id), a chart `{order,
type, kind, title, xTitle?, yTitle?, gridlines?, description?, series: id ->
order key, labels: id -> order key, names: id -> name, values:
"series/label" -> number}` (its series and labels held as a table's rows and
columns, its values plain numbers where a table's cells are texts, an empty
cell no entry), and a plot its fields alone. Two editors on different
fields, elements or values both keep their change; a figure is read repaired
(`repairFigureBlock`, `q::repair_figure`), and the projection keeps the plain
block. The room entry's key is the block's identity: blocks read from the
room carry it (`figureRoom(docs).key`), and the question card's figure
dialog writes and removes that entry (`figureRoom` in `liveQuiz.ts`: a chart
or graph through `bind`, a table at its Save). The live
writes the graph and chart dialogs use, each one undoable step touching only
what changed, are in `src/features/quizzes/liveFigures.ts` (element by id,
board field, plain fields, chart value, series and label add, remove and
rename), with `liveFigure` and `subscribeFigure` reading a figure kept
until its own entry changes. The server's writers (seeding, the save API,
agent commands) go through `sync_block`, which writes a figure field by
field and element by element, never whole. Editors type ordering items and matching options in the keys
document. Readers get them outside Yjs (D3 as revised 2026-10-10: a reader
copy inside the content document leaked typing order through its tombstones):
the content room keeps a plain list of texts per part (`items::quiz::
ReaderLists`) and pushes it over its channels as a stateless `quiz-items`
message, `{type, full, parts: {<part id>: {kind, items, total?} | null}}`, the
whole set to a channel that joins (`full`) and the parts that changed
otherwise. A part with marking items is listed too (no items, any kind) with
`total`, the items' total its learners read as its marks (Epo 2026-11-22,
"Yes, A everywhere": two editors' adds at once may take it past the cap). A
part whose entries change as a set is shuffled afresh (a uniform
permutation); a single text edit keeps the order, and a change of several
texts at once (a write that reorders and edits at once changes the list's
middle by position) shuffles too, so a
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
in use. The two documents count together against the material's limits: each
loaded room keeps its document's bound in `App::quiz_bounds` (`QuizBounds`),
reads the other room's there when it admits an update, and takes its own new
bound against the other's as it stands then, under one lock, so two writers
growing both documents at once never pass a limit the two share. The second
to take its growth is refused with the size limit, as one writer past it is,
and the first keeps its edit; before this, each room read the other's bound
from a message a flush late, both were admitted, and the stores refused both
documents and reset both rooms. An update admitted against the other's bound
as it still stands is taken as admitted, a shrink past a limit included; only
when the other's moved meanwhile is growth past a shared limit refused, a
shrink measured against the bound the other room counted for this one when
the validator holds none (review of 43fae032a, finding 5). A room that
unloads leaves its bound while the other room is loaded (it stored
everything, so the bound holds for the stored document), and the last of the
two to unload takes both away (finding 4: an unload that forgot its bound
left the other room counting the document as it read it at its own load).
An unloaded room's bound is overwritten by a server edit's store, and an
unloaded room is otherwise read from the store at its load. The store checks with the same bound, and
Go refuses a quiz projection over a limit unless it shrank. Admission checks structure, value
caps and counts only (`collaboration-rs/crates/items/src/quiz.rs`): texts,
units, labels and attributions (`QUESTION_METADATA_MAX`), image and graph
descriptions (`QUESTION_DESCRIPTION_MAX`, 500 in quizzes and notes; the bank
keeps `QUESTION_TEXT_MAX`, Epo 2026-10-14), image sizes and ids, whole marks, list and table counts, questions, parts per question and per
quiz, a question's groups (no more than its parts may be), open parts, marking
items, ticks and matching pairs, and each figure field, graph element
(`notes::questions::figure_caps` on the element alone; its form is the
validators') and chart value as it arrives (sizes only: an unfinished figure
is admitted). A figure's maps (graph elements, chart series, labels, names and
values) count to twice their caps, as a merge may pass a cap and every read
keeps them all; a figure written as one value (the layout before client
protocol 30) is refused. Every count and typed text two people's edits at
once may merge past its cap (Epo 2026-11-22, "Yes, A everywhere",
superseding 2026-10-14's "nothing past a limit is stored") is admitted,
stored and read up to twice the cap: the question dialog's inputs stop at
each limit and its Add buttons at each count (checked on the question as it
reads now), a server writer's edit (an agent's, question media, the content
save API) may not grow one past its cap (`quiz::check_written`, against what
the room held: a rewrite places entries by their list or section, not by id,
so each place's n-th largest value may reach the cap or the n-th largest it
held), past twice it is refused, and everything the store's check
refuses is refused at admission, so a store never discards a room for it. A
value past a cap comes three ways: two people's edits merged, a hand-made
client, and a paste or block Duplicate, which copies a block whole: a pasted
or duplicated figure, Mermaid diagram or table view keeps what it holds, up to
twice the cap, while interactive blocks and table views are still guarded by
count (`blocks/countCaps.ts`). A
part's marks reach twice `QUESTION_MARKS_MAX` outside the bank, a closed part's
too, so marks racing a type switch both go in. An answer turned `open` sends
its update to the exact check, which holds its accepted texts to twice
`QUIZ_OPEN_ANSWER_MAX`. A list's count
is bounded like a text's length (held plus added against its cap): only an
update that may pass a cap copies the room for the exact check, whose walk the
step counter counts (`Walk::Exact`). An image block waiting for its upload
(blank) is structure; it only leaves its question incomplete. Live quiz rooms
accept only hosted question images: an image names its uploaded `{assetId}`,
and an image's `{url}` is blank or one a stored question keeps
(`figure_url`, `Policy::hosted`: under `BANK_ASSETS_URL`, a copied bank
figure).

A quiz's question (its page's open card, or a note's quiz block in Edit, which
edits the same cards in place, Epo 2026-11-15) writes through `writeQuestion`
(`src/features/quizzes/liveQuiz.ts`: the fewest changes, lists by their common
head and tail, a move as a new order key), a table stays staged until
its `BlockDialog`'s Save, which writes only what differs into the block's own
room entry, found by its key (`FigureRoom`), and a chart or graph is edited
live (below), with Undo, Redo and the
live state in the page's header or above the note's quiz; there is no Save or
Cancel.

A chart's or graph's dialog edits the figure where it lives (Epo 2026-11-16,
D2, D3, D13): it holds no draft, has no Save or Cancel, and its Done (in the
footer, at the end of the row after Remove block; phones show the row after
the content) only closes it. It reads and writes the figure through one
binding (`FigureBinding` in `src/features/questions/figureBinding.ts`: `read`,
`subscribe`, `setFields`, `setBoard`, `setElement`, `deleteElement`,
`moveElement`, `addChartItem`, `removeChartItem`,
`setChartName`, `setChartCell`, `remove`), so its editors (`GraphEditor`,
`ChartEditor` in `BlockEditor.tsx`) know no quiz: a live quiz's figure binds
its room entry (`figureRoom(docs).bind`, `roomFigureBinding.ts`, each call one
`LOCAL_EDIT` transaction through `liveFigures.ts`, so the room's Undo takes it
back), and a question draft with no room (the bank's question dialog) binds a
plain block (`localFigureBinding.ts`), each change handed to the draft at
once; a chart's series and labels go by the binding's own handles there
(above). A note's
chart or graph binds its element (`noteFigureBinding`, over the local
binding: each change one `set_node` of the note's block, a change from
elsewhere through `receive`; above). `bindFigure` (`questionEdits.ts`) opens
the dialog: a chart or graph just added from Insert goes into the room or the
draft at once, where Insert put it (both start drawable: a graph with y = x,
a chart with one empty row and series), so the dialog has it to edit and
Remove takes it out; the dialog closes when a co-editor removes the figure.
A graph's rows stay in the editor for typing speed (a keystroke parses its
row once and the canvas redraws on the next frame) and are written by
`graphWriter.ts`: a row typed into, restyled, dragged or left unable to draw
is touched, and on the next frame its element is written if it differs from
the figure's (at most once a frame however fast it is typed, nothing when
unchanged; a new one goes last, then to its row's place, counted by the
figure's elements of the rows above it, a row that cannot draw now included).
Every existing row is written: readers draw every element up to twice the cap,
which two people's adds at once may reach (Epo 2026-11-22), on a quiz graph, a
note graph and a canvas plane alike. A new row's element is not written while
the figure already holds 100 (`graphFull`, checked as the figure reads when
written): it is named with `question_ui_graph_elements_max` and keeps its text.
While a row waits so, the writer writes again on each co-editor's change to the
figure (its own writes are skipped), so a row started before a co-editor filled
the last place goes in on its own once a delete makes room;
`onRefused` hears only a change in what is refused, and a refused row typed back
to what the figure holds is refused no more. Closing disposes the writer: the
watch ends and a frame already queued is cancelled, so one still refused when
the dialog closes is dropped with its text, as a row never drawable is: nothing
reaches the room and nothing asks first. A row that does not
parse or names a point that is not there is not written: it keeps its text
and issue while the dialog is open, and when the dialog closes the room keeps
the element's last drawable form (none for a row never drawable). A co-editor's
change reaches every row (`reconcileRows` in `graphSyntax.ts`: changed,
added, removed and reordered elements) except one holding what the figure
does not have yet, which keeps its text until it is written; element ids are
the rows' keys and never change. A tool's mark or move is written once on
drop (only the elements it changed), a pan or zoom writes the view once it settles, and a co-editor's view
waits while a gesture is under way. Axes and grid write on change; typed
fields (width, height, bounds, description, a chart's titles, names and
cells) show their own text while typed in and write once left, on Enter, or
when the dialog closes (`useCommitted`), so a co-editor's change elsewhere
never moves the caret; a width, height or bound that cannot be drawn stays in
its field with its issue, unwritten. A chart writes its kind and gridlines on
change, Add row and Add column at once, and each cell, name and title as it
is left, keyed by its series and label ids so a co-editor's cell lands in
place. Undo is the room's: writes merge into steps as other quiz edits do
(`itemUndo`, 500 ms). Plots stay shown only in the quiz dialog, which keeps
Save for them and tables. The question card's editors are nested Plate editors inside the note
block, so their input never reaches the note's. Undo spans both documents (`pairedUndo` in
`src/features/collaboration/undo.ts`: the latest step of either, and steps of
both made together, such as an answer type change, as one). Inputs stop at
their caps (`maxLength`; a text editor takes back an edit past its cap). A
quiz edits on its material page (`QuizEditor`, for whoever may edit) with
no Save or Reset: the cloud status follows the title in the header, Undo and
Redo sit there with Study, renaming goes through the item's Rename, the page
holds the question list and the open question (see
[question-bank.md](../question-bank.md#editing-and-assets)), a note's embed has
Edit (ghost-hover) and Remove (danger-light) on a row under each question
at the right, and an
incomplete question shows a line under it saying what it lacks
(`incomplete.ts`); empty text blocks and a blank short-answer unit never
count against it, but a part needs one block with
content. The bank dialog's Save drops them too (`withoutBlanks`). Readers
(the attempt page, the workspace quiz View, note embeds in View) paint the stored questions and then follow the content room
(`liveQuizReads.ts`); a learner's answer that no longer points at what a part
holds (a removed option, a changed set of ordering items) is dropped (D9). A
check of a question the room holds but grading doesn't (404
`question_no_answers`) shows "No answers configured" in place of its Check,
with no toast and nothing recorded (Epo 2026-11-05). From then the try leaves it
out: the header's counts, "{checked} of {total} checked", the result opening once
the rest are checked, and the score, which matches the attempt the server keeps
(it never counts a question that isn't projected). Until its Check is pressed it
counts in those on the page, and the result waits for it. Shared pages and review
sessions read stored questions, so they never show one.
Live rooms are the only writers of quiz content (Epo 2026-10-16: the REST
content write is gone). The server's whole-question writes, the content save
API (`set_questions`) and agent question commands (`replace_child`), go
through `sync_question`: only the questions that differ, texts as the fewest
changes, and every list (blocks, options, items, accepted answers, mark
scheme rows) by the browser's rule in `sync_entries`, ported from
`writeList` and `writeBlocks` (Epo 2026-11-17). Entries alike at the head and
tail (a block compared by its JSON as the room reads it back, a text item by
its text) stay untouched, a middle holding the same items in another order
only takes new order keys, and anything else changes the middle by position:
new items come between their neighbours, missing ones go, a block of another
type takes a fresh entry. So an editor typing in the same question, even in a
block after one the write inserted, keeps their characters. The agent's
commands' Undo is the durable Undo of every agent edit.

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
opens with the draft read-only for copying until Discard, beside Download of
what shows (`QuizRecovery`, `LiveFlashcards`, `downloadRecovery`, Epo
2026-11-23); it never rejoins with what was refused. A fresh token
naming another room (a discard) does the same with the edits as a draft of
the old lineage. An eviction notice's `mode` decides its close: a drain
(access widened; the room stored first) rejoins with the document as it is,
a discard replaces the room as a moved one. Navigating in the app never
asks; closing or reloading the tab asks only while this device's draft
storage fails and the room has not acknowledged an edit (Q561, as notes and
sources; [error-handling.md](error-handling.md#collaborative-source-failures)).

Flashcard sets edit live (live-items, Epo 2026-10-10). Each set has its own
Yjs document, `material:<id>:schema:<n>` like a note's: the root map `cards`
holds card id to `{order, front: Y.Text, back: Y.Text, image?: {assetId}}`,
ordered by fractional-index keys with the card id breaking ties
(`src/features/flashcards/liveSet.ts`, `src/lib/orderKey.ts`;
`collaboration-rs/crates/items`). The server admits only that shape (a struct
anywhere else, a card id outside 1-128 `[A-Za-z0-9_-]`, a non-text face, rich
text in a face or an image that is not `{assetId}` closes the writer), caps a
front at 200 and a back at 1,000 characters, measures the limits on every
card, blank ones included, and projects the set to its Plate envelope with blank
cards left out (a set keeps one card). `FlashcardsEditor` edits it in the
workspace file's editor (a standalone set at `/materials/$id`; the
old `/flashcards/$id/edit` page is gone) and inside a note. The card dialog
(front, back on ruled lines like a quiz's written answer, one optional image
under the front; the study card as a preview, at the study size, beside them
from `md` and under the back on narrower screens, turned to the answer until a
click flips it to the front, `CardPreview` in `CardStack.tsx`) writes as you type through
`useBoundText` (`src/features/collaboration/yText.ts`: the fewest changes to the
`Y.Text`, the caret carried through remote changes) and uploads a picked image
at once. There is no Save, Reset or Done: the dialog closes with its X or Esc,
and its footer holds Undo and Redo (this user's own edits: a `Y.UndoManager`
over the item document tracking the `LOCAL_EDIT` origin), the live state and
Remove card (borderless danger, at the footer's end on phones too). A card added and left blank goes when its dialog closes. On a
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
- comments and authorship.

Comments are plain fields (Epo 2026-10-24): each comment holds its
discussion, author and plain text of at most 3,000 characters (`text`, the
only size rule; no rich content and no JSON byte cap). Go refuses text that is
empty or only whitespace, and any field the schema does not name. Every
comment field (text, quote, block id) refuses control characters other than
newline and tab and the bidi override and isolate characters (U+202A-U+202E,
U+2066-U+2069); zero-width joiners, which emoji and some scripts need, stay
(Epo 2026-10-24, Q313). The comment box and the AI's
comments both send one plain text; the thread shows it as written. The
discussion and comment routes take bodies of at most 64 KiB, which fits the
largest valid discussion. The JSON API base64-encodes relative positions;
PostgreSQL stores raw `bytea`. Go enforces paired anchors, a block id of 1-128
characters and strict size/version/quote bounds.

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
update. An anchor resolves through `liveSlateRange` (`liveRange.ts`): an end
inside a block that left the document gives no highlight, where slate-yjs
alone would place it at the start of the last block. A thread whose anchor no
longer resolves keeps its block and quoted fallback instead of being deleted.

Document comments (Epo 2026-10-21): a thread with no `blockId`, and a thread
whose block is not a top-level block of the document now (deleted by anyone,
or replaced by the agent's `replace_block`, which mints new ids), list in one
document-level place instead of rendering nowhere. `documentThreads` in
`Collaboration.tsx` decides this at render from the live top-level ids, with
no data moved, so Undo bringing a block back (same id) returns its threads to
it. The note toolbar's pinned end shows a comment icon with their count while
there are any (`toolbar/ToolbarDocumentComments.tsx`); it opens the block
threads' popover (`DiscussionThreadsContent`) under a "Document comments"
heading, each thread with its quote, reply, edit and delete as on a block.
The API and table already allow a null `blockId`; the UI creates only block
comments. Threads have no resolved state (migration 0040).

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
Inside a note (`.note-editor`) text blocks are 4px top and bottom (8px apart)
on a 1.5 line in either note font, as the BlockSuite note's are (mock N2);
note blocks drawn outside one keep 8px (16px apart) with list items at 6px.
Quotes, code blocks, callouts and columns take the same gap as margins (4px in
a note, 8px outside); block equations 4px.

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
A column stores `width` as a preset writes it (`"33.333%"`) or as Plate's
column normalizer rewrites a group whose widths stop summing to 100 (`${n}%` of
a float, `"49.9995%"`): a plain decimal percentage above 0 and at most 100, as
JavaScript writes a number (`isColumnWidth`, Go's `columnWidth`, the notes
crate's `valid_column_width`). The browser's document check (so a Markdown or
JSON import), Go, the store and room admission refuse any other width, and
both column renderers draw none, since the width reaches a style.
The same holds for every other value a renderer puts into a style or class.
A table's `colSizes` (each entry a size or empty, null) and `marginLeft` are
px as Plate's table resizing writes them, finite numbers of 0 or more
(`isTableSize`, Go's `tableSize`, the notes crate's `table_size`). A block's
`indent` is a number (Plate's indent and list plugins, a pasted list's
`aria-level`) up to `LIST_INDENT_MAX` (`isIndent`); the indent plugin injects
its class and margin only for one (`INDENT_NODE_PROPS`). The text marks Plate
draws as styles (`color`, `backgroundColor`, `fontSize`, `fontFamily`) live
on text: the embed catalog forbids them on every element and both kits
inject them on leaves only (`inject.isLeaf`). On text, and as a list's
`listStyleType`, each holds any string a browser writes (`var()`,
`color-mix()`, non-px sizes, quoted font names, custom list markers) but no
`;` and no control character (Epo Q380, `isStyleValue`, Go's
`validateStyleValue`, the notes crate's `style_value`): the document check,
Go, the store and room admission (`MARK_VALUE` for a mark, `BAD_VALUE` for a
list style) refuse one, and both kits draw none (`STYLE_MARK_NODE_PROPS`, the
ordered list's `list-style-type`). Media blocks draw only a width
`mediaWidth` takes. `src/features/notes/refusedValues.test.tsx` holds that the
editor itself draws none of these refused values, so a crafted paste styles
nothing even before the room refuses it.
The table menu's cell/merge subscriptions remain inside the unmounted-when-closed
menu body, keeping those reads off the typing path.

## Commands

Editor settings uses the shared workspace-style tabs: General holds Display
size and Commands holds toolbar group visibility. Both preferences apply on
Apply and persist locally in `capy-note-editor-prefs`. Half width caps the
note's column at 912px (720px of text between 96px margins); Full width keeps
the margins and drops the cap. In a box of 640px or less both fill the width
with the note's gutters. Note previews use the same preference.

General also holds Note font: Fustat with roomy block gaps, or the system font
with the Plate playground's compact ones (paragraphs 4px padding and 1.5 line
height, my-1 lists, quotes, code, callouts and columns; headings unchanged).
Without a pick the style decides: capy and fisheye show Fustat, notion the system
font. A pick is per browser in `capy.noteFont` (`noteFont.ts`), not the prefs
blob, so the head scripts in `index.html` and `share.html` set
`<html data-note-font>` before first paint; `tailwind.css` maps it to
`--font-sans` and the `--note-*` gap variables on `.note-editor`, which the
editor, View and shared note pages all render in. Applying an unchanged font
stores nothing, so the default keeps following the style. Shared note pages
show the viewer's own choice (visitors without one get capy, so Fustat)
and carry a server-rendered Aa button that switches it with plain script
(`src/share/main.tsx`); the edge-cached HTML stays the same for everyone.

The width pick also has a shortcut in the top right corner of a note's scroll
area, in View and Edit alike (`NoteDisplayToggles.tsx`): a ↔ button (from `md`,
where the width shows) flips it, saving at once like Apply. Its icon stays the
same either way; the note shows which pick is on. The font is picked in Editor
settings alone (Epo 2026-11-17 removed the Aa shortcut). It sits in the scroll
area, not the toolbar, so it scrolls away with the note's top. In Edit a pencil
button (a bolt until Epo 2026-11-17) leads it and shows or hides the
note's toolbar, which starts hidden (Epo 2026-10-27); the choice is this
browser's (`PREF_KEYS.noteToolbar` in localStorage, Q461): no key, or storage
blocked, means hidden, and it holds across the editor's remounts and later
opens.

Slate's editable root spans the pane at either size. A stable `as` component
wraps its children in the width-constrained inner container, leaving margin
clicks inside the editable root and retaining native keyboard handling and
Plate's chunk rendering. Width changes do not recreate the editor.

`editorCommands.ts` is the shared command catalog. Editors can open commands by
typing `/`, through toolbar menus, or with `mod+k`. Commands, document mutations
and commenting are for those who may edit.

`mod+shift+m` opens the comment workflow for an active selection.

## Direct AI edits

Chat `edit_document` never touches the browser editor. The collaboration
service loads the durable material state into an isolated Y.Doc, merges the
open live room's state so in-flight typing counts, applies the normalized
commands through a headless Slate editor
(`collaboration-rs/crates/notes/src/edit.rs`), then fans the committed delta
into the live room as a `service-edit` update, which keeps the edit's own Yjs
items for its Undo while the room is loaded (see
[agentic-retrieval](../agentic-retrieval.md), Undo chain); the projection runs
on the same commit. A refused edit names its reason and, where the agent can retry, the
target as it reads now (see [agentic-retrieval](../agentic-retrieval.md#tools),
Tools).
A removed flashcard's review state stays in `review_states`, ignored until an
Undo brings the card back. The chat result card shows the effect with an Undo
button (`available`, `unavailable`) fed by the receipt's `undo` ref.

## Ghost text

Editor AI is ghost text only (Epo 2026-10-28; the AI menu, its previews and
`/ai/command` are gone). It is the one suggestion Plate's `CopilotPlugin`
draws after the caret's block (`ghostTextPlugin.ts`, `GhostTextView.tsx`),
shown from `sm` up. The request, the context window, the trigger rule and the
credits pause live in `ghostText.ts`, which has no Plate code so the coming
BlockSuite note can reuse them.

- **On.** Each user turns it on in Settings → LLM ("Note AI suggestions",
  `users.note_ai_enabled`, off by default; there is no build flag). The plugin
  is registered wherever the editor may call the server
  (`allowExternalAssets`); `GhostTextSync` hands it the switch and the note
  title at runtime, so flipping the switch never rebuilds the editor, and
  turning it off drops a suggestion on screen. While off nothing triggers and
  every key handler returns false, so Tab and the rest reach the editor.
- **Where.** Top-level text blocks only (paragraphs, headings and the flat
  indent lists), never a table cell, callout, column or code line, and only
  from 640px up: below `sm` the suggestion is hidden and phone keyboards have
  no Tab (Epo 2026-10-28).
- **Trigger.** With the caret collapsed at the end of its block, a 500 ms
  pause after a space, a CJK character or a CJK punctuation mark (Chinese has
  no spaces), never during IME composition or while a suggestion shows. Any
  local edit or caret move restarts the pause. ⌥Space (Ctrl+Space off Apple)
  asks at once.
- **Keys** (MI:225). Tab accepts, Esc rejects, ⌥→ (Ctrl+→) takes one word;
  typing what the suggestion starts with consumes it, anything else drops it.
- **Request.** `POST /api/workspaces/{id}/ai/copilot` with `{title, before,
  after}`. `before` is Markdown of whole top-level blocks back from the caret's
  block within 1,500 UTF-8 bytes (a longer caret block keeps its end), its
  trailing space kept; `after` is empty in Plate, since the caret is at the end
  of its block. Plate posts a string prompt, so `ghostTextPlugin` passes the
  context through as JSON and sends it with the API client, which turns a
  refusal into an `ApiError`.
- **Stale requests.** A local operation, typing or a caret move, cancels the
  pending trigger and aborts a running request (Plate itself would let both
  run on), and an answer is shown only while the caret's block and its text
  are what it was asked about. A collaborator's edit elsewhere leaves the
  suggestion and the request alone; one in the caret's block drops them.
- **Rendering.** Plate renders the ghost-text component under every block;
  it subscribes only to whether its block holds the suggestion, and only that
  block reads the text, so a changing suggestion re-renders one block.
- **Errors.** Failures, an empty answer and `provider_busy` stay silent.
  `llm_credits_exhausted` shows one toast (the shared credits copy) and stops
  auto-trigger until the page reloads; `note_ai_disabled` (turned off on
  another device) turns it off in this tab.

The gateway refuses with 403 `note_ai_disabled` while the switch is off,
before any spend; otherwise it bills the editor surface on the editor slot's
default pin with reasoning off (`resolveLLM`). Python owns the prompt
(`prompts/editor.py`): a short system prompt, then the title and the text
around a `<CARET>` marker; 40 output tokens at temperature 0.2. The answer
keeps its first line only and loses its leading whitespace when `before`
ends in whitespace (`ghost_suggestion`). The pin's cost, latency and capacity
are measured in `todo-ghost-text.md`; see
[observability-metering.md](../observability-metering.md) for pinning, leases
and credit rates.

## Static rendering

`MaterialPreview` uses `PlateStatic` and the checkpointed Plate envelope. Static
components must not use editor hooks. `StaticMaterialKit` has no markdown
parser: uploaded `.md` files convert first, in a worker
(`files/MarkdownPreview.worker.ts` through `markdownToDocument`), and the
markdown converters add `noteMarkdownPlugin` on top of the kit themselves. The
kit imports no `.tsx` module and nothing render-only, so that worker can load
it; `MaterialPreview` adds code highlighting (lowlight) and
`UnsupportedBlockPlugin` itself. Vite aliases
`decode-named-character-reference` to its DOM-free entry, since a worker has
no `document`. Interactive and static component
registries share node vocabulary but have different behavior.

Obsolete `suggestion` and `suggestion_*` properties are rejected by server
validation and are not rendered.

## Operational boundaries

- Signed-out visitors never connect; signed-in viewers of a note or a set hold
  read channels (no stores, projections or markers of their own).
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
  (`src/features/notes/cursorThrottle.ts`); a send that waited sends the
  selection as it is then, and none once the editor is unbound, since the
  range it was given may name paths a remote change moved (Q229).
- Monitor active rooms/connections, Y.Doc size, store/projection latency and
  failures, projection version lag, event-loop lag, RSS, disconnects, and
  Redis/PostgreSQL latency.
- Do not impose an arbitrary room occupancy cap. Add a distributed measured cap
  only when load tests or production usage justify one.
- Keep Yjs garbage collection enabled. Yjs history is not compacted for now
  ([Yjs storage growth](../backend-storage-quota.md#yjs-storage-growth)).
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
- The block menu (right-click, `BlockContextMenu` in `BlockInteractions.tsx`)
  is a non-modal `DropdownMenu` anchored by `DropdownMenuAnchor` to a
  zero-size span at the click point inside the editor's content, so it
  scrolls with its block and hides once the block leaves the scroll area
  (`hideWhenDetached`), as the floating toolbars do. It takes the editor
  popovers' look (All blocks: `rounded-lg`, 30px rows, an icon per row
  except Turn into); its content keeps `data-slot="context-menu-content"`
  for the specs.
- Comment decorations must match Slate paths structurally (`Path.compare`,
  not dot-joined path strings, which put block 10 before block 3); remote
  cursors are returned at the root only. Shared-link editors may be absent from the
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
A click beside an inline formula, not on it, puts the caret on the side clicked
(`FormulaCaretPlugin` in `formulaCaret.ts`, notes and question editors): Chrome
lands such a click in the formula's hidden spacer, which selects the formula and
drops typed text. It checks on the click and on the selection change, since Slate
throttles DOM selection and an already-selected formula sends no change.
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

## BlockSuite on main

`vendor/blocksuite` (plain files; its README lists the local changes) is on `main`
for the drawing answer's board only (Epo 2026-11-06). Notes stay on Plate until the
cut. `src/features/blocksuite/drawingBoard.ts` imports just the editor parts the board
needs, so it's a lazy chunk of about 650 KB gzipped, and the app reaches it through
`drawingBoard.boundary.d.ts`, so the app's type check skips the vendored sources.
data-view (database and table views) stays out of it: its elements are defined by the
database and data-view blocks, and Convert to database loads them on use (local change
26); `createIcon` takes icons by reference, so only icons the code names ship (local
change 27). The board takes a stroke as soon as Answer in Canvas is clicked (fix 4
of the canvas-open report, Epo 2026-11-07): once a canvas part (`CanvasAnswer`) or a
sample answer field (`DrawnSampleField`) shows, `useBoardAhead` in
`quizzes/drawing/boardPrefetch.tsx` fetches and evaluates the module in idle time
(within a second, `whenIdle`), then renders that part's `DrawingBoardScreen` with
`hidden`, which mounts the board in idle time too, or at once if Answer in Canvas comes
first: a mount is one long task. A quiz editor's canvas (`CanvasField`, in the stem, a
group's text or a part's) only preloads the module and mounts its board on Edit canvas,
leaving the page's one board ahead to a sample field. Hidden is `opacity: 0` with `inert` and `aria-hidden`, not
`visibility: hidden`, since BlockSuite gives every card in view (notes, images) an
inline `visibility: visible` that beats a hidden parent; `inert` keeps pointers off
everything in it, and the board keeps its size, so it mounts and fits as if shown. A
hidden board keeps no device draft (a note's height settling as it mounts isn't the
student's) and takes no time-limit Done. Answer in Canvas only shows it and fits it again at the
window's width then; Done puts it away: `putAway()` closes an open card, clears the
selection and turns off BlockSuite's event dispatcher (local change 28), whose key and
clipboard handlers sit on the document. A Done that changes the answer mounts the board
again, hidden and in idle time, for a fresh undo history. One board is mounted ahead
per page, held by the first canvas part that shows until it leaves; other parts mount
theirs on Answer in Canvas, with the module already there. A hidden mount that fails
says nothing and the button tries again; a mount that fails when shown says so and
closes, and the next press tries again. A first mount took 240-430 ms at 4x CPU on a Mac (about 1 s on the
CI runner) and showing one mounted ahead about 12 ms; a mounted board holds about 3-9
MB of JS heap and 3,500-5,700 DOM nodes.
Nothing in production opens it yet: `/dev/drawing` is a dev-only route. A production
build swaps that route for an empty module (`MSW_ENTRIES` in `vite.config.ts`), so it
doesn't ship the vendored sources; the answer flow reverses that. No vanilla-extract plugin
runs: the board's only `.css.ts` styles, the canvas note's, are plain CSS (local change 24). `pnpm audit` covers these packages' dependencies but not the copied
source, so an AFFiNE security fix stays unseen until someone re-copies.

The dev server pre-bundles the board's BlockSuite (Q683): at start `vite.config.ts` reads
every `@blocksuite/affine/*` subpath that `src/features/blocksuite` names and adds them to
`optimizeDeps.include`, so esbuild bundles them once into Vite's dep cache instead of the
server sending about 2,000 vendored source files a request each. An esbuild plugin there
gives each `.css.ts` file vanilla-extract's file scope, and its styles register in the
browser as the module runs, so the dev server runs no vanilla-extract plugin (a build with
MSW on still does). Two consequences:

- An edit to `vendor/blocksuite` shows only after the bundle is rebuilt: start the server
  with `vite --force`. `src/features/blocksuite` stays app source and hot reloads as before.
- A BlockSuite subpath newly imported there needs a server restart. Until then it loads as
  source beside a second copy of what the bundle holds.

Numbers in [editor-perf.md](../editor-perf.md#drawing-board-in-dev).

### The note's and the board's chrome

Decisions: `human/frontend/plate-editor.md`, 2026-11-10 (mocks
`artifacts/2026-11-09-notion-notes-look-mocks.html`). The BlockSuite note
(`VITE_DOCUMENT_LAYOUT=blocks`) and the drawing board share one look for
everything that floats, and the note body takes the Notion look in every style.
Main carries this look for the Plate note and the boards only: there is no cut
(Epo 2026-11-12), so the BlockSuite note's own files (`pageEditor`, `blockMenu`,
`tableBar`, `calloutLook`) stay on `blocksuite-notes`, and below they describe
that branch.

- **Tokens:** `src/features/blocksuite/chrome.css`, imported by `drawingBoard.ts` (and `pageEditor.ts` on `blocksuite-notes`),
  maps AFFiNE's `--affine-*` variables onto the app's tokens
  at the root (text, icon, panel, border, hover, shadow, font), since BlockSuite's
  parts read them from inside shadow roots and from popups under `<body>`. It
  outranks the theme sheet and the board's dark palette, and stands down while the
  marking image is drawn (`[data-board-light]`). What is selected or active is the
  app's accent on the board as in the note (Epo 2026-11-13, F1; until then the board
  kept AFFiNE's blue), so the notion style's is blue. The selection frame is
  Excalidraw's (local change 56): a 1px accent line 6px off the selection, dashed
  round several, 9px square corners filled with the board's paper
  (`--capy-handle-fill`), a faint bar outside each side that resizes, and a rotate
  knob above the middle for whatever turns, in place of AFFiNE's hidden ring past
  each corner. A turn within 4° of a multiple of 45° lands on it (local change 58),
  Shift snaps to every 15°, and the angle shows in one place while turning, under
  the circle the selection turns in (above it when the bottom toolbar would hide
  it). Quiz, set and link cards turn their content with the frame
  (`boardCards.ts`), as a picture does. The selection's toolbar stands 30px further off, clear of the
  knob.
- **One floating bar:** BlockSuite's `editor-toolbar` draws every bar: a text
  selection, a selected block (table, callout, image), a link, and on the board a
  selected element or several (Group, Align, Lock). It is an opaque overlay panel:
  36px tall from `sm` with 28px buttons and 18px icons, 32px and 26px on phones,
  where it keeps every control and scrolls sideways inside the screen. Sizes are
  `--capy-toolbar-*` properties in `chrome.css`; corners are the style's
  `--radius-toolbar` and `--radius-toolbar-button`. The bar lives in a shadow root,
  so the vendored parts read those properties (vendor README local change 34).
  Every icon in a bar is 18px, AFFiNE's fixed 20px ones included (16px in the
  small inner bars, such as the code block's).
  The board's own panels (the ☰ button and list, an open card's tools, the
  formula card) take the same corner and shadow, but the ☰ button is flat, as the
  canvas picker and a phone's Back beside it (Epo 2026-11-12). On the canvas pages the
  three are 32px tall, 8px in from the board's top left and right at every width
  (`--capy-board-menu-size`, which the pages set; the ☰ by an open card's Done stays
  Done's 40px). Its bottom toolbar keeps AFFiNE's 64px height and corner, which its
  pieces are fitted to; its narrow layout (78px tools, the full width) follows the
  board's width, as its paging does, not the window's (local change 15).
- **Icons:** `vite.config.ts` aliases `@blocksuite/icons/lit` to
  `src/features/blocksuite/blocksuiteIcons.ts`, which re-exports AFFiNE's set and
  replaces about ninety names with Hugeicons in the app's 1.8 stroke, in the
  vendored code and ours alike. A name not listed there keeps AFFiNE's drawing
  (connector ends, line and shape styles, list markers, file types, and the two
  highlight icons, whose first path takes the picked colour).
- **Labels:** BlockSuite's English labels pass through `tr()` where they are drawn
  (local change 37) and `chromeLabels.ts` answers with paraglide messages (existing
  `editor_*` and `action_*` keys where one says it, `chrome_*` otherwise). A label
  not in the table, or one written straight into a template the hook does not
  cover, stays English.
- **Note body** (`pageEditor.css`): a 720px column with 96px margins (912px
  editor width; the 16px gutter once the note's box is 640px or narrower; no cap
  at the note's Full width
  setting, read in `BlockSuiteNote.tsx`), 16px/1.5 text in blocks padded 3px 2px,
  headings 30, 24 and 20px at 600 with 32, 22 and 16px above. Sizes above 16px
  shrink on narrow screens as `note-fs` does. Code blocks take the dim fill. The
  margins follow the note's own box (a container query), so a note in a narrow
  pane takes the gutter as a phone does. The note's font setting
  (`<html data-note-font>`, `noteFont.ts`) applies to the body and the title
  through `.blocks-note`.
- **Callouts** keep the app's own look (`calloutLook.ts`, local change 39): the
  five kinds of `richBlockConfig.ts` with their tint, border and icon, from the
  block's `variant` (none reads as info). A selected callout's bar switches its
  kind; BlockSuite's emoji and background pickers are off.
- **Gutter handle and block menu** (local change 36, `blockMenu.ts`): a hovered
  block shows + and a six-dot grip, centred on its first line. + adds a line
  below and opens the slash menu on it (the slash is typed there, so a search
  can follow; leaving the menu without a pick removes the slash again, so the
  line is empty). A click on the grip selects the block and opens a vertical menu
  beside it: Turn into (a side submenu, text blocks only), Copy, Duplicate,
  Delete. The floating bar stays away while it is open, and closing it lets the
  block go; the menu closes with its editor.
  A table, callout or image has a bar of its own, so its grip only selects it.
  The handle needs the editor to report page mode, which `pageEditor.ts` does
  (`DocModeExtension`); without AFFiNE's app nothing else reports one.
- **Slash menu** (local change 35): 28px rows in a 240px panel, an 18px icon,
  the name and its Markdown shortcut, uppercase group labels, no descriptions.
- **Tables** keep BlockSuite's hover handles (⋯ over a column, ⋮ beside a row,
  + bars at the right and bottom edges, each with its menu). A table selected as
  a block shows Header row, Duplicate and Delete (`tableBar.ts`); a header row is
  the first row's `header` prop, drawn semibold on the dim fill (local change 38).
  The header belongs to the table's first row, whichever row that is: adding,
  moving, copying or deleting rows keeps it there (`keepHeaderFirst` in the
  vendored `table-data-manager.ts`). Only the first row draws as a header, so a
  `header` flag that arrives lower down (two people moving rows at once, a
  converted table with a second header row) shows nothing, and the next row
  change or press of Header row clears it.
- **Title and Info** (`src/features/notes/NoteHeading.tsx`, shared with the
  Plate note below): the top
  of the body shows the file's name as a 40px title. It is the material's
  `title`, not text in the note: leaving the field or pressing Enter renames the
  file through `PATCH /materials/{id}/metadata` (an empty or too long name is
  dropped, and a refused rename shows the file's name again). Only a title that
  was typed in is saved, so leaving the field never undoes a rename made
  elsewhere, which shows there. A name is one line: pasted line breaks become
  spaces, and a long name wraps and re-wraps with the column. Under it a
  collapsed Info row (quiet: no rules above and below, a ghost button as wide
  as its label, muted until hovered, Epo 2026-11-17) opens Topic (a press moves the note to another topic),
  Created, Updated and Words, counted when it opens. A reader, and a note outside
  a workspace, see Topic as text; a reader's title cannot be typed in.

**The Plate note takes the same look** (Epo 2026-11-10: both note engines are
aligned while Plate stays in the app). Built so far:

- **Headings, quote and divider** (`nodeStyles.ts`, shared with the static
  renderer, so previews and shared pages follow): 30, 24 and 20px at 600 on a
  1.3 line with 32, 22 and 16px above; a quote is upright text behind a 3px
  bar in the text colour; a divider is 1px.
- **Rhythm** (`tailwind.css`, `.note-editor`): text blocks 8px apart on a 1.5
  line in either note font; the font setting changes the font and its weight
  only.
- **Column** (`note-column` in `tailwind.css`): 96px margins from a box 880px
  wide and 48px from 640px (a tablet's pane, Epo 2026-11-19), capped at 912px unless Full width, in the editor
  (`NoteEditorSurface`), the painted note and the preview (`MaterialPreview`),
  and their footers. The steps are a padding max/min on the parent's width, so no
  container is declared. A narrower box keeps Plate's gutters (20px on a
  phone and 40px from `sm`, and always 40px on the editor's right for its
  thread buttons) where the BlockSuite note uses 16px. As in the BlockSuite
  note, a box just over 640px holds less text than one just under it.
  The same shared classes also restyle what else draws them: `.md` previews,
  the merge view, and the standalone quiz, flashcard, mindmap and diagram
  title (`StandaloneMaterialTitle`, now 30px at 600).
- **Floating bars** (`components/ui/BlockToolbar.tsx`, shared by the
  selection, link, table, column and media bars, the flashcard tile and graph
  editor bars and the question editors'; the study block bar in
  `notes/blocks/elements.tsx` repeats its box):
  36px tall with 28px buttons from `sm`, 32px and 26px on phones, on
  `--radius-toolbar` with `--radius-toolbar-button` buttons.

- **Title and Info** (`NoteHeading` with `plate`): over the editor
  (`EditorNoteHeading` in `NoteEditorCore.tsx`, outside the editable), over the
  painted note, Preview and a reader's note (`PaintedNote` in `NoteBody.tsx`,
  read-only) and over the late copy, in `note-column` with the title flush to
  the text. Every view draws it at the same height, so the paint hands over
  to the editor and Preview opens without a jump (positions are restored
  block by block). A note painted before its read answers has its name only:
  the same box, with nothing under Info yet. Enter puts the caret at the
  note's start; Words counts the blocks' text (`noteText`). Info's open state
  is kept per note for the session and shared by these views, so opening the
  editor or Preview does not close it. The editor's title is read-only while
  the note is locked (lost access, outdated, offline limit, full copy), and
  the phone's paused copy makes it read-only too (`copyPausedView`). The
  block lies over the note's corner buttons (`NoteDisplayToggles`) and the top
  16px of the editable, so only the title and the Info row take the pointer:
  clicks on its padding go through to what is under it. The space over the
  title (40px, 64px from a box wider than 640px) is `note-column-head`, the
  column's padding clamp again and not a container query: with a query
  container in the note's scroller, WebKit's scroll anchoring stops holding a
  reader's place while blocks go in above (measured 2026-11-10 on Playwright
  WebKit 26.5; `e2e/sharing/live-note-view.spec.ts` runs that reader in
  WebKit). The BlockSuite note's title still declares its container.
- **Gutter** (`BlockInteractions.tsx`): from `sm` a + sits left of the grip on
  a top-level block, both on its first line (an embedded quiz or set too,
  Epo 2026-11-17, no longer centred on the block's height). It adds a
  paragraph below and types the slash, so the
  slash plugin opens its menu; left without a pick or a search, the line
  stays empty (`gutterSlash.ts` marks the input node, `SlashInput.tsx` skips
  writing the slash back). A click on the grip opens the block menu under it
  (the right-click menu: Delete, Duplicate, Turn into, Indent, Outdent,
  Align) through `BlockMenuOpener`; a drag still moves the block. The grip
  menu is not offered on a touch device; a read-only note has no gutter. The chunk containment
  margin (`[data-slate-chunk]` in `tailwind.css`) is 44px on the left from
  `sm` so the + is not clipped.
- **Tables** (`TableNodes.tsx`): a pill beside the hovered row (it also drags
  the row) and over the hovered column opens a menu (insert before or after,
  delete); a + bar along the right edge and one under the last row add a
  column or a row at the end; they show while the pointer or the caret is in
  the table. The caret bar holds Merge and Split where they apply, Header
  row, Duplicate and Delete. A header is the first row's cells as header
  cells: inserting a row above it or deleting it keeps the header on the
  first row, and rows added below it or at the end are never header rows.
  `TABLE_WRAP_CLASS` pads the table (8px above, 20px right and below) in the
  editor and the static renderer alike, so the pills and the + bars fit
  inside its scroll box and both draw the same size. A pill acts on its
  cell's whole span: deleting from a merged cell takes every row or column it
  covers.

Kept different on the Plate note: on a phone its gutters stay 20px, and 40px
on the editor's right for the thread buttons, where the approved look has
16px; rows moved by dragging do not re-place the header.

Not built: the Table view block (AFFiNE's database, mock V2), queued as its own
step; Colour, Copy link and Comment in the block menu (the BlockSuite note has
no block colour, links to a block or comments yet).

### The board's tools

The board adds to BlockSuite through its own extensions (`boardTools.ts`, `boardPlane.ts`,
`boardPlaneEditor.ts`, `boardChart.ts`, `boardChartEditor.ts`, `boardEditorShell.ts`,
`boardFormula.ts`, pure geometry in `boardGeometry.ts`), with a few
vendored changes (14 to 21 in `vendor/blocksuite/README.md`).

- **Toolbar:** AFFiNE's shape pieces in the eraser's fixed colours (CSS variables on
  `.capy-board`), then two slots of pieces drawn like AFFiNE's shapes (Epo 2026-11-08,
  canvas NsamYcLR4imjm5Xi2fWFj2 "Picked"): Graphs (a polar disc behind a coordinate plane)
  and Formulas (d/dx, ∫, Σ, √x), then Misc, which holds the charts since 2026-11-10 (the
  Charts slot is gone; the B and Shift+B keys still place a chart). On the workspace
  canvas the Formulas slot is a **GIF & Sticker** slot instead (Epo 2026-11-12, mock
  LXarL8yrtSK1hNB8ydPkan, A + M1; `sheetTools(board)`): a GIF card behind a sticker,
  centred in the bar (Epo 2026-11-13) and lifting together on hover, whose click opens KLIPY's view (Misc's panel with `only`
  set: no Back) on the tab used last; Formulas move into its Misc, and the M key still
  opens a blank formula on both boards. `CapyPieceSlot` runs on
  BlockSuite's `EdgelessDraggableElementController` as the shape slot does: a piece lifts
  under the pointer, a click or a drag picks it up, it lands where it's dropped and a new
  one rises into the slot once it leaves the toolbar; Escape or the toolbar puts it back.
  A finger has nothing to carry it with, so a tap puts the card in the middle of the view
  and a drag brings it out (a second controller without click-to-carry).
  Pieces sit round the slot's middle, so a phone's narrower slot keeps them. A formula
  piece puts down its starter card (`placeFormula`) and opens the editor on it. There is no
  label tool. The toolbar and its pen touch the canvas only, never into a card. New shapes have no fill
  and a black outline.
- **Pen strokes** keep the moves inside BlockSuite's 2 px drag threshold, and a stroke
  ending back near its start (a closed circle) is no click, so it leaves no dot (local
  change 25, in the pointer controller, so every tool's drags and clicks behave this way).
- **Slot keys and tooltips** (Epo 2026-11-08): each piece's tooltip names it with its
  key, the slot's between pieces. G puts a coordinate plane in the view's middle, ⇧G a
  polar one, B a bar chart, ⇧B a pie chart, and M opens an empty formula card (a
  formula piece starts filled in, so has no key); none of these is one of AFFiNE's,
  and they're off while typing, while a card is open and with the board out of sight.
- **The ☰ menu** (`boardMenu.ts`, Epo 2026-11-08) sits top right, left of any Done the
  page around the board places (its width through `--capy-board-done-width`, its top through
  `--capy-board-menu-top`; a drawing answer measures whichever Done shows, the phone's or the
  wider screen's), so the
  bottom row holds only the toolbar: Undo, Redo, Fit to screen, Download as image, Clear all (Epo 2026-11-13:
  everything on the board, or in an open plane or chart, goes in one undo step; greyed
  out when there's nothing; a pie keeps its 12 o'clock line), then a row of −, the
  zoom (which resets to 100%) and +. Fit to screen closes it; Undo, Redo and the zoom
  row keep it open, so a few presses step back or zoom; a press anywhere else and
  Escape close it. Its rows are the editor popovers' (30px, medium 14px text, 18px
  icons, Epo 2026-11-12); a row with no icon lines its text up with those that have one.
  A teacher's board, a viewer's and one that takes no edits have Fit to screen,
  Download as image and zoom only.
  Download as image (2026-11-19, mock MenuDownload, as Office keeps Download) saves
  the whole board as a PNG named by the board's `title` (a canvas's, without the
  characters a file name cannot hold; `canvas.png` or `drawing.png` with none), on white in the
  light palette, its longest side at most 4,096 px, drawn as the marking image is
  (layer by layer, so what the screen covers is covered) but with nothing moved
  nearer. BlockSuite's own `ExportManager.exportPng` is not used: it draws every note
  under every stroke, offsets blocks by 50 units, and gives nothing when one image's
  file is missing. An image whose file cannot load is drawn as a light box saying
  "Image not available" at its place (Epo 2026-11-20, Q43 A). A board that cannot
  be drawn says so in a toast. The board's `image()` draws the same PNG and `ready`
  resolves at its first view, for a deleted canvas's Download off screen.
  On a canvas (`setRoomSize`, Epo 2026-11-18, 2B) the menu ends, from 75% of the
  room's cap, with a divider and `Size: 3,150/4,096 KB`, kilobytes rounded up as a
  note's size line (`documentStats.ts`); at the cap the row is in the error colour
  and reads on ` · Only edits that remove content will be saved.` A board with no
  room (`/dev/drawing`, answers) shows none. Just left of the ☰ (12 px apart, 8 px
  below 640 px, where a note's header goes compact) sits `statusSlot`, an empty element the canvas page portals its save
  status into (1B); empty, it takes no room.
  From the cap less the room's 64 KiB margin (`BOARD_OFFLINE_MARGIN`, the
  space offline work leaves, online too: client-limits A) the size row is red
  with the remove-only words and the board takes only edits that remove content
  (`boardFull.ts`): select, the eraser, Delete and moving stay; what adds is
  refused with "Only edits that remove content will be saved." in a toast: a
  tool other than select, pan and the eraser (the pen, highlighter, shapes,
  notes, text, connectors, stamps; picking one goes back to select), a paste,
  a drop, ⌘D and the element toolbar's Duplicate (both through
  `createElementsFromClipboardDataCommand`), an Alt-drag's copy, a mind map's
  Tab or Enter child, a shape's auto-complete +, a double click on empty
  canvas (its note, or with the note off at the cap a canvas text label; one
  on an element edits it, and a board that takes no edits, offline past its
  cap, says nothing), a piece or picture from the toolbar or Misc, a
  link card and a quiz or set card (or a new one made for the board; one a
  peer's filling refused while it was made still opens, kept in the
  workspace's list), an image picked, and a new formula.
  Typing in what is already there and Undo are not stopped; the room refuses
  them past its cap and its copy-only recovery takes over. Below the margin it
  all comes back. The gate coming on under the pen leaves it picked: its next
  press on the board (`gatePresses`, the tool controller's hooks, which hear
  only presses on the canvas, never the toolbar's) checks the size and, still
  full, is refused with the toast and goes back to select, nothing of the
  press reaching the pen (bytes room review 4, 2026-11-25: before, the board
  went back to select silently as the gate came on, which encoded the board at
  each crossing in every tab holding the pen while a peer moved things). `setRoomSize`
  is called on every update of the room, so it does nothing unless the row's
  text or the gate changes.
  A popover, menu or dialog of the page's that holds focus keeps it while the pointer
  crosses the board (local change 40): upstream the board took focus back on the
  pointer's first move, which closed the canvas picker.
  AFFiNE's zoom toolbar isn't loaded. Below 768 px the toolbar spans the screen less an
  8 px gutter, which needs `.capy-board` to be the `viewport` container.
- **Selecting** shows AFFiNE's own toolbar. It reads the editor's mode, so the board
  reports edgeless (`boardToolbar` in `boardTools.ts`) and hides what makes no sense on an
  answer: Frame, Comment, a note's page mode entries, a group's or frame's Insert into
  Page (the board has one mode, Epo 2026-11-09) and the linked doc entries. Connect shows its name. A plane card
  adds a pen that opens it and a Fit to size / Custom size toggle; a chart card adds the pen.
  The board (`.capy-board`) is positioned, so this selection layer and the ☰ menu sit
  against it even with a header row above it (a tablet's). BlockSuite's own toasts go to
  the app's `userToast` (`setToastHandler`, vendored local change 33); its fixed
  container was cut off by the page. They read in the app's language through a table
  of their own beside the chrome labels' (`toastText` in `chromeLabels.ts`, as decided
  2026-11-10 for the labels); one the table does not hold shows as written.
- **A canvas that takes no edits selects and copies** (2026-11-19, mocks ReadOnlyCopy
  and ReadOnlyPhone; notes and Office allow it in every read-only state): a viewer's
  board, copy-only recovery, a frozen or full one, a trashed canvas and an editor's
  board while it is locked. A mouse or pen click selects (vendored local change 71),
  a drag on empty board selects by its box, ⌘C copies; a finger pans and a tap
  selects (`TapPanTool`, `boardReadOnly.ts`). The tool is picked by each press's
  pointer, so a touch screen with a mouse does both. There is no toolbar: a bar with
  one Copy sits above the selection (below it when the board's top has no room),
  and puts on the clipboard what an editor's copy does (`copySelection`, local
  change 71); it says "Copied to clipboard". Nothing writes to the board: the moves
  stay refused (local change 65), cut copies only, a paste and a double click add
  nothing (local change 71). A teacher's view of an answer pans and zooms only.
- **An image while it uploads** (Epo 2026-11-06, as a note's placeholder; mock
  Upload): on a canvas, a box at the place and size its block will take shows at
  once with "0% uploaded" and a bar (`boardUploads.ts`; BlockSuite names the box
  before it stores the file, local change 70). The box is the page's own, in no
  one's stored board, so a refused upload leaves nothing behind: its box says "The
  image couldn't be added." with the reason and a Close. The other images of one
  paste still land. Peers see an "Uploading" box with the uploader's outline and
  name tag through board presence `uploads`, each id the box itself (`x,y,w,h` in
  whole board units, base 36, at most 29 characters, `uploadId` in
  `boardPresence.ts`); a board that takes no edits sends none, as a read channel's
  state may hold no `uploads`.
- **Shapes panel:** replaces AFFiNE's one-row menu through a DI override of the `shape`
  senior tool. The right triangle, parallelogram, trapezium, pentagon and hexagon are
  shape types added to BlockSuite (local change 46: corners in `POLYGON_SHAPES`, one
  polygon implementation for hit tests, connectors, canvas, DOM and cursor preview), so
  they fill, hold text and connect as a square does; `boardPreview.ts` keeps a copy of
  the corners, checked by its test. A selected shape's Switch shape type menu, and a
  connector's next-shape panel, offer the same ten in the panel's outlines (local change
  61, Epo 2026-11-13). Solids and diagrams are presets of straight
  connectors and ellipses in a group (a pen stroke smears at corners). The toolbar's
  square piece is a plain square (local change 43; AFFiNE's was rounded). Clicking the
  toolbar's Shape piece only opens or closes the panel; a shape is taken up by dragging
  the piece (the drag shows the piece in its toolbar colours, local change 14) or by
  picking it in the panel. A picked shape follows the pointer, centred on it, until a
  click places it there or a drag sizes it: BlockSuite's own shapes through its overlay
  (local change 41), the presets and lines (`StampTool`) drawn as they will be placed on
  the board's preview layer.
- **Toolbar buttons with a panel** (Shape, Note, Misc; Epo 2026-11-12) share three helpers
  in `boardTools.ts`: `togglePanel` (a click only opens or closes the panel, nothing
  follows the pointer yet), `closeOnPressOutside` (a press anywhere but the panel or its
  button closes it) and `followTool` (the panel closes once what was picked is placed or
  another tool is taken while it is open; it opens over any tool, so the pen stays the
  pen until something is picked). The Note button is `capy-note-button`, overriding the `note`
  senior tool; with a kind picked the button stays lit and the pointer is the plus
  cursor, with nothing following it, and a click (or a drag, at its start) places an
  inline note whose first line starts at the pointer, centred on it (local change 53,
  Epo 2026-11-13, like a text tool; it replaced local change 48's carried preview and
  AFFiNE's dragged-out box). A paragraph's placeholder clips both axes
  (local change 49), so a heading's shows no scrollbar. The note menu marks a kind only while a note of it is in
  hand (Epo 2026-11-13): AFFiNE's menu marks the tool's kind, which stayed the last one
  picked. Where the board takes link cards (the workspace and the Canvas page), the
  note menu starts with Link (Epo 2026-11-13, P1; local change 57 gives the menu a
  `lead` button and an `above` slot): its field (`capy-link-add`) opens above the
  row and places a link card as Misc's YouTube tile does (`placeLink`). A tooltip of
  something inside a toolbar menu (a popover in the top layer) is shown in the top
  layer too (local change 51), so it lands above the menu.
- **Select after placing** (Epo 2026-11-13, replacing 2026-11-12's return to the
  drawing tool): whatever is placed (a shape, a preset, a carried piece, a Misc card,
  a GIF, sticker or emoji, a picked image) leaves Select on with it selected, whatever
  tool was on before. `addCard` and `addPicture` take Select before selecting what
  they add, and Misc's Image tile before its images land. A placed note keeps the
  focus for typing.
- **Strokes** (local change 50, Epo 2026-11-12): a mouse stroke stores no pressure and
  draws at one width, and a mouse click is a dot at pressure 0; a pen or stylus that
  reports pressure keeps it. A stroke at pressure 0.5 is exactly its width wide, as
  `boardPreview.ts` draws it (AFFiNE drew each width 1.41 times over). The highlighter starts
  at its third width, 18.
  A stroke's points are stored as one binary value (local change 79, Epo 2026-11-24;
  `strokePoints.ts`, the one codec): a 4-byte header naming 2 values a point (x, y) or 3
  (with pressure), then the values as little-endian Float32s, relative to the stroke's
  box as BlockSuite keeps them, so a stroke 10,000 units long keeps about a thousandth
  of a unit anywhere on the board. Upstream's number arrays cost a Yjs value per number:
  a 6,000-stroke pen board took 47 MiB of the server's yrs heap and 79 to 85 MiB in a
  tab's Y.Doc (the document alone, its heap and ArrayBuffers, not the tab), now 28 and
  35 MiB. Its state goes from +15% (whole points at exactly 100%) to about −40% (any
  zoom a fit or pinch gives); Float32-exact points at exactly 100%, as Chrome gives
  them, come to about −15 to −25%, and pen pressure is always Float32-exact
  (`bench/collaboration/reports/2026-11-24-binary-pen-points.md`). The model's `points`
  reads the bytes and is set as drawn (`number[][]`), and `serialize` gives them back
  as drawn, for copies and pastes. The board's rules require a stroke's points and
  take only bytes that hold the header, whole points and finite values; anything else,
  the number arrays included, is a misfit (a placeholder on a canvas, a refused
  question's board). A peer's later write to an element's keys is read the same way:
  an element it leaves unreadable becomes a placeholder then and there (local change
  79's `_readAgain`), so a stroke overwritten with number arrays can't stop the canvas.
- **One thing held at a time** (local change 47, Epo 2026-11-12): every toolbar piece
  (shape pieces, Graphs, Formulas, Misc tiles) goes through BlockSuite's shared
  `EdgelessDraggableElementController`. Taking a piece puts down whatever else was held
  (another carried piece or a picked shape or note), and taking a tool puts a carried
  piece down. While a piece is carried a mask covers the board, so a press that returns
  it to the toolbar is passed on to what lies under the pointer: one click both puts the
  piece back and works the button or picks up the next piece.
- **Plane cards** (`boardPlane.ts`) are a `plane` canvas element holding a view (top left
  corner in plane units, board pixels per unit) and its marks, drawn by the graph engine
  (`drawGraph` in `src/features/graph/draw.ts`, the one renderer every graph shares,
  Epo 2026-11-16) with a clip, so a card stacks with strokes and reaches the marking
  image with no special case. Its marks are the graph model's elements
  (`src/features/graph/model.ts`, D1/D16): a `point`, a `polyline` (a line; with
  `arrow`, a two-point vector), a `curve` with optional `handles`, an `ellipse`
  (`center`, `radii`), a `text` label with `size`, a `formula` and an `expression`
  (`boardData.ts` `PlaneElement`). They are stored in the card's `elements` field, a
  `Y.Map` of element id to `{ element, order }` (an order key, `src/lib/orderKey.ts`),
  as BlockSuite's mind map keeps its nodes (`propsToY` turns a pasted card's plain
  entries into the map, `@observe` hears changes and tells the renderer and an open
  editor to draw again; D10): reading sorts by order key, a tie by id, cached on the
  model (`elementList`) until the map changes; writing (`writeList`, `writeElements` in
  `src/features/graph/keyed.ts`, the one writer quiz and note graphs use too) sets or
  deletes only the entries that changed, keeping every held order key that can stay
  (`risingOrders`), so two
  people drawing on one plane would merge mark by mark once the canvas has a room. A
  plane takes at most 100 elements from its tools, as every graph, its labels up to 60
  characters and a curve up to 100 points, where its tool finishes it (the question
  bounds `QUESTION_GRAPH_*`, D7); the load check takes up to twice the 100 elements
  (`mergedCap` in `boardRules.ts`, Epo 2026-11-22, "sure A"), as two people's adds at
  the same moment merge a plane past its cap, and runs the graph model's one element check
  (`graphElementSchema`, the same as quiz and note graphs and Go and Rust) on each
  element of a kind the plane makes (`PLANE_KINDS`); a board saved with the old
  `marks` list fails it (no production data, no shim). A card is a picture on the canvas: Select moves it, the frame's knob
  turns it about its middle (`rotate`, Epo 2026-11-13; turned, the side across from a
  dragged handle stays put on the page), its corners resize
  it, between 120 by 80 and 4000 px, showing more or less of the plane at the same scale,
  scrolling over it moves the canvas, and the eraser leaves it alone (`erasable` false,
  which the vendored eraser reads: local change 30), while a connector meets its edge
  at four anchors as on a shape. A fresh board starts
  with one. Double click, double tap or the pen opens it. A card starts at **Custom size**, the
  size it is placed at, which nothing changes but a corner drag (Epo 2026-11-18); the size
  never decides what of the plane shows: each time the plane is left, the plane in it is
  framed round its marks, the size kept, as a graph figure's window is (`fitView` over
  `fitWindow`), starting from the card's home window (origin near its bottom left at
  30 px a unit, `PLANE_HOME_PPU`), never from where the editor was left, so the frame
  comes from what is drawn alone; functions count over the home window's x range;
  nothing to frame keeps the editor's view (Epo 2026-11-18). **Fit to
  size**, turned on from its toolbar:
  each time the plane is left, a card with marks takes their size at the plane's scale plus
  40 px (a label's or formula's text counted in pixels round its point; not the origin,
  Epo 2026-11-18, as other apps fit to what is drawn), its top left
  staying put; past 1600 px it zooms out instead (`fitMarks`, shared with a quiz or note
  graph's dialog, Epo 2026-11-18). Functions count as sampled (`functionReach`, an
  asymptote's spikes left out) and only within the y range the card showed, or whole when
  never within it (y = 3x + 10000), so the card moves to it. Dragging a corner
  makes it Custom size, as resizing a note does. Neither is in the undo history. Pen
  strokes over a card stay where they are, so they can stop lining up. A **polar** card
  (`polar: true`, its origin in the middle) draws rings at the grid's steps, numbered along
  0°, and spokes every 15° (darker every 30°, the axes every 90°) labelled where they
  leave the card; its marks are stored as on any plane, and its editor snaps them to where
  a ring crosses a spoke.
- **Editing a plane** (Epo 2026-11-17: one graph editor for the canvas, notes and
  quizzes): the plane opens in `GraphEditor` (`src/features/questions/GraphEditor.tsx`),
  the editor quiz and note graphs use. `boardPlaneEditor.ts` gives it the card as a
  `FigureBinding` (`planeBinding`: one undo step per task, `boardEditorSession`'s
  `write`) and a root over the board; the page that mounted the board renders the
  editor there (`openPlane` in `mountDrawingBoard`'s options, `usePlaneEditor` in
  `PlaneEditorHost.tsx`, on the workspace and account Canvas pages, the answer board
  and the dev board). `boardEditorSession` (`boardEditorShell.ts`) keeps the board's
  side: undo reaches only the editor's steps while it is open, the board's menu and
  slot keys step aside, and closing (Done, an Escape nothing else took, the page)
  writes the camera outside the history and, for a fitting card, `fitCard`. It
  opens over the whole board. At its top right sit the same ☰ menu (Fit to screen where the card
  has one, Undo, Redo, Clear all, and − and + where it zooms; the board's menu hides
  meanwhile)
  and Done on its own (Epo 2026-11-08). A plane's Fit to screen shows at least 10
  units across and up, so an empty plane shows a stretch of grid round the origin
  (Epo 2026-11-13). Done leaves, as does Escape when no mark is open (Escape closes
  an open menu first, then a selection). Inside, the wheel or two fingers pan, Ctrl or
  pinch zooms about the pointer (the engine's `attachGestures`, within `PLANE_ZOOM`,
  10⁻⁶ to 10⁶ px a unit), a middle-button drag pans, and Select drags, as on the board.
  The tools are every graph editor's (Epo 2026-11-16, D12): `graphTools` in
  `src/features/graph/tools.ts` (no React, no BlockSuite) holds their state machines,
  hit-testing (`distanceTo` and `movedGroup` in `marks.ts`, constructions included),
  handles, selection and overlay, and writes whole element lists through the editor's
  rows. The strip floats over the plane's foot with Finish above it.
  Point names each point it places (Epo 2026-11-17, `freePointName`): the first of
  A … Z, then A_1 … Z_1, A_2 …, that no point in the graph has (a peer's included),
  so a row such as `segment(A, B)` can use it; the name draws beside the point.
  A point's dot picks up with any tool but Erase (Epo 2026-11-08, option C): it rings
  blue under the mouse, a drag moves it to the grid with the coordinate chip, and a tap
  still does the tool's job at that point (Line starts from it). Select also drags a
  whole line or curve (snapped by grid steps) or a label (wherever it's dragged, as it's
  placed where it's clicked, Epo 2026-11-13), and a single point takes the
  whole point, so dragging one of several selected dots, or a selected line's stroke,
  moves them all; a line's or curve's own point stays its own to drag, selected or not
  (Epo 2026-11-13). The moved copies are only drawn until the pointer lifts, so a
  drag is one undo step. Select works as the board's does (Epo 2026-11-09): a click
  selects a mark (blue, its points showing), Shift-click adds or takes one away, and a
  drag on empty paper draws a selection box that picks every mark it touches (Shift
  adds them); a click on empty paper, Escape or another tool lets go, and Delete or
  Backspace removes all that's selected.
  Where points coincide, the last drawn moves.
  Label (Epo 2026-11-08) types text centred where it's clicked, a `text` element at that
  coordinate that moves and zooms with the plane (a click near one edits it; up to 24
  characters, wrapping at 200 px as every graph's labels do; previews leave labels
  out); after one, the tool goes back to
  Select. With Select, a double click on empty paper types a label there and one on a
  label edits it, as on the canvas; while one is typed, the canvas label's maths symbol
  row (`symbolButtons` in `boardFormula.ts`) sits under it, kept inside the plane, and
  inserts at the caret within the label's 60 characters (Epo 2026-11-13). A plane label is
  still its own kind: a `text` element drawn on the plane, not BlockSuite's canvas text.
  A label or formula picked alone with Select wears the board's selection frame
  (`src/features/graph/overlay.ts`: a 1px accent line 6 px out, a 9 px square on each corner) and
  no toolbar; dragging a corner sizes its text about its middle (Epo 2026-11-13),
  stored as `size` in pixels (8 to 96, `QUESTION_GRAPH_TEXT_SIZE_MIN`/`MAX`, which
  the board catalog's `TEXT_SIZE_MIN`/`MAX` repeat for pie labels;
  without it 15 px for a label, 18 px for a formula, 12 px for a pie label). Formula (Epo 2026-11-08) opens the board's formula card (`openFormulaCard`) for
  a `formula` mark centred where it's clicked (a click on one opens it again, emptied it
  goes); KaTeX's layout (`boardFormulaDraw.ts`, loaded only once a formula is on the
  board or a plane) is replayed at 18 px, inverted on dark paper, keeping its size as
  the plane zooms. Select drags it whole; Erase takes it. Previews leave formulas out, as
  they can't lay them out (Epo: none rather than broken); the marking image has them.
  Vector (Epo 2026-11-08) is a line of two clicks with an arrowhead (12 px, kept as
  the plane zooms) at its second point, a two-point `polyline` with `arrow`; its line stops
  halfway into the head, on the card and the preview alike, so the line's round end
  doesn't show past the point (Epo 2026-11-13). Each tool's
  button shows AFFiNE's tooltip with its key, and the open card takes those keys: V
  Select, P Point, L Line, A Vector, C Curve, O Ellipse, T Label, F Formula, E Erase (a
  chart: V Select, D its bars or slices, F Fill, T Label, E Erase); the row fits a 360 px
  phone, its buttons 32 px wide on a board under 380 px and 36 px from there. Erase (Epo
  2026-11-09) works as the board's eraser does: the pointer is a ring as wide as its
  reach (16 px, `--capy-eraser-cursor`, also on the board's own eraser), it takes what
  is within the ring's radius (`ERASER_SIZE / 2`, in planes and charts alike), a press leaves
  BlockSuite's fading grey trail (`EraserTrail` in `boardEraser.ts`), everything it
  passes over hides, and lifting removes them in one undo step. Ellipse (Epo 2026-11-08, square
  planes only): a press and drag sizes a circle from its middle (the chip shows `r`), a
  click places one a grid step round. It's an `ellipse` element (`center`, `radii`)
  held by four handles (right, top, left, bottom: `ellipseHandles`); pulling one sets
  the width or height about the middle, so it
  stays upright and on the grid, and Shift scales it evenly. Select drags it whole, its
  middle (any other mark's first point) landing on the grid, where a ring crosses a
  spoke on a polar plane (`snapPlane`), as points do. Curves draw as cubic Bézier pieces
  (`curveSegments`): their Catmull-Rom curve (`curvePieces`) until a handle is moved, then
  their stored handles; ellipses draw as canvas ellipses, smooth at any zoom; the sampled
  path (`pathOf`) is for hit tests and previews. A line's,
  curve's or ellipse's points show only in the editor, on the mark under the pointer,
  held or still open (Epo 2026-11-08); a single point always shows, on cards, previews
  and the marking image too. A curve clicked back onto its first point closes, smooth there,
  and ends. Point, Line and Curve snap to the
  fine squares for the current zoom, so the
  plane has no edge and no fixed scale (the numbers are the question editor's, `tickStep`
  and `axisNumber` in `src/features/graph/view.ts`; the plane draws through the engine,
  its editor adding only what it shows on top: the picked mark's blue halo
  (`strokeElement`), the points of the mark under the pointer, held or open, handles,
  frames and chips). Numbers keep to the edge their axis left by (Epo 2026-11-18) and
  marks keep their thickness. The view stops 1e9 units from the origin, and a grid too
  fine to draw goes blank. Each click is written at once, one undo step, and undo
  shortens a line or curve still taking clicks. While a plane or chart is open, undo and
  redo reach only what was done in it, since the canvas is out of sight: the stacks are
  set aside on opening and put back on leaving. A press lands where it lifts, so a finger
  can line it up against the coordinate chip. The view is written on leaving and isn't in
  the undo history.
- **Ending a mark:** Finish (shown while a line or curve is open), Escape, or clicking
  a curve's last point again. The tool then goes back to Select, as AFFiNE's shape and
  connector tools go back to Select; Point stays on. Leaving keeps a curve with two points
  or more and removes a mark that has only its first. Canvas drawings over a card aren't in it: they stay in place
  if the view moves.
- **Bending a curve** (Epo 2026-11-13, K1 and K2, both boards): a curve may store
  `handles`, an [in, out] pair of plane points per point; with none it keeps the
  automatic bend, so saved curves draw as before. Select on a curve's point picks it and
  shows its two handles (a blue line to a 9 px square each). Dragging one bends the
  pieces on either side; on a smooth point the other handle turns to stay in line at
  its own length, and Alt drags one alone, leaving a corner. A double click on a point
  makes it a corner (both handles on it) or smooth again. With one curve selected,
  dragging its stroke away from any point pulls that stretch through the pointer
  (`bent`: the two inner handles move by their share of the drag, `t` held to 0.1–0.9),
  the points either side staying smooth; a ring shows where a press would bend. A
  closed curve's seam is one point with the last point's in-handle and the first's
  out-handle (`pairOf`). Moving a point carries its handles; moving the curve moves
  them all. `fitCard` counts handles.
- **Functions and the objects list** (Epo 2026-11-13, L2, workspace canvases only): a
  formula row is an `expression` element holding its LaTeX as typed (Epo 2026-11-18;
  a restriction `\left\lbrace a\le x\le b\right\rbrace` inside it), read with
  `readExpression` in `graphSyntax.ts` (read as Desmos reads it, as every graph surface; a command
  such as `line(x)` is refused). A function of x is drawn across whatever is shown by
  `functionRuns` (`src/features/graph/curves.ts`): a sample every 2 px, at most 4000,
  breaking where the value isn't finite or jumps (a leap past the canvas height whose
  middle isn't between, as at tan's asymptote; a steep line keeps drawing). Any other
  equation in x and y is an implicit curve drawn by `equationRuns` (marching squares,
  [question-bank.md](../question-bank.md)). It can't be dragged; its row edits it, and
  `fitCard` ignores it. The list button (☰-styled, `drawing_board_objects`) sits
  at the editor's top left: a 300 px card floating below it, open by default from 640 px
  (`listChoice` remembers a toggle for the session), and under 640 px a sheet over the
  lower 48% with the tools and Finish riding above it; its "+ Label" is a ghost button
  (no border, the hover fill marks it). The answer board's plane has no list. Rows are
  the graph editor's rows (Epo 2026-11-16,
  D12: `graphSyntax.ts`'s one parser, `buildElements`, `reconcileRows` and
  `rowsAfterEdit`, no second syntax), laid out compact (36 px, 14 px text, 15 px
  formulas; kind icon as the field's label, ⋮ with style, Hide and Delete). Every row the dialog takes (a function with its
  restriction, an equation in x and y, a named point `A=(1,2)`, `segment(A, B)`, `line`, `circle`, `angle`, `arc`,
  `sector`, `polygon`) is a MathLive field (loaded when the list first opens; the row that
  takes focus as it opens takes it once MathLive is in only if the person pressed nothing
  meanwhile, so the More menu opened first stays open, `GraphRowField`) that draws
  as it's typed and writes on Enter or leaving, one undo step; emptied it goes. A point a
  tool places is a named `A = (a, b)` row; a line's or vector's `(a, b) to (c, d)` and a
  label's text are typed in place and written on change; curves, ellipses and formulas
  are shaped on the plane, so their rows show only the kind's name (Epo 2026-11-13). The
  empty last row (`data-new`, drawn by the same template as the row it becomes so its
  field keeps focus) adds a row. A row that can't be read shows the dialog's warning
  icon with its reason and keeps its text, unwritten, until it can; Escape puts it back
  as it was. Moving a named point drags what's built on it; erasing it (Erase, Delete)
  takes what's built on it too, while deleting its row in the list leaves those rows
  with their issue, as in the dialog. At 100 rows (`ELEMENTS_MAX`) or more (`graphFull`
  in `questions/graph.ts`) the list shows no new row, "+ Label" is disabled and a
  tool's new mark is turned away, the issue line above the editor then reading
  `question_ui_graph_elements_max` while the plane stays full. Every add is checked
  against the plane as it reads when written (`graphWriter`): a row started under the
  cap whose last place a co-editor's add took meanwhile is not written, its icon
  carrying that message and its text kept, and goes in on its own once a delete makes
  room; one still refused when the editor closes is dropped with its text, with no
  prompt. So only adds written
  on two tabs at the same moment, before either holds the other's, merge a plane past
  100; it then draws every element on its card, and in the editor every row, the
  101st on, edits and saves as any with no cap issue on it (Epo 2026-11-22: the cap
  stops only adding), as on a quiz or note graph, whose readers and validators also
  take up to 200 ("Yes, A everywhere"). "+ Label" adds a label in
  the middle of what's in view and selects its text. Hovering a row lights its mark,
  focusing a label row selects only its label (Shift/⌘/Ctrl adds it), focusing any other row
  clears the selection; selected marks light their rows. The answer board has no list button and no
  functions. The shell lets a `math-field` keep its keys.
- **Chart cards** (`boardChart.ts`, `boardChartEditor.ts`) are a `chart` canvas element of
  kind `bar` or `pie`, holding plain data, since a coordinate means nothing on either:
  `axisMax`, `axisStep`, `kind`, `rotate` and `xywh` as plain fields, and `bars`
  (`ChartBar`: `id`, `label`, `value`, `fill`), `labels` (pie labels) and `spokes` (pie
  lines: `id`, `angle`, and `fill`, the fill of the slice that starts at the line,
  clockwise) each a `Y.Map` of id to `{ element, order }`, as the plane keeps its elements
  (Epo 2026-11-22, "Yes, fix it"): `propsToY` turns a new or pasted card's plain entries
  into the maps, an `@observe` per list tells the renderer and an open editor to draw
  again on a change inside it (a peer's too), reads are cached per list (`barList`,
  `labelList`, `spokeList`), and `write` sets lists and the axis in one transaction, one
  undo step, each list through `writeElements`. Changes to different bars, labels or lines
  merge; two changes to the same item at once keep one; two people adding at once keep
  both. The editor builds every write from the lists as they read then, and a gesture
  follows its bar, line or label by id, so a peer's add, removal or turn mid-drag lands
  nowhere wrong; the bar being drawn in the free place after the last has the id `''`
  until it is written. An add checks the cap against the list as it reads when written
  (`appended` in `boardChart.ts`), so a bar a peer added mid-drag counts and the add
  does nothing at the cap or past it; two adds merged from the very same moment can
  still pass it, and the load check takes each list up to twice its cap for that (Epo
  2026-11-22, "sure A"): a chart merged past the cap opens and edits as any, the editor
  giving each bar its place and no free one (`barSlots`, `setsBar` in `boardData.ts`).
  Closing a label's text field writes nothing unless the
  text differs from what the field opened with, so closing an untouched field keeps a
  peer's rename; a changed text goes onto the bar or pie label as it reads then
  (`typedBars`, `typedLabels`), so a peer's move or resize stays and a label a peer
  erased stays erased; only a new pie label takes the place where the field opened. A
  pie's first line has one id on every pie (`FIRST_SPOKE`), which a new pie,
  Clear all and "+ Slice" on a pie with no line all use, so two Clear alls at once, or
  one crossing a peer's turn or fill of that line, leave one line. The load check (`boardRules.ts`) takes each map as it takes a
  plane's: every key its item's id, at most twice `BARS_MAX`, `LABELS_MAX` and
  `SPOKES_MAX` items (48, 120 and 120, `mergedCap`), finite values and angles, and a line's `fill` a board colour. They
  move, turn and resize like a plane card, the eraser leaves them alone, and their editor fills
  the board on the same shell. Bar chart: numbers on the value axis only, up to a top and
  step the student types (Fit, in the menu, takes the top to the first line above the
  tallest bar, and typing a bar past the top lifts it the same way; neither passes
  `AXIS_MAX` or 100 lines, falling back to a rounder step, `axisAbove` in `boardChart.ts`,
  since the board's rules draw a chart past its limits as a placeholder). The wheel or a pinch zooms the value axis: its top moves, the step
  following in 1, 2, 2.5 or 5 for about five lines, bars staying on 0; the zoom is
  written as one undo step once it rests 300 ms. Hovering shows where a press would set the bar, a dashed line with its
  value, as the plane shows where a point would go. Dragging in a place sets its bar, in half steps, with the value in the chip; a free place
  after the last bar starts the next, up to 24, in the current fill. Labels are typed under
  the bars. Pie chart: no grid or axes, starting with a line at 12 o'clock. A click adds a
  line, whose chip shows the sector it closes, from the line before it clockwise;
  Finish slicing (shown once there's a line) moves to Fill, where a click gives the slice
  under it the picked fill (the `fill` of the line the slice starts at; erasing that
  line drops it, No fill clears it). A label goes where it's clicked, kept as an angle and
  a share of the radius (`reach`), so it stays put as the card resizes. Select
  (Epo 2026-11-09) selects bars, pie lines and pie labels as the plane does (a click,
  Shift-click, a selection box; Delete removes them all, Escape lets go) and drags the
  one pressed: a bar up or down to its value, a line round to a new
  angle (off the other lines, its fill going with it), a label anywhere on the card, in
  the pie or out of it (Epo 2026-11-13; it only went round before). A pie label picked
  alone wears the board's selection frame, and dragging a corner sizes it (`size`, as a
  plane label's). One of several
  chosen items takes the others of its kind along: bars up or down by as much (none
  below 0; a bar the drag takes to 0 goes, judged against the values before it
  (`liftedBars`), so one typed as 0 in the data pane stays, held along or not),
  lines round by as far, labels by as far across. After
  one label the tool goes back to Select, as on the plane.
- **A chart's data pane** (Epo 2026-11-13, B1 and P1, workspace canvases only): the
  plane list's button, card and phone sheet (`.capy-plane-list`, its own session
  choice), the chart drawn beside the card or above the sheet (`pads`), and the typed
  axis right of the button (dropping to the second row under 460 px). A bar's row is
  its fill swatch, label and value; a value past the axis's top raises the top to the
  next numbered line (or a fresh axis past 100 lines), and "+ Bar" adds one a step
  tall with the caret in its label. A pie's row per slice (`slicesOf` in `boardData.ts`,
  clockwise from each line, the row going by that line's id) is its swatch, name and
  share in % with its degrees: the name is the
  first label inside the pie within the slice (typing one adds it at the slice's middle,
  reach 0.62; emptied it goes), and a share typed moves the slice's closing line in
  whole degrees, the slices after it keeping their sizes and the last taking up the
  rest (the last slice's own share moves its opening line), with fills following their
  line and labels inside keeping their place in their slice. Labels outside the pie
  (or a slice's second) are rows of their own. "+ Slice" halves the last slice (or puts
  the first line at 12 o'clock); ⋮ Delete removes a bar or label, or a slice's opening
  line, joining it to the one before. A swatch opens the fill row (Bars or Fill) and
  the next fill picked goes to that bar or slice. Hovering a row lights its bar, slice
  or label; Escape puts a row being typed back as it was.
- **See-through cards:** plane and chart paper (`PAPER`) and note fills are half
  see-through so the panel's frost over the page frame shows. An open editor uses the
  same paper with no ground of its own and hides the board's `editor-host` under it
  (`data-editor-open`). The marking image draws plane and chart paper opaque, as
  previews do (`cardPaper`, opaque while `asImage` draws), so a stroke under a card
  stays covered; note fills stay half see-through on its white.
- **Marking image (`toImage()`):** everything on the canvas as it stands, including each
  card with the view it was left at, so a plotted mark panned out of view isn't in it. It's
  drawn layer by layer at a scale capped to 1,568 px on its longest side (the size the
  marking model reads, Epo 2026-11-06; 42-47% smaller than drawing at 2,400 px and
  shrinking later), so it stacks as the screen does and
  fits a phone's canvas limit; AFFiNE's own export draws every note under every stroke at
  the device's scale. Notes are drawn by html2canvas-pro (local change 72): html2canvas
  1.4.1 threw on the `color(srgb …)` Chrome computes for a note's `color-mix()` fill. A
  note scrolled out of view is shown for the capture: BlockSuite
  hides it with no size, which html2canvas drew as nothing and the capture threw on. A quiz's board (`question`) draws exactly its answer area, cut at
  its edge (Epo 2026-11-23, which removed the far-group pass); a workspace canvas is
  framed where everything is (Epo 2026-11-18). The PNG goes through `fitImageOffThread` (WebP, 300 KB cap, Epo 2026-11-06), whose
  encode runs in a worker while the drawing stays on the page, and
  comes back as a `File`. `outside()` says whether anything but the question's parts
  lies wholly or partly outside the answer area, for Done's question in the answer flow
  and on the teacher's canvas (the 2,000-unit span check is gone).
- **What the answer flow mounts:** `mountDrawingBoard(host, { readOnly, saved,
  onChange })`. An answer starts on a plain board (Epo 2026-11-06 dropped
  per-question backgrounds), or on a copy of its drawn canvas's question board (Epo
  2026-11-23); the dev pages pass `plane: true` for a plane card to play
  with.
  - `answerArea: { label }` draws a dashed 1,920 × 1,200 box at the board's origin with
    the label in a black chip on its top left corner (Epo 2026-11-07, W3/W4), on the
    layer under the strokes, the same size on screen at every zoom, and fits the first
    view to it and what's drawn. Its frame is only on screen: the image and previews
    are cut to it without drawing it, `save()` leaves it out, and a read-only board draws
    none. `movable` (the teacher's question board) lets its label or edge move it, its
    top left kept as the page block's `prop:area`; a Canvas part's student board is a copy
    of the question's (`question: {board, tip}`), its parts locked (`lockedBySelf`) and
    showing `tip` when hovered or pressed.
  - `fitPadding` ([top, right, bottom, left] pixels) is the room the first fit leaves
    for what the page lays over the board, such as a pinned question card or a top bar;
    without it the fit leaves room for the board's own toolbar and undo. The first view is
    never above 100% (Epo 2026-11-13): a small drawing, one note, fitted to the
    screen opened at 212%, its 14.8 px text at 31 px; it now opens at 100%, centred.
  - `readOnly` is a teacher's view: BlockSuite's read-only store (pan tool), no toolbars,
    undo, symbol row or selection, and nothing opens for editing, so MathLive never
    loads.
  - `save()` returns `{ doc, bytes }`: the board copied into a fresh Yjs document, so no
    undo history (200 undo steps on a card were 606 KB live and a few KB saved). Stroke
    points are rounded to whole pixels and every place (`xywh`) to a tenth, with no
    visible change (pressure stays: perfect-freehand draws the line from it);
    highlighter strokes from the pen menu are rounded the same way. A place's text gets
    shorter; a stroke's Float32s keep their size but gzip to 40% as the bucket keeps
    them (2026-11-24, before binary points the rounding left 60% of the raw bytes). The
    answer flow refuses past `DRAWING_BOARD_MAX` on Done (400 KiB since
    2026-11-23, Epo's 250 KB before).
  - `saved` is checked before anything mounts (`boardLoad.ts`, by the board's rules in
    `boardRules.ts`, below), as BlockSuite's store
    skips a block it doesn't know and takes any tree on load: one page and one canvas,
    only the blocks and elements the **board catalog** lists for that board (the pen
    menu's highlighter included, which the preview draws as a see-through stroke), each
    block under a parent it may have in one tree, and each card's fields within
    the limits its editor keeps (marks, bars, labels, spokes, axis values, formula
    length), with a place (`[x,y,w,h]`) on everything but a connector and a group, whose
    places BlockSuite works out (from the ends, each an element id or a finite point; from
    the children) and never stores. Anything else throws a `BoardLoadError` with a
    `reason` on a question's board. A canvas is not opened from `saved`: it mounts on
    its room's document and draws what does not fit as a placeholder (The canvas's
    room, below).
  - **One toolbar, Misc per board** (Epo 2026-11-10, superseding the question board's own
    Charts slot of 2026-11-09): both boards have Graphs, Formulas (GIF & Sticker on the
    workspace canvas) and **Misc** after the shapes (`sheetTools`). Misc shows each board
    what it may hold (`tileFits`, by the board `markBoard` names at mount): an answer
    board the Bar and Pie chart and Image tiles, the workspace canvas also the mind map,
    the formulas, YouTube and web links and the workspace's quizzes and sets (emoji are the GIF &
    Sticker picker's third tab since 2026-11-13). Misc's button opens a panel above the toolbar
    (`capy-misc-panel`, right-aligned, Shapes' look): one 360 × 440 frame in every view
    (Epo 2026-11-09, round 2, mock DVxJzY5A3XiYHKuqQPezST), with Back, the title or
    KLIPY's search, and a close in its header and the body scrolling inside, so
    switching views moves nothing; the home view is tiles in groups, each picked up and
    dropped like a slot's piece (a finger's tap puts it in the view's middle); the panel
    closes once something is down. Every tile fills its grid column, 60 px tall with
    its art fitted in a 40 × 30 box centred over its name and groups 8 px apart, so
    every group shows without scrolling (Epo 2026-11-13, C1, mock
    YahmqxViPqKKRbPjqJmkW5), inside 16px of panel padding (Epo 2026-11-12: the
    picture tiles were buttons left at the popper's 36px). A panel opened from the
    toolbar (`openPopper`) keeps its clicks, keys (Escape aside), clipboard and wheel
    from the board under it, and lifts the toolbar over a selected element's own bar
    while open; a focused field in it keeps focus as the pointer moves (local change
    40), so the link field can be typed in. Its groups:
    - **Diagrams:** Bar chart, Pie chart and **Mind map**, AFFiNE's own (`mindmap`
      element, its topics and ideas shapes it lays out), registered on the workspace
      canvas only and without its own toolbar button (`MindmapWithoutTool`); it
      starts as a topic and three ideas.
    - **Formulas** (workspace canvas): the Formulas slot's four pieces as tiles, the
      art fitted to the tile's 40 × 36 box.
    - **Media:** **Image** picks files from the device. **Link** is below.
    - **The GIF & Sticker picker** (the slot's, workspace canvas only; Epo 2026-11-13):
      GIFs, Stickers and Emoji tabs, opening on the one used last. **Emoji** is a grid
      of 48 Noto Animated Emoji (Google, CC BY 4.0, credited on the Credits page),
      shipped in `public/emoji/noto` as 96 px animated WebP (about 5 MB together) with
      64 px stills for the grid, placed at 96 px; its tab has no search, the header
      shows the slot's name. **GIFs** and **Stickers** are KLIPY's (`boardKlipy.ts` `klipyMedia(kind, …)`, the same API under `/gifs`
      and `/stickers`, `VITE_KLIPY_KEY`): from the student's browser with an anonymous
      per-browser `customer_id`, the `high` content filter, results in KLIPY's order and
      none removed but one off its `*.klipy.com` hosts (its terms), "Search KLIPY" as
      the placeholder in every language (KLIPY's required attribution) and "Powered by
      KLIPY" under them. GIFs sit in two columns, each whole at the shape KLIPY gives
      and into the shorter column (Epo 2026-11-13, G1, mock LZvdppJpsKTgyeXzEz7VnR, as
      Discord's picker: a fixed 16:10 cut 19 of the first 24 trending by more than a
      tenth), keyed by id so a later page leaves earlier cells in place; each shows
      KLIPY's `blur_preview` (an inline JPEG under 1 KB) until its file has loaded (L2).
      Stickers stay plain squares, each whole (S1), with no background, as on the
      canvas. While a search loads, a shimmer stands in, in mixed shapes for GIFs and
      squares for stickers, 8 px apart (the cells set `height: auto`, since the popper
      styles make every button 36 px tall). KLIPY pages by 24 (`has_next`): scrolling
      within 240 px of the end loads the next page onto the grid. Placing one sends
      KLIPY's share event (`klipyShared`, `POST /{kind}/share/{slug}` with the
      `customer_id` and the search, empty from trending), which nothing waits on; no
      `locale` is sent. A mouse picks one up to carry (Epo 2026-11-12; an emoji too): it
      follows the pointer at the size it lands at (240 px on its longer side, a sticker
      160, an emoji 96,
      letterboxed in its cell's box) and lands centred where the board is clicked; a
      finger's tap or a key puts it in the view's middle, so a finger still scrolls
      the grid. A GIF without KLIPY's size takes its cell's picture's; one whose link
      passes the stored limit says it can't be placed;
      the placed GIF stays KLIPY's link, as its terms ask. Without a key the view
      says search is off; an uploaded GIF is an ordinary image.
    - **YouTube** (Epo 2026-11-13, the Link tile renamed, with YouTube's play mark;
      Y2 taken as recommended) takes a YouTube link or any web address: a video shows
      its poster (`i.ytimg.com`) with a play mark, anything else its host and
      address; a double click opens it in a new tab. A placed one's toolbar has
      **Edit link** (E1, `editLinkAction` and `capy-link-edit`): a field in
      BlockSuite's toolbar menu with the address selected; Save points the card at
      the new address where it stands, as wide as it was, 16:9 for a video and a web
      card's height for a web link, in one undo step. The form stops its clicks,
      since BlockSuite's menu closes on any click outside its button. Adding and
      editing share `readLink`.
    - **From the workspace:** **Quiz** and **Flashcards** show the workspace's own as a
      two-column grid of thumbnails from each material's stored preview (the title,
      the first question's stem, the question count; a set's first card front on a
      stacked pair, the title and its card count), with no edge or question-type pill
      on a tile, only the hover's fill, and a dashed New tile (Epo 2026-11-13), from
      the Files list (`useOwnedMaterials`, which
      carries previews; `useCanvasMaterials` reads it and `useCanvasLinks` lends it
      through `workspace` in the mount options), with a filter field from six items. A **New** tile comes first: the page
      creates the quiz or set unfiled in the workspace, named as the Create page names
      one (`nextGenerateTitle`), places its card and opens it. A click places a card
      that runs it (440 × 500 for a quiz, 400 × 340 for a set, `MATERIAL_CARD_SIZE`):
      the card is the note embed's own runner, answered and checked on the canvas
      (below). A double click on its header opens the material in the workspace for
      editing, and a card whose material the workspace no longer lists shows "can't be
      opened" and no runner. `useCanvasMaterials` reads every page of the list before
      lending it (`fetchNextPage` while `hasNextPage`); until then the list is
      `undefined`, the grid shows the New tile alone and a placed card's body loads
      rather than reading as gone.
    - **Quizzes and flashcards** on the Canvas page (Epo 2026-11-13, mock
      DnhMYffHEjdxiUansbBDde A + W1, the group named N1 by default): the same two
      tiles over every quiz and set the person can open (`GET /api/materials` with
      `scope=member` and no workspace; items they lost access to are left out),
      latest edited first in one grid. Each tile has its workspace's icon and name
      under the count, and nothing for one in no workspace; the filter also matches
      the workspace's name. New makes a quiz or set in no workspace (`POST
      /api/quizzes`, `POST /api/flashcards` without `workspaceId`) named Quiz 1,
      Quiz 2… (Flashcards 1…, the first number no listed title has), places its card
      and opens it. With no workspace page to open one in, New and a double click on
      a card's header open `CanvasMaterialDialog`: the shared `SimpleDialog` (a
      full-screen page on a phone) holding the note embed's editor
      (`AppEmbedEdit`), whose questions open `QuestionDialog`; closing it reads the
      material again for the cards (`WorkspaceLinks.account` switches the label,
      the workspace line and the empty text).
    Emoji and GIFs are `affine:embed-capy-picture` blocks (an `<img>` that plays by
    itself), links `affine:embed-capy-link` and quiz or set cards
    `affine:embed-capy-material` (`boardPicture.ts`, `boardCards.ts`): the surface
    takes `affine:embed-*` children, so no vendored change.
  - **A placed quiz or set runs on the canvas** (Epo 2026-11-09): the card's body is
    the note embed's `AppEmbedView` (`AppEmbed.tsx`), the same runner a note's embedded
    quiz or set uses, with no `ownerId` (a workspace's own material has no owning note
    to wait for), so a question is answered and Checked by direct clicks and a set is
    studied in place; nothing is recorded, as in a note. The card renders from the
    fetched snapshot and never joins the material's live room (`live` off on the embed,
    Epo 2026-11-09: editing happens in the dialog, and many cards would mean many
    connections against the 22-channel cap); it refetches the snapshot when the card
    comes back into view (`useRefreshOnEnter`, from the second entry: the observer's
    first call is the mount's own) and when the window regains focus (the hook's own
    `focus` listener, since the app's queries never refetch on focus), and
    `WorkspaceCanvas` invalidates the quiz and material queries of the material the
    item dialog showed when the dialog closes (the dialog's saves go through its live
    room, not the snapshot query). **Edit on the card** (Epo 2026-11-12; on the
    toolbar since 2026-11-13): a person who can edit the material
    (`capabilities.canEditContent` from `useMaterial`, read once the card is near)
    gets Edit on the card's floating toolbar (`a.edit-card`), not in its body. The
    page tells the board which cards those are and the board's toolbar names the card
    being edited, both through `materialCardHosts.ts` (`setCardEditable`,
    `setCardEditing`, `onCardState`); the board sets a selected card's selection again
    when that changes, so its toolbar follows. Edit swaps the body for
    the note embed's editor (`AppEmbedEdit`: per-question Edit and Remove for a quiz,
    per-card Edit and Add card for a set) on its live rooms; Done (lit, where Edit
    was) swaps back and
    invalidates the material's quiz and material queries so every card redraws. One
    card edits at a time (`CanvasMaterialCards`): with no note seat to join inside,
    each edited card takes its own places among the user's 22 joined documents. The
    editor gets no `onEmpty`, so it behaves as the item's own page: a quiz may lose
    its last question, a set keeps its last card. A card stops editing on Done,
    another card's Edit or leaving the board, and each of those reads its material
    again. Edit shows on `canEditContent`, so an owner at their storage limit gets
    none. While a card is edited the board's Undo and Redo (the ☰ menu, ⌘Z and ⇧⌘Z
    or Ctrl+Y on the board, not in a field) act on its quiz's or set's own history,
    not the canvas's, as the plane's editor takes them while open (Epo 2026-11-13):
    the editor lends its `UndoTarget` through `UndoSink` (`useLendUndo`, in
    `collaboration/undo.ts`) to `lendCardUndo`, and `cardUndo()` reads it; a
    question's dialog keeps its own. A card is placed 440 by 500 screen pixels for a quiz and 400 by 340 for a
    set (Epo 2026-11-13), and a set's card face takes the height its card has, under
    the count and above Previous and Next (`fill` on `AppEmbedView`, `StudyBody` and
    `CardStack`), where a note's set sizes it from the window; a quiz scrolls in its
    card. The block is a BlockSuite block
    like any other but hosts React: it adopts one `div` per card from the host registry
    (`src/features/canvas/materialCardHosts.ts` — kept out of `src/features/blocksuite`,
    which the app's tsconfig excludes), and `CanvasMaterialCards.tsx`, rendered by
    `WorkspaceCanvas`, portals the runner into it, so the page's providers are the
    runner's own. The registry hands a re-created block the element it had (released
    hosts are parked for the rest of the tick), so an answer in progress survives
    BlockSuite re-rendering the view. Blocks are light DOM upstream
    (`ShadowlessElement`), so the app's stylesheet reaches the runner; the card's own
    chrome (the header row with icon, title and kind, the hairline and the panel
    background) stays in the block's markup. The header is what moves and selects the
    card; the body swallows `pointerdown`, `pointerup`, `click`, `dblclick`, `wheel`,
    `keydown`, `keyup`, `beforeinput` (Android's Backspace hotkey) and `cut`, `copy`,
    `paste` (BlockSuite's clipboard handlers on the document would cut or copy the
    selected card instead of the field's text) so BlockSuite neither selects nor drags
    nor pans nor takes the keys from inside the quiz (React's own listeners sit on the
    host element, a portal container, so they still run); a swallowed `pointerdown` is
    re-dispatched on the document so the app's menus and popovers still close on a
    press inside a card; and the first click inside needs no selection first. Under any tool but Select the body takes no pointer events
    (`.capy-board:not([data-tool="default"]) .capy-card-body`), so a stroke draws over
    the card. A card out of view (`useNearScreen`) draws the material's stored preview
    through `ThumbnailPanel` instead of the runner; the previews come from the paged
    materials list, since the workspace's own materials read carries none.
  - **Board catalog** (Epo 2026-11-09): `server/internal/boardcatalog` lists every
    canvas element and block a board may hold, which board takes each (`question`, a
    drawing answer's board; `workspace`, the workspace canvas) and the limits above.
    `pnpm gen:openapi` writes it to `src/api/board.generated.ts` (`BOARD_CATALOG`);
    `TestGeneratedFileIsCurrent` fails when it's stale. `mountDrawingBoard`,
    `checkSavedBoard` and `drawBoardPreview` take the board, and the limits in
    `boardData.ts` come from it, as does the picture emoji list (`emoji`, read by
    `boardPictureData.ts`). Its `props` give a block flavour a prop on some boards
    only, its value checked by the board's rules (`BOARD_PROPS`): the page block's
    `area` on a question board, the answer area's top left (`boardArea.ts`, Canvas
    parts, Epo 2026-11-23). The server keeps a saved board as opaque bytes and
    checks no canvas room's content (below), so the browser is the only reader.
  - **The board's rules** (2026-11-22): `src/features/blocksuite/boardRules.ts`, read by
    the load check, the live board's placeholders, the preview and `keepToCatalog`. A
    corpus test (`boardRules.corpus.test.ts`) builds what every tool, editor and paste
    writes through BlockSuite's own model code and holds it fitting, and one broken case
    per rule not. An element or block is
    read from its own Y.Map's entries, never `toJSON()`, so a string where a Y.Text
    belongs is told apart: keys are strict per element type and block flavour (only
    the fields BlockSuite or the card stores), each value of its kind (colours, places,
    finite numbers, BlockSuite's enums, points, connector ends, label styles, a note's
    nested `edgeless` and colour maps; a colour with both `dark` and `light` holds strings
    in both), required fields present (a place on everything that stores one, a shape's
    `shapeType`, a connector's ends and mode, a group's children and title, a mind map's
    children, style and layout, a text element's text, a note's `edgeless.style`, each
    card's own), a block prop holding `undefined` only where BlockSuite's default is
    `undefined` (loading fills only absent props), text
    as string runs with plain-valued formats (no embeds or nested types; a reference or
    footnote format is an object), keyed lists up to twice their caps, ids of
    `[A-Za-z0-9_-]{1,128}` and never `__proto__` (nor a `__proto__` key inside a plain
    value; a run of overwritten values at one key is read by its last). The tree and a
    mind map's nodes are checked as before (the load check's tree, `mindmapNodesFit`).
    What breaks the rules is drawn as "This block cannot be shown" and never removed
    unless it is the tab's own add (Epo 2026-11-18); the canvas room checks none of it
    (Epo 2026-11-22, "maybe drop the cnvas content check if its not that useful").
  - **Holding to the catalog after load** (Epo 2026-11-09): the load check runs
    once, so a mounted board also drops what its catalog leaves out whatever adds it
    (a paste, a duplicate, later a peer): `keepToCatalog` in `boardKeep.ts` deletes
    such an element or block right after it lands, and any element the board's rules
    and the mind map's node check would refuse (`storedElementFits`), so a mind map copied from the
    workspace canvas and pasted into an answer goes with its node shapes, as does a capy
    embed. A saved mind map's nodes are checked too (`mindmapNodesFit`): each a shape on
    the canvas no other mind map or group holds, under a parent among its own nodes,
    one root, no cycle. A person's copy, paste or Duplicate never carries a placeholder:
    a clipboard middleware drops `capy:unknown` and `capy:unknown-card` blocks from what a
    copy exports and a paste or Duplicate imports (`placeholdersLeftOut` in
    `boardUnknown.ts`), and BlockSuite's canvas copy and clone leave out placeholder
    elements, stand-in cards and groups left empty (vendor local change 74), a group
    keeping only the children copied with it. Emoji, GIFs and cards copy, paste and duplicate on
    the workspace canvas through a clipboard config each (`boardClipboard.ts`), which
    re-adds only a block the load check would take (`embedFits`, the same check), since
    any page can write the clipboard. Their renderers check again what they use: a link
    opens only as http(s), an emoji shows only from the list, a GIF only from https
    `*.klipy.com` (`KLIPY_MEDIA_SOURCE`, which the image policy allows too), rotation as a number.
  - **The canvas's room (Epo 2026-11-18, superseding the saved board asset of
    2026-11-09):** a canvas is a standalone material of kind `canvas`, owned and paid
    for by the person who made it, any number per member per workspace (Epo
    2026-11-12, migration 0171), linked to its workspace by `canvas_workspace_id`
    and never cloned. Its board is the Yjs
    document of a collaboration room, one room per canvas whether it is private or
    shared, named `material:<materialId>:schema:<n>` like a note's (`MaterialRoom`),
    with no `keys` document and no parent. The collaboration server runs it as a note
    room with its own model, `Model::Board`, beside `Model::Note` and `Model::Item`
    (`model.rs`). Who holds a canvas, the tokens by role and what revokes them are in
    [authorization](../authorization-permissions-lifecycles.md#workspace-canvases); the
    charge and the cap's number in
    [storage](../backend-storage-quota.md#canvases).
    - **Opening.** `useCanvasBoard` (both pages mount it) reads the canvas
      (`GET /api/canvases/{id}`, for its image assets and whose it is) and joins the
      room through `useItemRoom`, the room client every live item uses, with an
      awareness of its own. The board mounts once the room has synced under its
      adopted client id, on the room's document itself (`mountDrawingBoard` with
      `room: { doc }`, `roomStore.ts`: the room's document is BlockSuite's root and
      space document and its `blocks` map the store's, so nothing but block edits
      reaches the room). Every change goes to the room as it is made and nothing is
      saved from the page; unsent edits are kept on this device as any live item's
      are. The `drawingDrafts` copies of canvases and the save loop are gone; a
      quiz's drawing answer and sample keep the in-memory board. Undo is BlockSuite's
      own manager following the document's client id (`followClientId`), so it
      reaches a person's own edits only, and a canvas has no previous versions (Epo
      2026-11-18, "no prev version").
    - **The view it opens at (Epo 2026-11-19, Q32, Q34, Q35).** A canvas opens where
      its person last left it on this device (zoom and centre), and only a first open
      on the device fits everything. `canvasViews.ts` keeps the view per canvas id in
      one localPrefs record (`capy.canvas.views`, the latest 100 canvases, Q34),
      written as the board unmounts and when the page is hidden (another tab, a
      reload, the tab closed, where no unmount runs); `useCanvasBoard` passes it as
      the board's `kept`, which the board takes only while something on it lies
      inside that view on this screen, else it fits (Q35: a peer may have moved or
      removed what was there); a board mounted again on the same canvas in the same
      tab takes its `view` as it was. The record carries its account, as the Make a quiz runs do
      (`claimAccountData`): another account's views, or anyone's once signed out, are
      dropped. Only the two canvas pages keep one; the answer board and
      `/dev/drawing` fit at every open. BlockSuite's own stored viewport is off
      (vendor local change 73): it was keyed `board` on every board, so each board
      opened at the last one's view.
    - **The first state.** Every canvas starts from the same bytes: one `affine:page`
      block with id `page` holding one `affine:surface` block with id `surface`, written
      under Yjs client id 1, which no user is assigned, so two first openers hold one
      state and no tab can write under it. The editor's own code makes them
      (`boardFirstState.ts`), a Vitest pins them byte for byte to
      `collaboration-rs/crates/server/fixtures/board-first-state.bin` (237 bytes), and
      the collaboration server seeds a canvas with that file at its first open
      (`Model::Board.state_from_value`); Go writes no Yjs row when it creates one. A
      tab never makes those blocks: a synced room without exactly one page holding one
      canvas is "couldn't open" with Retry (`holdsBoard`).
    - **Protocol 31.** Canvas rooms raised `CLIENT_PROTOCOL` and `MIN_MATERIAL` from
      30 to 31 ([the gate](#client-protocol-and-the-release-nudge)). The build's
      contract adds a rule the code does not hold: from here a change to the board
      catalog (`server/internal/boardcatalog`) raises both together.
    - **What the room admits.** A board has no rule on what its content is (Epo
      2026-11-18, "reject nothing"; a content check built 2026-11-22 was dropped the
      same day, Epo: "maybe drop the cnvas content check if its not that useful"):
      admission bounds what an update may cost, never its shape. After the checks every material room makes (the 4 MiB sync message,
      the token, the client-id rule, the marker root), `admit_board` takes an update
      that:
      - the room can place (`ydoc::inspect_bounded`): no struct or deleted range
        ends past clock 2^30 (`ydoc::MAX_CLOCK`, a ceiling for every room since this
        build: two 11-byte GC structs wrapped a client's clock in a release build and
        left a stored document that no longer loaded; note, flashcard and source
        rooms took the same input and refuse it now);
      - nests no type more than 64 deep below the root (`BOARD_DEPTH`; the editor's
        deepest is 5). yrs deletes nested types by recursion, and a chain of 8,000
        maps with one deletion of its top overflowed a worker's 2 MiB stack, which
        aborts the process;
      - stays within one work budget of `ydoc::MAX_WORK` (1,000,000) steps that
        counts what yrs's own count misses: the content copied and walked at every
        split of an item, conflict scans, the walk from each new struct to its root
        and the items a deletion removes without naming them. The slowest update a
        board admits by those costs held the room 48 to 66 ms on an M1 in a release
        build (the builder's measurements, 2026-11-18); an update's own size is not
        counted (100,000 map entries took 144 ms there).
        Only a board counts splits; the other rooms inspect as before;
      - writes only the `blocks` root (`BOARD_ROOT`) besides the room's own
        contributor markers;
      - puts each new item it names a parent for under a type, never under other
        content (a value, a contributor marker, a value of the same update): yrs
        fails to integrate such an item where Yjs collects it, so a board storing
        one would never replay again (no fold, trial or projection). No editor
        writes one. An item under a unit the stored base holds deleted is taken and
        collected; one under a value deleted since the base is refused, since a
        replay applies the base and its rows in one transaction, where that value
        keeps its content. A block or other type deleted since the base is still
        a parent, as it is in that replay: a stale tab's key set in a deleted
        block is taken (`Board::read`, `Board::parent_type`);
      - keeps the state within `CANVAS_BOARD_MAX`, 4 MiB (Epo 2026-11-18), the largest
        sync message the server takes (`NOTE_MAX_SYNC_BYTES`). The validator keeps an
        upper bound of the state's bytes; while the bound plus the most the update
        can add fits, the update enters unmeasured, and near the cap, or when it
        deletes a type's content without naming it, the state is measured exactly
        without and with the update, which enters when the state with it fits the cap
        or is no larger than before. So the cap is never passed, deletions that split
        items count like growth, a full board can always be thinned, and a person who
        cleared part of a full board draws again at once. An update that tells the
        room nothing new (a joiner's step 2) is not sized.

      A refusal closes that writer's channel alone. One for size reaches the tab as
      `document-rejected` with `document_size_exceeded` and
      `limits.maxContentBytes` the cap. A store never refuses a board for size, and a
      board has no repairs, sessions, held deletions, collection, late merge, index
      request or agent path: an agent inspect or edit, a replace-block command and the
      live read of a loaded board answer 409 `unsupported_operation`, unreported
      (`CANVAS_REFUSED`); the live read of a board this process has not loaded answers
      none, as for any room it does not hold. Known and left open, here as in every
      room: named deletions written out of order hold a room about 1.7 to 3.4 s per
      MB (the second Rust review's probe), and note, item and source rooms are still exposed to the split stall and the
      depth abort a board now refuses (follow-ups for Epo, the second Rust review).
    - **Unknown content is kept (Epo 2026-11-18, "reject nothing, dont just delete
      stuff without user acknowledgement", mock A, Artifact FFzLp8Zwcen678YfTEn88s).**
      Nothing a peer or the stored state brought is refused or removed for its shape,
      on the server or in the browser. What a tab cannot read (a block or canvas
      element of a kind this build does not know, or a known one that fails the
      board's checks) stays in the document as it is and is drawn as a placeholder: a
      dashed outline with "This block cannot be shown", the words a note's unknown
      block uses (`material_unsupported_block`). A canvas element's placeholder is
      BlockSuite's own inert model (vendor local change 62: an unknown element type no
      longer throws at load or on a remote add); a block's is `capy:unknown` in a
      note's text or `capy:unknown-card` with a place of its own (`boardUnknown.ts`,
      drawn by `boardUnknownView.ts`). Neither declares props, so reading one writes
      nothing, and a selected placeholder has no toolbar. Content is judged as it
      arrives; a later change to it waits for a reload. A person's own add that the
      catalog does not take (a paste, a duplicate) is still removed at once
      (`keepToCatalog` in `boardKeep.ts` acts only on this tab's own action, never on
      an undo, a peer's update or the loaded state). A question's board still refuses
      a saved board that does not check out.
    - **Projection.** The server reads one thing from a board: the editor assets its
      blocks name, each block map's string `prop:sourceId` of 1 to 64 characters of
      `[A-Za-z0-9_-]`, whatever the block's flavour (so an image block of a newer
      editor keeps its asset), each id once, in byte order. The room sends Go the
      canvas's whole document, one `canvas_board` block with the constant id `board`,
      `version` the stored version projected and `images: [{ assetId }]`. Go writes
      the block through `ProjectMaterialContent`, and its asset pruner keeps the
      images named and trashes the canvas's others. Each projection reads, in its
      snapshot, Go's projected version and the images Go's stored block names
      (Epo 2026-11-26). It sends at once when its images differ from Go's: right
      after a store whose update writes one of the canvas's assets as the room's
      last projection read them (before one has read them, any string shaped like
      an asset id; `names_asset`, `project_soon`), so an image added, pasted,
      brought back by Undo or given another asset, whose asset Go had trashed, is
      served again within seconds, and right after a fold commits. Every struct
      counts, not only one keyed `prop:sourceId`: an overwrite of a key carries
      its origin and no key. The idle projection (30 s after edits stop), the
      cadence (every 5 minutes while they go on), an on-demand one, the unload and
      the pending scan also send whenever Go's projected version lags the stored
      one, images changed or not, as every projection did before, so Go
      recomputes the canvas's charge (the board's stored bytes) as often as it
      did and the pending scan does not find the board again. A store alone, or a
      fold, never sends unchanged images: strokes and typing write no asset's id,
      so they ask for no projection at a store, and reach Go only at the idle
      projection, the cadence or the unload. An asset made since the room's last
      read is named by the next projection that runs (the idle one at the
      latest); none prunes it before, as each reads the assets anew.
    - **The projection rides on the fold (Epo 2026-11-26).** Every board fold already
      replays the board into a whole document under the board work permit
      (`note_store::fold`); it runs `Model::projection` on that document and stores the
      result beside the new base, in `material_yjs_documents.base_projection` (migration
      0196), in the fold's transaction, at the version of the last row it folded. A
      canvas's seed is stored with its projection at version 1, which names no image.
      Every board projection (idle, cadence, on demand, the early one above, after a
      fold, the unload's after its fold, the pending scan) is the projection between
      folds (`model::board_projection_since`, `projection::project_durable`): the stored
      `base_projection` with its `images` joined by every string in the rows since that
      passes the asset id check, kept to the canvas's own editor assets, each once in
      byte order, at the stored version. It reads the version, `base_projection`, the
      rows, Go's projected version and stored images, and the canvas's assets (every
      `editor_assets` row of the material, pending or ready, in the hidden trash or
      not; a purged one is gone; one query on `editor_assets_material_idx`) in one
      snapshot, never the base, takes no permit and builds no document. It is
      complete: an image live now was live at the fold, so its list names it, or was
      written since, so a row holds its id; Yjs never brings a deleted item back
      (Undo, a paste and a copy write new structs). Keeping to the canvas's assets
      drops only ids that are no asset of this canvas, and Go prunes this canvas's
      assets alone. It gives up exactness: an image deleted since the last fold stays
      named, and its asset charged, until the projection after the next fold (at
      256 KiB or 1,000 rows of log, and at every unload). That one reads the exact
      list once the fold committed: the room projects again when its fold commits,
      at a version projected already too, and the unload projects after its fold.
      Go takes a canvas's projection at the version it projected already when the
      block differs (a note's or quiz's it skips). The order holds because a
      material's durable projections run one at a time in the process
      (`projection::Slots`: the read and the send together, the room's, the
      unload's and the pending scan's alike), each reading after the last one's
      answer: a superset read before a fold committed is sent before the exact list
      read after it. A base stored before 0196 (`base_projection` null) projects by
      the full replay under the permit, kept to the canvas's assets the same way,
      until its next fold writes the column. On a board of 3.2 MB with a 256 KiB tail
      of 712 rows, the replay peaked at 11.2 MiB of heap beside the base and rows it
      read, in 82 ms, and the projection between folds at 19 KiB, in 2.4 ms (debug
      build, `board.rs` test allocator).
    - **Full JSON later.** Boards are expected to need a full JSON projection, as notes
      have, for AI support. It would plug in at the fold, the one place a board's
      document becomes content: the fold computes it from the document it builds anyway
      and stores it with the base as it stores `base_projection` now. Between folds only
      `images` and `version` move, so nothing about storage or the projection flow
      changes; a caller that needs the board's JSON current asks for a fold, or a
      one-off replay, when it needs it.
    - **Presence (Epo 2026-11-18, "just the same presence events like others").** A
      board's state is a note's event with board fields (`Fields::Board` in
      `presence.rs`, `boardPresence.ts`): `p` the pointer as `[x, y]` in whole board
      units, each within 1,000,000,000 either side of the origin, or null once it left
      the board; `b` the selected elements' and blocks' ids, at most 16 of at most 64
      UTF-16 units each; `s` and `f` a text caret's anchor and focus as base64 Yjs
      relative positions of at most 64 characters (`f` absent when collapsed);
      `uploads` a note's upload list, the ids of the images the tab is uploading,
      at most 100 of at most 32 UTF-16 units each, from a write channel only (a
      read channel's state naming it, a frozen or full payer's creator included,
      is dropped whole), so peers can show each as uploading. No name or colour:
      receivers name and colour a peer from the room's
      presence. Any other key, type or bound drops the whole state, silently, on the
      server and in the receiver (`readBoardPresence`), one vector list checking both.
      BlockSuite's own awareness (its `selectionV2`) stays on the page and never
      reaches the room. It is sent at most every 50 ms and only on a change; a caret is
      sent as soon as it is placed, and the pointer goes null as a card's editor
      opens over it. Whoever may edit the canvas sends and hears it,
      also while their own board is read-only for a time (a frozen account, a full
      payer); a workspace viewer sends nothing and the room tells a viewer nothing, as
      in a note. The page sends by the caller's `role` in the canvas's read
      (`sendsPresence` in `canvasRights.ts`): an owner or editor sends, a narrowed
      one on another member's canvas included, as the room relays any channel but a
      viewer's (`on_awareness`); a viewer does not, and before the read answers
      nothing is sent. `BoardPresenceMarks` draws the others with the marks a note uses
      (`PresenceMarks.tsx`, shared with `RemoteCursors.tsx`): a pointer that glides
      120 ms in board units and follows pan and zoom, one named outline around what a
      person selected, a caret and tinted range inside a note's text, and for text
      in a shape or on a connector the outline alone. Nothing shows with the
      "Show others' cursors" switch off. The presence marks have no mock yet (one
      outline around a multi-selection, carets without a name flag, and no avatar
      group on a canvas are as built, to be shown to Epo).
    - **What a person sees.** While the room joins, the pane's loader
      (`CanvasOpening`), which says after 5 s that an open slowed by the user's open
      budget is slowed (`editor_open_slowed`, `FileLoading`). A member's device keeps
      a copy of what the room confirmed (`deviceCopy.ts`, the `keep` label from the
      canvas's read, `seed` at the next open): the board shows it at once, offline
      too, with its tools when the copy says the person could edit. Such a board
      takes edits before the join (Epo 2026-11-19, Q27 b1, Q31, as a note does;
      `early` in `itemRoom.ts`). Once the room's token has answered (a slow join,
      or 30 s unreachable with the API up) the document takes the id the token
      offers before its first edit (`adopt`): an id assigned to this user that no
      session bound yet, so the JOIN binds it as any session's (Q236,
      `ClientIds::holds`) and nothing is renamed; what follows a rename (below)
      follows this change of id too, as it does the id a JOIN's token offers
      (`adoptClientId`), so a label editor open meanwhile keeps its Undo. With no token yet (offline at
      open) the edits go under the tab's own id, which no room assigned, kept as
      `late` draft rows naming it (`client`; the removals-only gate reading the
      copy's size, under the offline bound of cap less size less 64 KiB). At the
      join they become the room's in place, before the board's provider connects
      (Epo 2026-11-19, Q38, "Yes, rename in place"; `rename` in `itemRoom.ts`,
      `renameClient.ts`): every struct the board's one live document holds under
      a temporary id (its own, and those earlier tabs' late rows name, one after
      another so the new id's clocks run on from 0) becomes the same struct
      under the id the token offers. What follows it (`onRenamed`): every Item's
      `origin`, `rightOrigin` and `redone`; `doc.clientID`; BlockSuite's Undo
      stack (`renameUndo`, from roomStore's `followClientId`); every text
      editor open on the board (`followTextEditors`): a label editor's own Undo
      (a text's, a shape's or connector's label, a frame's or group's title:
      `rich-text` keeps a manager of its own, tracking the id the document had
      as it opened, which now tracks the new one too) and each editor's kept
      caret (`renamePosition`); and the presence's caret, sent again
      (`boardPresence`). BlockSuite's own awareness (its selections, never sent)
      keeps the old id; the provider and its awareness take the new one at the
      first JOIN, as at any. Nothing remounts: the same DOM, view, selection and
      Undo, and Undo after the join takes back an offline stroke, in the room
      too. The rename is sound only when no conflict was ever settled by
      comparing a temporary id with another client (Yjs orders concurrent
      inserts, and picks a map key's value, by client id): every struct under
      the temporary ids comes after every other struct the document holds, and
      their sessions form one chain, each painting the whole of the one before.
      Each early row names what its session painted (`painted`: the temporary
      ids, oldest first, and the state vector). At the open the sessions are
      ordered by that, never by how rows are stored (`earlyChain`, review M1);
      one that edited beside something it never saw (two tabs early side by
      side, both closed before their joins; one that painted an older copy) is
      written anew under this tab's id by the late merge on top of everything
      else (`mergeEarly`: its worker loads only then; a key whose value it holds
      follows the key's value there, while a key whose value Yjs gave another
      keeps it, `followHeads`, review re-check R1; where two such writes would
      then settle by client id against Yjs's pick, the value's chain follows
      the other's, re-check 2 R3; a text's units land as typed, theirs first
      at a spot both typed at), its rows flagged refused first and deleted
      once this session's whole document landed, what the merge hides kept
      apart as below; assigned ids' structs are never written anew (review
      M2). When the merge's code does not load (offline with nothing cached)
      the board shows the copy, read-only, under "Couldn't sync your edits.
      Retry or reload the page.", and Retry, the browser's reconnect and the
      join (which waits) try again, a token that answered while the merge ran
      once at once; once it loads the same document fills in place, nothing
      remounting (`mergeLater`, review re-check R2). A token that says read
      meanwhile, or while the merge ran, ends the wait: the strip goes, and
      the read-only join has its 30 s (re-check 2 m5). A refusal (404, 403)
      before the board painted (the merge's code did not load, the merge
      failed, a group waits for copying) shows the stored rows for copying:
      the first group the room cannot take as a join's `restore` would, else
      the rows over the copy under the refused toast, their sessions held
      until the tab goes, the canvas then unavailable (`keepStored`,
      re-check 3 m6); a board that painted keeps what it painted for copying
      though nothing was drawn on it, and so does any room refused before its
      first sync, the rows `restore` applied (the refusal drops the device
      copy, so no later open could show them, re-check 4 m7). Otherwise a merge
      that fails once loaded leaves the board to wait for its join, which
      offers the rows for copying. Until the rename nothing else comes in: the
      provider connects only after it (`beforeJoin` waits for it and Retry goes
      through it, review M3). The rename is pinned to Yjs 13.6.31's internals
      (`renameClient.test.ts` fails on an upgrade that moves them) and goes
      only when the new id is not in the document, no temporary id is in the
      copy's history (nothing under it ever left the tab), nothing is pending
      and no client but this tab's own holds more than it painted
      (`renameRefusal`); else every early edit is kept in the copy-only
      recovery, nothing saying the room refused it. Near the cap (4 MiB in some
      4,000 strokes, 35,000 to 43,000 structs) the rename itself takes about 2
      ms, and with the renamed state's encode for the drafts the step takes
      about 50 ms (47 and 55 measured) on the main thread in Chromium
      (`canvas:rename`, measured by canvas-room-states.spec.ts); the board
      before the room's state, when it
      must be decoded, about 60 to 80 ms more. Since the same edits under two
      ids would go in twice, the early rows are flagged refused in place first
      (`flagCopyOnly`): a later open shows them copy-only and never applies them.
      A session under the new id records from there, its first row the renamed
      document whole (`renamed`), and the early recorder stops (`handOver`): its
      rows go once that write landed or a receipt covers it, and the room's
      state is in with what it hides stored (`replacedHolds`, review m4), or,
      when the room goes before its state came in (a refusal, a move, a leave),
      once the write it ends with did; a write that failed leaves them, so
      storage failing never deletes their only copy. Each recorder keeps its own `late` mark. A
      field both sides changed (a shape both people moved) takes Yjs's own
      pick, with no review step (Epo 2026-11-19, Q33, "Yes, one side wins").
      What would not show is decided per element and block (`boardHidden.ts`),
      in the same document: the board before the room's state came in (the
      renamed state and this tab's edits until then, decoded only when the
      room's state deleted something under the new id) against the board after.
      An early edit is hidden when something both held around it is deleted
      after. When that is an element or block the board no longer shows
      (another person deleted it), those alone are kept as one hidden refused
      row and shown in the copy-only recovery (`merged`, the `changed` strip)
      while the room runs on; anything else hidden (typing into a text another
      person replaced) offers the whole early board there. Discard (asking
      first) drops it and shows the room; Download saves it as an image. Until the hidden row is stored the
      early rows stay; if it cannot be, they stay as its copy. Flags that
      cannot be stored keep the edits as they are, the board read-only under
      the note's `late-unloaded` strip ("Couldn't sync your edits. Retry or
      reload the page."), and try again on Retry and on the browser's
      reconnect (Q295, Q398). A refusal (size or any other) or a token refused
      at the join (403/404) keep every early edit in the copy-only recovery with
      Reload asking first, the strokes still on screen, and only the room's
      refusals toast. A token that says read at the join (a demotion, a freeze)
      discards them as any read-only turn does (Epo 2026-09-29): a fresh room
      opens on what was saved, read-only. Each tab writes under its own id, so
      two tabs of one person drawing early both land; a tab leaves another live
      tab's late rows alone (`heldDraftSessions`; without Web Locks it may take
      them, as Q420 accepts for notes), and so does one whose earlier sessions'
      late rows another early tab painted: that tab holds their sessions' locks
      until its early recorder stops, or gives them back at once when it
      painted nothing (`claimLateRows`, review m1). A reload before the join paints the rows
      earlier sessions left: early ones are renamed with this session's at the
      join; ones of a session that held a room's id (it joined, or its token
      answered) go as at any open (Q326), accepted ones with the document and
      never-accepted ones through the draft send, which goes first (the rename
      waits for it; a board joining as it is waits for it at its JOIN,
      `beforeJoin`). The board's notes keep their own late merge. Rows to copy, or
      a viewer's copy, keep the board locked until the room has synced. The copy's label follows the canvas's read: a rename or a
      demotion is written with the next copy (`ItemRoom.keepAs`, `relabel`), so the
      next open paints with the current title and tools. A board's copy is at most
      its 4 MiB cap, against the 200 MiB the device's copies share. Under the mocks
      only the scenarios workspace's canvases (`mock-scenario-canvas-N`) keep a
      copy and drafts, as every MSW scenario fixture does. A room that refuses the person before anything
      showed (no role, a canvas gone) is the usual unavailable panel
      (`UnavailableItem`), never saying blocked rather than gone. A canvas read that
      fails with nothing to show offers Retry and, for an unexpected failure, its
      error id (Q612); a board whose mount throws says the canvas couldn't be opened,
      and both reach Sentry (`canvas-open`, `canvas-board`; an API failure is the
      server's to log). A canvas opened offline with no copy waits ("Waiting for
      connection") and opens by itself when the connection returns, also when its
      read, sent offline, fails only once the connection is back (error-handling
      "Asked offline, failed once back"); with the browser
      online and the service down, the loader stays and at 30 s from the join's start
      the strip reads "The live collaboration service is unavailable." with Retry
      (Epo 2026-11-04, D5, C9; `unreachable` and `retry` in `itemRoom.ts`). A
      workspace viewer of a shared canvas gets a board to pan and zoom with no
      toolbar (mounted without tools; it mounts once more, at the same view, if the
      person may then write), with no cue (D9). A frozen account opens under "This
      file is read-only now." and a full storage under the strip naming whose
      (`StorageFullBanner`: "Your storage is full." or "Owner of the file has
      insufficient storage."), picked as a note picks them from the canvas's read
      (`storageFull`, else an owner's or editor's `role` with `canEditContent` off).
      An editor's board stops and starts taking edits in place when its access
      changes (`setLocked`: the view, the history and the board stay). Turned
      read-only while open (a demotion, a freeze, a full payer), the room discards
      the unsaved edits and, when there were any, opens afresh on what was saved
      (Epo 2026-09-29; the `board` option of `itemRoom.ts`), under the read-only strip
      from then on, and the canvas is read again for why. A revoke while inside (the
      canvas taken back, the member removed) leaves the board as it was, read-only,
      under a strip reading "You no longer have access" (`CanvasBoardStrip`, the
      `access-lost` save strip; where it sits has no mock yet). The strip also
      carries offline, an outdated build with Reload, edits open for copying, and
      "Saving is delayed" (closeable) once an edit's receipt has waited 25 s of
      connected time, as a note's, or the room said a store failed with edits
      unsaved (`delayed`, `SaveDelayClock`). One strip shows at a time: recovery,
      access lost, what the device could not store, its offline bound or an
      outdated build, unreachable, plain offline, storage, read-only, delayed.
      An edit the room refuses for good, one taking the board past its cap
      included, is kept on this device as one refused row and opens read-only for
      copying, as any item's (Developer 2026-09-30; Epo 2026-11-18, nothing deleted
      without acknowledgement), under the recovery strip; its Discard asks first ("Discard
      these edits and reload?", the note's discard words), then drops them and
      opens the room afresh, and its Download saves the board as an image
      (`saveRecoveryFile`, Epo 2026-11-23). The 7-day toast's Download gives a board's edits as its
      blocks in JSON, named after the canvas (`draftFile`).
    - **Save status and size (Epo 2026-11-18, 1B and 2B, mocks `StatusB`,
      `StatusPhone`, `SizeB`, `SizeFull`).** The board's save status sits just left
      of its ☰ (`statusSlot`, `CanvasBoardStatus`): `LiveStatus` with its label, the
      icon alone on a phone as a note's phone header, a spinner while a copy shows
      before the room joins, its tooltip held open with the slowed line after 5 s.
      A viewer, who saves nothing, gets what a note's viewer gets (no save status):
      the offline icon alone (`OfflineStatus`) and no size row. The picker's row
      stops 8px short of the status and ☰ whatever the status says: the page reads
      their width as `--capy-board-chrome` (`useCanvasBoard`); a phone's picker
      fills the row (mock `StatusPhone`, 360 px included), a wider screen's shrinks
      into it. The status turns compact below 640 px, as a note's header.
      A tab that may write keeps the board's size (`size`, `subscribeSize`): its own
      measure, or the length of the device copy it opened from, plus the bytes of
      every update applied since, an upper bound since deletions only lower it.
      The measure (`measure`, every one of them: the first sync's, the idle ones,
      the checks and the offline stop's) is what a collected copy of the document
      holds (`collectedSize.ts`), not the encode's length: the board's undo
      history (BlockSuite's, a `Y.UndoManager`) keeps what its transactions
      deleted, so the encode still holds a cleared board (200 deleted 2 KB
      entries: 404 KB against 3.3 KB collected), while the room's state is
      collected. It is the encode less what collecting each deleted item that
      still holds its content would save (an item inside a deleted type becomes a
      GC struct, any other keeps its header with its content shrunk to its
      length), an upper bound since collected neighbours merge (1.6% over at half
      of a 2.9 MB board erased); the walk adds 25-35 ms to the encode's 40 at
      that size on an M1, and reads Yjs internals in that one file. An encode
      below where anything acts on the size (the lower of the menu's 75% line
      and the cap less the 64 KiB margin) stands with no walk, an upper bound
      too: most boards and most first syncs skip it. A device copy
      is that tab's encode, so a copy-opened board takes deletions as pending
      and its first check measures. A board with no copy is measured once as it
      first syncs, at once rather than when idle, so a full board takes only
      removals from its first edit. The room's own bound in each receipt
      (`metrics.contentBytes`: exact after a fold or a trial, otherwise that size
      plus the most each update since can add, as the room never encodes the board
      whole) never sets it, since it never comes down for a deletion between those
      measures and misses what was appended during its store. With deletions
      applied since the last measure (a transaction's delete set; a move
      overwrites a key, written once per drag at its end and once per arrow-key
      nudge; a long stroke rewrites its points every 20), the size is encoded again
      once the tab is idle at the next store's receipt while it is at or past the
      lower of the menu's 75% line (`BOARD_SIZE_SHOWN`) and the cap less the 64 KiB
      margin, and as it crosses the full line, so the next press finds it exact:
      moves cost one encode per store, never one each, however near a line. The
      crossing's encode comes once per stroke (a stroke's rewrites cross again
      after each measure) and is armed again by a receipt or a press on the
      board, so a press right after a long stroke near the line may still
      encode. Nothing acts on a size deletions may have left high: the page
      hands the board its size with its check and its note of presses
      (`setRoomSize(size, { check, pressed })`, kept per store in
      `boardFull.ts`), and whatever refuses an add (`refusesAdds`: a tool
      picked, a press on the board with a tool that adds, a paste, a drop, ⌘D, a
      formula, a piece, a link or quiz card, a double click on empty canvas) and
      the menu as it opens call the check first. A gesture writing several
      elements on a full board goes only when the size plus 16 B for each value
      it writes fits under the cap (`refusesWrites`, `BOARD_WRITE_BYTES`; Epo
      2026-11-25): Yjs keeps a stub for each value overwritten, its clock
      twice (in the new value's origin and in the deleted range), measured in
      the room's collected state (`collectedSize`) at 12 B an element on a
      fresh board, 14 B once its clocks passed 10^5 and 16 B past 2.1 × 10^6,
      and a value written for the first time adds its key (about 20 B, two
      values' worth: `NEW_KEY`). A value written longer than it was adds the
      difference besides (the guard's fourth review: BlockSuite's
      `Bound.serialize` writes 17 significant digits at any zoom but 1, so a
      drag at zoom 0.73 of shapes placed on whole numbers grew each by 40 B,
      its stub 14 of it), so each written value keeps room for the most it
      can grow, the longest its format allows less what it stores now
      (`Writes.grows`, `bytesOf`; one read a value, no encode; positions are
      never rounded): a box 105 characters (`[x,y,w,h]`, each number at most
      25 as JS writes it: a sign, `0.`, five zeros and 17 digits), a moved
      one its `x` and `y` alone, 25 each (one that may get shorter, a
      peer's longer numbers, by nothing: an arrow key sends each element's
      move as an update of its own; a drag sets `moveDelta`, the snap
      shifts its delta, an arrow key its `x` and `y`; a mind map's nodes,
      laid out after a drag, and a note, whose measured size may go with its
      move, keep the whole box's bound), a number 9
      bytes (a float64 in lib0's `writeAny`: a rotation's angle, a text
      label's font size, a plane's view corner, a note's scale and collapsed
      height), a connector's free end its two numbers and a label's place its
      four, a toolbar change's values their new bytes less their stored ones
      (`anyBytes`, known before the write: a colour turned themed), new
      indexes by how BlockSuite makes them (`Keys`; fractional-indexing's
      key is at most one character longer than the longer of its two
      neighbours, the board's longest L or one the write made; a key that
      may get shorter counts as nothing): to the front or back each past the
      last (its integer part plus one, its fraction dropped, so the longest
      integer part I plus 1 + ⌊log₆₂ n⌋ at most, whatever fractions the
      board's keys carry: after a long chain of steps a Bring to Front of 200
      keeps 3,210 B where the whole keys' L + i kept 26,534), an ungroup's
      bisected at once between two (`generateNKeysBetween`, L + ⌈log₂(n +
      1)⌉), forward or backward each between two, either one it made, L + i
      for the i-th (a chain does grow: 1,000 adjacent elements brought
      forward top first reach 170 characters, and 200 grew a board by 5,371 B
      where `end` keys keep 3,599). An ungroup inside another group writes
      each element's id into that group's children too, a new key each, in
      the same update (the emptied group goes in one of its own after; the
      room judges each update alone, so a count covers each, not their sum):
      a group of 50 between two others grew the board by 1,852 B in that
      first update, counted at 2,785. A mind map node's place in its tree (an
      index and its parent's id) is the map's one value, a few bytes within
      the Style count its nodes keep; joining another map's tree it is a new
      key there. A block's object value (a note's `edgeless` through its style panel) is
      its own map, written whole: a new item for each value and each object
      in it, an array a Y.Array with an item for each run of plain values
      (Yjs packs them in one) and each map or array in it with its own (the
      map it replaces is collected whole, so its old values cost nothing):
      20 notes' empty styles given four values grew the board by 2,960 B,
      counted at 3,680 (2,080 without the items), and an array of two
      numbers and 12 maps in each 6,884 B, counted at 11,920 (3,920 with
      the array as one item). A select-all
      move of 1,000 shapes placed on whole numbers (boxes of 18 characters,
      `[1234,567,100,100]`) keeps 59,000 B (16 B and 43 a shape; 16,000
      before, against the 41,000 or so it adds at zoom 0.73), under the 64
      KiB a full board has left at most; a Bring to Front of 1,000 elements
      on 3-character keys keeps about 18,000 B, a Bring Forward of them
      about 516,000 B, more than a full board ever has.
      Back-to-back overwrites of one value by one tab merge (1,000 drags of one
      shape add 35 B), but not where values alternate: several elements'
      writes interleave, and so do one element's when it writes two or more
      values (a connector's ends and label, a rotation's angle and place, a text
      label's box and font size). Those never merge and no board fold collects
      them, so a select-all drag of thousands of elements would pass the cap
      and send the tab to its copy-only recovery. The count (`writesOf`) takes
      every element the gesture reaches (what a selected group holds; every
      node of a mind map one of them is in, since a node dragged moves its
      whole map; the label of each labelled connector hanging on one, which the
      moving tab places, local change 63) and every value it writes on each
      (`valuesWritten`, at most: a connector 3, its free ends and label; a
      rotation 2; a resize 2 on a text label or a stroke and 3 on a note, its
      scale written the first time, or a plane, 4 on one that fitted (it
      stops fitting, `fit` written only then); the alignment menu's place 5
      on a note, its collapse and collapsed height written the first time, a
      note's Scale 3 and its height 2; a note one more, the size it shows
      stored first, local change 75; a mind map's Style 9 a node and its Layout
      2, measured on BlockSuite's own layout at 117 B and 18 B a node at most
      on a fresh board, 125 B and 20 B past 10^5, 133 B and 22 B past
      2.1 × 10^6; a mind map's node dragged alone, which may land in another
      branch and restyle, its whole map at the Style count; a group nothing of
      its own). A toolbar change counts each value
      it names on each element (`valuesUpdated`), a stroke's width its points
      and box too, and a labelled connector's mode its label placed again. The
      size as it stands is never
      below the board's, so a write it fits goes unmeasured (a held arrow key
      measures nothing); one that doesn't is measured first. Refused, it writes
      nothing and shows the removals-only line; one element's gesture always
      goes (its few values are written once, at its end), and a board under the
      line checks nothing. It covers a drag, resize or rotation of a selection
      (at the interactivity's `handleElementMove`, `handleElementResize` and
      `handleElementRotate`, where the moving set is known: a press outside the
      selection selects what is under it; BlockSuite's DefaultTool and
      selection frame get the board's one `InteractivityManager` from the
      std), an arrow key's nudge (stopped as the board captures it; a key typed
      into a field on the board, `TYPING`, is the field's), the element
      toolbar's changes (its `updateElement` calls on what the selection
      writes, decided whole for the task; the width slider picks a value once a
      drag, its press included, local change 84, so each width it picks is
      one change), its alignment menu, a reorder, a note's Scale and Auto or
      Customized height, a mind map's Style and Layout, and a Lock or an Unlock
      of several, which write models straight and ask before any
      (`boardWrites`, local change 82), and an arrange, a resize to one size
      and an ungroup (their commands, `gateCommands`; an ungroup, and an Unlock
      of a group, writes the index of each element the group holds directly,
      and counts those). A group (a lock of several makes one) and a mind map's
      node dragged off its map (which makes a new map; refused, the node stays
      in its map) are adds, refused as one; a node dropped into another map
      is asked once, at the drop, for both maps: the one it joins laid out
      again, the one it leaves restyled whole at worst (Style one colours by
      first-level branch), the moved nodes among them (refused, it stays in
      its map). The board wires all of it in one place (`boardGates.ts`
      `gateBoardWrites`). A gesture's values stay this tab's until it ends
      (BlockSuite's stash), a dragged connector's free ends and label (local
      change 80; a bound end stays stored, so a peer's re-attach mid-drag
      stands, and one a peer frees mid-drag is stashed at the next frame), a
      resized stroke's points (local change 81), the label of a
      connector hanging on an element in this tab's gesture (local change 83:
      the interactivity manager's `activeInteraction$` names the elements, kept
      in a set once a gesture, a mind map's root its whole map; written inside
      the change that ends the gesture, so Undo takes them back together, or
      released after it at the stored place, writing nothing, so a peer's
      place stored meanwhile stands; a 60-frame drag of a shape with two
      labelled connectors on it grew the board 2,607 B before, 46 B after) and an end dragged by its
      handle with its label (local change 85; a cancelled pointer ends it as
      a release does) included. Left out: one
      element's gesture of several values always goes, leaving a stub a value
      each time. With
      deletions since the last measure it encodes once and the exact size reaches
      the board before it returns (`subscribeSize` is synchronous), so a board
      that peers cleared takes an add with no receipt. A tab that may not write
      measures nothing. The board's menu ends with the size from 75% and, at the
      cap, "Only edits that remove content will be saved." The server is
      the judge of what removes content: an update whose state with it is no larger than without it (a
      deletion) is always admitted, and a growing one at the cap is refused and kept
      for copying as above. Offline, a board's work stops under the offline-limit
      strip at the space its cap leaves (within 64 KiB of the cap; Epo
      2026-11-18, client-limits A), so its backlog fits when it is back, or at 4
      MiB of unsent updates (its cap, not the note's 2 MiB), whichever comes
      first. An update that deletes nothing (a stroke, typing in a note, Undo of
      a removal, a card: the gate checks only some of these) stops it when it
      leaves the size past the line. One that deletes (a removal, a move, a
      replacement) never stops it for the line alone: whenever the size counted
      is past the cap (going offline with it there included), the board is
      measured, and stops only when the exact size is past the line and a repeat
      of that update could take it over the cap (exact size plus the update's
      bytes). A move's update is several times what it adds (a select-all move
      of thousands of elements sends more than the margin), so the line keeps a
      board with room left going. A move of one element barely grows the board
      (Yjs merges a key's consecutive overwrites: 1,000 drags add 35 B), but a
      selection moved together adds about 10 B per element per drag (1,000 drags
      of ten add 100 KB), so many moves of a large selection can fill a board,
      which stops at its cap; it encodes once per (cap − exact size) bytes of
      updates. With deletions since the last measure, either check encodes
      first, at once (offline, at those updates alone: an accepted cost,
      repeated often only when large selections keep moving within a few KB of
      the cap), so a board removals freed takes adds until one takes it back
      past the line. A single update larger than the room left
      still overshoots, as one large add always could.
    - **Opened from the Trash.** A canvas in its maker's Trash opens from the Trash's
      link on its own canvas page (the account's, or its workspace's with
      `view=canvas`): `useCanvasPicker` asks `GET /api/canvases/{id}` for a `c` the
      list does not hold once its pages ended, and one answering `trash` is shown
      read-only with no Rename, sharing or Delete. Its board is the stored state from
      `GET /api/canvases/{id}/board` (the editor's first state for one never opened),
      with no room, under the Trash strip with Restore (`TrashBanner`); Restore's
      refresh asks again, the list is read again, and the canvas opens live.
    - **The picker's sharing (Epo 2026-11-18, "B, a switch", mock Artifact
      F2dZxe8XvcW1FAiqMf81NA).** The canvas shown has a "Shared with members" row
      (`content_shared_with_members`, the file switch's words, Epo 2026-11-18) with the
      people icon and a switch between Rename and Delete in `CanvasSwitcher`,
      for its creator while an owner or editor of the workspace (`canvasRights`, the
      server enforcing the same; provisional, see authorization). The row is the
      control and stays open. Sharing asks first, as the file switch does (mock
      `ShareDialog`: "Share this canvas with members?", "Everyone in the workspace will
      see it. Editors can draw on it.", Cancel and "Share with members"); taking it
      back does not. The switch shows where it is going while
      `PATCH /api/canvases/{id}` is on its way, and a refusal is said by a toast. A
      canvas the person shared carries the people mark before its time, another
      member's shared canvas reads their name before the time ("Ben · 3d"), and a
      private one neither. Rename and Delete show for the creator alone. The Canvas
      tab lists the canvases the person drew in the workspace and the other members'
      shared ones; nothing announces a share or an unshare, so the list is read again
      each time the picker opens and after the person's own change. The first canvas
      is made, with the workspace's name, for a person with none to show, so a
      member whose list holds only another member's shared canvas opens that one
      (as built; put to Epo). The Canvas tab shows to members only, since a link or
      public visitor has no canvas.
  - **The Canvas page (Epo 2026-11-10, mock KNPB4pYUhSSYUJvuKN1ct7 B):** `/canvas`
    (`Canvas.tsx`, Canvas under Tools in the sidebar) is a board: one of the person's
    own canvases, in no workspace. Such a canvas is a standalone `canvas` material with
    no `canvas_workspace_id` (migration 0167), any number per person, opened in its
    room exactly as a workspace's is (`useCanvasBoard`, which both pages mount), with
    the same images and limits, and Misc's **Quizzes and flashcards** (above). It is its
    maker's alone and can never be shared. `?c=` names the canvas shown; without one (the sidebar's link) the one
    already shown stays, else the latest saved of the person's own, and a first one ("My
    canvas") is made for a person who has none. The id routes serve only a person's own
    canvases, a workspace's while they are a member of it, and another member's
    once it is shared with that workspace. A frozen account opens what it has
    read-only (its room token carries `read`) and is offered neither New canvas,
    Rename nor the sharing switch. The page and the Canvas tab share `useCanvasPicker` (the canvas shown,
    the first one made, New, Rename, the sharing switch and Delete). The panel at the top left
    (`CanvasSwitcher`) is the editor's popover (`ToolbarPopoverContent` and its 30px
    rows, as Plate's All blocks, Epo 2026-11-12) and
    lists every canvas there is (`GET /api/canvases`: their own, latest saved first,
    then each workspace's under its icon and name, leaving out a workspace whose owner's
    account is no longer live), a page of 50 at a time as the menu is scrolled (Epo
    2026-11-10: `cursor` and `nextCursor`, `canvasesQuery` is an infinite query ending
    in `ListEnd`; there is no cap on how many a person makes). The list scrolls in a box
    of its own, so New canvas, Rename, the sharing switch and Delete under it stay in reach. Their own come first so
    that a first page without one means they have none, and a canvas the URL names on a
    page not loaded yet has the pages load until it shows or they end. The panel makes
    a new one ("Untitled canvas", numbered when a loaded one has the name), and renames
    or deletes the one shown, as a standalone
    material (`PATCH /api/materials/{id}/metadata`, which leaves the revision alone, and
    the trash; the room's refusal of a canvas being deleted is no news to its board,
    `gone`). A
    workspace's canvas opens in its workspace (`?c=` with `view=canvas`), where its quiz
    and flashcard cards work; there the picker lists that workspace's canvases alone.
    The account chat's file listing leaves canvases out: a canvas is a board, not a
    document the agent reads. On a phone the navigation drawer's button sits beside the
    panel, and the row stops short of the board's own menu. The Files page lists no
    canvas (the rows of earlier that day are gone); a canvas's images still list there
    and open the canvas they are on, and Trash shows a deleted canvas with its icon
    and opens it read-only on its canvas page (above).
  - **Images (Epo 2026-11-09 and 2026-11-10, `todo-board-images.md`):** an image block
    keeps only an id (`sourceId`), and the board reads and stores files through its own
    blob source (`boardBlobs.ts`, `BoardBlobSource`, in place of BlockSuite's in-memory
    one), which the page feeds through the mount's `images` option (`boardImages.ts`).
    Every way an image arrives (a paste, a drop, a note's slash menu, Misc's Image tile,
    which opens the device's file picker for a phone with no paste or drop) goes
    through BlockSuite's `blobSync.set`, so the source is the one place that sees them.
    On a canvas (`assetImages` in `boardAsset.ts`) an image is stored at
    once as the canvas material's own `image` editor asset through `uploadEditorAsset`,
    as a note's is: compressed in the browser first (`fitImageOffThread`: WebP where the
    browser encodes it, JPEG or PNG where it doesn't, as Safari), capped at the
    uploader's plan image cap, refused when storage is full, billed to whoever
    uploaded it (the creator, or an editor of a shared canvas) and listed on their
    Files page. The image is stored before its block is added: BlockSuite waits for the
    source's `set` (a file pasted, picked or dropped) and for a copied block's paste
    (`BoardImageClipboard`), and the one way in where BlockSuite adds the block first, a
    file pasted into a note's text, waits for `set` on a canvas too
    (`storedImagePaste`). So a block is never in the room under an id no one can load,
    leaving mid-upload leaves no empty frame, and a refused image never lands (a
    toast says so). The block then takes the stored id and size outside the undo
    history. The board acts only on this tab's own image adds (`change.isLocal`): it
    never uploads for, rewrites or deletes a block another person added. An image
    already stored under its id is never stored again: a copy pasted back hands its
    file to `set` under that id, which the source leaves alone (`stored`).
    `GET /api/canvases/{id}` answers `ownImageAssetIds`, every ready image asset of the
    canvas, one the pruner trashed included. The room's projection says which images
    the board holds, so one taken off the board is trashed and one put back (an undo)
    is restored with no word from the page, and served again after the room's next
    store. A peer's image still going up, a deleted image or one the pruner trashed
    answers 404 to the reader and is asked for again by the next view of it. An image
    pasted from another canvas resolves as another material's and is stored again as
    this one's when the tab may write; a reader's board stores nothing. Opened again,
    an image loads from its asset's link (`assetLink`). Known and left open (the
    browser fix round's notes): an image uploaded and then abandoned by leaving stays
    an asset no block names, which the pruner's rule for it was not checked.
    On an **answer board** (`DrawingBoardScreen`) a picture is compressed as it lands
    (`shrink`: `fitImageOffThread` under `BOARD_IMAGE_MAX`, 1 MiB, from the board
    catalog) and refused with a toast past `BOARD_IMAGES_MAX` (10, counting the ones of
    the same drop still being compressed) or when no size fits; its block keeps
    BlockSuite's hash for good, and the file stays on the board. The device keeps each
    file once, beside the draft (`drawingPictures` in `localDb.ts`, by draft and id;
    `syncLocalDrawingPictures` adds the new ones and forgets the ones off the board),
    so a reload before Done loses none and a stroke rewrites no picture. Done checks the
    count again, asks the board for every file (`imageFiles`, fetching a stored
    drawing's not shown yet) and keeps them in the page's memory under the part's key
    (`holdDrawingPictures`); the value names them by that key (`pictures`), since files
    don't sit in an answer. An assignment's Done sends them in base64 with the board
    (`drawingUpload`, `pictures: [{ sourceId, data }]`) and then lets them go
    (`releaseDrawingPictures`): from there they are read from the stored drawing. A
    practice Check sends them the same way and keeps them for Check again. A check that
    keeps no drawing sends none: a shared page's, a quiz inside a note
    (`embedded`), a review session's and the bank's (those two now send a drawing as
    its board and image at all, where they sent the page's raw value). Sending a value
    whose pictures are no longer held throws rather than storing empty frames.
    `GET /api/drawings/{id}` answers a link per picture (`pictures`), from which a
    reopened answer and a teacher's read-only board load them (`fetchDrawingPicture`,
    which asks for the links again once when one has lapsed; a Done forgets the page's
    copy of its drawing). The marking image draws them as before, and list previews
    still draw a grey box. A drawn sample answer's board in the quiz editor takes no
    pictures (Epo 2026-11-10: the quiz would have to name them in the shared question
    format, which Go and the collaboration server both check): `DrawnSampleField` opens
    the board with `noPictures`, so its Misc has the charts and no Image tile
    (`BoardImages.none`, `markBoard`) and a pasted or dropped picture is refused and
    said ("A sample answer can't hold pictures."). An answer board's Misc has the same
    Image tile as the canvas's.
- **Preview (`boardPreview.ts`):** `drawBoardPreview(saved, { width, height }, board)` draws a
  saved board as an SVG string from its data, for lists, results and marking views
  (Epo 2026-11-06: what's on it, not every detail). It never loads the editor: it imports
  yjs and the small modules the check uses (`boardData.ts` holds the cards' stored shape,
  limits and chart geometry, `boardGeometry.ts` the framing, and the graph engine,
  `src/features/graph/`, for plane cards). Framed as the marking image is (everything, far
  groups drawn nearer on a quiz's board only, 8 px round, on white), stacked by index with a note over a stroke
  at the same index. Strokes are plain lines thinned to one point per preview pixel and
  never thinner than a pixel; shapes their outline, fill and text; connectors straight
  from end to end with their arrowheads; text and shape labels a line per line break;
  plane cards as the graph engine draws them on the light export paper (grid, axes with
  their numbers, marks; no labels or formulas), recorded by its SVG recorder
  (`SvgRecorder.nested`, ids prefixed per card) at no less than half the card's size, so
  its lines keep a pixel; charts their bars
  or circle and spokes; formulas their LaTeX as text; notes their box and a line per
  paragraph; a placed quiz or set its box with the title and what it is (text only, the
  runner being on the canvas alone); pasted images a grey box. No labels on charts. It checks the board
  first and throws the same `BoardLoadError`. `fromBase64` uses `Uint8Array.fromBase64`
  where the browser has it. A plane card with 5 strokes takes 0.4 ms
  in Node, a 300 KB board (50 strokes of 300 points) 5 ms (measured before plane cards
  drew through the engine). Show it as an
  `<img src="data:image/svg+xml,…">` in a list, so rows don't add SVG nodes to the page.
- **Notes:** a note is inline or a card (Epo 2026-11-13, local change 52). Inline is
  its text on the canvas with no fill, padding or edge (a `transparent` fill, no shadow,
  no border); every placed note starts inline. On the workspace canvas a double click
  on empty canvas places an inline text note there and types in it, as the Note
  tool's Text does; an answer board's double click keeps placing a canvas text label,
  which has the maths symbol row and the font menu (Epo 2026-11-13, local change 59,
  the `enable_dblclick_note` flag). The plus on either side of a selected note places
  the next note there with the caret in its first line (local change 60). An inline
  note is as wide as its text,
  wrapping at a card's 498, with its first and last block's margins dropped
  (`drawingBoard.css`), so its frame hugs the text; its corners scale it and it has no
  side handles, and an empty one shows its whole placeholder (local change 53). Card
  keeps its lines, widening it by the card's padding. An inline note's toolbar has no
  Style button (a card's). A note has no custom height or fold: it is always as tall
  as its text (local change 55). Its measured width (while inline) and height
  are written by the tab whose person changed the note, once that pauses (local
  change 75): the tab editing it, or the one whose own change that can resize the
  note (its text or blocks, an Undo of them, the Inline toggle, a resize's last
  rewrap, a new note; not a move, a turn or a colour) came less than 500 ms before
  the measure. It saves 500 ms after the last
  new measure, at most 2 s after the first unsaved one, and at once, untracked,
  when editing ends, the note's view goes, the page is hidden, the board is saved
  or snapshotted (`saveNoteSizes`), a drag, resize or turn starts, or any tracked
  step of the board's store starts (align, `updateBlock`), so undoing the step or
  the gesture keeps the typed height; the arrow keys' nudge, a plain write of the
  model, stores the size with it. Until then the size is that tab's alone
  (`xywh` stashed), so its frame, selection box and connector paths follow the
  text at once while other tabs see the size up to 2 s later. A gesture's end
  measures the note again, so a size its own write left out still goes in. A
  peer's move or resize shows during the wait, the measured size over it. Every
  other tab (not editing the note, read-only, or the note locked) shows what it
  measures at once too, as a size only it shows, so its hit tests, selection box
  and connector paths match the text it shows (2026-11-24: holding nothing, a
  note whose text outgrew its stored height took a double click on its last
  lines as empty board, for 3 s in an editor's tab and for good in a viewer's).
  A peer's or an Undo's write shows at once with that tab's measure over it. A
  writable tab stores the size a note shows, untracked, before a drag, resize
  or turn of it (one note or several) and before a tracked step that can act on
  it (the note selected, or in a selected group or frame: an align), so the
  step starts from the bound shown without the frame jumping, holds only what
  it changes, and its Undo keeps the size, and previews and tabs that have not
  drawn the note see it as shown. No other note is stored around a step: Yjs's
  Undo never writes over another client's later write, so a stroke that
  stored every shown size took a peer's move out of the peer's Undo. A step
  that writes a note it did not store writes the stored size with it; the
  arrow keys' nudge stores the size shown with the move. A read-only tab never writes
  one, a local write of the note included. Copy, Duplicate and an Alt-drag's
  clone take the size shown. Such a tab writes nothing per key: it writes what
  it measures only after 3 s of differing from the stored size, so a note no
  one edits (a card code added) still gets its size. A size someone else writes
  meanwhile ends the wait, the tab showing its own measure and writing nothing
  (2026-11-24: the wait started again, and its later write took a peer's move
  of the note out of that peer's Undo). Its own write ends the wait too, so two
  tabs whose fonts disagree write once at most, not back and forth; only a step
  that acts on the note stores a tab's own size again, one write per step.
  A connector's label shows at its stored offset along the path the tab shows,
  in drawing and hit tests, so it stays on its line where a shown size moved the
  path and no tab placed the label (2026-11-24: it stayed where the document had
  it, off its line); nothing is written, and the label editor, a label drag and
  their Undo write as before. Size saves take no undo step. A read-only
  board writes none (a lock drops a waiting size before the selection's end
  could save it), and unlocking measures every note again, a size the lock
  dropped going in as this tab's. A locked note (BlockSuite's lock, its own or a
  group's, as a Canvas question's elements on a student's copy) keeps its stored
  size in every tab, since the lock stops only a person's edits: no tab holds,
  saves or writes it (each shows what it measures), a lock arriving while a size
  waits drops that size, and unlocking measures the note again as by a tab not
  editing it (written after 3 s). Locks are checked
  only after a change that can lock or unlock a note (a lock, a group's or frame's
  children, an element or block added or gone), never per typed key. A lock made
  as a tracked step in the tab holding a size stores it first, as any step does,
  so a tab making a copy with locked elements adds and locks them in one
  transaction (or the copy is built before the board mounts, or on the server): a
  note it adds counts as its own change, and a later lock would store the size it
  measured in between. Before the board's document goes, its waiting sizes are saved,
  or dropped when the room was lost, refused the person or was replaced by a
  recovery copy, and every wait stops, so nothing is written after the board is
  gone. Leaving the page, each note saves its size as React takes the board's
  DOM away, before any effect's cleanup; a room that goes while the board stays
  closes them in its `onLeave`, before its teardown (`drop` while locked); the
  drawing answer closes them before its last draft write. Connector labels move at the save, inside its
  transaction, not per key. Saved on every key, in every tab, each size
  took the clock between two typed characters, so a typed note held a struct per
  character and a deleted size per key ([room memory
  report](../../bench/collaboration/reports/2026-11-22-room-memory.md) cut 2). A card's sides set its width, its text rewrapping and
  its height following, down to 40 (times its scale), and its corners scale it. A note
  turns by the frame's knob about its middle (`rotate`, local change 56). Its links
  are underlined; hovering one while no note is typed in (or a tap on a touch
  screen) shows its address and Open, a new tab (`boardNoteLinks.ts`, Epo 2026-11-13,
  L1), as the note's mask keeps the pointer off the link. The chip sits above the
  link. For a selected note it keeps off the frame and its handles, measured on the
  note's turned box (the turn is on its inner container): past the frame on the side
  away from the rotate knob, which it would otherwise cover, else beside the frame at
  the link's height, else above the link again (a note taller or wider than the
  screen); it moves when the note is selected under it, and always stays inside the
  board, over its bottom tool row, so a tap can reach Open. A mouse on its way from
  the link to the chip keeps it: crossing another link does not move it there unless
  the pointer rests on it for 150 ms, and reaching the chip ends a hide under way.
  A card
  takes its stored style from the style panel (fill half see-through, shadow, border,
  corner), with 8×10 px padding and
  the same size while typing (N2, 2026-11-08); note text is weight 500, the app's
  (headings keep 600/700); its Box shadow is the board's 1 px
  hairline (`--affine-note-shadow-box` on `.capy-board`). The style panel opens with an
  Inline | Card switch (Inline on the left; the other sections only for a card), and
  the note toolbar's Inline button (lit while inline) turns it either way; Card brings
  the default fill, the Box shadow and corner 8. The preview draws an inline note as
  its text and a card with its corner, fill, border, or a hairline for any shadow.
  AFFiNE's slash menu is registered, offering
  text styles, lists, alignment, inline styles, Image, dates and the move/copy/delete
  actions; Image stores its file through the board's blob source, as a pasted image does.
- **Theme:** the board follows the app's light or dark. The app's dark themes set
  `data-theme` to a Catppuccin flavour, which AFFiNE's `[data-theme=dark]` never matches,
  so `drawingBoard.ts` puts AFFiNE's dark variables under `html.dark` (on `<html>`, for
  its popovers too) and sets BlockSuite's theme signal from the `dark` class. The board
  paints no ground: its dots sit on the panel's colour, or its frost over the page frame.
  Plane and chart cards take a light or dark `PAPER` (dark paper is a dark note's), and a
  formula's black ink is inverted (hue kept) on a dark board. The marking image is
  always light: `toImage` lifts the dark variables (`data-board-light`) and switches the
  signal to light while it draws, so the board shows light for that moment. AFFiNE's
  own dark placeholder and border greys (rgb(62, 62, 63) and rgb(46, 46, 46) on
  rgb(30, 30, 30) panels) are lifted to readable ones, and the toolbar pieces' navy
  (`--capy-navy`) lightens to #5683b3 on a dark board.
- **Formulas:** a `formula` canvas element holding LaTeX, typed in MathLive (loaded on
  first open) with the question editor's field styles (`mathField.css`: app selection
  colours, caret on the line), the caret after the formula and nothing selected. Its
  card opens in the middle of the board and closes like a popup on a
  press anywhere else, another formula piece too (MathLive's keyboard and menus aside),
  discarding what was typed, as Cancel does. AFFiNE keeps LaTeX as HTML in note cards, and its export (html2canvas)
  garbles that, so typing `$$` in a note here stays text; AFFiNE's inline spec stays
  registered because paragraphs read it as they render (the specs only: its LaTeX node and
  editor menu, which load KaTeX and shiki, are left out). KaTeX and its stylesheet load
  once the board holds a formula or the formula editor opens (84 KB gzipped most boards
  never need). It lays the formula out in a
  hidden host and where its glyphs, rules and stretched SVGs sit (clipped as KaTeX clips
  them) is kept as drawing steps, which the canvas renderer replays at the card's size
  each frame, so a formula stays sharp at any size and zoom. Resizing keeps its shape
  (`lockRatio`, as AFFiNE's images). Tested in Chromium only. Size and expansion limits
  are set on KaTeX, and a saved answer holding more than 2,000 characters draws
  nothing. Laid-out formulas stay until the board closes. Saving answers still needs
  limits on the server.
- **Full-screen views in the URL** (Epo 2026-11-13): on the account's Canvas page
  and a workspace's Canvas tab, a plane's or chart's editor and a quiz card's drawing
  answer are named in the URL (`open`: the card's id, or `<card>~<part>` for a
  drawing answer), so opening one is a history step: Back closes it, Forward opens
  it again, and Done or Escape steps back. `boardEditorShell.ts` tells the page which
  card's editor opened or closed (`watchBoardEditor`, the board's `onEditor`), the
  board opens one by id (`openEditor`, false when it holds no plane or chart by that
  id), and `useCanvasBoard` keeps the two in step; a card's drawing answer reads its
  open state from `OpenLinkContext` (`useOpenView` in `src/lib/openLink.ts`,
  scoped per card by `scopedOpenLink`), elsewhere it stays local. A link naming a
  card no longer on the canvas, a quiz no longer listed or a part the quiz no longer
  has silently leaves the URL (no toast, Epo 2026-11-18); a card off screen
  is brought into view so its runner mounts. A nested board (the drawing answer's
  own plane) keeps its editor out of the URL.
- **Labels** come from the Maths menu's Label, which can place one on top of a card (a
  double click there opens the plane), or, on an answer board, a double click on empty
  canvas (on the workspace canvas that places an inline note). They have a
  maths symbol row while typing. Board text starts at 16 px (local change 45; the size
  menu offers 12, 16, 20, 24, 32, 40, 64 and 128). **Fonts** (local change 44, Epo
  2026-11-12): the font menu offers Fustat (BlockSuite's default `Inter` name drawn in
  the app's font), Comic Neue, Lora and JetBrains Mono. BlockSuite's font loader has no
  config here (AFFiNE fetches its fonts from its CDN), so `drawingBoard.css` declares a
  face per weight the weight menu knows (300, 400, 600, normal and italic where the font
  has them) from the `@fontsource` packages; the weight menu lists a font's faces, so a
  single variable range left it blank. AFFiNE's other names (in mind map styles) alias to
  Fustat or, for Kalam, Comic Neue. Faces load when first drawn, and the board redraws on
  `document.fonts` `loadingdone`.
