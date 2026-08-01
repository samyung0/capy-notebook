import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = path.dirname(fileURLToPath(import.meta.url));

// TODO: use existing packages for loading env?
function loadLocalEnv() {
  const envFile = path.join(root, 'e2e', '.env');
  if (!existsSync(envFile)) return;
  for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    process.env[key] ??= value;
  }
}

loadLocalEnv();

const randomPort = () => randomInt(20_000, 45_000);
const apiPort = Number(process.env.E2E_API_PORT ?? randomPort());
const collaborationPort = Number(
  process.env.E2E_COLLABORATION_PORT ?? randomPort()
);
const dbPort = Number(process.env.E2E_DB_PORT ?? randomPort());
const vitePort = Number(process.env.E2E_VITE_PORT ?? randomPort());
const apiUrl = process.env.E2E_API_URL ?? `http://127.0.0.1:${apiPort}`;
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${vitePort}`;
const composeProject =
  process.env.E2E_COMPOSE_PROJECT ??
  `evo-notes-e2e-${process.pid}-${randomBytes(3).toString('hex')}`;
const e2eSecret =
  process.env.E2E_AUTH_SECRET ?? randomBytes(32).toString('hex');
const urlPort = (value: string) => {
  const url = new URL(value);
  return url.port || (url.protocol === 'https:' ? '443' : '80');
};

process.env.E2E_API_PORT = urlPort(apiUrl);
process.env.E2E_COLLABORATION_PORT = String(collaborationPort);
process.env.E2E_DB_PORT = String(dbPort);
process.env.E2E_VITE_PORT = urlPort(baseURL);
process.env.E2E_API_URL = apiUrl;
process.env.E2E_BASE_URL = baseURL;
process.env.E2E_COMPOSE_PROJECT = composeProject;
process.env.E2E_AUTH_SECRET = e2eSecret;

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  globalSetup: path.join(root, 'e2e', 'global-setup.ts'),
  globalTeardown: path.join(root, 'e2e', 'global-teardown.ts'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
  retries: process.env.CI ? 1 : 0,
  testDir: path.join(root, 'e2e'),
  // The editor feature matrix runs against MSW (no Docker) with its own
  // config: e2e/editor/playwright.editor.config.ts (pnpm e2e:editor).
  testIgnore: ['**/editor/**'],
  timeout: 60_000,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${process.env.E2E_VITE_PORT} --strictPort`,
    env: {
      ...process.env,
      VITE_API_URL: apiUrl,
      // No Clerk key → AuthGate passthrough; identity comes from E2E headers.
      VITE_CLERK_PUBLISHABLE_KEY: '',
      VITE_FEATURE_EXPLORE: 'true',
      VITE_PORT: process.env.E2E_VITE_PORT!,
      VITE_USE_MSW: 'false',
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
  workers: process.env.CI ? 2 : undefined,
});
