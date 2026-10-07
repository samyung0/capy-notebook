// Bundles the editor's markdown import (src/features/notes/markdownConvert.ts)
// for the notes crate's embedded V8 (src/markdown.rs): one script that sets
// `globalThis.__markdown` to the module's exports, for a plain JS runtime
// (no DOM, no Node builtins; markdown.rs gives it `console`,
// `crypto.getRandomValues` and `URL`). Same entry, aliases and defines as the
// Node server's bundle. Its dependencies are this package's own, so an image
// installs only them (pnpm --filter @capy-notebook/notes-markdown...).
//   node build.mjs [out]   (default: markdown.bundle.js beside this script)
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const root = here('../../../../');
await build({
  alias: {
    '@': `${root}src`,
    '@/i18n': here('./i18n-stub.mjs'),
  },
  bundle: true,
  // A worker has no DOM: packages pick their DOM-free builds.
  conditions: ['worker'],
  define: {
    'import.meta.env': '{}',
    'process.env.NODE_ENV': '"production"',
  },
  entryPoints: [`${root}src/features/notes/markdownConvert.ts`],
  format: 'iife',
  globalName: '__markdown',
  logLevel: 'warning',
  minify: true,
  nodePaths: [here('./node_modules')],
  outfile: process.argv[2] ?? here('./markdown.bundle.js'),
  platform: 'browser',
  target: 'es2023',
});
