import { api, isApiError } from '@/api/client';
import type { CanvasBody, SaveCanvasInputBody } from '@/api/gen/model';

/** A member's personal workspace canvas (Epo 2026-11-09): found or made on open;
 * a save records the board asset it uploaded, at the revision it read. */

export type WorkspaceCanvas = CanvasBody;

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
