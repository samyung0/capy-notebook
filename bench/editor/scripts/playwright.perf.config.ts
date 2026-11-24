import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';
import { buildLabel } from './snapshot';

/**
 * Editor performance harness. Run with: pnpm bench:editor
 *
 * A production build (Vite's production mode, as UAT's, minified, React
 * production mode) with MSW mocks in the page, turned on by the benches'
 * switch VITE_BENCH_MSW (vite.cap.config.ts), served by `vite preview` (Epo
 * 2026-11-24, "Yes, move it" and "Yes, production mode"; the dev server
 * before). No Docker stack: typing latency and frame rate are entirely
 * client-side, and the mocks, with the same `/api` latency as on the dev
 * server, remove backend variance from the numbers. The build reads an empty
 * env directory, so a developer's deploy/.env stays out. It takes a few
 * minutes.
 *
 * Environment knobs:
 * - PERF_CPU       CPU throttling rate applied via CDP after page load
 *                  (default 4; try 6+ to approximate low-end mobile).
 * - PERF_PORT      preview port (default 4517).
 * - PERF_BASE_URL  a preview of such a build that is already running; none is
 *                  built or started.
 * - PERF_PROFILE   runs the two profile specs; the build is then left
 *                  unminified so their profiles name functions (still React's
 *                  production mode), and the budget specs' numbers from it
 *                  are not comparable.
 *
 * Numbers are absolute-machine-dependent: budgets in the specs are regression
 * tripwires with generous headroom, not UX targets. Use DevTools traces for
 * diagnosis; use these tests to notice when something gets much worse.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_PORT ?? 4517);
const running = process.env.PERF_BASE_URL;
const outDir = path.join(perfDir, '..', '.results', 'editor-dist');
const viteConfig = path.join(perfDir, 'vite.cap.config.ts');
// The build's env directory (CAPY_ENV_DIR in vite.config.ts): none of deploy/.env.
const envDir = path.join(perfDir, '..', '.results', 'empty-env');
mkdirSync(envDir, { recursive: true });
const minify = process.env.PERF_PROFILE ? ' --minify false' : '';

export default defineConfig({
  fullyParallel: false,
  // What this run measures, written beside each case (reportMetrics) and read
  // by compare-cli's assemble, so only like runs compare.
  metadata: { build: buildLabel(process.env) },
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
    baseURL: running ?? `http://127.0.0.1:${port}`,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: running
    ? undefined
    : {
        // The heap flag is the one `pnpm build` uses. One build, then its
        // preview, which stops with the command.
        command: `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --config ${viteConfig} --outDir ${outDir} --emptyOutDir${minify} && node node_modules/vite/bin/vite.js preview --config ${viteConfig} --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
        cwd: root,
        env: {
          ...process.env,
          CAPY_ENV_DIR: envDir,
          NODE_ENV: 'production',
          VITE_BENCH_MSW: 'true',
          VITE_CLERK_PUBLISHABLE_KEY: '',
          // Both perf notes: the ~2MB load-test fixture and mat_perf_small.
          VITE_LOAD_TEST_SEED: 'true',
        },
        reuseExistingServer: false,
        timeout: 1_200_000,
        url: `http://127.0.0.1:${port}`,
      },
  workers: 1,
});
