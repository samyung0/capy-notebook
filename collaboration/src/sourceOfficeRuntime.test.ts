import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, test } from 'vitest';
import {
  closeOfficeRuntime,
  type OfficeFormat,
  runOffice,
} from './officeRuntime.js';

const BASE_MISMATCH = /base/;

afterAll(closeOfficeRuntime);

test.each([
  ['docx', 'poc/fixtures/feature-rich.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  '%s loads the packaged Node runtime, exports deterministically and restores its new base',
  async (format: OfficeFormat, path: string) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const initial = await runOffice('seedOffice', format, bytes);
    expect(initial.baseSha256).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
    expect(await runOffice('compare', bytes, initial, initial)).toEqual([]);
    const determinism = {
      now: '2000-01-01T00:00:00.000Z',
      seed: createHash('sha256').update('integration-job').digest('hex'),
    };
    const first = await runOffice('exportOffice', bytes, initial, determinism);
    const second = await runOffice('exportOffice', bytes, initial, determinism);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const reopened = await runOffice('seedOffice', format, first);
    expect(reopened.state.length).toBeGreaterThan(0);
    expect(await runOffice('compare', first, reopened, reopened)).toEqual([]);
    await expect(
      runOffice(
        'compare',
        first,
        { ...reopened, baseSha256: '0'.repeat(64) },
        reopened
      )
    ).rejects.toThrow(BASE_MISMATCH);
  },
  60_000
);
