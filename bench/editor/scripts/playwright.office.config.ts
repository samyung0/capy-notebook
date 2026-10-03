import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Office runtime harness. Run with: pnpm bench:office
 *
 * Unlike the Plate harness this measures a production build (minified, React
 * production mode) with MSW mocks, because the Office runtime's costs are
 * engine and paint work that the dev build distorts. The runtime is served
 * from a second origin (127.0.0.1 against the app's localhost), so view and
 * edit run in the real cross-origin iframe. The build takes a few minutes.
 *
 * Environment knobs:
 * - PERF_OFFICE_PORT  preview port (default 4518).
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_OFFICE_PORT ?? 4518);
const outDir = path.join(perfDir, '..', '.results', 'office-dist');

export default defineConfig({
  fullyParallel: false,
  projects: [{ name: 'chromium-office', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: perfDir,
  testMatch: '**/*.office.ts',
  timeout: 600_000,
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    viewport: { height: 800, width: 1280 },
  },
  webServer: {
    // MSW needs the development mode; NODE_ENV=production keeps React and
    // the bundle production. The heap flag is the one `pnpm build` uses.
    command: `node --max-old-space-size=4096 node_modules/vite/bin/vite.js build --mode development --outDir ${outDir} --emptyOutDir && node node_modules/vite/bin/vite.js preview --mode development --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      // Seeds the 62-page document next to the rich-content fixtures.
      VITE_LOAD_TEST_SEED: 'true',
      VITE_OFFICE_RUNTIME_ORIGIN: `http://127.0.0.1:${port}`,
      VITE_USE_MSW: 'true',
    },
    reuseExistingServer: false,
    timeout: 1_200_000,
    url: `http://127.0.0.1:${port}`,
  },
  workers: 1,
});
