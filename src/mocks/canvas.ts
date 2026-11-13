import { HttpResponse, http } from 'msw';
import type { CanvasBody, CanvasListItem } from '@/api/gen/model';
import { mockImageAssets } from './editorAssets';
import { mockPage } from './paging';

/** A person's canvases (Epo 2026-11-09, 2026-11-10 and 2026-11-12): any number
 * of their own, made on the Canvas page, and any number in each workspace, made
 * in its Canvas tab. A
 * save at a stale revision is refused (409), as the gateway refuses another
 * tab's, and one naming an image that isn't the canvas's own is a 400. A board
 * asset is a mock editor asset. */
type MockCanvas = CanvasBody & { workspaceId?: string };
const canvases = new Map<string, MockCanvas>();
/** Canvases made so far, counted per workspace and for one's own (''). */
const made = new Map<string, number>();

const make = (id: string, title: string, workspaceId?: string) => {
  const canvas: MockCanvas = {
    boardAssetId: '',
    id,
    imageAssetIds: [],
    ownImageAssetIds: [],
    revision: 1,
    title,
    updatedAt: new Date().toISOString(),
    version: 0,
    workspaceId,
  };
  canvases.set(id, canvas);
  return canvas;
};

/** With the image assets a save may name, as the gateway lists them. */
const body = ({ workspaceId: _, ...canvas }: MockCanvas): CanvasBody => ({
  ...canvas,
  ownImageAssetIds: mockImageAssets(canvas.id),
});

const save = async (canvas: MockCanvas, request: Request) => {
  const sent = (await request.json()) as {
    boardAssetId: string;
    imageAssetIds?: string[];
    revision: number;
  };
  if (sent.revision !== canvas.revision)
    return HttpResponse.json(
      { detail: 'this canvas was saved from another tab', status: 409 },
      { status: 409 }
    );
  const own = mockImageAssets(canvas.id);
  if (sent.imageAssetIds?.some((id) => !own.includes(id)))
    return HttpResponse.json(
      { detail: "a save names only this canvas's ready assets", status: 400 },
      { status: 400 }
    );
  canvas.boardAssetId = sent.boardAssetId;
  canvas.version += 1;
  canvas.imageAssetIds = sent.imageAssetIds ?? [];
  canvas.revision += 1;
  canvas.updatedAt = new Date().toISOString();
  return HttpResponse.json(body(canvas));
};

/** `workspaces` names a workspace and its icon, for the list's rows. */
/** Canvases whose title holds q, for the mock global search. */
export const searchCanvases = (q: string) =>
  [...canvases.values()].filter((c) => c.title.toLowerCase().includes(q));

export const canvasHandlers = (
  workspaces: (id: string) => { iconId: string; name: string } | undefined
) => {
  return [
    // A canvas read as a material, for its owner's plan image cap; any other
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
    // Renamed and deleted as any standalone material is.
    http.patch('/api/materials/:id/metadata', async ({ params, request }) => {
      const canvas = canvases.get(String(params.id));
      if (!canvas) return;
      const { title } = (await request.json()) as { title?: string };
      if (title) canvas.title = title;
      return HttpResponse.json({ id: canvas.id, kind: 'canvas', title });
    }),
    http.delete('/api/materials/:id', ({ params }) => {
      if (!canvases.delete(String(params.id))) return;
      return new HttpResponse(null, { status: 204 });
    }),
    // One's own first, latest saved first, then the workspaces', a page at a
    // time; or one workspace's.
    http.get('/api/canvases', ({ request }) => {
      const only = new URL(request.url).searchParams.get('workspaceId');
      return HttpResponse.json(
        mockPage(
          [...canvases.values()]
            .filter(({ workspaceId }) => !only || workspaceId === only)
            .sort(
              (a, b) =>
                Number(!!a.workspaceId) - Number(!!b.workspaceId) ||
                b.updatedAt.localeCompare(a.updatedAt)
            )
            .map(
              ({ id, title, updatedAt, workspaceId }): CanvasListItem => ({
                id,
                title,
                updatedAt,
                ...(workspaceId
                  ? {
                      workspaceIconId: workspaces(workspaceId)?.iconId,
                      workspaceId,
                      workspaceName: workspaces(workspaceId)?.name,
                    }
                  : {}),
              })
            ),
          request
        )
      );
    }),
    http.post('/api/canvases', async ({ request }) => {
      const { title, workspaceId } = (await request.json()) as {
        title: string;
        workspaceId?: string;
      };
      const count = (made.get(workspaceId ?? '') ?? 0) + 1;
      made.set(workspaceId ?? '', count);
      const id = workspaceId ? `cv_${workspaceId}_${count}` : `cv_own_${count}`;
      return HttpResponse.json(body(make(id, title, workspaceId)), {
        status: 201,
      });
    }),
    http.get('/api/canvases/:id', ({ params }) => {
      const canvas = canvases.get(String(params.id));
      return canvas
        ? HttpResponse.json(body(canvas))
        : new HttpResponse(null, { status: 404 });
    }),
    http.put('/api/canvases/:id', ({ params, request }) => {
      const canvas = canvases.get(String(params.id));
      return canvas
        ? save(canvas, request)
        : new HttpResponse(null, { status: 404 });
    }),
  ];
};
