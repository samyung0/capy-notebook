import { HttpResponse, http } from 'msw';
import type { CanvasBody } from '@/api/gen/model';

/** A member's personal workspace canvas (Epo 2026-11-09): one per workspace in
 * this mock, made on first open; a save at a stale revision is refused (409), as
 * the gateway refuses another tab's. Its board asset is a mock editor asset. */
const canvases = new Map<string, CanvasBody>();

const canvasFor = (workspaceId: string): CanvasBody => {
  let canvas = canvases.get(workspaceId);
  if (!canvas) {
    canvas = {
      boardAssetId: '',
      id: `cv_${workspaceId}`,
      imageAssetIds: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      version: 0,
    };
    canvases.set(workspaceId, canvas);
  }
  return canvas;
};

export const canvasHandlers = [
  http.get('/api/workspaces/:id/canvas', ({ params }) =>
    HttpResponse.json(canvasFor(String(params.id)))
  ),
  http.put('/api/workspaces/:id/canvas', async ({ params, request }) => {
    const canvas = canvasFor(String(params.id));
    const body = (await request.json()) as {
      boardAssetId: string;
      imageAssetIds?: string[];
      revision: number;
      version: number;
    };
    if (body.revision !== canvas.revision)
      return HttpResponse.json(
        { detail: 'this canvas was saved from another tab', status: 409 },
        { status: 409 }
      );
    canvas.boardAssetId = body.boardAssetId;
    canvas.version = body.version;
    canvas.imageAssetIds = body.imageAssetIds ?? [];
    canvas.revision += 1;
    canvas.updatedAt = new Date().toISOString();
    return HttpResponse.json(canvas);
  }),
];
