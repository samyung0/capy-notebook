import path from 'node:path';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';

const repository = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  // The growth bound's property tests open the editor bench's load-test note
  // (src/mocks/noteContent), which reaches frontend modules through `@` and
  // their messages through `@paraglide`. Resolved and compiled with the same
  // options as the root vite.config.ts, which `pnpm test:collaboration` uses.
  plugins: [
    paraglideVitePlugin({
      outdir: path.join(repository, 'src/i18n/paraglide'),
      project: path.join(repository, 'project.inlang'),
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
  ],
  resolve: {
    alias: [
      {
        find: '@paraglide',
        replacement: path.join(repository, 'src/i18n/paraglide'),
      },
      { find: '@', replacement: path.join(repository, 'src') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
