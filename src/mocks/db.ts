/* ============================================================
   In-memory mock database. Seeded with dummy data; MSW handlers
   read/mutate these arrays so the UI behaves like a real backend
   for the session. Swap for the real API later — no UI changes.
   ============================================================ */
import type {
  AccountStatus,
  ActivityBlock,
  AppNotification,
  Attempt,
  AttemptCard,
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
  MaterialPreview,
  NotificationPrefs,
  PublicFlashcardSet,
  PublicQuiz,
  PublicWorkspace,
  Question,
  RecentOpen,
  RecentPage,
  ReportEditIncidentReq,
  SourceFile,
  Task,
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
  htmlEmbedNode,
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
  type ChatFixture,
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
import { markdownSamples } from './markdownSamples';
import {
  nearLimitCards,
  nearLimitFlowchart,
  nearLimitMindmap,
  nearLimitQuestions,
} from './nearLimits';
import { seedNotes } from './noteContent';
import { bioNearLimitNotes } from './noteContent/bio';
import { embeddedSeeds, equation } from './noteContent/helpers';
import { buildBiologyLoadTestValue } from './noteContent/loadTest';
import {
  biologyOfficeFixtures,
  standaloneOfficeFixtures,
} from './officeFixtures';
import {
  buildSmallPerfDocument,
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from './perfSeed';
import {
  FILE_TEXT,
  FILE_THUMBNAILS,
  flashcardsPreview,
  GALLERY,
  mermaidPreview,
  notePreview,
  quizPreview,
} from './thumbnails';

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
  chatSendKey: 'enter',
  chatSteps: 'normal',
  classLabel: 'Grade 11 · Science',
  email: 'kate@capynotebook.app',
  id: 'u_1',
  locale: 'en',
  name: 'Kate Malone',
  noteAiEnabled: false,
  planTier: 'pro',
  streak: 0,
  studyPreferences: {},
  subscriptionStatus: 'active',
};

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
    cover: { color: '#1b9e6f', kind: 'math', style: 'doodles' },
    createdAt: days(40),
    description:
      'Explore how cells work, how substances move across membranes, and how traits pass from one generation to the next. Lecture readings, revision notes and practice materials for our introductory biology course.',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-01',
    id: 'ws_bio',
    isOwner: true,
    name: 'Biology 101',
    privacy: 'link',
    role: 'owner',
    sharePath: '/w/ws_bio.WsDtCIGPdoZOSZL0',
    shareRole: 'viewer',
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
    cover: { color: '#2a78d6', kind: 'math', style: 'symbols' },
    createdAt: days(30),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-02',
    id: 'ws_calc',
    isOwner: true,
    name: 'Calculus II',
    privacy: 'private',
    role: 'owner',
    sharePath: '/w/ws_calc.UZ6Qw4jRVADIzzI1',
    shareRole: 'viewer',
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
    name: 'World History',
    privacy: 'link',
    role: 'owner',
    sharePath: '/w/ws_hist.bVGQ2CHqnMetPMgB',
    shareRole: 'viewer',
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
    cover: { color: '#eb6834', pattern: 'hexagons', style: 'geo' },
    createdAt: days(12),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-04',
    id: 'ws_chem',
    isOwner: true,
    name: 'Organic Chemistry',
    privacy: 'private',
    role: 'owner',
    sharePath: '/w/ws_chem.c5KOZGPxH2RwP08Z',
    shareRole: 'viewer',
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
    cover: { color: '#f8efc9', kind: 'latin', style: 'paper' },
    createdAt: days(8),
    description: '',
    fileCount: 0,
    filesLimit: PLAN_LIMITS.pro.filesPerWorkspace,
    iconId: 'waves-05',
    id: 'ws_eng',
    isOwner: true,
    name: 'English Literature',
    privacy: 'public',
    role: 'owner',
    sharePath: '/w/ws_eng.-sR-YQ2vLCQXEe2Q',
    shareRole: 'viewer',
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

/** Wide and long delimited files for the CSV/TSV preview: many columns,
 * CJK text, a body past the 500-row preview cap and quoting edge cases. */
const gradebookCsv = (() => {
  const students = [
    'Aiko Tan',
    'Ben Okafor',
    'Chloe Martin',
    'Dev Patel',
    'Elena Rossi',
    'Farah Haddad',
    'Gus Lindqvist',
    'Hana Kim',
    'Isaac Mensah',
    'Jia Wen Lim',
    'Kofi Asante',
    'Lucia Fernández',
  ];
  const comments = [
    'Steady improvement since the midterm',
    '',
    'Missed two labs, caught up in May',
    'Strong project on enzyme kinetics',
    '',
    'Needs to show working in calculations',
  ];
  const homework = Array.from({ length: 10 }, (_, i) => `hw${i + 1}`);
  const header = [
    'student',
    'class',
    ...homework,
    'quiz1',
    'quiz2',
    'quiz3',
    'midterm',
    'lab_report',
    'project',
    'participation',
    'attendance_pct',
    'final_exam',
    'total',
    'grade',
    'teacher_comment',
  ];
  const rows = students.map((name, s) => {
    const scores = homework.map((_, h) =>
      (s + h) % 7 === 0 ? '' : 5 + ((s * 3 + h * 7) % 6)
    );
    const total = 52 + ((s * 17) % 45) + 0.5 * (s % 2);
    const grade =
      total >= 85 ? 'A' : total >= 72 ? 'B' : total >= 60 ? 'C' : 'D';
    return [
      name,
      s % 2 ? '10B' : '10A',
      ...scores,
      10 + ((s * 5) % 11),
      12 + ((s * 7) % 9),
      9 + ((s * 3) % 12),
      48 + ((s * 13) % 50),
      12 + ((s * 4) % 14),
      20 + ((s * 9) % 21),
      3 + (s % 3),
      (78 + ((s * 23) % 22) + 0.4).toFixed(1),
      40 + ((s * 31) % 59),
      total,
      grade,
      comments[s % comments.length],
    ].join(',');
  });
  return `${[header.join(','), ...rows].join('\n')}\n`;
})();

const greenhouseTsv = (() => {
  const sides = ['n', 'e', 's', 'w'];
  const header = [
    'timestamp',
    'station_id',
    ...sides.flatMap((side) => [
      `temp_c_${side}`,
      `rh_pct_${side}`,
      `lux_${side}`,
    ]),
    'co2_ppm',
    'pm2_5',
    'pm10',
    'voc_index',
    'pressure_hpa',
    'wind_ms',
    'wind_dir',
    'rain_mm',
    'uv_index',
    'soil_moist_pct',
    'soil_temp_c',
    'battery_v',
    'rssi_dbm',
    'firmware',
    'status',
    'operator_note',
  ];
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const rows = Array.from({ length: 24 }, (_, i) => {
    const hour = String(8 + Math.floor(i / 4)).padStart(2, '0');
    const minute = String((i % 4) * 15).padStart(2, '0');
    return [
      `2026-05-14T${hour}:${minute}:00Z`,
      i % 3 ? 'GH-01' : 'GH-02',
      ...sides.flatMap((_, k) => [
        (17 + ((i * 7 + k * 3) % 90) / 10).toFixed(1),
        40 + ((i * 11 + k * 5) % 45),
        800 + ((i * 1733 + k * 977) % 41_000),
      ]),
      410 + ((i * 37) % 400),
      (2 + ((i * 13) % 280) / 10).toFixed(1),
      (5 + ((i * 17) % 400) / 10).toFixed(1),
      20 + ((i * 29) % 280),
      (1003 + ((i * 7) % 180) / 10).toFixed(1),
      (((i * 9) % 60) / 10).toFixed(1),
      directions[i % directions.length],
      i % 5 === 3 ? 1.4 : 0,
      i % 8,
      18 + ((i * 3) % 28),
      (12 + ((i * 5) % 70) / 10).toFixed(1),
      (4.1 - i * 0.025).toFixed(2),
      -61 - ((i * 7) % 31),
      '2.4.1',
      i % 7 === 5 ? 'degraded' : 'ok',
      i === 6
        ? 'Door left open during reading'
        : i === 15
          ? 'Sensor N recalibrated'
          : '',
    ].join('\t');
  });
  return `${[header.join('\t'), ...rows].join('\n')}\n`;
})();

const enzymeAssayCsv = (() => {
  const enzymes = ['catalase', 'amylase', 'pepsin', 'lipase', 'trypsin'];
  const rows = Array.from({ length: 600 }, (_, i) => {
    const temp = 10 + (i % 9) * 5;
    const ph = (4 + (i % 7) * 0.5).toFixed(1);
    return [
      i + 1,
      enzymes[i % enzymes.length],
      temp,
      ph,
      (0.2 + ((i * 37) % 180) / 100).toFixed(2),
      i % 11 === 0 ? '' : ((i * 53) % 900) / 10,
    ].join(',');
  });
  return `trial,enzyme,temperature_c,ph,substrate_mm,rate_umol_min\n${rows.join('\n')}\n`;
})();

/** Biology 101 text sources, one per text format the source editor opens
 * collaboratively (Office formats come from `biologyOfficeFixtures`). */
const biologyTextSources = [
  {
    body: `species,habitat,count
frog,pond,12
newt,pond,4
heron,shore,2
`,
    id: 'bio-text-csv',
    kind: 'sheet',
    name: 'Pond survey.csv',
  },
  {
    body: `organelle\tfunction
nucleus\tstores DNA
mitochondria\tmakes ATP
ribosome\tbuilds proteins
`,
    id: 'bio-text-tsv',
    kind: 'sheet',
    name: 'Organelle functions.tsv',
  },
  {
    body: gradebookCsv,
    id: 'bio-text-csv-gradebook',
    kind: 'sheet',
    name: 'Class gradebook.csv',
  },
  {
    body: greenhouseTsv,
    id: 'bio-text-tsv-greenhouse',
    kind: 'sheet',
    name: 'Greenhouse sensors.tsv',
  },
  {
    body: `物種,學名,棲息地,數量,備註
青蛙,Rana catesbeiana,池塘東岸,12,蘆葦附近有卵塊
蠑螈,Cynops orientalis,池塘,4,
蒼鷺,Ardea cinerea,岸邊,2,清晨觀察到兩隻在覓食
蜻蜓幼蟲,Anisoptera,水草區,41,網撈十次
田螺,Cipangopaludina chinensis,淺水區,9,學生在平台上計數
`,
    id: 'bio-text-csv-zh',
    kind: 'sheet',
    name: '池塘調查.csv',
  },
  {
    body: enzymeAssayCsv,
    id: 'bio-text-csv-enzyme',
    kind: 'sheet',
    name: 'Enzyme assay (600 rows).csv',
  },
  {
    body: `sample,label,value,change_pct,passed,collected,comment
1,"Leaf, upper",0.42,-3.5,TRUE,2026-04-02,"Quoted ""fresh"" sample"
2,Leaf lower,1.07,12,FALSE,2026-04-02,
3,,0.9,0,TRUE,,Missing label and date
4,Root tip,-0.15,-100,TRUE,2026-04-03,"Line one
line two"
5,Stem,1200,250.25,FALSE,2026-04-04,A very long comment that runs well past the widest column the preview allows so it has to truncate with the full text on hover
10,Stem,7,8,TRUE,2026-04-05,Sorts after 5 numerically
`,
    id: 'bio-text-csv-edge',
    kind: 'sheet',
    name: 'Edge cases.csv',
  },
  {
    body: `{
  "cross": "Aa x Aa",
  "genotypes": { "AA": 0.25, "Aa": 0.5, "aa": 0.25 },
  "phenotypeRatio": "3:1"
}
`,
    id: 'bio-text-json',
    kind: 'json',
    name: 'Monohybrid cross.json',
  },
  {
    body: `topic: Cell respiration
stages:
  - glycolysis
  - krebs cycle
  - electron transport chain
atp_per_glucose: 30
`,
    id: 'bio-text-yaml',
    kind: 'txt',
    name: 'Respiration outline.yaml',
  },
  {
    body: `def punnett(a: str, b: str) -> list[str]:
    """Every offspring genotype of two parent genotypes."""
    return ["".join(sorted(x + y)) for x in a for y in b]


print(punnett("Aa", "Aa"))
`,
    id: 'bio-text-py',
    kind: 'txt',
    name: 'punnett.py',
  },
  {
    body: String.raw`\section{Photosynthesis}

\[ 6\,CO_2 + 6\,H_2O \rightarrow C_6H_{12}O_6 + 6\,O_2 \]
`,
    id: 'bio-text-tex',
    kind: 'txt',
    name: 'Photosynthesis.tex',
  },
  ...markdownSamples,
] as const;

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
  // A ready file over an ingest limit: it opens, only search skips it.
  'bio-state-too-large': { url: textUrl('species,count\nfrog,12\nnewt,4\n') },
  ...Object.fromEntries(
    biologyTextSources.map((file) => [file.id, { url: textUrl(file.body) }])
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
      isPayer: true,
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
      isPayer: true,
      kind: 'md',
      name: `Biology notes - ${status === 'ready' ? 'stored without indexing' : status}.md`,
      position: position + dialogFiles.length,
      revision: 1,
      sizeBytes: 2048,
      status,
      workspaceId: 'ws_bio',
      ...(status === 'processing' ? { ingestPct: 45 } : {}),
      ...(status === 'failed'
        ? { errorId: 'a3ce929d0e0e47364bf92f3577b34da6' }
        : {}),
    })
  ),
  {
    addedAt: hours(1),
    chapterId: null,
    hasBytes: true,
    id: 'bio-state-too-large',
    indexed: false,
    indexLimit: 'tabular_column_limit',
    isPayer: true,
    kind: 'sheet',
    name: 'Field counts - too large to index.csv',
    position: dialogFiles.length + 4 + biologyOfficeFixtures.length,
    revision: 1,
    sizeBytes: 100_048,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(20),
    chapterId: 'ch_1',
    hasBytes: true,
    id: 'f_1',
    indexed: true,
    isPayer: true,
    kind: 'pdf',
    name: 'Cell structure.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 2480 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(19),
    chapterId: 'ch_1',
    hasBytes: true,
    id: 'f_2',
    indexed: true,
    isPayer: true,
    kind: 'md',
    name: 'Organelles cheatsheet.md',
    position: 1,
    revision: 1,
    sizeBytes: 14 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(18),
    chapterId: 'ch_2',
    hasBytes: true,
    id: 'f_3',
    indexed: true,
    isPayer: true,
    kind: 'txt',
    name: 'Osmosis notes.txt',
    position: 0,
    revision: 1,
    sizeBytes: 6 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(15),
    chapterId: 'ch_3',
    hasBytes: true,
    id: 'f_4',
    indexed: true,
    // A member uploaded it: as a non-owner editor (the workspace-owner-*
    // scenarios) the viewer gets only the chapter Move on it.
    isPayer: false,
    kind: 'pdf',
    name: 'Mendelian genetics.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 1890 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(14),
    chapterId: null,
    hasBytes: true,
    id: 'f_5',
    indexed: true,
    isPayer: true,
    kind: 'image',
    name: 'Punnett squares.png',
    position: 0,
    revision: 1,
    sizeBytes: 420 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  {
    addedAt: days(10),
    chapterId: 'ch_c1',
    hasBytes: true,
    id: 'f_6',
    indexed: true,
    isPayer: true,
    kind: 'pdf',
    name: 'Integration by parts.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 980 * 1024,
    status: 'ready',
    workspaceId: 'ws_calc',
  },
  {
    addedAt: days(9),
    chapterId: 'ch_c2',
    hasBytes: true,
    id: 'f_7',
    indexed: true,
    isPayer: true,
    kind: 'md',
    name: 'Taylor series.md',
    position: 0,
    revision: 1,
    sizeBytes: 11 * 1024,
    status: 'ready',
    workspaceId: 'ws_calc',
  },
  {
    addedAt: days(14),
    chapterId: null,
    hasBytes: true,
    id: 'f_8',
    indexed: false,
    isPayer: true,
    kind: 'audio',
    name: 'dummy_audio.wav',
    position: 1,
    revision: 1,
    sizeBytes: 10_000 * 1024,
    status: 'ready',
    workspaceId: 'ws_bio',
  },
  // After the chat fixtures' cited files, which take the first indexed rows.
  ...biologyTextSources.map(
    (file, position): SourceFile => ({
      addedAt: hours(2),
      chapterId: null,
      hasBytes: true,
      id: file.id,
      indexed: true,
      isPayer: true,
      kind: file.kind,
      name: file.name,
      position:
        position + dialogFiles.length + 5 + biologyOfficeFixtures.length,
      preview: { text: file.body.slice(0, 600) },
      revision: 1,
      sizeBytes: new TextEncoder().encode(file.body).byteLength,
      status: 'ready',
      workspaceId: 'ws_bio',
    })
  ),
  // Standalone files (no workspace): the Files tab's No workspace rows.
  ...(['ready', 'failed'] as const).map(
    (status, position): SourceFile => ({
      addedAt: hours(3 + position),
      chapterId: null,
      hasBytes: true,
      id: `f_standalone_${status}`,
      indexed: status === 'ready',
      isPayer: true,
      kind: 'pdf',
      name: status === 'ready' ? 'Past paper 2025.pdf' : 'Scanned handout.pdf',
      position,
      revision: 1,
      sizeBytes: 1830 * 1024,
      status,
      workspaceId: '',
      ...(status === 'failed'
        ? { errorId: 'b5c7d1e3f9a24b6c8d0e2f4a6b8c0d1e' }
        : {}),
    })
  ),
];
// A file the user still pays for in a workspace it left: the Files tab shows
// it as lost access, delete only.
files.push({
  addedAt: hours(30),
  chapterId: null,
  hasBytes: true,
  id: 'f_lost_access',
  indexed: true,
  isPayer: true,
  kind: 'pdf',
  lostAccess: true,
  name: 'Group project brief.pdf',
  position: 0,
  revision: 1,
  sizeBytes: 920 * 1024,
  status: 'ready',
  workspaceId: 'ws_left_group',
  workspaceName: 'Study group',
});
for (const status of ['ready', 'failed'])
  fileLinks[`f_standalone_${status}`] = { ...fileLinks.f_6 };

// More standalone files, one of each kind that opens outside a workspace:
// the Office one read-only (its edit session waits for the sources work).
const standaloneSeeds: {
  body?: string;
  hoursAgo: number;
  id: string;
  kind: SourceFile['kind'];
  name: string;
  url?: string;
}[] = [
  {
    body: '# Reading list\n\n- *The Selfish Gene*, Richard Dawkins\n- *Sapiens*, Yuval Noah Harari\n- *Thinking, Fast and Slow*, Daniel Kahneman\n\nFinish one a month; notes go in the study group folder.',
    hoursAgo: 5,
    id: 'f_standalone_md',
    kind: 'md',
    name: 'Reading list.md',
  },
  {
    body: 'week,topic,hours\n1,Cell structure,4\n2,Genetics,5\n3,Calculus limits,6\n4,Revision,3\n',
    hoursAgo: 8,
    id: 'f_standalone_csv',
    kind: 'sheet',
    name: 'Study hours.csv',
  },
  {
    hoursAgo: 26,
    id: 'f_standalone_image',
    kind: 'image',
    name: 'Whiteboard photo.jpg',
    url: 'https://picsum.photos/1600/1200',
  },
  {
    hoursAgo: 50,
    id: 'f_standalone_audio',
    kind: 'audio',
    name: 'Lecture recording.wav',
    url: fileLinks.f_8.url,
  },
];
standaloneSeeds.forEach((seed, index) => {
  fileLinks[seed.id] = { url: seed.url ?? textUrl(seed.body ?? '') };
  files.push({
    addedAt: hours(seed.hoursAgo),
    chapterId: null,
    hasBytes: true,
    id: seed.id,
    indexed: seed.kind !== 'audio',
    isPayer: true,
    kind: seed.kind,
    name: seed.name,
    position: 2 + index,
    ...(seed.body ? { preview: { text: seed.body.slice(0, 600) } } : {}),
    revision: 1,
    sizeBytes: seed.body
      ? new TextEncoder().encode(seed.body).byteLength
      : 640 * 1024,
    status: 'ready',
    workspaceId: '',
  });
});
for (const fixture of standaloneOfficeFixtures) {
  fileLinks[fixture.id] = { url: fixture.sourceURL };
  files.push({
    addedAt: hours(2),
    chapterId: null,
    hasBytes: true,
    id: fixture.id,
    indexed: false,
    isPayer: true,
    kind: fixture.kind,
    name: fixture.name,
    position: 2 + standaloneSeeds.length,
    revision: 1,
    sizeBytes: fixture.sizeBytes,
    status: 'ready',
    workspaceId: '',
  });
}

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
      // The study group's readings, uploaded by another member.
      isPayer: false,
      kind: 'md',
      name: `${title}.md`,
      position,
      preview: { text: body },
      revision: 1,
      sizeBytes: new TextEncoder().encode(body).byteLength,
      status: 'ready',
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

for (const file of files) {
  if (FILE_THUMBNAILS[file.id]) file.thumbnailUrl = FILE_THUMBNAILS[file.id];
  if (FILE_TEXT[file.id]) file.preview = { text: FILE_TEXT[file.id] };
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
              type: 'mcq',
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
              type: 'mcq',
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

export type SeedAttempt = Attempt & {
  answers?: Answers;
  cards?: AttemptCard[];
  questions?: Question[];
};

/** A seeded attempt graded the way the server stores one. */
function seedAttempt(
  quiz: EditableQuiz,
  answers: Answers,
  fields: Omit<
    SeedAttempt,
    | 'answers'
    | 'correct'
    | 'kind'
    | 'materialId'
    | 'pct'
    | 'questions'
    | 'startedAt'
    | 'total'
    | 'workspaceId'
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
    kind: 'quiz',
    materialId: quiz.id,
    pct: Math.round((correct / graded.max) * 100),
    questions,
    // Twelve minutes or so before submitting.
    startedAt: new Date(Date.parse(fields.takenAt) - 12 * 60_000).toISOString(),
    total: graded.max,
    workspaceId: quiz.workspaceId,
  };
}

/** An attempt as lists carry it: the score, without answers or graded questions. */
export const attemptSummary = ({
  answers: _,
  cards: ___,
  questions: __,
  ...attempt
}: SeedAttempt): Attempt => ({
  ...attempt,
  iconId: workspaces.find((ws) => ws.id === attempt.workspaceId)?.iconId,
});

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
  {
    ...seedCard(
      'c_2',
      'dk_1',
      'Nucleus',
      'Stores DNA and controls cell activity.'
    ),
    image: { assetId: 'asset_mock_cell_diagram' },
  },
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
    at: hours(0.2),
    data: { code: 'source_batch', done: 3, failed: 1, source: 'upload' },
    href: '/workspaces/ws_bio',
    id: 'nt_1',
    kind: 'system',
    workspaceIconId: 'waves-01',
    workspaceName: 'Biology 101',
  },
  {
    at: hours(1),
    data: {
      code: 'workspace_invite_accepted',
      memberId: 'u_mina',
      memberName: 'Mina Okafor',
      workspaceName: 'Biology 101',
    },
    href: '/workspaces/ws_bio',
    id: 'nt_2',
    kind: 'system',
    memberAvatarUrl: '/icons/avataaars-02.svg',
    workspaceIconId: 'waves-01',
    workspaceName: 'Biology 101',
  },
  {
    at: hours(5),
    data: {
      code: 'model_deprecated',
      fromName: 'Previous model',
      toName: 'GLM-5.3 Flash',
    },
    href: '/settings?tab=llm',
    id: 'nt_3',
    kind: 'system',
  },
  {
    at: hours(26),
    data: {
      code: 'pending_edits_too_large',
      fileId: 'f_1',
      fileName: 'lecture-notes.docx',
    },
    href: '/workspaces/ws_bio?file=f_1',
    id: 'nt_4',
    kind: 'system',
    readAt: hours(20),
    workspaceIconId: 'waves-01',
    workspaceName: 'Biology 101',
  },
  {
    at: hours(30),
    data: { role: 'editor', workspaceName: 'World History' },
    href: '/workspaces/ws_hist',
    id: 'nt_5',
    kind: 'workspace_role_changed',
    readAt: hours(28),
    workspaceIconId: 'waves-03',
    workspaceName: 'World History',
  },
  {
    at: hours(80),
    data: {
      code: 'office_maintenance',
      hours: 2,
      reminder: false,
      startsAt: hours(-72),
    },
    id: 'nt_6',
    kind: 'system',
    readAt: hours(78),
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
type MaterialDefaults =
  | 'audioMaxBytes'
  | 'imageMaxBytes'
  | 'isOwner'
  | 'position'
  | 'revision'
  | 'updatedAt';

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
    audioMaxBytes: PLAN_LIMITS.free.sourceFileMaxBytes,
    imageMaxBytes: PLAN_LIMITS.free.imageMaxBytes,
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

/** The note's own copy of another note's quiz or flashcard set, as the
 * collaboration service's children pass makes it (fresh card ids, numbered
 * title); "" when the source is not an embedded quiz or set. */
export function copyEmbeddedInto(note: Material, sourceId: string): string {
  const source = materials.find((x) => x.id === sourceId);
  if (
    !source?.parentMaterialId ||
    (source.kind !== 'quiz' && source.kind !== 'flashcards')
  )
    return '';
  const rekey = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rekey);
    if (!node || typeof node !== 'object') return node;
    const copy = Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, rekey(value)])
    );
    return copy.type === 'flashcard' ? { ...copy, id: uid('card') } : copy;
  };
  const mt = makeMaterial({
    ...source,
    content: rekey(source.content) as typeof source.content,
    createdAt: new Date().toISOString(),
    id: uid('mat'),
    parentMaterialId: note.id,
    // Embedded items carry a random, never displayed name.
    title: crypto.randomUUID(),
    workspaceId: note.workspaceId,
    workspaceName: note.workspaceName,
  });
  materials.unshift(mt);
  return mt.id;
}

/** An unprocessed change in the Indexing tab. `ticks` counts the stats reads
 * since the state was entered, so the handler advances queued work as the tab
 * polls. */
export type MockChange = {
  /** A failed row's trace id, which the stats read sends while it is failed. */
  errorId?: string;
  lastEditedAt: string;
  ticks: number;
  state: FileChange['state'];
};

/** Unprocessed source edits by file. */
export const fileChanges = new Map<string, MockChange>([
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
      errorId: '4bf92f3577b34da6a3ce929d0e0e4736',
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

/** Workspace notes whose index is behind their content, by material id. */
export const noteChanges = new Map<string, MockChange>([
  [
    'mat_note_1',
    {
      lastEditedAt: '2026-01-12T11:30:00Z',
      state: 'waiting',
      ticks: 0,
    },
  ],
  [
    'mat_note_bio_transport',
    {
      errorId: '0af7651916cd43dd8448eb211c80319c',
      lastEditedAt: '2026-01-12T08:15:00Z',
      state: 'failed',
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

/* Card preview gallery: standalone, older than the seeds above so it never
 * displaces them from the first page or the dashboard's recents. */
const galleryMaterials = GALLERY.map((item, index) => ({
  material: makeMaterial({
    capabilities: ownerCapabilities,
    chapterId: null,
    content: createMaterialDocument(item.value),
    createdAt: days(2 + index / 4),
    id: item.id,
    kind: item.kind,
    privacy: 'private',
    role: 'owner',
    scopeChapters: [],
    scopeFileNames: [],
    title: item.title,
    workspaceId: '',
    workspaceName: '',
  }),
  trashed: item.trashed,
}));
for (const { material, trashed } of galleryMaterials)
  if (!trashed) materials.push(material);

/* ---------------- chat: conversations + messages ---------------- */
export const conversations: Conversation[] = [
  {
    createdAt: days(1),
    id: 'conv_seed1',
    title: 'What is a cell?',
    updatedAt: hours(3),
    workspaceId: workspaces[0].id,
  },
  {
    createdAt: days(3),
    id: 'conv_seed_pinned',
    pinnedAt: hours(2),
    title: 'Exam plan for the cell unit',
    updatedAt: days(3),
    workspaceId: workspaces[0].id,
  },
  {
    archivedAt: days(2),
    createdAt: days(9),
    id: 'conv_seed_archived1',
    title: 'Lab report draft questions',
    updatedAt: days(8),
    workspaceId: workspaces[0].id,
  },
  {
    archivedAt: days(21),
    createdAt: days(40),
    id: 'conv_seed_archived2',
    title: 'Old exam tips',
    updatedAt: days(30),
    workspaceId: workspaces[0].id,
  },
  // Account chats (workspaceId ""): across all the user's files.
  {
    createdAt: days(2),
    id: 'conv_account_pinned',
    pinnedAt: hours(1),
    title: 'What should I read this month?',
    updatedAt: hours(4),
    workspaceId: '',
  },
  {
    createdAt: days(5),
    id: 'conv_account_older',
    title: 'Plan my week across all subjects',
    updatedAt: days(4),
    workspaceId: '',
  },
  {
    archivedAt: days(6),
    createdAt: days(12),
    id: 'conv_account_archived',
    title: 'Old revision timetable',
    updatedAt: days(11),
    workspaceId: '',
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
        canRestore: true,
        episodeId: `episode_${file.id}`,
        fileKind: file.kind,
        id: file.id,
        kind: 'source_file',
        preview: file.preview,
        purgeAfter: hours(index + 1 - 30 * 24),
        sizeBytes: file.sizeBytes,
        thumbnailUrl: file.thumbnailUrl,
        title: file.name,
        trashedAt: hours(index + 1),
        workspaceId: file.workspaceId,
        workspaceName: workspaces.find(
          (workspace) => workspace.id === file.workspaceId
        )?.name,
      },
    });
  });

// A trashed standalone file restores to No workspace.
{
  const file: SourceFile = {
    addedAt: days(4),
    chapterId: null,
    hasBytes: true,
    id: 'trash_standalone_notes',
    indexed: true,
    isPayer: true,
    kind: 'pdf',
    name: 'Old revision notes.pdf',
    position: 0,
    revision: 1,
    sizeBytes: 640 * 1024,
    status: 'ready',
    workspaceId: '',
  };
  fileLinks[file.id] = { ...fileLinks.f_6 };
  trash.push({
    file,
    item: {
      canRestore: true,
      episodeId: `episode_${file.id}`,
      fileKind: file.kind,
      id: file.id,
      kind: 'source_file',
      purgeAfter: days(-26),
      sizeBytes: file.sizeBytes,
      title: file.name,
      trashedAt: days(4),
    },
  });
}

// Trashed diagrams lead the bin, where their previews are on show.
trash.unshift(
  ...galleryMaterials
    .filter(({ trashed }) => trashed)
    .map(({ material }) => ({
      item: {
        canRestore: true,
        episodeId: `episode_${material.id}`,
        id: material.id,
        kind: 'material' as const,
        materialKind: material.kind,
        preview: materialPreview(material),
        purgeAfter: days(-29),
        sizeBytes: material.contentBytes,
        title: material.title,
        trashedAt: hours(0.5),
      },
      material,
    }))
);

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
  {
    citations: null,
    content: 'What should I read this month?',
    conversationId: 'conv_account_pinned',
    createdAt: hours(4),
    id: 'm_account1',
    role: 'user',
    status: 'complete',
  },
  {
    activity: accountSeedActivity(hours(4)),
    // Account citations name where each source lives ("" is No workspace).
    citations: [
      {
        fileId: 'f_2',
        fileName: 'Organelles cheatsheet.md',
        snippet: 'Mitochondria transfer energy from food into ATP.',
        workspaceId: 'ws_bio',
        workspaceName: 'Biology 101',
      },
      {
        fileId: 'f_standalone_md',
        fileName: 'Reading list.md',
        snippet: 'Finish one a month; notes go in the study group folder.',
        workspaceId: '',
        workspaceName: '',
      },
    ],
    content:
      'Start with *The Selfish Gene* from your reading list: it fits the genetics unit after the organelles in your Biology 101 cheatsheet.',
    conversationId: 'conv_account_pinned',
    createdAt: hours(4),
    id: 'm_account2',
    modelDisplayName: 'DeepSeek Flash',
    modelSlug: 'deepseek-flash',
    modelVersion: 1,
    providerSlug: 'deepseek',
    role: 'assistant',
    status: 'complete',
  },
];

function after(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** The seeded account turn's steps: one of each account tool kind, the list
 * calls twice so the trace groups them, a failed web search and a created
 * mindmap. */
function accountSeedActivity(createdAt: string): ActivityBlock[] {
  const steps: [string, string, ActivityBlock['outcome']?][] = [
    ['list_workspaces', ''],
    ['list_sources', ''],
    ['list_sources', 'Biology 101'],
    ['search_files_summary', 'reading list'],
    ['search_files_content', 'genetics unit'],
    ['read_document', 'Reading list.md'],
    ['search_knowledge', 'The Selfish Gene'],
    ['search_web', 'The Selfish Gene summary', 'failed'],
    ['read_skill', 'note_building'],
    ['create_material', 'Cell biology mindmap'],
  ];
  return steps.map(([name, detail, outcome = 'succeeded'], index) => {
    const callId = `m_account2_${index}`;
    return {
      callId,
      detail,
      ...(name === 'create_material' && {
        effects: [
          {
            operation: 'created' as const,
            operationId: callId,
            resource: {
              id: 'mat_1',
              kind: 'material' as const,
              title: 'Cell biology mindmap',
            },
          },
        ],
      }),
      endedAt: after(createdAt, 900 + index * 700),
      id: callId,
      kind: 'tool',
      name,
      outcome,
      startedAt: after(createdAt, 400 + index * 700),
    };
  });
}

/** A fixture's Office edits as history keeps them: a cut call the turn
 * followed with an edit of its file closed as done, one it never followed
 * keeps its counts (Epo 2026-10-23, Q171). */
function officeActivity(
  conversationId: string,
  createdAt: string,
  edits: ChatFixture['edits'] = []
): ActivityBlock[] {
  const office = edits.filter(({ tool }) => tool === 'edit_office_document');
  return office.flatMap(({ changes, cut }, index) => {
    const file = files.find(({ id }) => id === changes[0]?.id);
    if (!file) return [];
    const followed = office
      .slice(index + 1)
      .some((next) => next.changes[0]?.id === file.id);
    const callId = `${conversationId}_office_${index}`;
    return {
      ...(cut && !followed ? cut : {}),
      callId,
      detail: file.name,
      effects: [
        {
          operation: 'edited',
          operationId: callId,
          resource: { id: file.id, kind: 'source_file', title: file.name },
        },
      ],
      endedAt: after(createdAt, 4000 + index * 3000),
      id: callId,
      kind: 'tool',
      name: 'edit_office_document',
      outcome: 'succeeded',
      startedAt: after(createdAt, 3200 + index * 3000),
    };
  });
}

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
          detail: fixture.prompt.slice(0, 40),
          // Step times, so history shows "Thought for 2s" like a live turn.
          endedAt: after(createdAt, 2700),
          id: `${conversationId}_search`,
          kind: 'tool',
          name: 'search_workspace',
          outcome: 'succeeded',
          startedAt: after(createdAt, 1800),
        },
        ...officeActivity(
          conversationId,
          createdAt,
          (fixture as ChatFixture).edits
        ),
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
/** Explore's quizzes with their keys (clone sources); the route sends the
 * question count only. */
export const publicQuizzes: (PublicQuiz & { questions: Question[] })[] = [
  {
    author: 'mrslee',
    canClone: true,
    clones: 540,
    id: 'pub_qz_1',
    name: 'Cell biology — 50 questions',
    questions: seedQuizzes[0].questions,
    workspaceId: seedQuizzes[0].workspaceId,
  },
  {
    author: 'mathpro',
    canClone: true,
    clones: 410,
    id: 'pub_qz_2',
    name: 'Calculus II mega quiz',
    questions: seedQuizzes[2].questions,
    workspaceId: seedQuizzes[2].workspaceId,
  },
];
export const publicFlashcardSets: PublicFlashcardSet[] = [
  {
    ...seedFlashcardSets[0],
    author: 'mrslee',
    canClone: true,
    clones: 320,
    id: 'pub_dk_1',
    isOwner: false,
    name: 'Cell biology essentials',
    privacy: 'public',
  },
  {
    ...seedFlashcardSets[1],
    author: 'mathpro',
    canClone: true,
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

/** Editing incidents the browser reported (edit_incidents), for specs. */
export const editIncidents: ReportEditIncidentReq[] = [];

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
            ...(c.image ? { image: c.image } : {}),
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
  }),
  makeMaterial({
    capabilities: ownerCapabilities,
    chapterId: null,
    content: createMaterialDocument([
      ...structuredClone(
        seedNotes.find((note) => note.id === 'mat_note_1')?.value ?? []
      ),
      // A shared page's display equations: one wider than a phone, one short.
      equation(
        '\\mathrm{C_6H_{12}O_6} + 6\\,\\mathrm{O_2} \\rightarrow 6\\,\\mathrm{CO_2} + 6\\,\\mathrm{H_2O} + \\text{ATP}'
      ),
      equation('E = mc^2'),
      htmlEmbedNode(
        '<p id="snippet-ready">The interactive block runs.</p>',
        'An interactive block',
        'html_shared'
      ),
    ]),
    createdAt: days(3),
    id: 'nt_shared',
    kind: 'note',
    privacy: 'link',
    role: 'owner',
    scopeChapters: [],
    scopeFileNames: [],
    title: 'Lecture notes — the cell',
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

/* ---------------- near-limit fixtures ---------------- */
// Every embed at its limits (mocks/nearLimits.ts), seeded last so they sit at
// the bottom of Biology 101's tree and out of Recent Files, under the rows
// specs click. The diagrams take seconds to draw.
const nearLimitSet = nearLimitCards('fc_near');
for (const card of nearLimitSet)
  flashcardCards[card.id] = { materialId: 'dk_bio_near' };
for (const [id, kind, title, value] of [
  ...bioNearLimitNotes.map(
    (note) => [note.id, 'note', note.title, note.value] as const
  ),
  [
    'mat_bio_near_diagram',
    'diagram',
    'Near-limit diagram',
    [mermaidNode(nearLimitFlowchart())],
  ],
  [
    'mat_bio_near_mindmap',
    'mindmap',
    'Near-limit mindmap',
    [mermaidNode(nearLimitMindmap())],
  ],
  [
    'qz_bio_near',
    'quiz',
    'Near-limit quiz',
    [quizNode({ questions: nearLimitQuestions('qz_near') }, 'qz_bio_near')],
  ],
  [
    'dk_bio_near',
    'flashcards',
    'Near-limit flashcards',
    [flashcardsNode(nearLimitSet, 'dk_bio_near')],
  ],
] as const)
  materials.push(
    makeMaterial({
      capabilities: ownerCapabilities,
      chapterId: null,
      content: createMaterialDocument(value as MaterialValue),
      createdAt: days(30),
      id,
      kind,
      privacy: 'private',
      role: 'owner',
      scopeChapters: [],
      scopeFileNames: [],
      title,
      workspaceId: 'ws_bio',
      workspaceName: 'Biology 101',
    })
  );

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
      title: crypto.randomUUID(),
      workspaceId: note.workspaceId,
      workspaceName: note.workspaceName,
    })
  );
}

// The shared copy of the lecture note embeds copies of its own, as a clone does.
const sharedNote = materials.find((mt) => mt.id === 'nt_shared');
if (sharedNote)
  sharedNote.content = {
    ...sharedNote.content,
    value: sharedNote.content.value.map((node) =>
      node.type === 'material_ref' && typeof node.materialId === 'string'
        ? { ...node, materialId: copyEmbeddedInto(sharedNote, node.materialId) }
        : node
    ),
  };

/** Standalone quizzes, flashcard sets and notes share through a signed link.
 * Signing is async, so mocks write a placeholder that the dev server swaps for
 * a real signature on the first visit (src/summary/vite.ts). */
export function mockSharePath(mt: Material): string | undefined {
  if (mt.workspaceId || mt.parentMaterialId) return;
  if (mt.kind === 'quiz') return `/share/quizzes/${mt.id}.mswSignature0000`;
  if (mt.kind === 'flashcards')
    return `/share/flashcards/${mt.id}.mswSignature0000`;
  if (mt.kind === 'note') return `/share/notes/${mt.id}.mswSignature0000`;
}

/** Every mock material belongs to the mock user. */
export const mockAuthor = { avatarUrl: user.avatarUrl, name: user.name };

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
    ...(mt.parentMaterialId ? { parentMaterialId: mt.parentMaterialId } : {}),
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
    ...(c.image ? { image: c.image } : {}),
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
    ...(mt.parentMaterialId ? { parentMaterialId: mt.parentMaterialId } : {}),
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
  const quiz = mt.kind === 'quiz' ? quizFromMaterial(mt) : undefined;
  const set =
    mt.kind === 'flashcards' ? flashcardSetFromMaterial(mt) : undefined;
  return {
    chapterId: mt.chapterId,
    chapterName: chapters.find((c) => c.id === mt.chapterId)?.name ?? '',
    createdAt: mt.createdAt,
    id: mt.id,
    kind: mt.kind,
    preview: materialPreview(mt),
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

/** The card preview the server stores with each material write. */
export function materialPreview(mt: Material): MaterialPreview | undefined {
  if (typeof mt.content === 'string') return;
  switch (mt.kind) {
    case 'quiz':
      return quizPreview(quizFromMaterial(mt).questions);
    case 'flashcards':
      return flashcardsPreview(cardsFromMaterial(mt));
    case 'mindmap':
    case 'diagram':
      return mermaidPreview(mt.kind, mt.content.value);
    default:
      return notePreview(mt.content.value);
  }
}

/** Convenience accessors for the two derived material kinds. */
export const quizMaterials = () => materials.filter((m) => m.kind === 'quiz');
export const flashcardSetMaterials = () =>
  materials.filter((m) => m.kind === 'flashcards');

/** The signed-in user's last opens (workspace_visits): the recent order, and
 * which public workspaces they visited. */
export const visits = new Map<string, string>([
  ['ws_bio', hours(3)],
  ['ws_calc', days(1)],
  ['ws_hist', days(2)],
  ['ws_chem', days(5)],
  ['ws_eng', hours(20)],
]);

/** The user's file and material opens (item_opens), `file:<id>` or
 * `material:<id>`. An item never opened counts as opened when it was created,
 * as the server marks creations. */
export const itemOpens = new Map<string, string>();

const RECENT_KINDS = ['note', 'quiz', 'flashcards', 'mindmap', 'diagram'];

/** GET /api/recent: opens in the workspace list's set, newest first. */
export function listRecent(url: URL): RecentPage {
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const visible = new Set(
    listWorkspaces(new URL('http://mock/api/workspaces')).map((w) => w.id)
  );
  const rows: RecentOpen[] = [
    ...files
      .filter((f) => !f.workspaceId || visible.has(f.workspaceId))
      .map((f) => ({
        file: f,
        openedAt: itemOpens.get(`file:${f.id}`) ?? f.addedAt,
      })),
    ...materials
      .filter(
        (mt) =>
          !mt.parentMaterialId &&
          RECENT_KINDS.includes(mt.kind) &&
          (!mt.workspaceId || visible.has(mt.workspaceId))
      )
      .map((mt) => ({
        material: materialListItem(mt),
        openedAt: itemOpens.get(`material:${mt.id}`) ?? mt.createdAt,
      })),
  ];
  return {
    items: rows
      .sort((a, b) => +new Date(b.openedAt) - +new Date(a.openedAt))
      .slice(0, limit),
  };
}

/** GET /api/workspaces: search, tag filter and sort. Visited public
 * workspaces list with the user's own. */
export function listWorkspaces(url: URL): Workspace[] {
  const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  const tags = (url.searchParams.get('tag') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  let list: Workspace[] = [
    ...workspaces,
    ...publicWorkspaces.filter((w) => visits.has(w.id)),
  ];
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
    default: {
      // Never opened last, newest first, as the server.
      const opened = (w: Workspace) => +new Date(visits.get(w.id) ?? 0);
      return list.sort(
        (a, b) =>
          opened(b) - opened(a) ||
          +new Date(b.createdAt) - +new Date(a.createdAt)
      );
    }
  }
}
