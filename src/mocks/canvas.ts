import { HttpResponse, http } from 'msw';
import type {
  CanvasBody,
  CanvasListItem,
  StorageFullBy,
  TrashItem,
  WorkspaceRole,
} from '@/api/types';
import { tokenClaims } from '@/features/collaboration/protocol';
import { trash, uid } from './db';
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
  /** The mock user's account, or the canvas's payer, is frozen or full (e2e):
   * their channel reads, whatever their role. */
  narrowed?: Narrowed;
  revision: number;
  /** The mock user's role on another member's canvas, when it is not their
   * role in the workspace (e2e: a viewer in a workspace they own). */
  role?: WorkspaceRole;
  shared: boolean;
  title: string;
  /** In its maker's Trash: the episode Restore names. */
  trash?: TrashItem;
  updatedAt: string;
  /** The room's stored version at its last projection. */
  version: number;
  workspaceId?: string;
};
/** Why an editor reads only: a frozen account, or whose storage is full. */
type Narrowed = 'frozen' | StorageFullBy;
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
  if (canvas.trash) return;
  if (!canvas.creatorName) return 'owner';
  if (!(canvas.shared && canvas.workspaceId)) return;
  return canvas.role ?? workspaceOf(canvas.workspaceId)?.role;
}

/** Whether a material is a canvas: its room is a board room. */
export const isMockCanvas = (id: string) => canvases.has(id);

/** The access a room token for the canvas carries for the mock user: `write`
 * for an owner or editor, `read` for a viewer or while narrowed, none for
 * anyone else. */
export function mockCanvasAccess(id: string): 'read' | 'write' | null {
  const canvas = canvases.get(id);
  const role = canvas && roleOn(canvas);
  if (!role) return null;
  return role === 'viewer' || canvas.narrowed ? 'read' : 'write';
}

/** Whether the mock user is a viewer on the canvas: their channel neither
 * sends nor hears presence (live-items D1). */
export const mockCanvasViewer = (id: string) => {
  const canvas = canvases.get(id);
  return !!canvas && roleOn(canvas) === 'viewer';
};

/** The mock user is narrowed to reading a canvas they may edit (e2e): a
 * frozen account (`frozen`), or a full storage, theirs (`self`) or its
 * payer's (`payer`). The room closes their channel (`mockNarrowBoard`). */
export function narrowMockCanvas(id: string, how: Narrowed = 'frozen') {
  const canvas = canvases.get(id);
  if (!canvas) throw new Error(`No mock canvas ${id}`);
  canvas.narrowed = how;
}

/** The mock user's role on another member's canvas drops to viewer (e2e).
 * The room closes their channel (`mockDemoteBoard`). */
export function demoteMockCanvas(id: string) {
  const canvas = canvases.get(id);
  if (!canvas) throw new Error(`No mock canvas ${id}`);
  canvas.role = 'viewer';
}

/** The room token for the canvas fails with a 503 while set (e2e: the
 * collaboration service down at open, the browser online). */
const failingTokens = new Set<string>();
export function failMockCanvasTokens(id: string, failing: boolean) {
  if (failing) failingTokens.add(id);
  else failingTokens.delete(id);
}

const encode = (claims: object) =>
  btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');

/** A room token as the API signs one, offering a client id (Q213): the
 * previous token's again when one of this canvas is presented (Go's
 * `regrantedClientIDs`, Q236), else a fresh one. The room decides whether
 * it binds (`MockBoardProvider`). */
export function mockCanvasToken(id: string, previous: string | undefined) {
  const claims = previous ? tokenClaims(previous) : {};
  const clientId =
    claims.materialId === id && typeof claims.clientId === 'number'
      ? claims.clientId
      : 1 + Math.floor(Math.random() * 2 ** 30);
  return `mock.${encode({ clientId, iat: Math.floor(Date.now() / 1000), materialId: id })}.sig`;
}

/** A board room's stored state as the gateway answers a trashed canvas's
 * board (base64 updates). Set by collaboration.ts, which keeps the rooms. */
let storedBoard: (id: string) => string[] = () => [];
export function setMockStoredBoard(read: (id: string) => string[]) {
  storedBoard = read;
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
  const n = next(`member:${workspaceId}`);
  // The scenarios workspace's keep drafts and copies, as its own canvases.
  const id =
    workspaceId === 'ws_scenarios'
      ? `mock-scenario-canvas-m${n}`
      : `cv_${workspaceId}_m${n}`;
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

const body = (canvas: MockCanvas): CanvasBody => {
  const role = roleOn(canvas);
  const editor = role === 'owner' || role === 'editor';
  // As the gateway answers (`editingOf`): a viewer, a frozen account and one
  // in the Trash edit nothing; a full storage stops content editing and says
  // whose, to editors.
  const full =
    editor && canvas.narrowed && canvas.narrowed !== 'frozen'
      ? canvas.narrowed
      : undefined;
  const canEdit = editor && canvas.narrowed !== 'frozen';
  const { trash: trashed } = canvas;
  return {
    capabilities: {
      canEdit,
      canEditContent: canEdit && !full,
      canManageMembers: false,
      canView: true,
    },
    id: canvas.id,
    imageAssetIds: canvas.imageAssetIds,
    own: !canvas.creatorName,
    // Every ready image asset of the canvas, as the gateway lists them.
    ownImageAssetIds: mockImageAssets(canvas.id),
    revision: canvas.revision,
    role,
    shared: canvas.shared,
    storageFull: full,
    title: canvas.title,
    trash: trashed && {
      canRestore: trashed.canRestore,
      episodeId: trashed.episodeId,
      purgeAfter: trashed.purgeAfter,
    },
    updatedAt: canvas.updatedAt,
    version: canvas.version,
    workspaceId: canvas.workspaceId,
  };
};

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Its maker deleted it: it goes to their Trash as a note does, its board
 * kept for the Trash to show and Restore to bring back. */
function trashCanvas(canvas: MockCanvas) {
  canvas.trash = trashItem(canvas);
  trash.unshift({ item: canvas.trash });
}

/** Its maker, another member, deleted their shared canvas (e2e): it goes to
 * their Trash, not this person's, and its read answers `item_deleted` to this
 * person, who held it (Q41). Its room is the collaboration mock's
 * (`deleteMockItem`). */
export function trashMockMemberCanvas(id: string) {
  const canvas = canvases.get(id);
  if (!canvas?.creatorName) throw new Error(`No member's mock canvas ${id}`);
  canvas.trash = trashItem(canvas);
}

/** The gateway's 410 for a trashed canvas its reader held (`deletedError`). */
const deletedCanvas = (canvas: MockCanvas) =>
  HttpResponse.json(
    {
      detail: 'the item was deleted',
      errors: [
        {
          message: 'item_deleted',
          value: { kind: 'canvas', name: canvas.title },
        },
      ],
      status: 410,
      title: 'Gone',
    },
    { status: 410 }
  );

function trashItem(canvas: MockCanvas): TrashItem {
  const now = Date.now();
  return {
    canRestore: true,
    episodeId: uid('trash'),
    id: canvas.id,
    kind: 'material',
    materialKind: 'canvas',
    purgeAfter: new Date(now + TRASH_RETENTION_MS).toISOString(),
    sizeBytes: 0,
    title: canvas.title,
    trashedAt: new Date(now).toISOString(),
    workspaceId: canvas.workspaceId,
    workspaceName: canvas.workspaceId
      ? workspaceOf(canvas.workspaceId)?.name
      : undefined,
  };
}

/** A trashed canvas's Trash row, by the episode a request names. */
const trashedRow = (id: string, episodeId: string | null) => {
  const canvas = canvases.get(id);
  if (!(canvas?.trash && canvas.trash.episodeId === episodeId)) return;
  const at = trash.findIndex((row) => row.item === canvas.trash);
  return { at, canvas };
};

const notFound = () => new HttpResponse(null, { status: 404 });
/** Nothing answers a device that is offline (e2e: a canvas opened offline). */
const offline = () => typeof navigator !== 'undefined' && !navigator.onLine;

/** Canvases whose title holds q, for the mock global search: one's own. */
export const searchCanvases = (q: string) =>
  [...canvases.values()].filter(
    (c) => !(c.creatorName || c.trash) && c.title.toLowerCase().includes(q)
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
        if (failingTokens.has(id))
          return new HttpResponse(null, { status: 503 });
        const access = mockCanvasAccess(id);
        if (!access) return notFound();
        const asked = (await request.json().catch(() => null)) as {
          access?: string;
          previousToken?: string;
        } | null;
        return HttpResponse.json(
          {
            access: asked?.access === 'read' ? 'read' : access,
            expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
            room: `material:${id}:schema:1`,
            token: mockCanvasToken(id, asked?.previousToken),
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
      if (canvas.creatorName || canvas.trash) return notFound();
      trashCanvas(canvas);
      return new HttpResponse(null, { status: 204 });
    }),
    // Restore from the Trash: the canvas is its maker's again, with its board.
    http.post('/api/trash/:kind/:id/restore', async ({ params, request }) => {
      const { episodeId } = (await request.clone().json()) as {
        episodeId: string;
      };
      const row = trashedRow(String(params.id), episodeId);
      if (!row) return;
      trash.splice(row.at, 1);
      row.canvas.trash = undefined;
      return HttpResponse.json({
        effect: {
          operation: 'restored',
          resource: {
            id: row.canvas.id,
            kind: 'material',
            title: row.canvas.title,
            workspaceId: row.canvas.workspaceId,
          },
        },
        kind: 'restore',
        operationId: uid('op'),
        outcome: 'succeeded',
        toolVersion: 1,
      });
    }),
    // Deleted for good: its stored board goes with it (collaboration.ts keeps
    // one for the tab), so a reload makes a first canvas afresh.
    http.delete('/api/trash/:kind/:id', ({ params, request }) => {
      const row = trashedRow(
        String(params.id),
        new URL(request.url).searchParams.get('episodeId')
      );
      if (!row) return;
      trash.splice(row.at, 1);
      canvases.delete(row.canvas.id);
      if (typeof sessionStorage !== 'undefined')
        sessionStorage.removeItem(
          `capy.mock.board.material:${row.canvas.id}:schema:1`
        );
      return HttpResponse.json({
        kind: 'purge',
        operationId: uid('op'),
        outcome: 'succeeded',
        toolVersion: 1,
      });
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
                : !(canvas.creatorName || canvas.trash)
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
      // The scenarios workspace's canvases keep drafts and device copies, as
      // every MSW scenario fixture does (editDrafts.ts, deviceCopy.ts).
      const id =
        workspaceId === 'ws_scenarios'
          ? `mock-scenario-canvas-${count}`
          : workspaceId
            ? `cv_${workspaceId}_${count}`
            : `cv_own_${count}`;
      return HttpResponse.json(body(make(id, title, workspaceId)), {
        status: 201,
      });
    }),
    // One its maker holds, a member's shared one, or one in the caller's
    // Trash (its maker's alone), read-only. A member's shared one its maker
    // trashed answers deleted to whoever held it.
    http.get('/api/canvases/:id', ({ params }) => {
      if (offline()) return HttpResponse.error();
      const canvas = canvases.get(String(params.id));
      if (!canvas) return notFound();
      if (roleOn(canvas) || (canvas.trash && !canvas.creatorName))
        return HttpResponse.json(body(canvas));
      return canvas.trash && roleOn({ ...canvas, trash: undefined })
        ? deletedCanvas(canvas)
        : notFound();
    }),
    // A trashed canvas's stored board; none for a live one.
    http.get('/api/canvases/:id/board', ({ params }) => {
      if (offline()) return HttpResponse.error();
      const canvas = canvases.get(String(params.id));
      if (!(canvas?.trash && !canvas.creatorName)) return notFound();
      return HttpResponse.json({ updates: storedBoard(canvas.id) });
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
