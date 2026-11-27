import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './zodJitless';

const JITLESS_IMPORT =
  /^import (?:\{ zodConfig \} from )?'(\.\/lib|@\/lib)\/zodJitless';$/;

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

  // Q908: the entry sets zod's settings without importing zod; a zod upgrade
  // that stops reading `globalThis.__zod_globalConfig` fails here.
  it('configures zod through its global before zod loads', async () => {
    const { z } = await import('zod');
    expect(z.config().jitless).toBe(true);
  });
});
