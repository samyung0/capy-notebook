# BlockSuite (vendored)

BlockSuite's packages copied in as plain files, for the note editor spike
(`todo-blocksuite-spike.md`). Not a submodule: an upstream sync is a re-copy
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
- `.css.ts` (vanilla-extract): `@vanilla-extract/vite-plugin` in `vite.config.ts`.
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

Outside this directory, for BlockSuite:

- `patches/@atlaskit__pragmatic-drag-and-drop@1.4.0.patch`: upstream's yarn
  patch for that package, as a pnpm patch.
- Upstream's yarn patch for `yjs` 13.6.21 (53-bit client ids) is **not**
  carried: our rooms assign client ids.
