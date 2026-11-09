import { assetLink } from '@/features/materials/resolvedAssetLinks';
import { fromBase64, toBase64 } from './base64';

/** A board kept as a material's `board` editor asset: its saved document gzipped
 * (a drawn sample answer, Q3; the workspace canvas, Epo 2026-11-09). Fetched and
 * inflated in the browser. */

export const gzipBoard = (doc: string) =>
  new Response(
    new Blob([fromBase64(doc) as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();

export const boardFile = (packed: ArrayBuffer, name: string) =>
  new File([packed], name, { type: 'application/gzip' });

/** Boards fetched in this page, by asset id, base64. */
const fetched = new Map<string, Promise<string>>();

/** A board just uploaded as `assetId`: shown from the document in hand. */
export const rememberBoardAsset = (assetId: string, doc: string) =>
  fetched.set(assetId, Promise.resolve(doc));

/** A board asset's document, base64, as `mountDrawingBoard` takes it. A failure is
 * fetched again on the next ask, not retried here. */
export function boardFromAsset(assetId: string): Promise<string> {
  let board = fetched.get(assetId);
  if (!board) {
    board = assetLink(assetId, new AbortController().signal, false)
      .then((link) => fetch(link.url))
      .then(async (response) => {
        if (!response.ok || !response.body)
          throw new Error(`board asset fetch failed: ${response.status}`);
        const inflated = response.body.pipeThrough(
          new DecompressionStream('gzip')
        );
        return toBase64(
          new Uint8Array(await new Response(inflated).arrayBuffer())
        );
      });
    board.catch(() => fetched.delete(assetId));
    fetched.set(assetId, board);
  }
  return board;
}
