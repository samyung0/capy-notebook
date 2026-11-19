import { expect, it } from 'vitest';
import { downloadKind } from './downloads';

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
