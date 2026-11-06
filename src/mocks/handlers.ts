import { zipSync } from 'fflate';
import { delay, HttpResponse, http } from 'msw';
import {
  createMaterialBodyTitleMax,
  ReportEditIncidentBody,
  SetCustomizationBody,
  updateFileBodyNameMax,
} from '@/api/gen/validators';
import type {
  Attempt,
  CloneFileReq,
  CloneMaterialReq,
  CreateBlankFileReq,
  CreateWorkspaceReq,
  CreditSettings,
  EditableQuiz,
  FlashcardSet,
  GenerateOptions,
  HiddenBody,
  Material,
  MaterialDiscussion,
  ModelRef,
  MoveFilesReq,
  PDFAnnotation,
  PDFAnnotationBody,
  Question,
  SearchResult,
  SourceCollaborationToken,
  SourceFile,
  SourceSession,
  StudyPreferences,
  Tag,
  TagInput,
  Task,
  Topic,
  TrashItem,
  UpdateConversationReq,
  Workspace,
  WorkspaceActivity,
  WorkspaceDashboard,
  WorkspaceMember,
} from '@/api/types';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import { parseFlashcardsBlock } from '@/features/materials/blocks';
import {
  createMaterialDocument,
  emptyMaterialDocument,
  type FlashcardsElement,
  flashcardsElementToCards,
  flashcardsNode,
  quizNode,
} from '@/features/materials/document';
import { questionIssues } from '@/features/questions/issues';
import {
  exampleAnswers,
  exampleQuestion,
} from '@/features/questions/questionFixtures';
import { isDrawingValue } from '@/features/quizzes/drawing/drawingValue';
import { type Answers, runScore } from '@/features/quizzes/grade';
import {
  modelRefValue,
  optionRef,
  sameModel,
} from '@/features/settings/llmOptions';
import { getFileKind } from '@/features/workspace/sourceUpload';
import { DEV_SHARE_LINK_SECRET, sharePath } from '@/lib/shareLink';
import { accountChatHandlers } from './accountChat';
import { gradeQuestions, learnerView } from './answerKeys';
import {
  assignmentActivity,
  assignmentHandlers,
  quizAssignmentFields,
  recentFor,
  workspaceMaterialRefs,
} from './assignments';
import { mockResumeStream } from './chatResume';
import { mockChatStream } from './chatStream';
import { mockUndo } from './chatUndo';
import {
  mockMaterialRoom,
  noteTokenHold,
  savedSourceState,
  sourceRoom,
  sourceRoomName,
  sourceRoomState,
  sourceSessionHeld,
} from './collaboration';
import * as db from './db';
import { uid } from './db';
import { editorAssetHandlers } from './editorAssets';
import { extractionHandlers, seedExtractionFiles } from './extraction';
import { questionBankHandlers } from './questionBank';
import {
  blankOffice,
  clearMockThumbnailStale,
  mockAtSizeLimit,
  prepareBlankOffice,
  scenarioSourceSession,
  seedUploadedOffice,
} from './scenarioFixtures';
import { studyHandlers } from './study';
import { voiceInputHandlers } from './voiceInput';
import { mockWorkspaceMembers } from './workspaceMembers';

/** Query parsing shared by the owner-scoped list mocks; the cursor is an offset. */
function listParams(href: string) {
  const url = new URL(href);
  const param = (key: string) => url.searchParams.get(key) ?? '';
  return {
    asc: param('dir') === 'asc',
    limit: Number(param('limit') || 40),
    list: (key: string) => param(key).split(',').filter(Boolean),
    offset: Number(param('cursor') || 0),
    param,
    sort: param('sort'),
  };
}

function sortBy<T>(key: (row: T) => string | number, asc: boolean) {
  return (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return asc ? cmp : -cmp;
  };
}

import { dialogFiles } from './dialogFiles';
import { errorMaterials } from './errorMaterials';
import { sourceUploadPolicy } from './sourceUploadPolicy';

const latency = () => delay(1000 + Math.random() * 220);
/** /me carries the account lifecycle, as the server's does. */
const meBody = () => ({
  ...db.user,
  account: { ...db.accountStatus, userId: db.user.id },
});
function mockCatalogModels() {
  const thinking = {
    default: 'high',
    levels: ['low', 'mid', 'high', 'max'],
  };
  return [
    {
      isDefault: true,
      modelName: 'DeepSeek Flash',
      modelSlug: 'deepseek-flash',
      providerName: 'DeepSeek',
      providerSlug: 'deepseek',
      thinking,
    },
    {
      isDefault: false,
      modelName: 'GLM 5.3 Flash',
      modelSlug: 'glm-5.3-flash',
      providerName: 'Z.ai',
      providerSlug: 'zai',
      thinking: {
        default: 'high',
        levels: ['low', 'high', 'max'],
      },
    },
  ];
}
const ownerMaterialAccess = {
  capabilities: {
    canEdit: true,
    canEditContent: true,
    canManageMembers: true,
    canView: true,
  },
  role: 'owner' as const,
};
/** One typed address, as on the server: `invitedUserId` is empty while the
 * row reaches no eligible account (inert, never acceptable). */
interface MockWorkspaceInvite {
  acceptedAt?: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedUserId: string;
  revokedAt?: string;
  role: Exclude<WorkspaceMember['role'], 'owner'>;
  sentAt: string;
  token: string;
  workspaceId: string;
}
const pendingInvite = (invite: MockWorkspaceInvite) =>
  !invite.acceptedAt &&
  !invite.revokedAt &&
  new Date(invite.expiresAt).getTime() > Date.now();
function copyText(
  locale: string,
  key: 'new_flashcards' | 'untitled_note' | 'untitled_quiz'
): string {
  const table = {
    new_flashcards: { en: 'New flashcards', zh: '新建卡组' },
    untitled_note: { en: 'Untitled note', zh: '未命名笔记' },
    untitled_quiz: { en: 'Untitled quiz', zh: '未命名测验' },
  } as const;
  return locale === 'zh' ? table[key].zh : table[key].en;
}

interface MockInviteCandidate {
  avatarUrl?: string;
  email: string;
  id: string;
  name: string;
}

const mockDiscussions = db.discussions;
const mockWorkspaceInvites: MockWorkspaceInvite[] = [];
const mockInviteCandidates: MockInviteCandidate[] = [
  {
    email: 'morgan@example.com',
    id: 'u_mock_collaborator',
    name: 'Morgan Lee',
  },
];

const SOURCE_EPOCH = 1;

/** The plan's workspace cap, owned and joined together, as the gateway
 * enforces it. */
function atWorkspaceCap() {
  const cap = PLAN_LIMITS[db.user.planTier].ownedWorkspaceLimit;
  return (
    cap !== null &&
    db.workspaces.filter((w) => w.isOwner || w.role).length >= cap
  );
}

const workspaceLimitResponse = () =>
  HttpResponse.json(
    { code: 'workspace_limit_exceeded', message: 'workspace limit reached' },
    { status: 403 }
  );

/** Fixture Office sources use native checkpoint seeds; text sources seed from
 * their mock byte link. Intentionally broken preview files still answer 503. */
async function mockSourceSession(
  fileId: string,
  view = false
): Promise<SourceSession | null> {
  const scenario = await scenarioSourceSession(fileId, view);
  if (scenario) return scenario;
  const file = db.files.find((row) => row.id === fileId);
  const link = db.fileLinks[fileId];
  if (!(file && link?.url.startsWith('data:text/plain'))) return null;
  const text = decodeURIComponent(link.url.slice(link.url.indexOf(',') + 1));
  const room = sourceRoom(fileId, SOURCE_EPOCH, text);
  return {
    access: 'write',
    baseRevision: file.revision,
    baseSourceSHA256: `mock-${fileId}-${file.revision}`,
    checkpoint: room.version,
    epoch: SOURCE_EPOCH,
    fileId,
    format: 'text',
    indexedCheckpoint: 0,
    netTokens: 0,
    room: sourceRoomName(fileId, SOURCE_EPOCH),
    sourceIdentity: `mock-${fileId}`,
    sourceURL: link.url,
    state: sourceRoomState(room),
    stateSeedSHA256: null,
    workspaceId: file.workspaceId,
  };
}

const editorStateCacheName = 'capy-notebook-editor-e2e-state-v1';
const editorStateRequest = (materialId: string) =>
  new Request(
    `https://editor-state.capynotebook.test/materials/${encodeURIComponent(materialId)}`
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
  for (let index = mockDiscussions.length - 1; index >= 0; index--) {
    if (mockDiscussions[index].materialId === materialId)
      mockDiscussions.splice(index, 1);
  }
  const discussions = structuredClone(state.discussions);
  mockDiscussions.push(...discussions);
}

const materialCards = (material: Material) =>
  typeof material.content === 'string'
    ? parseFlashcardsBlock(material.content).cards
    : flashcardsElementToCards(
        material.content.value.find(
          (node) => node.type === 'flashcards'
        ) as FlashcardsElement
      );

const quizDocument = (questions: Question[], id = uid('quiz')) =>
  createMaterialDocument([quizNode({ questions }, id)]);

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

interface MockSourceImport {
  completed: boolean;
  fileId: string;
  hidden: boolean;
  name: string;
  polls: number;
  sizeBytes: number;
  topicId: string | null;
  workspaceId: string;
}

const sourceImports = new Map<string, MockSourceImport>();

/** A workspace's source route and its unscoped twin for standalone files. */
const sourceRoutes = (suffix: string) => [
  `/api/workspaces/:id/sources${suffix}`,
  `/api/sources${suffix}`,
];
const sourceImportResponses = new Map<
  string,
  {
    jobs: { jobId: string; name: string; uploadId: string }[];
    rejected: { code: string; fileId: string }[];
  }
>();

function completeMockSourceImport(sourceImport: MockSourceImport) {
  if (sourceImport.completed) return;
  sourceImport.completed = true;
  db.fileLinks[sourceImport.fileId] = {
    url: db.textUrl(`Imported ${sourceImport.name}`),
  };
  const file: (typeof db.files)[number] = {
    addedAt: new Date().toISOString(),
    hasBytes: true,
    hidden: sourceImport.hidden || undefined,
    id: sourceImport.fileId,
    indexed: true,
    ingestPct: 100,
    isPayer: true,
    kind: 'pdf',
    name: sourceImport.name,
    position: db.nextContentPosition(
      sourceImport.workspaceId,
      sourceImport.topicId
    ),
    revision: 1,
    sizeBytes: sourceImport.sizeBytes,
    status: 'ready',
    topicId: sourceImport.topicId,
    workspaceId: sourceImport.workspaceId,
  };
  db.files.unshift(file);
  const workspace = db.workspaces.find(
    (item) => item.id === sourceImport.workspaceId
  );
  if (workspace) workspace.fileCount += 1;
  db.accountStatus.storageUsedBytes += sourceImport.sizeBytes;
  if (sourceImport.topicId) {
    db.topics
      .find((topic) => topic.id === sourceImport.topicId)
      ?.fileIds.push(file.id);
  }
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function trashItem(
  base: Omit<TrashItem, 'canRestore' | 'episodeId' | 'trashedAt' | 'purgeAfter'>
): TrashItem {
  const now = Date.now();
  return {
    ...base,
    canRestore: true,
    episodeId: uid('trash'),
    purgeAfter: new Date(now + TRASH_RETENTION_MS).toISOString(),
    trashedAt: new Date(now).toISOString(),
  };
}

function trashMaterial(id: string, kind?: string) {
  const i = db.materials.findIndex(
    (x) => x.id === id && (!kind || x.kind === kind)
  );
  if (i < 0) return;
  const [removed] = db.materials.splice(i, 1);
  const ws = db.workspaces.find((w) => w.id === removed.workspaceId);
  db.trash.unshift({
    item: trashItem({
      id: removed.id,
      kind: 'material',
      materialKind: removed.kind,
      preview: db.materialPreview(removed),
      sizeBytes: JSON.stringify(removed.content ?? {}).length,
      title: removed.title,
      workspaceId: removed.workspaceId || undefined,
      workspaceName: ws?.name,
    }),
    material: removed,
  });
}

const pdfAnnotations: Record<string, PDFAnnotation[]> = {};

export { mockWorkspaceMembers } from './workspaceMembers';

/** Clear only state created by the dedicated User scenarios workspace. */
export function resetScenarioHandlerState(workspaceId: string) {
  for (const rows of [mockWorkspaceMembers, mockWorkspaceInvites]) {
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i].workspaceId === workspaceId) rows.splice(i, 1);
  }
  for (const id of Object.keys(pdfAnnotations))
    if (id.startsWith('mock-scenario-')) delete pdfAnnotations[id];
  for (const key of sourceImportResponses.keys())
    if (key.startsWith(`${workspaceId}:`)) sourceImportResponses.delete(key);
  for (const [id, job] of sourceImports)
    if (job.workspaceId === workspaceId) sourceImports.delete(id);
}

const MOCK_USAGE_EVENT_SHAPES = [
  {
    kind: 'llm',
    modelSlug: 'deepseek-flash',
    providerSlug: 'deepseek',
    surface: 'chat',
  },
  {
    kind: 'rerank',
    modelSlug: 'qwen3-rerank',
    providerSlug: 'alibaba',
    surface: 'chat',
  },
  {
    kind: 'embedding',
    modelSlug: 'Qwen/Qwen3-Embedding-4B',
    providerSlug: 'deepinfra',
    surface: 'ingest',
  },
  {
    kind: 'llm',
    modelSlug: 'deepseek-flash',
    providerSlug: 'deepseek',
    surface: 'generate',
  },
  { kind: 'email', modelSlug: '', providerSlug: '', surface: 'system' },
] as const;

/** 45 ledger rows, newest first, so Detailed usage has three pages. */
const MOCK_USAGE_EVENTS = Array.from({ length: 45 }, (_, i) => {
  const shape = MOCK_USAGE_EVENT_SHAPES[i % MOCK_USAGE_EVENT_SHAPES.length];
  const llm = shape.kind === 'llm';
  return {
    ...shape,
    createdAt: new Date(Date.now() - i * 2 * 3_600_000).toISOString(),
    creditMicros: llm ? 120_000 + i * 1000 : 20_000,
    inputTokens: llm ? 800 + i * 10 : 0,
    outputTokens: llm ? 240 + i * 5 : 0,
    unit: shape.kind === 'email' ? 'emails' : 'tokens',
    units: llm ? 0 : 1,
  };
});
type MockUsageEvent = (typeof MOCK_USAGE_EVENTS)[number];

/** A Huma error carrying a machine code, as the gateway sends it. */
const codeError = (status: number, code: string) =>
  HttpResponse.json({ errors: [{ message: code }], status }, { status });

/** Advances one queue of unprocessed changes (files, or notes) as the tab
 * polls: one item processes at a time, queued work starts on the second read
 * without other work processing, and processing finishes on the fourth read. */
function advanceChanges<T extends { id: string }>(
  items: T[],
  changes: Map<string, db.MockChange>
) {
  const tracked = items.flatMap((item) => {
    const change = changes.get(item.id);
    return change ? [{ change, item }] : [];
  });
  for (const { change, item } of tracked) {
    change.ticks++;
    if (change.state === 'processing' && change.ticks > 3)
      changes.delete(item.id);
  }
  const live = tracked.filter(({ item }) => changes.has(item.id));
  const next = live.find(({ change }) => change.state === 'queued');
  if (
    next &&
    next.change.ticks > 1 &&
    !live.some(({ change }) => change.state === 'processing')
  )
    Object.assign(next.change, { state: 'processing', ticks: 0 });
  return live;
}

type SourceUploadMetadata = {
  topicId?: string | null;
  topicName?: string | null;
  hidden?: boolean;
  kind: string;
  name: string;
};

/** A clone's topic: the picked one, or one by name (any case), created
 * when missing. */
function mockCloneTopic(
  workspaceId: string,
  { topicId, topicName }: { topicId?: string; topicName?: string }
): string | null {
  const name = topicName?.trim();
  if (!name) return topicId ?? null;
  const existing = db.topics.find(
    (topic) =>
      topic.workspaceId === workspaceId &&
      topic.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;
  const topic: Topic = {
    description: '',
    fileIds: [],
    id: uid('tp'),
    name,
    order: db.topics.filter((c) => c.workspaceId === workspaceId).length,
    workspaceId,
  };
  db.topics.push(topic);
  return topic.id;
}

/** Explore's public quizzes and flashcards, as material clone sources. */
function publicCloneSource(id: string): Material | undefined {
  const quiz = db.publicQuizzes.find((q) => q.id === id);
  if (quiz) {
    return db.makeMaterial({
      ...ownerMaterialAccess,
      content: quizDocument(quiz.questions),
      createdAt: new Date().toISOString(),
      id,
      kind: 'quiz',
      privacy: 'public',
      scopeFileNames: [],
      scopeTopics: [],
      title: quiz.name,
      topicId: null,
      workspaceId: '',
      workspaceName: '',
    });
  }
  const index = db.publicFlashcardSets.findIndex((set) => set.id === id);
  return index >= 0 ? db.flashcardSetMaterials()[index] : undefined;
}

/** Purchased-credit controls the billing mocks read and the PUT mocks edit. */
const mockCreditSettings: CreditSettings = {
  autoReload: true,
  paymentMethod: {
    brand: 'visa',
    expMonth: 6,
    expYear: 2029,
    last4: '7290',
    type: 'card',
  },
  paymentMethodInstant: true,
  // Matches the retrying reload invoice below.
  reload: {
    amountCents: 1000,
    nextAttemptAt: new Date(Date.now() + 86_400_000).toISOString(),
    skipped: false,
    status: 'retrying',
  },
  reloadAmountCents: 1000,
  reloadThresholdMicros: 0,
  spendingLimitCents: 5000,
  spentThisMonthCents: 1800,
  // On so the Usage tab shows the starter offer, though a card is saved.
  starterAvailable: true,
  starterCardUsed: false,
};

type GradeOneBody = { questionId: string; answers: Answers };

/** A shared page's check: one question graded with its key. As on the server,
 * no model reads an open answer, so an answered one stays Not marked. */
function gradeOne(
  questions: Question[],
  { questionId, answers }: GradeOneBody
) {
  const question = questions.find((q) => q.id === questionId);
  if (!question)
    return HttpResponse.json({ message: 'not found' }, { status: 404 });
  const graded = gradeQuestions([question], answers);
  const parts = graded.questions[0].parts.map((part) => {
    const answer = answers[part.id];
    const answered =
      (part.answer.type === 'open' &&
        typeof answer === 'string' &&
        answer.trim() !== '') ||
      (part.answer.type === 'drawing' && isDrawingValue(answer ?? null));
    return answered
      ? { ...part, awarded: 0, itemAwards: undefined, pending: true }
      : part;
  });
  return HttpResponse.json({
    correct: parts.reduce((sum, part) => sum + (part.awarded ?? 0), 0),
    question: { ...graded.questions[0], parts },
    total: graded.max,
  });
}

seedExtractionFiles();

export const handlers = [
  ...extractionHandlers(
    (workspaceId, title, questions) => {
      const quiz = db.makeMaterial({
        ...ownerMaterialAccess,
        content: quizDocument(questions),
        createdAt: new Date().toISOString(),
        hidden: true,
        id: uid('qz'),
        kind: 'quiz',
        privacy: 'private',
        scopeFileNames: [],
        scopeTopics: [],
        title,
        topicId: null,
        workspaceId,
        workspaceName:
          db.workspaces.find((row) => row.id === workspaceId)?.name ?? '',
      });
      db.materials.unshift(quiz);
      return quiz.id;
    },
    (workspaceId, title) =>
      db.materials.some(
        (row) => row.workspaceId === workspaceId && row.title === title
      )
  ),
  ...questionBankHandlers,
  ...editorAssetHandlers,
  ...voiceInputHandlers,
  http.get('/api/files/:id/annotations', ({ params }) =>
    params.id === 'mock-preview-annotations'
      ? new HttpResponse(null, { status: 503 })
      : HttpResponse.json(pdfAnnotations[String(params.id)] ?? [])
  ),
  http.post('/api/files/:id/annotations', async ({ params, request }) => {
    const fileId = String(params.id);
    const body = (await request.json()) as PDFAnnotationBody;
    const mark: PDFAnnotation = {
      ...body,
      authorId: db.user.id,
      createdAt: new Date().toISOString(),
      fileId,
      id: uid('annotation'),
      updatedAt: new Date().toISOString(),
    };
    pdfAnnotations[fileId] ??= [];
    pdfAnnotations[fileId].push(mark);
    return HttpResponse.json(mark, { status: 201 });
  }),
  http.patch(
    '/api/files/:id/annotations/:annotationId',
    async ({ params, request }) => {
      const mark = pdfAnnotations[String(params.id)]?.find(
        (item) => item.id === params.annotationId
      );
      if (!mark) return new HttpResponse(null, { status: 404 });
      Object.assign(mark, await request.json(), {
        updatedAt: new Date().toISOString(),
      });
      return HttpResponse.json(mark);
    }
  ),
  http.delete('/api/files/:id/annotations/:annotationId', ({ params }) => {
    const fileId = String(params.id);
    pdfAnnotations[fileId] = (pdfAnnotations[fileId] ?? []).filter(
      (item) => item.id !== params.annotationId
    );
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/files/:id/links', ({ params }) => {
    if (!dialogFiles.some((file) => file.id === params.id)) return;
    if (params.id === 'mock-preview-links')
      return new HttpResponse(null, { status: 503 });
    if (params.id === 'mock-preview-annotations')
      return HttpResponse.json(db.fileLinks.f_1);
    return HttpResponse.json({
      url:
        params.id === 'mock-preview-text'
          ? '/__mock/preview/text'
          : '/__mock/preview/unavailable',
    });
  }),
  http.get('/__mock/preview/text', () =>
    HttpResponse.text(
      'Dummy source text. Choose Edit source to preview a failed source session.'
    )
  ),
  http.get(
    '/__mock/preview/unavailable',
    () => new HttpResponse(null, { status: 503 })
  ),
  http.get('/api/files/:id/source-session', async ({ params, request }) => {
    const file = db.files.find((row) => row.id === params.id);
    const view = new URL(request.url).searchParams.get('view') === 'true';
    // The viewer's read of a text source is lock-free on the server: only the
    // last saved state, while one is ahead of the published bytes.
    if (view && file && !/\.(docx|xlsx|pptx)$/i.test(file.name))
      return HttpResponse.json({
        access: 'read',
        atSizeLimit: mockAtSizeLimit(file.id),
        fileId: file.id,
        format: 'text',
        state: savedSourceState(file.id),
      });
    if (dialogFiles.some((file) => file.id === params.id)) {
      return HttpResponse.json(
        { detail: 'Mock source session unavailable.', status: 503 },
        { status: 503 }
      );
    }
    if (!file) return new HttpResponse(null, { status: 404 });
    // A hung edit open (`holdSourceSessions`): never answered.
    if (sourceSessionHeld() && !view) await new Promise(() => {});
    const session = await mockSourceSession(String(params.id), view);
    return session
      ? HttpResponse.json(session)
      : HttpResponse.json(
          { detail: 'Only text sources have a mock session.', status: 503 },
          { status: 503 }
        );
  }),
  http.post('/api/files/:id/collaboration-token', async ({ params }) => {
    const session = await mockSourceSession(String(params.id));
    if (!session) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(
      {
        access: 'write',
        epoch: session.epoch,
        expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
        room: session.room,
        token: 'mock-collaboration-token',
        url: 'mock://collaboration',
      } satisfies SourceCollaborationToken,
      { status: 201 }
    );
  }),
  http.post('/__mock/auth/:operation', async () => {
    await delay(250);
    return HttpResponse.json({ error: null, status: 'complete' });
  }),
  http.all('/api/*', async () => {
    await latency();
  }),

  /* ---------------- me ---------------- */
  http.get('/api/me', async () => HttpResponse.json(meBody())),
  http.get('/api/account/deletion', async () => {
    const toDestroy = db.workspaces.filter((ws) => ws.role === 'owner');
    return HttpResponse.json({
      canDelete: true,
      graceDays: 30,
      lifecycleGeneration: 0,
      storageUsedBytes: db.accountStatus.storageUsedBytes,
      workspacesNeedingTransfer: [],
      workspacesToDestroy: toDestroy,
    });
  }),
  http.post('/api/account/deletion', async ({ request }) => {
    const body = (await request.json()) as {
      confirmEmail?: string;
      lifecycleGeneration?: number;
    };
    // An account with no email confirms with the word, as on the server.
    const expected = db.user.email || 'delete';
    if (
      !body.confirmEmail ||
      body.lifecycleGeneration !== 0 ||
      body.confirmEmail.toLowerCase() !== expected.toLowerCase()
    ) {
      return HttpResponse.json(
        { message: 'confirmation does not match' },
        { status: 400 }
      );
    }
    const purgeAfter = new Date();
    purgeAfter.setDate(purgeAfter.getDate() + 30);
    db.accountStatus.deletionRequestedAt = new Date().toISOString();
    db.accountStatus.purgeAfter = purgeAfter.toISOString();
    db.accountStatus.state = 'deletion_pending';
    db.accountStatus.userId = db.user.id;
    return HttpResponse.json({ ...db.accountStatus });
  }),
  http.patch('/api/me', async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      avatarIconId?: string;
    };
    const name = body.name?.trim() ?? '';
    if (!name || name.length > 60)
      return HttpResponse.json({ detail: 'name is required' }, { status: 422 });
    db.user.name = name;
    if (body.avatarIconId) {
      db.user.avatarIconId = body.avatarIconId;
      db.user.avatarUrl = `/icons/${body.avatarIconId}.svg`;
    }
    return HttpResponse.json(meBody());
  }),
  http.patch('/api/me/locale', async ({ request }) => {
    const body = (await request.json()) as { locale?: string };
    if (body.locale === 'en' || body.locale === 'zh')
      db.user.locale = body.locale;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/edit-incidents', async ({ request }) => {
    const incident = ReportEditIncidentBody.safeParse(await request.json());
    if (!incident.success)
      return HttpResponse.json({ detail: 'invalid incident' }, { status: 422 });
    db.editIncidents.push(incident.data);
    return new HttpResponse(null, { status: 204 });
  }),
  // Sync: stores the look; MSW opens no event stream, so no tab hears it.
  http.put('/api/me/customization', async ({ request }) => {
    const body = SetCustomizationBody.strict().safeParse(await request.json());
    if (!body.success)
      return HttpResponse.json(
        { detail: 'invalid customization' },
        { status: 422 }
      );
    db.user.customization = body.data;
    return new HttpResponse(null, { status: 204 });
  }),
  http.patch('/api/me/study-preferences', async ({ request }) => {
    db.user.studyPreferences = (await request.json()) as StudyPreferences;
    return new HttpResponse(null, { status: 204 });
  }),
  http.patch('/api/me/chat', async ({ request }) => {
    const { sendKey, steps } = (await request.json()) as {
      sendKey?: string;
      steps?: string;
    };
    if (steps !== undefined && steps !== 'normal' && steps !== 'verbose')
      return HttpResponse.json({ detail: 'invalid steps' }, { status: 422 });
    if (
      sendKey !== undefined &&
      sendKey !== 'enter' &&
      sendKey !== 'shift_enter'
    )
      return HttpResponse.json({ detail: 'invalid sendKey' }, { status: 422 });
    if (steps) db.user.chatSteps = steps;
    if (sendKey) db.user.chatSendKey = sendKey;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/models', async ({ request }) => {
    const slot = new URL(request.url).searchParams.get('slot');
    const fallback = {
      modelSlug: 'deepseek-flash',
      providerSlug: 'deepseek',
    };
    if (!slot) {
      return HttpResponse.json({
        defaultModel: { modelSlug: '', providerSlug: '' },
        models: [],
        selectedModel: { modelSlug: '', providerSlug: '' },
        selectedThinking: '',
      });
    }
    const selected = slot === 'chat' ? db.user.chatModel : fallback;
    const models = mockCatalogModels();
    const stored = db.userThinking[modelRefValue(selected)]?.[slot] ?? '';
    const selectedOption = models.find((item) =>
      sameModel(optionRef(item), selected)
    );
    const selectedThinking = stored || selectedOption?.thinking?.default || '';
    if (
      selectedOption?.thinking &&
      !selectedOption.thinking.levels.includes(selectedThinking)
    ) {
      return HttpResponse.json(
        { message: 'Stored thinking is not supported by the selected model.' },
        { status: 503 }
      );
    }
    return HttpResponse.json({
      defaultModel: fallback,
      models,
      selectedModel: selected,
      selectedThinking,
    });
  }),
  http.patch('/api/me/models', async ({ request }) => {
    const body = (await request.json()) as {
      chatModel?: ModelRef;
      chatThinking?: string;
      noteAiEnabled?: boolean;
    };
    if (body.chatModel !== undefined) {
      if (!body.chatModel?.providerSlug || !body.chatModel.modelSlug)
        return HttpResponse.json(
          { message: 'a model preference is required' },
          { status: 400 }
        );
      db.user.chatModel = body.chatModel;
    }
    if (body.noteAiEnabled !== undefined)
      db.user.noteAiEnabled = body.noteAiEnabled;
    const value = body.chatThinking;
    if (value !== undefined) {
      const model = db.user.chatModel;
      const spec = mockCatalogModels().find((item) =>
        sameModel(optionRef(item), model)
      )?.thinking;
      if (value && spec && !spec.levels.includes(value)) {
        return HttpResponse.json({ message: 'not found' }, { status: 404 });
      }
      const identity = modelRefValue(model);
      if (!db.userThinking[identity]) db.userThinking[identity] = {};
      db.userThinking[identity].chat = value;
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/questions/computation-check', async ({ request }) => {
    const { question } = (await request.json()) as { question: Question };
    const text = JSON.stringify(question.parts).toLowerCase();
    const computational = /calculat|convert|solve|\d+\s*[+*/=-]\s*\d+/.test(
      text
    );
    return HttpResponse.json({
      computational,
      probability: computational ? 0.9 : 0.05,
    });
  }),
  // The share reads the site Worker renders from; MSW skips the signature check.
  http.get('/api/public/quizzes/:token', ({ params }) => {
    const mt = anonymousMaterial(String(params.token), 'quiz');
    if (!mt)
      return HttpResponse.json({ message: 'not found' }, { status: 404 });
    const { id, name, privacy, questions } = db.quizFromMaterial(mt);
    return HttpResponse.json({
      author: db.mockAuthor,
      id,
      name,
      privacy,
      questions: questions.map(learnerView),
      updatedAt: mt.updatedAt,
    });
  }),
  http.post('/api/public/quizzes/:token/grade', async ({ params, request }) => {
    const mt = anonymousMaterial(String(params.token), 'quiz');
    if (!mt)
      return HttpResponse.json({ message: 'not found' }, { status: 404 });
    const body = (await request.json()) as GradeOneBody;
    return gradeOne(db.quizFromMaterial(mt).questions, body);
  }),
  http.get('/api/public/flashcards/:token', ({ params }) => {
    const mt = anonymousMaterial(String(params.token), 'flashcards');
    if (!mt)
      return HttpResponse.json({ message: 'not found' }, { status: 404 });
    const set = db.flashcardSetFromMaterial(mt);
    return HttpResponse.json({
      author: db.mockAuthor,
      cards: db
        .cardsFromMaterial(mt)
        .filter(({ back, front }) => front.trim() || back.trim())
        .map(({ back, front, id, image }) => ({ back, front, id, image })),
      color: set.color,
      id: set.id,
      name: set.name,
      privacy: set.privacy,
      updatedAt: mt.updatedAt,
    });
  }),
  http.get('/api/public/notes/:token', ({ params }) => {
    const mt = anonymousMaterial(String(params.token), 'note');
    if (!mt)
      return HttpResponse.json({ message: 'not found' }, { status: 404 });
    return HttpResponse.json({
      author: db.mockAuthor,
      content: mt.content,
      embeds: noteEmbeds(mt).map((child) =>
        child.kind === 'quiz'
          ? {
              id: child.id,
              kind: 'quiz',
              questions: db.quizFromMaterial(child).questions.map(learnerView),
            }
          : {
              cards: db
                .cardsFromMaterial(child)
                .filter(({ back, front }) => front.trim() || back.trim())
                .map(({ back, front, id, image }) => ({
                  back,
                  front,
                  id,
                  image,
                })),
              id: child.id,
              kind: 'flashcards',
            }
      ),
      id: mt.id,
      name: mt.title,
      privacy: mt.privacy,
      updatedAt: mt.updatedAt,
    });
  }),
  http.post(
    '/api/public/notes/:token/quizzes/:quizId/grade',
    async ({ params, request }) => {
      const note = anonymousMaterial(String(params.token), 'note');
      const quiz =
        note && noteEmbeds(note).find((child) => child.id === params.quizId);
      if (quiz?.kind !== 'quiz')
        return HttpResponse.json({ message: 'not found' }, { status: 404 });
      const body = (await request.json()) as GradeOneBody;
      return gradeOne(db.quizFromMaterial(quiz).questions, body);
    }
  ),

  /* ---------------- global search ---------------- */
  http.get('/api/search', async ({ request }) => {
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
          href: `/workspaces/${w.id}`,
          iconId: w.iconId,
          id: w.id,
          kind: 'workspace',
          subtitle: w.tags.map((t) => t.value).join(' · '),
          title: w.name,
        });
    for (const f of db.files)
      if (f.name.toLowerCase().includes(q)) {
        const ws = db.workspaces.find((w) => w.id === f.workspaceId);
        results.push({
          fileKind: f.kind,
          href: `/workspaces/${f.workspaceId}?file=${f.id}`,
          id: f.id,
          kind: 'file',
          preview: f.preview,
          subtitle: ws?.name,
          thumbnailUrl: f.thumbnailUrl,
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
    // Embedded sets live only inside their note, as on the server.
    for (const mt of db.flashcardSetMaterials())
      if (!mt.parentMaterialId && mt.title.toLowerCase().includes(q))
        results.push({
          color: mt.color,
          href: `/flashcards/${mt.id}`,
          id: mt.id,
          kind: 'flashcards',
          subtitle: mt.workspaceName,
          title: mt.title,
        });
    return HttpResponse.json(results.slice(0, 20));
  }),

  /* ---------------- notifications ---------------- */
  http.get('/api/notifications', async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const limit = Math.min(Number(params.get('limit') ?? 50), 100);
    const before = Number(params.get('before') ?? 0);
    const start = Number.isFinite(before) && before > 0 ? before : 0;
    const items = db.notifications.slice(start, start + limit);
    const next =
      start + limit < db.notifications.length
        ? String(start + limit)
        : undefined;
    return HttpResponse.json({ items, ...(next ? { next } : {}) });
  }),
  http.get('/api/notifications/unread-count', async () =>
    HttpResponse.json({
      count: db.notifications.filter((notification) => !notification.readAt)
        .length,
    })
  ),
  http.post('/api/notifications/:id/read', async ({ params }) => {
    const notification = db.notifications.find((item) => item.id === params.id);
    if (notification) notification.readAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/notifications/read', async () => {
    const readAt = new Date().toISOString();
    db.notifications.forEach((notification) => {
      notification.readAt ??= readAt;
    });
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/notification-prefs', async () =>
    HttpResponse.json(db.notificationPrefs)
  ),
  http.patch('/api/notification-prefs', async ({ request }) => {
    Object.assign(
      db.notificationPrefs,
      (await request.json()) as typeof db.notificationPrefs
    );
    return HttpResponse.json(db.notificationPrefs);
  }),

  /* ---------------- tags ---------------- */
  http.get('/api/tags', async ({ request }) => {
    const kind = new URL(request.url).searchParams.get('kind');
    if (!kind) return HttpResponse.json([]);
    const list = db.tagCatalog
      .filter((t) => t.kind === kind)
      .map((t) => ({ id: t.id, value: t.value }))
      .sort((a, b) => a.value.localeCompare(b.value));
    return HttpResponse.json(list as Tag[]);
  }),

  /* ---------------- workspaces ---------------- */
  // TODO response/request/schema model is different
  http.get('/api/workspaces', async ({ request }) =>
    HttpResponse.json(db.listWorkspaces(new URL(request.url)))
  ),
  http.get('/api/workspaces/:id', async ({ params }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) {
      // A public workspace reads like the server's, for any signed-in visitor.
      const shared = db.publicWorkspaces.find((w) => w.id === params.id);
      return shared
        ? HttpResponse.json(shared)
        : new HttpResponse(null, { status: 404 });
    }
    return HttpResponse.json(ws);
  }),
  http.post('/api/workspaces/:id/visit', ({ params }) => {
    db.visits.set(String(params.id), new Date().toISOString());
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete('/api/workspaces/:id/visit', ({ params }) => {
    db.visits.delete(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/files/:id/process-changes', ({ params }) => {
    const id = String(params.id);
    const change = db.fileChanges.get(id);
    if (!change) return codeError(409, 'nothing_to_process');
    if (change.state === 'waiting' || change.state === 'failed')
      Object.assign(change, { state: 'queued', ticks: 0 });
    return HttpResponse.json(
      { checkpoint: 1, fileId: id, jobId: uid('job'), status: 'pending' },
      { status: 202 }
    );
  }),
  // A note's Process queues its index job now, whatever its threshold.
  http.post('/api/materials/:id/process-changes', ({ params }) => {
    const change = db.noteChanges.get(String(params.id));
    if (!change) return codeError(409, 'nothing_to_process');
    if (change.state !== 'waiting' && change.state !== 'failed')
      return codeError(409, 'processing_started');
    Object.assign(change, { state: 'queued', ticks: 0 });
    return new HttpResponse(null, { status: 202 });
  }),
  // Retry processing: the owner reruns a failed file on its stored bytes; the
  // mock worker finishes it like an upload ('none' just stores it).
  http.post('/api/files/:id/retry-processing', async ({ params, request }) => {
    const file = db.files.find((item) => item.id === params.id);
    if (!file) return new HttpResponse(null, { status: 404 });
    if (file.status !== 'failed') return codeError(409, 'conflict');
    const { parseMode } = (await request.json()) as { parseMode: string };
    file.status = 'pending';
    // The server sends an error id on failed files only.
    delete file.errorId;
    setTimeout(() => {
      file.status = 'ready';
      file.indexed = parseMode !== 'none' && file.kind !== 'audio';
    }, 2000);
    return new HttpResponse(null, { status: 202 });
  }),
  http.delete('/api/files/:id/process-changes', ({ params }) => {
    const change = db.fileChanges.get(String(params.id));
    if (!change) return codeError(409, 'nothing_to_process');
    if (change.state !== 'queued') return codeError(409, 'processing_started');
    Object.assign(change, { state: 'waiting', ticks: 0 });
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/workspaces/:id/stats', async ({ params }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const wsQuizIds = new Set(
      db
        .quizMaterials()
        .filter((m) => m.workspaceId === ws.id)
        .map((m) => m.id)
    );
    const att = db.attempts.filter(
      (a) => a.materialId !== null && wsQuizIds.has(a.materialId)
    );
    const avg = att.length
      ? Math.round(att.reduce((s, a) => s + a.pct, 0) / att.length)
      : 0;
    const sourceFiles = db.files.filter((file) => file.workspaceId === ws.id);
    const indexed = sourceFiles.filter((file) => file.indexed).length;
    const notIndexable = sourceFiles.filter(
      (file) =>
        !file.indexed &&
        (file.kind === 'unknown' ||
          ['doc', 'xls', 'ppt'].includes(
            file.name.split('.').pop()?.toLowerCase() ?? ''
          ))
    ).length;
    return HttpResponse.json({
      attempts: att.length,
      avgScore: avg,
      fileChanges: advanceChanges(sourceFiles, db.fileChanges).map(
        ({ change, item }) => ({
          ...(change.state === 'failed' && { errorId: change.errorId }),
          fileId: item.id,
          kind: item.kind,
          lastEditedAt: change.lastEditedAt,
          name: item.name,
          state: change.state,
        })
      ),
      files: ws.fileCount,
      indexed,
      moreNoteChanges: 0,
      noteChanges: advanceChanges(
        db.materials.filter(
          (item) => item.workspaceId === ws.id && item.kind === 'note'
        ),
        db.noteChanges
      ).map(({ change, item }) => ({
        ...(change.state === 'failed' && { errorId: change.errorId }),
        lastEditedAt: change.lastEditedAt,
        materialId: item.id,
        state: change.state,
        title: item.title,
      })),
      notIndexable,
      notIndexed: sourceFiles.length - indexed - notIndexable,
      quizzes: wsQuizIds.size,
      topics: ws.topicCount,
    });
  }),
  http.post('/api/workspaces', async ({ request }) => {
    const body = (await request.json()) as Partial<Workspace> & {
      tags?: TagInput[];
    };
    if (atWorkspaceCap()) return workspaceLimitResponse();
    const id = uid('ws');
    const ws: Workspace = {
      autoProcess: true,
      canClone: true,
      capabilities: {
        canEdit: true,
        canEditContent: true,
        canManageMembers: true,
        canView: true,
      },
      createdAt: new Date().toISOString(),
      description: body.description ?? '',
      fileCount: 0,
      filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
      iconId:
        body.iconId ??
        `waves-${String(Math.floor(Math.random() * 11) + 1).padStart(2, '0')}`,
      id,
      isOwner: true,
      kind: body.kind ?? 'personal',
      name: body.name ?? 'Untitled workspace',
      privacy: 'private',
      role: 'owner',
      sharePath: await sharePath(DEV_SHARE_LINK_SECRET, id),
      shareRole: 'viewer',
      tags: resolveTags('workspace', body.tags),
      topicCount: 0,
    };
    db.workspaces.unshift(ws);
    return HttpResponse.json(ws, { status: 201 });
  }),
  http.patch('/api/workspaces/:id', async ({ params, request }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<Workspace> & {
      tags?: TagInput[];
      clearCover?: boolean;
    };
    // Auto process and the kind are the owner's alone; the gateway answers
    // others 404.
    if (body.autoProcess !== undefined || body.kind !== undefined) {
      if (!ws.isOwner) return new HttpResponse(null, { status: 404 });
      ws.autoProcess = body.autoProcess ?? ws.autoProcess;
      ws.kind = body.kind ?? ws.kind;
    }
    if (body.tags !== undefined) ws.tags = resolveTags('workspace', body.tags);
    if (body.name !== undefined) ws.name = body.name;
    if (body.description !== undefined) ws.description = body.description;
    if (body.iconId !== undefined) ws.iconId = body.iconId;
    if (body.cover !== undefined) ws.cover = body.cover;
    if (body.clearCover) ws.cover = undefined;
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
    const ws = db.workspaces.find((workspace) => workspace.id === params.id);
    const collaborators = mockWorkspaceMembers.filter(
      (member) => member.workspaceId === workspaceId
    );
    if (ws?.role === 'owner') {
      return HttpResponse.json([
        {
          createdAt: ws.createdAt,
          email: db.user.email,
          name: db.user.name,
          role: 'owner' as const,
          userId: db.user.id,
          workspaceId,
        },
        ...collaborators,
      ]);
    }
    return HttpResponse.json(collaborators);
  }),
  http.get('/api/workspaces/:id/collaborators', async ({ params }) => {
    const workspaceId = String(params.id);
    const ws = db.workspaces.find((workspace) => workspace.id === params.id);
    const directory = mockWorkspaceMembers
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => ({
        avatarUrl: member.avatarUrl,
        name: member.name,
        userId: member.userId,
      }));
    if (ws?.role === 'owner') {
      return HttpResponse.json([
        { name: db.user.name, userId: db.user.id },
        ...directory,
      ]);
    }
    return HttpResponse.json(directory);
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
    const typed = body.identifier.trim();
    const now = new Date();
    const fields = {
      email: typed,
      expiresAt: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString(),
      invitedUserId: candidate && !alreadyMember ? candidate.id : '',
      role: body.role,
      sentAt: now.toISOString(),
      token: uid('invite-token'),
    };
    // Every typed address keeps one pending row; typing it again refreshes it.
    let invite = mockWorkspaceInvites.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.email.toLowerCase() === identifier &&
        !item.acceptedAt &&
        !item.revokedAt
    );
    if (invite) Object.assign(invite, fields);
    else {
      invite = { ...fields, id: uid('inv'), workspaceId };
      mockWorkspaceInvites.push(invite);
    }
    if (invite.invitedUserId === db.user.id) {
      const href = `/workspace-invites/${invite.id}`;
      const workspaceName =
        db.workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
        'this workspace';
      const existingNotification = db.notifications.find(
        (notification) =>
          notification.data &&
          typeof notification.data === 'object' &&
          (notification.data as { inviteId?: string }).inviteId === invite.id
      );
      if (existingNotification) {
        Object.assign(existingNotification, {
          at: now.toISOString(),
          data: { inviteId: invite.id, workspaceName },
          href,
          readAt: undefined,
        });
      } else {
        db.notifications.unshift({
          at: now.toISOString(),
          data: { inviteId: invite.id, workspaceName },
          href,
          id: uid('notification'),
          kind: 'workspace_invite',
        });
      }
    }
    return new HttpResponse(null, { status: 202 });
  }),
  http.get('/api/workspaces/:id/invites', ({ params }) =>
    HttpResponse.json(
      mockWorkspaceInvites
        .filter((item) => item.workspaceId === params.id && pendingInvite(item))
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .map((item) => ({
          address: item.email,
          expiresAt: item.expiresAt,
          id: item.id,
          sentAt: item.sentAt,
        }))
    )
  ),
  http.delete('/api/workspaces/:id/invites/:inviteId', ({ params }) => {
    const invite = mockWorkspaceInvites.find(
      (item) =>
        item.id === params.inviteId &&
        item.workspaceId === params.id &&
        pendingInvite(item)
    );
    if (!invite) return new HttpResponse(null, { status: 404 });
    invite.revokedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
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
      const workspaceName =
        db.workspaces.find((workspace) => workspace.id === params.id)?.name ??
        'this workspace';
      if (params.memberId === db.user.id) {
        db.notifications.unshift({
          at: new Date().toISOString(),
          data: {
            role: body.role,
            workspaceId: params.id,
            workspaceName,
          },
          href: `/workspaces/${params.id}`,
          id: uid('notification'),
          kind: 'workspace_role_changed',
        });
      }
      return new HttpResponse(null, { status: 204 });
    }
  ),
  http.delete('/api/workspaces/:id/members/:memberId', async ({ params }) => {
    // Removing yourself is leaving: the workspace drops out of your list and
    // nobody is notified, as on the server. Only members are offered Leave;
    // the member scenarios keep the fixture's owner flag, so it is not read.
    if (params.memberId === db.user.id) {
      const left = db.workspaces.findIndex((w) => w.id === params.id);
      if (left < 0) return new HttpResponse(null, { status: 404 });
      db.workspaces.splice(left, 1);
      return new HttpResponse(null, { status: 204 });
    }
    const index = mockWorkspaceMembers.findIndex(
      (item) =>
        item.workspaceId === params.id && item.userId === params.memberId
    );
    if (index < 0) return new HttpResponse(null, { status: 404 });
    mockWorkspaceMembers.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/workspaces/:id/transfer', async ({ params, request }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as { recipientId?: string };
    if (!body.recipientId || body.recipientId === db.user.id) {
      return HttpResponse.json(
        { message: 'cannot transfer to yourself' },
        { status: 409 }
      );
    }
    const recipient = mockWorkspaceMembers.find(
      (member) =>
        member.workspaceId === params.id && member.userId === body.recipientId
    );
    if (!recipient) return new HttpResponse(null, { status: 404 });
    recipient.role = 'owner';
    const alreadyListed = mockWorkspaceMembers.some(
      (member) =>
        member.workspaceId === params.id && member.userId === db.user.id
    );
    if (!alreadyListed) {
      mockWorkspaceMembers.push({
        createdAt: new Date().toISOString(),
        name: db.user.name,
        role: 'editor',
        userId: db.user.id,
        workspaceId: String(params.id),
      });
    }
    ws.role = 'editor';
    ws.capabilities = {
      canEdit: true,
      canEditContent: true,
      canManageMembers: false,
      canView: true,
    };
    return HttpResponse.json(ws);
  }),
  http.post('/api/workspace-invites/:token/accept', async ({ params }) => {
    const invite = mockWorkspaceInvites.find(
      (item) =>
        (item.id === params.token || item.token === params.token) &&
        pendingInvite(item)
    );
    if (!invite) return new HttpResponse(null, { status: 404 });
    if (!db.workspaces.some((workspace) => workspace.id === invite.workspaceId))
      return new HttpResponse(null, { status: 404 });
    // Someone else's invite answers like a missing one, as on the server.
    if (invite.invitedUserId !== db.user.id) {
      return new HttpResponse(null, { status: 404 });
    }
    // A role change adds no workspace; a new membership counts.
    const joined = db.workspaces.some(
      (w) => w.id === invite.workspaceId && (w.isOwner || w.role)
    );
    if (!joined && atWorkspaceCap()) return workspaceLimitResponse();
    invite.acceptedAt = new Date().toISOString();
    const candidate = mockInviteCandidates.find(
      (item) => item.id === invite.invitedUserId
    );
    const member: WorkspaceMember = {
      avatarUrl: candidate?.avatarUrl,
      createdAt: invite.acceptedAt,
      name: candidate?.name ?? invite.invitedUserId,
      role: invite.role,
      userId: invite.invitedUserId,
      workspaceId: invite.workspaceId,
    };
    mockWorkspaceMembers.push(member);
    const notificationIndex = db.notifications.findIndex(
      (notification) => notification.href === `/workspace-invites/${invite.id}`
    );
    if (notificationIndex >= 0) db.notifications.splice(notificationIndex, 1);
    return HttpResponse.json(member);
  }),
  http.delete('/api/workspaces/:id', async ({ params }) => {
    const i = db.workspaces.findIndex((w) => w.id === params.id);
    if (i >= 0) db.workspaces.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  // A share link presented once (the server remembers the grant).
  http.post('/api/share/redeem', async ({ request }) => {
    const { token } = (await request.json()) as { token: string };
    const id = token.split('.')[0];
    if (
      db.workspaces.some((row) => row.id === id) ||
      db.publicWorkspaces.some((row) => row.id === id)
    )
      return HttpResponse.json({ id, kind: 'workspace' });
    const material = db.materials.find(
      (row) => row.id === id && !row.workspaceId
    );
    return material
      ? HttpResponse.json({
          id,
          kind: 'material',
          materialKind: material.kind,
        })
      : new HttpResponse(null, { status: 404 });
  }),
  http.post('/api/workspaces/:id/clone', async ({ params, request }) => {
    if (atWorkspaceCap()) return workspaceLimitResponse();
    const body = (await request.json()) as CreateWorkspaceReq;
    const source =
      db.workspaces.find((w) => w.id === params.id) ??
      db.publicWorkspaces.find((w) => w.id === params.id);
    if (!source) return new HttpResponse(null, { status: 404 });
    const newId = uid('ws');
    const workspace: Workspace = {
      ...source,
      cover: body.cover,
      createdAt: new Date().toISOString(),
      description: body.description ?? '',
      iconId: body.iconId ?? source.iconId,
      id: newId,
      isOwner: true,
      // As the server: an owner's or editor's copy keeps its kind.
      kind:
        source.role === 'owner' || source.role === 'editor'
          ? source.kind
          : 'personal',
      name: body.name,
      privacy: 'private',
      sharePath: await sharePath(DEV_SHARE_LINK_SECRET, newId),
      tags: resolveTags('workspace', body.tags),
    };
    db.workspaces.unshift(workspace);

    const topicMap = new Map<string, string>();
    db.topics
      .filter((topic) => topic.workspaceId === source.id)
      .forEach((topic) => {
        const id = uid('tp');
        topicMap.set(topic.id, id);
        db.topics.push({ ...topic, fileIds: [], id, workspaceId: newId });
      });
    const fileMap = new Map<string, string>();
    db.files
      .filter((file) => file.workspaceId === source.id)
      .forEach((file) => {
        const id = uid('f');
        fileMap.set(file.id, id);
        const links = db.fileLinks[file.id];
        if (links) db.fileLinks[id] = { ...links };
        db.files.push({
          ...file,
          id,
          topicId: file.topicId ? (topicMap.get(file.topicId) ?? null) : null,
          workspaceId: newId,
        });
      });
    db.materials
      .filter((material) => material.workspaceId === source.id)
      .forEach((material) => {
        const materialId = uid('mat');
        const clonedCards =
          material.kind === 'flashcards'
            ? materialCards(material).map((card) => ({
                ...card,
                id: uid('c'),
              }))
            : [];
        const cloned = {
          ...material,
          content:
            material.kind === 'flashcards'
              ? flashcardsDocument(clonedCards, materialId)
              : structuredClone(material.content),
          createdAt: new Date().toISOString(),
          id: materialId,
          privacy: 'private',
          scopeFileNames: material.scopeFileNames,
          topicId: material.topicId
            ? (topicMap.get(material.topicId) ?? null)
            : null,
          workspaceId: newId,
          workspaceName: workspace.name,
        } satisfies Material;
        db.refreshMaterialContentBytes(cloned);
        db.materials.push(cloned);
        for (const card of clonedCards) {
          db.flashcardCards[card.id] = { materialId };
        }
      });
    return HttpResponse.json(
      { skippedMaterials: 0, workspace },
      { status: 201 }
    );
  }),
  http.post('/api/files/:id/clone', async ({ params, request }) => {
    const body = (await request.json()) as CloneFileReq;
    const source = db.files.find((file) => file.id === params.id);
    // No workspaceId: a standalone copy.
    const workspaceId = body.workspaceId ?? '';
    if (
      !source ||
      (workspaceId && !db.workspaces.some((ws) => ws.id === workspaceId))
    )
      return new HttpResponse(null, { status: 404 });
    const id = uid('f');
    const links = db.fileLinks[source.id];
    if (links) db.fileLinks[id] = { ...links };
    const file = {
      ...source,
      addedAt: new Date().toISOString(),
      id,
      // The cloner pays for the copy.
      isPayer: true,
      name: body.name.trim(),
      topicId: workspaceId ? mockCloneTopic(workspaceId, body) : null,
      workspaceId,
    };
    db.files.push(file);
    return HttpResponse.json(file, { status: 201 });
  }),
  http.post('/api/workspaces/:id/files/blank', async ({ params, request }) => {
    const body = (await request.json()) as CreateBlankFileReq;
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const topicId = body.topicId ?? null;
    const url = blankOffice[body.format].sourceURL;
    const file: (typeof db.files)[number] = {
      addedAt: new Date().toISOString(),
      hasBytes: true,
      id: uid('f'),
      indexed: false,
      isPayer: true,
      kind: body.format === 'docx' ? 'doc' : 'sheet',
      name: `${body.name.trim()}.${body.format}`,
      position: db.nextContentPosition(ws.id, topicId),
      revision: 1,
      sizeBytes: (await (await fetch(url)).arrayBuffer()).byteLength,
      status: 'ready',
      topicId,
      workspaceId: ws.id,
    };
    db.fileLinks[file.id] = { url };
    await prepareBlankOffice(file.id, body.format);
    db.files.push(file);
    ws.fileCount += 1;
    if (topicId) db.topics.find((c) => c.id === topicId)?.fileIds.push(file.id);
    return HttpResponse.json(file, { status: 201 });
  }),
  // Move into a workspace: the first move of f_1 out of Biology asks about
  // the progress it drops, so the confirmation can be tried.
  http.post('/api/files/move', async ({ request }) => {
    const body = (await request.json()) as MoveFilesReq;
    const target = db.workspaces.find((ws) => ws.id === body.workspaceId);
    const files = (body.fileIds ?? []).map((id) =>
      db.files.find((file) => file.id === id)
    );
    if (!target || files.some((file) => !file))
      return new HttpResponse(null, { status: 404 });
    const moving = files.filter((file) => file !== undefined);
    if (moving.some((file) => file.workspaceId === target.id))
      return HttpResponse.json(
        { errors: [{ message: 'conflict' }] },
        { status: 409 }
      );
    if (
      moving.some(
        (file) =>
          file.status && file.status !== 'ready' && file.status !== 'failed'
      )
    )
      return HttpResponse.json(
        { errors: [{ message: 'file_processing' }] },
        { status: 409 }
      );
    const topicId = mockCloneTopic(target.id, body);
    for (const file of moving) {
      const source = db.workspaces.find((ws) => ws.id === file.workspaceId);
      if (source) source.fileCount = Math.max(0, source.fileCount - 1);
      for (const c of db.topics)
        c.fileIds = c.fileIds.filter((id) => id !== file.id);
      file.workspaceId = target.id;
      if (file.workspaceName !== undefined) file.workspaceName = target.name;
      file.topicId = topicId;
      if (topicId)
        db.topics.find((c) => c.id === topicId)?.fileIds.push(file.id);
      target.fileCount += 1;
    }
    return HttpResponse.json(moving);
  }),
  /* ---------------- topics & files ---------------- */
  http.get('/api/workspaces/:id/topics', async ({ params }) =>
    HttpResponse.json(
      db.topics
        .filter((c) => c.workspaceId === params.id)
        .sort((a, b) => a.order - b.order)
    )
  ),
  http.post('/api/workspaces/:id/topics', async ({ params, request }) => {
    const body = (await request.json()) as {
      description?: string;
      name: string;
    };
    const order = db.topics.filter((c) => c.workspaceId === params.id).length;
    const ch: Topic = {
      description: body.description ?? '',
      fileIds: [],
      id: uid('tp'),
      name: body.name,
      order,
      workspaceId: String(params.id),
    };
    db.topics.push(ch);
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (ws) ws.topicCount += 1;
    return HttpResponse.json(ch, { status: 201 });
  }),
  http.patch('/api/topics/:id', async ({ params, request }) => {
    const ch = db.topics.find((c) => c.id === params.id);
    if (!ch) return new HttpResponse(null, { status: 404 });
    Object.assign(ch, await request.json());
    return HttpResponse.json(ch);
  }),
  http.post('/api/workspaces/:id/topics/reorder', async ({ request }) => {
    const body = (await request.json()) as { ids: string[] };
    body.ids.forEach((id, idx) => {
      const ch = db.topics.find((c) => c.id === id);
      if (ch) ch.order = idx;
    });
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(
    '/api/workspaces/:id/content/reorder',
    async ({ params, request }) => {
      const body = (await request.json()) as {
        topicId: string | null;
        items: { id: string; type: 'file' | 'material' }[];
      };
      body.items.forEach((item, position) => {
        if (item.type === 'file') {
          db.topics.forEach((topic) => {
            topic.fileIds = topic.fileIds.filter((id) => id !== item.id);
          });
          if (body.topicId) {
            db.topics
              .find((topic) => topic.id === body.topicId)
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
          content.topicId = body.topicId;
          content.position = position;
        }
      });
      return new HttpResponse(null, { status: 204 });
    }
  ),
  http.delete('/api/topics/:id', async ({ params }) => {
    const i = db.topics.findIndex((c) => c.id === params.id);
    if (i >= 0) {
      // keep files — just unfile them
      db.files.forEach((f) => {
        if (f.topicId === params.id) f.topicId = null;
      });
      db.materials.forEach((material) => {
        if (material.topicId === params.id) material.topicId = null;
      });
      db.topics.splice(i, 1);
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/files', async ({ request }) => {
    const { asc, limit, list, offset, sort } = listParams(request.url);
    const kinds = list('kind');
    const wsIds = list('workspaceId');
    const locations = list('location');
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? '';
    const rows = db.files
      .filter(
        (f) =>
          (!q || f.name.toLowerCase().includes(q)) &&
          (!kinds.length || kinds.includes(f.kind)) &&
          (!wsIds.length || wsIds.includes(f.workspaceId)) &&
          (!locations.length ||
            locations.includes(f.workspaceId ? 'workspace' : 'standalone'))
      )
      .sort(
        sortBy(
          (f) =>
            sort === 'name'
              ? f.name.toLowerCase()
              : sort === 'size'
                ? f.sizeBytes
                : sort === 'kind'
                  ? f.kind
                  : sort === 'workspace'
                    ? (db.workspaces
                        .find((ws) => ws.id === f.workspaceId)
                        ?.name.toLowerCase() ?? '')
                    : f.addedAt,
          asc
        )
      );
    // The mock user owns every mock workspace, so each row allows everything.
    return HttpResponse.json({
      items: rows.slice(offset, offset + limit).map((f) => ({
        ...f,
        rights: { clone: true, move: true, rename: true, trash: true },
      })),
      nextCursor:
        offset + limit < rows.length ? String(offset + limit) : undefined,
    });
  }),
  http.get('/api/recent', async ({ request }) =>
    HttpResponse.json(recentFor(request.url, 'owner'))
  ),
  http.post('/api/files/:id/open', ({ params }) => {
    db.itemOpens.set(`file:${params.id}`, new Date().toISOString());
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/materials/:id/open', ({ params }) => {
    db.itemOpens.set(`material:${params.id}`, new Date().toISOString());
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/workspaces/:id/files', async ({ params }) =>
    HttpResponse.json(db.files.filter((f) => f.workspaceId === params.id))
  ),
  // The Dashboard: the owner, the roster's size and the newest files and
  // materials; the mock credits them to the roster in turn and its first
  // flashcard set to the agent.
  http.get('/api/workspaces/:id/dashboard', async ({ params }) => {
    const ws = db.workspaces.find((w) => w.id === params.id);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const roster = [
      { avatarUrl: db.user.avatarUrl, name: db.user.name, userId: db.user.id },
      ...mockWorkspaceMembers.filter((mb) => mb.workspaceId === ws.id),
    ];
    const all: WorkspaceActivity[] = [
      ...db.files
        .filter((f) => f.workspaceId === ws.id)
        .map(
          (f): WorkspaceActivity => ({
            at: f.addedAt,
            fileId: f.id,
            hidden: f.hidden,
            kind: 'uploaded',
            title: f.name,
          })
        ),
      ...db.materials
        .filter((mt) => mt.workspaceId === ws.id && !mt.parentMaterialId)
        .map(
          (mt): WorkspaceActivity => ({
            at: mt.createdAt,
            hidden: mt.hidden,
            kind: mt.kind === 'flashcards' ? 'agent' : 'added',
            materialId: mt.id,
            title: mt.title,
          })
        ),
      ...assignmentActivity(ws.id),
    ].sort(sortBy((row) => row.at, false));
    // The newest four, plus the newest agent-made set so its row shows as on
    // the boards (H2); the server takes the newest five.
    const agent = all.find((row) => row.kind === 'agent');
    const rows = [
      ...all.filter((row) => row !== agent).slice(0, agent ? 4 : 5),
      ...(agent ? [agent] : []),
    ]
      .sort(sortBy((row) => row.at, false))
      .map((row, i) => {
        const actor =
          row.kind === 'agent' || row.kind === 'assigned'
            ? roster[0]
            : roster[i % roster.length];
        return {
          ...row,
          actorAvatarUrl: actor.avatarUrl,
          actorId: actor.userId,
          actorName: actor.name,
        };
      });
    return HttpResponse.json({
      activity: rows,
      members: roster.length,
      ownerName:
        ws.role === 'owner' ? db.user.name : (roster[1]?.name ?? db.user.name),
    } satisfies WorkspaceDashboard);
  }),
  http.get('/api/workspaces/:id/recent', async ({ params }) =>
    HttpResponse.json({
      files: db.files
        .filter((f) => f.workspaceId === params.id)
        .sort(sortBy((f) => f.addedAt, false))
        .slice(0, 4),
      materials: db.materials
        .filter((mt) => mt.workspaceId === params.id && !mt.parentMaterialId)
        .sort(sortBy((mt) => mt.createdAt, false))
        .slice(0, 4)
        .map(db.materialListItem),
    })
  ),
  http.get('/api/files/:id', async ({ params }) => {
    const f = db.files.find((x) => x.id === params.id);
    return f ? HttpResponse.json(f) : new HttpResponse(null, { status: 404 });
  }),
  http.get('/api/files/:id/links', async ({ params }) => {
    const links = db.fileLinks[String(params.id)];
    if (!links) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      ...links,
    });
  }),
  http.patch('/api/files/:id', async ({ params, request }) => {
    const f = db.files.find((x) => x.id === params.id);
    if (!f) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<
      Pick<SourceFile, 'name' | 'topicId'>
    >;
    if (body.name !== undefined) f.name = body.name;
    if (body.topicId !== undefined) {
      // Empty-string sentinel unfiles (mirrors the Go gateway).
      const next = body.topicId === '' ? null : body.topicId;
      for (const c of db.topics)
        c.fileIds = c.fileIds.filter((id) => id !== f.id);
      f.topicId = next;
      if (next) db.topics.find((c) => c.id === next)?.fileIds.push(f.id);
    }
    return HttpResponse.json(f);
  }),
  // A browser capture of an edited Office file: the cards show it from here.
  http.post('/api/files/:id/thumbnail', async ({ params, request }) => {
    const f = db.files.find((x) => x.id === params.id);
    if (!f) return new HttpResponse(null, { status: 404 });
    const bytes = await request.arrayBuffer();
    f.thumbnailUrl = URL.createObjectURL(
      new Blob([bytes], { type: 'image/webp' })
    );
    clearMockThumbnailStale(f.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete('/api/files/:id', async ({ params }) => {
    const i = db.files.findIndex((x) => x.id === params.id);
    if (i >= 0) {
      const [removed] = db.files.splice(i, 1);
      const ws = db.workspaces.find((w) => w.id === removed.workspaceId);
      if (ws) ws.fileCount = Math.max(0, ws.fileCount - 1);
      for (const ch of db.topics)
        ch.fileIds = ch.fileIds.filter((id) => id !== removed.id);
      db.trash.unshift({
        file: removed,
        item: trashItem({
          fileKind: removed.kind,
          id: removed.id,
          kind: 'source_file',
          preview: removed.preview,
          sizeBytes: removed.sizeBytes,
          thumbnailUrl: removed.thumbnailUrl,
          title: removed.name,
          workspaceId: removed.workspaceId,
          workspaceName: ws?.name,
        }),
      });
    }
    return new HttpResponse(null, { status: 204 });
  }),
  /* ---------------- trash (owner-only bin) ---------------- */
  http.get('/api/trash', async ({ request }) => {
    const { limit, offset, param } = listParams(request.url);
    const wsId = param('workspaceId');
    const items = db.trash
      .filter((entry) => !wsId || entry.item.workspaceId === wsId)
      .map((entry) => entry.item);
    return HttpResponse.json({
      items: items.slice(offset, offset + limit),
      nextCursor:
        offset + limit < items.length ? String(offset + limit) : undefined,
    });
  }),
  http.post('/api/trash/:kind/:id/restore', async ({ params, request }) => {
    const body = (await request.json()) as { episodeId: string };
    const i = db.trash.findIndex(
      (entry) =>
        entry.item.id === params.id && entry.item.episodeId === body.episodeId
    );
    if (i < 0) return new HttpResponse(null, { status: 404 });
    const [entry] = db.trash.splice(i, 1);
    if (entry.file) {
      db.files.push(entry.file);
      const ws = db.workspaces.find((w) => w.id === entry.file?.workspaceId);
      if (ws) ws.fileCount += 1;
      const ch = db.topics.find((c) => c.id === entry.file?.topicId);
      if (ch) ch.fileIds.push(entry.file.id);
    }
    if (entry.material) db.materials.push(entry.material);
    return HttpResponse.json({
      effect: {
        operation: 'restored',
        resource: {
          id: entry.item.id,
          kind: entry.item.kind,
          title: entry.item.title,
          workspaceId: entry.item.workspaceId,
        },
      },
      kind: 'restore',
      operationId: uid('op'),
      outcome: 'succeeded',
      toolVersion: 1,
    });
  }),
  http.delete('/api/trash/:kind/:id', async ({ params, request }) => {
    const episodeId = new URL(request.url).searchParams.get('episodeId');
    const i = db.trash.findIndex(
      (entry) =>
        entry.item.id === params.id && entry.item.episodeId === episodeId
    );
    if (i < 0) return new HttpResponse(null, { status: 404 });
    db.trash.splice(i, 1);
    return HttpResponse.json({
      kind: 'purge',
      operationId: uid('op'),
      outcome: 'succeeded',
      toolVersion: 1,
    });
  }),
  /* ---------------- study materials ---------------- */
  http.get('/api/materials', async ({ request }) => {
    const { asc, limit, list, offset, sort } = listParams(request.url);
    const kinds = list('kind');
    const wsIds = list('workspaceId');
    const locations = list('location');
    const allowed = kinds.length ? kinds : ['note', 'quiz', 'flashcards'];
    const rows = db.materials
      .filter((mt) => {
        if (!allowed.includes(mt.kind)) return false;
        if (wsIds.length && !wsIds.includes(mt.workspaceId)) return false;
        // Embedded items live only inside their note.
        if (mt.parentMaterialId) return false;
        const location = mt.workspaceId ? 'workspace' : 'standalone';
        return !locations.length || locations.includes(location);
      })
      .sort(
        sortBy(
          (mt) =>
            sort === 'title'
              ? mt.title.toLowerCase()
              : sort === 'kind'
                ? mt.kind
                : sort === 'created'
                  ? mt.createdAt
                  : sort === 'workspace'
                    ? (mt.workspaceName ?? '').toLowerCase()
                    : mt.updatedAt,
          asc
        )
      );
    return HttpResponse.json({
      items: rows.slice(offset, offset + limit).map((mt) => ({
        ...db.materialListItem(mt),
        ...quizAssignmentFields(mt.id, 'owner'),
      })),
      nextCursor:
        offset + limit < rows.length ? String(offset + limit) : undefined,
    });
  }),
  http.post('/api/materials', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      kind?: Material['kind'];
      title?: string;
      content?: Material['content'];
    };
    if (body.kind !== 'note') {
      return HttpResponse.json(
        { message: 'unsupported material kind' },
        { status: 400 }
      );
    }
    const mt = db.makeMaterial({
      ...ownerMaterialAccess,
      content: body.content ?? emptyMaterialDocument(),
      createdAt: new Date().toISOString(),
      id: uid('mat'),
      kind: 'note',
      privacy: 'private',
      scopeFileNames: [],
      scopeTopics: [],
      title: body.title || copyText(db.user.locale, 'untitled_note'),
      topicId: null,
      workspaceId: '',
      workspaceName: '',
    });
    db.materials.unshift(mt);
    return HttpResponse.json(mt, { status: 201 });
  }),
  http.get('/api/workspaces/:id/materials', async ({ params }) =>
    HttpResponse.json(workspaceMaterialRefs(String(params.id), 'owner'))
  ),
  http.post('/api/workspaces/:id/materials', async ({ params, request }) => {
    const wsId = String(params.id);
    const ws = db.workspaces.find((w) => w.id === wsId);
    const body = (await request.json().catch(() => ({}))) as {
      kind?: Material['kind'];
      title?: string;
      content?: Material['content'];
      scopeTopics?: string[];
      scopeFileNames?: string[];
    };
    if (!body.kind) {
      return HttpResponse.json(
        { message: 'kind is required' },
        { status: 400 }
      );
    }
    const mt = db.makeMaterial({
      ...ownerMaterialAccess,
      content: body.content ?? emptyMaterialDocument(),
      createdAt: new Date().toISOString(),
      id: uid('mat'),
      kind: body.kind,
      privacy: 'private',
      scopeFileNames: body.scopeFileNames ?? [],
      scopeTopics: body.scopeTopics ?? [],
      title: body.title || copyText(db.user.locale, 'untitled_note'),
      topicId: null,
      workspaceId: wsId,
      workspaceName: ws?.name ?? '',
    });
    db.materials.unshift(mt);
    return HttpResponse.json(mt, { status: 201 });
  }),
  http.post('/api/materials/:id/embedded', async ({ params, request }) => {
    const note = db.materials.find(
      (x) => x.id === params.id && x.kind === 'note' && !x.parentMaterialId
    );
    if (!note) return new HttpResponse(null, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as {
      kind?: 'quiz' | 'flashcards';
      questions?: Question[];
      cards?: { front: string; back: string }[];
    };
    if (body.kind !== 'quiz' && body.kind !== 'flashcards') {
      return HttpResponse.json(
        { message: 'unsupported embedded material kind' },
        { status: 400 }
      );
    }
    const block =
      body.kind === 'quiz'
        ? quizNode({
            questions: body.questions ?? [],
          })
        : flashcardsNode(
            (body.cards ?? []).map((card) => ({ ...card, id: uid('c') }))
          );
    const mt = db.makeMaterial({
      ...ownerMaterialAccess,
      content: { schemaVersion: 1, value: [block] },
      createdAt: new Date().toISOString(),
      id: uid('mat'),
      kind: body.kind,
      parentMaterialId: note.id,
      privacy: 'private',
      scopeFileNames: [],
      scopeTopics: [],
      title: crypto.randomUUID(),
      topicId: null,
      workspaceId: note.workspaceId,
      workspaceName: note.workspaceName,
    });
    db.materials.unshift(mt);
    return HttpResponse.json(mt, { status: 201 });
  }),
  http.get('/api/materials/:id', async ({ params, request }) => {
    const fixture = errorMaterials.find((item) => item.id === params.id);
    if (fixture?.failure) {
      return HttpResponse.json(
        {
          detail: 'Mock material could not be loaded.',
          status: 500,
          ...(fixture.failure === 'unreadable'
            ? { errors: [{ message: 'material_content_unreadable' }] }
            : {}),
        },
        { status: 500 }
      );
    }

    await hydrateEditorState(String(params.id));
    const mt = db.materials.find((x) => x.id === params.id);
    if (!mt) return new HttpResponse(null, { status: 404 });
    const read = { ...db.learnerMaterial(mt), sharePath: db.mockSharePath(mt) };
    return HttpResponse.json(
      new URL(request.url).searchParams.get('noContent') === 'true'
        ? { ...read, content: { ...read.content, value: [] } }
        : read
    );
  }),
  http.post('/api/materials/readable', async ({ request }) => {
    const { ids } = (await request.json()) as { ids: string[] };
    return HttpResponse.json({
      ids: ids.filter((id) => db.materials.some((item) => item.id === id)),
    });
  }),
  http.post(
    '/api/materials/:id/collaboration-token',
    async ({ params, request }) => {
      const material = db.materials.find((item) => item.id === params.id);
      if (!material) return new HttpResponse(null, { status: 404 });
      await noteTokenHold(material.id);
      const body = (await request.json().catch(() => null)) as {
        access?: string;
        document?: string;
      } | null;
      const keys = body?.document === 'keys';
      const write = material.capabilities.canEdit && body?.access !== 'read';
      if (keys && material.kind !== 'quiz')
        return new HttpResponse(null, { status: 404 });
      // A quiz's keys go to editors who can write only (Epo 2026-10-10).
      if (keys && !write) return new HttpResponse(null, { status: 403 });
      const room = mockMaterialRoom(material.id);
      // Viewers get read channels (Epo 2026-10-10, D1), as does anyone who
      // asks for one (REVIEW5 N2).
      return HttpResponse.json(
        {
          access: write ? 'write' : 'read',
          expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
          room: keys ? `keys:${room.slice('material:'.length)}` : room,
          token: 'mock-collaboration-token',
          url: 'mock://collaboration',
        },
        { status: 201 }
      );
    }
  ),
  http.patch('/api/materials/:id/metadata', async ({ params, request }) => {
    const mt = db.materials.find((x) => x.id === params.id);
    if (!mt) return new HttpResponse(null, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      topicId?: string;
      scopeTopics?: string[];
      scopeFileNames?: string[];
    };
    if (body.title != null) mt.title = body.title;
    // Empty-string sentinel unfiles; a real id files it; omitted leaves it.
    if (body.topicId != null)
      mt.topicId = body.topicId === '' ? null : body.topicId;
    if (body.scopeTopics != null) mt.scopeTopics = body.scopeTopics;
    if (body.scopeFileNames != null) mt.scopeFileNames = body.scopeFileNames;
    mt.updatedAt = new Date().toISOString();
    await persistEditorState(mt.id);
    return HttpResponse.json({
      contentBytes: mt.contentBytes,
      id: mt.id,
      revision: mt.revision,
      updatedAt: mt.updatedAt,
    });
  }),
  http.patch('/api/materials/:id/sharing', async ({ params, request }) => {
    const material = db.materials.find(
      (item) => item.id === params.id && !item.workspaceId
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Pick<Material, 'privacy'>;
    material.privacy = body.privacy;
    return HttpResponse.json(material);
  }),
  // Hidden from members: owners and editors switch a workspace item from its
  // menu.
  http.put('/api/files/:id/hidden', async ({ params, request }) => {
    const file = db.files.find((item) => item.id === params.id);
    if (!file?.workspaceId) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as HiddenBody;
    file.hidden = body.hidden;
    return HttpResponse.json(body);
  }),
  http.put('/api/materials/:id/hidden', async ({ params, request }) => {
    const material = db.materials.find((item) => item.id === params.id);
    if (!material?.workspaceId) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as HiddenBody;
    material.hidden = body.hidden;
    return HttpResponse.json(body);
  }),
  http.delete('/api/materials/:id', async ({ params }) => {
    trashMaterial(String(params.id));
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
      anchorEnd?: string;
      anchorQuote?: string;
      anchorStart?: string;
      anchorVersion?: number;
      text: string;
    };
    if (body.anchorVersion == null || body.anchorVersion < 1) {
      return HttpResponse.json(
        { message: 'anchorVersion must be at least 1' },
        { status: 400 }
      );
    }
    const now = new Date().toISOString();
    const discussion: MaterialDiscussion = {
      anchorEnd: body.anchorEnd,
      anchorQuote: body.anchorQuote ?? '',
      anchorStart: body.anchorStart,
      anchorVersion: body.anchorVersion,
      authorName: db.user.name,
      blockId: body.blockId,
      comments: [
        {
          authorName: db.user.name,
          createdAt: now,
          discussionId: '',
          id: uid('comment'),
          isDeleted: false,
          isEdited: false,
          text: body.text,
          updatedAt: now,
          userId: db.user.id,
        },
      ],
      createdAt: now,
      id: uid('discussion'),
      isDeleted: false,
      materialId: String(params.id),
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
    const body = (await request.json()) as { text: string };
    const now = new Date().toISOString();
    const comment: MaterialDiscussion['comments'][number] = {
      authorName: db.user.name,
      createdAt: now,
      discussionId: discussion.id,
      id: uid('comment'),
      isDeleted: false,
      isEdited: false,
      text: body.text,
      updatedAt: now,
      userId: db.user.id,
    };
    discussion.comments.push(comment);
    discussion.updatedAt = now;
    await persistEditorState(discussion.materialId);
    return HttpResponse.json(comment, { status: 201 });
  }),
  http.delete('/api/discussions/:id', async ({ params }) => {
    const discussion = mockDiscussions.find((item) => item.id === params.id);
    if (!discussion) return new HttpResponse(null, { status: 404 });
    discussion.isDeleted = true;
    await persistEditorState(discussion.materialId);
    return new HttpResponse(null, { status: 204 });
  }),
  http.patch('/api/comments/:id', async ({ params, request }) => {
    const body = (await request.json()) as { text: string };
    for (const discussion of mockDiscussions) {
      const comment = discussion.comments.find(
        (entry) => entry.id === params.id
      );
      if (!comment) continue;
      comment.text = body.text;
      comment.isEdited = true;
      comment.updatedAt = new Date().toISOString();
      return HttpResponse.json(comment);
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.delete('/api/comments/:id', async ({ params }) => {
    for (const discussion of mockDiscussions) {
      const entry = discussion.comments.find(
        (comment) => comment.id === params.id
      );
      if (!entry) continue;
      entry.isDeleted = true;
      entry.text = '';
      return new HttpResponse(null, { status: 204 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.get('/api/source-upload-policy', async () =>
    HttpResponse.json(sourceUploadPolicy)
  ),
  // Each source route has an unscoped twin for standalone files (no
  // workspace), which the mocks answer alike with an empty workspace id.
  // The mock gateway always has a free slot: every ticket's turn is now.
  ...sourceRoutes('/uploads/tickets').map((path) =>
    http.post(path, () =>
      HttpResponse.json({ position: 0, ticketId: 'utk_mock' }, { status: 201 })
    )
  ),
  // A file removed before it was sent counts in its batch; mocks keep none.
  ...sourceRoutes('/batches/:batchId/removed').map((path) =>
    http.post(path, () => new HttpResponse(null, { status: 204 }))
  ),
  // Mirrors the streamed upload: one multipart request, metadata then file.
  ...sourceRoutes('/uploads').map((path) =>
    http.post(path, async ({ params, request }) => {
      const wsId = typeof params.id === 'string' ? params.id : '';
      const form = await request.formData();
      const body = JSON.parse(
        String(form.get('metadata'))
      ) as SourceUploadMetadata;
      const bytes = form.get('file');
      if (!(bytes instanceof Blob)) {
        return HttpResponse.json(
          { message: 'an upload carries its file part' },
          { status: 400 }
        );
      }
      if ([...body.name].length > updateFileBodyNameMax) {
        return HttpResponse.json(
          { message: 'validation failed' },
          { status: 422 }
        );
      }
      await delay(500);
      const name = body.name;
      const kind = body.kind as SourceKindFix;
      let topicId = body.topicId ?? null;
      const topicName = body.topicName ?? null;
      const expectedKind = getFileKind(name, sourceUploadPolicy);
      if (topicId && topicName?.trim()) {
        return HttpResponse.json(
          { message: 'topicId and topicName cannot both be set' },
          { status: 400 }
        );
      }
      if (expectedKind === 'unknown' || kind !== expectedKind) {
        return HttpResponse.json(
          { message: 'unsupported source file type' },
          { status: 400 }
        );
      }
      // A standalone file has no topic, so its metadata names none.
      if (!wsId && ('topicId' in body || 'topicName' in body)) {
        return HttpResponse.json(
          { message: 'a standalone file has no topic' },
          { status: 400 }
        );
      }
      if (!topicId && topicName?.trim()) {
        const normalizedName = topicName.trim().toLowerCase();
        const existing = db.topics.find(
          (topic) =>
            topic.workspaceId === wsId &&
            topic.name.trim().toLowerCase() === normalizedName
        );
        if (existing) {
          topicId = existing.id;
        } else {
          const order = db.topics.filter(
            (topic) => topic.workspaceId === wsId
          ).length;
          const topic: Topic = {
            description: '',
            fileIds: [],
            id: uid('tp'),
            name: topicName.trim(),
            order,
            workspaceId: wsId,
          };
          db.topics.push(topic);
          const ws = db.workspaces.find((workspace) => workspace.id === wsId);
          if (ws) ws.topicCount += 1;
          topicId = topic.id;
        }
      }
      const f: (typeof db.files)[number] = {
        addedAt: new Date().toISOString(),
        // Mirror the real backend: uploads start 'pending' until a worker
        // claims the ingest job, then the client animates progress.
        hasBytes: true,
        // Who can see it: hidden from members from the start.
        hidden: body.hidden || undefined,
        id: uid('f'),
        indexed: false,
        isPayer: true,
        kind,
        name,
        position: db.nextContentPosition(wsId, topicId),
        revision: 1,
        sizeBytes: bytes.size,
        status: 'pending',
        topicId,
        workspaceId: wsId,
      };
      db.fileLinks[f.id] = { url: URL.createObjectURL(bytes) };
      const office = /\.(docx|pptx|xlsx)$/i.exec(name)?.[1].toLowerCase();
      if (office)
        seedUploadedOffice(
          f.id,
          office as 'docx' | 'pptx' | 'xlsx',
          db.fileLinks[f.id].url
        );
      db.files.push(f);
      const ws = db.workspaces.find((w) => w.id === wsId);
      if (ws) ws.fileCount += 1;
      if (f.topicId)
        db.topics.find((c) => c.id === f.topicId)?.fileIds.push(f.id);
      // Finish the ingest before the client's animation (5 × 450 ms) refetches
      // the list; scenarios can rewrite the outcome on that read.
      setTimeout(() => {
        f.status = 'ready';
        f.indexed = f.kind !== 'audio';
      }, 2000);
      return HttpResponse.json(f, { status: 201 });
    })
  ),
  /* ---------------- chat & generate ---------------- */
  /* ---------------- conversations ---------------- */
  // The live list: pinned first (latest pin on top), then newest activity;
  // ?archived=true: the archived threads, latest archived first.
  http.get('/api/workspaces/:id/conversations', async ({ params, request }) => {
    const archived =
      new URL(request.url).searchParams.get('archived') === 'true';
    const time = (at?: string) => (at ? +new Date(at) : 0);
    const list = db.conversations
      .filter((c) => c.workspaceId === params.id && !!c.archivedAt === archived)
      .sort((a, b) =>
        archived
          ? time(b.archivedAt) - time(a.archivedAt)
          : time(b.pinnedAt) - time(a.pinnedAt) ||
            time(b.updatedAt) - time(a.updatedAt)
      );
    return HttpResponse.json(list.map(db.listedConversation));
  }),
  // Archiving drops the pin, as on the server.
  http.patch('/api/conversations/:id', async ({ params, request }) => {
    const conv = db.conversations.find((c) => c.id === params.id);
    if (!conv) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as UpdateConversationReq;
    const now = new Date().toISOString();
    if (body.title !== undefined) conv.title = body.title;
    if (body.pinned !== undefined)
      conv.pinnedAt = body.pinned ? (conv.pinnedAt ?? now) : undefined;
    if (body.archived !== undefined) {
      conv.archivedAt = body.archived ? (conv.archivedAt ?? now) : undefined;
      if (body.archived) conv.pinnedAt = undefined;
    }
    return HttpResponse.json(db.listedConversation(conv));
  }),
  ...[
    [
      '/api/workspaces/:id/conversations/unarchive',
      '/api/workspaces/:id/conversations/archived',
    ],
    ['/api/conversations/unarchive', '/api/conversations/archived'],
  ].flatMap(([unarchive, archived]) => [
    http.post(unarchive, ({ params }) => {
      for (const c of db.conversations)
        if (c.workspaceId === (params.id ?? '')) c.archivedAt = undefined;
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(archived, ({ params }) => {
      const gone = new Set(
        db.conversations
          .filter((c) => c.workspaceId === (params.id ?? '') && c.archivedAt)
          .map((c) => c.id)
      );
      for (let i = db.conversations.length - 1; i >= 0; i--)
        if (gone.has(db.conversations[i].id)) db.conversations.splice(i, 1);
      for (let i = db.chatMessages.length - 1; i >= 0; i--)
        if (gone.has(db.chatMessages[i].conversationId))
          db.chatMessages.splice(i, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ]),
  http.post(
    '/api/workspaces/:id/conversations',
    async ({ params, request }) => {
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
      return HttpResponse.json(db.listedConversation(conv), { status: 201 });
    }
  ),
  http.get('/api/conversations/:id/messages', async ({ params }) => {
    const list = db.chatMessages.filter(
      (msg) => msg.conversationId === params.id
    );
    return HttpResponse.json(list);
  }),
  // The mock stream ends when the browser stops reading after this; a row
  // still streaming (the e2e seed's running turn) is saved stopped.
  http.post('/api/conversations/:id/messages/:messageId/stop', ({ params }) => {
    const row = db.chatMessages.find(
      (msg) => msg.id === params.messageId && msg.status === 'streaming'
    );
    if (row) row.status = 'aborted';
    return new HttpResponse(null, { status: 204 });
  }),
  mockResumeStream,
  http.delete('/api/conversations/:id', async ({ params }) => {
    const i = db.conversations.findIndex((c) => c.id === params.id);
    if (i >= 0) db.conversations.splice(i, 1);
    for (let j = db.chatMessages.length - 1; j >= 0; j--) {
      if (db.chatMessages[j].conversationId === params.id)
        db.chatMessages.splice(j, 1);
    }
    return new HttpResponse(null, { status: 204 });
  }),
  mockChatStream(),
  ...accountChatHandlers,
  mockUndo,
  http.post('/api/workspaces/:id/ai/copilot', async ({ request }) => {
    const body = (await request.json()) as { before?: string };
    if (!db.user.noteAiEnabled)
      return HttpResponse.json(
        { code: 'note_ai_disabled', message: 'note AI is turned off' },
        { status: 403 }
      );
    if (request.signal.aborted) return HttpResponse.json(null, { status: 408 });
    await delay(80);
    return HttpResponse.json({
      text: body.before?.trim() ? 'with a natural continuation.' : '',
    });
  }),
  http.post('/api/workspaces/:id/generate', async ({ params, request }) => {
    await delay(900);
    const opts = (await request.json()) as GenerateOptions;
    const wsId = String(params.id);
    const ws = db.workspaces.find((w) => w.id === wsId);
    if (!ws) return new HttpResponse(null, { status: 404 });
    const { count } = opts;
    if (!count || !opts.types?.length) {
      return HttpResponse.json(
        { message: 'count and types are required' },
        { status: 400 }
      );
    }
    const unknownFile = (opts.fileIds ?? []).find(
      (id) =>
        !db.files.some((file) => file.id === id && file.workspaceId === wsId)
    );
    if (unknownFile) {
      return HttpResponse.json(
        { message: `unknown file id "${unknownFile}"` },
        { status: 400 }
      );
    }
    const unknownTopic = (opts.topics ?? []).find(
      (id) => !db.topics.some((ch) => ch.id === id && ch.workspaceId === wsId)
    );
    if (unknownTopic) {
      return HttpResponse.json(
        { message: `unknown topic id "${unknownTopic}"` },
        { status: 400 }
      );
    }
    const wsName = ws.name;
    const topics = opts.topics ?? [];
    const fileIds = opts.fileIds ?? [];
    const scopeTopicNames = topics
      .map((cid) => db.topics.find((c) => c.id === cid)?.name)
      .filter(Boolean) as string[];
    const selectedFileIds = new Set(fileIds);
    for (const topicId of topics) {
      const topic = db.topics.find((item) => item.id === topicId);
      for (const fileId of topic?.fileIds ?? []) selectedFileIds.add(fileId);
    }
    const scopeFileNames = [...selectedFileIds]
      .map((fid) => db.files.find((f) => f.id === fid)?.name)
      .filter(Boolean) as string[];
    const title = opts.title?.trim() ?? '';
    if (!title) {
      return HttpResponse.json(
        { message: 'title is required' },
        { status: 400 }
      );
    }
    if ([...title].length > createMaterialBodyTitleMax) {
      return HttpResponse.json(
        { message: 'validation failed' },
        { status: 422 }
      );
    }
    const titleTaken = db.materials.some(
      (mt) =>
        mt.workspaceId === wsId &&
        mt.title.trim().toLowerCase() === title.toLowerCase()
    );
    if (titleTaken) {
      return HttpResponse.json(
        {
          code: 'title_taken',
          message: 'a material with this name already exists in this workspace',
        },
        { status: 409 }
      );
    }

    const qs: Question[] = Array.from({ length: count }, (_, i) => {
      const type = opts.types[i % opts.types.length];
      const answer = structuredClone(
        exampleAnswers.find((answer) => answer.type === type)!
      );
      const question = exampleQuestion(crypto.randomUUID(), answer);
      question.parts[0].blocks = [
        { text: `Generated ${type} question ${i + 1}?`, type: 'text' },
      ];
      return question;
    });
    const name = title;
    const quizMat = db.makeMaterial({
      ...ownerMaterialAccess,
      content: quizDocument(qs),
      createdAt: new Date().toISOString(),
      id: uid('qz'),
      kind: 'quiz',
      privacy: 'private',
      scopeFileNames,
      scopeTopics: scopeTopicNames,
      title: name,
      topicId: null,
      workspaceId: wsId,
      workspaceName: wsName,
    });
    db.materials.unshift(quizMat);
    return HttpResponse.json({ quiz: db.quizFromMaterial(quizMat) });
  }),
  /* ---------------- quizzes & attempts ---------------- */
  http.post('/api/quizzes', async ({ request }) => {
    const body = (await request.json()) as Partial<EditableQuiz>;
    const ws = db.workspaces.find((w) => w.id === body.workspaceId);
    const name = body.name || copyText(db.user.locale, 'untitled_quiz');
    const material = db.makeMaterial({
      ...ownerMaterialAccess,
      content: quizDocument(body.questions ?? []),
      createdAt: new Date().toISOString(),
      id: uid('qz'),
      kind: 'quiz',
      privacy: body.privacy ?? 'private',
      scopeFileNames: [],
      scopeTopics: body.topics ?? [],
      title: name,
      topicId: null,
      workspaceId: body.workspaceId ?? '',
      workspaceName: ws?.name ?? '',
    });
    db.materials.unshift(material);
    return HttpResponse.json(db.quizFromMaterial(material), { status: 201 });
  }),
  // Viewing and taking read answer-free questions; only the editor reads the key.
  http.get('/api/quizzes/:id', async ({ params }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    if (!mt) return new HttpResponse(null, { status: 404 });
    const quiz = db.quizFromMaterial(mt);
    return HttpResponse.json({
      ...quiz,
      author: db.mockAuthor,
      questions: quiz.questions.map(learnerView),
    });
  }),
  http.get('/api/quizzes/:id/edit', async ({ params }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    // Without edit access the quiz's key does not exist for the caller.
    if (!mt?.capabilities.canEditContent)
      return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(db.quizFromMaterial(mt));
  }),
  http.patch('/api/quizzes/:id/metadata', async ({ params, request }) => {
    const material = db.materials.find(
      (item) => item.id === params.id && item.kind === 'quiz'
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<EditableQuiz>;
    if (body.name !== undefined) material.title = body.name;
    if (body.topics !== undefined) material.scopeTopics = body.topics;
    return HttpResponse.json(db.quizFromMaterial(material));
  }),
  http.patch('/api/quizzes/:id/sharing', async ({ params, request }) => {
    const material = db.materials.find(
      (item) =>
        item.id === params.id && item.kind === 'quiz' && !item.workspaceId
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Pick<EditableQuiz, 'privacy'>;
    material.privacy = body.privacy;
    return HttpResponse.json(db.quizFromMaterial(material));
  }),
  http.delete('/api/quizzes/:id', async ({ params }) => {
    trashMaterial(String(params.id), 'quiz');
    return new HttpResponse(null, { status: 204 });
  }),
  // A material copies into a workspace (a taken title refuses it, as the
  // server does) or standalone; Explore's public items clone too.
  http.post('/api/materials/:id/clone', async ({ params, request }) => {
    const body = (await request.json()) as CloneMaterialReq;
    const workspaceId = body.workspaceId ?? '';
    const workspace = db.workspaces.find((ws) => ws.id === workspaceId);
    const source =
      db.materials.find(
        (material) => material.id === params.id && !material.parentMaterialId
      ) ?? publicCloneSource(String(params.id));
    if (!source || (workspaceId && !workspace))
      return new HttpResponse(null, { status: 404 });
    const title = body.title.trim();
    if (
      workspaceId &&
      db.materials.some(
        (mt) =>
          mt.workspaceId === workspaceId &&
          mt.title.trim().toLowerCase() === title.toLowerCase()
      )
    ) {
      return HttpResponse.json(
        {
          code: 'title_taken',
          message: 'a material with this name already exists in this workspace',
        },
        { status: 409 }
      );
    }
    const id = uid('mat');
    const cards =
      source.kind === 'flashcards'
        ? materialCards(source).map((card) => ({ ...card, id: uid('c') }))
        : [];
    const material = db.makeMaterial({
      ...ownerMaterialAccess,
      color: source.color,
      content:
        source.kind === 'flashcards'
          ? flashcardsDocument(cards, id)
          : structuredClone(source.content),
      createdAt: new Date().toISOString(),
      id,
      isOwner: workspace ? workspace.isOwner : true,
      kind: source.kind,
      privacy: 'private',
      scopeFileNames: [],
      scopeTopics: [],
      title,
      topicId: workspace ? mockCloneTopic(workspace.id, body) : null,
      workspaceId,
      workspaceName: workspace?.name ?? '',
    });
    db.materials.unshift(material);
    for (const card of cards) db.flashcardCards[card.id] = { materialId: id };
    return HttpResponse.json(material, { status: 201 });
  }),
  http.get('/api/attempts', ({ request }) => {
    const params = new URL(request.url).searchParams;
    const workspaces = params.get('workspaceId')?.split(',') ?? [];
    const kinds = params.get('kind')?.split(',') ?? [];
    const sort = params.get('sort');
    const list = db.attempts
      .filter(
        (a) =>
          (!workspaces.length ||
            (a.workspaceId !== null && workspaces.includes(a.workspaceId))) &&
          (!kinds.length || kinds.includes(a.kind))
      )
      .sort(
        sortBy(
          (a: Attempt) =>
            sort === 'score'
              ? a.total
                ? a.correct / a.total
                : 0
              : sort === 'quiz'
                ? a.quizName.toLowerCase()
                : sort === 'workspace'
                  ? a.workspaceName.toLowerCase()
                  : a.takenAt,
          params.get('dir') === 'asc'
        )
      );
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 30);
    return HttpResponse.json({
      items: list.slice(offset, offset + limit).map(db.attemptSummary),
      more: list.length > offset + limit,
    });
  }),
  http.get('/api/attempts/:id', async ({ params }) => {
    const at = db.attempts.find((a) => a.id === params.id);
    if (!at) return new HttpResponse(null, { status: 404 });
    // A set's attempt before this one, as the server reads it.
    const previous =
      at.kind === 'flashcards'
        ? db.attempts
            .filter(
              (a) => a.materialId === at.materialId && a.takenAt < at.takenAt
            )
            .sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0]
        : undefined;
    return HttpResponse.json({
      ...at,
      answers: at.answers ?? {},
      cards: at.cards ?? [],
      questions: at.questions ?? [],
      ...(previous && {
        previous: {
          correct: previous.correct,
          takenAt: previous.takenAt,
          total: previous.total,
        },
      }),
    });
  }),
  // Grades one question and adds it to the attempt, starting one when the id
  // is missing or unknown; returns the attempt so far with the keys.
  http.post('/api/quizzes/:id/check', async ({ params, request }) => {
    const { answers, attemptId, questionId, startedAt } =
      (await request.json()) as GradeOneBody & {
        attemptId?: string;
        startedAt?: string;
      };
    const quizMt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'quiz'
    );
    if (!quizMt) return new HttpResponse(null, { status: 404 });
    const quiz = db.quizFromMaterial(quizMt);
    const question = quiz.questions.find((q) => q.id === questionId);
    // As the server: only complete questions are projected and marked.
    if (!question || questionIssues(question).length > 0)
      return HttpResponse.json(
        { errors: [{ message: 'question_no_answers' }] },
        { status: 404 }
      );
    const [graded] = gradeQuestions([question], answers).questions;
    const order = quiz.questions.map((q) => q.id);
    const existing = db.attempts.find(
      (a) => a.id === attemptId && a.materialId === quiz.id
    );
    if (existing?.questions?.some((q) => q.id === questionId))
      return new HttpResponse(null, { status: 409 });
    // As the server: quiz order, questions no longer in the quiz last; a
    // checked question counts with the marks it was checked against.
    const at_ = (id: string) =>
      order.includes(id) ? order.indexOf(id) : order.length;
    const checked = [...(existing?.questions ?? []), graded].sort(
      (a, b) => at_(a.id) - at_(b.id)
    );
    const { awarded: correct, max: total } = runScore(quiz.questions, checked);
    const at = {
      answers: { ...existing?.answers, ...answers },
      correct,
      id: existing?.id ?? uid('at'),
      kind: 'quiz' as const,
      materialId: quiz.id,
      pct: total > 0 ? Math.floor((correct / total) * 100) : 0,
      questions: checked,
      quizName: quiz.name,
      startedAt: existing?.startedAt ?? startedAt ?? null,
      takenAt: new Date().toISOString(),
      topics: quiz.topics,
      total,
      workspaceId: quizMt.workspaceId,
      workspaceName: quiz.workspaceName,
    };
    // An embedded quiz records nothing: graded, returned without an id.
    if (quizMt.parentMaterialId)
      return HttpResponse.json({ ...at, id: '', questions: [graded] });
    if (existing) db.attempts.splice(db.attempts.indexOf(existing), 1);
    db.attempts.unshift(at);
    return HttpResponse.json(at);
  }),
  /* ---------------- flashcards ---------------- */
  http.post('/api/flashcards', async ({ request }) => {
    const body = (await request.json()) as Partial<FlashcardSet>;
    const ws = db.workspaces.find((w) => w.id === body.workspaceId);
    const name = body.name || copyText(db.user.locale, 'new_flashcards');
    const id = uid('dk');
    const material = db.makeMaterial({
      ...ownerMaterialAccess,
      color: body.color ?? 'green',
      content: flashcardsDocument([], id),
      createdAt: new Date().toISOString(),
      id,
      kind: 'flashcards',
      privacy: 'private',
      scopeFileNames: [],
      scopeTopics: [],
      title: name,
      topicId: null,
      workspaceId: body.workspaceId ?? '',
      workspaceName: ws?.name ?? body.workspaceName ?? '',
    });
    db.materials.unshift(material);
    return HttpResponse.json(db.flashcardSetFromMaterial(material), {
      status: 201,
    });
  }),
  http.get('/api/flashcards/:id', async ({ params }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'flashcards'
    );
    return mt
      ? HttpResponse.json({
          ...db.flashcardSetFromMaterial(mt),
          author: db.mockAuthor,
        })
      : new HttpResponse(null, { status: 404 });
  }),
  http.patch('/api/flashcards/:id/metadata', async ({ params, request }) => {
    const material = db.materials.find(
      (item) => item.id === params.id && item.kind === 'flashcards'
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Partial<FlashcardSet>;
    if (body.name !== undefined) material.title = body.name;
    if (body.color !== undefined) material.color = body.color;
    return HttpResponse.json(db.flashcardSetFromMaterial(material));
  }),
  http.patch('/api/flashcards/:id/sharing', async ({ params, request }) => {
    const material = db.materials.find(
      (item) =>
        item.id === params.id && item.kind === 'flashcards' && !item.workspaceId
    );
    if (!material) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as Pick<FlashcardSet, 'privacy'>;
    material.privacy = body.privacy;
    return HttpResponse.json(db.flashcardSetFromMaterial(material));
  }),
  http.get('/api/flashcards/:id/cards', async ({ params }) => {
    const mt = db.materials.find(
      (x) => x.id === params.id && x.kind === 'flashcards'
    );
    return mt
      ? HttpResponse.json(db.cardsFromMaterial(mt))
      : new HttpResponse(null, { status: 404 });
  }),
  /* ---------------- study progress and review ---------------- */
  ...studyHandlers,
  ...assignmentHandlers('owner'),

  /* ---------------- schedule ---------------- */
  http.get('/api/events', async () => HttpResponse.json(db.events)),
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
  http.get('/api/labels', async () => HttpResponse.json(db.labels)),
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
    const i = db.tasks.findIndex((x) => x.id === params.id);
    if (i >= 0) db.tasks.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- explore ---------------- */
  http.get('/api/explore/workspaces', async () =>
    HttpResponse.json({ items: db.publicWorkspaces })
  ),
  http.get('/api/explore/quizzes', async () =>
    HttpResponse.json({
      items: db.publicQuizzes.map(({ questions, ...quiz }) => ({
        ...quiz,
        questionCount: questions.length,
      })),
    })
  ),
  http.get('/api/explore/flashcards', async () =>
    HttpResponse.json({ items: db.publicFlashcardSets })
  ),

  /* ---------------- billing ---------------- */
  http.get('/api/billing', async () =>
    HttpResponse.json({
      cancelAtPeriodEnd: false,
      creditSettings: mockCreditSettings,
      creditsCarriedMicros: 0,
      creditsLimitMicros: PLAN_LIMITS.pro.creditLimitMicros,
      creditsPeriodStart: new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
      ).toISOString(),
      creditsPurchasedMicros: 0,
      creditsReservedMicros: 0,
      creditsUsedMicros: PLAN_LIMITS.pro.creditLimitMicros,
      planTier: db.user.planTier,
      renewalAt: new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 9)
      ).toISOString(),
      storageBreakdown: {
        canvasBytes: 140 * 1024,
        filesBytes: Math.round(db.accountStatus.storageUsedBytes * 0.8),
        otherBytes:
          db.accountStatus.storageUsedBytes -
          Math.round(db.accountStatus.storageUsedBytes * 0.8) -
          140 * 1024,
      },
      storageLimitBytes: db.accountStatus.storageLimitBytes,
      storageReservedBytes: 0,
      storageUsedBytes: db.accountStatus.storageUsedBytes,
      subscriptionStatus: db.user.subscriptionStatus,
    })
  ),
  http.get('/api/me/ingest-slots', async () =>
    HttpResponse.json({
      slotsFree: 20,
      slotsLimit: 20,
      slotsUsed: 0,
    })
  ),
  http.get('/api/usage', async () =>
    HttpResponse.json({
      bySurface: [
        { creditMicros: 9000 * 1_000_000, events: 9, key: 'chat' },
        { creditMicros: 3000 * 1_000_000, events: 3, key: 'generate' },
        { creditMicros: 1700 * 1_000_000, events: 6, key: 'ingest' },
        { creditMicros: 300 * 1_000_000, events: 4, key: 'editor' },
        { creditMicros: 70 * 1_000_000, events: 1, key: 'system' },
      ],
    })
  ),
  http.get('/api/usage/events', async ({ request }) => {
    // Enough rows for three pages; the cursor is just the next offset here.
    const search = new URL(request.url).searchParams;
    const before = search.get('before');
    const start = before ? Number(before) : 0;
    const keys: Record<string, (e: MockUsageEvent) => number | string> = {
      credits: (e) => e.creditMicros,
      date: (e) => e.createdAt,
      model: (e) => `${e.providerSlug}/${e.modelSlug}`.toLowerCase(),
      tokens: (e) => e.inputTokens + e.outputTokens,
    };
    const key = keys[search.get('sort') ?? 'date'];
    const sign = search.get('dir') === 'asc' ? 1 : -1;
    const sorted = key
      ? [...MOCK_USAGE_EVENTS].sort((a, b) => {
          const x = key(a);
          const y = key(b);
          return (x < y ? -1 : x > y ? 1 : 0) * sign;
        })
      : MOCK_USAGE_EVENTS;
    const page = sorted.slice(start, start + 20);
    const next = start + 20 < sorted.length ? String(start + 20) : undefined;
    return HttpResponse.json({ items: page, next });
  }),
  http.get('/api/billing/invoices', async () =>
    HttpResponse.json({
      items:
        db.user.planTier === 'pro'
          ? [
              {
                createdAt: new Date().toISOString(),
                currency: 'usd',
                id: 'in_mock_reload',
                kind: 'reload',
                // Cancelling the retry voids it.
                ...(mockCreditSettings.reload.status === 'void'
                  ? { status: 'void' }
                  : {
                      nextAttemptAt: new Date(
                        Date.now() + 86_400_000
                      ).toISOString(),
                      status: 'open',
                    }),
                total: 1000,
                url: 'https://invoice.stripe.com/i/mock',
              },
              {
                createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
                currency: 'usd',
                id: 'in_mock_topup',
                kind: 'topup',
                status: 'paid',
                total: 2000,
                url: 'https://invoice.stripe.com/i/mock',
              },
              ...[0, 1, 2].map((months) => {
                const at = new Date();
                at.setUTCMonth(at.getUTCMonth() - months, 1);
                return {
                  createdAt: at.toISOString(),
                  currency: 'usd',
                  id: `in_mock_${months}`,
                  kind: 'plan',
                  // This month's renewal failed and Stripe retries it.
                  ...(months === 0
                    ? {
                        nextAttemptAt: new Date(
                          Date.now() + 3 * 86_400_000
                        ).toISOString(),
                        status: 'open',
                      }
                    : { status: 'paid' }),
                  total: 800,
                  url: 'https://invoice.stripe.com/i/mock',
                };
              }),
            ]
          : [],
    })
  ),
  http.post('/api/billing/top-up', async ({ request }) => {
    const { amountCents } = (await request.json()) as { amountCents: number };
    const limit = mockCreditSettings.spendingLimitCents;
    if (limit && mockCreditSettings.spentThisMonthCents + amountCents > limit) {
      return HttpResponse.json(
        {
          detail: 'the monthly spending limit would be exceeded',
          errors: [
            {
              message: 'spending_limit',
              value: { chargingCents: 0, limitCents: limit },
            },
          ],
          status: 409,
          title: 'Conflict',
        },
        { status: 409 }
      );
    }
    return HttpResponse.json({
      url: `/billing?tab=subscription&mock_topup=${amountCents}`,
    });
  }),
  http.post('/api/billing/payment-method', async () =>
    HttpResponse.json({ url: '/billing?tab=subscription&reload=method' })
  ),
  http.put('/api/billing/auto-reload', async ({ request }) => {
    const body = (await request.json()) as {
      amountCents: number;
      enabled: boolean;
      thresholdCredits: number;
    };
    mockCreditSettings.autoReload = body.enabled;
    mockCreditSettings.reloadAmountCents = body.amountCents;
    mockCreditSettings.reloadThresholdMicros =
      body.thresholdCredits * 1_000_000;
    return HttpResponse.json({ armed: true });
  }),
  http.put('/api/billing/spending-limit', async ({ request }) => {
    const { limitCents } = (await request.json()) as { limitCents: number };
    mockCreditSettings.spendingLimitCents = limitCents || undefined;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/billing/checkout', async ({ request }) => {
    const body = (await request.json()) as { planTier: string };
    return HttpResponse.json({
      url: `/billing?tab=subscription&mock_checkout=${body.planTier}`,
    });
  }),
  http.post('/api/billing/portal', async () =>
    HttpResponse.json({ url: '/billing?tab=subscription&mock_portal=1' })
  ),
  http.post('/api/billing/portal/cancel-subscription', async () =>
    HttpResponse.json({ url: '/billing?tab=subscription&mock_portal=cancel' })
  ),
  http.post('/api/billing/auto-reload/cancel-retry', async () => {
    if (mockCreditSettings.reload.status === 'retrying')
      mockCreditSettings.reload = {
        ...mockCreditSettings.reload,
        nextAttemptAt: undefined,
        status: 'void',
      };
    return new HttpResponse(null, { status: 204 });
  }),

  /* ---------------- integrations ---------------- */
  http.get('/api/integrations', async () =>
    HttpResponse.json({
      google: false,
      googleDriveReadonly: false,
      microsoft: false,
      microsoftFilesRead: false,
    })
  ),
  http.get('/api/integrations/google/picker-token', async () =>
    HttpResponse.json({ accessToken: 'mock-google-token' })
  ),
  http.get('/api/integrations/microsoft/drive', async () =>
    HttpResponse.json({
      driveType: 'personal',
      id: 'b!mock',
      webUrl: 'https://onedrive.live.com/?id=root',
    })
  ),
  ...sourceRoutes('/import-inspect').map((path) =>
    http.post(path, async ({ params, request }) => {
      const base =
        typeof params.id === 'string'
          ? `/api/workspaces/${params.id}/sources`
          : '/api/sources';
      const body = (await request.json()) as {
        driveIds?: string[];
        fileIds: string[];
        provider: string;
      };
      return HttpResponse.json({
        items: body.fileIds.map((fileId, index) => ({
          analysisUrl: `${base}/import-content?provider=${body.provider}&fileId=${encodeURIComponent(fileId)}`,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ...(body.driveIds?.[index] ? { driveId: body.driveIds[index] } : {}),
          fileId,
          kind: 'doc',
          name: `cloud-notes-${index + 1}.docx`,
          sizeBytes: 2048,
          sizeEstimate: false,
        })),
        rejected: [],
      });
    })
  ),
  ...sourceRoutes('/import-content').map((path) =>
    http.get(path, async () => {
      const encoder = new TextEncoder();
      const document = zipSync({
        'docProps/app.xml': encoder.encode(
          '<Properties><Pages>2</Pages></Properties>'
        ),
        'word/document.xml': encoder.encode(
          `<w:document><w:t>${'Searchable mock document text. '.repeat(80)}</w:t></w:document>`
        ),
      });
      return new HttpResponse(document, {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      });
    })
  ),
  ...sourceRoutes('/import').map((path) =>
    http.post(path, async ({ params, request }) => {
      const wsId = typeof params.id === 'string' ? params.id : '';
      const body = (await request.json()) as {
        topicId?: string | null;
        topicName?: string | null;
        driveIds?: string[];
        fileIds: string[];
        hidden?: boolean;
        parseMode?: 'fast' | 'none';
        provider: string;
        requestId?: string;
      };
      const replayKey = body.requestId
        ? `${wsId}:${body.requestId}`
        : undefined;
      const replayed = replayKey
        ? sourceImportResponses.get(replayKey)
        : undefined;
      if (replayed) {
        return HttpResponse.json(replayed, { status: 202 });
      }
      const jobs = body.fileIds.map((_fileId, i) => {
        const jobId = uid('imp');
        const sourceImport: MockSourceImport = {
          completed: false,
          fileId: uid('f'),
          hidden: body.hidden === true,
          name: `${body.provider}-import-${i + 1}.pdf`,
          polls: 0,
          sizeBytes: 512 * 1024,
          topicId: body.topicId ?? null,
          workspaceId: wsId,
        };
        sourceImports.set(jobId, sourceImport);
        return {
          jobId,
          name: sourceImport.name,
          uploadId: uid('up'),
        };
      });
      const response = { jobs, rejected: [] };
      if (replayKey) sourceImportResponses.set(replayKey, response);
      return HttpResponse.json(response, { status: 202 });
    })
  ),
  ...sourceRoutes('/imports/:jobId').map((path) =>
    http.get(path, async ({ params }) => {
      const jobId = params.jobId as string;
      const sourceImport = sourceImports.get(jobId);
      if (!sourceImport) {
        return HttpResponse.json({ message: 'not found' }, { status: 404 });
      }
      sourceImport.polls += 1;
      const status =
        sourceImport.polls === 1
          ? 'pending'
          : sourceImport.polls === 2
            ? 'running'
            : 'succeeded';
      if (status === 'succeeded') completeMockSourceImport(sourceImport);
      return HttpResponse.json({
        ...(status === 'succeeded' ? { fileId: sourceImport.fileId } : {}),
        jobId,
        name: sourceImport.name,
        status,
      });
    })
  ),
];

type SourceKindFix = 'pdf' | 'doc' | 'md' | 'image' | 'txt';

/** Signed-out reads reach standalone, non-embedded link/public materials. */
/** The quizzes and sets a note embeds and references, in reference order. */
function noteEmbeds(note: Material) {
  const ids = note.content.value.flatMap((node) =>
    node.type === 'material_ref' && typeof node.materialId === 'string'
      ? [node.materialId]
      : []
  );
  return [...new Set(ids)].flatMap((id) => {
    const child = db.materials.find(
      (x) => x.id === id && x.parentMaterialId === note.id
    );
    return child ? [child] : [];
  });
}

function anonymousMaterial(
  token: string,
  kind: 'quiz' | 'flashcards' | 'note'
) {
  const id = token.split('.')[0];
  return db.materials.find(
    (x) =>
      x.id === id &&
      x.kind === kind &&
      !x.workspaceId &&
      !x.parentMaterialId &&
      x.privacy !== 'private'
  );
}
