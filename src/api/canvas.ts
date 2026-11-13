import { infiniteQueryOptions } from '@tanstack/react-query';
import { api, isApiError, qk } from '@/api/client';
import type {
  CanvasBody,
  CanvasListItem as GenCanvasListItem,
  CanvasPage as GenCanvasPage,
  SaveOwnCanvasInputBody,
} from '@/api/gen/model';

/** A person's canvases (Epo 2026-11-09): their own, and any number in each
 * workspace (Epo 2026-11-12). A save records the board asset it uploaded, at the
 * revision it read. */

export type WorkspaceCanvas = CanvasBody;
export type SaveCanvasBody = SaveOwnCanvasInputBody;
/** One of a person's canvases: their own, or a workspace's (`workspaceId`). */
export type CanvasListItem = GenCanvasListItem;

/** The save lost to another tab's: the canvas stops saving until a reload. */
export const isCanvasConflict = (error: unknown) =>
  isApiError(error) && error.status === 409;

export type CanvasPage = GenCanvasPage;

/** The caller's canvases a page at a time: on the account's Canvas page (Epo
 * 2026-11-10) their own, latest saved first, then their workspaces'; in a
 * workspace's Canvas tab the ones drawn there (Epo 2026-11-12). */
export const listCanvases = (
  cursor: string,
  workspaceId: string | undefined,
  signal?: AbortSignal
) => {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (workspaceId) query.set('workspaceId', workspaceId);
  const qs = query.toString();
  return api.get<CanvasPage>(`/canvases${qs ? `?${qs}` : ''}`, { signal });
};

/** A new canvas of the caller's, in the workspace or in none. */
export const createCanvas = (title: string, workspaceId?: string) =>
  api.post<WorkspaceCanvas>('/canvases', { title, workspaceId });

export const canvasById = (id: string, signal?: AbortSignal) =>
  api.get<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, { signal });

export const saveCanvas = (id: string, body: SaveCanvasBody) =>
  api.put<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, body);

export const canvasesQuery = (workspaceId?: string) =>
  infiniteQueryOptions({
    getNextPageParam: (last: CanvasPage) => last.nextCursor || undefined,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      listCanvases(pageParam, workspaceId, signal),
    queryKey: [...qk.canvases, workspaceId ?? ''],
  });
