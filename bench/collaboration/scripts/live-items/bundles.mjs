/* Bundle sizes for live-items DESIGN.md (sections 5, 6, 8): esbuild with
 * vite's esbuild, minified ESM for the browser, gzip -9 and brotli. React,
 * react-dom and anything listed as shared are external (the app shell has
 * them). node bench/collaboration/scripts/live-items/bundles.mjs <out.json> */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const root = join(here, '../../../..').replaceAll('\\', '/');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite')).call(null, 'esbuild');

const react = ['react', 'react-dom', 'react/jsx-runtime'];
const cases = [
  ['yjs', `export * as Y from 'yjs';`, react],
  [
    'live reads: yjs + y-protocols awareness + RoomProvider',
    `export { RoomProvider } from '${root}/src/features/collaboration/roomProvider.ts';`,
    react,
  ],
  ['@slate-yjs/core (slate, yjs external)', `export * from '@slate-yjs/core';`, [...react, 'slate', 'yjs']],
  [
    'CodeMirror as MermaidCodeEditor loads it (state, view, history)',
    `export { history, historyKeymap } from '@codemirror/commands';
     export { RangeSet, StateEffect, StateField } from '@codemirror/state';
     export { Decoration, EditorView, GutterMarker, gutterLineClass, keymap, lineNumbers } from '@codemirror/view';`,
    react,
  ],
  [
    'CodeMirror + Y.Text binding (yjs external)',
    `export { history, historyKeymap } from '@codemirror/commands';
     export { RangeSet, StateEffect, StateField } from '@codemirror/state';
     export { Decoration, EditorView, GutterMarker, gutterLineClass, keymap, lineNumbers } from '@codemirror/view';
     export { yTextSync } from '${here.replaceAll('\\', '/')}/yTextCodeMirror.ts';`,
    [...react, 'yjs'],
  ],
  [
    'Plate core + YjsPlugin (what a Plate-free diagram editor drops, plugins excluded)',
    `export { Plate, PlateSlate, usePlateEditor } from 'platejs/react';
     export { YjsPlugin } from '@platejs/yjs/react';`,
    react,
  ],
];

const results = [];
for (const [name, contents, external] of cases) {
  const built = await esbuild.build({
    bundle: true,
    external,
    format: 'esm',
    logLevel: 'silent',
    minify: true,
    nodePaths: [join(root, 'node_modules')],
    platform: 'browser',
    stdin: { contents, loader: 'ts', resolveDir: root, sourcefile: 'entry.ts' },
    target: 'es2022',
    write: false,
  });
  const code = built.outputFiles[0].contents;
  results.push({
    brotliKB: +(brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length / 1024).toFixed(1),
    case: name,
    gzipKB: +(gzipSync(code, { level: 9 }).length / 1024).toFixed(1),
    minKB: +(code.length / 1024).toFixed(1),
  });
}
writeFileSync(process.argv[2], `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
