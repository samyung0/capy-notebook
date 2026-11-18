import { HttpResponse, http } from 'msw';
import type { CanvasBody, CanvasListItem } from '@/api/gen/model';
import type { WorkspaceRole } from '@/api/types';
import { mockImageAssets } from './editorAssets';
import { mockPage } from './paging';

/** A person's canvases (Epo 2026-11-09, 2026-11-10 and 2026-11-12): any number
 * of their own, made on the Canvas page, and any number in each workspace, made
 * in its Canvas tab. A canvas's drawing lives in its collaboration room (Epo
 * 2026-11-18; the board room in collaboration.ts), and one made in a workspace
 * can be shared with the workspace's members, who then hold it by their
 * workspace role. */
type MockCanvas = {
  /** Who made it, when not the mock user (another member's shared canvas). */
  creatorName?: string;
  id: string;
  /** The images on the board at its room's last projection. */
  imageAssetIds: string[];
  revision: number;
  /** The mock user's role on another member's canvas, when it is not their
   * role in the workspace (e2e: a viewer in a workspace they own). */
  role?: WorkspaceRole;
  shared: boolean;
  title: string;
  updatedAt: string;
  /** The room's stored version at its last projection. */
  version: number;
  workspaceId?: string;
};
const canvases = new Map<string, MockCanvas>();
/** Canvases made so far, counted per workspace and for one's own (''). */
const made = new Map<string, number>();

type MockWorkspace = { iconId: string; name: string; role?: WorkspaceRole };
/** A workspace's icon, name and the mock user's role in it, for the list's
 * rows and for who may draw. Set by `canvasHandlers`. */
let workspaceOf: (id: string) => MockWorkspace | undefined = () => undefined;

const make = (
  id: string,
  title: string,
  workspaceId?: string,
  member?: Pick<MockCanvas, 'creatorName' | 'role'>
) => {
  const canvas: MockCanvas = {
    ...member,
    id,
    imageAssetIds: [],
    revision: 1,
    shared: !!member,
    title,
    updatedAt: new Date().toISOString(),
    version: 0,
    workspaceId,
  };
  canvases.set(id, canvas);
  return canvas;
};

const next = (workspaceId = '') => {
  const count = (made.get(workspaceId) ?? 0) + 1;
  made.set(workspaceId, count);
  return count;
};

/** The mock user's role on a canvas, as the gateway decides it: its maker's
 * is `owner`; on another member's, their workspace role while it is shared;
 * none otherwise. */
function roleOn(canvas: MockCanvas): WorkspaceRole | undefined {
  if (!canvas.creatorName) return 'owner';
  if (!(canvas.shared && canvas.workspaceId)) return;
  return canvas.role ?? workspaceOf(canvas.workspaceId)?.role;
}

/** Whether a material is a canvas: its room is a board room. */
export const isMockCanvas = (id: string) => canvases.has(id);

/** The access a room token for the canvas carries for the mock user: `write`
 * for an owner or editor, `read` for a viewer, none for anyone else. */
export function mockCanvasAccess(id: string): 'read' | 'write' | null {
  const canvas = canvases.get(id);
  const role = canvas && roleOn(canvas);
  if (!role) return null;
  return role === 'viewer' ? 'read' : 'write';
}

/** Another member's canvas in a workspace, shared with it (e2e): the mock
 * user holds it by `role`, or by their role in the workspace. Answers its id. */
export function mockMemberCanvas({
  creatorName,
  role,
  title,
  workspaceId,
}: {
  creatorName: string;
  role?: WorkspaceRole;
  title: string;
  workspaceId: string;
}) {
  const id = `cv_${workspaceId}_m${next(`member:${workspaceId}`)}`;
  return make(id, title, workspaceId, { creatorName, role }).id;
}

/** Its maker took a shared canvas back (e2e): the other members hold nothing
 * of it from now. The room closes their channels (`mockRevokeBoard`). */
export function unshareMockCanvas(id: string) {
  const canvas = canvases.get(id);
  if (!canvas) throw new Error(`No mock canvas ${id}`);
  canvas.shared = false;
}

/** The room's projection of a canvas (collaboration.ts): the images its board
 * holds, at the room's stored version. */
export function projectMockCanvas(
  id: string,
  version: number,
  imageAssetIds: string[]
) {
  const canvas = canvases.get(id);
  if (!canvas) return;
  canvas.imageAssetIds = imageAssetIds;
  canvas.version = version;
  canvas.updatedAt = new Date().toISOString();
}

const body = (canvas: MockCanvas): CanvasBody => ({
  id: canvas.id,
  imageAssetIds: canvas.imageAssetIds,
  own: !canvas.creatorName,
  // Every ready image asset of the canvas, as the gateway lists them.
  ownImageAssetIds: mockImageAssets(canvas.id),
  revision: canvas.revision,
  shared: canvas.shared,
  title: canvas.title,
  updatedAt: canvas.updatedAt,
  version: canvas.version,
  workspaceId: canvas.workspaceId,
});

const notFound = () => new HttpResponse(null, { status: 404 });
/** Nothing answers a device that is offline (e2e: a canvas opened offline). */
const offline = () => typeof navigator !== 'undefined' && !navigator.onLine;

/** Canvases whose title holds q, for the mock global search: one's own. */
export const searchCanvases = (q: string) =>
  [...canvases.values()].filter(
    (c) => !c.creatorName && c.title.toLowerCase().includes(q)
  );

/** `workspaces` names a workspace, its icon and the mock user's role in it. */
export const canvasHandlers = (
  workspaces: (id: string) => MockWorkspace | undefined
) => {
  workspaceOf = workspaces;
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
    // A canvas's room token: its room, and read or write by the mock user's
    // role on it. Any other material falls through to the materials mock.
    http.post(
      '/api/materials/:id/collaboration-token',
      async ({ params, request }) => {
        const id = String(params.id);
        if (!canvases.has(id)) return;
        if (offline()) return HttpResponse.error();
        const access = mockCanvasAccess(id);
        if (!access) return notFound();
        const asked = (await request.json().catch(() => null)) as {
          access?: string;
        } | null;
        return HttpResponse.json(
          {
            access: asked?.access === 'read' ? 'read' : access,
            expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
            room: `material:${id}:schema:1`,
            token: 'mock-collaboration-token',
            url: 'mock://collaboration',
          },
          { status: 201 }
        );
      }
    ),
    // Renamed and deleted as any standalone material is, by its maker alone.
    http.patch('/api/materials/:id/metadata', async ({ params, request }) => {
      const canvas = canvases.get(String(params.id));
      if (!canvas) return;
      if (canvas.creatorName) return notFound();
      const { title } = (await request.json()) as { title?: string };
      if (title) canvas.title = title;
      return HttpResponse.json({ id: canvas.id, kind: 'canvas', title });
    }),
    http.delete('/api/materials/:id', ({ params }) => {
      const canvas = canvases.get(String(params.id));
      if (!canvas) return;
      if (canvas.creatorName) return notFound();
      canvases.delete(canvas.id);
      // Its stored board goes with it (collaboration.ts keeps one for the
      // tab): a reload makes the first canvas afresh under the same id.
      if (typeof sessionStorage !== 'undefined')
        sessionStorage.removeItem(
          `capy.mock.board.material:${canvas.id}:schema:1`
        );
      return new HttpResponse(null, { status: 204 });
    }),
    // One's own first, latest saved first, then the ones drawn in workspaces, a
    // page at a time; or one workspace's: the mock user's there and the other
    // members' shared ones, latest saved first.
    http.get('/api/canvases', ({ request }) => {
      const only = new URL(request.url).searchParams.get('workspaceId');
      return HttpResponse.json(
        mockPage(
          [...canvases.values()]
            .filter((canvas) =>
              only
                ? canvas.workspaceId === only && !!roleOn(canvas)
                : !canvas.creatorName
            )
            .sort(
              (a, b) =>
                Number(!!a.workspaceId) - Number(!!b.workspaceId) ||
                b.updatedAt.localeCompare(a.updatedAt)
            )
            .map(
              (canvas): CanvasListItem => ({
                id: canvas.id,
                own: !canvas.creatorName,
                shared: canvas.shared,
                title: canvas.title,
                updatedAt: canvas.updatedAt,
                ...(canvas.creatorName
                  ? { creatorName: canvas.creatorName }
                  : {}),
                ...(canvas.workspaceId
                  ? {
                      workspaceIconId: workspaces(canvas.workspaceId)?.iconId,
                      workspaceId: canvas.workspaceId,
                      workspaceName: workspaces(canvas.workspaceId)?.name,
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
      const count = next(workspaceId);
      const id = workspaceId ? `cv_${workspaceId}_${count}` : `cv_own_${count}`;
      return HttpResponse.json(body(make(id, title, workspaceId)), {
        status: 201,
      });
    }),
    http.get('/api/canvases/:id', ({ params }) => {
      if (offline()) return HttpResponse.error();
      const canvas = canvases.get(String(params.id));
      return canvas && roleOn(canvas)
        ? HttpResponse.json(body(canvas))
        : notFound();
    }),
    // Shared with its workspace or taken back: its maker alone, while the
    // workspace's owner or editor; a canvas in no workspace has no one to
    // share with (422).
    http.patch('/api/canvases/:id', async ({ params, request }) => {
      const canvas = canvases.get(String(params.id));
      if (!(canvas && roleOn(canvas))) return notFound();
      if (!canvas.workspaceId)
        return HttpResponse.json(
          { detail: 'a canvas in no workspace cannot be shared', status: 422 },
          { status: 422 }
        );
      const role = workspaces(canvas.workspaceId)?.role;
      if (canvas.creatorName || !(role === 'owner' || role === 'editor'))
        return new HttpResponse(null, { status: 403 });
      const { shared } = (await request.json()) as { shared: boolean };
      canvas.shared = shared;
      return HttpResponse.json(body(canvas));
    }),
  ];
};
