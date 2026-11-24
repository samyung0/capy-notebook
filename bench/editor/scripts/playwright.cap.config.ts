import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * How long a canvas at its size cap takes to open. Run by hand with:
 * node_modules/.bin/playwright test --config=bench/editor/scripts/playwright.cap.config.ts
 *
 * The editor bench's production build with MSW (vite.cap.config.ts,
 * VITE_BENCH_MSW; Vite's development mode before 2026-11-24): the Canvas page
 * opens its board through the mock collaboration room. The board's own route (/dev/drawing) is kept too
 * (VITE_BENCH_ROUTES), for the same state opened with no room. No workflow
 * runs this; the build takes about eight minutes on an M1 under load.
 *
 * Environment knobs:
 * - PERF_CAP_PORT      preview port (default 4524).
 * - PERF_CAP_BASE_URL  a preview of this build that is already running; none
 *   is built or started.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_CAP_PORT ?? 4524);
const running = process.env.PERF_CAP_BASE_URL;
const outDir = path.join(perfDir, '..', '.results', 'cap-dist');
const viteConfig = path.join(perfDir, 'vite.cap.config.ts');
// The build's env directory (CAPY_ENV_DIR in vite.config.ts): none of deploy/.env.
const envDir = path.join(perfDir, '..', '.results', 'empty-env');
mkdirSync(envDir, { recursive: true });

export default defineConfig({
  fullyParallel: false,
  // Its own folder: a run empties it, and other suites use the default.
  outputDir: path.join(perfDir, '..', '.results', 'board-open-at-cap'),
  projects: [{ name: 'chromium-cap', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: perfDir,
  testMatch: '**/*.cap.ts',
  timeout: 2_400_000,
  use: {
    baseURL: running ?? `http://127.0.0.1:${port}`,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    viewport: { height: 800, width: 1280 },
  },
  webServer: running
    ? undefined
    : {
        // The production build with MSW the editor bench makes
        // (playwright.perf.config.ts). The heap flag is the one `pnpm build`
        // uses.
        command: `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --config ${viteConfig} --outDir ${outDir} --emptyOutDir && node node_modules/vite/bin/vite.js preview --config ${viteConfig} --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
        cwd: root,
        env: {
          ...process.env,
          CAPY_ENV_DIR: envDir,
          NODE_ENV: 'production',
          VITE_BENCH_MSW: 'true',
          VITE_BENCH_ROUTES: 'true',
          VITE_CLERK_PUBLISHABLE_KEY: '',
        },
        reuseExistingServer: false,
        timeout: 1_200_000,
        url: `http://127.0.0.1:${port}`,
      },
  workers: 1,
});
