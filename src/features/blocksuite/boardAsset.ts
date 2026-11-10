import { isApiError } from '@/api/client';
import { assetLink } from '@/features/materials/resolvedAssetLinks';
import { fromBase64, toBase64 } from './base64';
import type { BoardImages } from './boardImages';

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

/** A board whose images are its material's `image` editor assets, uploaded at
 * once as a note's are (the workspace canvas, Epo 2026-11-09): the uploader pays,
 * the plan's image cap and a full storage refuse, and the Files page lists them.
 * `own` are the material's image assets as the server lists them, a trashed one
 * included: only those are named in a save. An image of another material
 * (pasted from another canvas) is stored again as this one's. */
export function assetImages(
  materialId: string,
  listed: readonly string[],
  onRefused: (error: unknown) => void
) {
  const own = new Set(listed);
  /** Own images the server gave no file for: trashed until a save names them. */
  const missing = new Set<string>();
  const signal = () => new AbortController().signal;
  const images: BoardImages = {
    load: async (id) => {
      let link: Awaited<ReturnType<typeof assetLink>>;
      try {
        link = await assetLink(id, signal(), false);
      } catch (error) {
        // No such asset for this reader: a hash never uploaded, a deleted
        // image, or one of this canvas's the pruner trashed.
        if (!(isApiError(error) && error.status === 404)) throw error;
        if (own.has(id)) missing.add(id);
        return null;
      }
      if (link.purpose !== 'image') return null;
      let response = await fetch(link.url);
      // The link in hand may have lapsed: one more, asked afresh.
      if (!response.ok)
        response = await fetch((await assetLink(id, signal(), true)).url);
      if (!response.ok)
        throw new Error(`image asset fetch failed: ${response.status}`);
      return {
        file: await response.blob(),
        foreign: link.materialId !== materialId,
      };
    },
    onRefused,
    store: async (file) => {
      const { uploadEditorAsset } = await import('@/api/editorAssets');
      const asset = await uploadEditorAsset(materialId, file, 'image');
      own.add(asset.assetId);
      return { bytes: asset.sizeBytes, id: asset.assetId };
    },
    stored: (id) => own.has(id),
  };
  return {
    images,
    /** Of the ids on the board, this material's image assets: what its save
     * names, so the pruner keeps them. One still a hash (its upload didn't
     * finish) or another material's is left out. */
    named: (ids: readonly string[]) => ids.filter((id) => own.has(id)),
    /** The server's list again, after it refused a save's images (one was
     * deleted for good elsewhere). */
    relist: (ids: readonly string[]) => {
      own.clear();
      for (const id of ids) own.add(id);
    },
    /** After a save landed: whether it named an image that had shown none, so
     * the board asks for it again. */
    restored: () => {
      const any = missing.size > 0;
      missing.clear();
      return any;
    },
  };
}
