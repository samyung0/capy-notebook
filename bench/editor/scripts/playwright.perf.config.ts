import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * Editor performance harness. Run with: pnpm bench:editor
 *
 * Unlike the functional e2e suite this runs against the Vite dev server with
 * MSW mocks (no Docker stack): typing latency and frame rate are entirely
 * client-side, and mocks remove backend variance from the numbers.
 *
 * Environment knobs:
 * - PERF_CPU     CPU throttling rate applied via CDP after page load
 *                (default 4; try 6+ to approximate low-end mobile).
 * - PERF_PORT    Vite port for the harness (default 4517, 4527 for blocks).
 * - PERF_EDITOR  unset: Plate's budgeted cases only (production promotion);
 *                `plate`: also Plate's side of the BlockSuite comparison;
 *                `blocks`: BlockSuite, report-only, with the dev server on
 *                VITE_DOCUMENT_LAYOUT=blocks (one Vite process serves one
 *                layout, so each editor is its own run). See editor.perf.ts.
 *
 * Numbers are absolute-machine-dependent: budgets in the specs are regression
 * tripwires with generous headroom, not UX targets. Use DevTools traces for
 * diagnosis; use these tests to notice when something gets much worse.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const editor = process.env.PERF_EDITOR ?? '';
if (!['', 'plate', 'blocks'].includes(editor))
  throw new Error('PERF_EDITOR must be plate, blocks or unset');
const blocks = editor === 'blocks';
const port = Number(process.env.PERF_PORT ?? (blocks ? 4527 : 4517));
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
    [
      'html',
      {
        open: 'never',
        outputFolder: blocks
          ? 'playwright-report-perf-blocks'
          : 'playwright-report-perf',
      },
    ],
  ],
  // A BlockSuite run after Plate's in one job keeps Plate's failure output.
  ...(blocks && { outputDir: path.join(root, 'test-results', 'perf-blocks') }),
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
      // Both perf notes: the ~2MB load-test fixture and mat_perf_small.
      VITE_LOAD_TEST_SEED: 'true',
      VITE_USE_MSW: 'true',
      // Set either way, so a shell's own value never picks the editor.
      VITE_DOCUMENT_LAYOUT: blocks ? 'blocks' : 'plate',
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
  workers: 1,
});
