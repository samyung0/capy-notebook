import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const required = [
  'UAT_TARGET_AUTHORIZED',
  'UAT_ALLOWED_HOSTS',
  'UAT_APP_URL',
  'UAT_API_URL',
  'UAT_COLLAB_URL',
  'CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'UAT_OWNER_EMAIL',
  'UAT_EDITOR_EMAIL',
  'UAT_COMMENTER_EMAIL',
  'UAT_VIEWER_EMAIL',
  'UAT_OTHER_EMAIL',
  'UAT_FIXTURE_WORKSPACE_ID',
  'UAT_FIXTURE_MATERIAL_ID',
] as const;

const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing UAT Playwright values: ${missing.join(', ')}`);
}

if (process.env.UAT_TARGET_AUTHORIZED !== 'true') {
  throw new Error('UAT_TARGET_AUTHORIZED must be exactly true');
}

const allowedHosts = new Set(
  process.env
    .UAT_ALLOWED_HOSTS!.split(',')
    .map((host) => host.trim())
    .filter(Boolean)
);
for (const [name, expectedProtocol] of [
  ['UAT_APP_URL', 'https:'],
  ['UAT_API_URL', 'https:'],
  ['UAT_COLLAB_URL', 'wss:'],
] as const) {
  const url = new URL(process.env[name]!);
  if (url.protocol !== expectedProtocol) {
    throw new Error(`${name} must use ${expectedProtocol}//`);
  }
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`${name} host is not present in UAT_ALLOWED_HOSTS`);
  }
}
if (
  process.env.PRODUCTION_APP_URL &&
  process.env.PRODUCTION_APP_URL === process.env.UAT_APP_URL
) {
  throw new Error('UAT_APP_URL must not equal PRODUCTION_APP_URL');
}

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: path.join(directory, 'test-results'),
  projects: [
    {
      name: 'uat-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(directory, 'report') }],
  ],
  retries: process.env.CI ? 1 : 0,
  testDir: directory,
  testIgnore: '**/*.config.ts',
  timeout: 60_000,
  use: {
    baseURL: process.env.UAT_APP_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  workers: 1,
});
