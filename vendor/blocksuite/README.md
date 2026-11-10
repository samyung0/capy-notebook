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

15. Phone toolbar (`affine/widgets/edgeless-toolbar` `edgeless-toolbar.ts`, marked
    `Capy (local change 15)`): below 768 px the toolbar takes the full width less an
    8 px gutter, in place of AFFiNE's 64 px safe area each side, its illustrated tools
    are 78 px wide and spread with `space-around`, so two show between the arrows. The
    change is the `FULL_WIDTH_*` constants, the media rule, `_availableWidth` and
    `scrollSeniorToolSize`.

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
    dismissed without a pick leaves the slash on the line, as a typed one does.
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
    header row hands it to the next first row.
39. Callout kinds (`blocks/callout` `callout-block.ts`, marked `Capy (local change
    39)`; Epo 2026-11-10): once the app calls `setCalloutVariantIcon`, a callout sets
    `data-variant` from the block's `variant` (none reads as info), draws that kind's
    icon in place of the emoji with no icon picker, and leaves its background to the
    app's styles (`src/features/blocksuite/calloutLook.ts`, `pageEditor.css`).
    Callout's row in the slash menu, in Turn into and in the phone keyboard toolbar
    (`configs/slash-menu.ts`, `rich-text` `conversion.ts`, `widgets/keyboard-toolbar`
    `config.ts`) shows the information icon, where upstream reuses Text's.

Icons: `@blocksuite/icons/lit` is aliased in `vite.config.ts` to
`src/features/blocksuite/blocksuiteIcons.ts`, which re-exports AFFiNE's set and
replaces about ninety names with the app's Hugeicons, so the swap itself edits no
vendored file. The two duotone highlight icons keep AFFiNE's drawing (their first
path takes the picked colour); the icon edits that are in vendored files are the
sizes of local change 34 and the Callout rows of 39.
