import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * Update rates per connection: what real editing sends to the collaboration
 * server, as the input for its per-connection rate limit. Run with:
 * pnpm bench:rates
 *
 * The Vite dev server with MSW, as the editor perf harness: the editors and
 * the Office runtime are the real ones, and the mock rooms receive exactly the
 * Yjs updates the room provider would send, one message per update.
 *
 * Environment knobs:
 * - RATES_PORT   Vite port (default 4536).
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..', '..', '..');
const port = Number(process.env.RATES_PORT ?? 4536);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  fullyParallel: false,
  projects: [{ name: 'chromium-rates', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: scriptsDir,
  testMatch: '**/*.rates.ts',
  timeout: 600_000,
  use: {
    baseURL,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    viewport: { height: 800, width: 1280 },
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: {
      ...process.env,
      BROWSER: 'none',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      // The perf notes (mat_perf_small and the ~2 MB load-test note).
      VITE_LOAD_TEST_SEED: 'true',
      VITE_USE_MSW: 'true',
    },
    reuseExistingServer: false,
    timeout: 180_000,
    url: baseURL,
  },
  workers: 1,
});
