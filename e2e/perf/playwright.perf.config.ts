import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Editor performance harness. Run with: pnpm perf
 *
 * Unlike the functional e2e suite this runs against the Vite dev server with
 * MSW mocks (no Docker stack): typing latency and frame rate are entirely
 * client-side, and mocks remove backend variance from the numbers.
 *
 * Environment knobs:
 * - PERF_CPU     CPU throttling rate applied via CDP after page load
 *                (default 4; try 6+ to approximate low-end mobile).
 * - PERF_PORT    Vite port for the harness (default 4517).
 *
 * Numbers are absolute-machine-dependent: budgets in the specs are regression
 * tripwires with generous headroom, not UX targets. Use DevTools traces for
 * diagnosis; use these tests to notice when something gets much worse.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..');
const port = Number(process.env.PERF_PORT ?? 4517);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  fullyParallel: false,
  projects: [
    {
      name: 'chromium-perf',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-perf' }],
  ],
  retries: 0,
  testDir: perfDir,
  testMatch: '**/*.perf.ts',
  timeout: 600_000,
  use: {
    baseURL,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: {
      ...process.env,
      VITE_CLERK_PUBLISHABLE_KEY: '',
      // The near-limit fixture is the shared ~2MB load-test note.
      VITE_LOAD_TEST_SEED: 'true',
      // Adds the small baseline note to the mock db.
      VITE_USE_MSW: 'true',
    },
    reuseExistingServer: true,
    timeout: 120_000,
    url: baseURL,
  },
  workers: 1,
});
