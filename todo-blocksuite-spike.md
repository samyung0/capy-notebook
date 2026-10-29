# BlockSuite notes: built beside Plate, then a clean cut

Status: step 1 started 2026-10-28 on branch `blocksuite-notes` (worktree
`.claude/worktrees/blocksuite-notes`, from main `872c5ba6b`). Piece 1's layout
spec is `todo-blocksuite-layout.md`. The direction below is Epo's (2026-10-27).

## What we are building

A Capy note on BlockSuite's model instead of Plate's.

- **Plate's model today:** Slate keeps its own copy of the document, and
  slate-yjs mirrors it into Yjs as nested `Y.XmlText`.
- **BlockSuite's model:** each block is a `Y.Map` in one flat `blocks` map,
  parents hold ordered child ids, and each block's text is a `Y.Text` the
  editor edits directly.
- **Why it matters later:** that model is also what a note-plus-canvas design
  (cards, surface, mindmaps) would build on.

## Direction (Epo, 2026-10-27)

- **Build it beside Plate, not as a replacement in place.** Every real
  material stays on Plate until the cut. The BlockSuite layout exists only on
  dev stacks and in the bench, switched on by a stack-wide flag (boundary 1),
  and is compared with Plate on the same bench while it catches up.
- **Plate notes are nearly frozen.** They take bug fixes and a few small items,
  for example a "Table View" block or UI and UX touches. Each one is recorded in
  the parity list below, so the BlockSuite side catches up.
- **A clean cut at the end.** Nobody uses the half-built layout, and there is no
  production data or legacy data, so nothing migrates. When the BlockSuite note
  reaches parity, notes switch over and the Plate note editor goes.
- **Step 1 is the note editor alone,** with the side-by-side comparison. No
  canvas.

## Why

- **The editor's numbers today** (`bench/editor/scripts/editor.perf.ts`, near-limit
  note of about 2 MB and 7.4k nodes from `noteContent/loadTest.ts`):
  - interactive open takes about 15 s, measured unthrottled, about 11 s of it
    blocking;
  - typing at CPU x4 blocks about 209 ms per keystroke;
  - the save cycle blocks about 362 ms.
- **Costs that come from the model, not our code:**
  - two copies of the content with a translation in both directions, mirrored
    again in Rust;
  - path addressing;
  - a block move is a deep copy, a delete and a re-insert (`moveNode` in
    `@slate-yjs/core`). A co-editor's typing inside the moved block is lost,
    and comment anchors inside it probably collapse (not tested).
- **BlockSuite:**
  - addresses blocks by id;
  - moves a block by moving its id between `sys:children` arrays, so content
    and anchors stay;
  - re-renders one block per keystroke.

  Whether that shows up in our numbers is step 1's job.

## Source, licence, vendoring

- **Where from:** AFFiNE `canary`'s `blocksuite/`, pinned to one commit (canary
  was `5f19254997` on 2026-10-26).
- **Licence:** MIT at 0.27.5. npm `@blocksuite/*` stopped at 0.22.4 in July 2025.
  The old standalone `toeverything/blocksuite` repo was MPL-2.0; take nothing
  from it.
- **How:** copy it into `vendor/blocksuite/` as plain files, not a submodule.
  Record the commit and the package list in `vendor/blocksuite/README.md`. Epo's
  lean (2026-10-27): BetterOffice also moves in-tree once the repo is private,
  as AFFiNE keeps BlockSuite in its own repo. Upstream syncs are then a re-copy
  from a newer commit, with our changes reapplied as a diff.
- **The page blocks pull in the canvas.** `blocks/root` depends on `database`,
  `surface`, `frame`, `edgeless-text`, `data-view` and eight `gfx-*` packages.
  `note`, `image`, `embed`, `drag-handle` and `remote-selection` depend on
  `block-surface`. `foundation` depends on `data-view`, and `paragraph`, `code`
  and `note` on `gfx-turbo-renderer`. `shared` pulls in `pdfmake`; `code` pulls
  in `shiki`.
- **Build risks to clear in piece 1:**
  - BlockSuite pins zod `^3.25`, and we use `^4.6.6`;
  - there must be exactly one `yjs` instance;
  - the vanilla-extract `.css.ts` files need a Vite plugin;
  - `customElements.define` throws on a second registration under HMR or
    StrictMode;
  - upstream builds with yarn (`yarn run -T tsc`);
  - `@toeverything/theme` and `@blocksuite/icons` come from npm, outside the
    copy.
- **The canvas packages are vendored too** (Epo, 2026-10-27, D4). They sit in a
  lazy chunk nobody loads yet, and are ready when the canvas comes. There are no
  import patches to carry across syncs.
- **Branch:** a worktree branch (`blocksuite-notes`) until step 1's comparison
  is in.

## Boundaries while both exist

1. **How the layout is chosen (Epo, 2026-10-27: Plate everywhere until the cut).**
   - No new material kind and no per-material switch. Material kinds stay
     exactly as they are.
   - A new kind would have cost a lot: about 20 Go `kind == "note"` branches
     (indexing `store/queries.go:1302`, embedded-quiz reconciliation
     `yjs_documents.go:254`, trash, share and clone in `share.go`,
     `materialdoc/preview.go:101`, `document.go:391`), plus the
     `materials_kind_check` constraint, the OpenAPI enums, the `materials`
     lists in `embeds.json`, several `kind === 'note'` checks in TS, and
     `room.rs` `sessioned()`.
   - A stack-wide flag picks the room layout:
     - the collaboration server's `COLLABORATION_DOCUMENT_LAYOUT` (`plate` or
       `blocks`, name to settle);
     - the browser's matching `VITE_` flag;
     - MSW's switch.
   - UAT and production never set it. A dev stack that turns it on resets its
     rooms; they reseed from `materials.content` through `state_from_value`.
   - The cut changes the default to `blocks` and then deletes the flag along
     with the Plate path.
2. **Downstream contract.** `value()` projects the block layout to today's
   Plate-shaped material JSON. Go `materialdoc`, RAG indexing, previews, share
   pages, exports and the agent's reads keep working on that JSON.
   - It is a bridge for while both editors exist. In the cut, the stored
     content and everything downstream switch to block JSON, and the bridge is
     deleted (D11).
   - `value()` must give every element a deterministic id, including
     `code_line`, table cells and inline elements, because
     `NotePendingChanges` aligns blocks by id.
   - There are three implementations to keep equal: Rust, the TS converter, and
     MSW's (`mocks/collaboration.ts:125-192,310` reads the XmlText today).
3. **Agent.** It reads the new layout through `value()` from the start, and
   writes nothing to it until edit commands by block id exist. The content save
   path (`edits.rs:1326`) refuses the new layout explicitly.
4. **Browser.** The BlockSuite editor is used only for the new layout. Shared
   pieces (icons, embed previews, figure components) are reused as React
   islands, not copied.
5. **Embeds keep one editor per document.**
   - One room is one document is one editor host.
   - An embedded material is a `material_ref` to another room with its own
     light UI, never a second document editor.
   - An embedded note shows read-only and opens to edit.
6. **Plate freeze rule.** Plate notes take bug fixes and the small items above,
   each recorded in the parity list. Anything bigger is built on the BlockSuite
   side only.
7. **The cut covers every material (Epo, 2026-10-27).**
   - Notes, mindmaps and diagrams all move to the blocks layout. Mindmaps and
     diagrams are Plate documents today (`Model::Note`, `model.rs:1-4`) holding
     one `mermaid` block, so they become block documents with one Mermaid
     block. `liveMermaid.ts` reads the `content` XmlText and has to follow.
   - Quizzes and flashcards are already `Model::Item`. But agent reads on item
     rooms rebuild a Plate Y.Doc from `value()` through `slate_yjs`
     (`edits.rs:384-408`). That path moves to the blocks layout or to plain
     JSON in the same cut.
   - Then `slate_yjs.rs`, `plate.rs`, `repair.rs` and the Plate note editor are
     deleted, along with the layout flag.
   - `materials.content` and everything downstream switch to block JSON, and
     both converters are deleted (D11).
   - Reset UAT's test materials. Production is not published before the cut,
     so UAT holds the only data.
   - The question `TextEditor` and the static renderer follow in the same cut
     (D7).
   - The canvas (later) replaces the mindmap type itself. Until then a mindmap
     is a block document with one Mermaid block.

## Effects and collection (Rust harness, 2026-10-27)

**Read the current code on `train/2026-10-27-release`,** not main. It was
pushed early at `0ca84842d`; the final push adds the agent-edits room work
(Q402, Q417, Q432). Step 1 starts from the release branch once it lands.

**Note effects:**
- There is no incremental path for notes. Effects are one full pass, cached
  per revision: `NotePendingChanges` compares `MaterialIndexText` blocks from
  `materials.content` with `materials.indexed_blocks`, aligned by element id.
  Q415's per-revision column and Q417's live read are on the release branch.
- With `value()` giving today's JSON and stable element ids, the Go side and
  the pipeline need no change. Q417's detailed read of the open room projects
  through the room's model (`edits.rs` `live_value`); `from_doc`, which was
  never called, was deleted 2026-10-29.
- Ids `value()` invents inside a block (code lines, table cells) must not shift
  when a line is inserted. Otherwise one inserted line reads as many changed
  lines. Settle it in the layout spec.

**Incremental effects** (Q437) are Office only for now, after the release.
- An after-transaction observer marks dirty units (stories, cells, slides) and
  walks the delete set, comparing against a (hash, text) baseline per unit.
  The plan is capy-harness `2026-10-17-effects-misses/PLAN-effects-reader.md`.
- A blocks note could get the same reader cheaply, since block ids are its
  units:
  - a changed `blocks` key or Y.Map attribute marks that block dirty;
  - a `Y.Text` delta marks its block;
  - a `sys:children` change is an add, remove or move.
- That is new work, not a port, and not part of step 1.

**Collection and tombstones:**
- These parts are generic yrs and carry over unchanged:
  - `ydoc::gc::collect` and `names_collected` (`crates/ydoc/src/gc.rs`); the
    only special root is `CONTRIBUTORS_ROOT`;
  - sessions, held deletions, windows and folds;
  - the late merge's stable-left placement.
- The swap guard compares the projected value before and after, so it needs
  `value()`.
- The layout-specific parts are in the porting list: the notes crate's
  commands, repair and limits, plus the browser's merge and detector code.
  Those, not effects or collection, are the biggest cost of the switch.
- The flat layout grows tombstones more slowly than slate-yjs: a move rewrites
  one id instead of the whole block.
- For the canvas later: dragging rewrites `xywh` on every step, and each write
  leaves an item behind. Write it on drop, or at a throttled rate.

## Step 1, in order

### 1. The Yjs layout spec (first deliverable)

Write down, before any code:
- the keys (`sys:id`, `sys:flavour`, `sys:version`, `sys:children`, `prop:*`);
- the flavours we use and the props of each;
- which props `native2Y` turns into `Y.Map` or `Y.Array`;
- how BlockSuite ids map to Plate element ids.

Take the prop rules from BlockSuite's model schemas (`affine/model`), not from
our catalog. Their table block is flat data: cells are `{text}` with dotted prop
keys, not child blocks (`table-model.ts:11-65`).

Every piece below depends on this spec: the converters, MSW, `value()` and the
structural check.

### 2. Converters

- **Plate value → blocks, in Rust.** This is production code, not a test aid.
  `state_from_value` seeds every room from `materials.content`
  (`note_store.rs:143`, `edits.rs:362`): creation, clone, and trash restore,
  which bumps `room_schema`. It must produce the root, note and paragraph
  blocks an empty note needs, because the browser makes no edits at init (see
  client ids below).
- **The same in TS,** for the bench and MSW.
- **`value()`, blocks → Plate JSON,** in Rust and in MSW.
- **A round-trip test:** value → blocks → value is equal for every supported
  type, ids included.

### 3. Mount and sync in the browser, on MSW only

`Model::Note` admission refuses anything but XmlText content, so the real
server can't hold the new layout until piece 5. These pieces run on MSW's
in-memory doc.

- **The editor:** a `BlockSuiteNote` React component that builds the page
  editor from `std` plus the specs, behind a dev-only switch.
- **The workspace BlockSuite expects:** a root doc with `spaces` subdocs and
  `meta.pages` (`test/test-doc.ts:22-27`, `test/test-meta.ts`). Write our own
  Workspace/Doc over one room doc, plus a blob source for images.
- **Client ids:**
  - BlockSuite writes with the doc's current client id (`store.ts:384`), but
    its undo captures the id once, at construction
    (`history-extension.ts:22-23`).
  - `roomProvider.ts:733-743` changes the client id when the token arrives,
    and the room refuses edits made before that as `unassigned`.
  - So build the store only after the id is adopted, and make no edits at init.
- **Awareness:** their `AwarenessStore` writes `selectionV2` and `user`, while
  `roomProvider.ts:737` calls `setLocalState` and `uploadPresence` writes its
  own fields. Settle one set of field names so neither overwrites the other.
- **Undo:** D6.
- **Remote selections:** use their widget. Their selection stores an absolute
  `{blockId, index}`, so measure how far it drifts under concurrent typing.

### 4. One custom block: `capy:material-ref`

**Built 2026-10-28** (`blocksuite-notes`). The block's Lit view owns one
`div`. `BlockSuiteNote` renders the existing `AppEmbedEdit`/`AppEmbedView` into
it through a React portal (one root for the note), and the embedded rooms join
through the note's seat, as on Plate. Island cost (dev build): about 50 ms to
mount, about 6 MB per loaded quiz ref (the quiz editor and its room docs, the
same as on Plate), and about 80 KB for a ref still off screen. BlockSuite
blocks the layout refuses (database, attachment, bookmark, embeds, frame,
surface …) are not registered.

- The quiz and flashcards embed: a custom schema, a void block, a React island
  inside Lit, and another room read through `itemRoom`.
- AFFiNE's `blocks/embed` is link embeds (Figma, GitHub, Loom, YouTube, iframe,
  HTML) behind a link-preview service, so it is no model for this.
- Measure what the React island costs per block.
- Server-side, this block needs the embedded-quiz reconciliation in
  `yjs_documents.go:254`. It keeps working, since the kind stays `note` and Go
  reads `value()` JSON.

### 5. Server: a blocks room

`Model` has more arms than projection. A blocks arm needs each of them:
`assert_roots`, `value`, `document_value`, `stored`, `measure`,
`repair_on_entry`, `repairs`, `repair`, `validator` (`model.rs:43-149`).

`room.rs` also reads `CONTENT_ROOT` directly, each needing a blocks path
(lines on main `872c5ba6b`):
- the child pass, which repoints pasted images and material refs and is skipped
  for non-Note models (`:1946-1997`, the read at `:1969`);
- applying the child pass's answer (`:2053`);
- the heavy-update scan (`:3299`, `limits::heavy` is XmlText only);
- `sessioned()` (`:555-559`) decides sessions, the late path and
  `stored_version`; blocks rooms are sessioned.

The repair after an Undo is in `edits.rs:1056`, which the blocks layout refuses
anyway (boundary 3). `Model::of(kind)` (`model.rs:23`) has eight callers; a
process-wide layout read in `of()` returns `Model::Blocks` for `kind == "note"`
only, so none of them change and mindmaps and diagrams stay Plate in step 1
(`liveMermaid.ts:39` reads the XmlText).

The rest of the room work:
- **Structural check:**
  - every block reachable from the root, under exactly one parent;
  - no dangling child ids;
  - each flavour under a parent it allows;
  - props match the spec.
  
  Normal concurrent edits break the first two: two people moving one block put
  its id under two parents, and a delete racing a move leaves a dangling id.
  They are repaired on entry (D3).
- **Fuzz** with concurrent BlockSuite clients, not only `fuzz_admit`-style
  crafted updates. The gate below sets a case count.
- **Limits** are measured on the projection, as `Model::Item` does
  (`model.rs:91`), so the room and the store can't disagree.
- **Without a growth bound** (`bound.rs`), every update copies the room and
  projects it again (`items/src/validator.rs:84-115`). The copy alone is
  15–19 ms on the near-limit note. Either port the bound in step 1, or report
  the server numbers as pessimistic.
- **Comments:** stay relational, with anchors as relative positions in a block's `Y.Text` (D5).

### 6. Measure

**First GHA numbers, 2026-10-28** (Performance run 40686635416, `blocks`
input, CPU x4 except open; BlockSuite as integrated, before any tuning):

| Case | Plate | BlockSuite |
| --- | --- | --- |
| Open, near-limit | 14.1 s | 77.5 s |
| Open, common subset | 14.3 s | 75.0 s |
| First key after open, to frame | 195 ms | 1,532 ms |
| DOM nodes after open | 35.6k | 298.6k |
| JS heap after open | 336 MB | 282 MB |
| Typing, near-limit: blocking per key / p95 | 63 / 144 ms | 777 / 1,128 ms |
| Typing, common: blocking per key / p95 | 24 / 88 ms | 757 / 1,088 ms |
| Typing, small: blocking per key / p95 | 0 / 40 ms | 0 / 24 ms |
| Scroll, near-limit / common | 35.6 / 52.5 FPS | 11.5 / 11.2 FPS |
| Peer burst, 2,000 keys | over 10 min (timed out) | 220 s, apply p95 9 ms |

- **Open:** one task of about 19.6 s runs after the material fetch
  (`Response.text.then`), then BlockSuite renders every block at about 40 DOM
  nodes each.
- **Typing:** the cost per key grows with the document size, with
  `AFFINE-PAGE-ROOT.onbeforeinput` taking 0.7–1.1 s a key. On a small note
  BlockSuite is at least as fast as Plate.
- **Floor:** this is far below D8's "no worse than Plate" for large notes.
- **Profiled and tuned, 2026-10-28** (laptop, `editor.perf.ts --grep
  near-limit`, before → after; uncommitted): open 44.9 → 24.7 s with its
  blocking 12.6 → 1.8 s, first key 970 → 653 ms to a frame, typing 505 →
  276 ms blocking a key (p95 768 → 448), scroll 20.8 → 39.9 FPS. Causes and
  fixes: O(n) `root`/`getParent` per block rendered and per key, an O(n²)
  store load, `collapsedSiblings` per paragraph and every block's
  selection subscriber (vendor README local change 6); Chrome walking the
  whole editable page root on each `Selection.addRange`, cut by
  `content-visibility: auto` on top-level blocks (`pageEditor.css`); and in
  the harness, MSW matching each of ~3,400 dev modules against every
  handler (`src/mocks/browser.ts` passes them through). Left in a key:
  `EditorHost.updateComplete` awaits every block, rich text and inline
  element (`range-binding.ts:176`, `:303`; about 40%), and each block's
  `selected$` and placeholder effect rerun on every selection change
  (`block-component.ts:40`, `paragraph-block.ts:155`; about 20%).
- **Same run, Plate's budgets:** read-only open was 4,747 ms against its
  4,050 budget, already over on main's last run (4,286 ms, Oct 23). Scroll
  was 35.6 FPS against 38, where main had 45.5; the measurement code is
  unchanged, so it comes from the merged main commits or noise.

**After the first tuning round** (run 40706193353, `08379c98b`; O(n) open,
`content-visibility`, MSW module passthrough):

| Case | Plate | BlockSuite |
| --- | --- | --- |
| Open, near-limit / common | 12.4 / 12.3 s | 41.6 / 39.1 s |
| Open blocking | 6.0 s | 4.0 s |
| First key after open, to frame | 189 ms | 821 ms |
| DOM nodes after open | 36.3k | 287.7k |
| Typing, near-limit: blocking per key / p95 | 73.5 / 144 ms | 292 / 392 ms |
| Typing, common: blocking per key / p95 | 30.6 / 104 ms | 307 / 616 ms |
| Typing, small: p95 | 48 ms | 16 ms |
| Scroll, near-limit / common | 43.2 / 47.5 FPS | 27 / 23.6 FPS |
| Peer burst, 2,000 keys | over 10 min (timed out) | 114 s |

The remaining per-key cost is BlockSuite waiting on every block's
`updateComplete` after a selection change (about 40%) and every block's
`selected$` re-running (about 20%). DOM weight is about 39 nodes per block
against Plate's 5.

**Second tuning round, 2026-10-29** (laptop, `editor.perf.ts`, uncommitted;
vendor README local change 7). BlockSuite before → after on the near-limit
note: open 25.3 → 7.4 s, first key 580 → 147 ms, DOM 288k → 182k nodes
(75 → 46 a paragraph), typing 297 → 79 ms blocking a key (p95 416 → 176),
scroll 38.5 → 41.9 FPS. Range syncs wait only for the blocks they read,
`selected$`/`focused$` read a per-block selection index, the selection
overlay and placeholder render only when shown, and the editor chunk loads
while the room fetches its token. The open's wall time was mostly the
harness: Playwright locators walk every shadow root; BlockSuite now waits
natively. Same run, Plate → BlockSuite:

| Case | Plate | BlockSuite |
| --- | --- | --- |
| Open, near-limit / common | 8.4 / 7.6 s | 7.4 / 7.2 s |
| First key after open | 110 ms | 147 ms |
| Typing, near-limit: blocking / p95 | 16 / 80 ms | 79 / 176 ms |
| Typing, common: blocking / p95 | 0.7 / 56 ms | 90 / 176 ms |
| Scroll, near-limit / common | 48.9 / 54.6 FPS | 41.9 / 37.2 FPS |
| Peer burst, 180 s box | 408 keys, 2.3/s | 2,000 keys in 65 s, 30.6/s |

Still worse than Plate: typing, scroll, first key, DOM. Left in a key: the
native `addRange`/`removeAllRanges` over the large editable tree (about a
third), GC, and every block's inline range provider hearing each selection
change. Left per paragraph: Lit's part markers (about 30 comments) and the
inline editor's nesting. Open in dev still waits on ~2,300 BlockSuite modules
and two 1.1 s MSW fetches; GHA numbers pending.

**After the second tuning round** (run 40721065477, `88a167676`; every
Plate budget green). Compare within the run; GHA varies between runs.

| Case | Plate | BlockSuite |
| --- | --- | --- |
| Open, near-limit / common | 9.2 / 9.9 s | 9.4 / 9.5 s |
| Open blocking | 3.4 s | 2.2 s |
| First key after open, to frame | 120 ms | 138 ms |
| JS heap after open | 337 MB | 273 MB |
| DOM nodes after open | 35k | 181k |
| Typing, near-limit: blocking per key / p95 | 21 / 88 ms | 27.7 / 112 ms |
| Typing, common: blocking per key / p95 | 2.1 / 72 ms | 36.4 / 128 ms |
| Typing, small: p95 | 40 ms | 24 ms |
| Scroll, near-limit / common | 55.9 / 58.9 FPS | 27.4 / 32.4 FPS |
| Peer burst (180 s box) | 1.2 keys/s, 225 applied | 16.3 keys/s, all 2,000 |

Still below D8's floor on common-note typing, scroll and DOM weight.

**After the third tuning round, on GHA** (run 40732888335, `4bc98c28f`;
this runner was slower for both editors, so compare within the run):

| Case | Plate | BlockSuite |
| --- | --- | --- |
| Open, near-limit / common | 11.3 / 13.2 s | 13.1 / 13.5 s |
| Open blocking | 5.2 s | 3.5 s |
| First key after open, to frame | 182 ms | 134 ms |
| JS heap after open | 336 MB | 273 MB |
| DOM nodes after open | 35k | 183k |
| Typing, near-limit: blocking per key / p95 | 64.9 / 144 ms | 22.5 / 96 ms |
| Typing, common: blocking per key / p95 | 31.3 / 104 ms | 23.3 / 96 ms |
| Typing, small: p95 | 48 ms | 24 ms |
| Scroll, near-limit / common | 44.8 / 50.6 FPS | 57.8 / 56.7 FPS |
| Peer burst (180 s box) | 1.3 keys/s | 38.1 keys/s |

BlockSuite is around Plate or better on every case, which meets D8 as relaxed.
The run's one failure was Plate's own read-only open budget (Plate's static
view, which this branch doesn't touch; main's last run was over it too).

- **Server (load-test note, Plate vs blocks):** room load 71 vs 560 ms
  (replay 15 vs 291 ms), memory kept 7 vs 16 MB, `value()` 13 vs 20 ms, a
  joiner's step-1 answer 5 vs 9 ms. A keystroke's admission went from about
  85 ms to 0.03–0.08 ms with the growth bound (`blocks/src/bound.rs`).
  Formatting, Enter, paste and moves still take the exact check.

**Third tuning round, 2026-10-29** (laptop, `editor.perf.ts`, uncommitted;
vendor README local change 8). Scroll spent its frames in Chrome, not in
JS: with `content-visibility: auto` on each of the ~3,400 top-level blocks,
the visibility check (`IntersectionObserverController::computeIntersections`,
1.5 s in 4 s of scrolling against Plate's 0.26 s) and hit testing (0.8 s
against 0.08 s) walked every box each frame. The page note now renders its
blocks in chunks of about 32 (a block whose id hashes to it starts one, so
an edit moves no other block between chunks), and the chunk carries
`content-visibility`, as Plate's `data-slate-chunk` does. That also cut the
per-key cost, which was mostly the same per-frame work. Same session, Plate →
BlockSuite before → after:

| Case | Plate | BlockSuite before | BlockSuite after |
| --- | --- | --- | --- |
| First key, near-limit / common | 108 / 83 ms | 147 / 393 ms | 109 / 87 ms |
| Typing, near-limit: blocking / p95 | 16 / 88 ms | 89.5 / 256 ms | 8.9 / 88 ms |
| Typing, common: blocking / p95 | 0.7 / 56 ms | 92.5 / 176 ms | 4.8 / 72 ms |
| Scroll, near-limit / common | 49.5 / 54.8 FPS | 38 / 38.6 FPS | 58.9 / 58.5 FPS |
| DOM nodes, near-limit / common | 35k / 37k | 182k / 177k | 183k / 179k |

DOM weight is unchanged and not chased (D8 relaxed, 2026-10-29): about 45
nodes a paragraph, 29 of them Lit's comment markers, against Plate's 5 per
block. The islands' React commits during typing were not traced (scope cut
the same day). GHA numbers pending.

**Browser:** a BlockSuite variant of the `bench/editor` specs. **Plate is
measured on the common-subset document too**, because no baseline exists for
it.
- The common subset is paragraphs, headings, lists, code, tables, quotes,
  callouts, images, inline equations, links and `material_ref`, at equal size.
- The full load-test note is reported with placeholders, and weighs less.

| Spec | How it runs | Plate today (GHA median) |
| --- | --- | --- |
| interactive open, near-limit | unthrottled | 15,165 ms |
| typing, small: blocking per keystroke / p95 | CPU x4 | 0 / 56 ms |
| typing, near-limit: blocking per keystroke / p95 | CPU x4 | 209 / 304 ms |
| save cycle blocking, near-limit | CPU x4 | 362 ms |

- Read-only open is reported but not compared. It is mostly the workspace
  page's startup (`editor-perf.md`).
- Scroll FPS is reported but not gated. GHA noise keeps it out of the relative
  table (`editor-perf.md`).
- Also report: JS heap after open, the first keystroke after open, bundle size,
  and the remote-apply cost of a 2,000-keystroke peer burst.
- Measure on the production machine (D9), not on the laptop. There is no production data or users yet.

**Server**, for both layouts of the same content: room load, a fresh joiner's
step-1 answer, `trial` admission of a large update, the structural check and
`value()`. Reuse the probe at capy-harness `2026-10-27-yrs-vs-yocto/`.

**By hand**, as a fixed script:
- Chinese (pinyin) and Japanese (romaji) composition, on desktop Chrome and on
  Android Chrome through the phone tunnel;
- spellcheck replace, paste from Word and Google Docs, selection across three
  blocks;
- two tabs typing in one block while a third moves it, with every keystroke
  checked afterwards. This one needs piece 5, since the outcome depends on D3.

### 7. Dig: collection, server cost, effects, offline (2026-10-29)

- **Tombstones, folds, collection.** Collection, folds, held deletions, 24 h
  Undo and the late merge work on blocks rooms with no change to the crate
  (`blocks/tests/collection*.rs`, 12,000 fuzz seeds). Text costs the same as
  Plate. Per-block keys cost more: a 150-paragraph paste grows 38.6 KB vs
  15.3 KB, a block move 25 B vs 17 B, an agent replace-block about 2.4×. A
  deleted block's `blocks` key is never collected (about 20 B per deleted id).
  Q444 is slightly better than Plate: typing into an empty deleted block reads
  as `Since`/`Window`, not hidden.
- **Server RAM and CPU** (`bench/collaboration/scripts/layout-cost`, laptop,
  near-limit note). Typing admission is faster than Plate's (p95 1 µs vs
  19 µs). Every other update (a move, Enter, a paste, a delete, a reconnect)
  runs a full room check: 58–390 ms, 50 moves 5.2 s vs 9 ms, an hour of edits
  60 s CPU vs 0.2 s. The room keeps 2.3× Plate's heap (15.9 vs 7.0 MiB), peaking
  about 41 MiB during a full check; reload 2×; the step-1 answer is 31%
  larger. The prod-box package is `layout-box/`; nothing has run on the box.
- **Edit effects.** The same edits give byte-identical `NotePendingChanges`
  (`server/tests/effects_layouts.rs`, `note_effects_layouts_test.go`); derived
  ids shift but nothing aligns by them. The live read (Q417) projects through
  the room's model (unit test in `edits.rs`). T5 skips on blocks (boundary 3).
  The bridge's N1/N3/N4/N6 normalizations show as changes nobody made on a
  switched note's first save.
- **Offline, drafts.** The blocks note is an `ItemRoom`: offline strips,
  per-edit drafts, restore after reload, draft send, the Q465 leave prompt,
  paused swaps (`blocksRoom.test.ts`, `blocksuite-offline.spec.ts`). Other
  lineage and a late answer with unsent edits open copy-only: there is no
  merge view or late merge for blocks yet.
- **Seeds.** Fixed ranges in CI, longer runs through env variables, a failing
  seed printed and turned into a named test. No seed list file.

## Gates

**No speed gate** (Epo, 2026-10-27, D8). Optimize where we can. The floor is
that the BlockSuite note is no worse than Plate on any bench spec.

**Correctness, checked in step 1:**
- the move-while-typing script keeps every keystroke;
- the structural check survives the concurrent-client fuzz with no panic and
  no lost block, at a case count or time set in piece 5;
- `value()` round-trips every supported type, ids included;
- every step of the by-hand input script passes.

**Before the cut:**

- every row of the porting inventory is done or explicitly dropped;
- the bench is no worse than Plate on the full load-test note;
- the editor e2e specs have passing BlockSuite counterparts;
- the bundle without Plate's note chunks is no larger than today's.

## Work split (2026-10-28)

Four packages with disjoint files, all on `blocksuite-notes`. Each runs in its
own worktree branched from it and merges back. The layout spec is their shared
input.

| Package | Files | Waits on | Done when |
| --- | --- | --- | --- |
| **A. Rust blocks crate** (pieces 2 and 5's core) | new `collaboration-rs/crates/blocks`, workspace `Cargo.toml` | the spec | value → blocks → value is equal for the corpus and `every-block-note.json`; an empty value seeds `root`, `note` and one paragraph; the structural check catches two parents and a dangling id, and repair fixes both |
| **B. Server wiring** (piece 5) | `server/src/{model,room,edits,config,main,children}.rs`, deploy env files, Go's handling of a refused `replace-block` | A's signatures (stubbed first) | with the layout set to `blocks`, a `rooms.rs` test seeds a note whose projection equals `materials.content`; `replace-block` and agent edits are refused; mindmaps still load as Plate; with it unset, the existing suite passes |
| **C. TS converter and MSW** (pieces 2 and 3) | new `src/features/notes/blocksuite/layout.ts`, `src/mocks/collaboration.ts`, `src/mocks/chaosPeers.ts` | the spec, D's provider factory signature | round trip on the shared goldens; under the switch MSW seeds a blocks room and `persistMaterial` writes the same JSON as the Plate path |
| **D. Browser editor** (pieces 1's build and 3) | `vendor/blocksuite/`, `package.json`, `pnpm-workspace.yaml`, Vite config, new `src/features/notes/blocksuite/*` (besides `layout.ts`), `NoteEditor.tsx`, the flag module | the spec | the vendored build passes with BlockSuite in a lazy chunk; with the flag on under MSW a note opens, two tabs sync, nothing is written before the client id is adopted; the Plate path is unchanged with it off |

Then piece 4 (`capy:material-ref`, after D) and piece 6 (measure, after all
four). The vendoring part of D started first (2026-10-28).

- Rust worktrees need `vendor/betteroffice` linked for `yrs` and can share
  `collaboration-rs/target` through `CARGO_TARGET_DIR`. TS worktrees get their
  own `node_modules` (never a symlink to the main tree's).
- The flag's name is `COLLABORATION_DOCUMENT_LAYOUT` (`plate` | `blocks`) on
  the server, `VITE_DOCUMENT_LAYOUT` in the browser, and MSW reads the
  browser's.

## Tests

The laptop is busy, so CI is the check: `ci.yml` runs on every push of the
branch, and `perf.yml` is dispatched on it
(`gh workflow run perf.yml --ref blocksuite-notes -f office=false -f stress=false -f share_pages=false`).

- **Shared goldens.** `server/internal/materialdoc/testdata/blocks/*.json`, each
  `{value, canonical, blocks}`: a Plate value, its value after the spec's
  normalizations and derived ids, and the expected `blocks` map as JSON.
  Package A writes them; Rust and vitest (the TS converter and MSW's `value()`)
  each assert against them, as `figures.json` does for three languages today.
- **A:** `crates/blocks/tests/roundtrip.rs` over `notes/tests/corpus/bootstrap.json.gz`
  (the near-limit note, seed notes, small notes) and `every-block-note.json`,
  modelled on `notes/tests/projection.rs:59-85`; hand cases for the structural
  check and repair; a seeded concurrent fuzz (moves, deletes, typing from
  several yrs docs) on the `gc_views.rs` / `flashcards_parity.rs` pattern with
  `BLOCKS_CASES`/`BLOCKS_SEED`. CI job `collaboration`.
- **B:** unit tests beside `model.rs:235`; integration tests in
  `server/tests/rooms.rs` copying `two_clients_converge…` (`:872`), `tab()` and
  `returning()`. These need the docker stack, so CI job `collaboration`
  (`CAPY_IT_REQUIRED=1`), plus `backend_check` for Go.
- **C:** vitest beside the converter on the goldens; a two-participant blocks
  relay copying `src/mocks/collaboration.test.ts:28-75`. CI `frontend_check`.
- **D:** vitest on the store and workspace adapter (no DOM); Playwright
  `e2e/editor/blocksuite-*.spec.ts` under `e2e:msw:editor` with the flag on,
  including a blocks-layout `mockNotePeer` for move-while-typing. CI
  `e2e_editor`.
- **Piece 6:** `editor.perf.ts`'s four specs parametrised over both editors
  (`openNote` already takes a `PerfNote`), a blocks copy of the load note in
  `perfSeed.ts`/`db.ts`, the common-subset note for both, and the peer burst
  through `window.__capyMockRooms`. Server numbers in the
  `admit_cost.rs`/`bound_cost.rs` style, reported in
  `bench/collaboration/reports/`.

## What would need porting

Legend:
- **AF:** something comparable exists in AFFiNE's BlockSuite and needs adapting.
- **C:** a custom block, inline or widget we write.
- **R:** a rewrite of our own code against the new model.
- **=:** unchanged, because it works on the projected JSON.

### Element types (`pipeline/pipeline/generated/embeds.json`, 42)

| Ours | Port |
| --- | --- |
| `p`, `h1`–`h6`, `blockquote` | AF: paragraph block with its heading and quote types |
| `hr` | AF: divider |
| `code_block` / `code_line` | AF: code block (one `Y.Text` with lines, not one node per line) |
| lists: `listStyleType` + `indent` on paragraphs (`@platejs/list`, `indentLimit`) | AF: list block, nested. The model differs, so R for every list rule |
| `table` / `tr` / `td` / `th` | AF, but their cells hold text only (flat data). Ours hold blocks, so it's C if cells keep holding blocks |
| `callout` (+ the `richBlockConfig.ts` map) | AF: callout, restyled to option C |
| `column_group` / `column` | C |
| `toc` | C as a block. AFFiNE's `outline` is a side panel |
| `equation` / `inline_equation` | AF: latex block and latex inline |
| `a` | AF: link inline (an attribute on text, not a node) |
| `mention`, `mention_input`, `slash_input` | AF: mention inline and the slash-menu widget. The input elements become widget state |
| `img`, `audio`, `video`, `placeholder` (+ MediaFrame, resize, captions) | AF: image block. C: audio, video, the upload placeholder, the MediaFrame toolbar |
| `chart`, `plot`, `graph` | C: a block with a `Y.Map` prop, with the existing React figure as an island |
| `html_embed` | C |
| `mermaid` + `mermaid_caption` | C: a block with a `Y.Text` source prop |
| `material_ref` (with the quiz and flashcards elements inside) | C: `capy:material-ref` |

### Plate packages (28)

| Package | Replacement |
| --- | --- |
| `platejs`, `slate-react`, `@platejs/yjs`, `@slate-yjs/core` (and our patch of it) | `framework/store` + `std` + the inline editor |
| `basic-nodes`, `basic-styles`, `autoformat` | AF: paragraph types, text attributes, the `markdown-matcher` inline |
| `callout`, `code-block`, `table`, `list`, `indent`, `link`, `mention`, `media`, `caption`, `resizable`, `toc`, `layout`, `footnote` | AF where the table above says so, C elsewhere. AFFiNE has a footnote inline |
| `comment` | R. AFFiNE stores comments as `comment-<id>` text attributes in the document (`affine/inlines/comment/src/utils.ts:20-28`). Ours are relational and never write Yjs (`plate-editor.md`). D5 |
| `ai` | R: `notes/ai/*`. The AI-edit preview is in the Rust harness's open defects; coordinate before touching it |
| `dnd`, `selection` (`BlockSelection.tsx`, `BlockInteractions.tsx`) | AF: drag-handle widget, block selection in `std` |
| `slash-command`, `combobox`, `floating` (`FloatingToolbar`, `LinkFloatingToolbar`) | AF: slash-menu and toolbar widgets. R: our menus, icons and paraglide strings |
| `markdown` (`markdown.ts`, `markdownConvert.ts`, `markdownImport.ts`) | R in the browser. Server-side markdown is = |
| `docx`, `docx-io`, `juice` (paste from Word, `notes/export/*`) | R: paste through BlockSuite's clipboard adapters. Export is = through `value()` |

### Our note machinery (`src/features/notes`, about 98 files and 21k lines importing Plate)

- **R:**
  - Room binding and lifecycle: `roomBinding.ts`, `roomSwap.ts`,
    `roomConnection.ts`, `liveNoteHandover.ts`, `Collaboration.tsx`,
    `collaborationPlugins.ts`, and `src/features/collaboration/platePlugin.ts`.
  - Drafts and recovery: `src/lib/editDrafts.ts`, `NoteRecovery.tsx`,
    `saveDelay.ts`, `saveFailure.ts`.
  - `remoteNormalization.ts` and `stableElementIds.ts`. These become the
    structural check plus native ids.
  - Edit modes (`editorMode.ts`, view and edit tokens), checkpoints and
    projections.
  - `pastePlugins.ts`, `pastedImages.ts`, `uploadPresence.ts`, `pendingRefs.ts`.
  - `editorCommands.ts`, `EditorCommandPalette.tsx`, `toolbar/`,
    `NoteDisplayToggles.tsx`, `noteEditorPrefs.ts`, `noteFont.ts` (the CJK
    stack).
  - `RemoteCursors.tsx` and `cursorThrottle.ts` give way to their widget; our
    throttle and colours stay.
  - Merging and detection (Rust harness, 2026-10-27):
    - the hidden-typing detector (`hiddenTyping.ts` on the release branch),
      which walks structs and relies on a parent container's deletion;
    - Q229's copy merge;
    - the merge view, which aligns Slate blocks by element id.
  - `liveNoteBlocks.ts`, `liveNoteRead.ts`, `liveRange.ts`, `tocHeadings.ts`,
    `documentStats.ts`, `columnLayout.ts`, `tableStructure.ts`,
    `voidBlockBreak.ts`, `insertEditorNode.ts`, `mathInsert.ts`, `youtube.ts`.
- **Plate elsewhere:** the question `TextEditor` (`src/features/questions/TextEditor.tsx`)
  and `materials/staticPlugins.ts` (`MaterialPreview` → share pages,
  thumbnails, `LivePreview`) move in the same cut (D7).
- **The appearance styles** (capy, fisheye, notion) need BlockSuite's CSS mapped
  onto our tokens.

### Server and agents

- **R, the layout-specific part of the notes crate** (Rust harness,
  2026-10-27):
  - `slate/`, `slate_yjs.rs`, `plate.rs`;
  - `repair.rs` (repair on entry and after Undo);
  - `children.rs` and the content part of `limits.rs` (the children check,
    node count and depth bounds);
  - `commands.rs` and `edit.rs` (agent edit commands and durable Undo
    payloads);
  - `validate.rs`, `bound.rs`;

  A blocks module sits beside them, and the cut deletes the Plate ones
  (boundary 7). The harness also counts `prescan.rs`, though it has no yrs
  types (it scans raw updates); check what it assumes about the layout.
- **=:** `markdown.rs` and `questions.rs`, which work on JSON.
- **R, server reads of the open room:** Q417's detailed read asks the room for
  its value, and `ydoc::inspect`'s `hidden_units` holder walk assumes text
  hidden inside a deleted container. On blocks that becomes "a block removed
  from `sys:children` plus its Y.Map deleted".
- **R:** agent edit commands become operations on block ids. The tool shapes in
  `server/internal/agenttools` can stay if the edit layer maps them to ids.
- **=:** Go `materialdoc`, the pipeline's catalog readers and RAG indexing,
  since they read `value()` JSON. Kinds don't change, so every Go
  `kind == "note"` branch stays as it is.
- **Tests:** the editor e2e specs, the `editor.perf.ts` budgets, the vitest
  suites under `src/features/notes`, and the notes crate tests
  (`admission_parity`, `validation`, `catalog`, `fuzz_admit`, `admit_cost`)
  need BlockSuite counterparts before the cut.

## Decided

- **Side by side, then a clean cut** (Epo, 2026-10-27).
- **`value()` stays Plate-shaped JSON while both exist,** and only then (D11).
- **BlockSuite is copied into the tree,** not added as a submodule (Epo's lean,
  2026-10-27).
- **D1: Plate everywhere until the cut.** No new kind and no per-material
  switch; a stack-wide dev flag picks the layout (boundary 1).
- **D2: the cut covers every material.** Notes, mindmaps and diagrams all move
  to blocks, and the item agent-read path leaves `slate_yjs` (boundary 7).
- **D4: vendor the canvas packages too,** in a lazy chunk.
- **D5: comments stay relational** (Epo, 2026-10-27). They are anchored by Yjs
  relative positions inside each block's `Y.Text`; commenting never writes the
  document. AFFiNE's in-document `comment-<id>` attributes are not adopted.
- **D6: BlockSuite's undo manager** (Epo, 2026-10-27). It is a plain
  `Y.UndoManager` over `yBlocks`; we apply `limitUndo` to it and build it after
  the client id is adopted. Your own Undo stays in the tab's memory; agent
  Undo stays a server-built payload kept in IndexedDB for a day, and the
  blocks layout needs its own payload builder (`commands.rs`, `edit.rs`).
  Queued after the release (Rust harness): a redo patched to anchor on live
  neighbours, so the server can stop holding per-session deletions.
- **D7: the question editor and the static renderer move in the same cut**
  (Epo, 2026-10-27). No period with two editor formats.
- **D8: no speed gate** (Epo, 2026-10-27). Optimize where we can, and no worse
  than Plate.
  Relaxed 2026-10-29 (Epo): around Plate is enough. Gaps of a few
  milliseconds per key are fine and aren't chased; visible gaps (scroll FPS,
  open time) still count.
- **D9: all development on the Mac** (Epo, 2026-10-27), including the
  `collaboration-rs` piece, in the `blocksuite-notes` worktree. The PC keeps
  its own perf queue. The Rust part merges after the release train lands.
  Measurements run on the production machine (no production data or users
  yet), not on the laptop.
- **D3: repair on entry** (Epo, 2026-10-27). Keep the occurrence the higher
  client id wrote, as a map key would; drop dangling ids; put orphans back under
  the note; break cycles. The server writes the repair as an ordinary update.
  Extended 2026-10-28 to D18's depth cap: a block nested past level 8 moves,
  with its subtree flattened after it, under its deepest ancestor at level 7
  or above that may hold it, so a concurrent move is repaired, not refused.
  Background:
    dangling child id).
    - (a) Repair on entry: dedupe, drop dangling ids.
    - (b) Refuse, and reset the room.
    - Lean: (a). They come from normal editing.
    - **Why the CRDT doesn't settle this itself.** Yjs breaks ties between
      concurrent inserts at the same spot of one sequence by client id: the lower
      id goes first (`yrs` `block.rs:1084`). For one map key, the higher id's
      write is the one left visible.
      - A move in BlockSuite is a delete from one parent's `sys:children` and an
        insert into another's. Those are two different arrays, so no tie-break
        ever runs between two concurrent moves, and both inserts survive.
      - Slate-yjs today does no better: a concurrent move leaves two copies.
    - **A layout where the CRDT would settle it:** each block stores its parent
      as a key (`sys:parent`) plus a fractional order key. Two concurrent moves
      are then two writes to one map key, and the tie-break leaves exactly one
      parent.
      - It still needs a cycle check: A moved under B while B moves under A.
      - It means changing BlockSuite's store layout (`sync-controller.ts`), a fork
        we would carry.
    - **With (a):** the repair can reuse the same rule so it matches what the
      CRDT does elsewhere. Keep the occurrence the higher client id wrote, as a
      map key would, and drop the rest. The server writes the repair as a normal
      update, so every peer converges on it.
- **D11: stored content switches to block JSON in the cut** (Epo,
  2026-10-27). `materials.content` and everything downstream (Go `materialdoc`,
  the pipeline and RAG indexing, the agent's note format, share-page SSR,
  exports, markdown) move to block JSON, and the two converters
  (`value()` to Plate JSON, and the Plate JSON seed) are deleted. They exist only
  while both editors do. Production is not published before the cut, so only
  UAT data exists, and UAT is reset at the cut.
- **D12: editor chrome is BlockSuite's own widgets, restyled** (Epo,
  2026-10-28). The toolbar, slash menu and block menu stay BlockSuite's,
  restyled to our looks. The icon and paraglide patches live in the vendored
  code and are carried across upstream syncs (listed in
  `vendor/blocksuite/README.md`).
- **D13: an uploading image is an `affine:image` with an empty `sourceId`**
  (Epo, 2026-10-28). Peers draw it as the skeleton while the uploader's
  presence names it, and as "Add an image" otherwise. The room allows it, and
  `value()` leaves it out, so nothing about an upload is stored (PE:168).
- **D14: BlockSuite features with no decision of ours stay on when they work
  without porting** (Epo, 2026-10-28): heading and list folding, code wrap and
  line numbers. Ones that need a service we don't have (the `@` linked-doc menu
  needs a docs collection) stay off until one exists. Image pixel resize waits
  on T2 in `todo-blocksuite-layout.md`.
- **D15: table merging is dropped** (Epo, 2026-10-28). The BlockSuite table
  has no merged cells; seeding splits them into a full grid, and Merge cells /
  Split cells (`ToolbarTableMenu.tsx:99-105`) leave with Plate at the cut.

- **D16: the agent's edit tools and their Undo stay exactly as today** (Epo,
  2026-10-28). `edit_document`'s commands (`replace_text`, `insert_markdown`,
  `replace_block`, `replace_card`) keep their behaviour and payloads; an
  agent edit may or may not create paragraphs. On blocks:
  - `replace_text` diffs the block's `Y.Text` in place;
  - `insert_markdown` adds blocks to `sys:children`;
  - `replace_block` deletes the block and inserts one with a new id, as today
    (AR:703).

  Undo removes only the agent's own items (AR:723). Undoing a `replace_text`
  is the same item-level undo inside the block's `Y.Text`. For a block the
  agent inserted, any text someone else typed into it is moved into the block
  before it (the anchor) before the block goes, so it stays as it does
  today. A table's cells go with the table.

- **D17: our markdown converter stays** (Epo, 2026-10-28). It outputs block
  JSON instead of Plate nodes and is registered as BlockSuite's plain-text
  clipboard adapter in place of `MixTextAdapter`, so paste and import keep
  today's results: MDX callouts and columns, our figure, Mermaid and
  quiz/flashcards fences, and footnotes as superscript text (PE:186). The
  agent's markdown keeps running it without MDX in the server's V8, with its
  limits. BlockSuite's footnote inline is a citation chip (a URL, doc or
  attachment) rather than a text footnote, so it isn't used now; it is the
  ready-made piece if notes ever cite sources the way chat does.

- **D18: limits in block terms, with all nesting capped at 8** (Epo,
  2026-10-28). After D11 a node is a block, an inline embed (mention, inline
  equation) or a table cell. Depth is block nesting depth below the note,
  capped at 8 for every kind of nesting (lists, quotes, callouts, columns),
  down from today's material depth of 16, with list indent included in it.
  The 2 MiB cap applies to block JSON, re-measured on the near-limit note so
  the same content fits. While the bridge stands, the structural check
  already refuses nesting deeper than 8.

- **D19: editor AI is ghost text only** (Epo, 2026-10-28), in the Plate note
  now and the BlockSuite note later, on DeepSeek pin 1017 with no reasoning
  (Epo, 2026-10-28). The AI menu goes. Each user turns note AI on in
  Settings → LLM; it is off by default and stored server-side, so the
  BlockSuite ghost-text overlay checks the same setting. Built on Plate in
  `350900237` (`claude/ghost-text-18f936`): `users.note_ai_enabled`,
  `/ai/copilot` taking `{title, before, after}` and refusing
  `note_ai_disabled` when off, a server-owned prompt, `VITE_FEATURE_EDITOR_AI`
  dropped, and the AI menu and `/ai/command` deleted. The BlockSuite overlay
  calls the same route. The cost, endpoint and prompt are
  being worked out in the `ghost-text` session (`todo-ghost-text.md` on its
  branch).

- **D20: a pasted block keeps its id when no live block holds it** (Epo,
  2026-10-28), as `stableElementIds` does today. Comments anchor to block ids,
  and the server must not misread an offline user's typing into a block
  someone else moved or cut and pasted. Our own clipboard middleware replaces
  BlockSuite's `replaceIdMiddleware`, which mints a new id for every pasted
  block.
- **D21: image widths are pixels, not percent** (Epo, 2026-10-28), so an image
  keeps its size when the note switches to the canvas or the block is dragged
  out onto it, where a percentage has nothing to measure against. The note
  column has no fixed width even today (768 px half width, 1280 px full,
  `NoteEditorCore.tsx:263`, `:2311`). Images use `affine:image`'s
  `width`/`height` and its own resize handles; `widthPercent` (ours) is gone.
  Narrow screens clamp a wide image to the column. While the bridge stands,
  `value()` converts to the stored `"<n>%"` against a 768 px reference
  (clamped to 20–100) and the seed converts back (N8). Open: whether the
  other resizable blocks (YouTube, Mermaid, chart, plot, graph) share the
  rule, since they share one frame and would move to the canvas too. Presence
  is out of this plan: Epo works on it in another session.

## Held (not scheduled)

- **Copy a chat answer into a note** (Epo, 2026-10-28). Built for Plate by the
  "Copy-paste chat answer to note" session (`6f2967c7a`, on main
  since 2026-10-28). Copying inside one chat answer
  writes `application/x-capy-answer` (`answerClipboard.ts`): JSON
  `[{md, callout?}]` of plain note Markdown with our chart, plot and
  html-embed fences. Plate's `ChatAnswerPastePlugin` (`pastePlugins.ts`)
  converts each `md` without MDX and wraps callouts.
  **BlockSuite parity:** the D17 clipboard adapter reads the same type,
  importing its type from `answerClipboard.ts` so the compiler flags drift.
  There's no version field: the producer and both readers ship together, and a
  shape change updates every reader in the same commit.
  - Each `md` goes through our converter (plain) and then
    `layout.ts`'s Plate-to-blocks step while the bridge stands, and directly
    to block JSON after D11.
  - Callouts become `affine:callout` with the variant; the fences become
    `capy:chart`/`plot`/`html-embed`.
  - Inside a code block, or when parsing throws, it falls back to the normal
    paste.
  - Pinned by a BlockSuite counterpart of `e2e/editor/chat-answer-paste.spec.ts`.
  - Citations as footnote chips (D17) stay a later option.

The other questions from the decision walk-through are in
`todo-blocksuite-decisions.md` ("Questions for Epo"); they matter at the cut,
not for step 1.

## Decided 2026-10-29 (dig answers)

- **Switch normalizations in effects: accepted.** A switched note's first save
  may list the N1/N3/N4/N6 cleanups as changes; no requeue, Plate's index text
  stays as it is.
- **Merge for blocks notes: queued**, after the canvas work, since it needs UI
  design. Until then other lineage and a late answer with unsent edits open
  copy-only.
- **Blocks leg in the Agent visibility lane: queued** after the admission
  cost, room memory and deleted block ids answers.
- **Structural admission on the bound (option a).** Enter, merge, delete,
  move, indent, paste and prop writes admit from the update's own structs and
  a parent index (`blocks::Tree`, `crates/blocks/src/structure.rs`), not a
  full-room check; anything the repair on entry would fix still goes exact.
  Near-limit note: 50 moves 5,174 → 69 ms (Plate 4.7 ms), an hour of edits
  60.4 → 2.85 s (Plate 0.15 s), reconnect 86 → 21 ms; 20,000 differential
  seeds clean, 93% of structural updates on the bound. Left: `ydoc::inspect`'s
  trial copy on pastes and reconnects, the first paste on a fresh room, and
  the typing bound's pessimistic pricing near the limit.
- **Room memory: measured again after the bound.** 13.0 MiB idle (+0.3 MiB
  once the parent index exists) against Plate's 7.0; the box run decides.
- **Deleted block keys are collected (D20 amended).** The collection drops a
  deleted `blocks` key no session holds, so a deleted block leaves one marker
  (8 B, Plate 9 B). D20 now reads: a pasted block keeps its id only when the
  tab's own document still holds that id's key; otherwise it takes a fresh id.
  A late write to a collected key is re-keyed: the late merge reports the
  blocks it dropped for a collected key, and the tab pastes them again under
  fresh ids where they were (Rust half now, browser half with the late merge
  after canvas). Typing into a deleted block stays a hidden piece (Q444).
  Client-only markers were tested and rejected (`deleted_key_markers.rs`).
  Table row keys stay outside the rule (BlockSuite rewrites them on ordinary
  edits).
- **Trimmed block format: drop `sys:id` and `sys:version` only.** The id is
  read from the `blocks` map key and the version from the schema. Room memory
  on the near-limit note goes 15.85 → 12.98 MiB (1.86× Plate), which Epo
  accepts: still far below an Office room. `prop:collapsed` stays (D14
  folding), defaults stay written, and `sys:children` stays on every block
  (dropping it orphans a child when two peers add a first child at once).
- **Leave prompt, Q561 (on main 0fd074a02):** Plate notes, flashcard sets and
  quizzes take the narrow Q465 rule on `editor/narrow-leave`. When main is
  next merged here, fold this branch's `markUnstored`/`leave: 'unstored'`
  into main's version so one leave-prompt path remains.
- **Dead Rust helpers deleted.** `notes::index_text::from_doc` and
  `item_refs` (344873b68, 2026-10-17, for live-room effects) never had a
  caller: effects were built in Go from stored content (b95d392ce) and Q417
  reads the room through `ExtractIndexBlocks`.

## Decisions for Epo

- **D10. Timebox.** The review judged one week too short for about 74 upstream
  packages plus the build fixes. Proposal: two weeks for step 1, with a
  check-in after pieces 1–3 (the spec, the converters, and the editor running
  on MSW).

- **Room swap leftovers** (caret/focus restore, phone copy-in-place) before
  the cut? **Leave prompt** (Q465) for Plate notes too?
