import { queryOptions } from '@tanstack/react-query';
import { api, isApiError, qk } from '@/api/client';
import type {
  CanvasBody,
  CanvasListItem as GenCanvasListItem,
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

/** Every canvas the caller has: their own and their workspaces' (Epo
 * 2026-11-10, the account's Canvas page), latest saved first. */
export const listCanvases = (signal?: AbortSignal) =>
  api
    .get<{ items: CanvasListItem[] }>('/canvases', { signal })
    .then(({ items }) => items);

/** A new canvas of the caller's own, in no workspace. */
export const createCanvas = (title: string) =>
  api.post<WorkspaceCanvas>('/canvases', { title });

export const canvasById = (id: string, signal?: AbortSignal) =>
  api.get<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, { signal });

export const saveCanvas = (id: string, body: SaveCanvasBody) =>
  api.put<WorkspaceCanvas>(`/canvases/${encodeURIComponent(id)}`, body);

export const canvasesQuery = () =>
  queryOptions({
    queryFn: ({ signal }) => listCanvases(signal),
    queryKey: qk.canvases,
  });
