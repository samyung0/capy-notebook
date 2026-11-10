import { infiniteQueryOptions } from '@tanstack/react-query';
import { api, isApiError, qk } from '@/api/client';
import type {
  CanvasBody,
  CanvasListItem as GenCanvasListItem,
  CanvasPage as GenCanvasPage,
  SaveCanvasInputBody,
} from '@/api/gen/model';

/** A member's personal workspace canvas (Epo 2026-11-09): found or made on open;
 * a save records the board asset it uploaded, at the revision it read. */

export type WorkspaceCanvas = CanvasBody;
export type SaveCanvasBody = SaveCanvasInputBody;
/** One of a person's canvases: their own, or a workspace's (`workspaceId`). */
export type CanvasListItem = GenCanvasListItem;

export const workspaceCanvas = (workspaceId: string, signal?: AbortSignal) =>
  api.get<WorkspaceCanvas>(
    `/workspaces/${encodeURIComponent(workspaceId)}/canvas`,
    { signal }
  );

export const saveWorkspaceCanvas = (
  workspaceId: string,
  body: SaveCanvasInputBody
) =>
  api.put<WorkspaceCanvas>(
    `/workspaces/${encodeURIComponent(workspaceId)}/canvas`,
    body
  );

/** The save lost to another tab's: the canvas stops saving until a reload. */
export const isCanvasConflict = (error: unknown) =>
  isApiError(error) && error.status === 409;

export type CanvasPage = GenCanvasPage;

/** The caller's canvases a page at a time (Epo 2026-11-10, the account's
 * Canvas page): their own, latest saved first, then their workspaces'. */
export const listCanvases = (cursor: string, signal?: AbortSignal) =>
  api.get<CanvasPage>(
    `/canvases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal }
  );

/** A new canvas of the caller's own, in no workspace. */
export const createCanvas = (title: string) =>
  api.post<WorkspaceCanvas>('/canvases', { title });

export const canvasById = (id: string, signal?: AbortSignal) =>
  api.get<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, { signal });

export const saveCanvas = (id: string, body: SaveCanvasBody) =>
  api.put<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, body);

export const canvasesQuery = () =>
  infiniteQueryOptions({
    getNextPageParam: (last: CanvasPage) => last.nextCursor || undefined,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => listCanvases(pageParam, signal),
    queryKey: qk.canvases,
  });
