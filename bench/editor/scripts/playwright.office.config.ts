import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * Office runtime harness. Run with: pnpm bench:office
 *
 * Unlike the Plate harness this measures a production build (minified, React
 * production mode) with MSW mocks, because the Office runtime's costs are
 * engine and paint work that the dev build distorts. The runtime is served
 * from a second port of localhost: another origin on the same site, as
 * office.capynotebook.com is to the app, so view and edit run in the real
 * cross-origin iframe and share the app's renderer process as in production.
 * The build takes a few minutes.
 *
 * Environment knobs:
 * - PERF_OFFICE_PORT  app port (default 4518); the runtime is on the next one.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_OFFICE_PORT ?? 4518);
const runtimePort = port + 1;
const outDir = path.join(perfDir, '..', '.results', 'office-dist');
// The Office Worker's copy, for the stored `.br` sizes (runtime.office.ts).
const stageDir = path.join(perfDir, '..', '.results', 'office-stage');

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
    // One build and its staged copy, then the runtime's server and the
    // app's (whose URL Playwright waits for); both stop with the command.
    command: `node bench/editor/scripts/office-server.mjs "${outDir}" ${port} "${stageDir}"`,
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      // Seeds the 62-page document next to the rich-content fixtures.
      VITE_LOAD_TEST_SEED: 'true',
      VITE_OFFICE_RUNTIME_ORIGIN: `http://localhost:${runtimePort}`,
      VITE_USE_MSW: 'true',
    },
    reuseExistingServer: false,
    timeout: 1_200_000,
    url: `http://127.0.0.1:${port}`,
  },
  workers: 1,
});
