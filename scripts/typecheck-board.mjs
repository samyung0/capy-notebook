// Type-checks the drawing board (tsconfig.board.json). The board imports
// vendored BlockSuite as .ts sources, so tsc checks them too, and upstream's
// sources have errors in this setup (deps their package.json doesn't declare,
// tag-map augmentations in files nothing imports). Those are pinned per file
// below: a vendored file with more errors than its pin (one not listed has 0),
// any other error, or a tsc failure, fails, so an error in Capy's own changes
// to vendor/blocksuite shows. Lower a pin when its errors go.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const VENDOR = 'vendor/blocksuite/';
const VENDORED_ERRORS = {
  'affine/blocks/attachment/src/embed.ts': 10,
  'affine/blocks/database/src/adapters/html.ts': 1,
  'affine/blocks/embed-doc/src/embed-synced-doc-block/configs/toolbar.ts': 2,
  'affine/blocks/frame/src/edgeless-toolbar/frame-tool-button.ts': 2,
  'affine/blocks/frame/src/frame-toolbar.ts': 2,
  'affine/blocks/list/src/adapters/html.ts': 2,
  'affine/blocks/note/src/commands/change-note-display-mode.ts': 2,
  'affine/blocks/surface/src/renderer/dom-renderer.ts': 3,
  'affine/blocks/table/src/adapters/html.ts': 1,
  'affine/blocks/table/src/adapters/markdown.ts': 1,
  'affine/blocks/table/src/adapters/utils.ts': 4,
  'affine/components/src/slider/slider.ts': 3,
  'affine/data-view/src/core/data-source/base.ts': 1,
  'affine/data-view/src/core/group-by/trait.ts': 2,
  'affine/data-view/src/view-presets/table/pc-virtual/virtual/virtual-scroll.ts': 6,
  'affine/gfx/group/src/interaction-ext.ts': 4,
  'affine/gfx/group/src/toolbar/config.ts': 2,
  'affine/gfx/text/src/tool.ts': 2,
  'affine/inlines/footnote/src/adapters/markdown/inline-delta.ts': 1,
  'affine/inlines/latex/src/adapters/markdown/inline-delta.ts': 1,
  'affine/inlines/latex/src/command.ts': 1,
  'affine/inlines/latex/src/markdown.ts': 1,
  'affine/inlines/link/src/adapters/html/html-inline.ts': 5,
  'affine/inlines/link/src/adapters/markdown/inline-delta.ts': 1,
  'affine/inlines/link/src/adapters/notion-html/html-inline.ts': 5,
  'affine/inlines/reference/src/adapters/markdown/inline-delta.ts': 1,
  'affine/model/src/blocks/callout/callout-model.ts': 1,
  'affine/shared/src/adapters/html/html.ts': 1,
  'affine/shared/src/adapters/pdf/pdf.ts': 3,
  'affine/shared/src/utils/drag-helper/cell-select.ts': 2,
  'affine/widgets/drag-handle/src/watchers/drag-event-watcher.ts': 1,
  'affine/widgets/edgeless-toolbar/src/extension/index.ts': 3,
  'affine/widgets/slash-menu/src/config.ts': 1,
  'affine/widgets/slash-menu/src/slash-menu-popover.ts': 1,
  'affine/widgets/slash-menu/src/utils.ts': 2,
  'framework/global/src/di/provider.ts': 1,
  'framework/global/src/disposable/index.ts': 4,
  'framework/std/src/gfx/interactivity/manager.ts': 22,
  'framework/std/src/gfx/viewport-element.ts': 1,
  'framework/std/src/inline/extensions/inline-manager.ts': 3,
  'framework/std/src/inline/services/text.ts': 1,
  'framework/sync/src/blob/impl/indexeddb.ts': 2,
  'framework/sync/src/doc/impl/broadcast.ts': 1,
  'framework/sync/src/doc/impl/indexeddb.ts': 1,
  'framework/sync/src/doc/peer.ts': 3,
};

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json')
  ),
  'bin/tsc'
);
const run = spawnSync(
  process.execPath,
  [tsc, '-p', 'tsconfig.board.json', '--noEmit', '--pretty', 'false'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);
if (run.error) {
  throw run.error;
}

// One diagnostic per unindented line; indented lines continue the one above.
const diagnostics = [];
for (const line of run.stdout.split('\n')) {
  if (/^\s/.test(line) && diagnostics.length > 0) {
    diagnostics[diagnostics.length - 1] += `\n${line}`;
  } else if (line.trim()) {
    diagnostics.push(line);
  }
}
const ours = diagnostics.filter((d) => !d.startsWith(VENDOR));
const byFile = new Map();
for (const d of diagnostics.filter((each) => each.startsWith(VENDOR))) {
  const file = d.slice(VENDOR.length, d.indexOf('('));
  byFile.set(file, [...(byFile.get(file) ?? []), d]);
}
// A file past its pin shows all its errors, as tsc can't say which are new.
const grown = [...byFile.entries()].filter(
  ([file, list]) => list.length > (VENDORED_ERRORS[file] ?? 0)
);
const vendored = diagnostics.length - ours.length;

for (const list of [ours, ...grown.map(([, each]) => each)]) {
  if (list.length > 0) {
    process.stdout.write(`${list.join('\n')}\n`);
  }
}
if (run.stderr) {
  process.stderr.write(run.stderr);
}
process.stdout.write(
  `typecheck:board: ${ours.length} error(s), ${vendored} in ${VENDOR} (${grown.length} file(s) past their pin)\n`
);
// tsc exits non-zero on any error, so a failure with nothing parsed (a crash,
// a bad config printed elsewhere) fails too.
const failed =
  ours.length > 0 ||
  grown.length > 0 ||
  run.signal ||
  (run.status !== 0 && diagnostics.length === 0);
process.exit(failed ? 1 : 0);
