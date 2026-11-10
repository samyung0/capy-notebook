import { expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';
import { boardFile, gzipBoard } from './boardAsset';

// A board goes up as its gzipped document and comes back the same, the way the
// canvas and a drawn sample answer store it.
it('gzips a board document and inflates it back', async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 7);
  const doc = toBase64(bytes);
  const packed = await gzipBoard(doc);
  expect(packed.byteLength).toBeLessThan(bytes.byteLength);
  const file = boardFile(packed, 'canvas.ydoc.gz');
  expect(file.type).toBe('application/gzip');
  const inflated = new Uint8Array(
    await new Response(
      file.stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer()
  );
  expect(inflated).toEqual(fromBase64(doc));
});
