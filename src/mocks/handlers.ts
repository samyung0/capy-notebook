import { delay, HttpResponse, http } from 'msw';
import type { SuggestionMutationResult } from '@/api/gen/model';
import type {
  Chapter,
  Deck,
  Flashcard,
  GenerateOptions,
  Material,
  MaterialDiscussion,
  MaterialRef,
  MaterialRefType,
  MaterialSuggestion,
  Question,
  Quiz,
  SearchResult,
  SourceFile,
  Tag,
  TagInput,
  Task,
  UserColor,
  Workspace,
  WorkspaceMember,
} from '@/api/types';
import { parseFlashcardsBlock } from '@/features/materials/blocks';
import {
  createMaterialDocument,
  emptyMaterialDocument,
  type FlashcardsElement,
  flashcardsElementToCards,
  flashcardsNode,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import {
  finalizeSuggestionValue,
  resolveSuggestions,
  scanSuggestions,
} from '@/features/notes/suggestions';
import { getFileKind } from '@/features/workspace/sourceUpload';
import { isKnown, newSrsState } from '@/lib/srs';
import * as db from './db';
import { uid } from './db';
import { sourceUploadPolicy } from './sourceUploadPolicy';

/** Map a material's storage kind to the legacy left-panel ref type. */
const refType = (kind: Material['kind']): MaterialRefType =>
  kind === 'flashcards' ? 'deck' : kind;

const latency = () => delay(1000 + Math.random() * 220);
const ownerMaterialAccess = {
  capabilities: {
    canComment: true,
    canEdit: true,
    canManageMembers: true,
    canView: true,
  },
  role: 'owner' as const,
};
interface MockWorkspaceInvite {
  acceptedAt?: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedUserId: string;
  role: Exclude<WorkspaceMember['role'], 'owner'>;
  token: string;
  workspaceId: string;
}
interface MockInviteCandidate {
  avatarUrl?: string;
  email: string;
  id: string;
  name: string;
}

const mockDiscussions: MaterialDiscussion[] = [];
const mockSuggestions: MaterialSuggestion[] = [];
const mockWorkspaceInvites: MockWorkspaceInvite[] = [];
const mockWorkspaceMembers: WorkspaceMember[] = [];
const mockInviteCandidates: MockInviteCandidate[] = [
  {
    email: 'morgan@example.com',
    id: 'u_mock_collaborator',
    name: 'Morgan Lee',
  },
];

const editorStateCacheName = 'evo-notes-editor-e2e-state-v1';
const editorStateRequest = (materialId: string) =>
  new Request(
    `https://editor-state.evonotes.test/materials/${encodeURIComponent(materialId)}`
  );

/**
 * SOURCE: The editor Playwright project deliberately runs against MSW, whose
 * module arrays are recreated by a full page reload. Cache Storage is isolated
 * per Playwright browser context, so this test-only backdoor preserves the
 * revision head and collaboration projection across reloads without leaking
 * state between parallel journeys or introducing a second mock server.
 */
async function persistEditorState(materialId: string) {
  if (import.meta.env.VITE_E2E_EDITOR_SEED !== 'true' || !globalThis.caches)
    return;
  const material = db.materials.find((item) => item.id === materialId);
  if (!material) return;
  const discussions = mockDiscussions.filter(
    (item) => item.materialId === materialId
  );
  const cache = await globalThis.caches.open(editorStateCacheName);
  await cache.put(
    editorStateRequest(materialId),
    Response.json({ discussions, material })
  );
}

async function hydrateEditorState(materialId: string) {
  if (import.meta.env.VITE_E2E_EDITOR_SEED !== 'true' || !globalThis.caches)
    return;
  const cached = await (
    await globalThis.caches.open(editorStateCacheName)
  ).match(editorStateRequest(materialId));
  if (!cached) return;
  const state = (await cached.json()) as {
    material: Material;
    discussions: MaterialDiscussion[];
  };
  const material = db.materials.find((item) => item.id === materialId);
  if (material) Object.assign(material, state.material);
  const previousDiscussionIds = new Set(
    mockDiscussions
      .filter((item) => item.materialId === materialId)
      .map((item) => item.id)
  );
  for (let index = mockDiscussions.length - 1; index >= 0; index--) {
    if (mockDiscussions[index].materialId === materialId)
      mockDiscussions.splice(index, 1);
  }
  for (let index = mockSuggestions.length - 1; index >= 0; index--) {
    if (previousDiscussionIds.has(mockSuggestions[index].discussionId)) {
      mockSuggestions.splice(index, 1);
    }
  }
  const discussions = structuredClone(state.discussions);
  mockDiscussions.push(...discussions);
  mockSuggestions.push(
    ...discussions.flatMap((discussion) => discussion.suggestions)
  );
}

function mockSuggestionResult(
  material: Material,
  suggestionIds: string[]
): SuggestionMutationResult {
  return {
    contentBytes: material.contentBytes ?? 0,
    discussions: mockDiscussions.filter(
      (discussion) => discussion.materialId === material.id
    ),
    hasPendingSuggestions: material.hasPendingSuggestions ?? false,
    id: material.id,
    revision: material.revision ?? 1,
    suggestionIds,
    updatedAt: material.updatedAt ?? new Date().toISOString(),
  };
}

const mockNodeText = (node: unknown): string => {
  if (!node || typeof node !== 'object') return '';
  const value = node as { text?: unknown; children?: unknown[] };
  if (typeof value.text === 'string') return value.text;
  return (value.children ?? []).map(mockNodeText).join('');
};

const materialCards = (material: Material) =>
  typeof material.content === 'string'
    ? parseFlashcardsBlock(material.content).cards
    : flashcardsElementToCards(
        finalizeSuggestionValue(material.content.value, 'reject').find(
          (node) => node.type === 'flashcards'
        ) as FlashcardsElement
      );

const quizDocument = (
  questions: Question[],
  timeLimitMin?: number,
  id = uid('quiz')
) => createMaterialDocument([quizNode({ questions, timeLimitMin }, id)]);

const flashcardsDocument = (
  cards: { id: string; front: string; back: string }[],
  id = uid('flashcards')
) => createMaterialDocument([flashcardsNode(cards, id)]);

/** Resolve incoming tag refs against the catalog: reuse by id (preserving the
 * row), else match by value, else create a new catalog entry. Mirrors the
 * backend's resolveTag + syncEntityTags so dev mode matches prod behavior. */
function resolveTags(kind: string, refs: TagInput[] | null | undefined): Tag[] {
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const r of refs ?? []) {
    const value = (r.value ?? '').trim();
    if (!value) continue;
    let entry = r.id
      ? db.tagCatalog.find((t) => t.id === r.id && t.kind === kind)
      : undefined;
    if (!entry)
      entry = db.tagCatalog.find(
        (t) => t.kind === kind && t.value.toLowerCase() === value.toLowerCase()
      );
    if (!entry) {
      entry = { id: uid('tag'), kind, value };
      db.tagCatalog.push(entry);
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ id: entry.id, value: entry.value });
  }
  return out;
}

function sortWorkspaces(list: Workspace[], sort: string | null): Workspace[] {
  const copy = [...list];
  switch (sort) {
    case 'created':
      return copy.sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
      );
    case 'chapters':
      return copy.sort((a, b) => b.chapterCount - a.chapterCount);
    case 'files':
      return copy.sort((a, b) => b.fileCount - a.fileCount);
    default:
      return copy.sort(
        (a, b) => +new Date(b.lastAccessedAt) - +new Date(a.lastAccessedAt)
      );
  }
}

export const handlers = [
  /* ---------------- me ---------------- */
  http.get('/api/me', async () => {
    await latency();
    return HttpResponse.json(db.user);
  }),

  /* ---------------- global search ---------------- */
  http.get('/api/search', async ({ request }) => {
    await latency();
    const q = (new URL(request.url).searchParams.get('q') ?? '')
      .toLowerCase()
      .trim();
    if (!q) return HttpResponse.json([] as SearchResult[]);
    const results: SearchResult[] = [];
    for (const w of db.workspaces)
      if (
        w.name.toLowerCase().includes(q) ||
        w.tags.some((t) => t.value.toLowerCase().includes(q))
      )
        results.push({
          color: w.color,
          href: `/workspaces/${w.id}`,
          id: w.id,
          kind: 'workspace',
          subtitle: w.tags.map((t) => t.value).join(' · '),
          title: w.name,
        });
    for (const f of db.files)
      if (f.name.toLowerCase().includes(q)) {
        const ws = db.workspaces.find((w) => w.id === f.workspaceId);
        results.push({
          color: ws?.color,
          href: `/workspaces/${f.workspaceId}?file=${f.id}`,
          id: f.id,
          kind: 'file',
          subtitle: ws?.name,
          title: f.name,
        });
      }
    for (const e of db.events)
      if (e.title.toLowerCase().includes(q))
        results.push({
          color: db.labels.find((l) => l.id === e.labelIds[0])?.color,
          href: '/schedule',
          id: e.id,
          kind: 'event',
          subtitle: e.location,
          title: e.title,
        });
    for (const mt of db.deckMaterials())
      if (mt.title.toLowerCase().includes(q))
        results.push({
          color: mt.color,
          href: `/flashcards/${mt.id}`,
          id: mt.id,
          kind: 'flashcards',
          subtitle: mt.workspaceName,
          title: mt.title,
        });
    for (const c of db.canvases)
      if (c.name.toLowerCase().includes(q))
        results.push({
          href: `/thinking/${c.id}`,
          id: c.id,
          kind: 'thinking',
          title: c.name,
        });
    return HttpResponse.json(results.slice(0, 20));
  }),

  /* ---------------- notifications ---------------- */
  http.get('/api/notifications', async () => {
    await latency();
    return HttpResponse.json(db.notifications);
  }),
  http.post('/api/notifications/read', async () => {
    db.notifications.forEach((notification) => {
      notification.read = true;
    });
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- tags ---------------- */
  http.get('/api/tags', async ({ request }) => {
    await latency();
    const kind = new URL(request.url).searchParams.get('kind') ?? 'workspace';
    const list = db.tagCatalog
      .filter((t) => t.kind === kind)
      .map((t) => ({ id: t.id, value: t.value }))
      .sort((a, b) => a.value.localeCompare(b.value));
    return HttpResponse.json(list as Tag[]);
  }),

  /* ---------------- workspaces ---------------- */
  // TODO response/request/schema model is different
  http.get('/api/workspaces', async ({ request }) => {
    await latency();
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
    const colors = (url.searchParams.get('color') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const tags = (url.searchParams.get('tag') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const sort = url.searchParams.get('sort');
    let list = [...db.workspaces];
    if (q)
      list = list.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          w.tags.some((t) => t.value.toLowerCase().includes(q))
      );
    if (colors.length || tags.length) {
      list = list.filter(
        (w) =>
          (colors.length > 0 && colors.includes(w.color)) ||
          (tags.length > 0 && w.tags.some((t) => tags.includes(t.value)))
      );
    }
    return HttpResponse.json(sortWorkspaces(list, sort));
  }),
  http.get('/api/workspaces/:id', async ({ params }) => {
    await latency();
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    ws.lastAccessedAt = new Date().toISOString();
    return HttpResponse.json({ ...ws, isOwner: ws.isOwner ?? true });
  }),
  http.get('/api/workspaces/:id/stats', async ({ params }) => {
    await latency();
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const wsQuizIds = new Set(
      db
        .quizMaterials()
        .filter((m) => m.workspaceId === ws.id)
        .map((m) => m.id)
    );
    const att = db.attempts.filter((a) => wsQuizIds.has(a.quizId));
    const avg = att.length
      ? Math.round(att.reduce((s, a) => s + a.pct, 0) / att.length)
      : 0;
    return HttpResponse.json({
      attempts: att.length,
      avgScore: avg,
      chapters: ws.chapterCount,
      files: ws.fileCount,
      quizzes: wsQuizIds.size,
    });
  }),
  http.post('/api/workspaces', async ({ request }) => {
    const body = (await request.json()) as Partial<Workspace> & {
      tags?: TagInput[];
    };
    const ws: Workspace = {
      capabilities: {
        canComment: true,
        canEdit: true,
        canManageMembers: true,
        canView: true,
      },
      chapterCount: 0,
      color: (body.color as UserColor) ?? 'green',
      createdAt: new Date().toISOString(),
      fileCount: 0,
      id: uid('ws'),
      lastAccessedAt: new Date().toISOString(),
      name: body.name ?? 'Untitled workspace',
      privacy: 'private',
      role: 'owner',
      shareRole: 'viewer',
      tags: resolveTags('workspace', body.tags),
    };
    db.workspaces.unshift(ws);
    return HttpResponse.json(ws, { status: 201 });
  }),
  http.patch('/api/workspaces/:id', async ({ params, request }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<Workspace> & {
      tags?: TagInput[];
    };
    if (body.tags !== undefined) ws.tags = resolveTags('workspace', body.tags);
    if (body.name !== undefined) ws.name = body.name;
    if (body.color !== undefined) ws.color = body.color;
    return HttpResponse.json(ws);
  }),
  http.patch('/api/workspaces/:id/sharing', async ({ params, request }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Pick<
      Workspace,
      'privacy' | 'shareRole'
    >;
    if (body.privacy !== undefined) ws.privacy = body.privacy;
    if (body.shareRole !== undefined) ws.shareRole = body.shareRole;
    return HttpResponse.json(ws);
  }),
  http.get('/api/workspaces/:id/members', async ({ params }) => {
    const workspaceId = String(params.id);
    return HttpResponse.json([
      {
        createdAt:
          db.workspaces.find((workspace) => workspace.id === params.id)
            ?.createdAt ?? '',
        email: db.user.email,
        name: db.user.name,
        role: 'owner' as const,
        userId: db.user.id,
        workspaceId,
      },
      ...mockWorkspaceMembers.filter(
        (member) => member.workspaceId === workspaceId
      ),
    ]);
  }),
  http.post('/api/workspaces/:id/invites', async ({ params, request }) => {
    const body = (await request.json()) as {
      identifier: string;
      role: Exclude<WorkspaceMember['role'], 'owner'>;
    };
    const identifier = body.identifier.trim().toLowerCase();
    const matches = mockInviteCandidates.filter(
      (item) =>
        item.id === body.identifier.trim() ||
        item.email.toLowerCase() === identifier
    );
    const candidate = matches.length === 1 ? matches[0] : undefined;
    const workspaceId = String(params.id);
    const alreadyMember = candidate
      ? mockWorkspaceMembers.some(
          (member) =>
            member.workspaceId === workspaceId && member.userId === candidate.id
        )
      : false;
    if (!candidate || alreadyMember)
      return new HttpResponse(null, { status: 202 });

    const now = new Date();
    let invite = mockWorkspaceInvites.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.invitedUserId === candidate.id &&
        !item.acceptedAt
    );
    if (invite) {
      invite.role = body.role;
      invite.token = uid('invite-token');
      invite.expiresAt = new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString();
    } else {
      invite = {
        email: candidate.email,
        expiresAt: new Date(
          now.getTime() + 7 * 24 * 60 * 60 * 1000
        ).toISOString(),
        id: uid('invite'),
        invitedUserId: candidate.id,
        role: body.role,
        token: uid('invite-token'),
        workspaceId,
      };
      mockWorkspaceInvites.push(invite);
    }
    const href = `/workspace-invites/${invite.token}`;
    const existingNotification = db.notifications.find((notification) =>
      notification.href?.startsWith('/workspace-invites/')
    );
    if (existingNotification) {
      Object.assign(existingNotification, {
        at: now.toISOString(),
        body: 'You’ve been invited to join this workspace.',
        href,
        read: false,
      });
    } else {
      db.notifications.unshift({
        at: now.toISOString(),
        body: 'You’ve been invited to join this workspace.',
        href,
        id: uid('notification'),
        kind: 'workspace_invite',
        read: false,
        title: 'Workspace invitation',
      });
    }
    return new HttpResponse(null, { status: 202 });
  }),
  http.patch(
    '/api/workspaces/:id/members/:memberId',
    async ({ params, request }) => {
      const member = mockWorkspaceMembers.find(
        (item) =>
          item.workspaceId === params.id && item.userId === params.memberId
      );
      if (!member) return new HttpResponse(null, { status: 404 });
      const body = (await request.json()) as { role: WorkspaceMember['role'] };
      member.role = body.role;
      return new HttpResponse(null, { status: 204 });
    }
  ),
  http.delete('/api/workspaces/:id/members/:memberId', async ({ params }) => {
    const index = mockWorkspaceMembers.findIndex(
      (item) =>
        item.workspaceId === params.id && item.userId === params.memberId
    );
    if (index < 0) return new HttpResponse(null, { status: 404 });
    mockWorkspaceMembers.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/workspace-invites/:token/accept', async ({ params }) => {
    const invite = mockWorkspaceInvites.find(
      (item) => item.token === params.token && !item.acceptedAt
    );
    if (!invite) return new HttpResponse(null, { status: 404 });
    invite.acceptedAt = new Date().toISOString();
    const candidate = mockInviteCandidates.find(
      (item) => item.id === invite.invitedUserId
    );
    const member: WorkspaceMember = {
      avatarUrl: candidate?.avatarUrl,
      createdAt: invite.acceptedAt,
      email: invite.email,
      name: candidate?.name ?? invite.email,
      role: invite.role,
      userId: invite.invitedUserId,
      workspaceId: invite.workspaceId,
    };
    mockWorkspaceMembers.push(member);
    const notificationIndex = db.notifications.findIndex(
      (notification) =>
        notification.href === `/workspace-invites/${invite.token}`
    );
    if (notificationIndex >= 0) db.notifications.splice(notificationIndex, 1);
    return HttpResponse.json(member);
  }),
  http.delete('/api/workspaces/:id', async ({ params }) => {
    const i = db.workspaces.findIndex((w) => w.id === params.id);
    if (i >= 0) db.workspaces.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/workspaces/:id/clone', async ({ params }) => {
    await latency();
    const source =
      db.workspaces.find((w) => w.id === params.id) ??
      db.publicWorkspaces.find((w) => w.id === params.id);
    if (!source) return new HttpResponse(null, { status: 404 });
    const newId = uid('ws');
    const workspace: Workspace = {
      ...source,
      createdAt: new Date().toISOString(),
      id: newId,
      isOwner: true,
      lastAccessedAt: new Date().toISOString(),
      name: `${source.name} (copy)`,
      privacy: 'private',
    };
    db.workspaces.unshift(workspace);

    const chapterMap = new Map<string, string>();
    db.chapters
      .filter((chapter) => chapter.workspaceId === source.id)
      .forEach((chapter) => {
        const id = uid('ch');
        chapterMap.set(chapter.id, id);
        db.chapters.push({ ...chapter, fileIds: [], id, workspaceId: newId });
      });
    const fileMap = new Map<string, string>();
    db.files
      .filter((file) => file.workspaceId === source.id)
      .forEach((file) => {
        const id = uid('f');
        fileMap.set(file.id, id);
        db.files.push({
          ...file,
          chapterId: file.chapterId
            ? (chapterMap.get(file.chapterId) ?? null)
            : null,
          id,
          workspaceId: newId,
        });
      });
    db.materials
      .filter((material) => material.workspaceId === source.id)
      .forEach((material) => {
        db.materials.push({
          ...material,
          chapterId: material.chapterId
            ? (chapterMap.get(material.chapterId) ?? null)
            : null,
          createdAt: new Date().toISOString(),
          id: uid('mat'),
          privacy: 'private',
          scopeFileIds: material.scopeFileIds
            .map((id) => fileMap.get(id))
            .filter((id): id is string => !!id),
          workspaceId: newId,
          workspaceName: workspace.name,
        });
      });
    return HttpResponse.json({ ragCloned: true, workspace }, { status: 201 });
  }),

  /* ---------------- chapters & files ---------------- */
  http.get('/api/workspaces/:id/chapters', async ({ params }) => {
    await latency();
    return HttpResponse.json(
      db.chapters
        .filter((c) => c.workspaceId === params.id)
        .sort((a, b) => a.order - b.order)
    );
  }),
  http.post('/api/workspaces/:id/chapters', async ({ params, request }) => {
    const body = (await request.json()) as { name: string };
    const order = db.chapters.filter((c) => c.workspaceId === params.id).length;
    const ch: Chapter = {
      fileIds: [],
      id: uid('ch'),
      name: body.name,
      order,
      workspaceId: String(params.id),
    };
    db.chapters.push(ch);
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (ws) ws.chapterCount += 1;
    return HttpResponse.json(ch, { status: 201 });
  }),
  http.patch('/api/chapters/:id', async ({ params, request }) => {
    const ch = db.chapters.find((c) => c.id === params.id);
    if (!ch) return new HttpResponse(null, { status: 404 });
    Object.assign(ch, await request.json());
    return HttpResponse.json(ch);
  }),
  http.post('/api/workspaces/:id/chapters/reorder', async ({ request }) => {
    const body = (await request.json()) as { ids: string[] };
    body.ids.forEach((id, idx) => {
      const ch = db.chapters.find((c) => c.id === id);
      if (ch) ch.order = idx;
    });
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(
    '/api/workspaces/:id/content/reorder',
    async ({ params, request }) => {
      const body = (await request.json()) as {
        chapterId: string | null;
        items: { id: string; type: 'file' | 'material' }[];
      };
      body.items.forEach((item, position) => {
        if (item.type === 'file') {
          db.chapters.forEach((chapter) => {
            chapter.fileIds = chapter.fileIds.filter((id) => id !== item.id);
          });
          if (body.chapterId) {
            db.chapters
              .find((chapter) => chapter.id === body.chapterId)
              ?.fileIds.push(item.id);
          }
        }
        const content =
          item.type === 'file'
            ? db.files.find(
                (file) => file.id === item.id && file.workspaceId === params.id
              )
            : db.materials.find(
                (material) =>
                  material.id === item.id && material.workspaceId === params.id
              );
        if (content) {
          content.chapterId = body.chapterId;
          content.position = position;
        }
      });
      return new HttpResponse(null, { status: 204 });
    }
  ),
  http.delete('/api/chapters/:id', async ({ params }) => {
    const i = db.chapters.findIndex((c) => c.id === params.id);
    if (i >= 0) {
      // keep files — just unfile them
      db.files.forEach((f) => {
        if (f.chapterId === params.id) f.chapterId = null;
      });
      db.materials.forEach((material) => {
        if (material.chapterId === params.id) material.chapterId = null;
      });
      db.chapters.splice(i, 1);
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/files', async () => {
    await latency();
    return HttpResponse.json(db.files);
  }),
  http.get('/api/workspaces/:id/files', async ({ params }) => {
    await latency();
    return HttpResponse.json(
      db.files.filter((f) => f.workspaceId === params.id)
    );
  }),
  http.get('/api/files/:id', async ({ params }) => {
    await latency();
    const f = db.files.find((x) => x.id === params.id);
    return f ? HttpResponse.json(f) : new HttpResponse(null, { status: 404 });
  }),
  http.patch('/api/files/:id', async ({ params, request }) => {
    const f = db.files.find((x) => x.id === params.id);
    if (!f) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<
      Pick<SourceFile, 'name' | 'chapterId'>
    >;
    if (body.name !== undefined) f.name = body.name;
    if (body.chapterId !== undefined) {
      // Empty-string sentinel unfiles (mirrors the Go gateway).
      const next = body.chapterId === '' ? null : body.chapterId;
      for (const c of db.chapters)
        c.fileIds = c.fileIds.filter((id) => id !== f.id);
      f.chapterId = next;
      if (next) db.chapters.find((c) => c.id === next)?.fileIds.push(f.id);
    }
    return HttpResponse.json(f);
  }),
  http.delete('/api/files/:id', async ({ params }) => {
    const i = db.files.findIndex((x) => x.id === params.id);
    if (i >= 0) {
      const [removed] = db.files.splice(i, 1);
      const ws = db.workspaces.find((w) => w.id === removed.workspaceId);
      if (ws) ws.fileCount = Math.max(0, ws.fileCount - 1);
      for (const ch of db.chapters)
        ch.fileIds = ch.fileIds.filter((id) => id !== removed.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- study materials ---------------- */
  http.get('/api/workspaces/:id/materials', async ({ params }) => {
    await latency();
    const wsId = String(params.id);
    const refs: MaterialRef[] = db.materials
      .filter((mt) => mt.workspaceId === wsId)
      .map((mt) => ({
        chapterId: mt.chapterId ?? null,
        createdAt: mt.createdAt,
        hasPendingSuggestions: mt.hasPendingSuggestions ?? false,
        id: mt.id,
        position: mt.position ?? 0,
        title: mt.title,
        type: refType(mt.kind),
      }))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return HttpResponse.json(refs);
  }),
  http.post('/api/workspaces/:id/materials', async ({ params, request }) => {
    await latency();
    const wsId = String(params.id);
    const ws = db.workspaces.find((w) => w.id === wsId);
    const body = (await request.json().catch(() => ({}))) as {
      kind?: Material['kind'];
      title?: string;
      content?: Material['content'];
      scopeChapters?: string[];
      scopeFileIds?: string[];
    };
    const mt: Material = {
      ...ownerMaterialAccess,
      chapterId: null,
      content: body.content ?? emptyMaterialDocument(),
      createdAt: new Date().toISOString(),
      id: uid('mat'),
      kind: body.kind ?? 'note',
      privacy: 'private',
      revision: 1,
      scopeChapters: body.scopeChapters ?? [],
      scopeFileIds: body.scopeFileIds ?? [],
      title: body.title || 'Untitled note',
      workspaceId: wsId,
      workspaceName: ws?.name ?? '',
    };
    db.refreshMaterialContentBytes(mt);
    db.materials.unshift(mt);
    return HttpResponse.json(mt, { status: 201 });
  }),
  http.get('/api/materials/:id', async ({ params }) => {
    await hydrateEditorState(String(params.id));
    await latency();
    const mt = db.materials.find((x) => x.id === params.id);
    return mt ? HttpResponse.json(mt) : new HttpResponse(null, { status: 404 });
  }),
  http.patch('/api/materials/:id', async ({ params, request }) => {
    await latency();
    const mt = db.materials.find((x) => x.id === params.id);
    if (!mt) return new HttpResponse(null, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      content?: Material['content'];
      expectedRevision?: number;
      chapterId?: string;
      scopeChapters?: string[];
      scopeFileIds?: string[];
    };
    if (
      (body.title != null || body.content != null) &&
      body.expectedRevision != null &&
      body.expectedRevision !== (mt.revision ?? 1)
    ) {
      return HttpResponse.json(
        { message: 'material revision is stale' },
        { status: 409 }
      );
    }
    if (body.title != null) mt.title = body.title;
    if (body.content != null) {
      mt.content = createMaterialDocument(body.content.value);
      mt.hasPendingSuggestions = scanSuggestions(mt.content.value).length > 0;
      db.refreshMaterialContentBytes(mt);
    }
    if (body.title != null || body.content != null)
      mt.revision = (mt.revision ?? 1) + 1;
    // Empty-string sentinel unfiles; a real id files it; omitted leaves it.
    if (body.chapterId != null)
      mt.chapterId = body.chapterId === '' ? null : body.chapterId;
    if (body.scopeChapters != null) mt.scopeChapters = body.scopeChapters;
    if (body.scopeFileIds != null) mt.scopeFileIds = body.scopeFileIds;
    mt.updatedAt = new Date().toISOString();
    await persistEditorState(mt.id);
    return HttpResponse.json({
      contentBytes: mt.contentBytes,
      id: mt.id,
      revision: mt.revision,
      updatedAt: mt.updatedAt,
    });
  }),
  http.delete('/api/materials/:id', async ({ params }) => {
    const i = db.materials.findIndex((x) => x.id === params.id);
    if (i >= 0) db.materials.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/materials/:id/discussions', async ({ params }) => {
    await hydrateEditorState(String(params.id));
    return HttpResponse.json(
      mockDiscussions.filter((item) => item.materialId === params.id)
    );
  }),
  http.post('/api/materials/:id/discussions', async ({ params, request }) => {
    const body = (await request.json()) as {
      blockId?: string;
      anchor?: Record<string, unknown>;
      contentRich: MaterialDiscussion['comments'][number]['contentRich'];
    };
    const now = new Date().toISOString();
    const discussion: MaterialDiscussion = {
      anchor: body.anchor ?? {},
      blockId: body.blockId,
      comments: [
        {
          contentRich: body.contentRich,
          createdAt: now,
          discussionId: '',
          id: uid('comment'),
          isDeleted: false,
          isEdited: false,
          replies: [],
          updatedAt: now,
          userId: db.user.id,
        },
      ],
      createdAt: now,
      id: uid('discussion'),
      isDeleted: false,
      isResolved: false,
      kind: 'comment',
      materialId: String(params.id),
      suggestions: [],
      updatedAt: now,
      userId: db.user.id,
    };
    discussion.comments[0].discussionId = discussion.id;
    mockDiscussions.unshift(discussion);
    await persistEditorState(discussion.materialId);
    return HttpResponse.json(discussion, { status: 201 });
  }),
  http.post('/api/discussions/:id/comments', async ({ params, request }) => {
    const discussion = mockDiscussions.find((item) => item.id === params.id);
    if (!discussion) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as {
      contentRich: MaterialDiscussion['comments'][number]['contentRich'];
      parentCommentId?: string;
    };
    const now = new Date().toISOString();
    const comment: MaterialDiscussion['comments'][number] = {
      contentRich: body.contentRich,
      createdAt: now,
      discussionId: discussion.id,
      id: uid('comment'),
      isDeleted: false,
      isEdited: false,
      parentCommentId: body.parentCommentId,
      replies: [],
      updatedAt: now,
      userId: db.user.id,
    };
    const parent = body.parentCommentId
      ? discussion.comments.find((entry) => entry.id === body.parentCommentId)
      : undefined;
    if (parent) parent.replies.push(comment);
    else discussion.comments.push(comment);
    discussion.updatedAt = now;
    await persistEditorState(discussion.materialId);
    return HttpResponse.json(comment, { status: 201 });
  }),
  http.patch('/api/discussions/:id', async ({ params, request }) => {
    const discussion = mockDiscussions.find((item) => item.id === params.id);
    if (!discussion) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as { isResolved: boolean };
    discussion.isResolved = body.isResolved;
    discussion.updatedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete('/api/discussions/:id', async ({ params, request }) => {
    const discussion = mockDiscussions.find((item) => item.id === params.id);
    const material = db.materials.find(
      (item) => item.id === discussion?.materialId
    );
    if (!discussion || !material)
      return new HttpResponse(null, { status: 404 });
    const pendingIds = discussion.suggestions
      .filter((item) => item.status === 'pending')
      .map((item) => item.plateSuggestionId);
    if (pendingIds.length) {
      const expected = Number(
        new URL(request.url).searchParams.get('expectedRevision')
      );
      if (expected !== (material.revision ?? 1)) {
        return HttpResponse.json(
          { message: 'material revision is stale' },
          { status: 409 }
        );
      }
      const resolved = resolveSuggestions(
        material.content.value,
        'reject',
        pendingIds
      );
      material.content = createMaterialDocument(resolved.value);
      material.revision = (material.revision ?? 1) + 1;
      material.hasPendingSuggestions = resolved.hasPendingSuggestions;
      for (const suggestion of discussion.suggestions) {
        if (suggestion.status === 'pending') suggestion.status = 'rejected';
      }
      db.refreshMaterialContentBytes(material);
    }
    discussion.isDeleted = true;
    await persistEditorState(material.id);
    return HttpResponse.json(
      mockSuggestionResult(
        material,
        discussion.suggestions.map((item) => item.id)
      )
    );
  }),
  http.patch('/api/comments/:id', async ({ params, request }) => {
    const body = (await request.json()) as {
      contentRich: MaterialDiscussion['comments'][number]['contentRich'];
    };
    for (const discussion of mockDiscussions) {
      const entries = discussion.comments.flatMap((entry) => [
        entry,
        ...entry.replies,
      ]);
      const comment = entries.find((entry) => entry.id === params.id);
      if (!comment) continue;
      comment.contentRich = body.contentRich;
      comment.isEdited = true;
      comment.updatedAt = new Date().toISOString();
      return HttpResponse.json(comment);
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.delete('/api/comments/:id', async ({ params }) => {
    for (const discussion of mockDiscussions) {
      const entry = discussion.comments
        .flatMap((comment) => [comment, ...comment.replies])
        .find((comment) => comment.id === params.id);
      if (!entry) continue;
      entry.isDeleted = true;
      entry.contentRich = null;
      return new HttpResponse(null, { status: 204 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.post(
    '/api/materials/:id/suggestion-commits',
    async ({ params, request }) => {
      const material = db.materials.find((item) => item.id === params.id);
      if (!material) return new HttpResponse(null, { status: 404 });
      const body = (await request.json()) as {
        content: Material['content'];
        expectedRevision: number;
      };
      if (body.expectedRevision !== (material.revision ?? 1)) {
        return HttpResponse.json(
          { message: 'material revision is stale' },
          { status: 409 }
        );
      }
      const topLevelIds = new Set<string>();
      const hasInvalidBlockId = body.content.value.some((block) => {
        const id =
          typeof block.id === 'string' && block.id.trim() ? block.id : null;
        if (!id || topLevelIds.has(id)) return true;
        topLevelIds.add(id);
        return false;
      });
      const changes = scanSuggestions(body.content.value);
      if (hasInvalidBlockId || changes.length === 0) {
        return HttpResponse.json(
          { message: 'suggestion commit requires stable block IDs' },
          { status: 400 }
        );
      }
      const now = new Date().toISOString();
      const nextRevision = (material.revision ?? 1) + 1;
      const committedIds = new Set<string>();
      for (const change of changes) {
        committedIds.add(change.plateSuggestionId);
        const existingDiscussion = mockDiscussions.find(
          (entry) =>
            entry.materialId === material.id &&
            entry.blockId === change.blockId &&
            entry.kind === 'suggestion' &&
            entry.suggestions.some(
              (suggestion) =>
                suggestion.plateSuggestionId === change.plateSuggestionId &&
                suggestion.status === 'pending'
            )
        );
        const existingSuggestion = existingDiscussion?.suggestions.find(
          (entry) =>
            entry.plateSuggestionId === change.plateSuggestionId &&
            entry.status === 'pending'
        );
        if (existingSuggestion) {
          existingSuggestion.commitRevision = nextRevision;
          existingSuggestion.updatedAt = now;
          continue;
        }
        const discussion: MaterialDiscussion = {
          anchor: { blockId: change.blockId },
          blockId: change.blockId,
          comments: [],
          createdAt: now,
          id: uid('discussion'),
          isDeleted: false,
          isResolved: false,
          kind: 'suggestion',
          materialId: material.id,
          suggestions: [],
          updatedAt: now,
          userId: db.user.id,
        };
        const suggestion: MaterialSuggestion = {
          commitRevision: nextRevision,
          createdAt: now,
          discussionId: discussion.id,
          id: uid('suggestion'),
          isDeleted: false,
          plateSuggestionId: change.plateSuggestionId,
          status: 'pending',
          updatedAt: now,
          userId: db.user.id,
        };
        discussion.suggestions.push(suggestion);
        mockDiscussions.unshift(discussion);
        mockSuggestions.unshift(suggestion);
      }
      material.content = createMaterialDocument(body.content.value);
      material.revision = nextRevision;
      material.hasPendingSuggestions =
        scanSuggestions(body.content.value).length > 0;
      material.updatedAt = now;
      db.refreshMaterialContentBytes(material);
      await persistEditorState(material.id);
      return HttpResponse.json(
        mockSuggestionResult(material, [...committedIds].sort()),
        {
          status: 201,
        }
      );
    }
  ),
  http.post(
    '/api/materials/:id/suggestions/review',
    async ({ params, request }) => {
      const material = db.materials.find((item) => item.id === params.id);
      if (!material) return new HttpResponse(null, { status: 404 });
      const body = (await request.json()) as {
        decision: 'accept' | 'reject';
        suggestionIds?: string[];
        expectedRevision: number;
      };
      if (body.expectedRevision !== (material.revision ?? 1)) {
        return HttpResponse.json(
          { message: 'material revision is stale' },
          { status: 409 }
        );
      }
      const resolved = resolveSuggestions(
        material.content.value,
        body.decision,
        body.suggestionIds
      );
      const now = new Date().toISOString();
      material.content = createMaterialDocument(resolved.value);
      material.revision = (material.revision ?? 1) + 1;
      material.hasPendingSuggestions = resolved.hasPendingSuggestions;
      material.updatedAt = now;
      db.refreshMaterialContentBytes(material);
      const ids: string[] = [];
      for (const suggestion of mockSuggestions) {
        if (
          !resolved.resolvedIds.includes(suggestion.plateSuggestionId) ||
          suggestion.status !== 'pending'
        )
          continue;
        suggestion.status =
          body.decision === 'accept' ? 'accepted' : 'rejected';
        suggestion.reviewedBy = db.user.id;
        suggestion.reviewedAt = now;
        suggestion.updatedAt = now;
        suggestion.resolutionRevision = material.revision;
        ids.push(suggestion.plateSuggestionId);
      }
      await persistEditorState(material.id);
      return HttpResponse.json(mockSuggestionResult(material, ids));
    }
  ),
  http.delete('/api/material-suggestions/:id', async ({ params, request }) => {
    const suggestion = mockSuggestions.find((item) => item.id === params.id);
    const discussion = mockDiscussions.find(
      (item) => item.id === suggestion?.discussionId
    );
    const material = db.materials.find(
      (item) => item.id === discussion?.materialId
    );
    if (!suggestion || !material)
      return new HttpResponse(null, { status: 404 });
    const expected = Number(
      new URL(request.url).searchParams.get('expectedRevision')
    );
    if (expected !== (material.revision ?? 1)) {
      return HttpResponse.json(
        { message: 'material revision is stale' },
        { status: 409 }
      );
    }
    const resolved = resolveSuggestions(material.content.value, 'reject', [
      suggestion.plateSuggestionId,
    ]);
    material.content = createMaterialDocument(resolved.value);
    material.revision = (material.revision ?? 1) + 1;
    material.hasPendingSuggestions = resolved.hasPendingSuggestions;
    suggestion.status = 'withdrawn';
    suggestion.isDeleted = true;
    await persistEditorState(material.id);
    return HttpResponse.json(mockSuggestionResult(material, [suggestion.id]));
  }),
  http.get('/api/source-upload-policy', async () => {
    await latency();
    return HttpResponse.json(sourceUploadPolicy);
  }),
  http.post('/api/workspaces/:id/sources', async ({ params, request }) => {
    await delay(500);
    // Real uploads are multipart (file bytes); fall back to JSON for any
    // legacy/metadata-only callers.
    let name = '';
    let kind: SourceKindFix = 'pdf';
    let chapterId: string | null = null;
    let chapterName: string | null = null;
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      name = String(
        form.get('name') ||
          (file instanceof File ? file.name : '') ||
          'Untitled'
      );
      kind = (String(form.get('kind') || '') ||
        getFileKind(name, sourceUploadPolicy)) as SourceKindFix;
      chapterId = (form.get('chapterId') as string) || null;
      chapterName = (form.get('chapterName') as string) || null;
    } else {
      const body = (await request.json()) as {
        name: string;
        kind: SourceKindFix;
        chapterId?: string | null;
        chapterName?: string | null;
      };
      name = body.name;
      kind = body.kind ?? getFileKind(name, sourceUploadPolicy);
      chapterId = body.chapterId ?? null;
      chapterName = body.chapterName ?? null;
    }
    const expectedKind = getFileKind(name, sourceUploadPolicy);
    if (chapterId && chapterName?.trim()) {
      return HttpResponse.json(
        { message: 'chapterId and chapterName cannot both be set' },
        { status: 400 }
      );
    }
    if (expectedKind === 'unknown' || kind !== expectedKind) {
      return HttpResponse.json(
        { message: 'unsupported source file type' },
        { status: 400 }
      );
    }
    if (!chapterId && chapterName?.trim()) {
      const normalizedName = chapterName.trim().toLowerCase();
      const existing = db.chapters.find(
        (chapter) =>
          chapter.workspaceId === params.id &&
          chapter.name.trim().toLowerCase() === normalizedName
      );
      if (existing) {
        chapterId = existing.id;
      } else {
        const order = db.chapters.filter(
          (chapter) => chapter.workspaceId === params.id
        ).length;
        const chapter: Chapter = {
          fileIds: [],
          id: uid('ch'),
          name: chapterName.trim(),
          order,
          workspaceId: String(params.id),
        };
        db.chapters.push(chapter);
        const ws = db.workspaces.find(
          (workspace) => workspace.id === params.id
        );
        if (ws) ws.chapterCount += 1;
        chapterId = chapter.id;
      }
    }
    const f: (typeof db.files)[number] = {
      addedAt: new Date().toISOString(),
      chapterId,
      id: uid('f'),
      kind,
      name,
      sizeKb: Math.round(200 + Math.random() * 3000),
      // Mirror the real backend: uploads start 'processing' and the client
      // animates progress (useUploadSource) before flipping to 'ready'.
      status: 'processing',
      workspaceId: String(params.id),
    };
    db.files.push(f);
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (ws) ws.fileCount += 1;
    if (f.chapterId)
      db.chapters.find((c) => c.id === f.chapterId)?.fileIds.push(f.id);
    // Eventually mark ready so later refetches reflect a finished ingest.
    setTimeout(() => {
      f.status = 'ready';
    }, 2600);
    return HttpResponse.json(f, { status: 201 });
  }),

  /* ---------------- chat & generate ---------------- */
  http.post('/api/workspaces/:id/chat', async ({ request }) => {
    await delay(700);
    const body = (await request.json()) as { text: string };
    const sources = db.files.slice(0, 2);
    return HttpResponse.json({
      citations: sources.map((f) => ({
        fileId: f.id,
        fileName: f.name,
        snippet: 'Relevant passage from your source…',
      })),
      id: uid('m'),
      role: 'assistant',
      text: `Based on your sources, ${body.text.replace(/\?$/, '')} relates to the key ideas in your materials. In short: the cell membrane regulates transport, and energy is produced in the mitochondria.`,
    });
  }),

  /* ---------------- conversations ---------------- */
  http.get('/api/workspaces/:id/conversations', async ({ params }) => {
    await latency();
    const list = db.conversations
      .filter((c) => c.workspaceId === params.id)
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
    return HttpResponse.json(list);
  }),
  http.post(
    '/api/workspaces/:id/conversations',
    async ({ params, request }) => {
      await latency();
      const body = (await request.json().catch(() => ({}))) as {
        title?: string;
      };
      const now = new Date().toISOString();
      const conv = {
        createdAt: now,
        id: uid('conv'),
        title: body.title ?? '',
        updatedAt: now,
        workspaceId: params.id as string,
      };
      db.conversations.push(conv);
      return HttpResponse.json(conv, { status: 201 });
    }
  ),
  http.get('/api/conversations/:id/messages', async ({ params }) => {
    await latency();
    const list = db.chatMessages.filter(
      (msg) => msg.conversationId === params.id && msg.status !== 'streaming'
    );
    return HttpResponse.json(list);
  }),
  http.delete('/api/conversations/:id', async ({ params }) => {
    await latency();
    const i = db.conversations.findIndex((c) => c.id === params.id);
    if (i >= 0) db.conversations.splice(i, 1);
    for (let j = db.chatMessages.length - 1; j >= 0; j--) {
      if (db.chatMessages[j].conversationId === params.id)
        db.chatMessages.splice(j, 1);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- chat streaming (SSE) ----------------
     Mirrors the Go gateway: persists the user turn, streams the answer
     token-by-token as `data: {type,...}` events, then saves the assistant
     turn. Honors the client AbortController so Stop works in dev. */
  http.post('/api/workspaces/:id/chat/stream', async ({ params, request }) => {
    const body = (await request.json()) as {
      conversationId?: string;
      text: string;
    };
    const now = new Date().toISOString();

    let conv = body.conversationId
      ? db.conversations.find((c) => c.id === body.conversationId)
      : undefined;
    if (!conv) {
      conv = {
        createdAt: now,
        id: uid('conv'),
        title: '',
        updatedAt: now,
        workspaceId: params.id as string,
      };
      db.conversations.push(conv);
    }
    if (!conv.title) conv.title = body.text.slice(0, 60);
    db.chatMessages.push({
      citations: null,
      content: body.text,
      conversationId: conv.id,
      createdAt: now,
      id: uid('m'),
      role: 'user',
      status: 'complete',
    });

    const convId = conv.id;
    const assistantId = uid('m');
    const citations = db.files.slice(0, 2).map((f) => ({
      fileId: f.id,
      fileName: f.name,
      snippet: 'Relevant passage from your source…',
    }));
    const answer =
      `Based on your sources, **${body.text.replace(/\?$/, '')}** connects to the key ideas in your materials.\n\n` +
      '- The cell membrane regulates transport\n' +
      '- Energy is produced in the **mitochondria**\n' +
      '- Genetic information lives in the nucleus';
    const words = answer.split(' ');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        send({ conversationId: convId, messageId: assistantId, type: 'start' });
        await delay(120);
        send({ citations, type: 'citations' });
        let acc = '';
        for (const w of words) {
          if (request.signal.aborted) break;
          await delay(35);
          acc += w + ' ';
          send({ text: w + ' ', type: 'token' });
        }
        const aborted = request.signal.aborted;
        db.chatMessages.push({
          citations,
          content: acc.trim(),
          conversationId: convId,
          createdAt: new Date().toISOString(),
          id: assistantId,
          role: 'assistant',
          status: aborted ? 'aborted' : 'complete',
        });
        conv!.updatedAt = new Date().toISOString();
        if (!aborted)
          send({ status: 'complete', tokenCount: words.length, type: 'done' });
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      },
    });
  }),

  http.post('/api/workspaces/:id/complete/stream', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      mode?: 'command' | 'continue';
      prompt?: string;
    };
    const text =
      body.mode === 'continue'
        ? ' and this continues the thought with a few more grounded sentences drawn from your notes.'
        : `Here is an AI response${body.prompt ? ` to "${body.prompt}"` : ''}: the key ideas are summarized clearly and concisely for study.`;
    const words = text.split(' ');
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        for (const w of words) {
          if (request.signal.aborted) break;
          await delay(40);
          send({ text: w + ' ', type: 'token' });
        }
        if (!request.signal.aborted) send({ type: 'done' });
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      },
    });
  }),

  /* Plate/@ai-sdk UI-message stream. This mirrors the production protocol so
     editor integration can be developed under MSW without provider calls. */
  http.post('/api/workspaces/:id/ai/command', async ({ request }) => {
    const body = (await request.json()) as {
      messages?: Array<{
        role: string;
        parts?: Array<{ type: string; text?: string }>;
      }>;
      ctx?: {
        children?: Array<{ id?: string; children?: unknown[] }>;
        toolName?: 'generate' | 'edit' | 'comment';
      };
    };
    const instruction =
      [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')
        ?.parts?.filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('') ?? '';
    const toolName =
      body.ctx?.toolName ??
      (/\b(comment|feedback|review|annotat)/i.test(instruction)
        ? 'comment'
        : 'generate');
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) =>
          controller.enqueue(
            encoder.encode(
              `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`
            )
          );
        send({ type: 'start' });
        send({ type: 'start-step' });
        send({ data: toolName, type: 'data-toolName' });

        if (toolName === 'comment') {
          const block = body.ctx?.children?.[0];
          const content = mockNodeText(block).trim();
          if (block?.id && content) {
            await delay(40);
            send({
              data: {
                comment: {
                  blockId: block.id,
                  comment: 'Consider making this point more specific.',
                  content,
                },
                status: 'streaming',
              },
              id: uid('ai'),
              type: 'data-comment',
            });
          }
          send({
            data: { comment: null, status: 'finished' },
            id: uid('ai'),
            type: 'data-comment',
          });
        } else {
          const text =
            toolName === 'edit'
              ? 'This revised passage is clearer and more concise.'
              : `A concise response to: ${instruction || 'your request'}.`;
          const textId = uid('ai');
          send({ id: textId, type: 'text-start' });
          for (const word of text.split(' ')) {
            if (request.signal.aborted) {
              controller.close();
              return;
            }
            await delay(25);
            send({ delta: `${word} `, id: textId, type: 'text-delta' });
          }
          send({ id: textId, type: 'text-end' });
        }
        send({ type: 'finish-step' });
        send({ finishReason: 'stop', type: 'finish' });
        send('[DONE]');
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    });
  }),

  http.post('/api/workspaces/:id/ai/copilot', async ({ request }) => {
    const body = (await request.json()) as { prompt?: string };
    if (request.signal.aborted) return HttpResponse.json(null, { status: 408 });
    await delay(80);
    return HttpResponse.json({
      finishReason: 'stop',
      text: body.prompt?.trim() ? ' with a natural continuation.' : '0',
      usage: { completionTokens: 5, promptTokens: 8 },
    });
  }),

  http.post('/api/transcribe', async () => {
    await delay(600);
    return HttpResponse.json({ text: 'This is a mock voice transcription.' });
  }),

  http.post('/api/workspaces/:id/generate', async ({ params, request }) => {
    await delay(900);
    const opts = (await request.json()) as GenerateOptions;
    const wsId = String(params.id);
    const wsName =
      db.workspaces.find((w) => w.id === wsId)?.name ?? 'Workspace';
    // Chapters arrive as ids; resolve to names for display + storage parity
    // with the Go backend.
    const scopeChapterNames = opts.chapters
      .map((cid) => db.chapters.find((c) => c.id === cid)?.name)
      .filter(Boolean) as string[];
    // Human-readable scope, for material titles / bodies.
    const scopeFileNames = ('fileIds' in opts ? opts.fileIds : [])
      .map((fid) => db.files.find((f) => f.id === fid)?.name)
      .filter(Boolean) as string[];
    const scopeLabel =
      scopeChapterNames.length || scopeFileNames.length
        ? [...scopeChapterNames, ...scopeFileNames].join(', ')
        : 'the whole workspace';

    if (opts.kind === 'flashcards') {
      // Persist a flashcards markdown material; per-card FSRS lives in cardStats.
      const id = uid('dk');
      const name = `${wsName} flashcards`;
      const cardContents = Array.from({ length: opts.count }, (_, i) => ({
        back: `Definition for term ${i + 1}.`,
        front: `Term ${i + 1}`,
        id: uid('c'),
      }));
      const material: Material = {
        ...ownerMaterialAccess,
        chapterId: null,
        color: 'green',
        content: flashcardsDocument(cardContents, id),
        createdAt: new Date().toISOString(),
        id,
        kind: 'flashcards',
        privacy: 'private',
        scopeChapters: scopeChapterNames,
        scopeFileIds: opts.fileIds,
        title: name,
        workspaceId: wsId,
        workspaceName: wsName,
      };
      db.refreshMaterialContentBytes(material);
      db.materials.unshift(material);
      for (const c of cardContents)
        db.cardStats[c.id] = {
          known: false,
          materialId: id,
          srs: newSrsState(),
        };
      return HttpResponse.json({
        cards: db.cardsFromMaterial(material),
        deck: db.deckFromMaterial(material),
        kind: 'flashcards',
      });
    }

    if (opts.kind === 'mindmap' || opts.kind === 'diagram') {
      const material: Material = {
        ...ownerMaterialAccess,
        chapterId: null,
        content: createMaterialDocument([
          { children: [{ text: `${wsName} ${opts.kind}` }], type: 'h1' },
          { children: [{ text: `Generated from ${scopeLabel}.` }], type: 'p' },
          mermaidNode(
            opts.kind === 'mindmap'
              ? 'mindmap\n  root((Topic))\n    Key idea A\n      Detail 1\n      Detail 2\n    Key idea B\n      Detail 3'
              : 'flowchart LR\n  A[Start] --> B[Process]\n  B --> C{Decision}\n  C -->|Yes| D[Outcome 1]\n  C -->|No| E[Outcome 2]'
          ),
        ]),
        createdAt: new Date().toISOString(),
        id: uid('mat'),
        kind: opts.kind,
        privacy: 'private',
        scopeChapters: scopeChapterNames,
        scopeFileIds: opts.fileIds,
        title: `${wsName} ${opts.kind}`,
        workspaceId: wsId,
        workspaceName: wsName,
      };
      db.refreshMaterialContentBytes(material);
      db.materials.unshift(material);
      return HttpResponse.json({ kind: opts.kind, material });
    }

    // quiz
    const qs: Question[] = Array.from({ length: opts.count }, (_, i) => {
      const type = opts.types[i % opts.types.length] ?? 'mcq';
      const level = opts.levels[i % opts.levels.length] ?? 'application';
      const base = {
        id: uid('q'),
        level,
        prompt: `Generated ${type} question ${i + 1}?`,
      };
      switch (type) {
        case 'boolean':
          return {
            ...base,
            correct: true,
            explanation: 'This statement is true based on your sources.',
            type: 'boolean',
          } as Question;
        case 'fill':
        case 'short':
          return {
            ...base,
            accepted: [{ value: 'answer' }],
            explanation:
              'The accepted answer follows from the source material.',
            type,
          } as Question;
        case 'ordering':
          return {
            ...base,
            items: [
              { value: 'First' },
              { value: 'Second' },
              { value: 'Third' },
            ],
            type: 'ordering',
          } as Question;
        case 'matching':
          return {
            ...base,
            pairs: [
              { left: 'A', right: '1' },
              { left: 'B', right: '2' },
            ],
            type: 'matching',
          } as Question;
        case 'multi':
          return {
            ...base,
            correct: [0, 2],
            options: [
              {
                explanation: 'Correct — supported by the material.',
                value: 'A',
              },
              { explanation: 'Incorrect for this question.', value: 'B' },
              { explanation: 'Correct — also supported.', value: 'C' },
              { explanation: 'Incorrect for this question.', value: 'D' },
            ],
            type: 'multi',
          } as Question;
        default:
          return {
            ...base,
            correct: [0],
            options: [
              { explanation: 'Correct — this is the best answer.', value: 'A' },
              { explanation: 'Incorrect — a common distractor.', value: 'B' },
              { explanation: 'Incorrect for this question.', value: 'C' },
              { explanation: 'Incorrect for this question.', value: 'D' },
            ],
            type: 'mcq',
          } as Question;
      }
    });
    const name = `${wsName} quiz`;
    const quizMat: Material = {
      ...ownerMaterialAccess,
      chapterId: null,
      content: quizDocument(qs, opts.timeLimitMin),
      createdAt: new Date().toISOString(),
      id: uid('qz'),
      kind: 'quiz',
      privacy: 'private',
      scopeChapters: scopeChapterNames,
      scopeFileIds: opts.fileIds,
      title: name,
      workspaceId: wsId,
      workspaceName: wsName,
    };
    db.refreshMaterialContentBytes(quizMat);
    db.materials.unshift(quizMat);
    return HttpResponse.json({
      kind: 'quiz',
      quiz: db.quizFromMaterial(quizMat),
    });
  }),

  /* ---------------- quizzes & attempts ---------------- */
  http.get('/api/quizzes', async () => {
    await latency();
    return HttpResponse.json(db.quizMaterials().map(db.quizFromMaterial));
  }),
  http.post('/api/quizzes', async ({ request }) => {
    const body = (await request.json()) as Partial<Quiz>;
    const ws = db.workspaces.find((w) => w.id === body.workspaceId);
    const name = body.name ?? 'Untitled quiz';
    const material: Material = {
      ...ownerMaterialAccess,
      chapterId: null,
      content: quizDocument(body.questions ?? [], body.timeLimitMin),
      createdAt: new Date().toISOString(),
      id: uid('qz'),
      kind: 'quiz',
      privacy: body.privacy ?? 'private',
      scopeChapters: body.chapters ?? [],
      scopeFileIds: [],
      title: name,
      workspaceId: body.workspaceId ?? '',
      workspaceName: ws?.name ?? '',
    };
    db.refreshMaterialContentBytes(material);
    db.materials.unshift(material);
    return HttpResponse.json(db.quizFromMaterial(material), { status: 201 });
  }),
  /** Ad-hoc quiz built from the recently-missed question pool. */
  http.get('/api/mistakes', async () => {
    await latency();
    const quiz: Quiz = {
      chapters: [],
      createdAt: new Date().toISOString(),
      id: 'review_mistakes',
      name: 'Review mistakes',
      privacy: 'private',
      questions: db.mistakes,
      workspaceId: '',
      workspaceName: 'From your missed questions',
    };
    return HttpResponse.json(quiz);
  }),
  http.get('/api/quizzes/:id', async ({ params }) => {
    await latency();
    if (params.id === 'review_mistakes') {
      return HttpResponse.json({
        chapters: [],
        createdAt: new Date().toISOString(),
        id: 'review_mistakes',
        name: 'Review mistakes',
        privacy: 'private',
        questions: db.mistakes,
        workspaceId: '',
        workspaceName: 'From your missed questions',
      } satisfies Quiz);
    }
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    return mt
      ? HttpResponse.json(db.quizFromMaterial(mt))
      : new HttpResponse(null, { status: 404 });
  }),
  http.patch('/api/quizzes/:id', async ({ params, request }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    if (!mt) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<Quiz>;
    const cur = db.quizFromMaterial(mt);
    const name = body.name ?? cur.name;
    const chapters = body.chapters ?? cur.chapters;
    const questions = body.questions ?? cur.questions;
    const timeLimitMin = body.timeLimitMin ?? cur.timeLimitMin;
    if (body.privacy !== undefined) mt.privacy = body.privacy;
    mt.title = name;
    mt.scopeChapters = chapters;
    mt.content = quizDocument(questions, timeLimitMin, mt.id);
    db.refreshMaterialContentBytes(mt);
    return HttpResponse.json(db.quizFromMaterial(mt));
  }),
  http.delete('/api/quizzes/:id', async ({ params }) => {
    const i = db.materials.findIndex(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    if (i >= 0) db.materials.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/quizzes/:id/clone', async ({ params }) => {
    await latency();
    const sourceMaterial = db.materials.find(
      (material) => material.id === params.id && material.kind === 'quiz'
    );
    const publicQuiz = db.publicQuizzes.find((quiz) => quiz.id === params.id);
    if (!sourceMaterial && !publicQuiz)
      return new HttpResponse(null, { status: 404 });
    const source = sourceMaterial
      ? db.quizFromMaterial(sourceMaterial)
      : publicQuiz!;
    const material: Material = {
      ...ownerMaterialAccess,
      chapterId: null,
      content: quizDocument(source.questions, source.timeLimitMin),
      createdAt: new Date().toISOString(),
      id: uid('qz'),
      isOwner: true,
      kind: 'quiz',
      privacy: 'private',
      scopeChapters: source.chapters,
      scopeFileIds: [],
      title: source.name,
      workspaceId: '',
      workspaceName: '',
    };
    db.refreshMaterialContentBytes(material);
    db.materials.unshift(material);
    return HttpResponse.json(db.quizFromMaterial(material), { status: 201 });
  }),
  http.get('/api/attempts', async () => {
    await latency();
    return HttpResponse.json(
      [...db.attempts].sort(
        (a, b) => +new Date(b.takenAt) - +new Date(a.takenAt)
      )
    );
  }),
  http.get('/api/attempts/:id', async ({ params }) => {
    await latency();
    const at = db.attempts.find((a) => a.id === params.id);
    if (!at) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      ...at,
      answers: at.answers ?? {},
      questions: at.questions ?? [],
    });
  }),
  http.post('/api/quizzes/:id/attempts', async ({ params, request }) => {
    const body = (await request.json()) as {
      correct: number;
      total: number;
      wrong?: Question[];
      answers?: Record<string, unknown>;
      questions?: Question[];
    };
    const quizMt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    const quiz = quizMt ? db.quizFromMaterial(quizMt) : undefined;
    // Fold any missed questions into the review-mistakes pool (deduped by id).
    if (body.wrong?.length) {
      for (const q of body.wrong) {
        const i = db.mistakes.findIndex((m) => m.id === q.id);
        if (i >= 0) db.mistakes[i] = q;
        else db.mistakes.push(q);
      }
    }
    // Correctly answered review-mistakes questions leave the pool.
    if (params.id === 'review_mistakes') {
      const wrongIds = new Set((body.wrong ?? []).map((q) => q.id));
      for (let i = db.mistakes.length - 1; i >= 0; i--) {
        if (!wrongIds.has(db.mistakes[i].id)) db.mistakes.splice(i, 1);
      }
    }
    const at = {
      answers: body.answers ?? {},
      chapters: quiz?.chapters ?? [],
      correct: body.correct,
      id: uid('at'),
      pct: Math.round((body.correct / Math.max(1, body.total)) * 100),
      questions: body.questions ?? [],
      quizId: String(params.id),
      quizName: quiz?.name ?? 'Quiz',
      takenAt: new Date().toISOString(),
      total: body.total,
      workspaceName: quiz?.workspaceName ?? '',
    };
    db.attempts.unshift(at);
    return HttpResponse.json(at, { status: 201 });
  }),

  /* ---------------- flashcards ---------------- */
  http.get('/api/decks', async () => {
    await latency();
    return HttpResponse.json(db.deckMaterials().map(db.deckFromMaterial));
  }),
  http.post('/api/decks', async ({ request }) => {
    const body = (await request.json()) as Partial<Deck>;
    const ws = db.workspaces.find((w) => w.id === body.workspaceId);
    const name = body.name ?? 'Untitled deck';
    const id = uid('dk');
    const material: Material = {
      ...ownerMaterialAccess,
      chapterId: null,
      color: body.color ?? 'green',
      content: flashcardsDocument([], id),
      createdAt: new Date().toISOString(),
      id,
      kind: 'flashcards',
      privacy: 'private',
      scopeChapters: [],
      scopeFileIds: [],
      title: name,
      workspaceId: body.workspaceId ?? '',
      workspaceName: ws?.name ?? body.workspaceName ?? '',
    };
    db.refreshMaterialContentBytes(material);
    db.materials.unshift(material);
    return HttpResponse.json(db.deckFromMaterial(material), { status: 201 });
  }),
  http.get('/api/decks/:id', async ({ params }) => {
    await latency();
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'flashcards'
    );
    return mt
      ? HttpResponse.json(db.deckFromMaterial(mt))
      : new HttpResponse(null, { status: 404 });
  }),
  http.patch('/api/decks/:id', async ({ params, request }) => {
    const material = db.materials.find(
      (item) => item.id === params.id && item.kind === 'flashcards'
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<Deck>;
    if (body.name !== undefined) material.title = body.name;
    if (body.color !== undefined) material.color = body.color;
    if (body.privacy !== undefined) material.privacy = body.privacy;
    return HttpResponse.json(db.deckFromMaterial(material));
  }),
  http.post('/api/decks/:id/clone', async ({ params }) => {
    await latency();
    let source = db.materials.find(
      (material) => material.id === params.id && material.kind === 'flashcards'
    );
    if (!source) {
      const index = db.publicDecks.findIndex((deck) => deck.id === params.id);
      source = index >= 0 ? db.deckMaterials()[index] : undefined;
    }
    if (!source) return new HttpResponse(null, { status: 404 });
    const cards = materialCards(source).map((card) => ({
      ...card,
      id: uid('c'),
    }));
    const id = uid('dk');
    const material: Material = {
      ...source,
      chapterId: null,
      content: flashcardsDocument(cards, id),
      createdAt: new Date().toISOString(),
      id,
      isOwner: true,
      privacy: 'private',
      scopeFileIds: [],
      workspaceId: '',
      workspaceName: '',
    };
    db.materials.unshift(material);
    cards.forEach((card) => {
      db.cardStats[card.id] = {
        known: false,
        materialId: id,
        srs: newSrsState(),
      };
    });
    return HttpResponse.json(db.deckFromMaterial(material), { status: 201 });
  }),
  http.get('/api/decks/:id/cards', async ({ params }) => {
    await latency();
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'flashcards'
    );
    return mt
      ? HttpResponse.json(db.cardsFromMaterial(mt))
      : new HttpResponse(null, { status: 404 });
  }),
  http.post('/api/decks/:id/cards', async ({ params, request }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'flashcards'
    );
    if (!mt) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as { front: string; back: string };
    const id = uid('c');
    const cards = materialCards(mt);
    cards.push({ back: body.back ?? '', front: body.front ?? '', id });
    mt.content = flashcardsDocument(cards, mt.id);
    db.refreshMaterialContentBytes(mt);
    db.cardStats[id] = { known: false, materialId: mt.id, srs: newSrsState() };
    return HttpResponse.json(
      db.cardsFromMaterial(mt).find((c) => c.id === id)!,
      { status: 201 }
    );
  }),
  http.patch('/api/cards/:id', async ({ params, request }) => {
    const stat = db.cardStats[String(params.id)];
    if (!stat) return new HttpResponse(null, { status: 404 });
    const mt = db.materials.find(
      (x) => x.id === stat.materialId && x.kind === 'flashcards'
    );
    if (!mt) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<
      Pick<Flashcard, 'front' | 'back' | 'known' | 'srs'>
    >;
    if (body.front !== undefined || body.back !== undefined) {
      const cards = materialCards(mt);
      const card = cards.find((c) => c.id === params.id);
      if (card) {
        if (body.front !== undefined) card.front = body.front;
        if (body.back !== undefined) card.back = body.back;
        mt.content = flashcardsDocument(cards, mt.id);
        db.refreshMaterialContentBytes(mt);
      }
    }
    if (body.srs !== undefined) stat.srs = body.srs;
    if (body.known !== undefined) stat.known = body.known;
    else if (body.srs !== undefined) stat.known = isKnown(body.srs);
    const cards = db.cardsFromMaterial(mt);
    const out = cards.find((c) => c.id === params.id);
    return out
      ? HttpResponse.json(out)
      : new HttpResponse(null, { status: 404 });
  }),
  http.delete('/api/cards/:id', async ({ params }) => {
    const stat = db.cardStats[String(params.id)];
    if (!stat) return new HttpResponse(null, { status: 404 });
    const mt = db.materials.find(
      (x) => x.id === stat.materialId && x.kind === 'flashcards'
    );
    if (!mt) return new HttpResponse(null, { status: 404 });
    const kept = materialCards(mt).filter((c) => c.id !== params.id);
    mt.content = flashcardsDocument(kept, mt.id);
    db.refreshMaterialContentBytes(mt);
    delete db.cardStats[String(params.id)];
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- schedule ---------------- */
  http.get('/api/events', async () => {
    await latency();
    return HttpResponse.json(db.events);
  }),
  http.post('/api/events', async ({ request }) => {
    const body = (await request.json()) as Omit<
      (typeof db.events)[number],
      'id'
    >;
    const ev = { ...body, id: uid('ev') };
    db.events.push(ev);
    return HttpResponse.json(ev, { status: 201 });
  }),
  http.patch('/api/events/:id', async ({ params, request }) => {
    const ev = db.events.find((x) => x.id === params.id);
    if (!ev) return new HttpResponse(null, { status: 404 });
    Object.assign(ev, await request.json());
    return HttpResponse.json(ev);
  }),
  http.delete('/api/events/:id', async ({ params }) => {
    const i = db.events.findIndex((x) => x.id === params.id);
    if (i >= 0) db.events.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/labels', async () => {
    await latency();
    return HttpResponse.json(db.labels);
  }),
  http.patch('/api/labels/:id', async ({ params, request }) => {
    const label = db.labels.find((x) => x.id === params.id);
    if (!label) return new HttpResponse(null, { status: 404 });
    Object.assign(label, await request.json());
    return HttpResponse.json(label);
  }),
  http.delete('/api/labels/:id', async ({ params }) => {
    const i = db.labels.findIndex((x) => x.id === params.id);
    if (i >= 0) db.labels.splice(i, 1);
    // keep events consistent — strip the deleted label from any event.
    for (const ev of db.events) {
      ev.labelIds = ev.labelIds.filter((id) => id !== params.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- tasks ---------------- */
  http.get('/api/tasks', async () => {
    await latency();
    // simulate day-end cleanup: drop tasks completed before today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const visible = db.tasks.filter(
      (t) => !(t.done && +new Date(t.dueDate) < +startOfToday)
    );
    return HttpResponse.json(visible);
  }),
  http.patch('/api/tasks/:id', async ({ params, request }) => {
    const t = db.tasks.find((x) => x.id === params.id) as Task | undefined;
    if (!t) return new HttpResponse(null, { status: 404 });
    Object.assign(t, await request.json());
    return HttpResponse.json(t);
  }),
  http.delete('/api/tasks/:id', async ({ params }) => {
    await latency();
    const i = db.tasks.findIndex((x) => x.id === params.id);
    if (i >= 0) db.tasks.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- thinking space ---------------- */
  http.get('/api/thinking', async () => {
    await latency();
    return HttpResponse.json(db.canvases);
  }),
  http.get('/api/thinking/:id', async ({ params }) => {
    await latency();
    const c = db.canvases.find((x) => x.id === params.id);
    return c ? HttpResponse.json(c) : new HttpResponse(null, { status: 404 });
  }),
  http.post('/api/thinking', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    const c = {
      id: uid('cv'),
      name: body.name,
      updatedAt: new Date().toISOString(),
    };
    db.canvases.unshift(c);
    return HttpResponse.json(c, { status: 201 });
  }),
  http.put('/api/thinking/:id', async ({ params, request }) => {
    const c = db.canvases.find((x) => x.id === params.id);
    if (!c) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as { scene?: unknown; name?: string };
    if (body.scene !== undefined) c.scene = body.scene;
    if (body.name) c.name = body.name;
    c.updatedAt = new Date().toISOString();
    return HttpResponse.json(c);
  }),

  /* ---------------- explore ---------------- */
  http.get('/api/explore/workspaces', async () => {
    await latency();
    return HttpResponse.json(db.publicWorkspaces);
  }),
  http.get('/api/explore/quizzes', async () => {
    await latency();
    return HttpResponse.json(db.publicQuizzes);
  }),
  http.get('/api/explore/decks', async () => {
    await latency();
    return HttpResponse.json(db.publicDecks);
  }),

  /* ---------------- billing ---------------- */
  http.get('/api/billing', async () => {
    await latency();
    return HttpResponse.json({
      planTier: db.user.planTier,
      subscriptionStatus: db.user.subscriptionStatus,
    });
  }),
  http.post('/api/billing/checkout', async ({ request }) => {
    await latency();
    const body = (await request.json()) as { planTier: string };
    return HttpResponse.json({
      url: `/subscription?mock_checkout=${body.planTier}`,
    });
  }),
  http.post('/api/billing/portal', async () => {
    await latency();
    return HttpResponse.json({ url: '/subscription?mock_portal=1' });
  }),

  /* ---------------- integrations ---------------- */
  http.get('/api/integrations', async () => {
    await latency();
    return HttpResponse.json({ google: false, microsoft: false });
  }),
  http.get('/api/integrations/google/picker-token', async () => {
    await latency();
    return HttpResponse.json({ accessToken: 'mock-google-token' });
  }),
  http.get('/api/integrations/microsoft/recent', async () => {
    await latency();
    return HttpResponse.json([
      { id: 'ms_file_1', name: 'Biology Notes.docx' },
      { id: 'ms_file_2', name: 'Lab Report.pdf' },
    ]);
  }),
  http.post(
    '/api/workspaces/:id/sources/import',
    async ({ params, request }) => {
      await latency();
      const wsId = params.id as string;
      const body = (await request.json()) as {
        provider: string;
        fileIds: string[];
        chapterId?: string | null;
      };
      const created = body.fileIds.map((_fileId, i) => {
        const f = {
          addedAt: new Date().toISOString(),
          chapterId: body.chapterId ?? null,
          id: uid('f'),
          ingestPct: 0,
          kind: 'pdf' as const,
          name: `${body.provider}-import-${i + 1}.pdf`,
          sizeKb: 512,
          status: 'processing' as const,
          workspaceId: wsId,
        };
        db.files.unshift(f);
        return f;
      });
      return HttpResponse.json(created, { status: 201 });
    }
  ),
];

type SourceKindFix = 'pdf' | 'doc' | 'md' | 'image' | 'txt';
