import { defineConfig, devices } from '@playwright/test';
import editor from './playwright.editor.config';

/**
 * The Mermaid geometry spec in Firefox and WebKit (Epo 2026-10-23), where it
 * checks that labels fit their boxes and overlap no more than on that
 * engine's own page; Chromium keeps the exact check in the editor config.
 * Run with: pnpm e2e:msw:mermaid-engines (CI job e2e_mermaid_engines, which
 * installs only these two browsers).
 */
export default defineConfig({
  ...editor,
  projects: [
    { name: 'firefox-mermaid', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-mermaid', use: { ...devices['Desktop Safari'] } },
  ],
  testMatch: 'mermaid-geometry.spec.ts',
});
