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
- `zod`: the packages keep zod 3.25.76 and the app keeps zod 4; each importer
  resolves its own. `vite.config.ts` excludes `zod` from dependency
  pre-bundling, which keys a dependency by bare name and would hand both the
  same copy in development.
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

Outside this directory, for BlockSuite:

- `patches/@atlaskit__pragmatic-drag-and-drop@1.4.0.patch`: upstream's yarn
  patch for that package, as a pnpm patch.
- Upstream's yarn patch for `yjs` 13.6.21 (53-bit client ids) is **not**
  carried: our rooms assign client ids.
