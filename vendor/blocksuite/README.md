# BlockSuite (vendored)

BlockSuite's packages copied in as plain files, for the drawing answer's board
(`src/features/blocksuite/drawingBoard.ts`) and the note editor spike
(`todo-blocksuite-spike.md`, on the `blocksuite-notes` branch). Not a submodule: an upstream sync is a re-copy
from a newer commit with the local changes below reapplied.

- **Source:** AFFiNE `canary`, commit `5f1925499760f6954c1e656711d9fb6ed3168179`,
  directory `blocksuite/` (package version 0.27.5).
- **Licence:** MIT, `LICENSE` here (AFFiNE's `LICENSE-MIT`). Bundled third-party
  code keeps its own licence file next to it (`framework/global/src/gfx/perfect-freehand`,
  `affine/blocks/surface/src/utils/{rough,points-on-path,points-on-curve,path-data-parser}`).
- **Copied:** `framework/` and `affine/` (70 packages, the canvas/`gfx-*` ones
  included per D4), 2,696 files, 7.4 MiB.
- **Left out:** `playground/`, `docs/`, `docs-site/`, `integration-test/`, every
  `src/__tests__/` directory and the per-package `vitest.config.ts` files.

## Wiring

The packages are pnpm workspace packages (`pnpm-workspace.yaml`), linked, not
injected, so Vite treats them as source. The app depends on `@blocksuite/affine`
(`affine/all`), which re-exports everything else by subpath. Only lazy chunks
import it.

- One `yjs`: the root `overrides` pins `yjs` to the app's patched 13.6.31.
- One `zod`: the packages use the app's zod 4 range (local change 5).
- `.css.ts` (vanilla-extract): none that the board loads, and no plugin. The note's
  three are plain CSS (local change 24); the outline fragment's seven need the same before
  anything imports it.
- Decorators: Lit's standard decorators with `accessor` fields. `vite.config.ts`
  sets `esbuild.target: 'es2022'` so esbuild lowers them (Rollup cannot parse
  `accessor`); this directory's `tsconfig.json` keeps upstream's
  `useDefineForClassFields: false`, which esbuild reads per file.
- The app's `tsc -b` does not check these sources: `src/features/blocksuite` is
  excluded from the root `tsconfig.json`, and the app sees it through
  `pageEditor.boundary.d.ts`.

## Packages

Framework: `@blocksuite/global`, `@blocksuite/store`, `@blocksuite/std`,
`@blocksuite/sync`.

Affine (`@blocksuite/affine-*` unless noted): `@blocksuite/affine` (`all`),
`components`, `data-view`, `ext-loader`, `foundation`, `model`, `rich-text`,
`shared`;
blocks: `attachment`, `bookmark`, `callout`, `code`, `data-view`, `database`,
`divider`, `edgeless-text`, `embed`, `embed-doc`, `frame`, `image`, `latex`,
`list`, `note`, `paragraph`, `root`, `surface`, `surface-ref`, `table`;
fragments: `adapter-panel`, `doc-title`, `frame-panel`, `outline`;
gfx: `brush`, `connector`, `group`, `link`, `mindmap`, `note`, `pointer`,
`shape`, `template`, `text`, `turbo-renderer`;
inlines: `comment`, `footnote`, `latex`, `link`, `mention`, `preset`,
`reference`;
widgets: `drag-handle`, `edgeless-auto-connect`, `edgeless-dragging-area`,
`edgeless-selected-rect`, `edgeless-toolbar`, `edgeless-zoom-toolbar`,
`frame-title`, `keyboard-toolbar`, `linked-doc`, `note-slicer`,
`page-dragging-area`, `remote-selection`, `scroll-anchoring`, `slash-menu`,
`toolbar`, `viewport-overlay`.

## Local changes

1. `tsconfig.json` (this directory) replaced: upstream's extends AFFiNE's root
   `tsconfig.web.json`, which is not vendored. It inlines those options and
   drops the AFFiNE-only ambient types (`assets`, `build-config`, `affine__env`).
2. Every `package.json`: external dependency ranges pinned to the exact
   versions upstream's `yarn.lock` resolves (e.g. `lit ^3.2.0` → `3.3.0`), with
   upstream's root `resolutions` applied (`@atlaskit/pragmatic-drag-and-drop`
   `^2.0.0` → `1.4.0`). `yjs` ranges are left as written (the root override
   decides).
3. Every `package.json`: `devDependencies` removed (test tooling for the tests
   not copied: vitest, playwright, msw, `@vanilla-extract/vite-plugin`,
   `@types/pdfmake`, `@types/js-yaml`).
4. Three dependencies set to the app's versions, so the app and BlockSuite
   share one instance: `katex` 0.18.10 → 0.19.0 (`blocks/latex`,
   `inlines/latex`), `y-protocols` 1.0.6 → 1.0.7 (`framework/store`,
   `framework/sync`), `idb-keyval` 6.2.2 → 6.3.0 (`framework/sync`).
5. zod 3.25.76 → the app's range (`^4.6.6`) in all 21 packages that use it,
   for GHSA-mrhx-c7xc-m3w5 and one zod instance. Upstream is written against
   zod 3; on a sync, set the range again, then port what zod 4 rejects. Find
   it by type-checking the vendored sources (a throwaway tsconfig extending
   this directory's one, with `include` set to `framework/*/src/**/*.ts` and
   `affine/**/src/**/*.ts`, `noEmit`, `composite: false`) and comparing the
   error list with the same run on zod 3. This port changed:
   - `z.function().args(a, b).returns(c)` → `z.function({ input: [a, b],
     output: c })` (`framework/store` `model/block/zod.ts`, `blocks/database`
     and `blocks/paragraph` `view.ts`, `widgets/linked-doc` `view.ts`). These
     schemas only check that an option is a function: every `parse` of them
     discards its result, so the wrapped functions never run.
   - One-argument `z.record(v)` → `z.record(z.string(), v)`
     (`framework/store` `transformer/type.ts`, `model/block/zod.ts`,
     `shared` `link-preview-storage.ts`).
   - Types only: zod 3's `AnyZodObject`, `ZodEffects`, `KeySchema` and
     `ZodTypeDef` replaced with `ZodObject`/`ZodType` (`framework/std`
     `inline/extensions/type.ts`, `inline/services/attribute.ts`), and casts
     where zod 4's `ZodTypeAny`/`ZodSchema` are `unknown` rather than `any`
     (`rich-text.ts`, `shared` `zod-schema.ts` and `edit-props-store.ts`,
     `framework/std` `dynamic-schema.ts`).
   - `vite.config.ts` no longer excludes `zod` from pre-bundling.

   Left as written, since zod 4 keeps them with the same results:
   `z.nativeEnum`, `.merge`, `.default` (zod 4 returns the default without
   parsing it; every object default here is already complete), `.catch`,
   `z.promise`, `z.string().url()`. No vendored schema passes
   `message`/`errorMap`, uses `.superRefine`, `.passthrough`, `.strict` or
   `.deepPartial`.

6. Large-note cost (2026-10-28, `todo-blocksuite-spike.md` "6. Measure"):
   work that ran once per block or once per keystroke over every block.
   Each change keeps the answers it replaced.
   - `framework/store` `model/store/crud.ts`: `root` read every block and
     `getParent` walked the tree from the root on each call; block rendering
     (paragraph `collapsedSiblings`, `topContenteditableElement`, the drag
     handle's drop target) and each key (event scope, range binding) call
     them, so opening was O(n²) and a key O(n). `DocCRUD` keeps the root and
     a child → parent map from one pre-order walk (the first parent the walk
     meets, as before) and drops it in `beforeObserverCalls` of any
     transaction that adds or removes a block or changes a children list or
     flavour. While such a transaction is open or its observers run, it
     walks afresh. `Store.dispose` releases the listener.
   - `framework/store` `model/store/store.ts`: the constructor copied the
     blocks map once per block (O(n²)); the initial blocks go into it in
     place and one new map is published at the end.
   - `blocks/paragraph` `paragraph-block.ts`: `renderBlock` computes
     `collapsedSiblings` (O(n) over the parent's children) for headings only;
     a non-heading never collapses and the attribute it set styles only a
     heading's icon. The static `<style>` each paragraph rendered (one
     stylesheet per paragraph) is in `styles.ts` instead, with the same
     selector.
   - `framework/std` `inline/range/inline-range-provider.ts`: every block's
     inline editor hears every selection change; one whose range is already
     null, for a selection that cannot reach it, returns before reading the
     DOM (`isActiveInEditor`), since it would set null again.

7. Per-key and per-block cost, second round (2026-10-29, same section). Each
   change is marked `Capy (... local change 7)` in the source; on a sync,
   reapply them by that marker.
   - `framework/std` `inline/range/range-binding.ts`: both range syncs (after
     a native `selectionchange`, and after a selection change in the store)
     awaited `host.updateComplete`, which awaits every block, rich text,
     v-line and v-element of the doc, each with a `querySelectorAll`. They
     now await `_settled(ids)`: the host's own render, each ancestor's own
     render (which renders the next block on the path), then the blocks the
     sync reads in full (their rich text and inline elements). The ids are
     the native range's endpoint blocks, or the text selection's `from` and
     `to`. What the syncs read after the wait is in those blocks only
     (`rangeToTextSelection`, `textSelectionToRange`, `_computePath`, from
     the store). The composition paths (`:130`, `:153`) re-render the whole
     host and keep `host.updateComplete`, as do the 23 other callers (block
     commands that focus a block after a structural change).
     `ownUpdateComplete` is new on `EditorHost` (`view/element/lit-host.ts`)
     and `BlockComponent` (`view/element/block-component.ts`): Lit's own
     `getUpdateComplete`, without the overrides that await the children.
     Pinned by `e2e/editor/blocksuite-note.spec.ts` (a block whose render
     never settles does not hold the caret).
   - `framework/store` `extension/selection/selection-extension.ts`: `set`
     indexes the selections by block id (the first per block, as
     `value.find(s => s.blockId === id)`) and `block$(id)` returns a signal
     set only when that block's selection changes (lazily created, kept per
     id). `BlockComponent.selected$` and the paragraph's `focused$` read it,
     so a selection change re-evaluates the blocks it touches, not all of
     them. The paragraph's placeholder effect reads `focused$` first, so an
     unfocused paragraph does not depend on the selection.
   - `framework/std` `inline/range/inline-range-provider.ts`: the early
     return of local change 6 caches the element's `blockId` (a dataset
     read per block per selection change).
   - DOM per paragraph, 75 → 46 nodes (elements, text, comments):
     `affine/components` `caption/captioned-block-component.ts` renders the
     `affine-block-selection` overlay (a Lit element with a shadow root and
     a `watch(selected$)` effect, `display: none` while unselected) only
     while the block is selected; `blocks/paragraph` renders its placeholder
     only while it shows (`visible`, same classes). Both templates, and the
     paragraph's children container, lost the whitespace between tags (a
     text node each). The rest is Lit's part markers (about 30 comments) and
     the inline editor's nesting (`rich-text` > `v-line` > `v-element` >
     `v-text`).

8. Scroll, third round (2026-10-29, same section). Each change is marked
   `Capy (local change 8)` in the source; on a sync, reapply them by that
   marker.
   - `blocks/note` `note-block.ts`: the page note renders its children in
     `.affine-note-chunk` elements of about 32 blocks (at most 64), which
     the app makes `content-visibility: auto` (`pageEditor.css`), in place
     of one such box per block. With 3,400 boxes Chrome's visibility check
     (`IntersectionObserverController::computeIntersections`) and hit
     testing walked every one on each scrolled frame. A block starts a chunk
     when its id hashes to one (FNV-1a mod 32), so an insert or delete moves
     no other block between chunks unless it starts or ends one; a moved
     block is rendered anew (the view store keeps the newest element per id).
   - `framework/std` `view/element/lit-host.ts`: `renderModels(models)`,
     `renderChildren`'s keyed render of a given list, for the chunks.
   - `widgets/drag-handle` `utils.ts`: the selector for a note's top-level
     blocks also matches them inside a chunk.

9. Trimmed block map (2026-10-29, Epo; `todo-blocksuite-layout.md`
   "yBlock keys"): a yBlock holds no `sys:id` and no `sys:version`. On the
   near-limit note that keeps 18% less room heap and a 7% smaller state.
   Each change is marked `Capy (... local change 9)` in the source; on a
   sync, reapply them by that marker.
   - `framework/store` `model/block/block.ts`, `sync-controller.ts`,
     `flat-sync-controller.ts`: the block's id is a constructor argument,
     its key in the blocks map (`store.ts` `_onBlockAdded` passes it), not
     a `sys:id` read from the yBlock. A missing `sys:version` already read
     as the schema's version, and nothing reads the stored one (the
     model's `version` is its schema's).
   - `framework/store` `model/store/crud.ts`: `_findRoot` takes the root's
     id from its key; `addBlock` writes neither key.

10. Subpath exports for the drawing board (2026-11-06), so it can
    import only the editor parts it needs: `./widgets/edgeless-selected-rect`,
    `./widgets/edgeless-zoom-toolbar` and their `/view`, and `./inlines/comment/view`
    (`affine/all/package.json`, `affine/all/src/inlines/comment/view.ts`).

11. `makeDeepOptional` (`affine/shared` `zod-schema.ts`, marked `Capy (local change
    11)`): a union goes optional through `.optional()`. Zod 4 kept `.or(z.undefined())`
    a required key, so every partial edit on the canvas threw in `recordLastProps`.

12. `enable_note_menu_media` flag (`affine/shared` `feature-flag-service.ts`,
    `affine/gfx/note` `note-menu.ts`, marked `Capy (local change 12)`): the board turns
    off the note menu's image, link and file buttons, which upload or need a doc search.

13. `minimatch` 10.2.5 → 11.0.1 (`framework/store`) for GHSA-g3hv-75wg-m249 (Epo
    2026-11-06). `schema.ts` uses both arguments of `_matchFlavour` as patterns: check
    whether a saved answer's flavours reach it before saving is built.

14. Shape button colours (`affine/gfx/shape` `shape-draggable.ts`, marked `Capy (local
    change 14)`): `--capy-shape-button-<name>` and `--capy-shape-button-stroke-<name>`
    fix the toolbar pieces' colours; without them the pieces show the shape's last colour.
    A piece being dragged out (`onOverlayCreated`) keeps those colours too, as AFFiNE's
    demo shows the piece itself, where it took the canvas shape's last colours (Epo
    2026-11-12).

15. Phone toolbar (`affine/widgets/edgeless-toolbar` `edgeless-toolbar.ts`, marked
    `Capy (local change 15)`): below 768 px the toolbar takes the full width less an
    8 px gutter, in place of AFFiNE's 64 px safe area each side, its illustrated tools
    are 78 px wide and spread with `space-around`, so two show between the arrows. The
    change is the `FULL_WIDTH_*` constants, the narrow rule, `_availableWidth` and
    `scrollSeniorToolSize`. The narrow rule is a container query on the widget (Epo
    2026-11-12), so it follows the board's width as the paging does; as a media query
    on the window, a board under 768 px in a wider window drew 96 px tools that the
    paging had counted as 78 px, and they ran past the end with no arrows.

16. `elementsCtorMap` exported from `affine/blocks/surface` (marked `Capy (local change
    16)`), so the board can register its formula element before a saved answer loads.

17. Text tool (`affine/gfx/text` `tool.ts`, marked `Capy (local change 17)`): a click on
    a `plane` or `chart` card adds a label on top of it. The board's Label button uses this,
    since a double click on a card opens its editor. It applies only when the card is the topmost
    thing under the click.
18. Double tap (`framework/std` `event/control/pointer.ts` and
    `gfx/interactivity/gfx-view-event-handler.ts`, marked `Capy (local change 18)`): two
    touches within 500 ms and 24 px are a double click, though each has its own pointer id,
    and a touch finds the element under it before the event goes to that element's view.
    Upstream, a phone never opens anything a double click opens.
19. Marking image (`affine/blocks/surface` `canvas-renderer.ts` and `export-manager.ts`,
    marked `Capy (local change 19)`): `getCanvasByBound` takes the scale to draw at, and
    `_html2canvas` is public. The board draws its image layer by layer, so it stacks as
    the screen does and stays within a phone's canvas limit.
20. Tooltips (`affine/components` `tooltip.ts`, marked `Capy (local change 20)`): a tooltip
    takes no pointer events. A tap shows it first and the click then lands on it, so a
    phone couldn't use the toolbar's arrows or reach the tools past them.
21. Blank lines (`framework/std` `inline/components/v-line.ts`, marked `Capy (local change
    21)`): the empty line's template has no space around it. A canvas label keeps white
    space, so a blank line in one was five lines tall and took no clicks.
22. Leaking class (`affine/blocks` `attachment/src/styles.ts` and
    `image/src/components/image-block-fallback.ts`, marked `Capy (local change 22)`): a
    bare `.truncate` rule, in sheets that go into the document, applied `align-self:
    stretch` to every Tailwind `truncate` in the app once the board had loaded; it's
    scoped to the attachment and image fallback cards. A check of every rule the board
    loads against the app's Tailwind classes found no other bare selector.
23. Note height (`affine/blocks` `note/src/note-edgeless-block.ts`, marked `Capy (local
    change 23)`): a canvas note reads its content's height once a frame instead of on
    every mutation batch. Each read forced a layout; a large board's first render spent
    874 ms on them at 4x CPU slowdown (Windows' canvas-open report, 2026-11-06).
24. Note styles (`affine/blocks` `note/src/note-styles.css` and `note-styles.ts`, marked
    `Capy (local change 24)`): the canvas note's three vanilla-extract `.css.ts` files are
    one plain stylesheet with fixed `affine-note-*` class names, so the app's build runs no
    vanilla-extract plugin (Windows' canvas-open report, 2026-11-06).
25. Pointer clicks and drags (`framework/std` `event/control/pointer.ts`, marked `Capy
    (local change 25)`): a press that went past the 2 px drag threshold never clicks, so
    a pen stroke ending back near its start no longer adds a dot stroke; and the moves
    inside the threshold (the latest 64) reach the drag as `dragMove`s right after
    `dragStart`, so a stroke keeps its first points (Epo 2026-11-07).
26. data-view out of the board (`affine/foundation` `src/effects.ts`, `affine/data-view`
    `src/effects.ts`, `affine/blocks` `database/src/effects.ts`, `data-view/src/effects.ts`
    and `root/src/configs/toolbar.ts`, marked `Capy (local change 26)`): data-view's
    elements are defined by the database and data-view blocks (once, whichever comes
    first) instead of by foundation, and the page toolbar's Convert to database loads
    the database block and table view on use, so a board without those blocks loads
    none of data-view (about 155 KB gzipped; Epo 2026-11-07, fix 6 of the canvas-open
    report). The callout block draws its icon with data-view's `<uni-lit>`, which only
    data-view's effects define now, so an editor with callouts and no database or
    data-view block shows callouts without icons (it matters once notes move to
    BlockSuite).
27. Icons by reference (`affine/data-view` `src/core/utils/uni-icon.ts`, marked `Capy
    (local change 27)`, and its 15 `createIcon` callers in data-view and the database
    block, which aren't marked: each passes the imported icon where it passed its name,
    and `rg "createIcon\("` finds them): `createIcon` takes the icon itself instead of
    its name. A lookup by name kept every icon of `@blocksuite/icons/lit` in the build
    wherever the icons load, which was the board's chunk (about 90 KB gzipped more; Epo
    2026-11-07, fix 7).
28. Dispatcher off on demand (`framework/std` `event/dispatcher.ts`, marked `Capy (local
    change 28)`): a public `deactivate()`. A board kept mounted out of sight
    (`putAway()` in `drawingBoard.ts`) calls it, since none of the events that turn the
    dispatcher off fire when the board is hidden, and its document-level key and
    clipboard handlers would otherwise still run.
29. Narrower toolbar slots (`widgets/edgeless-toolbar` `edgeless-toolbar.ts`, marked
    `Capy (local change 29)`): a slot whose element carries `data-own-width` takes that
    element's width instead of AFFiNE's 96 px. The board's Charts slot is 60 px (Epo
    2026-11-08). The toolbar's paging still counts every slot as 96 px, so it pages a
    little early on a narrow screen.
30. Elements the eraser skips (`gfx/brush` `src/eraser-tool.ts`, marked `Capy (local change
    30)`): an element whose `erasable` is `false` is left out of the eraser's reach. The
    board's plane and chart cards set it (their marks are erased inside them), so they can
    answer `getLineIntersections` truthfully, which connectors need for their anchors.
31. Auto-complete for shapes and notes only (`widgets/edgeless-selected-rect`
    `src/edgeless-auto-complete.ts`, marked `Capy (local change 31)`): the next-shape
    arrows and next-note plus buttons render only for a single selected shape or note.
    Upstream hid them for other elements only while the pointer was over them, so a
    selected connector (or plane, chart) showed note buttons once the pointer moved
    away, and pressing one read a `background` the element doesn't have. The hover
    check's hit test and `render()`'s `isShape`, unused after it, are gone.
32. Wheel over the floating toolbar (`affine/components` `src/toolbar/toolbar.ts`,
    marked `Capy (local change 32)`): a pinch or swipe over the buttons goes on to the
    canvas, which zooms or pans; only an open menu keeps it, so its list scrolls.
    Upstream stopped every wheel without preventing it, so a pinch zoomed the page.
33. Toasts through the app (`affine/components` `src/toast/toast.ts`, marked `Capy
    (local change 33)`): `setToastHandler` hands every `toast()` message to the app's
    own toast. BlockSuite's fixed container sat inside the board's page and was cut off.

The specs named in local changes 6 to 9 are on the `blocksuite-notes` branch, with the
note editor they pin.

`pnpm audit` sees these packages' dependencies, not this source: Dependabot and `cargo
deny` don't cover it, so an AFFiNE security fix stays unseen until someone re-copies.

Outside this directory, for BlockSuite:

- `patches/@atlaskit__pragmatic-drag-and-drop@1.4.0.patch`: upstream's yarn
  patch for that package, as a pnpm patch.
- Upstream's yarn patch for `yjs` 13.6.21 (53-bit client ids) is **not**
  carried: our rooms assign client ids.
34. Chrome on the app's tokens (`affine/components` `src/toolbar/{styles,toolbar,icon-button,separator,menu-button}.ts`
    and `affine/shared` `src/styles/panel.ts`, marked `Capy (local change 34)`; Epo
    2026-11-10, mock S2): the floating bar and its menus live in shadow roots, so page
    CSS cannot restyle them. `styles.ts` no longer pins AFFiNE's light or dark palette
    on a bar (its two functions return nothing), so bars read the variables the app maps
    onto its tokens in `src/features/blocksuite/chrome.css`. The rest read custom
    properties set there, each falling back to upstream's value: a panel's corner
    (`--radius-toolbar`) with a 1px border, a bar's height, gap and padding
    (`--capy-toolbar-height`, `-gap`, `-padding`), a button's least size, corner and
    icon size (`--capy-toolbar-button-size`, `-button-justify`, `-button-radius`,
    `-icon-size`), a separator's width and line (`--capy-toolbar-separator-*`), and a
    menu row's corner and height (`--capy-menu-row-height`).
    The bar also takes `--capy-toolbar-max-width` and scrolls sideways past it (a
    phone keeps every control), and the slash menu and the context `icon-button` use
    the app's font. Icons drawn at AFFiNE's 20px (`svg[width='20']` slotted into
    `icon-button.ts` and `menu-button.ts`, and the two duotone icons of
    `highlight-dropdown-menu/`) take the button's icon size: 18px in a bar, and 16px
    in the inner bars that set `iconSize` to 16px (the code block's bar).
35. Slash menu rows (`widgets/slash-menu` `slash-menu-popover.ts` and `styles.ts`,
    marked `Capy (local change 35)`; Epo 2026-11-10, mock M1): 28px rows in a 240px
    panel with an 18px icon, the name and its Markdown shortcut at the right (a small
    table of names in the popover), uppercase group labels, and no description line.
36. Gutter handle (`widgets/drag-handle` `drag-handle.ts`, `styles.ts`, `config.ts`,
    `utils.ts`, `components/add-block-widget.ts`, `watchers/pointer-event-watcher.ts`,
    `watchers/handle-event-watcher.ts`, `widgets/slash-menu` `widget.ts`, and
    `components` `context-menu/sub-menu.ts`, marked `Capy (local change 36)`; Epo
    2026-11-10, mock H1): a note block's handle is the six-dot grip beside a 20 by 24px
    + button (upstream: a 4px bar, the dots on the canvas only), both centred on the
    block's first line; `heightMap` is retuned to the note's own type sizes
    (`src/features/blocksuite/pageEditor.css`), with callout and table entries. A
    click on the grip dispatches `capy-block-menu` (`{ block, grip }`) after selecting
    the block, which the app answers with its block menu
    (`src/features/blocksuite/blockMenu.ts`); `sideSubMenuMiddleware` places a submenu
    beside its row for it. A click on + is not a grip click (the watcher checks the
    event's path), and the grip stays where it is while hovered in a note (upstream
    re-pads its container to 8px and narrows its bar to 2px there). + adds a line
    below and opens the slash menu on it: the slash widget's `openOn(inlineEditor)`
    types the slash and opens the menu on the first `selectionchange` that finds the
    inline range after the slash and the browser's caret inside that line (a note's
    caret is moved by the host a moment after the inline range is set). A menu
    opened this way and left without a pick takes its slash with it, so the line is
    empty again (`_handleInput` hands the menu the caller's `AbortController`); a
    search typed after the slash stays. Only the BlockSuite note on the
    `blocksuite-notes` branch registers the drag handle and answers
    `capy-block-menu`; on main (no cut, Epo 2026-11-12) the boards carry this change
    unused.
37. Labels through one hook (`shared` `src/utils/label.ts`, new, exported from
    `utils/index.ts`; marked `Capy (local change 37)`; Epo 2026-11-10): `tr(label)`
    returns the app's translation of an English label, set once with
    `setLabelTranslator` (`src/features/blocksuite/chromeLabels.ts`), or the label as
    written. Called where labels are drawn: a bar button's tooltip
    (`components` `toolbar/icon-button.ts`), an action's label (`widgets/toolbar`
    `utils.ts`), a popup menu's item and submenu names (`components`
    `context-menu/button.ts`, `sub-menu.ts`), the slash menu's item and group names,
    the Turn into and alignment names (`blocks/root` `configs/toolbar.ts`) and the +
    button's title. Labels written straight into other templates are not covered yet.
38. Header rows (`blocks/table` `table-cell.ts` and `table-data-manager.ts`, marked
    `Capy (local change 38)`): a row with `header` (the note layout's own prop) draws
    semibold on the dim fill unless a colour was picked; the app's table bar toggles it
    (`src/features/blocksuite/tableBar.ts`). A table's header is its first row:
    `keepHeaderFirst` runs inside the transaction of every row add, delete, move,
    reorder and duplicate and leaves `header` on the first row alone, and a deleted
    header row hands it to the next first row. Only the first row draws as a header
    (`table-cell.ts` checks its row index), so a flag that arrives lower down (two
    people moving rows at once, a converted table) shows nothing. The table bar is
    the BlockSuite note's, on `blocksuite-notes`; main's boards hold no table.
39. Callout kinds (`blocks/callout` `callout-block.ts`, marked `Capy (local change
    39)`; Epo 2026-11-10): once the app calls `setCalloutVariantIcon`, a callout sets
    `data-variant` from the block's `variant` (none reads as info), draws that kind's
    icon in place of the emoji with no icon picker, and leaves its background to the
    app's styles (`src/features/blocksuite/calloutLook.ts`, `pageEditor.css`).
    Callout's row in the slash menu, in Turn into and in the phone keyboard toolbar
    (`configs/slash-menu.ts`, `rich-text` `conversion.ts`, `widgets/keyboard-toolbar`
    `config.ts`) shows the information icon, where upstream reuses Text's. The
    callout look (`calloutLook.ts`, `pageEditor.css`) is the BlockSuite note's, on
    `blocksuite-notes`; main's boards never call `setCalloutVariantIcon`.
40. Focus kept by the page's popovers (`framework/std` `event/dispatcher.ts`, marked
    `Capy (local change 40)`; Epo 2026-11-12): the pointer entering the board leaves
    the dispatcher off while focus sits in a `[role=dialog]`, `[role=menu]` or
    `[role=listbox]` outside the host, as upstream already did for a focused input.
    Otherwise the pointer's cursor selection, on its first move, had `RangeBinding`
    focus the host, which closed the page's canvas picker. `RangeBinding`
    (`inline/range/range-binding.ts`) also leaves focus in a text input or textarea
    when a selection changes: with the board already active, every pointer move
    focused the host and took focus out of the Misc panel's link field.

41. Shape centred on the pointer (`affine/gfx/shape` `overlay/shape-overlay.ts` and
    `shape-tool.ts`, marked `Capy (local change 41)`; Epo 2026-11-12): the shape tool's
    overlay is centred on the pointer, as a dragged piece is, and a click places the
    shape centred there. AFFiNE hung it by its top-left corner (6 px off for rectangles,
    the `SHAPE_OVERLAY_OFFSET_*` constants, now removed). Local change 46 sizes the
    overlay and the click per shape (`getShapeSize`).

42. Duplicate and paste without frames (`blocks/root` `edgeless/clipboard/utils.ts`,
    marked `Capy (local change 42)`; Epo 2026-11-12): `createNewPresentationIndexes`
    asks for the frame manager only when the pasted content holds a frame. The boards
    register no frames, so Duplicate and every paste threw `ServiceNotFoundError`.

43. Shape fill and the square piece (`affine/gfx/shape` `toolbar/config.ts`,
    `draggable/shape-draggable.ts` and `toolbar/icons.ts`, marked `Capy (local change
    43)`; Epo 2026-11-12): picking a fill colour sets `filled`, and No fill clears it;
    upstream read `isTransparent` the wrong way round, so a colour was stored unfilled and
    never drew. The toolbar's first piece is a plain square (`squareSvg`, `rect`) where
    AFFiNE's was a rounded rectangle; its colours are `--capy-shape-button-rect`.

44. Board fonts (`model` `consts/text.ts`, `widgets/edgeless-toolbar`
    `panel/font-family-panel.ts`, marked `Capy (local change 44)`; Epo 2026-11-12):
    `FontFamily` gains `ComicNeue` and `JetBrainsMono`, and the font menu lists
    `BoardFontFamilyList` (Fustat for `Inter`, Comic Neue, Lora, JetBrains Mono) in place
    of AFFiNE's seven, which load from its CDN and never drew here. The faces are in
    `src/features/blocksuite/drawingBoard.css`.

45. Text sizes (`shared` `utils/zod-schema.ts`, `model` `elements/shape/shape.ts`,
    `widgets/edgeless-selected-rect` `auto-complete-panel.ts`, `gfx/text`
    `toolbar/actions.ts`, marked `Capy (local change 45)`; Epo 2026-11-12): shape text
    and free text start at 16 (AFFiNE: 20 and 24), and the size menu adds 12 and 20.

46. Polygon shapes (`model` `consts/shape.ts` and `elements/shape/api/polygon.ts`,
    `affine/gfx/shape` `element-renderer/shape/polygon.ts`, `element-renderer/shape/
    utils.ts`, `element-renderer/shape-dom/index.ts`, `overlay/polygon.ts`,
    `overlay/factory.ts`, `overlay/utils.ts`, `shape-tool.ts`, and `shared`
    `utils/zod-schema.ts`, marked `Capy (local change 46)`; Epo 2026-11-12): `ShapeType`
    gains `rightTriangle`, `parallelogram`, `trapezium`, `pentagon` and `hexagon`, each
    its corners in `POLYGON_SHAPES`, drawn and hit-tested by one polygon implementation
    built as the diamond is. `getShapeSize` gives each its click size. They were groups
    of straight connectors, which neither filled nor held text.

47. One thing held at a time (`widgets/edgeless-toolbar`
    `draggable/draggable-element.controller.ts`, marked `Capy (local change 47)`; Epo
    2026-11-12): the controller every toolbar piece uses keeps one carried piece across
    all of them (`carried`). Taking a piece cancels the other and drops a held tool (a
    picked shape or note following the pointer) but keeps a drawing tool (pen,
    highlighter, eraser), which the board takes back once the piece is placed; a tool
    picked while carrying cancels the piece. A press that returns a carried piece to the toolbar lands on the overlay's mask
    and is passed on (`pressThrough`) to what lies beneath, so one click works a button
    or picks up another piece; AFFiNE swallowed it. The mouseup and touchend that end a
    press are heard in the capture phase: the board's panels keep their mouseup from the
    board, so a click on a panel's tile was read as a drag from the board's first move
    (no carry, and a scaled preview off the pointer).

48. Note centred on the pointer (replaced by 53: the preview is gone) (`affine/gfx/note` `note-tool.ts`, `overlay/overlay.ts`,
    `overlay/consts.ts` and `index.ts`, marked `Capy (local change 48)`; Epo 2026-11-12):
    the note tool's overlay is the empty note a click places, centred on the pointer:
    its width, its height, hairline (`--capy-note-edge`) and corner, and the
    placeholder in the block's font, size, weight and place, from `notePreviewOf`
    (`overlay/consts.ts`, measured per kind on the board). The click centres the note
    by that height. A dragged note lands where its outline was drawn. AFFiNE drew a
    100 by 50 box in 16 px Arial below and right of the pointer and shifted both by
    `DEFAULT_NOTE_OFFSET_X/Y`. The package exports `EdgelessNoteSeniorButton` for the
    board's `capy-note-button`.

49. Placeholder without a scrollbar (`blocks/paragraph` `styles.ts`, marked `Capy
    (local change 49)`; Epo 2026-11-12): `.affine-paragraph-placeholder` clips both
    axes. Its `overflow-x: hidden` alone made the other axis `auto`, and a heading's
    text, a pixel taller than its line, drew a scrollbar beside the placeholder.

50. Mouse strokes at one width (`affine/gfx/brush` `brush-tool.ts` and
    `highlighter-tool.ts`, `framework/global` `gfx/perfect-freehand/
    get-solid-stroke-points.ts`, marked `Capy (local change 50)`; Epo 2026-11-12): a
    mouse stroke records no pressure, and a stroke without pressure draws at one width
    (pressure 0.5, `simulatePressure` off); a click without pressure is a dot at
    pressure 0. A stroke at pressure 0.5 is its width wide (size `lineWidth / √2`):
    AFFiNE's easing drew every width 1.41 times over, a pen 4 as 5.7 and the
    highlighter's 22 as 31. The highlighter starts at its third width, 18 (`model`
    `consts/line.ts`; AFFiNE's fourth, 22). AFFiNE took the release's pressure 0 for a
    pressure device, so the first stroke redrew at another width when it ended and
    every later one stored pressure, and it thinned a stroke without pressure by its
    speed.
51. Tooltips over popover menus (`affine/components` `tooltip/tooltip.ts`, marked
    `Capy (local change 51)`; Epo 2026-11-13): a tooltip whose element sits inside an
    open popover (the selection toolbar's menus, shown in the top layer since
    `topLayer: true`) is shown as a manual popover itself, placed `fixed`, so it lands
    above the menu. It was drawn under it: the note style panel's Film shadow tooltip
    showed as a black box peeking past the panel's edge.
52. Inline notes (`affine/model` `consts/note.ts`, `affine/blocks/note`
    `inline-note.ts`, `note-edgeless-block.ts`, `components/edgeless-note-background.ts`
    and `components/edgeless-note-style-panel.ts`, `affine/gfx/note` `note-tool.ts` and
    `overlay/`, marked `Capy (local change 52)`; Epo 2026-11-13): a note is inline (its
    text on the canvas, no fill, padding or edge) when its fill is `transparent`, it has
    no shadow and no border (`isInlineNote`; no new field). A placed note starts inline,
    and its preview and centring leave out the card's padding (`NOTE_CARD_PADDING`). The
    note container carries `data-inline`. The style panel opens with an Inline | Card
    switch, Inline on the left, and shows Fill, Shadow, Border and Corner only for a
    card; `setNotesInline` turns notes inline or into cards (the default fill, the Box
    shadow, corner 8) as one undo step. A note's fill is drawn half see-through
    (`color-mix`), its border and shadow solid.

53. Inline notes fit their text (`affine/gfx/note` `note-tool.ts`, `index.ts`,
    `affine/blocks/note` `note-edgeless-block.ts`, `inline-note.ts` and
    `components/edgeless-note-mask.ts`, marked `Capy (local change 53)`; Epo
    2026-11-13): the note tool draws nothing under the pointer (its plus cursor
    alone); a click, or a drag at its start, places an inline note whose first line
    starts at the pointer and is centred on it (`FIRST_LINE` per kind). The
    `overlay/` folder (local change 48's preview, AFFiNE's dragged-out box) is gone.
    An inline note renders `max-content` wide up to `DEFAULT_NOTE_WIDTH`, and a
    `ResizeObserver` stores that width; it resizes by its corners only, which scale
    it. Turning one into a card widens it by the card's 10 px padding each side, so
    its lines stay. The note mask stored its height 40 taller while a note was edited
    (it reaches 20 px past the note then); it stores the note's own height.

54. A note's full height from its own padding (`affine/blocks/note`
    `note-edgeless-block.ts`, marked `Capy (local change 54)`; Epo 2026-11-13): the
    full height a custom height is compared with adds the note container's real top
    and bottom padding (8 px on a board card, 0 inline), not AFFiNE's 24 each. It
    read 32 too tall, so a card whose custom height fitted its text showed the fold
    (a pale blue strip under it on hover) and the fold arrow. The arrow shows when
    the two differ by a pixel or more. `setNotesInline` also clears a custom height
    (`collapse`) when a note turns inline, whose height is its text's. Local change 55
    removed the fold itself, so what remains of this is the board's padding.

55. Notes have no fold (`affine/blocks/note` `note-edgeless-block.ts`, `inline-note.ts`,
    `note-styles.ts`/`.css`, `components/edgeless-note-mask.ts`, marked
    `Capy (local change 55)`; Epo 2026-11-13): a note is always as tall as its text.
    The custom height (`edgeless.collapse`), the pale strip of the hidden part on
    hover, the fold arrow (`components/more-indicator.ts`, deleted) and the hover and
    resize tracking that fed them are gone; the mask always stores the text's height.
    A card resizes by its sides, which set its width (the text rewraps and the height
    follows; the opposite side stays put), or its corners, which scale it; it can be
    as narrow as 40 (times its scale), where AFFiNE kept it 218 wide at least, so a
    card scaled down while inline snapped wider on its first drag. Turning a note
    inline or into a card clears and sets its selection again, so the frame's handles
    follow the new kind.

56. Excalidraw's selection frame, and notes turn (`affine/widgets/edgeless-selected-rect`
    `edgeless-selected-rect.ts` and `resize-handles.ts`, `affine/widgets/toolbar`
    `utils.ts`, `affine/model` `note-model.ts`, `affine/blocks/note`
    `note-edgeless-block.ts`, marked `Capy (local change 56)`; Epo 2026-11-13, F1): the
    frame is a 1px `--affine-primary-color` line drawn 6 px off the selection
    (`::before`, dashed with `data-multi`, none with `data-connector`), with 9 px square
    corners filled with `--capy-handle-fill`, a faint 3 by 16 px bar outside each side
    that resizes, and a rotate knob 32 px above the middle (`aria-label="rotate"`) in
    place of the hidden rotate ring past each corner. While turning, the angle shows
    in one place, under the circle the selection turns in, or above it when the
    board's bottom toolbar would hide it (`.capy-rotate-angle`); one item shows its
    own, snapped turn. The selection's
    toolbar stands 30 px further off, clear of the knob. A note has a `rotate` prop
    (0 by default), is drawn turned about its middle, hit where it is drawn, and turns
    (AFFiNE's notes did not); a side drag keeps the other side's middle where it is
    along the turn.

57. A lead button in the note menu (`affine/gfx/note` `toolbar/note-menu.ts`, marked
    `Capy (local change 57)`; Epo 2026-11-13, P1): `lead` renders before the note kinds,
    with a divider, and `above` above the row (the menu is a column). The board puts
    its Link button and address field there; nothing is rendered when they are unset.

58. A gentle snap when turning (`framework/std` `gfx/interactivity/resize/manager.ts`,
    marked `Capy (local change 58)`; Epo 2026-11-13): without Shift, one item turned to
    within 4° of a multiple of 45° lands on it (`softSnap`). Shift still snaps to every
    15°; several items turn without either, as in AFFiNE.

59. A double click places a note (`affine/shared` `feature-flag-service.ts`,
    `affine/gfx/note` `note-tool.ts` and `view.ts`, `affine/gfx/text`
    `dblclick-add-edgeless-text.ts`, marked `Capy (local change 59)`; Epo 2026-11-13):
    with `enable_dblclick_note` (off by default), a double click on empty canvas places
    an inline text note there and types in it (`DblClickAddNote`), and the canvas text
    label's double click stands aside. The workspace canvas turns it on; an answer
    board keeps the label.

60. A note's side plus types in the new note (`affine/widgets/edgeless-selected-rect`
    `edgeless-auto-complete.ts` and `utils.ts`, marked `Capy (local change 60)`; Epo
    2026-11-13): the plus on either side of a selected note places the next note there
    with the caret in its first line. AFFiNE aimed a caret at the middle of a
    default-height note, below an inline note's one line, so nothing could be typed;
    the stale fold flag the new note was given is gone too.

61. The shape switcher offers every shape (`affine/gfx/shape`
    `toolbar/shape-menu-config.ts`, marked `Capy (local change 61)`; Epo 2026-11-13):
    `ShapeComponentConfig` lists the board shapes panel's ten shapes (local change 46's
    polygons after AFFiNE's five), drawn with the panel's outlines, so a selected
    shape's Switch shape type menu and a connector's next-shape panel reach them all.

62. Content this editor can't read is kept and drawn as a placeholder (`framework/std`
    `gfx/model/surface/surface-model.ts`, `unknown-element-model.ts` (new) and
    `gfx/index.ts`; `framework/store` `schema/schema.ts`, `extension/schema.ts`,
    `model/block/block.ts`, `sync-controller.ts`, `flat-sync-controller.ts` and
    `model/store/store.ts`, marked `Capy (local change 62)`; Epo 2026-11-18: reject
    nothing, delete nothing a person hasn't acknowledged). A shared board holds what
    a peer or a newer version wrote, and none of this writes to or deletes a stored
    map.
    - Canvas elements: upstream threw `Invalid element type` for a type it has no
      model for, when the surface loads and inside the Yjs observer when a peer
      adds one. A stored entry is now built by `_storedCtor`: its own model, or an
      `UnknownElementModel` (type `capy:unknown`: its place, order and turn, nothing
      else read) when the type is unknown or the editor's `ElementReadableIdentifier`
      check, registered on the store, says it can't read it. An entry with no place
      to draw at (`hasPlace`), or that is no map, gets no model. An entry's id is its
      key in the elements map, not the `id` field it holds. `addElement` of an
      unknown type still throws. `_propsToY` takes a placeholder, so it can be moved.
    - Blocks: upstream skips a block whose flavour has no schema. `Schema.standIn`,
      set from a store's `BlockStandInExtension`, answers with the schema a stored
      block is read with (`Schema.of`, which the block and both sync controllers
      ask), so an editor can read one it doesn't know through a schema of its own
      that declares no props. `getBlock`, `getBlock$`, `getParent` and `hasBlock`
      answer for a block's own key only: a child id such as `__proto__` or
      `toString` found something that is no block. A block under such an id is
      still never built.
    - Toolbar (`affine/widgets/toolbar` `src/toolbar.ts`): a selection of models
      whose `toolbar` is `false` alone shows no floating toolbar. The placeholder
      models set it: Lock and the rest are not for something unread.
    - The board's side is `src/features/blocksuite/boardUnknown.ts` (what is read)
      and `boardUnknownView.ts` (the placeholder), pinned by
      `src/features/blocksuite/boardUnknown.test.ts`.

63. A connector's label is placed only by the tab whose own change moved it
    (`affine/gfx/connector` `connector-watcher.ts` and `connector-manager.ts`
    `ConnectorPathGenerator.updatePath`, marked `Capy (local change 63)`; Epo
    2026-11-18, the canvas's collaboration room). `labelXYWH` is a stored field, and
    upstream's watcher wrote it whenever a connector's path was worked out: as a
    board loads, when a peer adds a connector or moves a shape one hangs on, and
    in a read-only store. On a shared canvas every open tab then wrote, a
    viewer's too (the room closes a read channel that writes, so a viewer's board
    reopened in a loop), and a peer's move landed in another editor's Undo and
    emptied its Redo. The watcher now carries whether the change was this tab's
    own (`local` on the surface's events, `isLocal` on a block's) to
    `updatePath`'s new `placeLabel` argument, false on load and in a read-only
    store: the path, which is not stored, is still drawn again everywhere, and
    the label's place comes from the tab that made the change. A place that did
    not move is not written again, so an Undo that put it back keeps its Redo.
    The mind map's two callers keep the default (their connectors are local
    ones with no label). Pinned by
    `src/features/blocksuite/connectorLabel.test.ts`.

64. A double click that opens a card's editor is used up (`framework/std`
    `event/control/pointer.ts` `ClickController.endRun` and
    `PointerControl.endClickRun`, `event/dispatcher.ts`
    `UIEventDispatcher.endClickRun`, marked `Capy (local change 64)`; found
    2026-11-18). The click counter listens on the host and adds one for each press
    at the same place within 500 ms of the last. A plane's or chart's editor opens
    over the board, outside the host, so its presses (the menu, Done) are not
    seen: a double click on the card within 500 ms of the one that opened the
    editor counted as presses three and four, a triple click, and opened nothing.
    `openBoardEditor` (`src/features/blocksuite/boardEditorShell.ts`) calls
    `std.event.endClickRun()` as the editor opens. Pinned by "a selected line's
    point still moves alone" in `e2e/editor/drawing-board.spec.ts`, which closes
    an editor and opens it again at once.

65. A read-only store takes no edits from the board's keys or the select tool's
    drag (`affine/blocks/root` `edgeless/edgeless-keyboard.ts` and
    `edgeless/edgeless-root-block.ts`, `affine/blocks/surface`
    `tool/default-tool.ts`, `affine/gfx/shape` `draggable/shape-draggable.ts`,
    `affine/gfx/mindmap` `toolbar/mindmap-tool-button.ts`, marked `Capy (local
    change 65)`; found 2026-11-18, the canvas's collaboration room). The keyboard
    manager and the tools are made for every board, and upstream guards them with
    the viewport's lock (`service.locked`), never the store's `readonly`, while
    an element's field, a stash's pop and a block's props write with no
    read-only check. On a viewer's board, or an editor's locked one, select all
    and an arrow key moved every element, and `v` (on a locked board the
    toolbar's own Escape too) then a press-drag moved what it pressed on: a
    viewer's tab sent on its read channel, the room closed it and the board
    reopened each time; a locked editor moved what was stored nowhere. While
    `store.readonly`:
    - The select tool's `dragStart` (`default-tool.ts`) hands the drag to no view
      (a connector's label is moved by its view) and starts no move or clone.
      The press still selects what is under it and a drag from empty board
      still selects by its box, so `v` and Escape may pick the tool. A press-drag
      on a connector's label therefore selects its connector, as one on its
      line does.
    - The root block's `bindHotKey` wrapper (`edgeless-root-block.ts`), which
      replaces a selected mind map node's text with a bound letter before that
      letter's handler runs, leaves the text and calls the handler.
    - In `edgeless-keyboard.ts` (`_readonly`) these do nothing: the tool letters
      `t`, `c`, `n`, `p`, `Shift-p`, `e`, `f` and `Shift-s`, the note slicer
      (`k`, `-`), `@`, group and ungroup, Delete, Backspace and `Control-d`, the
      arrow nudge, Enter and Tab (a label's or a text's editor, a mind map's new
      node) and a letter that is no hotkey typed over a mind map's node. `v`,
      `h`, Space, select all, Escape, the zoom keys and walking a mind map's
      nodes with the arrows go on.
    - The shape piece's `s` and the mind map button's `m` pick nothing.
    The surface's own add, remove and update, a block's add and delete, and the
    resize handles already refused. The guard is at the tool and not at the
    element's stash pop, because a write that is no person's edit goes through
    it and is left as it was: a mind map lays itself out on every board when
    its tree changes and pops its nodes' stashed `xywh` (`mindmap.ts`
    `stashTree`, the view's layout method). Pinned by "the keyboard and a drag move nothing on a board
    that takes no edits" in `e2e/editor/canvas-room-states.spec.ts` (select all
    and the arrows, then `v` or Escape and a press-drag, on a viewer's board and
    a revoked editor's).

66. An inline editor with no range reads no selection after it renders
    (`framework/std` `inline/services/range.ts`, marked `Capy (local change 66)`;
    found 2026-11-18, opening a full canvas). Every inline editor syncs the page's
    selection when its render completes (`render.ts`), and with no range of its own
    that only clears a selection inside it; reading `selection.rangeCount` forces a
    style recalc, so each note's first render paid one (1.5 s of forced recalcs at
    4x CPU opening a 4 MiB board). `syncInlineRange` now returns first when the
    editor holds no range, has held none since it last found the selection outside
    it (`_mayHoldSelection`, set by any range it is given or syncs), and does not
    hold the focus. A focused editor and one that has held a range read it as
    before. Measured after (`bench/editor/reports/2026-11-18-board-open-fixes.md`):
    the open reads the selection once instead of 42 times, but the frames' own
    style recalcs then do the same work (1.5 s either way), so the open is no
    shorter; what makes each frame's recalc that large was not found. Pinned by
    `e2e/editor/board-note-caret.spec.ts` (typing, a composition, a caret kept while
    another note renders, a selection that goes with a note's editing), and the
    peer's caret by `canvas-presence.spec.ts`.

67. A graphics block finds its store's surface once (`framework/std`
    `gfx/model/gfx-block-model.ts`, marked `Capy (local change 67)`; found
    2026-11-18). `surface` filtered every block of the store on each read, and the
    layer sort reads `groups`, then `surface`, in every compare: 0.55 s at 4x CPU
    on a 4 MiB board, growing faster than the board. Each store's surface is kept
    (a `WeakMap`) while `store.getBlock(id)` still returns that model; a surface
    removed or replaced is looked up anew, and none found is never kept, so one
    added later is found. Pinned by `src/features/blocksuite/boardSurface.test.ts`.

68. The views added in one go ask once what is in view (`framework/std`
    `gfx/viewport-element.ts`, `gfx/grid.ts`, marked `Capy (local change 68)`;
    found 2026-11-18). The viewport element sets each added block view's
    `transformState$` from the models in view, and searched the grid over the
    viewport for every view: a board's open adds every note's view in one pass,
    0.74 s at 4x CPU for 262 notes. The search is kept to the end of the
    microtask while the grid (`GridManager.version`, counting adds and removes),
    the viewport and the query are the same. Pinned by the canvas e2e specs, whose
    notes show (`canvas-room.spec.ts`, `canvas-presence.spec.ts`) and by
    `e2e/editor/board-note-caret.spec.ts`.

69. The surface draws first in the frame its `attach` asks for
    (`affine/blocks/surface` `surface-block.ts`, marked `Capy (local change 69)`;
    found 2026-11-18). `firstUpdated` drew the whole board at once, before an
    editor fitting its view in the next frame (the drawing board's `mountLayer`)
    had done so, and that frame drew it again: 0.56 s at 4x CPU on a full canvas.
    The stacking canvases are still appended there; `attach`'s refresh draws them,
    after the fit, since `mountLayer` asked for its frame first. A board whose
    viewport has no size yet in that frame (`mountLayer` waits) is drawn once
    before its fit, as before.

70. An image is placed before its file is stored (`affine/blocks/image`
    `utils.ts`, `index.ts`, marked `Capy (local change 70)`; 2026-11-19, the
    canvas's upload placeholder, Epo 2026-11-06). `addImages` read each file's
    size and stored it together, then placed the blocks: a canvas stores the file
    before its block lands (`boardBlobs.ts`), so nothing showed while it went up.
    Each image's size is now read first, its box worked out, and the hook set by
    `setImageUploadHandler` told of each file and its box before the files are
    stored; its answer is called as the block lands, or with why the file was
    refused. An image whose size can't be read is said and left out (as before,
    with BlockSuite's own notice); one whose file is refused lands nothing and the
    others of the same paste still land (upstream one refusal dropped them all),
    and `addImages` answers the ids that landed. A board that stopped taking
    edits while the files were stored (`store.readonly`), or whose add throws,
    lands none and calls every answer with the error, so no box stays. Pinned by the upload test in
    `e2e/editor/canvas-read-only.spec.ts` and the image tests in
    `canvas-room-states.spec.ts`.

71. A read-only store selects and copies, and its clipboard and double click add
    nothing (`affine/blocks/surface` `tool/default-tool.ts`, `affine/blocks/root`
    `edgeless/clipboard/clipboard.ts`, `affine/gfx/note` `note-tool.ts`, marked
    `Capy (local change 71)`; 2026-11-19). Upstream a click on a read-only store
    returned at once, so nothing could be selected but by a press-drag. Now:
    - `DefaultTool.click` selects what it is on (or clears) on a read-only store
      too, and hands the click to no view.
    - `EdgelessClipboardController.copySelection()` puts on the clipboard what a
      copy event of the selection does (`_onCopy` without its event; the board's
      Copy bar, `boardReadOnly.ts`).
    - Cut on a read-only store copies and removes nothing; a paste returns before
      reading the clipboard.
    - The double click that places an inline note (local change 59) places none.
    Pinned by "a viewer's board selects and copies…" in
    `e2e/editor/canvas-read-only.spec.ts`.

72. Blocks are drawn into images by html2canvas-pro (`affine/blocks/surface`
    `extensions/export-manager/export-manager.ts` and `package.json`, `affine/blocks/root`
    `edgeless/clipboard/clipboard.ts` and `package.json`, marked `Capy (local change
    72)`; 2026-11-19), the fork the app's note export already uses, in place of
    html2canvas 1.4.1. Chrome computes a `color-mix()` as a `color(srgb …)` value,
    which html2canvas 1.4.1 cannot read: it threw on every note, whose fill is a
    `color-mix()` (local change 52), so the board's marking image and its Download as
    image failed on any board with a note. The options and the cloned-document fixes
    are unchanged. Pinned by "the image stacks as the screen does" and "a note
    scrolled out of view still reaches the image" in
    `e2e/editor/drawing-board.spec.ts`.

73. The edgeless root keeps no view of its own (`affine/blocks/root`
    `edgeless/edgeless-root-block.ts` `_initViewport`, marked `Capy (local change
    73)`; Epo 2026-11-19, Q32). Upstream read a stored viewport as it mounted and wrote
    one as it went, in sessionStorage under `blocksuite:<store id>:edgelessViewport`.
    Every board's store id is `board`, so each board opened at the view of the last
    one shown in the tab, whatever its canvas, until the board set its own first view on
    its first animation frame. The root now only fits the screen; the board sets the
    view it opens at on that frame (`DrawingBoardOptions.view` and `kept`: on a canvas,
    the view this device kept for it, `src/features/canvas/canvasViews.ts`; otherwise
    its fit), so the change is to what the root shows before that frame. No test pins
    it: the e2e specs read the view only after the board's first view, which is the
    same with or without the stored one. The page-mode writers (`frame-panel`,
    `surface-ref`) still write the key, which nothing reads now.

74. A canvas copy, Duplicate or Alt-drag clone carries no placeholder element
    (`affine/blocks/root` `edgeless/utils/clone-utils.ts` `serializeElement`, marked
    `Capy (local change 74)`; 2026-11-22). An `UnknownElementModel` (local change 62:
    a type this build has no model for, or a known type the board's rules don't
    read) stands for another build's or person's element, and its copy is that
    element's map as it is: pasted, a known type's map was written whole and reached
    every peer before the board took its own misfit add out again (`keepToCatalog`);
    an unknown type threw `Invalid element type` part way through the paste. Both
    serializers (`prepareClipboardData` for copy and cut, `prepareCloneData` for
    Duplicate and Alt-drag) now leave it out, and a block's placeholder on the canvas
    (one read through a stand-in schema, whose model's flavour is not its stored one)
    too, which no paste config took anyway; a group's copy keeps only the children it
    is copied with, and a group left with nothing is not copied (upstream a group whose
    child was not pasted was not pasted at all). A placeholder in a note's text is left
    out by the board's clipboard middleware (`placeholdersLeftOut`,
    `src/features/blocksuite/boardUnknown.ts`).
    Pinned by "leaves placeholder elements out of a canvas copy and Duplicate" in
    `src/features/blocksuite/boardUnknown.test.ts`.

75. A note's size is saved once typing pauses, by the tab editing it
    (`affine/blocks/note` `note-size.ts`, `components/edgeless-note-mask.ts`
    and `note-edgeless-block.ts`; `affine/gfx/connector`
    `connector-watcher.ts`, `view/view.ts`, `renderer/element-renderer.ts` and
    `renderer/dom-renderer.ts`; `affine/model` `elements/connector/connector.ts`;
    `affine/shared` `utils/note-size-writes.ts`; all marked
    `Capy (local change 75)`; Epo approved cut 2 of
    `bench/collaboration/reports/2026-11-22-room-memory.md`). The mask's
    height observer and an inline note's width observer (local change 53)
    each wrote `xywh` on every key, in every tab that could write, and each
    write took the clock between two typed characters, so no two merged into
    one run: an 80-character note held about 173 structs against 80 bytes of
    text, and a board of typed notes 17 to 21 times its state in the room's
    memory.
    - **The tab whose person changed the note** shows a measured size at once
      (`xywh` stashed: the frame, the selection box and connector paths follow
      it) and saves it 500 ms after the last new measure, at most 2 s after
      the first unsaved one. That is the tab editing the note, or the one whose
      own change that can resize the note came less than 500 ms before the
      measure: each local transaction of the store's document marks the notes
      whose blocks or text it changed, or whose style, scale, width or height,
      or whose fill made them inline or a card (the Inline toggle, an Undo on
      the board, a side resize's last rewrap, the note tool's new note). A move,
      a turn or a colour marks nothing, so a viewer that just moved the note
      still waits as a viewer when a peer's text arrives. A drag, resize or turn ending measures
      the note again as that tab's (`noteGestureEnds`), so a size the
      gesture's own write left out still goes in.
    - That tab saves at once, untracked, when editing ends, the block
      disconnects, the page is hidden, the board is saved (`saveNoteSizes`,
      called by `drawingBoard.ts` in `save` and `snapshot`), a drag, resize or
      turn starts (`noteGestureStarts`: the gesture keeps its own stash and its
      own tracked pop) or any tracked step of the store starts (align,
      `updateBlock`: `openNoteSizes` wraps the store's `transact`). Undoing the
      step or the gesture leaves the typed height. A plain write of the model
      outside the store's steps (the arrow keys' nudge, untracked itself)
      stores the size with it. A peer's or an Undo's write shows at once, the measured size
      over it, and the save writes the measured size (before the note's scale)
      onto it.
    - **Every other tab** shows what it measures at once too, as a size only
      it shows, written only as below (`xywh` stashed, `display`: hit tests, the
      selection box and connector paths follow the text it shows; 2026-11-24,
      a wrong-behaviour fix: holding nothing, a note whose text outgrew its
      stored height took a double click on its last lines as empty board, for
      3 s in an editor's tab and for good in one that never writes). Each note
      it measured is watched (`observe`): a peer's or an Undo's write shows at
      once, what this tab measures over it, so a peer's newly written size
      replaces the shown one wherever this tab's text measures the same.
    - In a writable tab, the size a note shows is stored, untracked
      (`storeShown`, its connectors' labels placed in the same write), before
      a drag, resize or turn of it (`noteGestureStarts`; multi-select moves
      start one per note) and before a tracked step of the store that can act
      on it (the wrapped `transact`): a note selected, or in a selected group
      or frame (`selectNoteSizes`, given the board's selection by
      `drawingBoard.ts`), as for an align or a distribute. The gesture or
      step then starts from the bound shown with no jump of the frame (the
      drag and resize read their start from `xywh`), holds only what it
      changes, and its Undo keeps the size, so previews (`boardPreview.ts`,
      the stored height clipped) and tabs that have not drawn the note see it
      as shown (2026-11-24, a wrong-behaviour fix: the shown size stepped
      aside at a gesture's start and the frame jumped to the stored size;
      then, written with the move, an Undo brought back a stored size nothing
      rewrote, and a press on a handle alone made a size-only undo step). No
      other note is stored before a step, and none after one: Yjs's Undo never
      writes over a later write by another client, so a pen stroke that
      stored every shown size took a peer's move of such a
      note out of the peer's Undo, which undid the step before it instead,
      and rewrote every note the two tabs measure differently on every stroke.
      A plain write of a note showing a size, which the stash keeps here (the
      arrow keys' nudge, untracked itself), is stored as written, the size
      shown with it (`passOn`); one inside a step that did not store it is
      written with the stored size where it kept the shown one, so that
      step's Undo moves the note back alone. In a
      read-only tab such a local write never reaches the store: the size
      shows again. Copy, Duplicate and an Alt-drag's clone read the note's
      `props`, so they take the size shown: harmless, the copy is a new note
      whose own tab measures it, but a path outside the gesture rule.
    - It writes nothing per key: it writes what it measures only once that
      has differed from the stored size for 3 s (`NOTE_SIZE_VIEWER_MS`, the
      editing tab's longest wait and 1 s), as a plain write, its connectors'
      labels placed in the same write (no Undo step of their own). A note no
      one edits (an agent's, a font change, a card code added) still gets its
      size from the first tab that measures it. A size someone else writes
      during the wait (a peer's, an Undo's) ends it: the tab goes on showing
      its own measure and writes nothing (2026-11-24, a wrong-behaviour fix:
      the wait started again, and its write 3 s later, the last, took a peer's
      move of the note out of that peer's Undo, which undid the step before
      it instead). Its own write ends the wait and the watch for it too, so two
      tabs whose fonts measure a note differently write once at most and then
      show their own sizes, with no write back and forth; only a step that
      acts on the note (above) stores a tab's own size again, one write per
      step, never one answering another.
    - A connector's label shows where its stored offset falls on the path this
      tab shows (`shownLabelXYWH`: the stored size, centred at
      `labelOffset.distance`), for drawing (both renderers), hit tests and
      bounds, the label's hit area (so a double click or a drag starts there)
      and the canvas's redraw reach (local change 76). Every place BlockSuite
      stores is that centre (the path's own placement, the label editor, a
      label drag), so where a tab placed the label the two agree; in a tab
      whose shown size moves a path with no label placed (a viewer, a size
      shown without a wait) the label stays on its line, with nothing held or
      written. Writes still read and write `labelXYWH` as before: a move, the
      label editor, a label drag, the style toolbar, and their Undo. Two of
      them can store a place off the offset, upstream: the style toolbar keeps
      the stored centre as it resizes the label, wherever the path now is,
      and a drag of the connector alone moves the stored place with the
      pointer (and stashes it again at the end instead of saving it) while a
      connector held at both ends keeps its path; drawn from its offset, the
      label stays on its line there too
      (2026-11-24, a wrong-behaviour fix: the path followed the shown bound and
      the label stayed where the document had it, off its line).
    - The width is written only while the note is inline: a note turned into
      a card drops it.
    - A read-only store writes nothing: a waiting size is dropped, what the
      tab measures still shown as its own; `setLocked` drops them
      (`dropNoteSizes`) before clearing the selection, whose end would save
      them. The observers measure while read-only too, and unlocking measures
      every note again with its last size (`measureNoteSizesAgain`), a size
      the lock dropped as this tab's own.
    - **A locked note** (`sizeIsFixed`: BlockSuite's `isLocked()`, the note's
      own lock or a group's, as a Canvas question's elements on a student's
      copy) keeps its stored size. The lock stops a person's edits, not code's,
      so without this a tab whose fonts measure differently would rewrite it.
      No tab holds, saves or writes its size; each shows what it measures.
      After a transaction of the store that can lock or unlock a note, this
      tab's or a peer's (`changesLocks`: a
      block's `prop:lockedBySelf` or `prop:childElementIds`, a block added or
      gone, a surface element's `lockedBySelf` or `children`, a group's
      children, an element added or gone; never a typed key, a shape's text or
      a move, so typing checks no lock), a waiting note locked since drops its
      size (nothing is written; what the tab measures still shows), and a note
      unlocked since is measured again with its last size as by a tab not
      editing it, so it is written after 3 s if that still differs. A lock made
      as a tracked step in the tab holding the size (the toolbar's Lock) stores
      the size first, as every tracked step does, since it was measured
      unlocked. So a tab that makes a copy whose elements are locked (a
      student's copy of a Canvas question) must add and lock them in one
      transaction, or the copy is built before the board mounts or on the
      server: a note this tab adds counts as its own change, so a lock in a
      later step would first store the size measured in between.
    - A board's sizes close (`closeNoteSizes`) before its document goes:
      saved, or dropped when the room lost, refused or replaced the board, and
      every wait stops, a viewer's too, with nothing more measured or written
      in that store. Leaving the page, React takes the board's DOM away before
      any effect's cleanup, so each note saves its held size as it disconnects,
      into the room still standing. A room that goes while the board stays
      (replaced, no longer enabled) is torn down before the board's unmount:
      the canvas page closes the sizes in the room's `onLeave`, before the
      teardown, `drop` while locked, since lost, kicked and recovery change the
      document and lock in one render, before `setLocked` runs. The drawing
      answer closes them before its last draft write, whose change they mark
      pending, as its board may go without its DOM (its options changed).
      `unmount(sizes)` closes them too, for a host that has done neither.
    - A connector's label (local change 63) moves with the saved size, not per
      key: a size only the editing tab shows is not an own change for it, and
      the save places the labels inside its transaction.
    Size saves take no undo step, as before (their transaction's origin is not
    the history's). Other tabs see the size up to 2 s later. Pinned by
    `src/features/blocksuite/noteSize.test.ts` and two tests in
    `e2e/editor/canvas-presence.spec.ts` ("a note's size reaches another person
    once typing pauses", "a note's waiting size is stored when editing ends or
    the board is saved") and `e2e/editor/board-note-size.spec.ts` (a note
    stored shorter than its text takes a double click on its last line right
    after an editor's board opens, a viewer's click there selects it, its
    frame round the text, and an editor's drag of a note showing its text's
    size starts from that size and writes it with the move in one step).

76. A change to one canvas element draws again only the part of its canvas
    that element covered and covers now (`affine/blocks/surface`
    `renderer/canvas-renderer.ts`, marked `Capy (local change 76)`;
    2026-11-23, `bench/editor/reports/2026-11-23-board-typing.md`). Upstream
    an element's refresh marked its layer's canvas dirty and the next frame
    cleared that canvas and drew every element in view on it. Typing a canvas
    label, a shape's label or a connector's label writes the element each key
    (its text, its size, the connector's label box), so each key redrew every
    plane card's grid, formula's glyphs and stroke on that canvas, though the
    edited label itself is hidden while its editor is open: on a board whose
    notes sit under every canvas element (one canvas, as the large and dense
    bench boards build them) that was the presentation delay of every key.
    - Each dirty canvas now keeps a region, in model units: for each changed
      element, where its drawing reached when it was last drawn and where it,
      and the groups holding it (a mind map's lines, a group's title), reach
      now. A reach is the element's turned bound (`getBoundWithRotation`, from
      the element's parsed `xywh`; `elementBound` parses it again each call)
      with what it draws outside it (`externalBound`, a connector's label),
      plus 24 for antialiasing and glyph overhang, 8 times its stroke width (a
      connector's arrowhead reaches 7.5) and its shadow. Local elements count
      too: a connector's label has a transparent local shape as its hit area,
      which follows the label each key.
    - The frame clears that region in whole device pixels, clips to it and
      draws there, in order, every element a whole pass would draw there (its
      bound in the canvas's cull bound, as a whole pass culls, and its reach
      in the cleared pixels), then the overlays.
    - Each canvas remembers the origin, scale and size it was last drawn at
      (the main canvas also which layers fell back to it), and a canvas whose
      placement differs is drawn whole: a stacking canvas that grows or
      moves, a pan or zoom, a canvas emptied when its layer left the view. So
      is any refresh of everything or of the main canvas (an element or local
      element added or gone, the selection, a layer change).
    - Once region passes pause for 1 s, the board is drawn whole once (a plain
      timer, then a frame), so a region's edge, where a stroke crossing it is
      drawn clipped, ends as a whole pass draws it. Each region pass restarts
      the timer and a whole pass cancels it, so typing (keys well under 1 s
      apart) never pays it per key.
    - Upstream's `_renderByBound` skipped an element with no renderer after
      `ctx.save()` without restoring it; it restores now, or a region's clip
      would stay on for the rest of the pass.
    Pinned by "a change draws again only what it reaches, on the canvas under
    a note and the one over it, as a whole board's redraw draws it" in
    `e2e/editor/drawing-board.spec.ts`: on a board of about 70 elements, a
    note between a stacking canvas and the main one, moving a shape off the
    board and back, shrinking a shape a connector joins, typing a text label,
    typing a shape's label that wraps and grows it and Backspace, and typing a
    connector's label each draw more than 0 and fewer than 10 elements a pass,
    the Backspace leaving the shape's height while its editor is open, and
    fewer than 20 pixels of every canvas differ by more than 96 levels from a
    whole redraw (each step's count logged) (on the GPU, read through a copy;
    drawn without it, a stroke crossing a region's edge comes out up to about
    64 of 255 levels off there, a stale dark stroke 200 or more). A pause after a key brings one whole pass, and a stacking
    canvas that grows is drawn whole.

77. The reference popup's input rules are scoped to `reference-popup`
    (`affine/inlines/reference` `reference-popup.ts`, marked `Capy (local change
    77)`): it is a ShadowlessElement, whose styles go to the document, and its
    bare `input { display: flex; padding: 0; border: none; background:
    transparent }` restyled every input on the page once a board loaded and
    showed the app's hidden file inputs (Tailwind's `hidden` is layered, the
    injected rule is not).

78. Undo and redo keys stop at their own handler
    (`affine/blocks/root/src/keyboard/keyboard-manager.ts`, marked `Capy (local
    change 78)`): 'Mod-z', 'Shift-Mod-z' and 'Control-y' return true. Off a Mac,
    Ctrl+Shift+Z arrives as a lowercase `z` with Shift, so the keymap, finding the
    redo handler's return falsy, tried the key again without Shift and ran
    'Mod-z': every Ctrl+Shift+Z on Windows and Linux redid and undid at once.
    `e2e/editor/drawing-board.spec.ts` ("a teacher's area moves by its label")
    redoes with it on CI's Linux.

79. A pen or highlighter stroke's points are one binary value of Float32s
    (`affine/model` `elements/brush/brush.ts` and `elements/highlighter/highlighter.ts`,
    `affine/gfx/brush` `brush-tool.ts` and `highlighter-tool.ts`, `affine/blocks/surface`
    `surface-transformer.ts`, `framework/std` `gfx/model/surface/decorators/convert.ts`
    and `gfx/model/surface/surface-model.ts`, marked `Capy (local change 79)`; Epo
    2026-11-24,
    `bench/collaboration/reports/2026-11-24-binary-pen-points.md`). Upstream stored
    `[[x, y, pressure?], ...]`, a Yjs value per number, which made a pen board's live
    document about twelve times its saved size. The format and its one codec are
    Capy's `src/features/blocksuite/strokePoints.ts` (a 4-byte header naming 2 or 3
    values a point, then little-endian Float32s), which these files import as
    `@/features/blocksuite/strokePoints`.
    - `points` reads as the stored `Uint8Array` (relative to `xywh`, as before) and is
      set as drawn, `number[][]` in board units: `@convert` encodes it, and the
      `xywh` and `lineWidth` derives decode, move and set the points again.
      `convert` takes a set type apart from the stored one (`I`) for this.
    - `serialize()` gives the points back as drawn (relative), so a copy, a paste,
      Duplicate and an Alt-drag clone set them through `@convert` as a peer's JSON
      clipboard does.
    - `includesPoint` reads the bytes in place (`strokeNearPoint`), the pointer turned
      back about the box's centre, which also ends upstream's read past the end of a
      one-point stroke; `getLineIntersections` decodes only for a line that crosses
      the box, as the eraser asks every stroke on every move; `commands` and
      `getNearestPoint` decode.
    - The tools count the drawn points for their pop gap.
    - The surface transformer writes a binary value into a snapshot as
      `{ 'affine:surface:bytes': true, bytes }`, so a JSON snapshot keeps it.
    - A peer's write to an existing element's keys is read again by the editor's
      say (local change 62's `ElementReadableIdentifier`), and an element it can no
      longer read becomes a placeholder then and there (`_readAgain`), as on load:
      upstream only read an element as it was added, so a peer overwriting a
      stroke's points with a number array made its model throw on every frame,
      and the canvas drew nothing more for anyone in the room.
    A stroke whose bytes break the format, or that has none, is refused by the
    board's rules (`boardRules.ts`), drawn as a placeholder on a canvas and refusing
    a question's board, and `strokeView` throws for any value that isn't stored
    points. Pinned by `strokePoints.test.ts` and the stroke cases of
    `boardRules.corpus.test.ts`. In dev, run `vite --force` after editing
    `strokePoints.ts`: Vite pre-bundles the vendored models with their copy of it,
    and a stale bundle and the app's rules would read the format apart.

Icons: `@blocksuite/icons/lit` is aliased in `vite.config.ts` to
`src/features/blocksuite/blocksuiteIcons.ts`, which re-exports AFFiNE's set and
replaces about ninety names with the app's Hugeicons, so the swap itself edits no
vendored file. The two duotone highlight icons keep AFFiNE's drawing (their first
path takes the picked colour); the icon edits that are in vendored files are the
sizes of local change 34 and the Callout rows of 39.
