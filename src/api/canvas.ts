import { infiniteQueryOptions } from '@tanstack/react-query';
import { api, qk } from '@/api/client';
import type {
  CanvasBoardBody,
  CanvasBody,
  CanvasListItem as GenCanvasListItem,
  CanvasPage as GenCanvasPage,
} from '@/api/gen/model';

/** A person's canvases (Epo 2026-11-09): their own, and any number in each
 * workspace (Epo 2026-11-12). A canvas's drawing lives in its collaboration
 * room (Epo 2026-11-18); these routes list, make, read and share it. */

export type WorkspaceCanvas = CanvasBody;
/** One of a person's canvases: their own, or a workspace's (`workspaceId`);
 * in a workspace's list, another member's shared one too (`own` false). */
export type CanvasListItem = GenCanvasListItem;

export type CanvasPage = GenCanvasPage;

/** The caller's canvases a page at a time: on the account's Canvas page (Epo
 * 2026-11-10) their own, latest saved first, then their workspaces'; in a
 * workspace's Canvas tab the ones they drew there and the other members'
 * shared ones (Epo 2026-11-18). */
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

/** A new canvas of the caller's, in the workspace or in none: private. */
export const createCanvas = (title: string, workspaceId?: string) =>
  api.post<WorkspaceCanvas>('/canvases', { title, workspaceId });

export const canvasById = (id: string, signal?: AbortSignal) =>
  api.get<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, { signal });

/** A canvas in the caller's Trash, its stored board as Yjs updates: shown
 * read-only, with no room (a live canvas's board is its room's). */
export const trashedCanvasBoard = (id: string, signal?: AbortSignal) =>
  api.get<CanvasBoardBody>(`/canvases/${encodeURIComponent(id)}/board`, {
    signal,
  });

/** Shares a workspace canvas with the workspace's members, who then hold it
 * by their workspace role, or takes it back. */
export const shareCanvas = (id: string, shared: boolean) =>
  api.patch<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, {
    shared,
  });

export const canvasesQuery = (workspaceId?: string) =>
  infiniteQueryOptions({
    getNextPageParam: (last: CanvasPage) => last.nextCursor || undefined,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      listCanvases(pageParam, workspaceId, signal),
    queryKey: [...qk.canvases, workspaceId ?? ''],
  });
