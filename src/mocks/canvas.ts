import { HttpResponse, http } from 'msw';
import type { CanvasBody } from '@/api/gen/model';
import { mockImageAssets } from './editorAssets';

/** A member's personal workspace canvas (Epo 2026-11-09): one per workspace in
 * this mock, made on first open; a save at a stale revision is refused (409), as
 * the gateway refuses another tab's, and one naming an image that isn't the
 * canvas's own is a 400. Its board asset is a mock editor asset. */
const canvases = new Map<string, CanvasBody>();

const canvasFor = (workspaceId: string): CanvasBody => {
  let canvas = canvases.get(workspaceId);
  if (!canvas) {
    canvas = {
      boardAssetId: '',
      id: `cv_${workspaceId}`,
      imageAssetIds: [],
      ownImageAssetIds: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      version: 0,
    };
    canvases.set(workspaceId, canvas);
  }
  return canvas;
};

/** The Files page's rows for the canvases opened so far: each under the
 * workspace it is the Canvas tab of, with a preview once it has a board. */
export const mockCanvasRows = (workspaceName: (id: string) => string) =>
  [...canvases].map(([workspaceId, canvas]) => ({
    canvasWorkspaceId: workspaceId,
    createdAt: canvas.updatedAt,
    id: canvas.id,
    isOwner: true,
    kind: 'canvas' as const,
    preview: canvas.boardAssetId
      ? { boardAssetId: canvas.boardAssetId, kind: 'canvas' as const }
      : undefined,
    privacy: 'private' as const,
    sizeBytes: 2048,
    title: workspaceName(workspaceId),
    topicId: null,
    topicName: '',
    updatedAt: canvas.updatedAt,
    workspaceId: '',
    workspaceName: workspaceName(workspaceId),
  }));

/** With the image assets a save may name, as the gateway lists them. */
const listed = (canvas: CanvasBody): CanvasBody => ({
  ...canvas,
  ownImageAssetIds: mockImageAssets(canvas.id),
});

export const canvasHandlers = [
  // Its row's Delete: the canvas goes, and the tab makes a fresh one. Any
  // other material falls through to the materials mock.
  http.delete('/api/materials/:id', ({ params }) => {
    const id = String(params.id);
    if (!id.startsWith('cv_')) return;
    canvases.delete(id.slice('cv_'.length));
    return new HttpResponse(null, { status: 204 });
  }),
  // The canvas read as a material, for its owner's plan image cap; any other
  // material falls through to the materials mock.
  http.get('/api/materials/:id', ({ params }) => {
    const id = String(params.id);
    if (!id.startsWith('cv_')) return;
    return HttpResponse.json({
      audioMaxBytes: 20 * 1024 * 1024,
      id,
      imageMaxBytes: 2 * 1024 * 1024,
      kind: 'canvas',
    });
  }),
  http.get('/api/workspaces/:id/canvas', ({ params }) =>
    HttpResponse.json(listed(canvasFor(String(params.id))))
  ),
  http.put('/api/workspaces/:id/canvas', async ({ params, request }) => {
    const canvas = canvasFor(String(params.id));
    const body = (await request.json()) as {
      boardAssetId: string;
      imageAssetIds?: string[];
      revision: number;
    };
    if (body.revision !== canvas.revision)
      return HttpResponse.json(
        { detail: 'this canvas was saved from another tab', status: 409 },
        { status: 409 }
      );
    const own = mockImageAssets(canvas.id);
    if (body.imageAssetIds?.some((id) => !own.includes(id)))
      return HttpResponse.json(
        { detail: "a save names only this canvas's ready assets", status: 400 },
        { status: 400 }
      );
    canvas.boardAssetId = body.boardAssetId;
    canvas.version += 1;
    canvas.imageAssetIds = body.imageAssetIds ?? [];
    canvas.revision += 1;
    canvas.updatedAt = new Date().toISOString();
    return HttpResponse.json(listed(canvas));
  }),
];
