// Capy's own Vite config, served headless for the recorder: its own port and
// cache, no browser window, no file watching, bound to localhost.
import path from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import capy from '../../../../vite.config';

export const RECORDER_PORT = 4793;
const root = path.resolve(import.meta.dirname, '../../../..');

export default defineConfig(async (env) => {
  const base = (typeof capy === 'function' ? await capy(env) : capy) as UserConfig;
  return mergeConfig(base, {
    cacheDir: path.resolve(import.meta.dirname, '.vite-cache'),
    root,
    server: {
      hmr: false,
      host: '127.0.0.1',
      open: false,
      port: RECORDER_PORT,
      strictPort: true,
      watch: null,
    },
  } satisfies UserConfig);
});
