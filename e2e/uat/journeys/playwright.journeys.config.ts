import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import '../../i18n/compile';

const directory = path.dirname(fileURLToPath(import.meta.url));
// Set once before workers start; manifests stay outside Playwright's cleared output.
process.env.UAT_RUN_ID ??=
  process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : randomUUID();

// Lanes: uat-quality runs each project as its own job with its own run id.
// A new spec lands in `app`; `refresh` waits for its specs (an empty project
// fails with "No tests found"). Without --project every lane runs serially.
const office = [
  'files.spec.ts',
  'chat.spec.ts',
  'officeRefusal.spec.ts',
  'scannedPdf.spec.ts',
  'partialIngest.spec.ts',
];
// Stripe-heavy journeys: the credits ones alone take 35–40 min.
const billing = ['billing.spec.ts', 'credits.spec.ts'];
const refresh = [
  'officeLifecycle.spec.ts',
  'noteIndex.spec.ts',
  'textLifecycle.spec.ts',
];
const chromium = devices['Desktop Chrome'];

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: path.join(directory, 'preflight.ts'),
  globalTeardown: path.join(directory, 'cleanup.ts'),
  globalTimeout: 90 * 60_000,
  outputDir: path.join(directory, 'test-results'),
  projects: [
    { name: 'office', testMatch: office, use: chromium },
    { name: 'refresh', testMatch: refresh, use: chromium },
    { name: 'billing', testMatch: billing, use: chromium },
    {
      name: 'app',
      testIgnore: [...office, ...refresh, ...billing],
      use: chromium,
    },
  ],
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
