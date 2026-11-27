import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const prefetchOfficeFile = vi.fn();

/** prefetchOffice, with the open's chunk loading or failing to. */
async function withOfficeChunk(loads: boolean) {
  vi.resetModules();
  vi.doMock('./prefetchOfficeFile', () => {
    if (!loads) throw new Error('chunk failed to load');
    return { prefetchOfficeFile };
  });
  return (await import('./prefetchOffice')).prefetchOffice;
}

afterEach(() => {
  vi.doUnmock('./prefetchOfficeFile');
  prefetchOfficeFile.mockClear();
});

const load = (preload: boolean) => ({
  abortController: new AbortController(),
  preload,
});

// The Office team's conditions for loading the open's code with the first
// route that opens a file (Q908).
it("loads the open's code on a hover's preload and hands the preload on", async () => {
  const prefetchOffice = await withOfficeChunk(true);
  const qc = new QueryClient();
  const hover = load(true);
  expect(prefetchOffice(qc, 'file_1', hover)).toBeUndefined();
  await vi.waitFor(() =>
    expect(prefetchOfficeFile).toHaveBeenCalledWith(qc, 'file_1', hover)
  );
});

it('swallows a failed chunk load', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const prefetchOffice = await withOfficeChunk(false);
  prefetchOffice(new QueryClient(), 'file_1', load(false));
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off('unhandledRejection', onRejection);
  expect(rejections).toEqual([]);
});

it('starts first in every route loader that opens a file', () => {
  const lines = readFileSync(
    new URL('../../router.ts', import.meta.url),
    'utf8'
  ).split('\n');
  const calls = lines.flatMap((line, i) =>
    line.includes('prefetchOffice(qc') ? [i] : []
  );
  expect(calls.length).toBe(2);
  for (const i of calls) expect(lines[i - 1].trim()).toBe('}) => {');
});
