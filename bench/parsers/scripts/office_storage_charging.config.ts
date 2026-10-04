// Storage charges of store-only Office and text sources through edit, publish,
// rebuild and the blob reaper, on the disposable local e2e stack with the
// collaboration stress test's fake S3 (nothing reaches the ingest host, UAT or
// production). Prebuilt images, so a before/after pair differs only in the
// server image:
//   OFFICE_CHARGING_SERVER_IMAGE=capy-storage-charging-server:before \
//   OFFICE_CHARGING_COLLABORATION_IMAGE=capy-storage-charging-collab:local \
//   OFFICE_CHARGING_OUT=/tmp/office-charging-before.json \
//   node_modules/.bin/playwright test --config=bench/parsers/scripts/office_storage_charging.config.ts
// Run after pnpm office:prepare (the browser loads the BetterOffice runtime).
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const name of ['OFFICE_CHARGING_SERVER_IMAGE', 'OFFICE_CHARGING_COLLABORATION_IMAGE', 'OFFICE_CHARGING_OUT'])
  if (!process.env[name]) throw new Error(`${name} is required`);
const port = () => String(randomInt(20_000, 45_000));
process.env.E2E_API_PORT ??= port();
process.env.E2E_COLLABORATION_PORT ??= port();
process.env.E2E_DB_PORT ??= port();
process.env.E2E_VITE_PORT ??= port();
process.env.OFFICE_CHARGING_S3_PORT ??= port();
process.env.E2E_API_URL ??= `http://127.0.0.1:${process.env.E2E_API_PORT}`;
process.env.E2E_BASE_URL ??= `http://127.0.0.1:${process.env.E2E_VITE_PORT}`;
process.env.E2E_COMPOSE_PROJECT ??= `capy-office-charging-${randomBytes(3).toString('hex')}`;
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString('hex');
process.env.OFFICE_CHARGING_PIPELINE_SECRET ??= randomBytes(32).toString('hex');
process.env.SHARE_LINK_SECRET ||= randomBytes(32).toString('hex');
process.env.E2E_PREBUILT_IMAGES = 'true';
process.env.STRESS_FAKE_S3 = path.join(root, 'bench/collaboration/scripts/fake-s3.mjs');
process.env.E2E_COMPOSE_OVERRIDES = [
  'bench/collaboration/scripts/docker-compose.stress.yml',
  'bench/parsers/scripts/docker-compose.office-charging.yml',
]
  .map((file) => path.join(root, file))
  .join(',');
// The fake S3's certificate for the name docker-compose.stress.yml gives it,
// made once (workers load this config again).
if (!process.env.STRESS_TLS_DIR) {
  const dir = mkdtempSync(path.join(tmpdir(), 'capy-office-charging-tls-'));
  const openssl = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=s3.stress.backblazeb2.com',
      '-addext', 'subjectAltName=DNS:s3.stress.backblazeb2.com',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ],
    { encoding: 'utf8' }
  );
  if (openssl.status !== 0) throw new Error(`openssl failed: ${openssl.stderr}`);
  for (const file of ['key.pem', 'cert.pem']) chmodSync(path.join(dir, file), 0o644);
  chmodSync(dir, 0o755);
  process.env.STRESS_TLS_DIR = dir;
}

export default defineConfig({
  globalSetup: path.join(root, 'e2e', 'global-setup.ts'),
  globalTeardown: path.join(root, 'e2e', 'global-teardown.ts'),
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: path.dirname(fileURLToPath(import.meta.url)),
  testMatch: 'office_storage_charging.spec.ts',
  timeout: 90 * 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // vite itself: pnpm exec may reinstall a worktree's linked node_modules.
    command: `${path.join(root, 'node_modules/.bin/vite')} --host 127.0.0.1 --port ${process.env.E2E_VITE_PORT} --strictPort`,
    cwd: root,
    env: {
      ...process.env,
      VITE_API_URL: process.env.E2E_API_URL!,
      VITE_APP_ENV: 'e2e',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      VITE_PORT: process.env.E2E_VITE_PORT!,
      VITE_POSTHOG_KEY: '',
      VITE_RELEASE_SHA: 'e2e',
      VITE_SENTRY_DSN: '',
      VITE_USE_MSW: 'false',
    },
    reuseExistingServer: false,
    timeout: 180_000,
    url: process.env.E2E_BASE_URL!,
  },
  workers: 1,
});
