import { api, isApiError } from '@/api/client';
import { toBase64 } from '@/features/blocksuite/base64';

/** A stored drawing that is gone: its payer deleted it from Files › Canvas,
 * or it went with its quiz. The marks stay. */
export const DRAWING_DELETED = 'deleted';

type StoredDrawing = { board: string; pictures: Map<string, string> };

/** Stored drawings fetched in this page, by id: the board in base64 with its
 * pictures' links, or deleted. */
const fetched = new Map<
  string,
  Promise<StoredDrawing | typeof DRAWING_DELETED>
>();

/** A stored drawing through its hour-long links. A failure is fetched again on
 * the next view, not retried here. */
function fetchDrawing(id: string) {
  let drawing = fetched.get(id);
  if (!drawing) {
    drawing = api
      .get<{
        boardUrl: string;
        pictures: { sourceId: string; url: string }[];
      }>(`/drawings/${id}`)
      .then(async ({ boardUrl, pictures }) => {
        const response = await fetch(boardUrl);
        if (!response.ok)
          throw new Error(`board fetch failed: ${response.status}`);
        // Stored gzipped (drawings.go); inflated here, not by a header.
        const inflated = response.body?.pipeThrough(
          new DecompressionStream('gzip')
        );
        return {
          board: toBase64(
            new Uint8Array(await new Response(inflated).arrayBuffer())
          ),
          pictures: new Map(
            pictures.map(({ sourceId, url }) => [sourceId, url])
          ),
        };
      })
      .catch((error: unknown) => {
        if (isApiError(error) && error.status === 404) return DRAWING_DELETED;
        fetched.delete(id);
        throw error;
      });
    fetched.set(id, drawing);
  }
  return drawing;
}

/** A stored drawing's board, base64, or DRAWING_DELETED. */
export const fetchDrawingBoard = (id: string) =>
  fetchDrawing(id).then((drawing) =>
    drawing === DRAWING_DELETED ? drawing : drawing.board
  );

/** One of a stored drawing's pictures, by the id its image block names: none
 * when the drawing holds no such picture. */
export async function fetchDrawingPicture(id: string, sourceId: string) {
  const read = async () => {
    const drawing = await fetchDrawing(id);
    const url =
      drawing === DRAWING_DELETED ? null : drawing.pictures.get(sourceId);
    return url ? fetch(url) : null;
  };
  let response = await read();
  // The links last an hour or two and this page's copy of them longer: one
  // that no longer opens is asked for again, once.
  if (response && !response.ok) {
    fetched.delete(id);
    response = await read();
  }
  if (!response) return null;
  if (!response.ok) throw new Error(`picture fetch failed: ${response.status}`);
  return response.blob();
}

/** Forget fetched boards after a delete: the ids given, or all. */
export function forgetDrawingBoards(ids: string[] | null) {
  if (ids) for (const id of ids) fetched.delete(id);
  else fetched.clear();
}
