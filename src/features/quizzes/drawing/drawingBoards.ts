import { api, isApiError } from '@/api/client';
import { toBase64 } from '@/features/blocksuite/base64';

/** A stored drawing that is gone: its payer deleted it from Files › Canvas,
 * or it went with its quiz. The marks stay. */
export const DRAWING_DELETED = 'deleted';

/** Stored boards fetched in this page, by drawing id: base64, or deleted. */
const fetched = new Map<string, Promise<string>>();

/** A stored drawing's board through its hour-long link. A failure is fetched
 * again on the next view, not retried here. */
export function fetchDrawingBoard(id: string) {
  let board = fetched.get(id);
  if (!board) {
    board = api
      .get<{ boardUrl: string }>(`/drawings/${id}`)
      .then((drawing) => fetch(drawing.boardUrl))
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`board fetch failed: ${response.status}`);
        // Stored gzipped (drawings.go); inflated here, not by a header.
        const inflated = response.body?.pipeThrough(
          new DecompressionStream('gzip')
        );
        return toBase64(
          new Uint8Array(await new Response(inflated).arrayBuffer())
        );
      })
      .catch((error: unknown) => {
        if (isApiError(error) && error.status === 404) return DRAWING_DELETED;
        fetched.delete(id);
        throw error;
      });
    fetched.set(id, board);
  }
  return board;
}

/** Forget fetched boards after a delete: the ids given, or all. */
export function forgetDrawingBoards(ids: string[] | null) {
  if (ids) for (const id of ids) fetched.delete(id);
  else fetched.clear();
}
