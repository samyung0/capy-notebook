// Bundles a checkout's bench/collaboration/scripts/stress.ts into one ESM file
// that a stock node:22-alpine generator container runs (STRESS_STACK=external).
// Packages resolve from a node_modules tree given on the command line (the
// main checkout's, read only); `@/` is the checkout's src/, as in the app, and
// `@/i18n` the collaboration image's stub (the generated messages are not in
// a git archive; the load-test note's imports only reach them in passing).
// The bundle must sit at <root>/bench/collaboration/scripts/ so stress.ts's
// `root` (three levels up) finds the fixtures copied beside it.
//
// Usage: node bundle.mjs <esbuild package dir> <source root> <node_modules> <outfile> [i18n stub]
// (the stub defaults to main's collaboration/scripts/i18n-stub.mjs; the Rust
// branch has it at collaboration-rs/crates/notes/markdown/i18n-stub.mjs).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [esbuildDir, root, nodeModules, outfile, i18nStub] = process.argv.slice(2);
if (!outfile) throw new Error('usage: bundle.mjs <esbuild dir> <source root> <node_modules> <outfile> [i18n stub]');
const { build } = await import(pathToFileURL(path.join(esbuildDir, 'lib/main.js')).href);
await build({
  alias: {
    '@': path.join(root, 'src'),
    '@/i18n': i18nStub ?? path.join(root, 'collaboration/scripts/i18n-stub.mjs'),
  },
  // Some bundled CommonJS calls require; give the ES module one.
  banner: {
    js: "import { createRequire as __capyCreateRequire } from 'node:module'; const require = __capyCreateRequire(import.meta.url);",
  },
  bundle: true,
  define: { 'import.meta.env': '{}' },
  entryPoints: [path.join(root, 'bench/collaboration/scripts/stress.ts')],
  format: 'esm',
  logLevel: 'warning',
  nodePaths: [nodeModules],
  outfile,
  platform: 'node',
  target: 'node22',
});
console.log(`bundled ${outfile}`);
