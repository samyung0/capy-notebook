/* The output preview's bundle: the app's markdown import, read-only note
 * renderer and styles on one page, served by playground.py at /preview/.
 * Build from the repository root (playground.py --check and a server start
 * without a bundle run the same):
 *   pnpm exec vite build --config lab/playground/preview/vite.config.ts */
import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repo = path.resolve(import.meta.dirname, '../../..');

export default defineConfig({
  base: '/preview/',
  build: {
    emptyOutDir: true,
    outDir: path.join(repo, 'lab/playground/local/preview'),
  },
  // The interactive block's frame comes from the playground under the other
  // loopback name, which only the page knows (index.html sets it).
  define: { 'import.meta.env.VITE_EMBED_ORIGIN': 'EMBED_ORIGIN' },
  plugins: [
    react(),
    tailwindcss(),
    // The app's settings, so the generated messages stay the app's.
    paraglideVitePlugin({
      outdir: path.join(repo, 'src/i18n/paraglide'),
      project: path.join(repo, 'project.inlang'),
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
  ],
  resolve: {
    alias: [
      { find: '@paraglide', replacement: path.join(repo, 'src/i18n/paraglide') },
      { find: '@', replacement: path.join(repo, 'src') },
    ],
  },
  root: import.meta.dirname,
});
