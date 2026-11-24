import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../../e2e/i18n/compile';

/**
 * Office runtime harness. Run with: pnpm bench:office
 *
 * Like the Plate harness this measures a production build (minified, React
 * production mode) with MSW mocks: the Office runtime's costs are engine and
 * paint work that a dev build distorts. It builds in Vite's production mode
 * with the benches' switch (VITE_BENCH_MSW) and an empty env directory, as
 * that harness does, but with the app's own config (the engines built, `pnpm
 * office:prepare`), since it opens Office files, and MSW's own worker; it
 * stages that build as the Office Worker does. The runtime is served
 * from a second port of localhost: another origin on the same site, as
 * office.capynotebook.com is to the app, so view and edit run in the real
 * cross-origin iframe and share the app's renderer process as in production.
 * The build takes a few minutes.
 *
 * Environment knobs:
 * - PERF_OFFICE_PORT  app port (default 4518); the runtime is on the next one.
 * - PERF_OFFICE_TLS_KEY, PERF_OFFICE_TLS_CERT  a key and a self-signed
 *   certificate for localhost (PEM): both origins answer over HTTPS, as in
 *   production, for local runs on a PC whose antivirus holds plain-HTTP
 *   answers (Q788 A: Epo's ESET holds the packed fonts 0.15-0.5 s). CI runs
 *   plain HTTP. Make the pair with
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=localhost
 *   -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout key.pem
 *   -out cert.pem
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, '..', '..', '..');
const port = Number(process.env.PERF_OFFICE_PORT ?? 4518);
const runtimePort = port + 1;
const { PERF_OFFICE_TLS_CERT, PERF_OFFICE_TLS_KEY } = process.env;
if (Boolean(PERF_OFFICE_TLS_CERT) !== Boolean(PERF_OFFICE_TLS_KEY))
  throw new Error('Set PERF_OFFICE_TLS_KEY and PERF_OFFICE_TLS_CERT together');
const tls = Boolean(PERF_OFFICE_TLS_CERT);
const scheme = tls ? 'https' : 'http';
const outDir = path.join(perfDir, '..', '.results', 'office-dist');
// The Office Worker's copy, for the stored `.br` sizes (runtime.office.ts).
const stageDir = path.join(perfDir, '..', '.results', 'office-stage');
// The build's env directory (CAPY_ENV_DIR in vite.config.ts): none of deploy/.env.
const envDir = path.join(perfDir, '..', '.results', 'empty-env');
mkdirSync(envDir, { recursive: true });

export default defineConfig({
  fullyParallel: false,
  projects: [{ name: 'chromium-office', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: perfDir,
  testMatch: '**/*.office.ts',
  timeout: 600_000,
  use: {
    baseURL: `${scheme}://localhost:${port}`,
    // MSW's service worker registers on a self-signed origin only with the
    // browser-wide switch (the context's ignoreHTTPSErrors is not enough).
    launchOptions: { args: tls ? ['--ignore-certificate-errors'] : [] },
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
      CAPY_ENV_DIR: envDir,
      NODE_ENV: 'production',
      VITE_BENCH_MSW: 'true',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      // Seeds the 62-page document next to the rich-content fixtures.
      VITE_LOAD_TEST_SEED: 'true',
      VITE_OFFICE_RUNTIME_ORIGIN: `${scheme}://localhost:${runtimePort}`,
    },
    ignoreHTTPSErrors: tls,
    reuseExistingServer: false,
    timeout: 1_200_000,
    url: `${scheme}://127.0.0.1:${port}`,
  },
  workers: 1,
});
