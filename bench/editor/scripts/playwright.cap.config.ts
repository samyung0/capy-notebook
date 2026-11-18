import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * How long a canvas at its size cap takes to open. Run by hand with:
 * node_modules/.bin/playwright test --config=bench/editor/scripts/playwright.cap.config.ts
 *
 * A production build (minified, React production mode) with MSW, as the Office
 * harness builds one: the Canvas page opens its board through the mock
 * collaboration room. The board's own route (/dev/drawing) is kept too
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
        // MSW needs the development mode; NODE_ENV=production keeps React and
        // the bundle production. The heap flag is the one `pnpm build` uses.
        // vite.cap.config.ts is the app's config for a checkout whose Office
        // engines are not built.
        command: `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --config ${viteConfig} --mode development --outDir ${outDir} --emptyOutDir && node node_modules/vite/bin/vite.js preview --config ${viteConfig} --mode development --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          VITE_BENCH_ROUTES: 'true',
          VITE_CLERK_PUBLISHABLE_KEY: '',
          VITE_USE_MSW: 'true',
        },
        reuseExistingServer: false,
        timeout: 1_200_000,
        url: `http://127.0.0.1:${port}`,
      },
  workers: 1,
});
