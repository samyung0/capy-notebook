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

/** An answer about the asset (gone, not the reader's), not a failure to ask. */
const refused = (error: unknown) => {
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  );
};

/** A board whose images are its material's `image` editor assets, uploaded at
 * once as a note's are (the workspace canvas, Epo 2026-11-09): the uploader pays,
 * the plan's image cap and a full storage refuse, and Files › Embeds lists them.
 * `stored` are the ones the material's last save named. An image of another
 * material (pasted from another canvas) is stored again as this one's. */
export function assetImages(
  materialId: string,
  stored: readonly string[],
  onRefused: (error: unknown) => void
) {
  const own = new Set(stored);
  const gone = new Set<string>();
  /** The asset's link, noting one that is this material's; null once the
   * server said there is none (a hash never uploaded, a deleted asset). */
  const linked = async (id: string) => {
    if (gone.has(id)) return null;
    try {
      const link = await assetLink(id, new AbortController().signal, false);
      if (link.materialId === materialId && link.purpose === 'image')
        own.add(id);
      return link;
    } catch (error) {
      if (!refused(error)) throw error;
      gone.add(id);
      return null;
    }
  };
  const images: BoardImages = {
    load: async (id) => {
      const link = await linked(id);
      if (link?.purpose !== 'image') return null;
      const response = await fetch(link.url);
      if (!response.ok)
        throw new Error(`image asset fetch failed: ${response.status}`);
      return { file: await response.blob(), foreign: !own.has(id) };
    },
    onRefused,
    store: async (file) => {
      const { uploadEditorAsset } = await import('@/api/editorAssets');
      const asset = await uploadEditorAsset(materialId, file, 'image');
      own.add(asset.assetId);
      return { bytes: asset.sizeBytes, id: asset.assetId };
    },
  };
  return {
    images,
    /** Of the ids on the board, this material's image assets: what its save
     * names, so the pruner keeps them. One still a hash (its upload didn't
     * finish) or another material's is left out. */
    named: async (ids: readonly string[]) => {
      const mine: string[] = [];
      for (const id of ids) {
        if (!own.has(id)) await linked(id);
        if (own.has(id)) mine.push(id);
      }
      return mine;
    },
  };
}
