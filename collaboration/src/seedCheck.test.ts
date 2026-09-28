import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, test, vi } from 'vitest';
import { closeOfficeRuntime, runOffice } from './officeRuntime.js';
import { checkSeeds } from './seedCheck.js';

afterAll(closeOfficeRuntime);

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

test('the seed check seeds each base once and reports every changed seed', async () => {
  const bytes = await readFile(
    new URL(
      '../../vendor/betteroffice/apps/demo/public/betteroffice-demo.docx',
      import.meta.url
    )
  );
  const seed = sha256((await runOffice('seedOffice', 'docx', bytes)).state);
  const base = sha256(bytes);
  const read = vi.fn(async () => bytes);
  const line = {
    baseSourceSHA256: base,
    files: 2,
    format: 'docx' as const,
    sourceURL: 'u',
  };
  const checks = await checkSeeds(
    [
      { ...line, stateSeedSHA256: seed },
      { ...line, files: 1, stateSeedSHA256: '0'.repeat(64) },
    ],
    read
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    checks.map((c) => [c.files, c.seedSHA256 === c.stateSeedSHA256])
  ).toEqual([
    [2, true],
    [1, false],
  ]);
  await expect(
    checkSeeds(
      [{ ...line, baseSourceSHA256: '1'.repeat(64), stateSeedSHA256: seed }],
      read
    )
  ).rejects.toThrow('downloaded other bytes');
}, 60_000);
