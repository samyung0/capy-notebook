import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const directory = path.dirname(fileURLToPath(import.meta.url));
// Set once before workers start; manifests stay outside Playwright's cleared output.
process.env.UAT_RUN_ID ??=
  process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : randomUUID();

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: path.join(directory, 'preflight.ts'),
  globalTeardown: path.join(directory, 'cleanup.ts'),
  globalTimeout: 90 * 60_000,
  maxFailures: 1,
  outputDir: path.join(directory, 'test-results'),
  projects: [{ name: 'uat-journeys-chromium', use: devices['Desktop Chrome'] }],
  reporter: 'list',
  retries: 0,
  testDir: directory,
  testMatch: '**/*.spec.ts',
  timeout: 15 * 60_000,
  use: {
    actionTimeout: 30_000,
    baseURL: process.env.UAT_APP_URL,
    navigationTimeout: 60_000,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  workers: 1,
});
