/* ============================================================
   In-memory mock database. Seeded with dummy data; MSW handlers
   read/mutate these arrays so the UI behaves like a real backend
   for the session. Swap for the real API later — no UI changes.
   ============================================================ */
import type {
  AccountStatus,
  AppNotification,
  Attempt,
  CalendarEvent,
  Chapter,
  Conversation,
  EditableQuiz,
  FileChange,
  Flashcard,
  FlashcardSet,
  Label,
  Material,
  MaterialDiscussion,
  MaterialListItem,
  NotificationPrefs,
  PublicFlashcardSet,
  PublicQuiz,
  PublicWorkspace,
  Question,
  SourceFile,
  Task,
  ThinkingCanvas,
  TrashItem,
  User,
  WireMessage,
  Workspace,
} from '@/api/types';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import {
  parseFlashcardsBlock,
  parseQuizBlock,
} from '@/features/materials/blocks';
import {
  createMaterialDocument,
  type FlashcardsElement,
  flashcardsElementToCards,
  flashcardsNode,
  type MaterialValue,
  mermaidNode,
  parseMaterialDocumentWithMetrics,
  type QuizElement,
  quizElementToBlock,
  quizNode,
} from '@/features/materials/document';
import {
  type Answer,
  type Answers,
  applyItemAwards,
} from '@/features/quizzes/grade';
import { MATERIAL_SCHEMA_VERSION } from '@/lib/const';
import { gradeQuestions, learnerView } from './answerKeys';
import { biologyQuizQuestions } from './biologyQuiz';
import {
  chatFixtures,
  fixtureCitations,
  fixtureResult,
  mockChatModel,
} from './chatFixtures';
import { dialogFiles, dialogSourceFile } from './dialogFiles';
import {
  buildEditorNoteValue,
  EDITOR_NOTE,
  EDITOR_WORKSPACE_ID,
} from './editorSeed';
import { errorMaterials } from './errorMaterials';
import { seedNotes } from './noteContent';
import { embeddedSeeds } from './noteContent/helpers';
import { buildBiologyLoadTestValue } from './noteContent/loadTest';
import { biologyOfficeFixtures } from './officeFixtures';
import {
  buildSmallPerfDocument,
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from './perfSeed';

export const uid = (p = 'id') =>
  `${p}_${Math.random().toString(36).slice(2, 9)}`;

export function materialContentBytes(content: Material['content']): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}

export function refreshMaterialContentBytes(material: Material): void {
  material.contentBytes = materialContentBytes(material.content);
}

/** Wrap bare strings as {value} rows (matches useFieldArray-friendly shapes). */

/**
 * Mock tag catalog (mirrors the backend `tags` table: per-user, per-kind, id +
 * name). Entities reference these by id so reuse preserves the row. Handlers
 * read/mutate this array for GET /api/tags and workspace create/update.
 */
export interface CatalogTag {
  id: string;
  kind: string;
  value: string;
}
export const tagCatalog: CatalogTag[] = [
  { id: 'tag_1', kind: 'workspace', value: 'Cells' },
  { id: 'tag_2', kind: 'workspace', value: 'Genetics' },
  { id: 'tag_3', kind: 'workspace', value: 'Integrals' },
  { id: 'tag_4', kind: 'workspace', value: 'Series' },
  { id: 'tag_5', kind: 'workspace', value: 'Modern' },
  { id: 'tag_6', kind: 'workspace', value: 'Essays' },
  { id: 'tag_7', kind: 'workspace', value: 'Reactions' },
  { id: 'tag_8', kind: 'workspace', value: 'Poetry' },
  { id: 'tag_9', kind: 'workspace', value: 'Shakespeare' },
  { id: 'tag_war', kind: 'workspace', value: 'War' },
];
/** Build the {id, value} tag rows for an entity from catalog ids. */
const ct = (...ids: string[]) =>
  ids.map((id) => {
    const t = tagCatalog.find((x) => x.id === id)!;
    return { id: t.id, value: t.value };
  });

function seedCard(
  id: string,
  materialId: string,
  front: string,
  back: string
): Flashcard {
  return { back, front, id, materialId, revision: 1 };
}

const now = Date.now();
const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
const hours = (n: number) => new Date(now - n * 3_600_000).toISOString();

/** Build an ISO timestamp for today at a given hour (local). */
function todayAt(hour: number, minute = 0): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
function dateAt(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// The account lifecycle lives in `accountStatus`; handlers compose /me from both.
export const user: Omit<User, 'account'> = {
  avatarIconId: 'avataaars-01',
  avatarUrl: '/icons/avataaars-01.svg',
  chatModel: {
    modelSlug: 'deepseek-flash',
    providerSlug: 'deepseek',
  },
  classLabel: 'Grade 11 · Science',
  editorModel: {
    modelSlug: 'deepseek-flash',
    providerSlug: 'deepseek',
  },
  email: 'kate@capynotebook.app',
  id: 'u_1',
  locale: 'en',
  name: 'Kate Malone',
  planTier: 'pro',
  streak: 0,
  studyPreferences: {},
  studyProgress: true,
  subscriptionStatus: 'active',
};

export const llmCredentials: Record<string, string> = {};

export const userThinking: Record<string, Record<string, string>> = {};

export const workspaces: Workspace[] = [
  {
    autoProcess: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canEditContent: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 0,
    createdAt: days(40),
    description:
      'Explore how cells work, how substances move across membranes, and how traits pass from one generation to the next. Lecture readings, revision notes and practice materials for our introductory biology course.',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-01',
    id: 'ws_bio',
    isOwner: true,
    lastAccessedAt: hours(3),
    name: 'Biology 101',
    privacy: 'link',
    role: 'owner',
    sharePath: '/w/ws_bio.WsDtCIGPdoZOSZL0',
    shareRole: 'viewer',
    storageOwnerState: 'active',
    storageOwnerUsage: 'ok',
    tags: ct('tag_1', 'tag_2'),
  },
  {
    autoProcess: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canEditContent: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 0,
    createdAt: days(30),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-02',
    id: 'ws_calc',
    isOwner: true,
    lastAccessedAt: days(1),
    name: 'Calculus II',
    privacy: 'private',
    role: 'owner',
    sharePath: '/w/ws_calc.UZ6Qw4jRVADIzzI1',
    shareRole: 'viewer',
    storageOwnerState: 'active',
    storageOwnerUsage: 'ok',
    tags: ct('tag_3', 'tag_4'),
  },
  {
    autoProcess: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canEditContent: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 0,
    createdAt: days(22),
    description:
      'Explore the ideas, conflicts and everyday lives that shaped the modern world. Chapter readings and discussion notes for our history study group.',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-03',
    id: 'ws_hist',
    isOwner: true,
    lastAccessedAt: days(2),
    name: 'World History',
    privacy: 'link',
    role: 'owner',
    sharePath: '/w/ws_hist.bVGQ2CHqnMetPMgB',
    shareRole: 'viewer',
    storageOwnerState: 'active',
    storageOwnerUsage: 'ok',
    tags: ct('tag_5', 'tag_6', 'tag_war'),
  },
  {
    autoProcess: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canEditContent: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 0,
    createdAt: days(12),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-04',
    id: 'ws_chem',
    isOwner: true,
    lastAccessedAt: days(5),
    name: 'Organic Chemistry',
    privacy: 'private',
    role: 'owner',
    sharePath: '/w/ws_chem.c5KOZGPxH2RwP08Z',
    shareRole: 'viewer',
    storageOwnerState: 'active',
    storageOwnerUsage: 'ok',
    tags: ct('tag_7'),
  },
  {
    autoProcess: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canEditContent: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 0,
    createdAt: days(8),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-05',
    id: 'ws_eng',
    isOwner: true,
    lastAccessedAt: hours(20),
    name: 'English Literature',
    privacy: 'public',
    role: 'owner',
    sharePath: '/w/ws_eng.-sR-YQ2vLCQXEe2Q',
    shareRole: 'viewer',
    storageOwnerState: 'active',
    storageOwnerUsage: 'ok',
    tags: ct('tag_8', 'tag_9'),
  },
];

export const chapters: Chapter[] = [
  {
    fileIds: ['f_1', 'f_2'],
    id: 'ch_1',
    name: 'Cell structure',
    order: 0,
    workspaceId: 'ws_bio',
  },
  {
    fileIds: ['f_3'],
    id: 'ch_2',
    name: 'Membranes & transport',
    order: 1,
    workspaceId: 'ws_bio',
  },
  {
    fileIds: ['f_4', 'f_5'],
    id: 'ch_3',
    name: 'Genetics',
    order: 2,
    workspaceId: 'ws_bio',
  },
  {
    fileIds: ['f_6'],
    id: 'ch_c1',
    name: 'Techniques of integration',
    order: 0,
    workspaceId: 'ws_calc',
  },
  {
    fileIds: ['f_7'],
    id: 'ch_c2',
    name: 'Sequences & series',
    order: 1,
    workspaceId: 'ws_calc',
  },
];

/** Inline text sources for MSW: the links handler hands this back as the
 * presigned URL, and `fetch` reads data: URLs like any other. */
export function textUrl(body: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(body)}`;
}

/** Presigned-link stand-ins per file id, served by the mock links handler.
 * Rows only carry `hasBytes`, like production, so a viewer that reads bytes
 * without asking for links fails here too. */
export const fileLinks: Record<string, { previewUrl?: string; url: string }> = {
  ...Object.fromEntries(
    biologyOfficeFixtures.map((file) => [file.id, { url: file.sourceURL }])
  ),
  ...Object.fromEntries(
    ['pending', 'processing', 'failed', 'ready'].map((status) => [
      `bio-state-${status}`,
      {
        url: textUrl(
          '# Biology notes\n\nThe original source remains readable while indexing is pending or failed.'
        ),
      },
    ])
  ),
  f_1: {
    url: 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf',
  },
  f_2: {
    url: textUrl(
      '# Organelles\n\n- **Nucleus** — stores DNA, controls the cell.\n- **Mitochondria** — the powerhouse; ATP via respiration.\n- **Ribosomes** — protein synthesis.\n- **Golgi apparatus** — packaging & shipping.\n\nThe cell membrane is a *phospholipid bilayer* that controls what enters and leaves.'
    ),
  },
  f_3: {
    url: textUrl(
      'Osmosis is the diffusion of water across a semi-permeable membrane from low to high solute concentration.'
    ),
  },
  f_4: {
    url: 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf',
  },
  f_5: { url: 'https://picsum.photos/2000/3000' },
  f_6: {
    url: 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf',
  },
  f_7: {
    url: textUrl(
      '# Taylor series\n\nA function f(x) near a point a:\n\nf(x) = Σ fⁿ(a)/n! · (x − a)ⁿ'
    ),
  },
  f_8: {
    url: 'https://essentials.pixfort.com/original/wp-content/uploads/sites/4/2020/02/skanews.wav',
  },
};

export const files: SourceFile[] = [
  ...biologyOfficeFixtures.map(
    (file, position): SourceFile => ({
      addedAt: hours(1),
      chapterId: null,
      hasBytes: true,
      id: file.id,
      indexed: false,
      kind: file.kind,
      name: file.name,
      position: position + dialogFiles.length + 4,
      revision: 1,
      sizeBytes: file.sizeBytes,
      status: 'ready',
      workspaceId: 'ws_bio',
    })
  ),
  ...dialogFiles.map((file, position) => ({
    ...dialogSourceFile(file.id),
    position,
  })),
  ...(['pending', 'processing', 'failed', 'ready'] as const).map(
    (status, position): SourceFile => ({
      addedAt: hours(1),
      chapterId: null,
      hasBytes: true,
      id: `bio-state-${status}`,
      indexed: false,
      kind: 'md',
      name: `Biology notes - ${status === 'ready' ? 'stored without indexing' : status}.md`,
      position: position + dialogFiles.length,
      revision: 1,
      sizeBytes: 2048,
      status,
      workspaceId: 'ws_bio',
      ...(status === 'processing' ? { ingestPct: 45 } : {}),
    })
  ),
  {
    addedAt: days(20),
    chapterId: 'ch_1',
    hasBytes: true,
    id: 'f_1',
    indexed: true,
    kind: 'pdf',
    name: 'Cell structure.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 2480 * 1024,
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(19),
    chapterId: 'ch_1',
    hasBytes: true,
    id: 'f_2',
    indexed: true,
    kind: 'md',
    name: 'Organelles cheatsheet.md',
    position: 1,
    revision: 1,
    sizeBytes: 14 * 1024,
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(18),
    chapterId: 'ch_2',
    hasBytes: true,
    id: 'f_3',
    indexed: true,
    kind: 'txt',
    name: 'Osmosis notes.txt',
    position: 0,
    revision: 1,
    sizeBytes: 6 * 1024,
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(15),
    chapterId: 'ch_3',
    hasBytes: true,
    id: 'f_4',
    indexed: true,
    kind: 'pdf',
    name: 'Mendelian genetics.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 1890 * 1024,
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(14),
    chapterId: null,
    hasBytes: true,
    id: 'f_5',
    indexed: true,
    kind: 'image',
    name: 'Punnett squares.png',
    position: 0,
    revision: 1,
    sizeBytes: 420 * 1024,
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(10),
    chapterId: 'ch_c1',
    hasBytes: true,
    id: 'f_6',
    indexed: true,
    kind: 'pdf',
    name: 'Integration by parts.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 980 * 1024,
    workspaceId: 'ws_calc',
  },
  {
    addedAt: days(9),
    chapterId: 'ch_c2',
    hasBytes: true,
    id: 'f_7',
    indexed: true,
    kind: 'md',
    name: 'Taylor series.md',
    position: 0,
    revision: 1,
    sizeBytes: 11 * 1024,
    workspaceId: 'ws_calc',
  },
  {
    addedAt: days(14),
    chapterId: null,
    hasBytes: true,
    id: 'f_8',
    indexed: false,
    kind: 'audio',
    name: 'dummy_audio.wav',
    position: 1,
    revision: 1,
    sizeBytes: 10_000 * 1024,
    workspaceId: 'ws_bio',
  },
];

// A populated shared workspace for local summary and sharing previews.
for (const [index, chapter] of [
  {
    name: 'Revolutions and reform',
    titles: ['The Enlightenment', 'The French Revolution', 'Reform movements'],
  },
  {
    name: 'Industry and empire',
    titles: [
      'The Industrial Revolution',
      'Trade and empire',
      'Life in a growing city',
    ],
  },
  {
    name: 'A world at war',
    titles: [
      'Causes of the First World War',
      'Voices from the home front',
      'The interwar years',
    ],
  },
  {
    name: 'The modern world',
    titles: ['Decolonisation', 'The Cold War', 'Global connections'],
  },
].entries()) {
  const chapterId = `ch_hist_${index}`;
  const fileIds = chapter.titles.map((title, position) => {
    const id = `f_hist_${index}_${position}`;
    const body = `# ${title}\n\nReading notes for ${chapter.name}.\n\nCompare the causes, the people involved, and the consequences. Bring one primary source to our next discussion.\n`;
    files.push({
      addedAt: days(12 - index),
      chapterId,
      hasBytes: true,
      id,
      indexed: true,
      kind: 'md',
      name: `${title}.md`,
      position,
      revision: 1,
      sizeBytes: new TextEncoder().encode(body).byteLength,
      workspaceId: 'ws_hist',
    });
    fileLinks[id] = { url: textUrl(body) };
    return id;
  });
  chapters.push({
    fileIds,
    id: chapterId,
    name: chapter.name,
    order: index,
    workspaceId: 'ws_hist',
  });
}

for (const workspace of workspaces) {
  workspace.chapterCount = chapters.filter(
    (chapter) => chapter.workspaceId === workspace.id
  ).length;
  workspace.fileCount = files.filter(
    (file) => file.workspaceId === workspace.id
  ).length;
}

const seedQuizzes: EditableQuiz[] = [
  {
    canEdit: true,
    canEditContent: true,
    chapters: ['Cell structure', 'Membranes & transport'],
    createdAt: days(4),
    id: 'qz_1',
    isOwner: true,
    name: 'Cell biology basics',
    privacy: 'private',
    questions: structuredClone(biologyQuizQuestions),
    revision: 1,
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    canEditContent: true,
    chapters: ['Genetics'],
    createdAt: days(2),
    id: 'qz_2',
    isOwner: true,
    name: 'Genetics check-in',
    privacy: 'private',
    questions: [
      {
        id: 'q7',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0],
              options: ['1:2:1', '3:1', '1:1', '9:3:3:1'],
              type: 'mcq',
            },
            blocks: [
              {
                text: 'A cross between Aa × Aa gives what genotype ratio?',
                type: 'text',
              },
            ],
            id: 'q7:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q8',
        labels: 'letters',
        layout: 'paper',
        level: 'analysis',
        parts: [
          {
            answer: {
              accepted: [
                'an allele expressed in the phenotype even when only one copy is present',
              ],
              type: 'short',
            },
            blocks: [
              {
                text: 'Define a dominant allele in one sentence.',
                type: 'text',
              },
            ],
            id: 'q8:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q15',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: {
              correct: [0],
              options: [
                'Homozygous dominant',
                'Heterozygous',
                'Homozygous recessive',
                'Hemizygous',
              ],
              type: 'mcq',
            },
            blocks: [
              { text: 'The genotype AA is described as…', type: 'text' },
            ],
            id: 'q15:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q16',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { correct: false, type: 'boolean' },
            blocks: [
              {
                text: 'Genotype refers to an organism’s observable physical traits.',
                type: 'text',
              },
            ],
            id: 'q16:part',
            marks: 1,
            solution: [
              {
                text: 'That describes phenotype; genotype is the genetic makeup.',
                type: 'text',
              },
            ],
          },
        ],
        stem: [],
      },
      {
        id: 'q17',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0, 2],
              options: ['AA', 'Aa', 'aa', 'Bb'],
              type: 'multi',
            },
            blocks: [
              { text: 'Select all homozygous genotypes.', type: 'text' },
            ],
            id: 'q17:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q18',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: { accepted: ['Punnett'], type: 'short' },
            blocks: [
              {
                text: 'A diagram used to predict offspring genotypes is a ____ square.',
                type: 'text',
              },
            ],
            id: 'q18:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q19',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { correct: true, type: 'boolean' },
            blocks: [
              {
                text: 'Alleles are alternative forms of the same gene.',
                type: 'text',
              },
            ],
            id: 'q19:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q20',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0],
              options: ['1:1', '3:1', '1:2:1', 'All dominant'],
              type: 'mcq',
            },
            blocks: [
              {
                text: 'A cross Aa × aa gives what phenotype ratio (dominant:recessive)?',
                type: 'text',
              },
            ],
            id: 'q20:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q21',
        labels: 'letters',
        layout: 'paper',
        level: 'analysis',
        parts: [
          {
            answer: {
              items: ['Prophase', 'Metaphase', 'Anaphase', 'Telophase'],
              type: 'ordering',
            },
            blocks: [{ text: 'Order the phases of mitosis.', type: 'text' }],
            id: 'q21:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q22',
        labels: 'letters',
        layout: 'paper',
        level: 'analysis',
        parts: [
          {
            answer: {
              accepted: ['the observable characteristics of an organism'],
              type: 'short',
            },
            blocks: [
              { text: 'Define phenotype in one sentence.', type: 'text' },
            ],
            id: 'q22:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
    ],
    revision: 1,
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    canEditContent: true,
    chapters: ['Techniques of integration'],
    createdAt: days(6),
    id: 'qz_3',
    isOwner: true,
    name: 'Integration techniques',
    privacy: 'private',
    questions: [
      {
        id: 'q9',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [1],
              options: [
                'Substitution',
                'Integration by parts',
                'Partial fractions',
                'Trig substitution',
              ],
              type: 'mcq',
            },
            blocks: [{ text: '∫ x·eˣ dx is best solved by…', type: 'text' }],
            id: 'q9:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q10',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { correct: true, type: 'boolean' },
            blocks: [{ text: '∫ 1/x dx = ln|x| + C', type: 'text' }],
            id: 'q10:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q23',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0],
              options: ['sin x + C', '-sin x + C', 'cos x + C', '-cos x + C'],
              type: 'mcq',
            },
            blocks: [{ text: '∫ cos x dx = ?', type: 'text' }],
            id: 'q23:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q24',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { correct: true, type: 'boolean' },
            blocks: [
              {
                text: 'The integral of a sum equals the sum of the integrals.',
                type: 'text',
              },
            ],
            id: 'q24:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q25',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: { accepted: ['C'], type: 'short' },
            blocks: [{ text: '∫ 2x dx = x² + ____.', type: 'text' }],
            id: 'q25:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q26',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0],
              options: ['arctan x + C', 'ln|x| + C', 'arcsin x + C', '1/x + C'],
              type: 'mcq',
            },
            blocks: [{ text: '∫ 1/(1 + x²) dx = ?', type: 'text' }],
            id: 'q26:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q27',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { correct: true, type: 'boolean' },
            blocks: [{ text: 'd/dx of ∫ f(x) dx returns f(x).', type: 'text' }],
            id: 'q27:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q28',
        labels: 'letters',
        layout: 'paper',
        level: 'application',
        parts: [
          {
            answer: {
              correct: [0, 1],
              options: [
                'Partial fractions',
                'Polynomial long division',
                'Integration by parts',
                'Trig substitution',
              ],
              type: 'multi',
            },
            blocks: [
              {
                text: 'Which techniques help integrate rational functions?',
                type: 'text',
              },
            ],
            id: 'q28:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q29',
        labels: 'letters',
        layout: 'paper',
        level: 'analysis',
        parts: [
          {
            answer: {
              items: [
                'Choose u and dv',
                'Differentiate u',
                'Integrate dv',
                'Apply the formula',
              ],
              type: 'ordering',
            },
            blocks: [
              {
                text: 'Order the steps of integration by parts.',
                type: 'text',
              },
            ],
            id: 'q29:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
      {
        id: 'q30',
        labels: 'letters',
        layout: 'paper',
        level: 'recall',
        parts: [
          {
            answer: { accepted: ['constant of integration'], type: 'short' },
            blocks: [
              {
                text: 'Name the constant added to every indefinite integral.',
                type: 'text',
              },
            ],
            id: 'q30:part',
            marks: 1,
            solution: [],
          },
        ],
        stem: [],
      },
    ],
    revision: 1,
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
];

/** Seed answers are written per question; grading reads them per part. */
const byPart = (answers: Record<string, Answer>) =>
  Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [`${id}:part`, a])
  );

type SeedAttempt = Attempt & { answers?: Answers; questions?: Question[] };

/** A seeded attempt graded the way the server stores one. */
function seedAttempt(
  quiz: EditableQuiz,
  answers: Answers,
  fields: Omit<
    SeedAttempt,
    'answers' | 'correct' | 'materialId' | 'pct' | 'questions' | 'total'
  >,
  /** Open parts' item marks, standing in for Jev's. */
  itemAwards: Record<string, number[]> = {}
): SeedAttempt {
  const graded = gradeQuestions(quiz.questions, answers);
  const questions = graded.questions.map((question) => ({
    ...question,
    parts: question.parts.map((part) =>
      itemAwards[part.id] ? applyItemAwards(part, itemAwards[part.id]) : part
    ),
  }));
  const correct = questions
    .flatMap((question) => question.parts)
    .reduce((sum, part) => sum + (part.awarded ?? 0), 0);
  return {
    ...fields,
    answers,
    correct,
    materialId: quiz.id,
    pct: Math.round((correct / graded.max) * 100),
    questions,
    total: graded.max,
  };
}

/** An attempt as lists carry it: the score, without answers or graded questions. */
export const attemptSummary = ({
  answers: _,
  questions: __,
  ...attempt
}: SeedAttempt): Attempt => attempt;

export const attempts: SeedAttempt[] = [
  seedAttempt(
    seedQuizzes[0],
    {
      ...byPart({
        q1: [1],
        q2: true,
        q3: [1, 2],
        q4: 'osmosis',
        q5: [
          'Ribosome',
          'Rough ER',
          'Golgi apparatus',
          'Vesicle',
          'Cell membrane',
        ],
        // Wrong: swapped Nucleus/Mitochondria functions.
        q6: {
          0: 'Makes ATP using a proton gradient',
          1: 'Stores DNA',
          2: 'Builds proteins',
          3: 'Makes ATP using a proton gradient',
        },
        q11: [1],
        q12: true, // Wrong: correct answer is false.
        q13: '24/8',
        q14: 'The rate stays at 6 because extra light no longer increases photosynthesis.',
        q15: ['mitochondria', 'glucose', ''],
      }),
      'q14:control': null,
      'q14:increase': '4',
    },
    {
      chapters: ['Cell structure'],
      id: 'at_1',
      quizName: 'Cell biology basics',
      takenAt: days(2),
      workspaceName: 'Biology 101',
    },
    // Full, half and none of the open part's first three items' marks.
    Object.fromEntries(
      seedQuizzes[0].questions
        .flatMap((question) => question.parts)
        .flatMap((part) =>
          part.answer.type === 'open' && part.markscheme
            ? [
                [
                  part.id,
                  part.markscheme.map((item, i) =>
                    i === 0 ? item.marks : i === 1 ? item.marks / 2 : 0
                  ),
                ],
              ]
            : []
        )
    )
  ),
  seedAttempt(
    seedQuizzes[2],
    byPart({
      q9: [1],
      q10: true,
      q23: [0],
      q24: true,
      q25: 'C',
      q26: [0],
      q27: false, // Wrong: correct answer is true.
      q28: [0], // Wrong: correct is [0, 1].
      // Wrong order.
      q29: [
        'Apply the formula',
        'Choose u and dv',
        'Integrate dv',
        'Differentiate u',
      ],
      q30: '', // Blank: wrong.
    }),
    {
      chapters: ['Techniques of integration'],
      id: 'at_2',
      quizName: 'Integration techniques',
      takenAt: days(3),
      workspaceName: 'Calculus II',
    }
  ),
  seedAttempt(
    seedQuizzes[1],
    byPart({
      q7: [0],
      q8: '', // Blank: wrong.
      q15: [0],
      q16: true, // Wrong: correct answer is false.
      q17: [0], // Wrong: correct is [0, 2].
      q18: 'Punnett',
      q19: true,
      q20: [1], // Wrong: correct is [0].
      q21: ['Telophase', 'Anaphase', 'Metaphase', 'Prophase'], // Wrong order.
      q22: '', // Blank: wrong.
    }),
    {
      chapters: ['Genetics'],
      id: 'at_3',
      quizName: 'Genetics check-in',
      takenAt: days(5),
      workspaceName: 'Biology 101',
    }
  ),
];

const seedFlashcardSets: FlashcardSet[] = [
  {
    canEdit: true,
    canEditContent: true,
    cardCount: 32,
    color: 'green',
    id: 'dk_1',
    isOwner: true,
    name: 'Cell organelles',
    privacy: 'private',
    revision: 1,
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    canEditContent: true,
    cardCount: 24,
    color: 'purple',
    id: 'dk_2',
    isOwner: true,
    name: 'Integration rules',
    privacy: 'private',
    revision: 1,
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
  {
    canEdit: true,
    canEditContent: true,
    cardCount: 40,
    color: 'amber',
    id: 'dk_3',
    isOwner: true,
    name: 'History dates',
    privacy: 'private',
    revision: 1,
    workspaceId: 'ws_hist',
    workspaceName: 'World History',
  },
];

const seedCards: Flashcard[] = [
  seedCard(
    'c_1',
    'dk_1',
    'Mitochondria',
    'Powerhouse of the cell — produces ATP.'
  ),
  seedCard('c_2', 'dk_1', 'Nucleus', 'Stores DNA and controls cell activity.'),
  seedCard('c_3', 'dk_1', 'Ribosome', 'Site of protein synthesis.'),
  seedCard('c_4', 'dk_1', 'Golgi apparatus', 'Packages and ships proteins.'),
  seedCard('c_7', 'dk_1', 'Lysosome', 'Digests waste with hydrolytic enzymes.'),
  seedCard(
    'c_8',
    'dk_1',
    'Endoplasmic reticulum',
    'Rough ER makes proteins; smooth ER makes lipids.'
  ),
  seedCard('c_5', 'dk_2', '∫ eˣ dx', 'eˣ + C'),
  seedCard('c_6', 'dk_2', '∫ 1/x dx', 'ln|x| + C'),
  seedCard('c_9', 'dk_2', '∫ cos x dx', 'sin x + C'),
  seedCard('c_10', 'dk_3', 'Fall of the Berlin Wall', '1989'),
  seedCard('c_11', 'dk_3', 'End of WWII', '1945'),
];

export const labels: Label[] = [
  { color: 'green', id: 'lb_bio', name: 'Biology' },
  { color: 'purple', id: 'lb_calc', name: 'Calculus' },
  { color: 'amber', id: 'lb_hist', name: 'History' },
  { color: 'coral', id: 'lb_exam', name: 'Exam' },
  { color: 'blue', id: 'lb_study', name: 'Study group' },
];

export const events: CalendarEvent[] = [
  {
    end: todayAt(9),
    id: 'ev_1',
    labelIds: ['lb_bio'],
    location: 'Room B2 · 158',
    start: todayAt(8),
    title: 'Biology lecture',
  },
  {
    end: todayAt(12, 30),
    id: 'ev_2',
    labelIds: ['lb_calc', 'lb_study'],
    location: 'Room 124',
    start: todayAt(11),
    title: 'Calculus tutorial',
  },
  {
    end: todayAt(16),
    id: 'ev_3',
    labelIds: ['lb_hist', 'lb_exam'],
    start: todayAt(15),
    title: 'History essay due',
  },
  {
    end: dateAt(1, 15),
    id: 'ev_4',
    labelIds: ['lb_study'],
    location: 'Library',
    start: dateAt(1, 13),
    title: 'Study group',
  },
  {
    end: dateAt(2, 11),
    id: 'ev_5',
    labelIds: ['lb_exam'],
    location: 'Hall A',
    start: dateAt(2, 9),
    title: 'Chem midterm',
  },
  {
    end: dateAt(-30, 11),
    id: 'ev_6',
    labelIds: ['lb_bio'],
    start: dateAt(-30, 10),
    title: 'Past revision',
  },
];

export const tasks: Task[] = [
  {
    done: false,
    dueDate: todayAt(23),
    id: 'tk_1',
    meta: 'Biology 101 this is again a really long meta just to make sure everything works',
    title:
      'Read Chapter 3 — Genetics b labdl ab lb la this is really long I guess just to make sure everything works',
  },
  {
    done: false,
    dueDate: todayAt(23),
    id: 'tk_2',
    meta: 'Calculus II · 12 problems',
    title: 'Finish integration worksheet',
  },
  {
    done: true,
    dueDate: todayAt(23),
    id: 'tk_3',
    meta: 'Cell organelles',
    title: 'Review flashcards',
  },
  {
    done: false,
    dueDate: dateAt(1, 23),
    id: 'tk_4',
    meta: 'World History',
    title: 'Outline history essay',
  },
  {
    done: false,
    dueDate: todayAt(23),
    id: 'tk_5',
    meta: 'Biology 101 this is again a really long meta just to make sure everything works',
    title:
      'Read Chapter 3 — Genetics b labdl ab lb la this is really long I guess just to make sure everything works',
  },
];

export const notifications: AppNotification[] = [
  {
    at: hours(1),
    data: { code: 'source_batch', done: 3, failed: 1, source: 'upload' },
    id: 'nt_1',
    kind: 'system',
  },
  {
    at: hours(5),
    data: {
      code: 'model_deprecated',
      fromName: 'Previous model',
      toName: 'GLM-5.3 Flash',
    },
    id: 'nt_2',
    kind: 'system',
  },
  {
    at: hours(26),
    data: { role: 'editor', workspaceName: 'Biology' },
    id: 'nt_3',
    kind: 'workspace_role_changed',
  },
];

export const notificationPrefs: NotificationPrefs = {
  emailBilling: true,
  emailWorkspaceInvite: true,
};

export const accountStatus: AccountStatus = {
  planTier: 'pro',
  state: 'active',
  storageLimitBytes: PLAN_LIMITS.pro.storageLimitBytes,
  storageUsage: 'ok',
  storageUsedBytes: 128 * 1024 * 1024,
  userId: user.id,
};

export const canvases: ThinkingCanvas[] = [
  { id: 'cv_1', name: 'Bio mind map', updatedAt: hours(4) },
  { id: 'cv_2', name: 'Essay brainstorm', updatedAt: days(2) },
];

/* ---------------- study materials (mindmaps / diagrams) ---------------- */
const ownerCapabilities = {
  canEdit: true,
  canEditContent: true,
  canManageMembers: true,
  canView: true,
};

/** Counters `makeMaterial` owns outright — they are a function of the document,
 * so letting a fixture state them is how they drift. */
type MaterialMetrics = 'contentBytes' | 'maxDepth' | 'nodeCount';

/** Wire fields with an obvious default for authored content. */
type MaterialDefaults = 'isOwner' | 'position' | 'revision' | 'updatedAt';

export type MaterialDraft = Omit<Material, MaterialMetrics | MaterialDefaults> &
  Partial<Pick<Material, MaterialDefaults>>;

/** Next free slot in the bucket an item is filed under. Files and materials
 * share one ordering per (workspace, chapter). */
export function nextContentPosition(
  workspaceId: string,
  chapterId: string | null
): number {
  const taken = [...files, ...materials]
    .filter(
      (item) => item.workspaceId === workspaceId && item.chapterId === chapterId
    )
    .map((item) => item.position);
  return taken.length ? Math.max(...taken) + 1 : 0;
}

/** Complete a fixture draft into the full wire shape the API always returns. */
export function makeMaterial(draft: MaterialDraft): Material {
  const metrics = parseMaterialDocumentWithMetrics(draft.content)?.metrics ?? {
    maxDepth: 0,
    nodeCount: 0,
  };
  return {
    isOwner: true,
    position: nextContentPosition(draft.workspaceId, draft.chapterId),
    revision: 1,
    updatedAt: draft.createdAt,
    ...draft,
    contentBytes: materialContentBytes(draft.content),
    maxDepth: metrics.maxDepth,
    nodeCount: metrics.nodeCount,
  };
}

export const materials: Material[] = [];

/** Unprocessed source edits by file, for the Indexing tab. `ticks` counts the
 * stats reads since the state was entered, so the handler advances queued
 * work as the tab polls. */
export const fileChanges = new Map<
  string,
  { lastEditedAt: string; ticks: number; state: FileChange['state'] }
>([
  [
    'bio-office-docx',
    {
      lastEditedAt: '2026-01-12T09:30:00Z',
      state: 'processing',
      ticks: 0,
    },
  ],
  [
    'bio-office-pptx',
    {
      lastEditedAt: '2026-01-12T10:05:00Z',
      state: 'queued',
      ticks: 0,
    },
  ],
  [
    'bio-office-xlsx',
    {
      lastEditedAt: '2026-01-11T16:20:00Z',
      state: 'failed',
      ticks: 0,
    },
  ],
  [
    'f_2',
    {
      lastEditedAt: '2026-01-12T11:00:00Z',
      state: 'waiting',
      ticks: 0,
    },
  ],
]);

const seedMaterials: MaterialDraft[] = [
  {
    capabilities: ownerCapabilities,
    chapterId: 'ch_1',
    content: createMaterialDocument([
      mermaidNode(
        'mindmap\n  root((Cell))\n    Membrane\n      Phospholipid bilayer\n      Transport\n        Diffusion\n        Osmosis\n    Organelles\n      Nucleus\n      Mitochondria\n      Ribosome\n    Energy\n      ATP\n      Respiration'
      ),
    ]),
    createdAt: days(3),
    id: 'mat_1',
    kind: 'mindmap',
    privacy: 'private',
    role: 'owner',
    scopeChapters: ['Cell structure', 'Membranes & transport'],
    scopeFileNames: [],
    title: 'Cell biology mindmap',
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    capabilities: ownerCapabilities,
    chapterId: null,
    content: createMaterialDocument([
      mermaidNode(
        'flowchart LR\n  Ribosome --> RoughER\n  RoughER --> Golgi\n  Golgi --> Vesicle\n  Vesicle --> Membrane[Cell membrane]'
      ),
    ]),
    createdAt: days(1),
    id: 'mat_2',
    kind: 'diagram',
    privacy: 'private',
    role: 'owner',
    scopeChapters: [],
    scopeFileNames: ['Cell structure.pdf'],
    title: 'Protein secretion pathway',
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
];
for (const draft of seedMaterials) materials.push(makeMaterial(draft));

for (const fixture of errorMaterials) {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument(
        fixture.kind === 'diagram'
          ? [mermaidNode('flowchart LR\n  A[Unclosed node')]
          : [{ children: [{ text: 'Error preview fixture.' }], type: 'p' }]
      ),
      createdAt: days(1),
      id: fixture.id,
      kind: fixture.kind,
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: fixture.title,
      workspaceId: 'ws_bio',
      workspaceName: 'Biology 101',
    })
  );
}

/* Rich Plate notes live in mocks/noteContent (one fixture set per workspace). */
for (const note of seedNotes) {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: note.chapterId,
      content: createMaterialDocument(note.value),
      createdAt: days(note.daysAgo),
      id: note.id,
      kind: 'note',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: note.title,
      workspaceId: note.workspaceId,
      workspaceName: note.workspaceName,
    })
  );
}

// Three pages of standalone notes at the default 40-item page size.
for (let index = 1; index <= 85; index++) {
  const title = `Study journal ${String(index).padStart(3, '0')}`;
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument([
        {
          children: [
            {
              text: `${title}: review notes and questions for this study session.`,
            },
          ],
          type: 'p',
        },
      ]),
      createdAt: days(index),
      id: `mat_pagination_${index}`,
      kind: 'note',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title,
      workspaceId: '',
      workspaceName: '',
    })
  );
}

/* ---------------- chat: conversations + messages ---------------- */
export const conversations: Conversation[] = [
  {
    createdAt: days(1),
    id: 'conv_seed1',
    title: 'What is a cell?',
    updatedAt: hours(3),
    workspaceId: workspaces[0].id,
  },
];

/** Owner-only trash bin: metadata rows plus the original record so restore can
 * put it back exactly where it was. */
export const trash: Array<{
  file?: SourceFile;
  item: TrashItem;
  material?: Material;
}> = [];

files
  .filter((file) => ['f_1', 'f_2', 'f_7'].includes(file.id))
  .flatMap((source) => Array.from({ length: 29 }, () => source))
  .forEach((source, index) => {
    const file: SourceFile = {
      ...source,
      chapterId: null,
      id: `trash_seed_${source.id}_${index}`,
      name: `Archived ${String(index + 1).padStart(3, '0')} ${source.name}`,
      position: nextContentPosition(source.workspaceId, null) + index,
    };
    fileLinks[file.id] = { ...fileLinks[source.id] };
    trash.push({
      file,
      item: {
        episodeId: `episode_${file.id}`,
        fileKind: file.kind,
        id: file.id,
        kind: 'source_file',
        purgeAfter: hours(index + 1 - 30 * 24),
        sizeBytes: file.sizeBytes,
        title: file.name,
        trashedAt: hours(index + 1),
        workspaceId: file.workspaceId,
        workspaceName: workspaces.find(
          (workspace) => workspace.id === file.workspaceId
        )?.name,
      },
    });
  });

export const chatMessages: WireMessage[] = [
  {
    citations: null,
    content: 'What is a cell?',
    conversationId: 'conv_seed1',
    createdAt: days(1),
    id: 'm_seed1',
    role: 'user',
    status: 'complete',
  },
  {
    citations: files[0]
      ? [
          {
            fileId: files[0].id,
            fileName: files[0].name,
            pageEnd: 1,
            pageStart: 1,
            regions: [
              {
                bbox: [100, 100, 500, 200],
                page: 1,
                space: 'page-1000-topleft',
              },
            ],
            snippet: 'The cell is the basic unit of life…',
          },
        ]
      : null,
    content:
      'A **cell** is the basic structural and functional unit of life.\n\n- Bounded by a **membrane** that controls transport\n- Contains **organelles** like the nucleus and mitochondria\n- Produces energy (ATP) in the **mitochondria**',
    conversationId: 'conv_seed1',
    createdAt: days(1),
    id: 'm_seed2',
    modelDisplayName: 'DeepSeek Flash',
    modelSlug: 'deepseek-flash',
    modelVersion: 1,
    providerSlug: 'deepseek',
    role: 'assistant',
    status: 'complete',
  },
];

// Every preview is also a saved conversation, so history needs no streamed turn.
chatFixtures.forEach((fixture, index) => {
  const conversationId = `conv_${fixture.id}`;
  const createdAt = hours(index + 4);
  const result = fixtureResult(fixture);
  conversations.push({
    createdAt,
    id: conversationId,
    title: fixture.label,
    updatedAt: createdAt,
    workspaceId: 'ws_bio',
  });
  chatMessages.push(
    {
      content: fixture.prompt,
      conversationId,
      createdAt,
      id: `${conversationId}_user`,
      role: 'user',
      status: 'complete',
    },
    {
      ...mockChatModel,
      ...result,
      activity: [
        {
          callId: `${conversationId}_search`,
          id: `${conversationId}_search`,
          kind: 'tool',
          name: 'search_workspace',
          outcome: 'succeeded',
        },
      ],
      citations:
        result.errorCode === 'response_flagged'
          ? []
          : fixtureCitations(
              fixture,
              files.filter((file) => file.workspaceId === 'ws_bio')
            ),
      conversationId,
      createdAt,
      id: `${conversationId}_assistant`,
      role: 'assistant',
    }
  );
});

export const publicWorkspaces: PublicWorkspace[] = [
  {
    ...workspaces[0],
    author: 'mrslee',
    clones: 1240,
    id: 'pub_ws_1',
    isOwner: false,
    name: 'AP Biology — full course',
    privacy: 'public',
    sharePath: '/w/pub_ws_1.HHb0FBNicpc_Eiu4',
  },
  // A public viewer share role: readable, not clonable, no membership role.
  {
    ...workspaces[2],
    author: 'historyhub',
    canClone: false,
    capabilities: {
      canEdit: false,
      canEditContent: false,
      canManageMembers: false,
      canView: true,
    },
    clones: 860,
    id: 'pub_ws_2',
    isOwner: false,
    name: 'Modern World History',
    privacy: 'public',
    role: undefined,
    sharePath: '/w/pub_ws_2.IT_5zt_99G56MWnD',
  },
];
/** Explore's quizzes with their keys; the route sends learner views. */
export const publicQuizzes: (Omit<PublicQuiz, 'questions'> & {
  questions: Question[];
})[] = [
  {
    ...seedQuizzes[0],
    author: 'mrslee',
    clones: 540,
    id: 'pub_qz_1',
    isOwner: false,
    name: 'Cell biology — 50 questions',
    privacy: 'public',
  },
  {
    ...seedQuizzes[2],
    author: 'mathpro',
    clones: 410,
    id: 'pub_qz_2',
    isOwner: false,
    name: 'Calculus II mega quiz',
    privacy: 'public',
  },
];
export const publicFlashcardSets: PublicFlashcardSet[] = [
  {
    ...seedFlashcardSets[0],
    author: 'mrslee',
    clones: 320,
    id: 'pub_dk_1',
    isOwner: false,
    name: 'Cell biology essentials',
    privacy: 'public',
  },
  {
    ...seedFlashcardSets[1],
    author: 'mathpro',
    clones: 205,
    id: 'pub_dk_2',
    isOwner: false,
    name: 'Calculus formulas',
    privacy: 'public',
  },
];

/* ---------------- unified markdown materials + derived views ----------------
   Markdown (materials[].content) is the source of truth for quiz/flashcard
   content; the card -> set lookup lives in flashcardCards. The seed quizzes/flashcards/cards
   above are authored as typed data, then folded into markdown materials here so
   the mock mirrors the backend's single-table model. */

/** Comment discussions on materials; the handlers own their writes. */
export const discussions: MaterialDiscussion[] = [];

/** card id -> its flashcard set, like flashcard_cards on the server. */
export const flashcardCards: Record<string, { materialId: string }> = {};
for (const c of seedCards) flashcardCards[c.id] = { materialId: c.materialId };

seedQuizzes.forEach((q) => {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument([
        quizNode({ questions: q.questions }, q.id),
      ]),
      createdAt: q.createdAt,
      id: q.id,
      kind: 'quiz',
      privacy: q.privacy,
      role: 'owner',
      scopeChapters: q.chapters,
      scopeFileNames: [],
      title: q.name,
      workspaceId: q.workspaceId,
      workspaceName: q.workspaceName,
    })
  );
});
seedFlashcardSets.forEach((d, i) => {
  const flashcardSetCards = seedCards.filter((c) => c.materialId === d.id);
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      color: d.color,
      content: createMaterialDocument([
        flashcardsNode(
          flashcardSetCards.map((c) => ({
            back: c.back,
            front: c.front,
            id: c.id,
          })),
          d.id
        ),
      ]),
      createdAt: days(5 + i),
      id: d.id,
      kind: 'flashcards',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: d.name,
      workspaceId: d.workspaceId,
      workspaceName: d.workspaceName,
    })
  );
});
// Standalone link-shared materials for the share pages; add `?anonymous` to
// open them as a signed-out visitor.
materials.push(
  makeMaterial({
    capabilities: ownerCapabilities,
    chapterId: null,
    content: createMaterialDocument([
      quizNode({ questions: seedQuizzes[0].questions }, 'qz_shared'),
    ]),
    createdAt: days(3),
    id: 'qz_shared',
    kind: 'quiz',
    privacy: 'link',
    role: 'owner',
    scopeChapters: [],
    scopeFileNames: [],
    title: 'Shared cell biology quiz',
    workspaceId: '',
    workspaceName: '',
  }),
  makeMaterial({
    capabilities: ownerCapabilities,
    chapterId: null,
    color: 'green',
    content: createMaterialDocument([
      flashcardsNode(
        seedCards
          .filter((c) => c.materialId === seedFlashcardSets[0].id)
          .map((c) => ({ back: c.back, front: c.front, id: `shared_${c.id}` })),
        'dk_shared'
      ),
    ]),
    createdAt: days(3),
    id: 'dk_shared',
    kind: 'flashcards',
    privacy: 'link',
    role: 'owner',
    scopeChapters: [],
    scopeFileNames: [],
    title: 'Shared cell biology cards',
    workspaceId: '',
    workspaceName: '',
  })
);
/* ---------------- editor matrix fixtures (e2e/editor) ---------------- */
if (import.meta.env.VITE_E2E_EDITOR_SEED === 'true') {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument(buildEditorNoteValue() as MaterialValue),
      createdAt: days(1),
      id: EDITOR_NOTE.id,
      kind: 'note',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: EDITOR_NOTE.title,
      workspaceId: EDITOR_WORKSPACE_ID,
      workspaceName: 'Biology 101',
    })
  );
}

/* ---------------- editor perf fixtures (opt-in) ---------------- */
if (import.meta.env.VITE_LOAD_TEST_SEED === 'true') {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument(buildBiologyLoadTestValue()),
      createdAt: days(0),
      id: PERF_LARGE_NOTE.id,
      kind: 'note',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: PERF_LARGE_NOTE.title,
      workspaceId: PERF_WORKSPACE_ID,
      workspaceName: 'Biology 101',
    }),
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument(
        buildSmallPerfDocument().value as MaterialValue
      ),
      createdAt: days(0),
      id: PERF_SMALL_NOTE.id,
      kind: 'note',
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: PERF_SMALL_NOTE.title,
      workspaceId: PERF_WORKSPACE_ID,
      workspaceName: 'Biology 101',
    })
  );
}

/* Embedded quiz and flashcard rows referenced from the note fixtures. */
for (const seed of embeddedSeeds) {
  const note = materials.find((mt) => mt.id === seed.noteId);
  if (!note) continue;
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument([seed.block]),
      createdAt: note.createdAt,
      id: seed.id,
      kind: seed.kind,
      parentMaterialId: note.id,
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title: `${note.title} · ${seed.kind === 'quiz' ? 'Quiz' : 'Flashcards'}`,
      workspaceId: note.workspaceId,
      workspaceName: note.workspaceName,
    })
  );
}

/** Standalone quizzes and flashcard sets share through a signed link. MSW has
 * no Worker to verify it, so the signature is a fixed placeholder. */
export function mockSharePath(mt: Material): string | undefined {
  if (mt.workspaceId || mt.parentMaterialId) return;
  if (mt.kind === 'quiz') return `/share/quizzes/${mt.id}.mswSignature0000`;
  if (mt.kind === 'flashcards')
    return `/share/flashcards/${mt.id}.mswSignature0000`;
}

/** Derive the typed Quiz view from a quiz material (questions from the fence). */
export function quizFromMaterial(mt: Material): EditableQuiz {
  const { questions } =
    typeof mt.content === 'string'
      ? parseQuizBlock(mt.content)
      : quizElementToBlock(
          mt.content.value.find((node) => node.type === 'quiz') as QuizElement
        );
  return {
    canEdit: true,
    canEditContent: true,
    chapters: mt.scopeChapters,
    createdAt: mt.createdAt,
    id: mt.id,
    isOwner: true,
    name: mt.title,
    privacy: mt.privacy,
    questions,
    revision: mt.revision,
    sharePath: mockSharePath(mt),
    workspaceId: mt.workspaceId,
    workspaceName: mt.workspaceName,
  };
}

/** A quiz material as its readers get it: each question in its learner view.
 * Other kinds are unchanged. */
export function learnerMaterial(material: Material): Material {
  if (material.kind !== 'quiz') return material;
  const quiz =
    typeof material.content === 'string'
      ? undefined
      : material.content.value.find((node) => node.type === 'quiz');
  const { questions } = quizFromMaterial(material);
  return {
    ...material,
    content: {
      schemaVersion: MATERIAL_SCHEMA_VERSION,
      value: [
        {
          children: questions.length
            ? questions.map((question) => ({
                children: [{ text: '' }],
                id: question.id,
                // The node is typed for authored questions; readers get the learner view.
                question: learnerView(question) as unknown as Question,
                type: 'quiz_question' as const,
              }))
            : [{ text: '' }],
          id: quiz?.id ?? material.id,
          type: 'quiz',
        },
      ],
    },
  };
}

/** Derive the typed cards for a flashcards material (from the fence). */
export function cardsFromMaterial(mt: Material): Flashcard[] {
  const cards =
    typeof mt.content === 'string'
      ? parseFlashcardsBlock(mt.content).cards
      : flashcardsElementToCards(
          mt.content.value.find(
            (node) => node.type === 'flashcards'
          ) as FlashcardsElement
        );
  return cards.map((c) => ({
    back: c.back,
    front: c.front,
    id: c.id,
    materialId: mt.id,
    revision: mt.revision,
  }));
}

/** Derive the typed FlashcardSet view (counts computed live). */
export function flashcardSetFromMaterial(mt: Material): FlashcardSet {
  const cs = cardsFromMaterial(mt);
  return {
    canEdit: true,
    canEditContent: true,
    cardCount: cs.length,
    color: mt.color ?? 'green',
    id: mt.id,
    isOwner: true,
    name: mt.title,
    privacy: mt.privacy,
    revision: mt.revision,
    sharePath: mockSharePath(mt),
    workspaceId: mt.workspaceId,
    workspaceName: mt.workspaceName,
  };
}

/** One Create page row for a material, with the per-kind counts the card shows. */
export function materialListItem(mt: Material): MaterialListItem {
  const parent = mt.parentMaterialId
    ? materials.find((p) => p.id === mt.parentMaterialId)
    : undefined;
  const quiz = mt.kind === 'quiz' ? quizFromMaterial(mt) : undefined;
  const set =
    mt.kind === 'flashcards' ? flashcardSetFromMaterial(mt) : undefined;
  return {
    chapterId: mt.chapterId,
    chapterName: chapters.find((c) => c.id === mt.chapterId)?.name ?? '',
    createdAt: mt.createdAt,
    id: mt.id,
    kind: mt.kind,
    parentMaterialId: mt.parentMaterialId ?? '',
    parentTitle: parent?.title ?? '',
    privacy: mt.privacy,
    sharePath: mockSharePath(mt),
    sizeBytes: mt.contentBytes,
    title: mt.title,
    updatedAt: mt.updatedAt,
    workspaceId: mt.workspaceId,
    workspaceName: mt.workspaceName,
    ...(quiz
      ? {
          questionCount: quiz.questions.length,
        }
      : {}),
    ...(set
      ? {
          cardCount: set.cardCount,
        }
      : {}),
  };
}

/** Convenience accessors for the two derived material kinds. */
export const quizMaterials = () => materials.filter((m) => m.kind === 'quiz');
export const flashcardSetMaterials = () =>
  materials.filter((m) => m.kind === 'flashcards');

/** GET /api/workspaces: search, tag filter and sort. */
export function listWorkspaces(url: URL): Workspace[] {
  const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  const tags = (url.searchParams.get('tag') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  let list = [...workspaces];
  if (q)
    list = list.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.tags.some((t) => t.value.toLowerCase().includes(q))
    );
  if (tags.length) {
    list = list.filter(
      (w) => tags.length > 0 && w.tags.some((t) => tags.includes(t.value))
    );
  }
  switch (url.searchParams.get('sort')) {
    case 'created':
      return list.sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
      );
    case 'chapters':
      return list.sort((a, b) => b.chapterCount - a.chapterCount);
    case 'files':
      return list.sort((a, b) => b.fileCount - a.fileCount);
    default:
      return list.sort(
        (a, b) => +new Date(b.lastAccessedAt) - +new Date(a.lastAccessedAt)
      );
  }
}
