import { expect, it } from 'vitest';
import { type Download, downloadKind, downloadsBetween } from './downloads';

const app = 'http://localhost:4518';
const runtime = 'http://localhost:4519';
const kind = (path: string, initiator = 'fetch', origin = runtime) =>
  downloadKind(initiator, new URL(path, origin), runtime);

it('counts a CJK face by its slice index, skeleton and chunks', () => {
  for (const path of [
    '/assets/slices-B-Ut2Cmu.json',
    '/assets/skeleton-CzA81bQ2.zst',
    '/assets/c093-BrrOHgFT.zst',
    '/assets/Carlito-Regular.ttf-D2kq9fWx.zst',
  ])
    expect(kind(path)).toEqual({ kind: 'fonts' });
  // Any other JSON is no font.
  expect(kind('/assets/manifest-Bx9aT2kL.json')).toEqual({ kind: 'other' });
});

it('names an engine by its module, and the font decoder apart', () => {
  expect(kind('/assets/docx_view_wasm_bg-Df3kQp9a.wasm')).toEqual({
    kind: 'engineWasm',
    module: 'docx_view_wasm_bg',
  });
  expect(kind('/assets/fontpack-BocYgisa.wasm')).toEqual({
    kind: 'fontDecoder',
  });
});

it("tells the runtime's scripts from the app's, and the source file", () => {
  expect(kind('/assets/DocxViewer-Ab12Cd34.js')).toEqual({
    kind: 'officeRuntimeJs',
  });
  expect(kind('/assets/main-D4Kpb2pf.js', 'script', app)).toEqual({
    kind: 'appJsCss',
  });
  expect(kind('/files/exchange-plan.docx', 'fetch', app)).toEqual({
    kind: 'sourceFile',
  });
});

it("sums each fetch as it crossed the wire, decoded beside, with production's stored brotli", () => {
  const fetch = (path: string, sizes: Partial<Download>): Download => ({
    decoded: 0,
    encoded: 0,
    initiator: 'fetch',
    name: new URL(path, runtime).href,
    start: 10,
    transfer: 0,
    ...sizes,
  });
  const entries = [
    // A script gzipped to a third, with half a KiB of headers.
    fetch('/assets/DocxViewer-Ab12Cd34.js', {
      decoded: 9216,
      encoded: 3072,
      transfer: 3584,
    }),
    // An engine the Office Worker stores at 2 KiB of brotli.
    fetch('/assets/docx_view_wasm_bg-Df3kQp9a.wasm', {
      decoded: 10_240,
      encoded: 10_240,
      transfer: 10_752,
    }),
    // A slice the HTTP cache answered: no body crossed the wire.
    fetch('/assets/c093-BrrOHgFT.zst', { decoded: 4096, encoded: 4096 }),
    // Outside the window, and the host's entry for the runtime frame.
    fetch('/assets/late-Ab12Cd34.js', { encoded: 1024, start: 20 }),
    fetch('/office-runtime.html', { encoded: 1024, initiator: 'iframe' }),
  ];
  const stored = (url: URL) => (url.pathname.endsWith('.wasm') ? 2048 : null);
  const { engineWasmModules, kinds, total } = downloadsBetween(
    entries,
    0,
    20,
    runtime,
    stored
  );
  expect(total).toEqual({
    bodiesSent: 2,
    decodedKiB: 23,
    encodedKiB: 17,
    requests: 3,
    transferredKiB: 14,
    withStoredBrotliKiB: 6,
  });
  expect(kinds.officeRuntimeJs).toMatchObject({
    decodedKiB: 9,
    encodedKiB: 3,
    transferredKiB: 3.5,
  });
  expect(engineWasmModules.docx_view_wasm_bg?.withStoredBrotliKiB).toBe(2.5);
  expect(kinds.fonts).toMatchObject({ bodiesSent: 0, transferredKiB: 0 });
});
