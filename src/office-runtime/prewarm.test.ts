import { afterEach, expect, test, vi } from 'vitest';

vi.mock('./docxViewerWorker', () => ({ prewarmDocxViewerWorker: vi.fn() }));

import { runtimeEngines } from './prewarm';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the XLSX edit warm-up reads the engine into the HTTP cache and keeps none of it', async () => {
  const body = vi.fn(async () => new ArrayBuffer(8));
  const fetch = vi.fn(async () => ({ arrayBuffer: body }));
  vi.stubGlobal('fetch', fetch);
  // The resolved value stays referenced for the frame's life.
  await expect(runtimeEngines['xlsx:edit']()).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledOnce();
  expect(body).toHaveBeenCalledOnce();
});
