// Bundles the editor's markdown import (src/features/notes/markdownConvert.ts)
// for Node, so agent markdown becomes the same nodes a paste gives. The output
// sits beside the compiled server, which loads it on first use
// (src/markdown.ts). Run from the collaboration package; the Dockerfile copies
// the frontend sources this reads.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
await build({
  alias: {
    '@': `${root}src`,
    '@/i18n': fileURLToPath(new URL('./i18n-stub.mjs', import.meta.url)),
  },
  // Some bundled CommonJS calls require; give the ES module one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  bundle: true,
  define: {
    'import.meta.env': '{}',
    'process.env.NODE_ENV': '"production"',
  },
  entryPoints: [`${root}src/features/notes/markdownConvert.ts`],
  format: 'esm',
  logLevel: 'warning',
  minify: true,
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  outfile: fileURLToPath(
    new URL('../dist/markdown.bundle.mjs', import.meta.url)
  ),
  platform: 'node',
  target: 'node22',
});
