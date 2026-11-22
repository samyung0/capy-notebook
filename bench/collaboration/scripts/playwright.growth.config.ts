import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * How a live board's Yjs state grows against its saved size, as the input for
 * the canvas room's size cap. Run with: pnpm bench:growth
 *
 * The Vite dev server with MSW, as the update rates harness: the Canvas page's
 * board is the real one, and nothing is sent anywhere.
 *
 * Environment knobs:
 * - GROWTH_PORT      Vite port (default 4547).
 * - GROWTH_BASE_URL  a dev server that is already running, to measure another
 *   checkout than this one (a commit while the tree is being edited); none is
 *   started.
 * - GROWTH_MINUTES   the mixed hour's minutes (default 60), for a quick run.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..', '..', '..');
const port = Number(process.env.GROWTH_PORT ?? 4547);
const running = process.env.GROWTH_BASE_URL;
const baseURL = running ?? `http://127.0.0.1:${port}`;
// The preset's Windows UA makes the board read Ctrl as its modifier while
// Playwright sends Meta on a Mac host; keep the host's real platform.
const { userAgent: _windowsUserAgent, ...desktopChrome } =
  devices['Desktop Chrome'];

export default defineConfig({
  fullyParallel: false,
  // Its own folder: every run empties it, and other suites use the default.
  outputDir: path.join(scriptsDir, '..', '.results', 'board-growth'),
  projects: [
    {
      name: 'chromium-growth',
      // The spec's places are laid out for a board this size.
      use: { ...desktopChrome, viewport: { height: 800, width: 1280 } },
    },
  ],
  reporter: [['list']],
  retries: 0,
  testDir: scriptsDir,
  testMatch: '**/*.growth.ts',
  timeout: 1_800_000,
  use: {
    // A step that never lands fails its test here, not at the run's end.
    actionTimeout: 30_000,
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  webServer: running
    ? undefined
    : {
        command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
        cwd: root,
        env: {
          ...process.env,
          BROWSER: 'none',
          VITE_CLERK_PUBLISHABLE_KEY: '',
          VITE_USE_MSW: 'true',
        },
        reuseExistingServer: false,
        timeout: 180_000,
        url: baseURL,
      },
  workers: 1,
});
