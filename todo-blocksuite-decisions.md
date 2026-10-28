# BlockSuite notes: what every editor decision means for the move

Status: draft, 2026-10-28. This file goes through every recorded decision that
touches the note editor or the Plate side and says what the move to BlockSuite
does to it. Inputs: `todo-blocksuite-spike.md` (the plan, D1–D11),
`todo-blocksuite-layout.md` (the spec), `human/`, the openwiki pages, and
BlockSuite at AFFiNE canary `5f19254997` (read-only copy in the session
scratchpad).

## How to read it

Classes:
- **Keep**: holds unchanged. It works through `value()` JSON, generic yrs, the
  server room, or a component outside the editor.
- **Port (S/M/L)**: holds, but has to be rebuilt on BlockSuite. The entry names
  the mechanism it maps to.
- **Re-decide**: BlockSuite conflicts with it or makes it moot. These are
  collected in "Questions for Epo".
- **Obsolete at cut**: exists only because of Plate or slate-yjs. The entry says
  what deletes it.

Citations are `file:line`. Abbreviations:

| Tag | File |
| --- | --- |
| PE | `human/frontend/plate-editor.md` |
| AR | `human/agentic-retrieval.md` |
| SQ | `human/backend-storage-quota.md` |
| AU | `human/authorization-permissions-lifecycles.md` |
| EH | `human/frontend/error-handling.md` |
| MI | `human/miscellaneous.md` |
| QB | `human/question-bank.md` |
| SP | `human/study-progress.md` |
| EP | `human/editor-perf.md` |
| TC | `human/test-catalog.md` |
| OB | `human/observability-metering.md` |
| OF | `human/frontend/office-files.md` |
| W  | `openwiki/frontend/plate-editor.md` |
| BS | BlockSuite source, under `blocksuite/` |

BlockSuite facts checked against the source and used below:
- **Undo:** the history is one `Y.UndoManager([yBlocks], {trackedOrigins: {clientID}})`
  that reads the client id once (BS `framework/store/src/extension/history/history-extension.ts:22-24`).
  `store.transact` uses the current `spaceDoc.clientID` as the origin
  (`store.ts:371-384`). Mod-z, Shift-Mod-z and, on Windows and Linux,
  Control-y call `store.undo/redo` (`affine/blocks/root/src/keyboard/keyboard-manager.ts:87-104`).
- **Default props:** when a block model is built from a yBlock, every schema
  default the yBlock lacks and that is not `undefined` is **written into the
  yBlock** (`framework/store/src/model/block/sync-controller.ts:309-317`).
- **Gfx props:** `affine:image` and `affine:latex` are GfxCompatible, so their
  defaults include `xywh`, `index`, `lockedBySelf`, `rotate` and (latex)
  `scale`. Image defaults also include `width`, `height` and `size: -1`
  (`affine/model/src/blocks/image/image-model.ts`, `latex/latex-model.ts`).
- **Allowed parents and children:** a callout holds only `affine:paragraph`
  and `affine:list`. `affine:table` sits only under `affine:note`.
  `affine:latex` sits under note, paragraph or list.
- **`native2Y` is deep:** every plain array becomes a `Y.Array` and every plain
  object a `Y.Map`. A reactive array's `splice`, `push` and `unshift` mutate
  the `Y.Array` in place (`framework/store/src/reactive/native-y.ts`,
  `proxy.ts:95-155`).
- **Awareness:** `AwarenessStore` writes `selectionV2` when it is constructed.
  `RemoteColorManager` writes a random `color` and keeps it in session storage.
  The remote-selection widget labels a caret with awareness `user.name` and
  draws remote block selections as tinted rectangles
  (`affine/widgets/remote-selection/src/doc/doc-remote-selection.ts`,
  `manager/remote-color-manager.ts`). Nothing in BlockSuite writes `user`; the
  app does.
- **Paste:** pasted blocks get fresh ids from `replaceIdMiddleware`
  (`affine/shared/src/adapters/middlewares/replace-id.ts`).
- **Latex:** the latex block and inline render with KaTeX
  (`affine/blocks/latex/src/latex-block.ts`,
  `affine/inlines/latex/src/latex-node/latex-node.ts`).
- **Link hotkey:** the inline link command is bound to `Mod-k`
  (`affine/inlines/preset/src/command/config.ts:117`).
- **Inline formats:** each format's attributes are validated by a zod schema
  with `.catch(undefined)`, so a value the schema refuses is not drawn
  (`affine/inlines/preset/src/inline-spec.ts`).
- **No i18n:** UI strings are hard-coded English, for example "Type '/' for
  commands" (`affine/blocks/paragraph/src/view.ts:19`).
- **Unknown flavour:** a flavour with no registered schema throws "schema for
  flavour: … not found" when its model is created (`sync-controller.ts:295-300`).
- **Markdown:** the markdown adapter has no MDX support and turns footnotes
  into a footnote inline (`affine/shared/src/adapters/markdown/`).

---

## 1. Structure and ids

- **Obsolete at cut** PE:143 (2026-10-08): NodeIdPlugin is off, and `stableElementIds.ts` gives ids to Enter, split and duplicate.
  BlockSuite ids come from the workspace `idGenerator`, and duplicates come only from a paste, which `replaceIdMiddleware` handles. The plugin is deleted with the Plate editor.
- **Obsolete at cut** W:364-367: Plate's `_id` insert marker is dropped at every depth.
  Plate-only. It goes with `stableElementIds.ts`.
- **Obsolete at cut** W:369-379: `remoteNormalizationPlugin` flushes Slate's normalizations right after a remote event.
  BlockSuite applies remote Yjs events straight to its models and has no normalizer pass. The plugin is deleted.
- **Obsolete at cut** W:233-235: normalizers must be deterministic and idempotent, and Slate history is never layered on top of the Yjs history.
  No Slate normalizers or history remain.
- **Re-decide** BS paste behaviour against W:358-361: Plate kept a block's id across a cut and paste in the same note when the id was free. BlockSuite gives every pasted block a new id.
  With new ids, a cut-and-paste sends the block's threads to Document comments (PE:248) and reads as a delete plus an add in note effects (AR:623). → Q12.
- **Keep** AR:623 (2026-10-17): note effects compare per-block index text, aligned by element id.
  `value()` keeps top-level and nested ids (spec "Ids"). After D11 the unit becomes the block id.
- **Port (S)** AR:699 (2026-10-21): a note never ends empty. The server appends one empty paragraph at admission.
  On blocks, a `note` left with no children gets one `affine:paragraph`. The spec seeds this only for an empty value; add it as a repair on entry beside D3.
- **Keep** PE:3: standalone quiz, flashcard, mindmap and diagram H1 titles are rendered outside the document.
  The same holds outside the blocks tree.
- **Keep** PE:1, PE:2: metadata PATCH never rewrites content; clones read the SQL projection.
  Layout-neutral.
- **Port (S)** PE:185 (2026-10-13): embed names are one word per kind in each layer's casing (`mermaid`, `html_embed`/`html-embed`/`HtmlEmbed`).
  The blocks layer is a new layer, but the spec names the HTML block `capy:html`. Rename it `capy:html-embed` and add flavours to the generated catalog (spec change d).

## 2. Text input, IME, marks

- **Obsolete at cut** PE:134 (2026-10-08): the editor root answers React's contentEditable check as not editable.
  BlockSuite's Lit host owns its contenteditable and React never commits into it. The workaround and its test are deleted.
- **Port (S)** PE:67 (2026-09-27): browser spellcheck is off inside code blocks.
  Set `spellcheck=false` on the `affine:code` rich-text.
- **Port (M)** PE:20, PE:77 (2026-09-25, 2026-09-28): formulas are edited in place with MathLive, inline or on their own line, and MathLive renders them in View and Edit.
  BlockSuite's latex block and latex inline draw with KaTeX in a popup editor. Replace both views with `MathField`/`MathPreview` islands, keeping the data (`latex` prop or attribute).
- **Port (S)** PE:191 (2026-10-14): read-only formulas draw MathLive's HTML commands as text (`inertTex`), and share pages run a tripwire.
  If BlockSuite's KaTeX view stayed, these guards would be bypassed. They come with the MathLive port above.
- **Keep** PE:56-57, PE:69-75, PE:79-84, PE:145, PE:172-173: MathField and MathPreview behaviour (caret, menus, keyboard, ATP, `\dots`, baseline, sideways scroll).
  These live in `MathField.tsx` and `MathPreview.tsx`, which the port reuses.
- **Port (S)** PE:58 (2026-09-27): Subscript and Superscript sit under Inline elements in All blocks.
  They are inline specs we add (spec "Inline formats"). The menu entry moves with whichever menu Q4 picks.
- **Port (S)** PE:295 (2026-10-26, Q380): color, backgroundColor, fontSize, fontFamily and listStyleType hold no `;` and no control characters; every renderer draws none.
  Do it in the zod schema of each of our inline specs (BlockSuite drops values that fail) and in room admission on `Y.Text` attributes and the `listStyleType` prop.
- **Obsolete at cut** embeds catalog `forbidden` keys (W, embeds.md:31-35): style marks may sit on text leaves only, never on elements.
  On blocks, formats exist only as `Y.Text` attributes, and the structural check closes each flavour's prop list, so the rule has nothing left to guard.
- **Keep** PE:177 (2026-10-11): a cloned mention stays live only for members of the destination.
  Go works on the JSON. After D11 it reads the `mention` attribute.
- **Port (S)** MI:220 (2026-10-14): ⌘K opens Search everywhere, inside notes too; the command palette moves to ⌘/; links are added from the toolbar only.
  BlockSuite binds the link command to `Mod-k`. Unbind it and bind ⌘/ to our palette.
- **Port (S)** MI:224 (2026-10-14): ⇧⌘S opens export, and ⇧⌘M adds a comment in notes.
  These become hotkeys on the BlockSuite host (`bindHotKey`).
- **Port (M)** MI:225 (2026-10-14): Copilot ghost text uses ⌥Space and ⌥→ on Apple, Tab to accept and Esc to reject, behind the editor AI flag.
  BlockSuite has no ghost text. It would be a new inline overlay → Q15 on whether editor AI gates the cut.
- **Keep** MI:223 (2026-10-14): live quiz and flashcard editors have one in-browser undo stack, and their rich fields drop Plate's own history.
  The rich fields are the question `TextEditor` (D7) → Q7.
- (Not a decision) IME and composition: no recorded decision. The plan's by-hand script covers it (step 6).

## 3. Lists and indent

- **Port (S)** PE:223 (2026-10-18): indent is at most 8 levels (`LIST_INDENT_MAX`), and every layer refuses deeper.
  On blocks this is nesting depth. Stop Tab past depth 8 and add the bound to the structural check (spec change j).
- **Port (S)** PE:47-48 (2026-09-27): list drag handles and todo checkboxes align with the first line, and todo uses a single indent with the checkbox in the marker gutter.
  This is CSS and offsets on the `affine:list` view and the drag-handle widget.
- **Port (S)** PE:182 (2026-10-13): numbered items are spaced like bulleted ones.
  CSS on `affine:list`.
- **Keep** PE:281 (2026-10-24, Q247-Q250): an Undo's redo keeps its traced right neighbour only after the left one (yjs patch and yrs).
  Generic `Item::redo`, so it covers `sys:children` arrays and block `Y.Text` alike.
- **Port (S)** W:174-177: an import (Markdown, DOCX, JSON, agent) clamps indent on entry (`clampIndents`).
  Under the bridge, `state_from_value` clamps (N1). After the cut, the converter clamps nesting.

## 4. Tables

- **Re-decide** spec T1 against W:1094 ("rich/merged tables use HTML" in export) and table cells that hold blocks.
  `affine:table` holds one `Y.Text` per cell, with no spans and no header cells. → Q14 (spec T1).
- **Port (M)** PE:24 (2026-09-25): one shared floating toolbar serves tables, columns, embeds and the question dialog.
  It becomes the toolbar we drive over `affine:table`, `capy:columns` and the embeds; how depends on Q4.
- **Port (S)** PE:175 (2026-10-10): table cell padding is tighter on phones.
  CSS on the `affine:table` view.
- **Keep** AR:723 (second half): text typed into a cell of an agent-inserted table goes with the table.
  The cells are in the table's yBlock, so deleting it takes them, as today.
- **Port (S)** W:3652 (AI previews): table updates keep stable cell ids.
  The cell id becomes the key `rowId:colId` (spec "Ids").

## 5. Media, figures, embeds

- **Port (M)** PE:124, PE:141 (2026-10-07, 2026-10-08): image, YouTube, Mermaid, chart and graph share `MediaFrame` (hover toolbar, side resize handles, click to zoom), and `width` is "<n>%", 20 to 100, through one shared check.
  `affine:image` has pixel resize handles and its own toolbar. Either our `MediaFrame` wraps the image view or we keep theirs → spec T2 (Q14). The `widthPercent` check goes into the structural check.
- **Port (L)** PE:167 (2026-10-10): pasted images upload in the browser through the editor asset path (files directly; `<img>` URLs fetched, then uploaded; a link when that fails). No server fetches. Nodes always carry an `assetId`.
  BlockSuite's image flow stores a local blob hash as `sourceId` and syncs it through blob storage. Ours needs a gateway asset id before the block holds a source, so the drop and paste handlers (`FileDropExtension`, the HTML adapter's image step) and the blob source must be rewritten around asset ids.
- **Re-decide** PE:168 (2026-10-10): an uploading image is a skeleton that other editors see through the uploader's presence (`uploads: [blockId]`); if the uploader leaves, the block falls back to the empty "Add an image" placeholder.
  The spec never writes `placeholder`, and an image must carry an asset id, so no block exists for presence to name. → Q3.
- **Port (M)** PE:169 (2026-10-11): pictures in an imported DOCX upload like pasted images.
  This moves to the DOCX paste or import adapter → the upload pipeline above.
- **Port (S)** PE:192 (2026-10-15): notes embed images and audio only, with no PDF or file blocks.
  Do not register `affine:attachment`, `affine:bookmark`, the `embed-*` blocks or `affine:database`, and make the drop handler refuse other types with the type message.
- **Keep** PE:96 (2026-10-02): standalone notes upload through the material editor-asset route.
  API-level.
- **Port (S)** SQ:90 (2026-10-25, Q371): an image keeps the picked file name as its alt text.
  `affine:image` has no `name`. It is ours (spec change e).
- **Keep** SQ:53, SQ:59, SQ:62 (2026-10-24, M16, Q273): media follow uploader-pays, and an Embeds-tab delete leaves the "removed by its uploader" placeholder.
  The asset resolve answer drives the view, so the layout does not matter.
- **Keep** SQ:33, SQ:63-64, SQ:76, SQ:88 (2026-10-20…25): one browser compressor, a 2 MiB cap, decode refusal, SVG to PNG.
  This runs in the upload path the port calls.
- **Keep** AU:42-48 (2026-10-06): note children follow saves (hidden trash for a day, restore on reuse, a paste copies another note's child).
  Server-side, driven by the projection and the children pass (plan: `room.rs` child pass, piece 5).
- **Keep** W:532-535: the YouTube poster loads the player only on click.
  `capy:video` renders as an island.
- **Port (S)** PE:23, PE:9 (2026-09-25, 2026-09-22): embeds render view-only with an accent ring when selected, and the floating toolbar anchors to the selected block.
  This maps onto the `BlockSelection` state in `std` and our block toolbar.
- **Obsolete at cut** PE:125 (2026-10-07): block toolbar Copy fires `execCommand('copy')` filled by `setFragmentData`, because `application/x-slate-fragment` cannot go through `navigator.clipboard`.
  Copy becomes `std.clipboard.copy` of the block's slice, in BlockSuite's own clipboard format. The Slate fragment path is deleted.
- **Port (S)** PE:151 (2026-10-08): a block pasted while a quiz or other non-text block is selected goes in right after it.
  `VoidBlockPastePlugin` becomes a paste handler on a `BlockSelection`.
- **Obsolete at cut** W:537-542: every block embed must be a void, Enter on a void opens a paragraph below (`voidBlockBreak.ts`), and void carets suppress scroll-into-view.
  BlockSuite blocks have no Slate void semantics. Enter on a selected block is the root keymap's job; keep only the behaviour as a small port.
- **Obsolete at cut** PE:206 (2026-10-18): every catalog void element holds exactly one empty text leaf.
  Blocks have no text leaves. The structural check's prop list replaces the rule.
- **Keep** PE:94-95, PE:101-103, PE:130-132, PE:178, PE:180 (2026-10-01…13): the interactive HTML block (sandboxed iframe, CSP, caption, height 32–600 px, 64 KB, at most 10, loads with the page, export as a link).
  `capy:html-embed` renders `HtmlEmbed.tsx` as an island; the caps are value checks.
- **Port (S)** PE:103 (2026-10-05): the export link carries `?block=<id>`, and the note opens scrolled to that block.
  Scroll with `std.view.getBlock(id)` once the block is mounted.
- **Port (S)** PE:170 (2026-10-10): the old `title` field of interactive blocks is refused on every layer.
  The structural check's closed prop list does this for `capy:html-embed` and the figures.
- **Port (S)** PE:210 (2026-10-17): a chart's, plot's and graph's `block` is a `Y.Map`; each field, series and element is replaced whole, and an open editor shows peers live.
  `native2Y` is deep, so `labels`, a series' `values` and nested arrays become `Y.Array`s. Writers must assign whole fields, never `splice`, `push` or `unshift`, or two concurrent "replace all" writes interleave (spec change c).
- **Keep** PE:213, PE:218, PE:220-221 (2026-10-17/18): live figure merges are repaired on read, the figure type wins, extra entries are admitted up to twice the cap, and pie charts keep negatives marked.
  This works on the figure value whatever holds it.
- **Keep** PE:161 (2026-10-10): chart and graph in live items are one last-write-wins value, written on Done.
  Item rooms, not notes.
- **Keep** PE:214-217 (2026-10-17): plot limits, the editor and prefilled rows.
  Dialog-level.
- **Keep** AR:779 (2026-10-25): a placed library figure is small (50%) or normal.
  The agent's markdown maps it onto `widthPercent`.

## 6. Mermaid, mindmap, diagram

- **Port (S)** PE:159 (2026-10-10): a Mermaid block's source is a strings-only `Y.Text` in `mermaid.source`, through a pnpm patch of `@slate-yjs/core`.
  The spec makes `source` a `Y.Text` prop natively. `yTextCodeMirror.ts` binds as before, and the slate-yjs patch is deleted at the cut.
- **Port (S)** PE:87-88, PE:91-92 (2026-09-28): a per-block `theme` with five presets; the block toolbar leads with the theme dropdown and a caption edited in place under the diagram; the default theme is a per-user preference stamped on new blocks.
  `capy:mermaid` props `theme` and `caption` (spec). The theme dropdown and caption field move to the block toolbar of the port, and insertion stamps the preference.
- **Port (S)** PE:190 (2026-10-14): the inline Mermaid caption stops at 300 characters on the user side only.
  The caption is a `Y.Text` prop (spec); the limit goes on the caption input's `beforeinput`.
- **Keep** PE:89-90, PE:154-155, PE:193-194, PE:255-258, PE:260-269, PE:272 (2026-09-28…10-23): Mermaid rendering (worker, DOM shim, safety, fonts, 50,000-character and 500-edge caps, 30 s limit, minimum scale, error style, geometry CI, export fallback).
  All of it is in `Mermaid.tsx` and its worker, which `capy:mermaid` renders as an island.
- **Port (S)** PE:261 (2026-10-23): a note holding a Mermaid block starts the worker at idle when it opens.
  Read the store for a `capy:mermaid` block instead of walking Plate nodes.
- **Port (S)** PE:120 (2026-10-27, Q453): a diagram or mindmap View asks the open room for a fresh projection.
  Keep while they stay Plate in step 1 (plan boundary 5 note). At the cut they become blocks documents with one Mermaid block (D2), and `liveMermaid.ts` reads `blocks` (already listed in the plan).
- **Keep** PE:160, PE:254 (2026-10-10, 2026-10-22): live item editors have no Save/Cancel, and a live dialog shows its save status after the title.
  Dialog UI.

## 7. Material refs, quizzes and flashcards in notes

- **Port (M)** PE:6, PE:121, PE:123 (2026-09-18, 2026-10-07): a quiz or flashcards block is a void top-level reference to its own material row, rendered with the real study components (View) or editors (Edit); insertion creates the row first; removing the last question or card removes the block.
  This is piece 4, `capy:material-ref`. Removing the block becomes `store.deleteBlock` from inside the island.
- **Keep** PE:122, AU:26 (2026-10-07, 2026-09-18): embedded items have a random UUID name, no lifecycle of their own, and are trashed when their reference leaves the projection.
  Projection-driven.
- **Keep** PE:8, QB:73 (2026-09-18, 2026-10-13): no inline quiz or flashcard nodes and no pending reference in a stored note.
  The structural check refuses unknown props and flavours.
- **Port (S)** W:600-611: the insert goes where the command ran (`holdInsertPlace`), takes the caret only if it has not moved, and does nothing inside a container; a nested reference is lifted to the top level.
  With block ids this is simpler: remember the block id and offset. The "top level only" rule is the schema's `parent: ['affine:note']`.
- **Keep** W:610-612: note undo covers only inserting and removing the reference.
  The item rooms are separate documents outside `yBlocks`.
- **Keep** PE:233 (2026-10-20): an embed's room syncs inside the note's seat (at most 64).
  Socket-level.
- **Keep** AU:43-44, AU:46 (2026-10-06): a pasted quiz or flashcards block becomes the note's own copy through the server children pass, and a duplicate gets a copy.
  The server path stays; the children pass reads the `capy:material-ref` props (plan, `room.rs` child pass).
- **Keep** SP:4, QB:65-69 (2026-10-06, 2026-10-10/11): embeds record no study progress, and embed credits are computed from the current embed ids.
  The credit union reads embed ids, which the browser now gets from the store instead of Plate nodes (S-sized change in the footer hook).
- **Keep** PE:304 (2026-10-27): the Study tools popover groups the quiz and flashcard inserts.
  This is our toolbar (Q4).

## 8. Comments

- **Keep** D5 (plan): comments stay relational and are anchored by relative positions in a block's `Y.Text`. Settled.
- **Port (S)** PE:68 (2026-09-27): a cursor-only comment attaches to its containing block, including an empty one.
  The block id comes from the `TextSelection`.
- **Port (M)** W:3451-3456: comment highlighting is local decoration state, never a document write, and resolves through `liveRange.ts`.
  BlockSuite's inline editor has no Slate-style `decorate`; AFFiNE highlights through `comment-<id>` attributes in the document, which D5 rejects. Draw highlights as an overlay from `Y.createAbsolutePositionFromRelativePosition` ranges, like the remote-selection widget, or add a local-only inline renderer hook.
- **Port (S)** PE:248 (2026-10-21): a thread whose block is gone shows as a document comment and returns when Undo brings the block back.
  The live id set becomes `store.getBlock(id)` presence. It depends on Q2 and Q12 (ids kept or minted).
- **Keep** PE:85-86, PE:282, PE:284 (2026-09-28, 2026-10-24, Q313): flat threads, the popover, plain-text comments of at most 3,000 characters, and field sanitising.
  Relational and UI-only.
- **Keep** SQ:51 (2026-10-23): after a collection, a discussion on deleted text falls back to its block and quote.
  Generic yrs.
- **Keep** AU:18, AU:28 (2026-09-24): no commenter role; comments only in Edit, keyed on `canEdit`.
  Policy.
- **Port (S)** PE:176 (2026-10-11): paragraph drag handles and comment triggers centre on the first text line.
  This is a block-gutter widget position.

## 9. Undo, redo and agent Undo

- **Keep** D6 (plan): BlockSuite's `Y.UndoManager`, with `limitUndo` applied and built after the client id is adopted. Settled.
- **Keep** W:254-262 (2026-10-23): Undo reaches back at most 24 h (`limitUndo`), and the server holds deletions for 25 h.
  `limitUndo` takes a `Y.UndoManager`, which `HistoryExtension.undoManager` exposes.
- **Port (S)** PE:61 (2026-09-27): toolbar Undo and Redo work without a selection.
  Use `HistoryExtension.canUndo$`/`canRedo$` and `store.undo()`.
- **Port (S)** AR:686, AR:711, AR:726, AR:732, AR:785, AR:790 (2026-10-20…26, Q385, Q402): agent Undo reverts exactly the agent's items through a durable payload of id ranges and tombstone positions, valid for 24 h, admitted by a loaded room.
  This is the D6 payload builder (`commands.rs`, `edit.rs`), already in the plan. Ids are `Y` ids, so the format carries over.
- **Re-decide** AR:723 (2026-10-22): an agent edit's Undo removes only the agent's items, so text typed into an agent-inserted paragraph stays and joins the anchor paragraph.
  On blocks the typed text lives in the `Y.Text` of the agent's yBlock. Deleting that map deletes the typing too, so the literal rule cannot hold. → Q1.
- **Port (S)** AR:698 (2026-10-21): an agent edit may remove any note block, media included, trashed like a person's deletion.
  `store.deleteBlock` by id.
- **Keep** AR:694-695, AR:702, AR:730, AR:805, AR:809, AR:819 (2026-10-21…28): Undo size estimate and cap, created-file Undo, actor checks, replay rules.
  Server-level.
- **Keep** MI:223: the live items' undo stack (see section 2).

## 10. Drafts, offline, late merge

- **Keep** PE:97, PE:183, EH:66, EH:69, EH:71, EH:73, EH:87 (2026-10-04…24): editable offline, IndexedDB/OPFS drafts per local update, `POST /drafts`, 7-day expiry.
  Drafts store Yjs updates. They are layout-neutral, apart from the note-only pieces below.
- **Port (M)** EH:89 (2026-10-24, Q229): a note shown from its saved copy before its room joins stays editable, and at the join the saved copy, the edited copy and the room are compared block by block by id.
  The editor needs a Y.Doc built from the saved JSON, so the TS `state_from_value` becomes production browser code (plan change 2). Comparing by block id is natural on blocks; applying is `store` operations instead of Slate ops.
- **Port (M)** EH:90, EH:93 (2026-10-24, Q237, Q258): typing a merge would hide because a co-editor deleted its block is caught in the browser and goes to the merge view.
  `hiddenTyping.ts` must detect "a block removed from `sys:children` plus its Y.Map deleted" (in the plan).
- **Port (M)** EH:91, EH:95, EH:112 (2026-10-24…27, Q251, Q253-Q265, Q434): the merge view (pieces per block, Apply/Copy, a restored block after its previous block, one Undo step per choice).
  Pieces keyed by block id carry over. Apply becomes `store.addBlock` after the previous sibling inside one `transact`.
- **Port (S)** EH:98 (2026-10-26, Q397): the bind merge compares blocks ignoring inner element ids, and rewrites only the text that changed.
  Inner element ids (code lines, cells, inline) no longer exist. Text rewrites become `Y.Text` deltas on the block.
- **Port (S)** EH:104 (2026-10-27, Q411): the bind merge has no cap; a whole-note replace took 68.8 s at CPU x4, 79% of it in Slate's per-operation apply.
  The cost was Slate's. Re-measure on blocks and drop the perf-track item if it is gone.
- **Keep** EH:101 (2026-10-27, Q408): the bind merge runs on the main thread.
  Re-check after the measurement above.
- **Port (S)** EH:102-103 (2026-10-27, Q409, Q410): a paused editor stores its copy; the hidden-typing detector arms before the first sync; pending typing is saved before a large paste.
  The paste hook moves onto BlockSuite's clipboard paste event.
- **Keep** SQ:49, EH:94, EH:96, EH:99-100, EH:105-107, EH:109-111, EH:113-115 (2026-10-23…27, Q281…Q451): the late merge in WASM with stable-left placement, its timers, locks, expiry, rejoin and toast.
  Generic yrs (plan, "Collection and tombstones").
- **Keep** EH:114 (2026-10-27, Q446): a connected tab's typing into a block a co-editor deleted goes with the block (plain Yjs).
  On blocks, the `Y.Text` goes with its yBlock, the same outcome.
- **Keep** PE:98-100, EH:47, EH:67 (2026-10-04/05, 2026-09-30): refused saves, unplaceable updates resynced, lineage copy-only for non-notes.
  Room- and draft-level.
- **Keep** PE:283, PE:285-293 (2026-10-24/25, Q288, Q319-Q365): draft tokens, opening with a draft send, the 30 s hold, time limits.
  The editor "applies groups locally" by applying Yjs updates to the space doc, which works the same on blocks.
- **Keep** PE:230 (2026-10-20): offline drafts survive sign-out.

## 11. AI previews and agent edits

- **Port (L)** W:3646-3681 with PE:249-250 (2026-10-21): AI output stays local until accepted; streamed edits hold a relative range, inserts a block id, tables cell ids; Accept writes over the range as it reads now, as one undoable step; Accept after the text is gone drops it silently.
  This is a rewrite of `notes/ai/*` against store commands (in the plan, with the coordination note). Plain-paragraph edits that keep the block count become per-block `Y.Text` replacements, which is easier on blocks. One step means one `store.transact`.
- **Keep** W:3696-3721: AI routes, model selection, Instant thinking, the `VITE_FEATURE_EDITOR_AI` flag.
  Server and settings.
- **Re-decide** AR:703 with PE:248 (2026-10-21): `replace_block` stays (text-only stale check, new ids) while Epo works out precise in-block edits.
  On blocks, an in-block text edit is a `Y.Text` diff on the block that keeps its id. This is the moment to decide. → Q2.
- **Port (M)** AR:536 (2026-10-14): `insert_markdown` takes `after_block_id: "end"`, and receipts name the block ids they wrote.
  The commands map onto `sys:children` inserts (plan "agent edit commands become operations on block ids").
- **Re-decide** AR:394, PE:116, PE:136, PE:138-139 (2026-10-01…08): agent markdown runs the editor's own markdown import bundle in V8 inside the Rust server, with 1 MiB, 10 s and 512 MiB limits, an O(n) prescan and 0.8 GiB budgeted.
  After D11, "the editor's own import" is either ours emitting block JSON or BlockSuite's `MarkdownAdapter` (no MDX; unverified whether it loads without a DOM). → Q8.
- **Obsolete at cut** PE:115, PE:133 (2026-10-07): the Rust headless note editor keeps links, mentions, inline equations, `mention_input` and `slash_input` inline.
  Blocks keep inline content as `Y.Text` attributes and never store the input elements. The headless Slate editor (`slate/`, `edit.rs` Plate parts) is deleted.
- **Obsolete at cut** PE:153 (2026-10-09): the Node server's agent-edit fixes are ported to Rust.
  Done already, and the Node server is gone.
- **Keep** PE:117 (2026-10-07): the Rust port may differ from Node in update bytes and error text.
- **Keep** AR:516, AR:715, AR:251 (2026-10-13, 2026-10-22, 2026-09-21): `inspect_document` reads what editors see, prints figures as JSON, and shows embedded refs' ids.
  It reads `value()` JSON (plan boundary 3).
- **Port (S)** AR:796 (2026-10-27, Q417): the open room is read for live content only for a detailed read.
  Already in the plan (server reads of the open room).
- **Keep** AR:41, AR:43, AR:808, AR:801-806 (2026-09-09…28): no revision precondition, merge of in-flight typing, refusal while saves fail, the "might have been saved" wording, `moved_out`.
  Server-level.
- **Keep** AR:696 (2026-10-21): `set_mermaid` is gone; Mermaid changes through `replace_block`.
  The same `replace_block` port (Q2).

## 12. Limits, admission, repair

- **Port (L)** PE:112 (2026-10-07): every note update is checked against the limits on arrival (exact metrics plus a per-update growth bound).
  The plan measures on the projection (step 5) and ports `bound.rs` or reports pessimistic numbers. The XmlText leaf pricing (W:2585-2600) does not carry over.
- **Re-decide** SQ:6 with PE:223: plan-independent limits are 2 MiB normalized JSON, 10,000 material nodes and depth 16.
  While the bridge stands they are measured on the projection (plan). After D11, "node" and "depth" need block definitions. → Q9.
- **Port (M)** PE:137 (2026-10-08): admission refuses anything but strings and formats in note text, and non-plain attribute values except `mermaid.source` as a `Y.Text`.
  The same rule per flavour: `Y.Text` only where the spec says so, a deep `Y.Map` only for figure `block` and flat-data table keys, primitives elsewhere. This belongs in the structural check (spec, piece 5).
- **Port (M)** W:402-420 (REVIEW5 R2, `required_keys`): an update that leaves an element without its type's required keys is refused on arrival.
  Per flavour: `sourceId` (an asset id), `materialId`/`refKind`, `source`, `provider`/`videoId` (spec change l).
- **Keep** PE:140, PE:146-148, PE:150, PE:152 (2026-10-08): 4 MiB sync cap, yrs-counted work budget, trial-copy sizing, socket queue and awareness caps.
  Generic yrs and server.
- **Port (M)** PE:205, PE:209 (2026-10-18/19): cheap rules are refused at admission, costly ones repaired at save; repair is preferred over reset; a committed admission/save parity property test gates CI.
  The blocks crate needs its own `assert_canonical` and parity test beside D3's repair on entry. Add the test to piece 5's done-when (plan change 4).
- **Port (M)** PE:184 (2026-10-13): every layer refuses a block type the catalog does not list; a stored document holding one stays readable with an "unsupported block" placeholder, and editing it is refused.
  BlockSuite throws on an unknown flavour, so the editor cannot open such a room. That is fine, since editing is refused, but the read renderer (Q6) must draw the placeholder and admission must refuse unknown flavours (spec change i).
- **Port (S)** PE:294 (2026-10-25, Q378): a column or media width the check refuses gets no paste-time check; every renderer styles only valid values.
  Our block views must style `widthPercent` and column `width` only after the shared check.
- **Keep** PE:256, PE:95, QB:76, PE:189 (2026-10-22, 2026-10-01, 2026-10-14): the Mermaid and HTML caps, nothing over a limit stored, and the x/cap counters.
  Value checks and UI.
- **Keep** PE:259 (2026-10-22): the "This note is large" gate applies to notes only.
- **Keep** OB:54, OB:57 (2026-10-05/06): `edit_incidents` kinds.

## 13. Presence and cursors

- **Port (M)** PE:241, PE:245 (2026-10-20): cursor labels show the verified name from room presence, never one the client sends; the C2 design (2 px caret, 20% tint, a name flag shown while active then folded into a 7 px head, flipped near the edge, a palette picked by a server-side hash).
  BlockSuite's widget reads awareness `user.name`, shows the label always (12 px), and takes a random `color` from awareness. Write our own doc remote-selection widget, or patch theirs, to read the `room-presence` map and the server colour (plan change 3, spec change a).
- **Re-decide** PE:247 (2026-10-20): a co-editor's caret on a block void is not drawn.
  BlockSuite draws remote `BlockSelection`s as tinted rectangles over the whole block. → Q10.
- **Keep** PE:246 (2026-10-20): co-editors' mouse pointers are not shown.
  BlockSuite doc mode draws none either.
- **Port (S)** W:207-216 with plan step 3: peers' selections are relative positions resolved once per document version.
  BlockSuite sends absolute `{blockId, index}` in `selectionV2`; the plan already measures the drift.
- **Port (S)** AU:10 (2026-10-10): signed-in viewers hold read channels with no awareness.
  `AwarenessStore`'s constructor writes `selectionV2`, so a read-only BlockSuite instance must not get the room's awareness, or the provider must not send it.
- **Keep** PE:240, PE:242-243, AU:93 (2026-10-20/21): the avatar group, no tooltip, names from the email local part.
  Header and server.
- **Keep** W:466-486 (2026-10-10): the `uploads` awareness field, capped and dropped for read channels.
  It depends on Q3 for which block it names.
- **Keep** Q472, Q477 (2026-10-28, `human/frontend/plate-editor.md`): a
  reconnect from the same editing session rejoins at once with its client id,
  and the stale channel's awareness entry passes to the new channel.
  These live in `roomProvider.ts` and `room.rs`, not in the document layout, so the
  blocks editor gets them for free. Its `selectionV2` rides on the same awareness
  entry.
- **Port (S)** Q475 (2026-10-28): after a `collaboration-client-id` refusal the
  session drops its token and takes a fresh id at once, with no 70 s hold.
  Fresh ids come sooner and more often, so the BlockSuite undo manager must
  follow the doc's client id on every change, not read it once at construction
  (`history-extension.ts:22-23`; plan change 3).

## 14. Checkpoints, history, versions, projection

- **Keep** SQ:3, SQ:4 (2026-09-09/11): no snapshot history, `materials.revision` as the counter, and checkpoints raise no tree event.
- **Keep** PE:111, PE:113, PE:149, PE:135 (2026-10-06…08): projection on idle (30 s), at least every 5 minutes, on demand; the route validates its body once.
  `value()` stands in for the projection (plan boundary 2).
- **Keep** PE:114, PE:119 (2026-10-07): note View stays current (a fresh projection on open, the last projection on failure); Edit always loads the live room.
  The Edit-to-View switch renders "that tab's live document" → it needs a TS `value()` of the store while the bridge stands (plan change 2), and Q6 after the cut.
- **Keep** PE:31, PE:228, PE:252 (2026-09-27, 2026-10-19, 2026-10-22): cloud status icons, and Saved means the server stored the edit.
- **Keep** SQ:34-38, SQ:45-46, SQ:48-50, SQ:69, SQ:91-101 (2026-10-21…27): compaction removed, in-place collection, held deletions, the one-process rule, `names_collected`.
  Generic yrs (plan "Collection and tombstones").
- **Keep** PE:273, PE:276 (2026-10-23): the fork's yrs integrates items whose origin was collected as collected.
- **Keep** AR:27, AR:141 (indexing): source evidence and note indexing read the projected JSON.
  Go and the pipeline (plan "=").

## 15. Markdown, DOCX, HTML import and paste

- **Re-decide** PE:179, PE:186 (2026-10-13, 2026-10-14): Paste and Import Markdown keep MDX, only agent markdown is read without it; markdown footnotes become text.
  BlockSuite's `MarkdownAdapter` has no MDX and makes footnotes into a footnote inline. → Q8 and Q11.
- **Keep** PE:187-188 (2026-10-14): one quiz/flashcards fence parser; a flashcards fence carries fronts and backs only.
  The parser (`blocks.ts`, `markdownConvert.ts`) is shared, whichever converter wraps it.
- **Port (S)** PE:142, PE:144 (2026-10-08): the toolbar import inserts where it ran, splitting at the remembered point if the line is unchanged, else after it.
  Remember the block id and offset, then compare that block's `Y.Text`.
- **Port (M)** plan "Plate packages" `docx`, `juice` with W:430-431: paste from Word and Google Docs.
  This is BlockSuite's HTML clipboard adapter plus our upload step; there is no specific decision beyond images (section 5).
- **Keep** PE:7 (2026-09-18, export part): markdown export inlines quizzes' content.
- **Keep** W:442-443 with PE:167: markdown images in agent-written notes become links.
  Converter rule (Q8 decides where it lives).

## 16. Export and share rendering

- **Keep** PE:63-65, PE:90, PE:102, PE:269 (2026-09-27…10-23): Markdown and DOCX export in a client worker, design A, a native Word TOC, Mermaid without theme or as source on failure, the HTML block as a link.
  The worker consumes the snapshot JSON. `documentAdapters.ts` snapshots through `value()` while the bridge stands (an S change), and the block JSON after D11.
- **Keep** AU:115 (2026-10-27): notes download as Markdown or DOCX without opening the editor.
- **Keep** PE:118 (2026-10-07): the read-only renderer carries no markdown parser.
- **Re-decide** AU:51, AU:55, AU:60, AU:63 with D7 (2026-10-07): shared notes are server-rendered by the site Worker, with islands hydrated at load.
  D7 says the static renderer moves in the cut but not to what. BlockSuite is Lit with no SSR. → Q6.
- **Keep** PE:181, W:3593-3605 (2026-10-13): Note font is a per-browser pick with `data-note-font` set before paint, and shared pages have an Aa toggle.
  CSS variables on `.note-editor`. The BlockSuite theme must map onto them (plan "appearance styles").
- **Keep** AU:56, AU:58, AU:62 (2026-10-07): public pages carry no Sentry, are English-only, and share one not-found panel.

## 17. View mode and read-only

- **Re-decide** PE:158 (2026-10-10): signed-in note viewers join a read-only channel and see edits live, the projection painting first.
  This is either a read-only BlockSuite editor (`store.readonly`) or our renderer over a live `value()`. → Q6.
- **Keep** PE:157 (2026-10-09): the View/Edit switch shows the mode it switches to.
- **Port (S)** AU:33-36, EH:43 (2026-09-29): a frozen or full account drops the open editor to view mode under a read-only strip.
  Toggle `store.readonly` instead of Plate's `readOnly`.
- **Port (M)** PE:251, PE:270 (2026-10-22/23): a room reload swaps renderers: the old one stays paused and selectable while the new one builds hidden, then swaps in, restoring scroll, selection and focus by block id; phones remount in place.
  Two BlockSuite hosts at once on desktop cost memory; measure in piece 6. Selection restores as `TextSelection {blockId, index}`.
- **Keep** PE:271, PE:274 (2026-10-23): a join unfinished after 30 s shows the connection error.
- **Keep** PE:93, PE:165, PE:239 (2026-09-30, 2026-10-13, 2026-10-20): token refresh and reconnect, hidden readers leaving after 5 minutes, idle close.
- **Keep** PE:162, PE:163 (2026-10-10/11): a viewer's whole-state join and the tungstenite buffer patch.
  The blocks state size is measured in piece 6 (server).

## 18. Performance rules

- **Port (S)** W:165-168: long notes render in 32-block chunks with `content-visibility: auto`, padded so drag handles are not clipped.
  BlockSuite renders every block. Port the CSS onto block components and check that the drag-handle widget is not clipped.
- **Port (S)** PE:37 (2026-09-27): the floating toolbar follows Plate playground's editor-relative positioning to avoid scroll lag.
  It anchors inside the editor host's scroll container, whichever toolbar Q4 picks.
- **Keep** EP:1-3, EP:5-6, EP:20 (editor perf): budgets near 1.3x, warn-only deltas, the promotion gate, p95 and blocking per keystroke.
  D8 sets "no worse than Plate"; the BUDGET constants are rebaselined at the cut (plan change 4).
- **Keep** EP:9, EP:17 (2026-10-05, 2026-10-09): heap and latency ceilings follow the optimization round, and an efficiency review closes it.
  They are set on the BlockSuite editor once it replaces Plate.
- **Port (S)** EP:4 (2026-10-04): the collaboration stress test runs "one Office and one Plate room".
  Add a blocks room to `bench/collaboration` (plan change 4).
- **Port (S)** PE:199-201 (2026-10-18): rate-limit numbers were measured from Plate typing and paste (about two updates per pasted paragraph).
  Re-run `pnpm bench:rates` on the BlockSuite editor before the cut.
- **Port (S)** MI:240 (2026-10-18): CI gates the SPA bundle, with never-in rules such as no Plate in Office views.
  Add "no BlockSuite outside note, mindmap and diagram views" and the canvas lazy chunk (D4).
- **Keep** MI:233, MI:260 (2026-10-16, 2026-10-22): the katex override and the removal of `@platejs/math`.
  The override stays while anything ships KaTeX. If the MathLive port lands, BlockSuite's latex KaTeX views go unused.
- **Keep** PE:131 (2026-10-07): HTML frames load with the page and stay loaded.

## 19. i18n and UI chrome

- **Re-decide** PE:16, PE:45, PE:59, PE:300, PE:9, PE:33-35, PE:52, PE:54 (2026-09-22…10-26): our toolbar and popover design (Popover without chevrons, the All blocks look for the slash menu, `ToolbarButton`, frosted floating toolbars, the block context menu anchored to its block, the link editor).
  BlockSuite ships its own slash-menu, toolbar and drag-handle widgets. → Q4.
- **Port (M)** PE:5, PE:11, PE:174 (2026-09-16…10-10): Hugeicons through `EditorIcon`, 16 px icons with stroke 1.8, smaller on phones.
  BlockSuite widgets use `@blocksuite/icons`. Whatever Q4 keeps from them gets our icons.
- **Port (M)** (no single line; I18n rule in `AGENTS.md`, TC:18): every UI string goes through paraglide, and Playwright finds copy through `m.*`.
  BlockSuite's strings are hard-coded English (placeholders, menus, aria labels). Each one we keep needs a paraglide key, or the e2e counterparts cannot find it.
- **Port (S)** PE:12 (2026-09-24): selection-driven purple active states for marks, lists, links, tables and alignment.
  Read `isTextAttributeActive` and block selection from `std`.
- **Port (S)** PE:66 (2026-09-27): a pane-wide editable root with a centred inner container, so margin clicks stay in the editor; Half/Full width.
  CSS on the page root and the note block's container.
- **Port (S)** PE:175-176 (2026-10-10/11): phone font sizes and padding, fluid heading sizes, paragraph spacing.
  CSS on the BlockSuite block views, mapped to our tokens (plan "appearance styles").
- **Port (S)** PE:38-43, PE:50, PE:60 (2026-09-27, 2026-10-01): drag handles visible on long notes, TOC look and smooth scroll, heading handle alignment, a selectable horizontal rule, callout icon alignment and a low-profile variant chooser.
  `capy:toc` island, divider and callout styling, drag-handle offsets.
- **Port (M)** PE:61 (2026-09-27): column borders only in Edit, drag markers at one gap midpoint, no accumulating empty paragraphs.
  `capy:columns` is custom, so drop targets between columns need a drag-handle extension.
- **Port (S)** PE:301-302, MI:279, MI:282 (2026-10-26…28, Q414, Q461): display toggles (font, width, toolbar bolt) in the scroll area's corner; the toolbar is hidden by default per device.
  They sit outside the editor host. Positioning only.
- **Keep** PE:10, PE:13-15, PE:29-30, PE:304 (2026-09-23…10-27): the Connecting loader, `ToolbarButton` styles, 40 px toolbar with scroll fade, shared Toolbar groups, the Study tools popover.
  Our components, kept if Q4 keeps our toolbar.
- **Keep** OF:2, OF:73-74, OF:119, OF:225 (Office decisions that copy the note toolbar).
  They copy styles, not Plate code.

## 20. Question editor and static renderer (D7)

- **Keep** D7 (plan): both move in the same cut. Settled. How is open → Q6, Q7.
- **Keep** PE:17 (2026-09-24): question content is a list of typed blocks with one view each, and editors embed per-block widgets instead of the note editor.
  The text block's editor is the only Plate use (`TextEditor.tsx`, Plate over a `$…$` string). → Q7.
- **Keep** QB:8 (2026-10-02): question images reuse the editor-asset upload, quota, signed-URL and clone machinery.
  API-level, not Plate.

## 21. Tests and journeys

- **Port (S)** TC:20 (2026-10-08): every security finding gets a CI regression test that fails on revert.
  Every notes-crate security test (crafted updates, admission shapes, required keys, media) needs a blocks counterpart before the cut (plan change 4).
- **Port (S)** MI:184 (2026-10-06): a Plate note editing UAT journey holds the note, quiz and card image steps.
  It needs its BlockSuite run before the cut.
- **Keep** TC:1, TC:28 (2026-09-14, 2026-10-14): e2e checks functional outcomes, never layout or styling.
  The BlockSuite e2e counterparts follow the same rule.

## Decisions with no editor side (listed so the pass is complete)

PE:4, PE:18-19, PE:21-22, PE:25-28, PE:104-110, PE:126-129, PE:166, PE:171,
PE:196-198, PE:207-208, PE:211-212 (index rules: Keep, value-level), PE:219,
PE:222, PE:224-227, PE:231-232, PE:234-238, PE:244, PE:253, PE:275-280
(client-id binding: Keep, with plan change 1), PE:296-299, PE:303,
PE:305-306; SP lines other than 4; QB lines other than 8, 65-69, 73, 76; OF
lines other than those cited. These are quiz, flashcard, Office, rate-limit or
binding rules that never touch the note layout.

---

## Questions for Epo

1. **Agent Undo over someone's typing (AR:723).** Today an agent's Undo leaves
   text a person typed into an agent-inserted paragraph, joined to the anchor
   paragraph. On blocks that text is inside the agent's yBlock, so deleting
   the block deletes it. Options:
   a. (recommended) If anyone else's items are in the block's `Y.Text`, Undo
      keeps the block and removes only the agent's characters. Otherwise it
      deletes the block.
   b. Undo deletes the whole block and the typing goes with it, as a table
      cell's typing does today.
   c. Undo moves the other person's text into the previous block, then deletes.
   BlockSuite default: none. Its own undo is per client.
2. **`replace_block` on blocks (AR:703, PE:248).** Options:
   a. (recommended) Replacing a block of the same flavour diffs its `Y.Text`
      in place and keeps its id, so comments, effects and peers' carets stay.
      A flavour change gets a new block.
   b. Keep today's rule: a new block with a new id each time.
   This also settles whether "replace_block mints new ids", which the
   Document comments rule relies on, stays true.
3. **Upload skeleton for co-editors (PE:168).** Answered 2026-10-28: a (D13). The spec writes no
   placeholder, and an image must carry an asset id, so there is no block for
   the `uploads` presence to name. Options:
   a. (recommended) Allow `affine:image` with an empty `sourceId` in the room
      as a placeholder. Peers draw it as the skeleton while someone's presence
      names it and as "Add an image" otherwise. The store still refuses an
      empty source at save, so the "nothing about an upload is stored" part
      changes only to "an empty image block may be stored".
   b. A `capy:upload` block that never reaches the projection.
   c. Only the uploader sees the skeleton, and the block appears when the
      asset id returns (BlockSuite's own flow does this, with a local hash).
4. **Editor chrome (PE:9, PE:16, PE:45, PE:59, PE:300).** Answered 2026-10-28: b, BlockSuite's widgets restyled (D12). Options:
   a. (recommended) Our React toolbar, floating toolbar, slash popup and block
      menu drive BlockSuite commands. BlockSuite's `slash-menu` and `toolbar`
      widgets are not registered; `drag-handle` stays, restyled.
   b. Keep BlockSuite's widgets and restyle them to the decided looks. This
      needs icons and paraglide patches in vendored code we carry across syncs.
5. **Is editor AI (AI menu and Copilot) a cut gate? (MI:225, W:3646).** It is
   behind `VITE_FEATURE_EDITOR_AI`, which is off.
   a. (recommended) No. Mark both rows "dropped until the flag is turned on"
      in the porting inventory, so the cut does not wait on the rewrite the
      Rust harness owns.
   b. Yes, port both before the cut.
6. **What renders read-only notes after the cut (D7: share SSR, View, live
   View, MaterialPreview, unsupported blocks).** Options:
   a. (recommended) Our own React renderer over block JSON. It server-renders
      in the Worker, hydrates islands, draws the unsupported-block placeholder,
      and paints the live View from the read channel's `value()`.
   b. A read-only BlockSuite editor for app View and live View, plus a separate
      SSR renderer for share pages: two renderers.
   BlockSuite has no SSR, and its Lit components need a DOM.
7. **The question `TextEditor` (D7, MI:223).** Options:
   a. (recommended) BlockSuite's standalone `InlineEditor` (`framework/std/inline`)
      bound to the item room's `Y.Text`, with a MathLive latex inline spec and
      our gap spec. Notes and questions then share one inline engine and
      `limitUndo`.
   b. A plain text field with `$…$` and a MathLive preview, no rich inline.
8. **Markdown conversion after D11 (AR:394, PE:116, PE:136-139, PE:179).**
   Options:
   a. (recommended) Keep our converter (`markdownConvert.ts`, MDX for paste
      and import, plain for the agent, one fence parser) emitting block JSON,
      in the browser and in the server's V8. The budgets and prescan stay.
   b. BlockSuite's `MarkdownAdapter`. It has no MDX, footnotes become an
      inline, and whether it runs in V8 without a DOM is unverified.
   c. A Rust converter, dropping V8.
9. **Limits in block terms after D11 (SQ:6, PE:223).** Options:
   a. (recommended) Nodes count blocks plus inline embeds (mentions, inline
      equations) plus table cells. Depth is nesting depth with lists capped
      at 8. 2 MiB applies to block JSON, re-measured on the near-limit note so
      the same content fits.
   b. Keep measuring on a Plate-shaped projection forever. That contradicts
      D11, which deletes the converter.
10. **Remote block selections (PE:247).** BlockSuite tints the whole block a
    peer has selected. Options:
    a. (recommended) Hide remote block selections, as decided for carets on
       block voids.
    b. Show BlockSuite's tint.
11. **Markdown footnotes (PE:186).** BlockSuite has a footnote inline that
    draws them. Options:
    a. (recommended) Keep "footnotes become text" until a footnote design is
       asked for.
    b. Adopt AFFiNE's footnote inline, a new block-JSON attribute and export
       rules.
12. **Block ids on paste (W:358-361).** BlockSuite gives every pasted block a
    new id. Options:
    a. (recommended) A paste middleware keeps a pasted block's id when no live
       block holds it, as `stableElementIds` does today, so a cut-and-paste
       keeps its threads and effects.
    b. Accept new ids. A cut-and-paste then moves threads to Document comments
       and reads as a delete plus an add.
13. **BlockSuite UX we have no decision for.** Answered 2026-10-28: b, keep the free ones (D14). This covers heading and list
    folding (`collapsed`), code wrap and line numbers, image pixel resize,
    and the `@` linked-doc menu. Options:
    a. (recommended) Switch each one off until parity, recording each switch
       in the parity list.
    b. Keep whichever ones are free.
14. **Spec T1 and T2, as the decisions bear on them.** T1 answered 2026-10-28: drop merging (D15). T2 still open. T2: PE:141's single
    "<n>%" check across five resizable blocks favours keeping `widthPercent`
    (recommended) over pixel widths. T1: no decision defends merged cells or
    block content in cells, and export already falls back to HTML for rich
    tables. Dropping merges (recommended) is consistent with them.
15. **Ghost text, if Q5 says port.** Options:
    a. (recommended) An overlay widget reading the inline editor's range.
    b. Drop Copilot and keep only the AI menu.

Already settled and not asked again: comments relational (D5, spec
"Comment anchors"), the undo manager (D6), the question editor and renderer
moving in the cut (D7, but not how, hence Q6 and Q7), content switching to
block JSON (D11), repair on entry (D3), no speed gate (D8), Plate everywhere
until the cut (D1).

## Changes to the plan and spec

### `todo-blocksuite-layout.md`

a. **Awareness.** BlockSuite itself writes `selectionV2` (in `AwarenessStore`'s
   constructor) and `color` (`RemoteColorManager`, random, kept in session
   storage). It does not write `user`. Following PE:241 and PE:245: write no
   `user.name` (labels come from `room-presence`), replace `color` with the
   server-hashed palette colour, and give read-only instances no awareness
   (AU:10). Fix the line that says "BlockSuite writes … `user: {name}`. We keep
   both".
b. **Default props are written on load.** `sync-controller.ts:309-317` writes
   every non-`undefined` schema default the yBlock lacks, from any browser that
   opens the room, readers and pre-adoption tabs included. `state_from_value`
   must write them all, and the structural check's prop list must be "schema
   defaults plus ours". Per flavour that adds:
   - paragraph and list: `collapsed`;
   - code: `wrap` and `caption` (`preview`, `lineNumber` and `collapsed` are
     undefined, so not written);
   - image: `caption`, `sourceId`, `width`, `height`, `size`, `index`, `xywh`,
     `lockedBySelf`, `rotate`;
   - latex: `xywh`, `index`, `lockedBySelf`, `scale`, `rotate`;
   - callout: `icon`, `text`, `backgroundColorName`.
   The custom flavours should declare no defaults they do not mean to store.
c. **Figure `block` shape.** `native2Y` is deep, so `labels`, `series[i].values`
   and other leaf arrays become `Y.Array`s, not "the same shape the Plate room
   uses". Either state that shape exactly (for Rust `value()`, admission and
   MSW) and add "writers assign whole fields, never splice", or store leaf
   arrays as plain JSON values through a custom transform.
d. **Naming.** Rename `capy:html` to `capy:html-embed` (PE:185). Add a
   `flavour` column to the embed catalog (`embeds.json`, TS, Rust), so the
   catalog stays the one list every layer tests against.
e. **Image props.** `name` (alt text, SQ:90) and `contentType` are ours, not
   BlockSuite's. Mark `name` "ours". `caption` is a plain string on
   `affine:image`, so caption marks are dropped: add it to N6.
f. **Parent and child rules.** Callout children are only paragraph and list.
   `affine:table` sits only under `note`, and `affine:latex` under note,
   paragraph or list. Add normalizations for Plate content that breaks these
   (an image or code block in a callout, a table in a column), or extend the
   vendored schemas and list it in `vendor/blocksuite/README.md`.
g. **Upload placeholder.** Per Q3, either allow an empty-`sourceId` image in
   the room or add a placeholder flavour. The "transient elements are never
   written" line then changes.
h. **Never written.** Add the block `comments` prop (and the inline
   `comment-<id>` attribute already listed) to the never-written list (D5).
i. **Unknown flavours.** The structural check refuses a flavour the catalog
   does not list, since BlockSuite cannot load one. Read renderers show the
   unsupported-block placeholder (PE:184).
j. **Nesting bound.** Depth at most `LIST_INDENT_MAX` (8) in the structural
   check. `value()` never emits `indent` above 8 (PE:223).
k. **Style values.** `color`, `background`, `fontSize`, `fontFamily` and
   `listStyleType` hold no `;` or control characters (Q380). Admission checks
   `Y.Text` attributes as well as props.
l. **Required props per flavour** (W:402-420): `sourceId` (an asset id; empty
   only under Q3 a), `materialId` and `refKind`, `source`, `provider` and
   `videoId`.
m. **Empty note repair.** A `note` with no children gets one empty paragraph
   on entry (AR:699), not only at seed.

### `todo-blocksuite-spike.md`

1. **Undo and client ids.** `trackedOrigins` is captured once
   (`history-extension.ts:22-23`), but a reconnect can take a fresh client id
   (PE:280, Q236). Step 3 and D6: on every id change, add the new id to
   `undoManager.trackedOrigins`, beside building the store after adoption.
2. **The TS converter is production code.** Q229's editable saved copy
   (EH:89), the Edit-to-View live render (PE:114) and room swap need a browser
   `state_from_value` and `value()`. Change piece 2's "The same in TS, for the
   bench and MSW".
3. **New porting-inventory rows.**
   - the remote-selection widget with verified labels, the C2 flag and the
     server palette (PE:241, PE:245), with `RemoteColorManager` replaced;
   - the comment highlight overlay (no decorations, no document writes);
   - the upload pipeline around gateway asset ids: `FileDropExtension`, the
     HTML paste image step, the blob source, refusing anything but image and
     audio (PE:167, PE:169, PE:192);
   - MathLive views replacing the KaTeX latex block and inline, with the
     `inertTex` guards (PE:20, PE:77, PE:191);
   - key bindings: unbind `Mod-k`, ⌘/ palette, ⇧⌘M, ⇧⌘S (MI:220, MI:224);
   - paraglide for every BlockSuite string kept (placeholders, menus, aria);
   - not registering attachment, bookmark, `embed-*`, database and linked-doc;
   - `content-visibility` chunking;
   - spellcheck off in code;
   - the note-never-empty repair;
   - a paste id middleware (Q12);
   - the children pass reading `capy:material-ref` and `affine:image` props;
   - `liveRange.ts` and `documentStats.ts` against the store.
4. **Gates and benches.** Before the cut:
   - a blocks room in `bench/collaboration` stress (EP:4);
   - `bench:rates` re-run on BlockSuite typing and paste (PE:199-201);
   - BUDGET constants rebaselined (EP:2);
   - a blocks `assert_canonical` admission/save parity test (PE:205);
   - a BlockSuite run of the UAT note journey (MI:184);
   - a blocks counterpart for every notes-crate security regression test
     (TC:20);
   - an SPA bundle never-in rule keeping BlockSuite out of non-note views
     (MI:240).
5. **Cut checklist.**
   - raise `CLIENT_PROTOCOL` and `MIN_MATERIAL` so Plate tabs reload (PE:195);
   - delete `patches/@slate-yjs__core@1.0.2.patch` (PE:159);
   - redefine limits per Q9;
   - re-measure Q411's bind-merge apply cost and close its perf-track item if
     it is gone (EH:104);
   - keep the katex override only while something ships KaTeX (MI:260).
6. **Boundary 3 (agent).** Before agent writes open on blocks, note that
   AR:723's "typing stays" (Q1) and `replace_block` (Q2) need answers.
7. **The "Plate packages" table, `comment` row.** Add that highlights need
   the overlay (row 3 above), because BlockSuite's highlight is the in-document
   attribute D5 rejects.
