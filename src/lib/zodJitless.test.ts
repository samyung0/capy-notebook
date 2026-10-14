import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const JITLESS_IMPORT = /^import '(\.\/lib|@\/lib)\/zodJitless';$/;

// Zod reads `jitless` as it builds each object schema, so the setting holds
// only when it runs before any module that builds one: first in each page
// script whose pages carry a script policy (human deployment-runbook
// 2026-10-15 Zod jitless).
describe('Zod jitless', () => {
  it('is the first import of the SPA and share page scripts', () => {
    for (const entry of ['../main.tsx', '../share/main.tsx'])
      expect(
        readFileSync(new URL(entry, import.meta.url), 'utf8').split('\n')[0]
      ).toMatch(JITLESS_IMPORT);
  });
});
