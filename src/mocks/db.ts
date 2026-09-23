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
  Flashcard,
  FlashcardSet,
  Label,
  Material,
  MaterialListItem,
  NotificationPrefs,
  PublicFlashcardSet,
  PublicQuiz,
  PublicWorkspace,
  Question,
  Quiz,
  SourceFile,
  SrsState,
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
import { isDue, isKnown, newSrsState, reviewSrs } from '@/lib/srs';
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
const wv = (...ss: string[]) => ss.map((value) => ({ value }));

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

/**
 * Seed SRS scheduling state. Unknown cards stay due now (they surface in the
 * study queue); "known" cards get a couple of Good reviews to push their due
 * date out so they are not immediately due.
 */
function seedSrs(known: boolean): SrsState {
  let s = newSrsState();
  if (known) {
    s = reviewSrs(s, 'good');
    s = reviewSrs(s, 'good');
  }
  return s;
}
function seedCard(
  id: string,
  materialId: string,
  front: string,
  back: string,
  known: boolean
): Flashcard {
  const srs = seedSrs(known);
  return { back, front, id, known: isKnown(srs), materialId, srs };
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
  generateModel: {
    modelSlug: 'deepseek-flash',
    providerSlug: 'deepseek',
  },
  id: 'u_1',
  locale: 'en',
  name: 'Kate Malone',
  planTier: 'pro',
  streak: 0,
  subscriptionStatus: 'active',
};

export const llmCredentials: Record<string, string> = {};

export const userThinking: Record<string, Record<string, string>> = {};

export const workspaces: Workspace[] = [
  {
    autoReindex: true,
    autoReparse: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 6,
    createdAt: days(40),
    description: '',
    fileCount: 24,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-01',
    id: 'ws_bio',
    isOwner: true,
    lastAccessedAt: hours(3),
    name: 'Biology 101',
    privacy: 'private',
    role: 'owner',
    shareRole: 'viewer',
    storageOwnerName: user.name,
    tags: ct('tag_1', 'tag_2'),
  },
  {
    autoReindex: true,
    autoReparse: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 4,
    createdAt: days(30),
    description: '',
    fileCount: 12,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-02',
    id: 'ws_calc',
    isOwner: true,
    lastAccessedAt: days(1),
    name: 'Calculus II',
    privacy: 'private',
    role: 'owner',
    shareRole: 'viewer',
    storageOwnerName: user.name,
    tags: ct('tag_3', 'tag_4'),
  },
  {
    autoReindex: true,
    autoReparse: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 5,
    createdAt: days(22),
    description: '',
    fileCount: 18,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-03',
    id: 'ws_hist',
    isOwner: true,
    lastAccessedAt: days(2),
    name: 'World History',
    privacy: 'link',
    role: 'owner',
    shareRole: 'viewer',
    storageOwnerName: user.name,
    tags: ct('tag_5', 'tag_6', 'tag_war'),
  },
  {
    autoReindex: true,
    autoReparse: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 3,
    createdAt: days(12),
    description: '',
    fileCount: 9,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-04',
    id: 'ws_chem',
    isOwner: true,
    lastAccessedAt: days(5),
    name: 'Organic Chemistry',
    privacy: 'private',
    role: 'owner',
    shareRole: 'viewer',
    storageOwnerName: user.name,
    tags: ct('tag_7'),
  },
  {
    autoReindex: true,
    autoReparse: true,
    canClone: true,
    capabilities: {
      canEdit: true,
      canManageMembers: true,
      canView: true,
    },
    chapterCount: 7,
    createdAt: days(8),
    description: '',
    fileCount: 21,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-05',
    id: 'ws_eng',
    isOwner: true,
    lastAccessedAt: hours(20),
    name: 'English Literature',
    privacy: 'public',
    role: 'owner',
    shareRole: 'viewer',
    storageOwnerName: user.name,
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

// Keep Biology's card totals in step with its file-state showcase.
workspaces[0].fileCount = files.filter(
  (file) => file.workspaceId === 'ws_bio'
).length;

const seedQuizzes: Quiz[] = [
  {
    canEdit: true,
    chapters: ['Cell structure', 'Membranes & transport'],
    createdAt: days(4),
    id: 'qz_1',
    isOwner: true,
    name: 'Cell biology basics',
    privacy: 'private',
    questions: [
      {
        correct: [1],
        explanation: 'Mitochondria produce ATP through cellular respiration.',
        id: 'q1',
        level: 'recall',
        options: [
          {
            explanation: 'The nucleus stores DNA; it does not make ATP.',
            value: 'Nucleus',
          },
          {
            explanation:
              'Correct — mitochondria produce ATP via cellular respiration.',
            value: 'Mitochondria',
          },
          {
            explanation: 'Ribosomes build proteins, not energy.',
            value: 'Ribosome',
          },
          {
            explanation: 'The Golgi packages and ships proteins.',
            value: 'Golgi apparatus',
          },
        ],
        prompt: 'Which organelle is the powerhouse of the cell?',
        type: 'mcq',
      },
      {
        correct: true,
        id: 'q2',
        level: 'recall',
        prompt: 'The cell membrane is a phospholipid bilayer.',
        type: 'boolean',
      },
      {
        correct: [1, 2],
        id: 'q3',
        level: 'application',
        options: wv('Ribosome', 'Nucleus', 'Mitochondria', 'Cytosol'),
        prompt: 'Select all that are membrane-bound organelles.',
        type: 'multi',
      },
      {
        accepted: wv('osmosis'),
        id: 'q4',
        level: 'application',
        prompt: 'The diffusion of water across a membrane is called ____.',
        type: 'short',
      },
      {
        id: 'q5',
        items: wv(
          'Ribosome',
          'Rough ER',
          'Golgi apparatus',
          'Vesicle',
          'Cell membrane'
        ),
        level: 'analysis',
        prompt: 'Order the path of protein secretion.',
        type: 'ordering',
      },
      {
        id: 'q6',
        level: 'application',
        pairs: [
          { left: 'Nucleus', right: 'Stores DNA' },
          { left: 'Mitochondria', right: 'Makes ATP' },
          { left: 'Ribosome', right: 'Builds proteins' },
        ],
        prompt: 'Match the organelle to its function.',
        type: 'matching',
      },
      {
        correct: [1],
        id: 'q11',
        level: 'recall',
        options: wv('Cell wall', 'Cell membrane', 'Nucleolus', 'Vacuole'),
        prompt: 'Which structure controls what enters and leaves the cell?',
        type: 'mcq',
      },
      {
        correct: false,
        explanation: 'Ribosomes are not enclosed by a membrane.',
        id: 'q12',
        level: 'recall',
        prompt: 'Ribosomes are membrane-bound organelles.',
        type: 'boolean',
      },
      {
        accepted: wv('mitochondria', 'mitochondrion'),
        id: 'q13',
        level: 'application',
        prompt:
          'The organelle that produces most of the cell’s ATP is the ____.',
        type: 'short',
      },
      {
        accepted: wv('cellular respiration', 'aerobic respiration'),
        id: 'q14',
        level: 'analysis',
        prompt: 'Name the process cells use to convert glucose into ATP.',
        type: 'short',
      },
    ],
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    chapters: ['Genetics'],
    createdAt: days(2),
    id: 'qz_2',
    isOwner: true,
    name: 'Genetics check-in',
    privacy: 'private',
    questions: [
      {
        correct: [0],
        id: 'q7',
        level: 'application',
        options: wv('1:2:1', '3:1', '1:1', '9:3:3:1'),
        prompt: 'A cross between Aa × Aa gives what genotype ratio?',
        type: 'mcq',
      },
      {
        accepted: wv(
          'an allele expressed in the phenotype even when only one copy is present'
        ),
        id: 'q8',
        level: 'analysis',
        prompt: 'Define a dominant allele in one sentence.',
        type: 'short',
      },
      {
        correct: [0],
        id: 'q15',
        level: 'recall',
        options: wv(
          'Homozygous dominant',
          'Heterozygous',
          'Homozygous recessive',
          'Hemizygous'
        ),
        prompt: 'The genotype AA is described as…',
        type: 'mcq',
      },
      {
        correct: false,
        explanation:
          'That describes phenotype; genotype is the genetic makeup.',
        id: 'q16',
        level: 'recall',
        prompt: 'Genotype refers to an organism’s observable physical traits.',
        type: 'boolean',
      },
      {
        correct: [0, 2],
        id: 'q17',
        level: 'application',
        options: wv('AA', 'Aa', 'aa', 'Bb'),
        prompt: 'Select all homozygous genotypes.',
        type: 'multi',
      },
      {
        accepted: wv('Punnett'),
        id: 'q18',
        level: 'application',
        prompt:
          'A diagram used to predict offspring genotypes is a ____ square.',
        type: 'short',
      },
      {
        correct: true,
        id: 'q19',
        level: 'recall',
        prompt: 'Alleles are alternative forms of the same gene.',
        type: 'boolean',
      },
      {
        correct: [0],
        id: 'q20',
        level: 'application',
        options: wv('1:1', '3:1', '1:2:1', 'All dominant'),
        prompt:
          'A cross Aa × aa gives what phenotype ratio (dominant:recessive)?',
        type: 'mcq',
      },
      {
        id: 'q21',
        items: wv('Prophase', 'Metaphase', 'Anaphase', 'Telophase'),
        level: 'analysis',
        prompt: 'Order the phases of mitosis.',
        type: 'ordering',
      },
      {
        accepted: wv('the observable characteristics of an organism'),
        id: 'q22',
        level: 'analysis',
        prompt: 'Define phenotype in one sentence.',
        type: 'short',
      },
    ],
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    chapters: ['Techniques of integration'],
    createdAt: days(6),
    id: 'qz_3',
    isOwner: true,
    name: 'Integration techniques',
    privacy: 'private',
    questions: [
      {
        correct: [1],
        id: 'q9',
        level: 'application',
        options: wv(
          'Substitution',
          'Integration by parts',
          'Partial fractions',
          'Trig substitution'
        ),
        prompt: '∫ x·eˣ dx is best solved by…',
        type: 'mcq',
      },
      {
        correct: true,
        id: 'q10',
        level: 'recall',
        prompt: '∫ 1/x dx = ln|x| + C',
        type: 'boolean',
      },
      {
        correct: [0],
        id: 'q23',
        level: 'application',
        options: wv('sin x + C', '-sin x + C', 'cos x + C', '-cos x + C'),
        prompt: '∫ cos x dx = ?',
        type: 'mcq',
      },
      {
        correct: true,
        id: 'q24',
        level: 'recall',
        prompt: 'The integral of a sum equals the sum of the integrals.',
        type: 'boolean',
      },
      {
        accepted: wv('C'),
        id: 'q25',
        level: 'application',
        prompt: '∫ 2x dx = x² + ____.',
        type: 'short',
      },
      {
        correct: [0],
        id: 'q26',
        level: 'application',
        options: wv('arctan x + C', 'ln|x| + C', 'arcsin x + C', '1/x + C'),
        prompt: '∫ 1/(1 + x²) dx = ?',
        type: 'mcq',
      },
      {
        correct: true,
        id: 'q27',
        level: 'recall',
        prompt: 'd/dx of ∫ f(x) dx returns f(x).',
        type: 'boolean',
      },
      {
        correct: [0, 1],
        id: 'q28',
        level: 'application',
        options: wv(
          'Partial fractions',
          'Polynomial long division',
          'Integration by parts',
          'Trig substitution'
        ),
        prompt: 'Which techniques help integrate rational functions?',
        type: 'multi',
      },
      {
        id: 'q29',
        items: wv(
          'Choose u and dv',
          'Differentiate u',
          'Integrate dv',
          'Apply the formula'
        ),
        level: 'analysis',
        prompt: 'Order the steps of integration by parts.',
        type: 'ordering',
      },
      {
        accepted: wv('constant of integration'),
        id: 'q30',
        level: 'recall',
        prompt: 'Name the constant added to every indefinite integral.',
        type: 'short',
      },
    ],
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
];

export const attempts: (Attempt & {
  answers?: Record<string, unknown>;
  questions?: Question[];
})[] = [
  {
    answers: {
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
        Mitochondria: 'Stores DNA',
        Nucleus: 'Makes ATP',
        Ribosome: 'Builds proteins',
      },
      q11: [1],
      q12: true, // Wrong: correct answer is false.
      q13: 'mitochondria',
      q14: 'cellular respiration',
    },
    chapters: ['Cell structure'],
    correct: 8,
    id: 'at_1',
    materialId: 'qz_1',
    pct: 80,
    questions: seedQuizzes[0].questions,
    quizName: 'Cell biology basics',
    takenAt: days(2),
    total: 10,
    workspaceName: 'Biology 101',
  },
  {
    answers: {
      q9: [1],
      q10: true,
      q23: [0],
      q24: true,
      q25: 'C',
      q26: [0],
      q27: false, // Wrong: correct answer is true.
      q28: [0], // Wrong: correct is [0, 1].
      q29: [
        'Apply the formula',
        'Choose u and dv',
        'Integrate dv',
        'Differentiate u',
      ], // Wrong order.
      q30: '', // Blank: unanswered.
    },
    chapters: ['Techniques of integration'],
    correct: 6,
    id: 'at_2',
    materialId: 'qz_3',
    pct: 60,
    questions: seedQuizzes[2].questions,
    quizName: 'Integration techniques',
    takenAt: days(3),
    total: 10,
    workspaceName: 'Calculus II',
  },
  {
    answers: {
      q7: [0],
      q8: '', // Blank: unanswered.
      q15: [0],
      q16: true, // Wrong: correct answer is false.
      q17: [0], // Wrong: correct is [0, 2].
      q18: 'Punnett',
      q19: true,
      q20: [1], // Wrong: correct is [0].
      q21: ['Telophase', 'Anaphase', 'Metaphase', 'Prophase'], // Wrong order.
      q22: '', // Blank: unanswered.
    },
    chapters: ['Genetics'],
    correct: 4,
    id: 'at_3',
    materialId: 'qz_2',
    pct: 40,
    questions: seedQuizzes[1].questions,
    quizName: 'Genetics check-in',
    takenAt: days(5),
    total: 10,
    workspaceName: 'Biology 101',
  },
];

const seedFlashcardSets: FlashcardSet[] = [
  {
    canEdit: true,
    cardCount: 32,
    color: 'green',
    dueCount: 0,
    id: 'dk_1',
    isOwner: true,
    knownPct: 80,
    name: 'Cell organelles',
    privacy: 'private',
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    canEdit: true,
    cardCount: 24,
    color: 'purple',
    dueCount: 0,
    id: 'dk_2',
    isOwner: true,
    knownPct: 55,
    name: 'Integration rules',
    privacy: 'private',
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
  {
    canEdit: true,
    cardCount: 40,
    color: 'amber',
    dueCount: 0,
    id: 'dk_3',
    isOwner: true,
    knownPct: 30,
    name: 'History dates',
    privacy: 'private',
    workspaceId: 'ws_hist',
    workspaceName: 'World History',
  },
];

const seedCards: Flashcard[] = [
  seedCard(
    'c_1',
    'dk_1',
    'Mitochondria',
    'Powerhouse of the cell — produces ATP.',
    true
  ),
  seedCard(
    'c_2',
    'dk_1',
    'Nucleus',
    'Stores DNA and controls cell activity.',
    true
  ),
  seedCard('c_3', 'dk_1', 'Ribosome', 'Site of protein synthesis.', false),
  seedCard(
    'c_4',
    'dk_1',
    'Golgi apparatus',
    'Packages and ships proteins.',
    false
  ),
  seedCard(
    'c_7',
    'dk_1',
    'Lysosome',
    'Digests waste with hydrolytic enzymes.',
    false
  ),
  seedCard(
    'c_8',
    'dk_1',
    'Endoplasmic reticulum',
    'Rough ER makes proteins; smooth ER makes lipids.',
    false
  ),
  seedCard('c_5', 'dk_2', '∫ eˣ dx', 'eˣ + C', true),
  seedCard('c_6', 'dk_2', '∫ 1/x dx', 'ln|x| + C', false),
  seedCard('c_9', 'dk_2', '∫ cos x dx', 'sin x + C', false),
  seedCard('c_10', 'dk_3', 'Fall of the Berlin Wall', '1989', false),
  seedCard('c_11', 'dk_3', 'End of WWII', '1945', false),
];

/**
 * Pool of questions the user has recently missed (across quizzes). Feeds the
 * "Review mistakes" quiz. Deduped by question id.
 */
const mistakeIds = new Set([
  'q6',
  'q8',
  'q12',
  'q16',
  'q17',
  'q20',
  'q21',
  'q22',
  'q27',
  'q28',
  'q29',
  'q30',
]);
export const mistakes: Question[] = seedQuizzes
  .flatMap((quiz) => quiz.questions)
  .filter((question) => mistakeIds.has(question.id));

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
    data: {
      code: 'event_starting',
      eventName: 'Calculus tutorial',
      location: 'Room 124',
      time: '11:00',
    },
    id: 'nt_1',
    kind: 'event',
  },
  {
    at: hours(5),
    data: {
      code: 'quiz_attempt_graded',
      quizName: 'Cell biology basics',
      score: '8/10',
    },
    id: 'nt_2',
    kind: 'quiz',
  },
  {
    at: hours(1),
    data: {
      code: 'event_starting',
      eventName: 'Calculus tutorial',
      location: 'Room 124',
      time: '11:00',
    },
    id: 'nt_1',
    kind: 'event',
  },
  {
    at: hours(5),
    data: {
      code: 'quiz_attempt_graded',
      quizName: 'Cell biology basics',
      score: '8/10',
    },
    id: 'nt_2',
    kind: 'quiz',
  },
];

export const notificationPrefs: NotificationPrefs = {
  emailBilling: true,
  emailMembership: true,
  emailWorkspaceInvite: true,
};

export const accountStatus: AccountStatus = {
  planTier: 'pro',
  state: 'active',
  storageLimitBytes: PLAN_LIMITS.pro.storageLimitBytes,
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
    curate: false,
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
    curate: false,
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
  },
  // A public viewer share role: readable, not clonable, no membership role.
  {
    ...workspaces[2],
    author: 'historyhub',
    canClone: false,
    capabilities: { canEdit: false, canManageMembers: false, canView: true },
    clones: 860,
    id: 'pub_ws_2',
    isOwner: false,
    name: 'Modern World History',
    privacy: 'public',
    role: undefined,
  },
];
export const publicQuizzes: PublicQuiz[] = [
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
   content; per-card FSRS state lives in cardStats. The seed quizzes/flashcards/cards
   above are authored as typed data, then folded into markdown materials here so
   the mock mirrors the backend's single-table model. */

/** Per-card scheduling state, keyed by card id (the flashcards fence owns the
 * front/back; this owns FSRS + known). */
export const cardStats: Record<
  string,
  { materialId: string; srs: SrsState; known: boolean }
> = {};
for (const c of seedCards)
  cardStats[c.id] = { known: c.known, materialId: c.materialId, srs: c.srs };

seedQuizzes.forEach((q) => {
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument([
        quizNode(
          { questions: q.questions, timeLimitMin: q.timeLimitMin },
          q.id
        ),
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

/** Derive the typed Quiz view from a quiz material (questions from the fence). */
export function quizFromMaterial(mt: Material): Quiz {
  const { questions, timeLimitMin } =
    typeof mt.content === 'string'
      ? parseQuizBlock(mt.content)
      : quizElementToBlock(
          mt.content.value.find((node) => node.type === 'quiz') as QuizElement
        );
  return {
    canEdit: true,
    chapters: mt.scopeChapters,
    createdAt: mt.createdAt,
    id: mt.id,
    isOwner: true,
    name: mt.title,
    privacy: mt.privacy,
    questions,
    timeLimitMin,
    workspaceId: mt.workspaceId,
    workspaceName: mt.workspaceName,
  };
}

/** Derive the typed cards for a flashcards material (fence + cardStats join). */
export function cardsFromMaterial(mt: Material): Flashcard[] {
  const cards =
    typeof mt.content === 'string'
      ? parseFlashcardsBlock(mt.content).cards
      : flashcardsElementToCards(
          mt.content.value.find(
            (node) => node.type === 'flashcards'
          ) as FlashcardsElement
        );
  return cards.map((c) => {
    const st = cardStats[c.id];
    const srs = st?.srs ?? newSrsState();
    return {
      back: c.back,
      front: c.front,
      id: c.id,
      known: st?.known ?? false,
      materialId: mt.id,
      srs,
    };
  });
}

/** Derive the typed FlashcardSet view (counts computed live from cardStats). */
export function flashcardSetFromMaterial(mt: Material): FlashcardSet {
  const cs = cardsFromMaterial(mt);
  const known = cs.filter((c) => c.known).length;
  return {
    canEdit: true,
    cardCount: cs.length,
    color: mt.color ?? 'green',
    dueCount: cs.filter((c) => isDue(c.srs)).length,
    id: mt.id,
    isOwner: true,
    knownPct: cs.length ? Math.round((100 * known) / cs.length) : 0,
    name: mt.title,
    privacy: mt.privacy,
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
    sizeBytes: mt.contentBytes,
    title: mt.title,
    updatedAt: mt.updatedAt,
    workspaceId: mt.workspaceId,
    workspaceName: mt.workspaceName,
    ...(quiz
      ? {
          questionCount: quiz.questions.length,
          timeLimitMin: quiz.timeLimitMin,
        }
      : {}),
    ...(set
      ? {
          cardCount: set.cardCount,
          dueCount: set.dueCount,
          knownPct: set.knownPct,
        }
      : {}),
  };
}

/** Convenience accessors for the two derived material kinds. */
export const quizMaterials = () => materials.filter((m) => m.kind === 'quiz');
export const flashcardSetMaterials = () =>
  materials.filter((m) => m.kind === 'flashcards');
