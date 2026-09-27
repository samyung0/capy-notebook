import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import journeys from '../../../e2e/uat/journeys/playwright.journeys.config';

export default defineConfig({
  ...journeys,
  testDir: path.dirname(fileURLToPath(import.meta.url)),
  testMatch: 'office_storage_ingest.spec.ts',
});
