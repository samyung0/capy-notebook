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
  MaterialRef,
  SharingNotice,
  TodoList,
  WorkspaceActivity,
} from '@/api/types';
import type { Question, QuestionPart } from '@/features/questions/types';
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
  kind: 'marked' | 'unmarked';
  title: string;
  quizId?: string;
  questions?: Question[];
  dueAt?: string;
  postedAt: string;
  closedAt?: string;
  releasedAt?: string;
  timeLimitMin?: number;
  attempts: number;
  noLate: boolean;
  latePenaltyPct: number;
  assignAll: boolean;
  assignees: string[];
  draft: boolean;
  approveAiMarks: boolean;
  showAnswers: boolean;
  shuffle: boolean;
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
};

const WS = 'ws_bio';
const ASSIGNMENT_GRACE_MS = 15_000;
const DAY = 86_400_000;
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
    approveAiMarks: true,
    assignAll: true,
    assignees: [],
    attempts: 1,
    draft: false,
    files: [],
    latePenaltyPct: 0,
    noLate: false,
    showAnswers: true,
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
    {
      ...common,
      dueAt: at(6),
      id: 'as_inheritance',
      kind: 'marked',
      postedAt: at(0, 9),
      questions: worksheet(9),
      title: 'Inheritance worksheet',
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
}

/** Who ticked an unmarked assignment, and when. */
const done = new Map<string, Map<string, string>>();

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

const isClosed = (row: Row) =>
  !!closedAtOf(row) || (row.kind === 'unmarked' && pastDue(row));

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
      // The Member scenario's viewer is in the class.
      ...(row.assignAll && viewer === 'member' ? [db.user.id] : []),
    ]),
  ];
};

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
}

function toAssignment(row: Row, viewer: Viewer): Assignment {
  sweep(row);
  const staff = viewer === 'owner';
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
  return {
    attempts: row.attempts,
    closed: isClosed(row),
    closedAt: closedAtOf(row),
    draft: row.draft,
    dueAt: row.dueAt,
    files: row.files.flatMap((f): Assignment['files'] => {
      const file = db.files.find((x) => x.id === f.fileId);
      const mt = db.materials.find((x) => x.id === f.materialId);
      if (file) return [{ fileId: file.id, kind: file.kind, name: file.name }];
      if (mt) return [{ kind: mt.kind, materialId: mt.id, name: mt.title }];
      return [];
    }),
    id: row.id,
    kind: row.kind,
    latePenaltyPct: row.latePenaltyPct,
    marks,
    noLate: row.noLate,
    postedAt: row.postedAt,
    postedBy: db.user.name,
    practiceQuizId: row.releasedAt ? row.quizId : undefined,
    questions: questions.length,
    timeLimitMin: row.timeLimitMin,
    title: row.title,
    topicIds,
    workspaceId: row.workspaceId,
    ...(staff
      ? {
          manage: {
            approveAiMarks: row.approveAiMarks,
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
            quizId: row.quizId,
            quizTitle: material?.title,
            showAnswers: row.showAnswers,
            shuffle: row.shuffle,
            toApprove: assigned
              .flatMap((id) => submissions(row.id, id))
              .reduce((sum, a) => sum + totals(a.graded).waitingAnswers, 0),
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
            correct: myTotals?.correct,
            countedAttemptId: mine?.id,
            done: !!mine || !!tick,
            doneAt: mine?.submittedAt ?? tick,
            late: isLate(row, mine?.submittedAt),
            latePenaltyPct: penaltyOf(row, mine?.submittedAt),
            mark:
              myTotals &&
              penalised(myTotals.correct, penaltyOf(row, mine?.submittedAt)),
            missing:
              row.kind === 'marked' &&
              !mine &&
              !!row.dueAt &&
              Date.parse(row.dueAt) <= Date.now(),
            runningAttemptId: running?.id,
            total: myTotals?.total,
            waitingAnswers: myTotals?.waitingAnswers ?? 0,
            waitingMarks: myTotals?.waitingMarks ?? 0,
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
    deadlineAt: attempt.deadlineAt,
    id: attempt.id,
    late: isLate(row, attempt.submittedAt),
    latePenaltyPct: penaltyOf(row, attempt.submittedAt),
    now: new Date().toISOString(),
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
      mark: 0,
      questions: (row.questions ?? []).map(learnerView),
      showAnswers: false,
      status: 'running' as const,
      total: 0,
      waitingAnswers: 0,
      waitingMarks: 0,
    } satisfies AssignmentAttempt;
  const show = viewer === 'owner' || row.showAnswers;
  return {
    ...common,
    ...totals(attempt.graded),
    answers: attempt.answers,
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
        late: isLate(row, a?.submittedAt),
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
      const isOpen = question.parts.some((p) => p.answer.type === 'open');
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
  return { answers, members, questions };
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
  row.approveAiMarks = body.approveAiMarks;
  row.showAnswers = body.showAnswers;
  row.shuffle = body.shuffle;
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
  return [...rows.values()]
    .filter((row) => row.workspaceId === workspaceId && !row.draft)
    .map((row) => ({
      assignmentId: row.id,
      at: row.postedAt,
      kind: 'assigned' as const,
      title: row.title,
    }));
}

/** When the assignment that made this quiz practice closed (board P1). */
export function assignmentClosedAt(quizId: string) {
  seed();
  const row = [...rows.values()].find(
    (r) => r.quizId === quizId && r.releasedAt
  );
  return row && (closedAtOf(row) ?? row.releasedAt);
}

/** A quiz row's fields for this viewer, as the server's lists read them: the icon
 * while it is under an open assignment, and for an assignee what the row opens. */
export function quizAssignmentFields(quizId: string, viewer: Viewer) {
  seed();
  const open = [...rows.values()].filter(
    (r) => r.quizId === quizId && !r.draft && !closedAtOf(r)
  );
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
    items: page.items.map((item) =>
      item.material
        ? {
            ...item,
            material: {
              ...item.material,
              ...quizAssignmentFields(item.material.id, viewer),
            },
          }
        : item
    ),
  };
}

/** A workspace's rows for this viewer: a member lists a hidden quiz only while it
 * is assigned to them. */
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
    .filter((ref) => viewer === 'owner' || !ref.hidden || ref.assignmentId)
    // An assignee isn't told it is hidden from others.
    .map((ref) => (ref.assignmentId ? { ...ref, hidden: false } : ref))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return refs;
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
      const workspaces = db.workspaces
        .filter((ws) => ws.kind === 'class')
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
          manages: viewer === 'owner',
          name: ws.name,
          workspaceId: ws.id,
        }))
        .filter((ws) => ws.items.length > 0);
      return HttpResponse.json({ workspaces } satisfies TodoList);
    }),
    http.get('/api/workspaces/:id/assignments', ({ params }) => {
      seed();
      const ws = db.workspaces.find((w) => w.id === params.id);
      if (ws?.kind !== 'class') return gone();
      const items = [...rows.values()]
        .filter((row) => row.workspaceId === params.id)
        .filter((row) => viewer === 'owner' || !row.draft)
        .map((row) => toAssignment(row, viewer))
        .filter((a) => viewer === 'owner' || a.mine)
        .sort((a, b) => {
          if (a.closed !== b.closed) return a.closed ? 1 : -1;
          if (!a.dueAt) return 1;
          if (!b.dueAt) return -1;
          return Date.parse(a.dueAt) - Date.parse(b.dueAt);
        });
      return HttpResponse.json({
        items,
        members:
          viewer === 'owner' ? viewers(String(params.id)).length : undefined,
      } satisfies AssignmentList);
    }),
    http.post(
      '/api/workspaces/:id/assignments',
      async ({ params, request }) => {
        seed();
        const body = (await request.json()) as AssignmentFormReq;
        const row: Row = {
          approveAiMarks: true,
          assignAll: true,
          assignees: [],
          attempts: 1,
          draft: body.draft,
          files: [],
          id: newId('as'),
          kind: body.kind,
          latePenaltyPct: 0,
          noLate: false,
          postedAt: new Date().toISOString(),
          quizId: body.quizId,
          showAnswers: true,
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
      return viewer === 'owner' || out.mine ? HttpResponse.json(out) : gone();
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
      if (closed) row.releasedAt ??= new Date().toISOString();
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
    http.put('/api/assignments/:id/done', async ({ params, request }) => {
      seed();
      const id = String(params.id);
      const body = (await request.json()) as { done: boolean };
      const ticks = done.get(id) ?? new Map<string, string>();
      if (body.done) ticks.set(db.user.id, new Date().toISOString());
      else ticks.delete(db.user.id);
      done.set(id, ticks);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/assignments/:id/start', ({ params }) => {
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
        startedAt: new Date().toISOString(),
        userId: db.user.id,
      };
      attempts.set(attempt.id, attempt);
      return HttpResponse.json(attemptView(attempt, row, viewer));
    }),
    http.get('/api/assignments/:id/report', ({ params }) => {
      const row = rowOf(params.id);
      if (!row || viewer !== 'owner') return gone();
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
        if (!found || viewer !== 'owner') return gone();
        const mark = (await request.json()) as AssignmentMark;
        const question = found.attempt.graded.find(
          (q) => q.id === mark.questionId
        );
        if (!question) return gone();
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
