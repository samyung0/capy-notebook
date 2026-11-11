import { HttpResponse, http } from 'msw';
import type {
  Assignment,
  AssignmentAnswerRow,
  AssignmentAttempt,
  AssignmentFormReq,
  AssignmentGradedQuestion,
  AssignmentList,
  AssignmentMark,
  AssignmentMemberRow,
  AssignmentPartReport,
  AssignmentQuestionReport,
  AssignmentReport,
  MarkedDrawing,
  MaterialRef,
  PaperFile,
  SharingNotice,
  SubmittedPaper,
  TodoDonePage,
  TodoList,
  TodoWorkspace,
  WorkspaceActivity,
} from '@/api/types';
import { fromBase64, toBase64 } from '@/features/blocksuite/base64';
import { SAVED, withElements } from '@/features/blocksuite/boardFixture';
import {
  modelMarked,
  type Question,
  type QuestionPart,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { scorePart } from '@/features/quizzes/grade';
import { learnerView } from './answerKeys';
import * as db from './db';
import { mockWorkspaceMembers } from './workspaceMembers';

/* Assignments on mocked data: the class on the boards (W1, W3, G3, G3m, A3),
   seeded on first use. Who is asking comes from the handler set: the default
   handlers answer as the workspace's owner, and the Member scenario as a viewer
   given every "All members" assignment. Open answers wait for the owner, as on
   the server: nothing here marks them. */

type Viewer = 'owner' | 'member';
type Row = {
  id: string;
  workspaceId: string;
  /** A task its maker set themself: nobody else's, staff included. */
  own?: boolean;
  kind: 'marked' | 'unmarked';
  title: string;
  quizId?: string;
  questions?: Question[];
  dueAt?: string;
  postedAt: string;
  closedAt?: string;
  releasedAt?: string;
  /** When staff turned its quiz to practice (Do not show). */
  practiceAt?: string;
  timeLimitMin?: number;
  attempts: number;
  noLate: boolean;
  latePenaltyPct: number;
  assignAll: boolean;
  assignees: string[];
  draft: boolean;
  marking: AssignmentFormReq['marking'];
  showAnswers: AssignmentFormReq['showAnswers'];
  showGrades: AssignmentFormReq['showGrades'];
  gradesReleasedAt?: string;
  shuffle: boolean;
  allowUploads: boolean;
  files: { fileId?: string; materialId?: string }[];
};
type Attempt = {
  id: string;
  assignmentId: string;
  userId: string;
  startedAt: string;
  deadlineAt?: string;
  submittedAt?: string;
  autoSubmitted: boolean;
  answers: Answers;
  graded: AssignmentGradedQuestion[];
  /** Answered on paper (S5): its state and files. */
  paper?: 'upload' | 'reading' | 'read';
  paperFiles?: PaperFile[];
};

/** A paper file's bytes, as links read them. */
const paperUrls = new Map<string, string>();

/** A handwritten page, drawn: a seeded paper's one image. */
const SCAN = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="877"><rect width="620" height="877" fill="#f7f5ef"/>' +
    Array.from(
      { length: 24 },
      (_, i) =>
        `<line x1="30" x2="590" y1="${80 + i * 32}" y2="${80 + i * 32}" stroke="#c7d3e6"/>`
    ).join('') +
    '<g font-family="Bradley Hand, cursive" font-size="22" fill="#24306b"><text x="40" y="70">Name: Ben Lee</text><text x="40" y="134">1  B</text><text x="40" y="198">3  Water goes in by osmosis through the</text><text x="70" y="230">partially permeable membrane.</text></g></svg>'
)}`;

/** Upload file's files (the source upload with attemptId): a running paper's. */
export function addPaperFile(
  attemptId: string,
  name: string,
  kind: string,
  bytes: Blob
) {
  const attempt = attempts.get(attemptId);
  if (attempt?.paper !== 'upload' || attempt.submittedAt) return null;
  const file: PaperFile = {
    id: newId('f'),
    kind,
    name,
    sizeBytes: bytes.size,
    status: 'ready',
  };
  paperUrls.set(file.id, URL.createObjectURL(bytes));
  attempt.paperFiles = [...(attempt.paperFiles ?? []), file];
  return file;
}

/** Hand-ins (S3, T2): each member's files on an unmarked assignment that
 * takes them. */
const handIns = new Map<string, Map<string, PaperFile[]>>();

const handInOf = (assignmentId: string, userId: string) =>
  handIns.get(assignmentId)?.get(userId) ?? [];

const setHandIn = (
  assignmentId: string,
  userId: string,
  files: PaperFile[]
) => {
  const byUser = handIns.get(assignmentId) ?? new Map<string, PaperFile[]>();
  byUser.set(userId, files);
  handIns.set(assignmentId, byUser);
};

/** Takes the viewer's changes: taking files, not handed in, not closed. */
const handInOpen = (assignmentId: string) => {
  const row = rows.get(assignmentId);
  return (
    !!row?.allowUploads &&
    row.kind === 'unmarked' &&
    !isClosed(row) &&
    !done.get(assignmentId)?.has(db.user.id)
  );
};

/** Add files's files (the source upload with handInId). */
export function addHandInFile(
  assignmentId: string,
  name: string,
  kind: string,
  bytes: Blob
) {
  seed();
  if (!handInOpen(assignmentId)) return null;
  const file: PaperFile = {
    id: newId('f'),
    kind,
    name,
    sizeBytes: bytes.size,
    status: 'ready',
  };
  paperUrls.set(file.id, URL.createObjectURL(bytes));
  setHandIn(assignmentId, db.user.id, [
    ...handInOf(assignmentId, db.user.id),
    file,
  ]);
  return file;
}

/** Drawings an assignment's Done stored, by id: their boards. */
const mockDrawings = new Map<string, string>();
/** Each stored drawing's pictures, as Done sent them. */
const mockDrawingPictures = new Map<
  string,
  { data: string; sourceId: string }[]
>();
/** A picture's type from the start of its base64, as the bucket would serve it. */
const pictureType = (data: string) =>
  data.startsWith('iVBOR')
    ? 'image/png'
    : data.startsWith('/9j/')
      ? 'image/jpeg'
      : data.startsWith('R0lG')
        ? 'image/gif'
        : 'image/webp';

/** For a spec: hands the Member scenario's attempts at an assignment to one of
 * the class's members, so the owner's report shows them
 * (e2e/editor/drawing-answer.spec.ts). */
export function giveMockAttemptsTo(assignmentId: string, userId: string) {
  for (const attempt of attempts.values())
    if (attempt.assignmentId === assignmentId && attempt.userId === db.user.id)
      attempt.userId = userId;
}
const WS = 'ws_bio';
const ASSIGNMENT_GRACE_MS = 15_000;
const DAY = 86_400_000;

// Files › Canvas: marked drawings the viewer pays for, with seeded boards.
const wave = Array.from({ length: 60 }, (_, i) => [
  i * 8,
  120 + Math.sin(i / 5) * 60,
]);
mockDrawings.set('dr_marked_1', SAVED);
mockDrawings.set(
  'dr_marked_2',
  toBase64(
    withElements({
      color: '#1c7ed6',
      lineWidth: 4,
      points: wave,
      type: 'brush',
      xywh: '[900,0,480,240]',
    })
  )
);
const markedDrawings: MarkedDrawing[] = [
  {
    assignment: true,
    attemptId: 'at_1',
    bytes: 86 * 1024,
    createdAt: new Date(Date.now() - 4 * DAY).toISOString(),
    id: 'dr_marked_1',
    part: 1,
    question: 1,
    quizName: 'Distance and speed',
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    assignment: false,
    attemptId: 'at_2',
    bytes: 54 * 1024,
    createdAt: new Date(Date.now() - DAY).toISOString(),
    id: 'dr_marked_2',
    question: 11,
    quizName: 'Genetics check-in',
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
];
const minutes = (count: number) =>
  new Date(Date.now() + count * 60_000).toISOString();
const at = (days: number, hours = 18) => {
  const d = new Date(Date.now() + days * DAY);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
};

const textBlock = (text: string) => [{ text, type: 'text' as const }];
const base = (id: string) => ({
  id,
  labels: 'letters' as const,
  layout: 'paper' as const,
  stem: [],
});
const mcq = (
  id: string,
  text: string,
  options: string[],
  correct: number,
  marks = 1
): Question => ({
  ...base(id),
  parts: [
    {
      answer: { correct: [correct], options, type: 'mcq' },
      blocks: textBlock(text),
      id: `${id}:a`,
      marks,
      solution: [],
    },
  ],
});
const short = (
  id: string,
  text: string,
  accepted: string[],
  marks = 2
): Question => ({
  ...base(id),
  parts: [
    {
      answer: { accepted, type: 'short' },
      blocks: textBlock(text),
      id: `${id}:a`,
      marks,
      solution: [],
    },
  ],
});
const open = (
  id: string,
  text: string,
  items: [string, number][],
  solution?: string
): Question => ({
  ...base(id),
  parts: [
    {
      answer: { accepted: [], hints: [], type: 'open' },
      blocks: textBlock(text),
      id: `${id}:a`,
      marks: items.reduce((sum, [, marks]) => sum + marks, 0),
      markscheme: items.map(([text, marks]) => ({ marks, text })),
      solution: solution ? textBlock(solution) : [],
    },
  ],
});

/** Past paper 2025 P1: 12 questions, 40 marks, as the boards draw it. */
const pastPaper = (): Question[] => [
  mcq(
    'q1',
    "Which organelle makes most of a cell's ATP?",
    ['Nucleus', 'Mitochondria', 'Ribosome', 'Golgi body'],
    1
  ),
  short(
    'q2',
    'Name the process that moves water across a membrane.',
    ['osmosis'],
    2
  ),
  open(
    'q3',
    'Explain how water enters a root hair cell from the soil.',
    [
      ['Names the partially permeable membrane', 2],
      ['Water moves from dilute to concentrated solution', 2],
      ['Uses the term water potential', 1],
      ["Links to the cell's higher solute concentration", 1],
    ],
    'Soil water is more dilute than the cell sap, so water moves into the cell by osmosis through the partially permeable membrane, down the water potential gradient.'
  ),
  short(
    'q4',
    'Describe what happens to a plant cell placed in a concentrated salt solution.',
    ['it shrinks', 'shrinks', 'plasmolysis'],
    2
  ),
  open('q5', 'Label the nucleus and the cytoplasm on a cheek cell.', [
    ['Nucleus labelled', 1],
    ['Cytoplasm labelled', 1],
  ]),
  open('q6', 'Compare diffusion and active transport.', [
    ['Diffusion goes down a gradient', 1],
    ['Active transport goes against a gradient', 1],
    ['Active transport needs energy', 1],
    ['Diffusion needs no energy', 1],
  ]),
  short(
    'q7',
    'Calculate the real width of the cell from the image and the magnification.',
    ['0.02 mm', '0.02'],
    2
  ),
  open(
    'q8',
    'Explain why a red blood cell shrinks in a concentrated salt solution.',
    [
      ['Water leaves the cell', 1],
      ['By osmosis', 1],
      ['No cell wall to keep its shape', 1],
    ]
  ),
  open('q9', 'Explain why muscle cells have many mitochondria.', [
    ['Muscles need much energy', 2],
    ['Mitochondria release energy in respiration', 2],
  ]),
  open('q10', 'Describe how to prepare a slide of onion epidermis cells.', [
    ['Peel a thin layer', 1],
    ['Place on a slide with water', 1],
    ['Add a stain', 1],
    ['Lower a cover slip', 1],
  ]),
  open(
    'q11',
    'Describe how the nucleus and the ribosomes work together to make a protein.',
    [
      ['DNA holds the code', 2],
      ['Ribosomes build the chain', 2],
    ]
  ),
  open('q12', 'Explain what the potato cylinder results show about osmosis.', [
    ['Mass rises in dilute solution', 2],
    ['Mass falls in concentrated solution', 2],
    ['No change where potentials match', 2],
  ]),
];

const worksheet = (count: number): Question[] =>
  Array.from({ length: count }, (_, i) =>
    mcq(
      `w${i + 1}`,
      `Inheritance question ${i + 1}: which is the dominant allele?`,
      ['B', 'b'],
      0,
      2
    )
  );

const rows = new Map<string, Row>();
const attempts = new Map<string, Attempt>();
let seeded = false;
let nextId = 0;
const newId = (prefix: string) => `${prefix}_mock_${++nextId}`;

const viewers = (workspaceId: string) =>
  mockWorkspaceMembers.filter(
    (m) => m.workspaceId === workspaceId && m.role === 'viewer'
  );

function gradePaper(
  questions: Question[],
  answers: Answers
): AssignmentGradedQuestion[] {
  return questions.map((question) => ({
    ...question,
    parts: question.parts.map((part) => {
      // A drawing Done stored waits for the AI, as an open answer does.
      if (part.answer.type === 'drawing')
        return (answers[part.id] as { drawing?: string } | undefined)?.drawing
          ? { ...part, awarded: 0, pending: true }
          : {
              ...part,
              awarded: 0,
              itemAwards: (part.markscheme ?? []).map(() => 0),
            };
      if (part.answer.type !== 'open') {
        const { awarded, items } = scorePart(part, answers[part.id]);
        return part.answer.type === 'matching' || part.answer.type === 'gaps'
          ? { ...part, awarded, itemResults: items }
          : { ...part, awarded };
      }
      const text = answers[part.id];
      const items = (part.markscheme ?? []).map(() => 0);
      return typeof text === 'string' && text.trim()
        ? { ...part, awarded: 0, pending: true }
        : { ...part, awarded: 0, itemAwards: items };
    }),
  }));
}

const OPEN_ANSWER =
  'Water goes into the root hair cell by osmosis. It crosses the partially permeable membrane and then moves on towards the xylem.';

/** A member's seeded answers: `right` of the closed parts right, open parts
 * answered; each open answer marked except the `waiting` first ones. */
function seedAttempt(
  row: Row,
  userId: string,
  right: number,
  waiting: number,
  minutes: number,
  daysAgo: number
) {
  const questions = row.questions ?? [];
  const answers: Answers = {};
  let closed = 0;
  for (const question of questions)
    for (const part of question.parts) {
      if (part.answer.type === 'mcq')
        answers[part.id] = [
          closed++ < right
            ? part.answer.correct[0]
            : (part.answer.correct[0] + 1) % part.answer.options.length,
        ];
      else if (part.answer.type === 'short')
        answers[part.id] =
          closed++ < right ? part.answer.accepted[0] : 'diffusion';
      else if (part.answer.type === 'open') answers[part.id] = OPEN_ANSWER;
    }
  const graded = gradePaper(questions, answers);
  let waited = 0;
  graded.forEach((question, q) => {
    if (!question.parts.some((p) => p.pending)) return;
    if (waited++ < waiting) return;
    question.parts = question.parts.map((part) => {
      if (!part.pending) return part;
      const items = (part.markscheme ?? []).map((item, i) =>
        (i + q + right) % 3 === 2 ? 0 : item.marks
      );
      const { pending: _, ...rest } = part;
      return {
        ...rest,
        awarded: items.reduce((sum, v) => sum + v, 0),
        itemAwards: items,
        markedBy: db.user.id,
      };
    });
  });
  const submittedAt = at(-daysAgo, 12);
  const id = newId('at');
  attempts.set(id, {
    answers,
    assignmentId: row.id,
    autoSubmitted: false,
    graded,
    id,
    startedAt: new Date(
      Date.parse(submittedAt) - minutes * 60_000
    ).toISOString(),
    submittedAt,
    userId,
  });
}

function seed() {
  if (seeded) return;
  seeded = true;
  const quizzes = db.materials.filter(
    (mt) => mt.workspaceId === WS && mt.kind === 'quiz' && !mt.parentMaterialId
  );
  const files = db.files.filter((f) => f.workspaceId === WS);
  const common = {
    allowUploads: false,
    assignAll: true,
    assignees: [],
    attempts: 1,
    draft: false,
    files: [],
    latePenaltyPct: 0,
    marking: 'ai_approve' as const,
    noLate: false,
    showAnswers: 'submitted' as const,
    showGrades: 'automatic' as const,
    shuffle: false,
    workspaceId: WS,
  };
  const list: Row[] = [
    {
      ...common,
      dueAt: at(1, 23),
      files: files[0] ? [{ fileId: files[0].id }] : [],
      id: 'as_read',
      kind: 'unmarked',
      postedAt: at(-1, 9),
      title: 'Read Lecture 2 before the worksheet',
    },
    {
      ...common,
      dueAt: at(2),
      id: 'as_genetics',
      kind: 'marked',
      postedAt: at(-4, 9),
      questions: worksheet(10),
      quizId: quizzes[1]?.id,
      title: 'Genetics worksheet',
    },
    {
      ...common,
      dueAt: at(3),
      id: 'as_paper',
      kind: 'marked',
      postedAt: at(-1, 9),
      questions: pastPaper(),
      quizId: quizzes[0]?.id,
      timeLimitMin: 60,
      title: 'Past paper 2025 P1',
    },
    // Members may hand in a paper (Epo 2026-11-08, S4/S5).
    {
      ...common,
      allowUploads: true,
      dueAt: at(4),
      id: 'as_upload',
      kind: 'marked',
      postedAt: at(-1, 10),
      questions: pastPaper(),
      quizId: quizzes[0]?.id,
      timeLimitMin: 60,
      title:
        'Mock exam on paper: Paper 2 structured questions on cells, tissues and organisation',
    },
    {
      ...common,
      dueAt: at(6),
      id: 'as_inheritance',
      kind: 'marked',
      postedAt: at(0, 9),
      questions: worksheet(9),
      title: 'Inheritance worksheet',
    },
    // Members hand in files with Hand in (Epo 2026-11-08, S3/T2).
    {
      ...common,
      allowUploads: true,
      dueAt: at(3, 23),
      files: files[0] ? [{ fileId: files[0].id }] : [],
      id: 'as_lab',
      kind: 'unmarked',
      postedAt: at(-1, 11),
      title: 'Osmosis lab write-up',
    },
    {
      ...common,
      files: files[1] ? [{ fileId: files[1].id }] : [],
      id: 'as_notes',
      kind: 'unmarked',
      postedAt: at(0, 9),
      title: 'Make notes on Week 2 slides',
    },
    {
      ...common,
      dueAt: at(-11),
      id: 'as_cells',
      kind: 'marked',
      noLate: true,
      postedAt: at(-18, 9),
      questions: worksheet(10),
      quizId: quizzes[2]?.id,
      releasedAt: at(-11),
      title: 'Cells check',
    },
    {
      ...common,
      dueAt: at(-2),
      id: 'as_osmosis',
      kind: 'marked',
      latePenaltyPct: 20,
      postedAt: at(-7, 9),
      questions: worksheet(10),
      title: 'Osmosis check',
    },
    {
      ...common,
      draft: true,
      dueAt: at(9),
      id: 'as_draft',
      kind: 'marked',
      postedAt: at(0, 8),
      quizId: quizzes[0]?.id,
      title: 'Membranes quiz',
    },
    // Given to the viewer by name ("You"), so the owner's To do shows how each
    // kind of due date reads: overdue, the last hour of No late, today,
    // tomorrow, further out and none.
    ...(
      [
        ['as_me_overdue', 'unmarked', 'Return the lab coats', at(-1, 17)],
        ['as_me_soon', 'marked', 'Enzymes quick check', minutes(40)],
        ['as_me_today', 'unmarked', 'Print the field trip forms', minutes(180)],
        ['as_me_tomorrow', 'marked', 'Photosynthesis quiz', at(1, 9)],
        [
          'as_me_week',
          'unmarked',
          'Review the revision guide and write a one-page summary of chapters 3 to 5 before Friday',
          at(8, 16),
        ],
        ['as_me_far', 'marked', 'End of term paper', at(75, 9)],
        ['as_me_open', 'unmarked', 'Tidy the shared notes', undefined],
      ] as const
    ).map(
      ([id, kind, title, dueAt]): Row => ({
        ...common,
        assignAll: false,
        assignees: [db.user.id],
        dueAt,
        // Two tasks carry files, for the details dialog's list.
        files:
          id === 'as_me_week'
            ? files.slice(0, 2).map((f) => ({ fileId: f.id }))
            : id === 'as_me_today' && files[2]
              ? [{ fileId: files[2].id }]
              : [],
        id,
        kind,
        noLate: id === 'as_me_soon',
        postedAt: at(-2, 9),
        questions: kind === 'marked' ? worksheet(5) : undefined,
        timeLimitMin: id === 'as_me_tomorrow' ? 20 : undefined,
        title,
      })
    ),
    // Two more classes given to the viewer by name, so To do groups several.
    ...(
      [
        [
          'as_hist_essay',
          'ws_hist',
          'unmarked',
          'Essay: the long-term and short-term causes of the First World War, with sources',
          at(3, 9),
        ],
        [
          'as_hist_quiz',
          'ws_hist',
          'marked',
          'Cold War quiz: the Berlin Blockade, the Cuban Missile Crisis and détente',
          at(2, 13),
        ],
        ['as_hist_read', 'ws_hist', 'unmarked', 'Read chapter 4', undefined],
        [
          'as_eng_poetry',
          'ws_eng',
          'marked',
          'Poetry analysis quiz',
          minutes(300),
        ],
        [
          'as_eng_macbeth',
          'ws_eng',
          'unmarked',
          'Annotate Macbeth Act 1',
          at(5, 17),
        ],
      ] as const
    ).map(
      ([id, workspaceId, kind, title, dueAt]): Row => ({
        ...common,
        assignAll: false,
        assignees: [db.user.id],
        dueAt,
        id,
        kind,
        postedAt: at(-3, 9),
        questions: kind === 'marked' ? worksheet(6) : undefined,
        timeLimitMin: id === 'as_hist_quiz' ? 15 : undefined,
        title,
        workspaceId,
      })
    ),
  ];
  for (const row of list) rows.set(row.id, row);

  const class6 = viewers(WS).map((m) => m.userId);
  const paper = rows.get('as_paper')!;
  // Ben 1 to approve, Cara and Eve none, Farah and Gus 2; Dan not yet.
  const ben = class6.find((id) => id === 'u_mock_tom')!;
  const cara = 'u_mock_diego';
  const eve = 'u_mock_hana';
  seedAttempt(paper, ben, 4, 1, 38, 1);
  seedAttempt(paper, cara, 3, 0, 47, 0);
  seedAttempt(paper, eve, 4, 0, 52, 2);
  seedAttempt(paper, 'u_mock_farah', 2, 2, 41, 0);
  seedAttempt(paper, 'u_mock_gus', 1, 2, 55, 1);
  // T3: Ben's grade failed and Farah had no credits; the rest read Not marked.
  for (const attempt of attempts.values()) {
    if (attempt.assignmentId !== paper.id) continue;
    for (const q of attempt.graded)
      for (const part of q.parts) {
        if (!part.pending) continue;
        if (attempt.userId === ben) part.aiError = 'error';
        if (attempt.userId === 'u_mock_farah') part.aiError = 'credits';
      }
  }
  // T1: Ben handed in a paper, read and waiting on its open parts.
  const upload = rows.get('as_upload')!;
  seedAttempt(upload, ben, 4, 1, 40, 1);
  for (const attempt of attempts.values()) {
    if (attempt.assignmentId !== upload.id) continue;
    attempt.paper = 'read';
    attempt.paperFiles = [
      {
        id: 'f_scan',
        kind: 'image',
        name: 'Mock exam scan.jpg',
        sizeBytes: 1_900_000,
        status: 'ready',
      },
    ];
    for (const q of attempt.graded)
      for (const part of q.parts) part.pages = [1];
  }
  const genetics = rows.get('as_genetics')!;
  for (const [i, id] of class6.entries())
    seedAttempt(genetics, id, 8 + (i % 3), 0, 20 + i, 1);
  const inheritance = rows.get('as_inheritance')!;
  for (const id of class6.slice(0, 4))
    seedAttempt(inheritance, id, 6, 0, 18, 0);
  // The Member scenario's own work (boards W3, H2b).
  seedAttempt(genetics, db.user.id, 7, 0, 22, 1);
  seedAttempt(inheritance, db.user.id, 6, 0, 19, 0);
  const cells = rows.get('as_cells')!;
  for (const id of class6.slice(0, 5)) seedAttempt(cells, id, 7, 0, 25, 12);
  seedAttempt(cells, db.user.id, 8, 0, 24, 12);
  // In on time, and late with its 20% off, the Member scenario's viewer too.
  const osmosis = rows.get('as_osmosis')!;
  for (const id of class6.slice(0, 3)) seedAttempt(osmosis, id, 8, 0, 21, 3);
  for (const id of class6.slice(3, 5)) seedAttempt(osmosis, id, 9, 0, 23, 1);
  seedAttempt(osmosis, db.user.id, 8, 0, 26, 1);

  done.set('as_read', new Map(class6.slice(0, 4).map((id) => [id, at(0, 9)])));
  done.set('as_notes', new Map(class6.slice(0, 2).map((id) => [id, at(0, 9)])));
  // T2: four of the class handed in their write-ups.
  const work = (id: string, name: string, kind: string, sizeBytes: number) => ({
    id,
    kind,
    name,
    sizeBytes,
    status: 'ready',
  });
  const lab: [string, PaperFile[]][] = [
    ['u_mock_tom', [work('f_lab_ben', 'Lab write-up.pdf', 'pdf', 1_800_000)]],
    [
      'u_mock_diego',
      [
        work('f_lab_cara', 'Osmosis write-up.pdf', 'pdf', 1_800_000),
        work('f_lab_cara2', 'results-table.jpg', 'image', 900_000),
      ],
    ],
    [
      'u_mock_hana',
      [1, 2, 3].map((n) =>
        work(`f_lab_eve${n}`, `IMG_04${n}.jpg`, 'image', 1_200_000)
      ),
    ],
    ['u_mock_farah', [work('f_lab_farah', 'Osmosis lab.docx', 'docx', 60_000)]],
  ];
  for (const [id, handed] of lab) setHandIn('as_lab', id, handed);
  done.set('as_lab', new Map(lab.map(([id]) => [id, at(0, 10)])));
}

/** Who ticked an unmarked assignment, and when. */
const done = new Map<string, Map<string, string>>();
/** The viewer's To do ticks that aren't the work (Epo 2026-11-10): `work` on
 * their own quiz or hand-in, `approvals` on the answers waiting for them. */
const todoChecks = new Map<string, { approvals?: string; work?: string }>();
/** Who posted in the other classes, so To do's Posted by varies. */
const POSTERS: Record<string, string> = {
  ws_eng: 'Ms Rivera',
  ws_hist: 'Mr Okafor',
};
/** Rows taken off Done, by when: finished again after, they come back. */
const todoHidden = new Map<string, number>();

const pastDue = (row: Row) =>
  !!row.dueAt && Date.parse(row.dueAt) <= Date.now();

/** Closed by hand, or from its due date under No late submissions. */
const closedAtOf = (row: Row) => {
  if (
    row.noLate &&
    pastDue(row) &&
    (!row.closedAt || Date.parse(row.dueAt!) < Date.parse(row.closedAt))
  )
    return row.dueAt;
  return row.closedAt;
};

/** Either kind (Epo 2026-11-09, "same rules"). */
const isClosed = (row: Row) => !!closedAtOf(row);

const isLate = (row: Row, submittedAt?: string) =>
  !row.noLate &&
  !!submittedAt &&
  !!row.dueAt &&
  Date.parse(submittedAt) > Date.parse(row.dueAt);

const penaltyOf = (row: Row, submittedAt?: string) =>
  isLate(row, submittedAt) ? row.latePenaltyPct : 0;

const penalised = (correct: number, pct: number) =>
  Math.round(correct * (100 - pct)) / 100;

const assignedTo = (row: Row, viewer: Viewer) => {
  const members = viewers(row.workspaceId).map((m) => m.userId);
  const named = row.assignees.filter(
    (id) => id === db.user.id || members.includes(id)
  );
  return [
    ...new Set([
      ...(row.assignAll ? members : []),
      ...named,
      // The Member scenario's viewer is in the class, and staff see a paper
      // they handed in.
      ...(row.assignAll &&
      (viewer === 'member' ||
        submissions(row.id, db.user.id).some((a) => a.paper))
        ? [db.user.id]
        : []),
    ]),
  ];
};

/** A report row's view of the AI's waiting marks. */
const aiRow = (q: AssignmentGradedQuestion) => ({
  aiAwarded: q.parts.reduce(
    (n, p) =>
      n +
      (p.aiAwards
        ? p.aiAwards.reduce((sum, v) => sum + v, 0)
        : (p.awarded ?? 0)),
    0
  ),
  aiError: q.parts.find((p) => p.pending && !p.aiAwards && p.aiError)?.aiError,
  aiMarked: q.parts.every((p) => !p.pending || p.aiAwards),
  aiWarning: q.parts.some((p) => p.aiFlag)
    ? 'error'
    : q.parts.some((p) => p.aiComment)
      ? 'warning'
      : '',
  // The mock keeps every drawing's marking image.
  handMarking: false,
});

function submissions(assignmentId: string, userId: string) {
  return [...attempts.values()]
    .filter(
      (a) =>
        a.assignmentId === assignmentId && a.userId === userId && a.submittedAt
    )
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
}

/** The submission that counts: the highest mark after any late penalty, a tie
 * to the latest (`countedAttemptOrder`). */
function counted(row: Row, userId: string) {
  const mark = (a: Attempt) =>
    penalised(totals(a.graded).correct, penaltyOf(row, a.submittedAt));
  return submissions(row.id, userId).reduce<Attempt | undefined>(
    (best, a) => (!best || mark(a) >= mark(best) ? a : best),
    undefined
  );
}

function totals(graded: AssignmentGradedQuestion[]) {
  let correct = 0;
  let total = 0;
  let waitingMarks = 0;
  let waitingAnswers = 0;
  for (const question of graded) {
    let waits = false;
    for (const part of question.parts) {
      correct += part.awarded ?? 0;
      total += part.marks;
      if (part.pending) {
        waitingMarks += part.marks;
        waits = true;
      }
    }
    if (waits) waitingAnswers++;
  }
  return { correct, total, waitingAnswers, waitingMarks };
}

/** Submits what a running attempt saved once its time is out or it closed,
 * past the grace the page's own submit has (`attemptRow.expired`). */
function sweep(row: Row) {
  const past = (at?: string) =>
    !!at && Date.now() > Date.parse(at) + ASSIGNMENT_GRACE_MS;
  for (const attempt of attempts.values()) {
    if (attempt.assignmentId !== row.id || attempt.submittedAt) continue;
    const timedOut =
      past(attempt.deadlineAt) || (row.noLate && past(row.dueAt));
    if (timedOut || past(row.closedAt))
      finish(row, attempt, attempt.answers, timedOut);
  }
}

function finish(row: Row, attempt: Attempt, answers: Answers, auto: boolean) {
  attempt.answers = answers;
  attempt.autoSubmitted = auto;
  attempt.submittedAt = new Date().toISOString();
  attempt.graded = gradePaper(row.questions ?? [], answers);
  // A paper: the mock reads it at once, every part on its first page, waiting.
  if (attempt.paper === 'upload') {
    attempt.paper = 'read';
    attempt.answers = {};
    attempt.graded = attempt.graded.map((q) => ({
      ...q,
      parts: q.parts.map((p) => ({
        ...p,
        awarded: 0,
        pages: [1],
        pending: true,
      })),
    }));
  }
}

/** A class has staff; a personal workspace only each person's own tasks. */
const isClass = (workspaceId: string) =>
  db.workspaces.find((ws) => ws.id === workspaceId)?.kind === 'class';

/** Whether the viewer runs the row as its staff: a class's owner, or the maker
 * of a task they set themself, which the mock's viewer always is. */
const runs = (row: Row, viewer: Viewer) => !!row.own || viewer === 'owner';

function toAssignment(row: Row, viewer: Viewer): Assignment {
  sweep(row);
  const staff = row.own || (viewer === 'owner' && isClass(row.workspaceId));
  const questions = row.questions ?? [];
  const marks = questions.reduce(
    (sum, q) => sum + q.parts.reduce((n, p) => n + p.marks, 0),
    0
  );
  const assigned = assignedTo(row, viewer);
  const countedRows = assigned.flatMap((id) => {
    const a = counted(row, id);
    return a ? [a] : [];
  });
  const ticked = [...(done.get(row.id)?.keys() ?? [])].filter((id) =>
    assigned.includes(id)
  );
  const decided = countedRows.map((a) => totals(a.graded));
  const mine = assigned.includes(db.user.id)
    ? counted(row, db.user.id)
    : undefined;
  const running = [...attempts.values()].find(
    (a) =>
      a.assignmentId === row.id && a.userId === db.user.id && !a.submittedAt
  );
  const tick = done.get(row.id)?.get(db.user.id);
  const myTotals = mine ? totals(mine.graded) : undefined;
  const material = db.materials.find((mt) => mt.id === row.quizId);
  const topicIds =
    row.kind === 'marked'
      ? material?.topicId
        ? [material.topicId]
        : []
      : [
          ...new Set(
            row.files.flatMap((f) => {
              const file = db.files.find((x) => x.id === f.fileId);
              return file?.topicId ? [file.topicId] : [];
            })
          ),
        ];
  const gradesHidden = row.showGrades === 'manual' && !row.gradesReleasedAt;
  return {
    allowUploads: row.allowUploads,
    attempts: row.attempts,
    closed: isClosed(row),
    closedAt: closedAtOf(row),
    draft: row.draft,
    drawingParts: (row.questions ?? []).some((q) =>
      q.parts.some((p) => p.answer.type === 'drawing')
    ),
    dueAt: row.dueAt,
    files: row.files.flatMap((f): Assignment['files'] => {
      const file = db.files.find((x) => x.id === f.fileId);
      const mt = db.materials.find((x) => x.id === f.materialId);
      // Where each sits: a task's files need not be its own workspace's.
      const from = (workspaceId?: string) => {
        const ws = db.workspaces.find((w) => w.id === workspaceId);
        return ws ? { workspaceId: ws.id, workspaceName: ws.name } : {};
      };
      if (file)
        return [
          {
            fileId: file.id,
            kind: file.kind,
            name: file.name,
            ...from(file.workspaceId),
          },
        ];
      if (mt)
        return [
          {
            kind: mt.kind,
            materialId: mt.id,
            name: mt.title,
            ...from(mt.workspaceId),
          },
        ];
      return [];
    }),
    gradesHidden,
    id: row.id,
    kind: row.kind,
    latePenaltyPct: row.latePenaltyPct,
    marks,
    noLate: row.noLate,
    own: !!row.own,
    postedAt: row.postedAt,
    postedBy: row.own
      ? db.user.name
      : (POSTERS[row.workspaceId] ?? db.user.name),
    practiceQuizId: row.releasedAt && !gradesHidden ? row.quizId : undefined,
    questions: questions.length,
    timeLimitMin: row.timeLimitMin,
    title: row.title,
    topicIds,
    workspaceId: row.workspaceId,
    ...(staff
      ? {
          manage: {
            // Ticked off until an answer is submitted after it.
            approvalsCheckedOff: (() => {
              const at = todoChecks.get(row.id)?.approvals;
              const latest = assigned
                .flatMap((id) => submissions(row.id, id))
                .filter((a) => totals(a.graded).waitingAnswers > 0)
                .reduce(
                  (max, a) => Math.max(max, Date.parse(a.submittedAt ?? '')),
                  Number.NEGATIVE_INFINITY
                );
              return !!at && Date.parse(at) >= latest;
            })(),
            assignAll: row.assignAll,
            assigned: assigned.length,
            assignees: row.assignees,
            average:
              decided.length >= 5
                ? decided.reduce(
                    (sum, d) => sum + d.correct / (d.total - d.waitingMarks),
                    0
                  ) / decided.length
                : undefined,
            done: row.kind === 'marked' ? countedRows.length : ticked.length,
            gradesReleasedAt: row.gradesReleasedAt,
            marking: row.marking,
            notGraded:
              row.marking === 'manual'
                ? 0
                : assigned
                    .flatMap((id) => submissions(row.id, id))
                    .reduce(
                      (sum, a) =>
                        sum +
                        a.graded.filter((q) =>
                          q.parts.some((p) => p.pending && !p.aiAwards)
                        ).length,
                      0
                    ),
            practiceAt: row.practiceAt,
            quizId: row.quizId,
            quizTitle: material?.title,
            quizWorkspaceId: material?.workspaceId || undefined,
            showAnswers: row.showAnswers,
            showGrades: row.showGrades,
            shuffle: row.shuffle,
            toApprove: assigned
              .flatMap((id) => submissions(row.id, id))
              .reduce((sum, a) => sum + totals(a.graded).waitingAnswers, 0),
            toPractice:
              !row.own &&
              !row.draft &&
              !!closedAtOf(row) &&
              !gradesHidden &&
              answersHeld(row),
          },
        }
      : {}),
    ...(assigned.includes(db.user.id) && !row.draft
      ? {
          mine: {
            attemptsUsed: [...attempts.values()].filter(
              (a) =>
                a.assignmentId === row.id &&
                a.userId === db.user.id &&
                a.submittedAt
            ).length,
            checkedAt: todoChecks.get(row.id)?.work,
            checkedOff: !!todoChecks.get(row.id)?.work,
            correct: gradesHidden ? undefined : myTotals?.correct,
            countedAttemptId: mine?.id,
            done: !!mine || !!tick,
            doneAt: mine?.submittedAt ?? tick,
            handIn:
              row.kind === 'unmarked' && row.allowUploads
                ? handInOf(row.id, db.user.id)
                : undefined,
            late: isLate(row, mine?.submittedAt ?? tick),
            latePenaltyPct: penaltyOf(row, mine?.submittedAt),
            mark:
              myTotals && !gradesHidden
                ? penalised(myTotals.correct, penaltyOf(row, mine?.submittedAt))
                : undefined,
            missing:
              row.kind === 'marked' &&
              !mine &&
              !!row.dueAt &&
              Date.parse(row.dueAt) <= Date.now(),
            runningAttemptId: running?.id,
            total: gradesHidden ? undefined : myTotals?.total,
            waitingAnswers: gradesHidden ? 0 : (myTotals?.waitingAnswers ?? 0),
            waitingMarks: gradesHidden ? 0 : (myTotals?.waitingMarks ?? 0),
          },
        }
      : {}),
  };
}

function attemptView(attempt: Attempt, row: Row, viewer: Viewer) {
  const member = viewers(row.workspaceId).find(
    (m) => m.userId === attempt.userId
  );
  const name = member?.name ?? db.user.name;
  const common = {
    assignmentId: row.id,
    autoSubmitted: attempt.autoSubmitted,
    closesAt: row.noLate ? row.dueAt : undefined,
    deadlineAt: attempt.deadlineAt,
    // Manual grading makes no marking images (Q693).
    drawingImages: row.marking !== 'manual',
    id: attempt.id,
    late: isLate(row, attempt.submittedAt),
    latePenaltyPct: penaltyOf(row, attempt.submittedAt),
    now: new Date().toISOString(),
    paper: attempt.paper,
    paperFiles: attempt.paperFiles ?? [],
    removedAssetIds: [],
    startedAt: attempt.startedAt,
    title: row.title,
    userAvatarUrl: member?.avatarUrl,
    userId: attempt.userId,
    userName: name,
  };
  if (!attempt.submittedAt)
    return {
      ...common,
      answers: attempt.answers,
      correct: 0,
      gradesHidden: false,
      mark: 0,
      questions: (row.questions ?? []).map(learnerView),
      showAnswers: false,
      status: 'running' as const,
      total: 0,
      waitingAnswers: 0,
      waitingMarks: 0,
    } satisfies AssignmentAttempt;
  // Show grades Manual: a member reads their answers alone until release.
  if (
    !runs(row, viewer) &&
    row.showGrades === 'manual' &&
    !row.gradesReleasedAt
  )
    return {
      ...common,
      answers: attempt.answers,
      correct: 0,
      gradesHidden: true,
      mark: 0,
      questions: attempt.graded.map((q) => learnerView(q as Question)),
      showAnswers: false,
      status: 'submitted' as const,
      submittedAt: attempt.submittedAt,
      total: 0,
      waitingAnswers: 0,
      waitingMarks: 0,
    } satisfies AssignmentAttempt;
  const show =
    runs(row, viewer) ||
    row.showAnswers === 'submitted' ||
    (row.showAnswers === 'closed' && !!closedAtOf(row));
  return {
    ...common,
    ...totals(attempt.graded),
    answers: attempt.answers,
    gradesHidden: false,
    mark: penalised(
      totals(attempt.graded).correct,
      penaltyOf(row, attempt.submittedAt)
    ),
    questions: attempt.graded.map((question) =>
      show
        ? question
        : {
            ...learnerView(question as Question),
            comment: question.comment,
            commentByName: question.commentByName,
            parts: question.parts.map((part, i) => ({
              ...learnerView(question as Question).parts[i],
              awarded: part.awarded,
              pending: part.pending,
            })),
          }
    ),
    showAnswers: show,
    status: 'submitted' as const,
    submittedAt: attempt.submittedAt,
  } satisfies AssignmentAttempt;
}

function partReport(part: QuestionPart, list: Attempt[]): AssignmentPartReport {
  const out: AssignmentPartReport = { partId: part.id };
  const gradedPart = (a: Attempt) =>
    a.graded.flatMap((q) => q.parts).find((p) => p.id === part.id);
  if (part.answer.type === 'mcq') {
    out.options = part.answer.options.map(() => 0);
    for (const a of list) {
      const chosen = a.answers[part.id];
      if (Array.isArray(chosen))
        for (const i of chosen as number[]) out.options[i] += 1;
    }
  } else if (part.answer.type === 'short') {
    const counts = new Map<string, number>();
    for (const a of list) {
      const text = a.answers[part.id];
      const graded = gradedPart(a);
      if (
        typeof text === 'string' &&
        graded &&
        (graded.awarded ?? 0) < part.marks
      )
        counts.set(
          text.trim().toLowerCase(),
          (counts.get(text.trim().toLowerCase()) ?? 0) + 1
        );
    }
    out.wrongAnswers = [...counts]
      .map(([text, count]) => ({ count, text }))
      .sort((a, b) => b.count - a.count);
  } else if (part.answer.type === 'open') {
    out.items = (part.markscheme ?? []).map((item, i) => {
      const marked = list.flatMap((a) => {
        const graded = gradedPart(a);
        return graded && !graded.pending ? [graded] : [];
      });
      return {
        awarded: marked.filter((g) => (g.itemAwards?.[i] ?? 0) > 0).length,
        marked: marked.length,
        marks: item.marks,
        text: item.text,
      };
    });
  }
  return out;
}

function report(row: Row, viewer: Viewer): AssignmentReport {
  sweep(row);
  const assigned = assignedTo(row, viewer);
  const roster = viewers(row.workspaceId);
  const nameOf = (id: string) =>
    roster.find((m) => m.userId === id) ?? {
      avatarUrl: db.user.avatarUrl,
      name: db.user.name,
    };
  const countedRows = assigned.flatMap((id) => {
    const a = counted(row, id);
    return a ? [a] : [];
  });
  const members: AssignmentMemberRow[] = assigned
    .map((id): AssignmentMemberRow => {
      const a = counted(row, id);
      const sum = a ? totals(a.graded) : undefined;
      const tick = done.get(row.id)?.get(id);
      const person = nameOf(id);
      return {
        attemptId: a?.id,
        avatarUrl: person.avatarUrl,
        correct: sum?.correct,
        late: isLate(row, a?.submittedAt ?? tick),
        latePenaltyPct: penaltyOf(row, a?.submittedAt),
        mark: sum && penalised(sum.correct, penaltyOf(row, a?.submittedAt)),
        minutes: a
          ? Math.max(
              1,
              Math.round(
                (Date.parse(a.submittedAt!) - Date.parse(a.startedAt)) / 60_000
              )
            )
          : undefined,
        missing:
          row.kind === 'marked' &&
          !a &&
          !!row.dueAt &&
          Date.parse(row.dueAt) <= Date.now(),
        name: person.name,
        running: [...attempts.values()].some(
          (x) => x.assignmentId === row.id && x.userId === id && !x.submittedAt
        ),
        submittedAt: a?.submittedAt ?? tick,
        total: sum?.total,
        userId: id,
        ...(row.kind === 'unmarked' && row.allowUploads && tick
          ? { files: handInOf(row.id, id) }
          : {}),
        waitingAnswers: submissions(row.id, id).reduce(
          (n, x) => n + totals(x.graded).waitingAnswers,
          0
        ),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const answers: AssignmentAnswerRow[] = [];
  const questions: AssignmentQuestionReport[] = (row.questions ?? []).map(
    (question) => {
      // Written and drawn answers wait for marking alike.
      const isOpen = question.parts.some((p) => modelMarked(p.answer.type));
      const graded = countedRows.flatMap((a) => {
        const q = a.graded.find((g) => g.id === question.id);
        return q ? [{ attempt: a, q }] : [];
      });
      const marked = graded.filter(({ q }) => !q.parts.some((p) => p.pending));
      const score = (q: AssignmentGradedQuestion) =>
        q.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
      const marks = question.parts.reduce((n, p) => n + p.marks, 0);
      const number = (a: Attempt) =>
        submissions(row.id, a.userId).indexOf(a) + 1;
      if (isOpen) {
        for (const { attempt, q } of graded)
          answers.push({
            ...aiRow(q),
            attemptId: attempt.id,
            attemptNumber: number(attempt),
            awarded: score(q),
            marks,
            questionId: question.id,
            userId: attempt.userId,
            waiting: q.parts.some((p) => p.pending),
          });
        // Another submission's answer still waiting: it can still become the highest.
        for (const attempt of assigned.flatMap((id) =>
          submissions(row.id, id)
        )) {
          const q = attempt.graded.find((g) => g.id === question.id);
          if (q?.parts.some((p) => p.pending) && !countedRows.includes(attempt))
            answers.push({
              ...aiRow(q),
              attemptId: attempt.id,
              attemptNumber: number(attempt),
              awarded: score(q),
              marks,
              questionId: question.id,
              userId: attempt.userId,
              waiting: true,
            });
        }
      }
      const enough = marked.length >= 5;
      return {
        average:
          enough && isOpen
            ? marked.reduce((n, { q }) => n + score(q), 0) / marked.length
            : undefined,
        parts: question.parts.map((p) => partReport(p, countedRows)),
        percent:
          enough && !isOpen
            ? marked.filter(({ q }) => score(q) >= marks).length / marked.length
            : undefined,
        question,
        submitted: graded.length,
      };
    }
  );
  // The mock reads papers at once: one waits only as a seed sets it.
  const papersToRead = [...attempts.values()].filter(
    (a) => a.assignmentId === row.id && a.paper === 'reading'
  ).length;
  return { answers, members, papersToRead, questions };
}

function applyForm(row: Row, body: AssignmentFormReq) {
  row.title = body.title;
  row.dueAt = body.dueAt ?? undefined;
  row.timeLimitMin = body.timeLimitMin ?? undefined;
  row.attempts = body.attempts;
  row.noLate = body.noLate;
  row.latePenaltyPct = body.latePenaltyPct;
  row.assignAll = body.assignAll;
  row.assignees = body.assignees;
  row.marking = body.marking;
  row.showAnswers = body.showAnswers;
  row.showGrades = body.showGrades;
  row.shuffle = body.shuffle;
  row.allowUploads = !!body.allowUploads;
  row.files = body.files.map(({ fileId, materialId }) => ({
    fileId,
    materialId,
  }));
}

/** Freezes the quiz as publishing does. */
function freeze(row: Row) {
  const material = db.materials.find((mt) => mt.id === row.quizId);
  if (material) row.questions = db.quizFromMaterial(material).questions;
}

/** The Dashboard's "assigned" Activity rows. */
export function assignmentActivity(workspaceId: string): WorkspaceActivity[] {
  seed();
  return (
    [...rows.values()]
      // A member's own task is nobody's news.
      .filter(
        (row) => row.workspaceId === workspaceId && !row.draft && !row.own
      )
      .map((row) => ({
        assignmentId: row.id,
        at: row.postedAt,
        kind: 'assigned' as const,
        title: row.title,
      }))
  );
}

/** When the assignment that made this quiz practice closed (board P1). */
export function assignmentClosedAt(quizId: string) {
  seed();
  const row = [...rows.values()].find(
    (r) => r.quizId === quizId && r.releasedAt
  );
  return row && (closedAtOf(row) ?? row.releasedAt);
}

/** Under Show answers Do not show and not yet turned to practice. */
const answersHeld = (row: Row) =>
  row.kind === 'marked' && row.showAnswers === 'never' && !row.practiceAt;

/** The assignments holding a quiz: open ones, and closed ones whose answers are
 * held. A task someone set themself holds no quiz back. */
function holding(quizId: string) {
  seed();
  return [...rows.values()].filter(
    (r) =>
      r.quizId === quizId &&
      !r.own &&
      !r.draft &&
      (!closedAtOf(r) || answersHeld(r))
  );
}

/** Whether the quiz is kept from a member: while an assignment holds it, it is,
 * assigned to them or not (the one it went to opens it through their row). */
export const quizHeldFromMembers = (quizId: string) =>
  holding(quizId).length > 0;

/** A quiz row's fields for this viewer, as the server's lists read them: the icon
 * while it is under an open assignment, and for an assignee what the row opens. */
export function quizAssignmentFields(quizId: string, viewer: Viewer) {
  const open = holding(quizId);
  if (!open.length) return {};
  if (viewer === 'owner') return { assigned: true };
  const mine = open
    .filter((r) => assignedTo(r, viewer).includes(db.user.id))
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
  return mine ? { assigned: true, assignmentId: mine.id } : {};
}

/** Told once in this page's life. */
let sharingNoticeSeen = false;

/** GET /api/recent for this viewer. */
export function recentFor(url: string, viewer: Viewer) {
  const page = db.listRecent(new URL(url));
  return {
    ...page,
    items: page.items
      .map((item) =>
        item.material
          ? {
              ...item,
              material: {
                ...item.material,
                ...quizAssignmentFields(item.material.id, viewer),
              },
            }
          : item
      )
      // A member's held quiz is listed only as the row that opens its assignment.
      .filter(
        (item) =>
          viewer === 'owner' ||
          !item.material ||
          !!item.material.assignmentId ||
          !quizHeldFromMembers(item.material.id)
      ),
  };
}

/** A workspace's rows for this viewer: a member lists a quiz that is hidden, or
 * held by an open assignment, only while it is assigned to them. */
export function workspaceMaterialRefs(wsId: string, viewer: Viewer) {
  const refs: MaterialRef[] = db.materials
    .filter((mt) => mt.workspaceId === wsId && !mt.parentMaterialId)
    .map((mt) => ({
      createdAt: mt.createdAt,
      hidden: mt.hidden,
      id: mt.id,
      maxDepth: mt.maxDepth,
      nodeCount: mt.nodeCount,
      position: mt.position,
      sizeBytes: mt.contentBytes,
      title: mt.title,
      topicId: mt.topicId,
      type: mt.kind,
      ...quizAssignmentFields(mt.id, viewer),
    }))
    .filter(
      (ref) =>
        viewer === 'owner' ||
        ref.assignmentId ||
        (!ref.hidden && !quizHeldFromMembers(ref.id))
    )
    // An assignee isn't told it is hidden from others.
    .map((ref) => (ref.assignmentId ? { ...ref, hidden: false } : ref))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return refs;
}

/** The viewer's submissions on the Files page: papers of closed assignments,
 * every part marked; hand-ins of closed ones. */
export function submittedPapers(): SubmittedPaper[] {
  seed();
  const workspaceName = (id: string) =>
    db.workspaces.find((w) => w.id === id)?.name ?? '';
  const items: SubmittedPaper[] = [...attempts.values()].flatMap((a) => {
    const row = rows.get(a.assignmentId);
    const marked = a.graded.every((q) => q.parts.every((p) => !p.pending));
    if (
      !row ||
      a.userId !== db.user.id ||
      a.paper !== 'read' ||
      !marked ||
      !closedAtOf(row)
    )
      return [];
    return (a.paperFiles ?? []).map((f) => ({
      assignmentId: row.id,
      attemptId: a.id,
      bytes: f.sizeBytes,
      createdAt: a.submittedAt ?? a.startedAt,
      id: f.id,
      kind: f.kind,
      name: f.name,
      quizName: row.title,
      workspaceId: row.workspaceId,
      workspaceName: workspaceName(row.workspaceId),
    }));
  });
  for (const [assignmentId, byUser] of handIns) {
    const row = rows.get(assignmentId);
    if (!row || !isClosed(row)) continue;
    for (const f of byUser.get(db.user.id) ?? [])
      items.push({
        assignmentId,
        bytes: f.sizeBytes,
        createdAt: row.postedAt,
        id: f.id,
        kind: f.kind,
        name: f.name,
        quizName: row.title,
        workspaceId: row.workspaceId,
        workspaceName: workspaceName(row.workspaceId),
      });
  }
  return items;
}

const gone = () => new HttpResponse(null, { status: 404 });
const conflict = (code: string, detail: string) =>
  HttpResponse.json(
    { detail, errors: [{ message: code }], status: 409, title: 'Conflict' },
    { status: 409 }
  );

export const assignmentHandlers = (viewer: Viewer) => {
  const rowOf = (id: unknown) => {
    seed();
    return rows.get(String(id));
  };
  const attemptOf = (id: unknown) => {
    seed();
    const attempt = attempts.get(String(id));
    const row = attempt && rows.get(attempt.assignmentId);
    if (row) sweep(row);
    return attempt && row ? { attempt, row } : null;
  };
  return [
    http.get('/api/todo', () => {
      seed();
      // The viewer's tasks with no workspace come first, as a section with
      // an empty id.
      const workspaces = [
        { iconId: '', id: '', kind: 'personal', name: '' },
        ...db.workspaces,
      ]
        .map((ws) => ({
          iconId: ws.iconId,
          items: [...rows.values()]
            .filter((row) => row.workspaceId === ws.id)
            .map((row) => toAssignment(row, viewer))
            .filter(
              (a) =>
                (a.manage?.toApprove ?? 0) > 0 ||
                (a.mine && !a.draft && !a.closedAt)
            ),
          manages: viewer === 'owner' && ws.kind === 'class',
          name: ws.name,
          workspaceId: ws.id,
        }))
        .filter((ws) => ws.items.length > 0);
      return HttpResponse.json({ workspaces } satisfies TodoList);
    }),
    // The Done tab: done, ticked off or closed, sorted, filtered and paged like
    // the server.
    http.get('/api/todo/done', ({ request }) => {
      seed();
      const search = new URL(request.url).searchParams;
      const list = (key: string) =>
        (search.get(key) ?? '').split(',').filter(Boolean);
      const kinds = list('type').map((t) =>
        t === 'quiz' ? 'marked' : 'unmarked'
      );
      const asc = search.get('dir') === 'asc';
      const at = (a: Assignment) =>
        Date.parse(a.mine?.doneAt ?? a.mine?.checkedAt ?? a.closedAt ?? '') ||
        0;
      const done = [...rows.values()]
        .map((row) => toAssignment(row, viewer))
        .filter(
          (a) =>
            a.mine &&
            !a.draft &&
            (a.mine.done || a.mine.checkedOff || a.closedAt) &&
            (kinds.length === 0 || kinds.includes(a.kind)) &&
            at(a) > (todoHidden.get(a.id) ?? -1)
        )
        .sort((a, b) => (asc ? 1 : -1) * (at(a) - at(b)));
      const offset = Number(search.get('cursor') ?? 0);
      const page = done.slice(offset, offset + 30);
      const workspaces: TodoWorkspace[] = [];
      for (const a of page) {
        let ws = workspaces.find((w) => w.workspaceId === a.workspaceId);
        if (!ws) {
          const source = db.workspaces.find((w) => w.id === a.workspaceId);
          ws = {
            iconId: source?.iconId ?? '',
            items: [],
            manages: viewer === 'owner' && source?.kind === 'class',
            name: source?.name ?? '',
            workspaceId: a.workspaceId,
          };
          workspaces.push(ws);
        }
        ws.items.push(a);
      }
      return HttpResponse.json({
        nextCursor: offset + 30 < done.length ? String(offset + 30) : undefined,
        workspaces,
      } satisfies TodoDonePage);
    }),
    http.get('/api/workspaces/:id/assignments', ({ params }) => {
      seed();
      const staff = viewer === 'owner' && isClass(String(params.id));
      const items = [...rows.values()]
        .filter((row) => row.workspaceId === params.id)
        .filter((row) => staff || !row.draft)
        .map((row) => toAssignment(row, viewer))
        .filter((a) => a.manage || a.mine)
        .sort((a, b) => {
          if (a.closed !== b.closed) return a.closed ? 1 : -1;
          if (!a.dueAt) return 1;
          if (!b.dueAt) return -1;
          return Date.parse(a.dueAt) - Date.parse(b.dueAt);
        });
      return HttpResponse.json({
        items,
        members: staff ? viewers(String(params.id)).length : undefined,
      } satisfies AssignmentList);
    }),
    // A task with no workspace: its maker's alone.
    http.post('/api/todo/tasks', async ({ request }) => {
      seed();
      const body = (await request.json()) as AssignmentFormReq;
      const row: Row = {
        allowUploads: false,
        assignAll: false,
        assignees: [],
        attempts: 1,
        draft: false,
        files: [],
        id: newId('as'),
        kind: body.kind,
        latePenaltyPct: 0,
        marking: 'ai_approve' as const,
        noLate: false,
        own: true,
        postedAt: new Date().toISOString(),
        quizId: body.quizId,
        showAnswers: 'closed' as const,
        showGrades: 'automatic' as const,
        shuffle: false,
        title: body.title,
        workspaceId: '',
      };
      applyForm(row, body);
      if (row.kind === 'marked') freeze(row);
      rows.set(row.id, row);
      return HttpResponse.json(toAssignment(row, viewer), { status: 201 });
    }),
    http.post(
      '/api/workspaces/:id/assignments',
      async ({ params, request }) => {
        seed();
        const body = (await request.json()) as AssignmentFormReq;
        const row: Row = {
          allowUploads: false,
          assignAll: true,
          assignees: [],
          attempts: 1,
          draft: body.draft,
          files: [],
          id: newId('as'),
          kind: body.kind,
          latePenaltyPct: 0,
          marking: 'ai_approve' as const,
          noLate: false,
          // From anyone but a class's staff it is a task for themself.
          own: !(viewer === 'owner' && isClass(String(params.id))),
          postedAt: new Date().toISOString(),
          quizId: body.quizId,
          showAnswers: 'closed' as const,
          showGrades: 'automatic' as const,
          shuffle: false,
          title: body.title,
          workspaceId: String(params.id),
        };
        applyForm(row, body);
        if (row.kind === 'marked' && !row.draft) freeze(row);
        rows.set(row.id, row);
        return HttpResponse.json(toAssignment(row, viewer), { status: 201 });
      }
    ),
    http.get('/api/workspaces/:id/sharing-notice', ({ params }) => {
      const ws = db.workspaces.find((w) => w.id === params.id);
      if (viewer !== 'member' || ws?.kind !== 'class' || sharingNoticeSeen)
        return HttpResponse.json({ due: false } satisfies SharingNotice);
      // The name the Dashboard and assignments show as this class's owner.
      return HttpResponse.json({
        due: true,
        owner: { avatarUrl: db.user.avatarUrl, name: db.user.name },
      } satisfies SharingNotice);
    }),
    http.put('/api/workspaces/:id/sharing-notice', () => {
      sharingNoticeSeen = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/api/assignments/:id', ({ params }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      const out = toAssignment(row, viewer);
      return runs(row, viewer) || out.mine ? HttpResponse.json(out) : gone();
    }),
    http.put('/api/assignments/:id', async ({ params, request }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      applyForm(row, (await request.json()) as AssignmentFormReq);
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.delete('/api/assignments/:id', ({ params }) => {
      rows.delete(String(params.id));
      for (const [id, a] of attempts)
        if (a.assignmentId === params.id) attempts.delete(id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/assignments/:id/publish', ({ params }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      if (row.kind === 'marked') freeze(row);
      row.draft = false;
      row.postedAt = new Date().toISOString();
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.post('/api/assignments/:id/republish', ({ params }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      freeze(row);
      row.postedAt = new Date().toISOString();
      // The stream's word to whoever is taking it, as closing has it.
      if (
        [...attempts.values()].some(
          (a) => a.assignmentId === row.id && !a.submittedAt
        )
      )
        window.dispatchEvent(
          new CustomEvent('capy:mock-stream', {
            detail: { assignmentId: row.id, type: 'assignment_republished' },
          })
        );
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.put('/api/assignments/:id/closed', async ({ params, request }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      const { closed } = (await request.json()) as { closed: boolean };
      row.closedAt = closed ? new Date().toISOString() : undefined;
      // Under Do not show the quiz stays held until staff turn it to practice.
      if (closed && (row.own || !answersHeld(row)))
        row.releasedAt ??= new Date().toISOString();
      // The stream's word to whoever is taking it (`publishAssignmentClosed`).
      if (
        closed &&
        [...attempts.values()].some(
          (a) => a.assignmentId === row.id && !a.submittedAt
        )
      )
        window.dispatchEvent(
          new CustomEvent('capy:mock-stream', {
            detail: { assignmentId: row.id, type: 'assignment_closed' },
          })
        );
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.post('/api/assignments/:id/practice', ({ params }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      if (row.own || !closedAtOf(row) || !answersHeld(row))
        return HttpResponse.json(
          { message: "this assignment's quiz is not waiting" },
          { status: 400 }
        );
      row.practiceAt = new Date().toISOString();
      row.releasedAt ??= row.practiceAt;
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.post('/api/assignments/:id/release-grades', ({ params }) => {
      const row = rowOf(params.id);
      if (!row) return gone();
      if (row.showGrades === 'manual')
        row.gradesReleasedAt ??= new Date().toISOString();
      return HttpResponse.json(toAssignment(row, viewer));
    }),
    http.put('/api/assignments/:id/done', async ({ params, request }) => {
      seed();
      const id = String(params.id);
      const body = (await request.json()) as { done: boolean };
      const row = rowOf(id);
      if (row && isClosed(row))
        return HttpResponse.json(
          { code: 'assignment_closed', message: 'this assignment is closed' },
          { status: 409 }
        );
      // A quiz is done when it is submitted.
      if (row?.kind === 'marked')
        return new HttpResponse(null, { status: 400 });
      if (row?.allowUploads && row.kind === 'unmarked') {
        const open = body.done ? handInOpen(id) : done.get(id)?.has(db.user.id);
        if (!open || (body.done && !handInOf(id, db.user.id).length))
          return HttpResponse.json(
            {
              code: 'hand_in_closed',
              message: 'this assignment no longer takes your files',
            },
            { status: 409 }
          );
      }
      const ticks = done.get(id) ?? new Map<string, string>();
      if (body.done) ticks.set(db.user.id, new Date().toISOString());
      else ticks.delete(db.user.id);
      done.set(id, ticks);
      return new HttpResponse(null, { status: 204 });
    }),
    // Off the caller's Done tab; nothing else changes.
    http.post('/api/todo/done/hide', async ({ request }) => {
      seed();
      const { ids } = (await request.json()) as { ids: string[] };
      for (const id of ids) todoHidden.set(id, Date.now());
      return new HttpResponse(null, { status: 204 });
    }),
    // A To do tick that isn't the work: nothing is submitted or handed in.
    http.put('/api/assignments/:id/todo-check', async ({ params, request }) => {
      seed();
      const row = rowOf(params.id);
      if (!row) return gone();
      const body = (await request.json()) as {
        approvals?: boolean;
        checked: boolean;
      };
      const side = body.approvals ? 'approvals' : 'work';
      const ticks = todoChecks.get(row.id) ?? {};
      ticks[side] = body.checked ? new Date().toISOString() : undefined;
      todoChecks.set(row.id, ticks);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/assignments/:id/start', async ({ params, request }) => {
      const { upload } = (await request.json().catch(() => ({}))) as {
        upload?: boolean;
      };
      const row = rowOf(params.id);
      if (!row) return gone();
      sweep(row);
      const running = [...attempts.values()].find(
        (a) =>
          a.assignmentId === row.id && a.userId === db.user.id && !a.submittedAt
      );
      if (running) return HttpResponse.json(attemptView(running, row, viewer));
      if (closedAtOf(row))
        return conflict('assignment_closed', 'This assignment is closed.');
      const used = [...attempts.values()].filter(
        (a) => a.assignmentId === row.id && a.userId === db.user.id
      ).length;
      if (used >= row.attempts)
        return conflict('assignment_no_attempts', 'No attempts are left.');
      const attempt: Attempt = {
        answers: {},
        assignmentId: row.id,
        autoSubmitted: false,
        deadlineAt: row.timeLimitMin
          ? new Date(Date.now() + row.timeLimitMin * 60_000).toISOString()
          : undefined,
        graded: [],
        id: newId('at'),
        ...(upload && row.allowUploads
          ? { paper: 'upload' as const, paperFiles: [] }
          : {}),
        startedAt: new Date().toISOString(),
        userId: db.user.id,
      };
      attempts.set(attempt.id, attempt);
      return HttpResponse.json(attemptView(attempt, row, viewer));
    }),
    // The AI's mark on every waiting part: full marks on its first point only.
    http.post('/api/assignments/:id/mark-with-ai', ({ params }) => {
      const row = rowOf(params.id);
      if (!row || !runs(row, viewer)) return gone();
      let total = 0;
      for (const attempt of attempts.values()) {
        if (attempt.assignmentId !== params.id) continue;
        for (const q of attempt.graded)
          for (const part of q.parts) {
            if (!part.pending || part.aiAwards) continue;
            part.aiAwards = (part.markscheme ?? []).map((item, i) =>
              i === 0 ? item.marks : 0
            );
            delete part.aiError;
            part.aiComment = 'Offered two answers for one point.';
            total++;
          }
      }
      return HttpResponse.json({ total });
    }),
    http.post(
      '/api/assignments/:id/approve-ai-marks',
      async ({ params, request }) => {
        const row = rowOf(params.id);
        if (!row || !runs(row, viewer)) return gone();
        const { questionId } = (await request.json()) as {
          questionId: string;
        };
        let approved = 0;
        for (const attempt of attempts.values()) {
          if (attempt.assignmentId !== params.id) continue;
          const q = attempt.graded.find((g) => g.id === questionId);
          if (!q?.parts.some((p) => p.pending) || !aiRow(q).aiMarked) continue;
          q.parts = q.parts.map((part) => {
            if (!part.pending) return part;
            const { pending: _, ...rest } = part;
            const items = part.aiAwards ?? [];
            return {
              ...rest,
              awarded: items.reduce((sum, v) => sum + v, 0),
              itemAwards: items,
              markedBy: db.user.id,
            };
          });
          approved++;
        }
        return HttpResponse.json({ approved });
      }
    ),
    http.get('/api/assignments/:id/report', ({ params }) => {
      const row = rowOf(params.id);
      if (!row || !runs(row, viewer)) return gone();
      return HttpResponse.json(report(row, viewer));
    }),
    http.get('/api/assignment-attempts/:id', ({ params }) => {
      const found = attemptOf(params.id);
      if (!found) return gone();
      return HttpResponse.json(attemptView(found.attempt, found.row, viewer));
    }),
    http.put(
      '/api/assignment-attempts/:id/answers',
      async ({ params, request }) => {
        const found = attemptOf(params.id);
        if (!found) return gone();
        if (found.attempt.submittedAt)
          return conflict(
            'attempt_finished',
            'This attempt has been submitted.'
          );
        const { answers } = (await request.json()) as { answers: Answers };
        found.attempt.answers = answers;
        return new HttpResponse(null, { status: 204 });
      }
    ),
    // Done stores a drawing part's board (and image); its answer is the id.
    http.put(
      '/api/assignment-attempts/:id/drawings/:partId',
      async ({ params, request }) => {
        const found = attemptOf(params.id);
        if (!found) return gone();
        if (found.attempt.submittedAt)
          return conflict(
            'attempt_finished',
            'This attempt has been submitted.'
          );
        const body = (await request.json()) as {
          board: string;
          pictures?: { data: string; sourceId: string }[];
        };
        const id = `dr_${String(params.partId)}_${Date.now()}`;
        mockDrawings.set(id, body.board);
        mockDrawingPictures.set(id, body.pictures ?? []);
        return HttpResponse.json({ id });
      }
    ),
    http.delete(
      '/api/assignment-attempts/:id/drawings/:partId',
      ({ params }) => {
        const found = attemptOf(params.id);
        if (!found) return gone();
        delete found.attempt.answers[String(params.partId)];
        return new HttpResponse(null, { status: 204 });
      }
    ),
    http.get('/api/drawings', () =>
      HttpResponse.json({
        count: markedDrawings.length,
        items: markedDrawings,
        totalBytes: markedDrawings.reduce((sum, d) => sum + d.bytes, 0),
      })
    ),
    http.delete('/api/drawings/:id', ({ params }) => {
      const i = markedDrawings.findIndex((d) => d.id === params.id);
      if (i < 0) return gone();
      markedDrawings.splice(i, 1);
      mockDrawings.delete(String(params.id));
      return HttpResponse.json({ deleted: 1 });
    }),
    http.delete('/api/drawings', () => {
      const deleted = markedDrawings.length;
      for (const d of markedDrawings.splice(0)) mockDrawings.delete(d.id);
      return HttpResponse.json({ deleted });
    }),
    http.get('/api/drawings/:id', async ({ params }) => {
      const board = mockDrawings.get(String(params.id));
      if (board === undefined) return gone();
      // Stored gzipped, as drawings.go stores it.
      const packed = await new Response(
        new Blob([fromBase64(board) as Uint8Array<ArrayBuffer>])
          .stream()
          .pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer();
      return HttpResponse.json({
        boardUrl: `data:application/gzip;base64,${toBase64(new Uint8Array(packed))}`,
        bytes: board.length,
        id: params.id,
        partId: '',
        // Each as a link, as the gateway's presigned ones are.
        pictures: (mockDrawingPictures.get(String(params.id)) ?? []).map(
          ({ data, sourceId }) => ({
            sourceId,
            url: `data:${pictureType(data)};base64,${data}`,
          })
        ),
      });
    }),
    http.delete('/api/assignment-attempts/:id/paper/:fileId', ({ params }) => {
      const found = attemptOf(params.id);
      if (found?.attempt.paper !== 'upload') return gone();
      found.attempt.paperFiles = (found.attempt.paperFiles ?? []).filter(
        (f) => f.id !== params.fileId
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(
      '/api/assignment-attempts/:id/paper/order',
      async ({ params, request }) => {
        const found = attemptOf(params.id);
        if (found?.attempt.paper !== 'upload') return gone();
        const { fileIds } = (await request.json()) as { fileIds: string[] };
        const files = found.attempt.paperFiles ?? [];
        found.attempt.paperFiles = fileIds.flatMap((id) =>
          files.filter((f) => f.id === id)
        );
        return new HttpResponse(null, { status: 204 });
      }
    ),
    http.get(
      '/api/assignment-attempts/:id/paper/:fileId/links',
      ({ params }) => {
        const url = paperUrls.get(String(params.fileId)) ?? SCAN;
        return HttpResponse.json({
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          url,
        });
      }
    ),
    http.delete('/api/assignments/:id/hand-in/:fileId', ({ params }) => {
      const id = String(params.id);
      if (!handInOpen(id)) return gone();
      setHandIn(
        id,
        db.user.id,
        handInOf(id, db.user.id).filter((f) => f.id !== params.fileId)
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/api/assignments/:id/hand-in/:fileId/links', ({ params }) =>
      HttpResponse.json({
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        url: paperUrls.get(String(params.fileId)) ?? SCAN,
      })
    ),
    http.delete('/api/papers/:id', ({ params }) => {
      for (const a of attempts.values())
        a.paperFiles = a.paperFiles?.filter((f) => f.id !== params.id);
      for (const [assignmentId] of handIns)
        setHandIn(
          assignmentId,
          db.user.id,
          handInOf(assignmentId, db.user.id).filter((f) => f.id !== params.id)
        );
      return HttpResponse.json({ deleted: 1 });
    }),
    http.post(
      '/api/assignment-attempts/:id/submit',
      async ({ params, request }) => {
        const found = attemptOf(params.id);
        if (!found) return gone();
        if (!found.attempt.submittedAt) {
          const { answers } = (await request.json()) as { answers: Answers };
          finish(found.row, found.attempt, answers, false);
        }
        return HttpResponse.json(attemptView(found.attempt, found.row, viewer));
      }
    ),
    http.post(
      '/api/assignment-attempts/:id/marks',
      async ({ params, request }) => {
        const found = attemptOf(params.id);
        if (!found || !runs(found.row, viewer)) return gone();
        const mark = (await request.json()) as AssignmentMark;
        const question = found.attempt.graded.find(
          (q) => q.id === mark.questionId
        );
        if (!question) return gone();
        if (mark.clearWarning)
          question.parts = question.parts.map(
            ({ aiComment: _c, aiFlag: _f, ...part }) => part
          );
        if (mark.clearWarning && !mark.parts.length)
          return HttpResponse.json(
            attemptView(found.attempt, found.row, viewer)
          );
        question.parts = question.parts.map((part) => {
          const change = mark.parts.find((p) => p.partId === part.id);
          if (!change) return part;
          const { pending: _, ...rest } = part;
          return change.items
            ? {
                ...rest,
                awarded: change.items.reduce((sum, v) => sum + v, 0),
                itemAwards: change.items,
                markedBy: db.user.id,
              }
            : { ...rest, awarded: change.mark ?? 0, markedBy: db.user.id };
        });
        question.comment = mark.comment || undefined;
        question.commentBy = mark.comment ? db.user.id : undefined;
        question.commentByName = mark.comment ? db.user.name : undefined;
        question.commentByAvatarUrl = mark.comment
          ? db.user.avatarUrl
          : undefined;
        return HttpResponse.json(attemptView(found.attempt, found.row, viewer));
      }
    ),
  ];
};
