import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * Formula parity audit. Run with: pnpm bench:formula
 *
 * Run it when MathLive is upgraded. It opens the editor feature matrix
 * (VITE_E2E_EDITOR_SEED, as the editor e2e suite does) against the Vite dev
 * server with MSW and compares every formula template's View and Edit
 * geometry. Captures and geometry JSON land in the gitignored
 * bench/editor/.results/formula-parity/.
 *
 * - PERF_PORT  Vite port (default 4517, shared with pnpm bench:editor).
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_PORT ?? 4517);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  fullyParallel: true,
  outputDir: path.join(perfDir, '..', '.results', 'formula-parity'),
  projects: [{ name: 'chromium-formula', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: perfDir,
  testMatch: '**/*.audit.ts',
  timeout: 300_000,
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
      VITE_E2E_EDITOR_SEED: 'true',
      VITE_USE_MSW: 'true',
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
  workers: 2,
});
