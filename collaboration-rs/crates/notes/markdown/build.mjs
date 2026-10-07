// Bundles the editor's markdown import (src/features/notes/markdownConvert.ts)
// for the notes crate's embedded JS engine (QuickJS), as
// collaboration/scripts/build-markdown.mjs bundles it for Node: same entry,
// same aliases and defines, but for a plain ES runtime (no Node builtins).
// The Rust side (markdown.rs) gives it `crypto.getRandomValues` and
// `console`.
//   node build.mjs <checkout> <out.mjs>
// <checkout>: a Capy checkout with node_modules and collaboration/node_modules.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, out] = process.argv.slice(2).map((p) => resolve(p));
const require = createRequire(
  pathToFileURL(`${checkout}/collaboration/package.json`)
);
const { build } = require('esbuild');

await build({
  alias: {
    '@': `${checkout}/src`,
    '@/i18n': `${checkout}/collaboration/scripts/i18n-stub.mjs`,
  },
  bundle: true,
  // A worker has no DOM: packages pick their DOM-free builds.
  conditions: ['worker'],
  define: {
    'import.meta.env': '{}',
    'process.env.NODE_ENV': '"production"',
  },
  entryPoints: [`${checkout}/src/features/notes/markdownConvert.ts`],
  format: 'esm',
  logLevel: 'warning',
  minify: true,
  nodePaths: [`${checkout}/collaboration/node_modules`],
  outfile: out,
  platform: 'browser',
  target: 'es2023',
});
