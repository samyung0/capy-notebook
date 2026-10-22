import { HttpResponse, http } from 'msw';
import type {
  ItemAttempts,
  PastReview,
  PlanStep,
  ProgressWorkspace,
  ReviewAnswer,
  ReviewItem,
  ReviewMode,
  ReviewSessionRef,
  ReviewSuggestion,
  StudySummary,
} from '@/api/types';
import { parseFlashcardsBlock } from '@/features/materials/blocks';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { gradeQuestions, learnerView } from './answerKeys';
import * as db from './db';

/* Study progress and review, per signed-in user (the mock has one). A
 * rating is remembered with its lapses; there is no FSRS here, so "least
 * retained" is most lapses, then oldest. */

type State = 'started' | 'done' | 'removed';
type Rated = { lapses: number; at: number };

const progress = new Map<
  string,
  Map<string, { kind: 'file' | 'material'; state: State; at: number }>
>();
const enabled = new Map<string, boolean>();
/** The last progress write per workspace, for Learning's Progress order. */
const studiedAt = new Map<string, number>();
const rated = new Map<string, Rated>(); // `${materialId}/${itemId}`

function items(wsId: string) {
  let map = progress.get(wsId);
  if (!map) {
    map = new Map();
    progress.set(wsId, map);
  }
  return map;
}

// Biology 101 opens with some history, as in the mocks.
items('ws_bio').set('f_1', {
  at: Date.now() - 9 * 86_400_000,
  kind: 'file',
  state: 'done',
});
items('ws_bio').set('f_2', {
  at: Date.now() - 9 * 86_400_000,
  kind: 'file',
  state: 'done',
});
items('ws_bio').set('qz_1', {
  at: Date.now() - 5 * 86_400_000,
  kind: 'material',
  state: 'done',
});
items('ws_bio').set('dk_1', {
  at: Date.now() - 1 * 86_400_000,
  kind: 'material',
  state: 'started',
});
for (const [card, lapses] of [
  ['c_4', 2],
  ['c_7', 1],
  ['c_1', 0],
] as const)
  rated.set(`dk_1/${card}`, { at: Date.now() - lapses * 3_600_000, lapses });
// Missed quiz questions, so a session and Quick review have questions to
// check too: a short answer, gaps, and true/false under a chart.
rated.set('qz_1/q4', { at: Date.now() - 7_200_000, lapses: 1 });
rated.set('qz_1/q15', { at: Date.now() - 5_400_000, lapses: 1 });
rated.set('qz_1/q12', { at: Date.now() - 3_600_000, lapses: 1 });
// Calculus started yesterday; World History is finished on first read (below).
items('ws_calc').set('f_6', {
  at: Date.now() - 1 * 86_400_000,
  kind: 'file',
  state: 'done',
});
// A twice-missed ordering question: Calculus has a review but no Quick review.
items('ws_calc').set('qz_3', {
  at: Date.now() - 1 * 86_400_000,
  kind: 'material',
  state: 'started',
});
rated.set('qz_3/q29', { at: Date.now() - 86_400_000, lapses: 2 });
studiedAt.set('ws_bio', Date.now() - 3_600_000);
studiedAt.set('ws_calc', Date.now() - 86_400_000);
studiedAt.set('ws_hist', Date.now() - 3 * 86_400_000);
let historyFinished = false;

/** Adds a card's rating to its flashcard attempt, as the server does: cards
 * in first-rated order with every rating, scored by first ratings of Good or
 * Easy; only a workspace set records one. */
function recordCard(
  ref: { id: string; startedAt: string },
  setId: string,
  cardId: string,
  rating: number,
  at = new Date().toISOString()
) {
  const mt = db.materials.find((x) => x.id === setId);
  if (!mt?.workspaceId || mt.parentMaterialId) return;
  let attempt = db.attempts.find((a) => a.id === ref.id);
  if (!attempt) {
    attempt = {
      cards: [],
      chapters: [],
      correct: 0,
      id: ref.id,
      kind: 'flashcards',
      materialId: setId,
      pct: 0,
      quizName: mt.title,
      startedAt: ref.startedAt,
      takenAt: at,
      total: 0,
      workspaceId: mt.workspaceId,
      workspaceName: mt.workspaceName ?? '',
    };
    db.attempts.unshift(attempt);
  }
  attempt.cards ??= [];
  const card = attempt.cards.find((c) => c.id === cardId);
  if (card) card.ratings.push(rating);
  else {
    const face = db.cardsFromMaterial(mt).find((c) => c.id === cardId);
    attempt.cards.push({
      back: face?.back ?? '',
      front: face?.front ?? '',
      id: cardId,
      ratings: [rating],
    });
  }
  attempt.total = attempt.cards.length;
  attempt.correct = attempt.cards.filter((c) => c.ratings[0] >= 3).length;
  attempt.pct = Math.round((attempt.correct / attempt.total) * 100);
  attempt.takenAt = at;
}

// Cell organelles has three past attempts, the latest left before its end.
{
  const set = db.materials.find((x) => x.id === 'dk_1');
  const ids = set ? db.cardsFromMaterial(set).map((c) => c.id) : [];
  const runs: [number, number, number[]][] = [
    [6, 11, [3, 2, 4, 3, 1, 3]],
    [3, 9, [3, 3, 4, 2, 3, 4]],
    [1, 6, [4, 3, 1, 3]],
  ];
  for (const [ago, minutes, ratings] of runs) {
    const end = new Date(Date.now() - ago * 86_400_000).toISOString();
    const ref = {
      // Stable, so a result link survives a reload.
      id: `fa_dk_1_${ago}`,
      startedAt: new Date(Date.parse(end) - minutes * 60_000).toISOString(),
    };
    ratings.forEach((rating, i) => {
      if (ids[i]) recordCard(ref, 'dk_1', ids[i], rating, end);
    });
  }
}

/** A workspace's tracked items for Learning's map: untrashed files and
 * non-embedded materials, minus the ones the user stopped tracking. */
function tracked(wsId: string) {
  const states = items(wsId);
  return [
    ...db.files
      .filter((f) => f.workspaceId === wsId)
      .map((f) => ({
        chapterId: f.chapterId,
        createdAt: f.addedAt,
        id: f.id,
        position: f.position,
        title: f.name,
        type: 'file' as const,
      })),
    ...db.materials
      .filter((mt) => mt.workspaceId === wsId && !mt.parentMaterialId)
      .map((mt) => ({
        chapterId: mt.chapterId ?? null,
        createdAt: mt.createdAt,
        id: mt.id,
        position: mt.position,
        title: mt.title,
        type: 'material' as const,
      })),
  ]
    .map((it) => ({ ...it, state: states.get(it.id)?.state }))
    .filter((it) => it.state !== 'removed');
}

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
/** Progress rows only, so Learning's lists show a realistic spread: no items
 * behind them (Organic Chemistry and English Literature open their real,
 * empty workspaces; the others have no workspace in the mock). */
const SHOWCASE: ProgressWorkspace[] = [
  {
    cover: { color: '#eb6834', pattern: 'hexagons', style: 'geo' },
    done: 2,
    iconId: 'waves-04',
    lastStudiedAt: daysAgo(2),
    name: 'Organic Chemistry',
    total: 26,
    workspaceId: 'ws_chem',
  },
  {
    cover: {
      color: '#f8efc9',
      kind: 'latin',
      style: 'paper',
    },
    done: 8,
    iconId: 'waves-05',
    lastStudiedAt: daysAgo(4),
    name: 'English Literature',
    total: 12,
    workspaceId: 'ws_eng',
  },
  {
    cover: {
      color: '#d0505e',
      kind: 'math',
      style: 'symbols',
    },
    done: 11,
    iconId: 'waves-06',
    lastStudiedAt: daysAgo(6),
    name: 'Physics: mechanics',
    total: 20,
    workspaceId: 'ws_demo_physics',
  },
  {
    done: 3,
    iconId: 'waves-07',
    lastStudiedAt: daysAgo(9),
    name: 'Spanish A2',
    total: 30,
    workspaceId: 'ws_demo_spanish2',
  },
  {
    cover: {
      color: '#c48a00',
      kind: 'math',
      style: 'doodles',
    },
    done: 14,
    iconId: 'waves-08',
    lastStudiedAt: daysAgo(12),
    name: 'Statistics',
    total: 18,
    workspaceId: 'ws_demo_stats',
  },
  {
    cover: { color: '#1b9e6f', pattern: 'xes', style: 'geo' },
    done: 15,
    iconId: 'waves-09',
    lastStudiedAt: daysAgo(9),
    name: 'Chemistry basics',
    total: 15,
    workspaceId: 'ws_demo_chem0',
  },
  {
    cover: {
      color: '#d0505e',
      kind: 'kana',
      style: 'symbols',
    },
    done: 20,
    iconId: 'waves-10',
    lastStudiedAt: daysAgo(30),
    name: 'Spanish A1',
    total: 20,
    workspaceId: 'ws_demo_spanish1',
  },
  {
    cover: {
      color: '#2a78d6',
      kind: 'math',
      style: 'symbols',
    },
    done: 24,
    iconId: 'waves-11',
    lastStudiedAt: daysAgo(40),
    name: 'Linear algebra',
    total: 24,
    workspaceId: 'ws_demo_linalg',
  },
  {
    cover: { color: '#fbf9f3', kind: 'kana', style: 'paper' },
    done: 8,
    iconId: 'waves-02',
    lastStudiedAt: daysAgo(60),
    name: 'Essay writing',
    total: 8,
    workspaceId: 'ws_demo_essay',
  },
  {
    done: 12,
    iconId: 'waves-03',
    lastStudiedAt: daysAgo(75),
    name: 'Art history',
    total: 12,
    workspaceId: 'ws_demo_art',
  },
];

/** As the server: `lead` (a listed workspace) leads the map, else the first
 * in progress, else the first finished; showcase rows have no items to map. */
type MockPlanStep = {
  kind: PlanStep['kind'];
  workspaceId: string;
  targetId?: string;
};
type MockPlan = {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  steps: MockPlanStep[];
};

/** A seeded plan in Biology reaching into Chemistry, as a plan does. */
const plans: MockPlan[] = [
  {
    createdAt: daysAgo(5),
    id: 'plan_winter',
    name: 'Winter exams',
    steps: [
      ...db.chapters
        .filter((ch) => ch.workspaceId === 'ws_bio')
        .sort((a, b) => a.order - b.order)
        .slice(0, 2)
        .map((ch) => ({
          kind: 'chapter' as const,
          targetId: ch.id,
          workspaceId: 'ws_bio',
        })),
      { kind: 'workspace', workspaceId: 'ws_chem' },
    ],
    updatedAt: daysAgo(1),
    workspaceId: 'ws_bio',
  },
];

function stepTitle(step: MockPlanStep) {
  if (step.kind === 'chapter')
    return db.chapters.find((ch) => ch.id === step.targetId)?.name ?? '';
  if (step.kind === 'file')
    return db.files.find((f) => f.id === step.targetId)?.name ?? '';
  if (step.kind === 'material')
    return db.materials.find((mt) => mt.id === step.targetId)?.title ?? '';
  return db.workspaces.find((w) => w.id === step.workspaceId)?.name ?? '';
}

/** The plans response: steps with titles, every named workspace once. */
function studyPlans(list: MockPlan[]) {
  const ids = [
    ...new Set(
      list.flatMap((p) => [
        p.workspaceId,
        ...p.steps.map((st) => st.workspaceId),
      ])
    ),
  ];
  return {
    plans: list.map((p) => ({
      ...p,
      steps: p.steps.map((st) => ({
        ...st,
        locked: false,
        title: stepTitle(st),
      })),
    })),
    workspaces: ids.map((wsId) => {
      const ws = db.workspaces.find((w) => w.id === wsId);
      return {
        chapters: db.chapters
          .filter((ch) => ch.workspaceId === wsId)
          .map((ch) => ({ id: ch.id, name: ch.name, order: ch.order })),
        cover: ws?.cover,
        hidden: !(enabled.get(wsId) ?? true),
        iconId: ws?.iconId ?? '',
        items: tracked(wsId).map(({ state, ...it }) => ({
          ...it,
          ...(state ? { state } : {}),
        })),
        name: ws?.name ?? wsId,
        workspaceId: wsId,
      };
    }),
  };
}

function learningProgress(leadId: string | null, all = false) {
  if (!historyFinished) {
    historyFinished = true;
    for (const it of tracked('ws_hist'))
      items('ws_hist').set(it.id, {
        at: Date.now() - 3 * 86_400_000,
        kind: it.type,
        state: 'done',
      });
  }
  const rows: ProgressWorkspace[] = [...progress.keys()]
    .filter(
      (wsId) =>
        (all || (enabled.get(wsId) ?? true)) &&
        [...items(wsId).values()].some((it) => it.state !== 'removed')
    )
    .map((wsId) => {
      const ws = db.workspaces.find((w) => w.id === wsId);
      const list = tracked(wsId);
      return {
        cover: ws?.cover,
        done: list.filter((it) => it.state === 'done').length,
        hidden: !(enabled.get(wsId) ?? true),
        iconId: ws?.iconId ?? '',
        lastStudiedAt: new Date(studiedAt.get(wsId) ?? 0).toISOString(),
        name: ws?.name ?? wsId,
        total: list.length,
        workspaceId: wsId,
      };
    })
    .filter((ws) => ws.total > 0);
  rows.push(
    ...SHOWCASE.filter(
      (ws) =>
        !rows.some((r) => r.workspaceId === ws.workspaceId) &&
        (all || (enabled.get(ws.workspaceId) ?? true))
    ).map((ws) => ({ ...ws, hidden: !(enabled.get(ws.workspaceId) ?? true) }))
  );
  rows.sort((a, b) => b.lastStudiedAt.localeCompare(a.lastStudiedAt));
  const active = rows.filter((ws) => ws.done < ws.total).slice(0, 10);
  const finished = rows.filter((ws) => ws.done >= ws.total).slice(0, 10);
  const mapped = [...active, ...finished]
    .filter((ws) => !ws.hidden)
    .map((ws) => ws.workspaceId)
    .filter((id) => progress.has(id));
  const lead = mapped.find((id) => id === leadId) ?? mapped[0];
  return {
    active,
    finished,
    lead: lead && {
      chapters: db.chapters
        .filter((ch) => ch.workspaceId === lead)
        .map((ch) => ({ id: ch.id, name: ch.name, order: ch.order })),
      items: tracked(lead).map(({ state, ...it }) => ({
        ...it,
        ...(state ? { state } : {}),
      })),
      workspaceId: lead,
    },
  };
}

function cardsOf(materialId: string) {
  const mt = db.materials.find((x) => x.id === materialId);
  if (mt?.kind !== 'flashcards') return [];
  return typeof mt.content === 'string'
    ? parseFlashcardsBlock(mt.content).cards
    : flashcardsElementToCards(
        mt.content.value.find(
          (node) => node.type === 'flashcards'
        ) as FlashcardsElement
      );
}

/** Rated items of the quizzes and sets in progress, least retained first. */
function pool(wsId: string): ReviewItem[] {
  const out: (ReviewItem & { rank: Rated })[] = [];
  for (const [id, it] of items(wsId)) {
    if (it.kind !== 'material' || it.state === 'removed') continue;
    const mt = db.materials.find((x) => x.id === id);
    if (!mt) continue;
    if (mt.kind === 'flashcards')
      for (const card of cardsOf(id)) {
        const rank = rated.get(`${id}/${card.id}`);
        if (rank)
          out.push({
            back: card.back,
            front: card.front,
            ...(card.image ? { image: card.image } : {}),
            itemId: card.id,
            kind: 'card',
            materialId: id,
            materialTitle: mt.title,
            rank,
          });
      }
    if (mt.kind === 'quiz')
      for (const question of db.quizFromMaterial(mt).questions) {
        const rank = rated.get(`${id}/${question.id}`);
        if (rank)
          out.push({
            itemId: question.id,
            kind: 'question',
            materialId: id,
            materialTitle: mt.title,
            // Questions come without their key; checking one returns it.
            question: learnerView(question),
            rank,
          });
      }
  }
  return out
    .sort((a, b) => b.rank.lapses - a.rank.lapses || a.rank.at - b.rank.at)
    .map(({ rank: _, ...item }) => item);
}

const QUICK_ANSWERS = ['mcq', 'boolean', 'short', 'gaps'];

/** The server ranks cards and single-part quick questions by suggestion
 * score among fading ones; the mock has no recall, so the most-missed items
 * lead, up to four. */
function quickReview(all: ReviewItem[]): ReviewItem[] {
  return all
    .filter(
      (it) =>
        (it.kind === 'card' ||
          (it.question?.parts.length === 1 &&
            QUICK_ANSWERS.includes(it.question.parts[0].answer.type))) &&
        (rated.get(`${it.materialId}/${it.itemId}`)?.lapses ?? 0) > 0
    )
    .slice(0, 4);
}

function summary(wsId: string): StudySummary {
  const all = pool(wsId);
  const ws = db.workspaces.find((w) => w.id === wsId);
  return {
    enabled: enabled.get(wsId) ?? true,
    items: [...items(wsId)].map(([id, it]) => ({
      ...(it.kind === 'file' ? { fileId: id } : { materialId: id }),
      state: it.state,
      updatedAt: new Date(it.at).toISOString(),
    })),
    quickReview: quickReview(all),
    recentAttempts: db.attempts
      .filter((a) => a.kind === 'quiz' && a.workspaceName === ws?.name)
      .slice(0, 5)
      .map(db.attemptSummary),
    reviewable: all.length,
    unfinished: unfinished().find(
      (u) => u.workspaceId === wsId && u.group === 'workspace'
    ),
  };
}

function workspaceOf(materialId: string) {
  return db.materials.find((x) => x.id === materialId)?.workspaceId ?? null;
}

/** Records a rating and starts the material's progress. */
function rate(materialId: string, itemId: string, missed: boolean) {
  const key = `${materialId}/${itemId}`;
  rated.set(key, {
    at: Date.now(),
    lapses: (rated.get(key)?.lapses ?? 0) + (missed ? 1 : 0),
  });
  const wsId = workspaceOf(materialId);
  if (wsId) {
    studiedAt.set(wsId, Date.now());
    const map = items(wsId);
    if (map.get(materialId)?.state !== 'done')
      map.set(materialId, {
        at: Date.now(),
        kind: 'material',
        state: 'started',
      });
  }
}

/* Review sessions: recorded with their first answer, finished once every
 * served item is answered. There is no scoring here: suggestions come from
 * lapses (missed -> tricky, otherwise fading) plus showcase rows. */

type Answer =
  | { kind: 'card'; rating: number }
  | {
      kind: 'question';
      rating: number;
      correct: number;
      total: number;
      answers: Answers;
      graded: Question;
    };
type Session = {
  workspaceId: string;
  group: ReviewSuggestion['group'];
  chapterId?: string;
  mode?: ReviewMode;
  items: { materialId: string; itemId: string }[];
  answers: Map<string, Answer>;
  startedAt: number;
  lastAnswerAt: number;
  finishedAt?: number;
};
const sessions = new Map<string, Session>();

// Biology 101 has one session left halfway, so Continue review shows.
sessions.set('9b1e1c2a-6a6e-4d43-9a4c-3c1f0b3d7e01', {
  answers: new Map([['dk_1/c_4', { kind: 'card', rating: 1 }]]),
  group: 'workspace',
  items: ['c_4', 'c_7', 'c_1'].map((itemId) => ({
    itemId,
    materialId: 'dk_1',
  })),
  lastAnswerAt: Date.now() - 2 * 3_600_000,
  startedAt: Date.now() - 2 * 3_600_000 - 120_000,
  workspaceId: 'ws_bio',
});

function answer(
  ref: ReviewSessionRef,
  materialId: string,
  itemId: string,
  a: Answer
) {
  let session = sessions.get(ref.id);
  if (!session) {
    session = {
      answers: new Map(),
      chapterId: ref.chapterId,
      group: ref.group,
      items: ref.items,
      lastAnswerAt: Date.now(),
      mode: ref.mode,
      startedAt: Date.now(),
      workspaceId: ref.workspaceId,
    };
    sessions.set(ref.id, session);
  }
  session.answers.set(`${materialId}/${itemId}`, a);
  session.lastAnswerAt = Date.now();
  if (session.answers.size >= session.items.length)
    session.finishedAt ??= Date.now();
}

function chapterOf(materialId: string) {
  return db.materials.find((x) => x.id === materialId)?.chapterId ?? null;
}

function inGroup(
  wsId: string,
  group: ReviewSuggestion['group'],
  chapterId?: string
) {
  return pool(wsId).filter((it) =>
    group === 'chapter'
      ? chapterOf(it.materialId) === chapterId
      : group === 'others'
        ? !chapterOf(it.materialId)
        : true
  );
}

/** A workspace's suggestion from its rated items: tricky when any was missed. */
function suggestionsOf(wsId: string): ReviewSuggestion[] {
  const all = pool(wsId);
  if (all.length < 3) return [];
  const ws = db.workspaces.find((w) => w.id === wsId);
  const missed = all.filter(
    (it) => (rated.get(`${it.materialId}/${it.itemId}`)?.lapses ?? 0) > 0
  ).length;
  return [
    {
      evidence: {
        forgotten: Math.ceil(all.length / 2),
        lastPractisedAt: new Date(
          Math.max(
            ...all.map(
              (it) => rated.get(`${it.materialId}/${it.itemId}`)?.at ?? 0
            )
          )
        ).toISOString(),
        missed,
        repeated: all.filter(
          (it) => (rated.get(`${it.materialId}/${it.itemId}`)?.lapses ?? 0) > 1
        ).length,
        young: all.length,
      },
      group: 'workspace',
      iconId: ws?.iconId ?? '',
      items: all.length,
      mode: missed ? 'tricky' : 'fading',
      workspaceId: wsId,
      workspaceName: ws?.name ?? wsId,
    },
  ];
}

/** Suggestions for workspaces the mock has no items for, so the list shows
 * every mode and group. */
const SHOWCASE_SUGGESTIONS: ReviewSuggestion[] = [
  {
    evidence: {
      forgotten: 12,
      lastPractisedAt: daysAgo(21),
      missed: 0,
      repeated: 0,
      young: 3,
    },
    group: 'workspace',
    iconId: 'waves-07',
    items: 40,
    mode: 'fading',
    workspaceId: 'ws_demo_spanish2',
    workspaceName: 'Spanish A2',
  },
  {
    chapterId: 'ch_demo_ibp',
    chapterName: 'Integration by parts',
    evidence: {
      forgotten: 3,
      lastPractisedAt: daysAgo(2),
      missed: 1,
      repeated: 0,
      young: 8,
    },
    group: 'chapter',
    iconId: 'waves-05',
    items: 9,
    mode: 'learned',
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
  {
    evidence: {
      forgotten: 4,
      lastPractisedAt: daysAgo(6),
      missed: 5,
      repeated: 2,
      young: 1,
    },
    group: 'others',
    iconId: 'waves-04',
    items: 11,
    mode: 'tricky',
    workspaceId: 'ws_chem',
    workspaceName: 'Organic Chemistry',
  },
];

/** Sessions left before their end, newest answer first. */
function unfinished() {
  return [...sessions]
    .filter(([, s]) => !s.finishedAt && s.answers.size > 0)
    .sort(([, a], [, b]) => b.lastAnswerAt - a.lastAnswerAt)
    .map(([id, s]) => {
      const ws = db.workspaces.find((w) => w.id === s.workspaceId);
      return {
        answered: s.answers.size,
        chapterName: db.chapters.find((ch) => ch.id === s.chapterId)?.name,
        group: s.group,
        iconId: ws?.iconId ?? '',
        id,
        lastAnswerAt: new Date(s.lastAnswerAt).toISOString(),
        total: s.items.length,
        workspaceId: s.workspaceId,
        workspaceName: ws?.name ?? s.workspaceId,
      };
    });
}

function overview() {
  const real = [...progress.keys()].filter(
    (wsId) => (enabled.get(wsId) ?? true) && items(wsId).size > 0
  );
  const lastReviewed = (wsId: string) => {
    const times = [...sessions.values()]
      .filter((s) => s.workspaceId === wsId)
      .map((s) => s.lastAnswerAt);
    return times.length
      ? new Date(Math.max(...times)).toISOString()
      : undefined;
  };
  return {
    suggestions: [
      ...real.flatMap(suggestionsOf),
      ...SHOWCASE_SUGGESTIONS,
    ].slice(0, 5),
    unfinished: unfinished(),
    workspaces: [
      ...real.map((wsId) => {
        const ws = db.workspaces.find((w) => w.id === wsId);
        return {
          iconId: ws?.iconId ?? '',
          lastReviewedAt: lastReviewed(wsId),
          name: ws?.name ?? wsId,
          reviewable: pool(wsId).length,
          workspaceId: wsId,
        };
      }),
      ...SHOWCASE.filter((ws) => !real.includes(ws.workspaceId))
        .slice(0, 4)
        .map((ws, i) => ({
          iconId: ws.iconId,
          lastReviewedAt: i % 2 ? daysAgo(i * 5) : undefined,
          name: ws.name,
          reviewable: i === 3 ? 0 : 6 + i * 7,
          workspaceId: ws.workspaceId,
        })),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const SHOWCASE_PAST: PastReview[] = [
  {
    answered: 18,
    cards: { correct: 6, total: 7 },
    chapterName: 'Membranes & transport',
    finishedAt: daysAgo(1),
    group: 'chapter',
    iconId: 'waves-04',
    id: 'past_1',
    lastAnswerAt: daysAgo(1),
    mode: 'tricky',
    quiz: { correct: 7.5, total: 11 },
    startedAt: new Date(Date.now() - 86_400_000 - 660_000).toISOString(),
    total: 18,
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    answered: 9,
    chapterName: 'Integration by parts',
    finishedAt: daysAgo(2),
    group: 'chapter',
    iconId: 'waves-05',
    id: 'past_2',
    lastAnswerAt: daysAgo(2),
    mode: 'learned',
    quiz: { correct: 6, total: 9 },
    startedAt: new Date(Date.now() - 2 * 86_400_000 - 360_000).toISOString(),
    total: 9,
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
  {
    answered: 5,
    cards: { correct: 3, total: 5 },
    finishedAt: daysAgo(3),
    group: 'others',
    iconId: 'waves-04',
    id: 'past_3',
    lastAnswerAt: daysAgo(3),
    mode: 'tricky',
    startedAt: new Date(Date.now() - 3 * 86_400_000 - 180_000).toISOString(),
    total: 11,
    workspaceId: 'ws_chem',
    workspaceName: 'Organic Chemistry',
  },
  {
    answered: 40,
    cards: { correct: 31, total: 40 },
    finishedAt: daysAgo(4),
    group: 'workspace',
    iconId: 'waves-07',
    id: 'past_4',
    lastAnswerAt: daysAgo(4),
    mode: 'fading',
    startedAt: new Date(Date.now() - 4 * 86_400_000 - 840_000).toISOString(),
    total: 40,
    workspaceId: 'ws_demo_spanish2',
    workspaceName: 'Spanish A2',
  },
];

/** The server's past review orders (review_sessions.go). */
function pastSortKey(r: PastReview, sort: string | null) {
  const ratio = (s?: { correct: number; total: number }) =>
    s?.total ? s.correct / s.total : null;
  switch (sort) {
    case 'quiz':
      return ratio(r.quiz);
    case 'cards':
      return ratio(r.cards);
    case 'time':
      return +new Date(r.lastAnswerAt) - +new Date(r.startedAt);
    case 'workspace':
      return r.workspaceName.toLowerCase();
    case 'chapter':
      return r.group === 'chapter' ? (r.chapterName ?? '').toLowerCase() : null;
    case 'status':
      return r.answered < r.total ? 1 : 0;
    default:
      return r.startedAt;
  }
}

/** Answered items in answer order, with their records; `current` finds an
 * item as its material holds it now. */
function answeredItems(
  session: Session,
  current: (materialId: string, itemId: string) => ReviewItem | undefined
) {
  return [...session.answers].flatMap(([key, a]): ReviewAnswer[] => {
    const [materialId, itemId] = key.split('/');
    const found = current(materialId, itemId);
    if (!found) return [];
    // The learner view's question gives way to the graded one.
    const { question: _learner, ...item } = found;
    return a.kind === 'card'
      ? [{ ...item, rating: a.rating }]
      : [
          {
            ...item,
            answers: a.answers,
            correct: a.correct,
            question: a.graded,
            rating: a.rating,
            total: a.total,
          },
        ];
  });
}

/** The showcase Biology 101 review: graded questions from the seeded quiz
 * attempt between cards of Cell organelles. */
function showcaseResultItems(): ReviewAnswer[] {
  const attempt = db.attempts.find((a) => a.id === 'at_1');
  const questions = [1, 2, 5, 7, 10].flatMap(
    (i) => attempt?.questions?.[i] ?? []
  );
  // The second card's front and back run near their caps (120 and 1,000
  // characters), to see how a result tile holds them.
  const near = (sentence: string, cap: number) =>
    sentence
      .repeat(Math.ceil(cap / sentence.length))
      .slice(0, cap - 2)
      .trim();
  const cards = cardsOf('dk_1')
    .slice(0, 5)
    .map((card, i) =>
      i === 1
        ? {
            ...card,
            back: near(
              'The nucleus holds the DNA, controls gene expression and ships mRNA out through its pores. ',
              1000
            ),
            front: near(
              'Explain, with reference to the nuclear envelope, nucleolus and chromatin, how the nucleus controls the activities of a eukaryotic cell. ',
              120
            ),
          }
        : card
    );
  const RATINGS = [3, 1, 4, 2, 3];
  return questions.flatMap((question, i): ReviewAnswer[] => {
    const marks = question.parts.reduce((n, p) => n + p.marks, 0);
    const awarded = question.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
    const card = cards[i];
    return [
      {
        answers: attempt?.answers,
        correct: awarded,
        itemId: question.id,
        kind: 'question',
        materialId: 'qz_1',
        materialTitle: 'Cell biology basics',
        question,
        rating: awarded / marks < 0.5 ? 1 : awarded / marks < 0.7 ? 2 : 3,
        total: marks,
      },
      ...(card
        ? [
            {
              back: card.back,
              front: card.front,
              itemId: card.id,
              kind: 'card' as const,
              materialId: 'dk_1',
              materialTitle: 'Cell organelles',
              rating: RATINGS[i],
            },
          ]
        : []),
    ];
  });
}

function pastRow(id: string, s: Session): PastReview {
  const ws = db.workspaces.find((w) => w.id === s.workspaceId);
  const answers = [...s.answers.values()];
  const quiz = answers.filter((a) => a.kind === 'question');
  const cards = answers.filter((a) => a.kind === 'card');
  return {
    answered: answers.length,
    cards: cards.length
      ? {
          correct: cards.filter((a) => a.rating >= 3).length,
          total: cards.length,
        }
      : undefined,
    chapterId: s.chapterId,
    chapterName: db.chapters.find((ch) => ch.id === s.chapterId)?.name,
    finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : undefined,
    group: s.group,
    iconId: ws?.iconId ?? '',
    id,
    lastAnswerAt: new Date(s.lastAnswerAt).toISOString(),
    mode: s.mode,
    quiz: quiz.length
      ? {
          correct: quiz.reduce((n, a) => n + a.correct, 0),
          total: quiz.reduce((n, a) => n + a.total, 0),
        }
      : undefined,
    startedAt: new Date(s.startedAt).toISOString(),
    total: s.items.length,
    workspaceId: s.workspaceId,
    workspaceName: ws?.name ?? s.workspaceId,
  };
}

function pastReviews(params: URLSearchParams) {
  const recorded = [...sessions]
    .filter(([, s]) => s.finishedAt)
    .map(([id, s]) => pastRow(id, s));
  const workspaces = params.get('workspaceId')?.split(',') ?? [];
  const has = params.get('has')?.split(',') ?? [];
  const list = [...recorded, ...SHOWCASE_PAST]
    .filter((r) => !workspaces.length || workspaces.includes(r.workspaceId))
    .filter(
      (r) =>
        !has.length ||
        (has.includes('quiz') && r.quiz) ||
        (has.includes('flashcards') && r.cards)
    )
    .sort((a, b) => {
      const ka = pastSortKey(a, params.get('sort'));
      const kb = pastSortKey(b, params.get('sort'));
      // Rows without a value (no quiz, Others) stay last either way.
      if (ka === null || kb === null)
        return ka === kb ? 0 : ka === null ? 1 : -1;
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      return params.get('dir') === 'asc' ? cmp : -cmp;
    });
  return { items: list, more: false };
}

export const studyHandlers = [
  http.get('/api/workspaces/:id/study', ({ params }) =>
    HttpResponse.json(summary(String(params.id)))
  ),
  http.put('/api/workspaces/:id/study/enabled', async ({ params, request }) => {
    const body = (await request.json()) as { enabled: boolean };
    enabled.set(String(params.id), body.enabled);
    return new HttpResponse(null, { status: 204 });
  }),
  http.put('/api/workspaces/:id/study/items', async ({ params, request }) => {
    const body = (await request.json()) as {
      fileId?: string;
      materialId?: string;
      state?: 'done' | 'removed';
    };
    const id = body.fileId ?? body.materialId;
    if (!id) return new HttpResponse(null, { status: 422 });
    const map = items(String(params.id));
    studiedAt.set(String(params.id), Date.now());
    if (body.state)
      map.set(id, {
        at: Date.now(),
        kind: body.fileId ? 'file' : 'material',
        state: body.state,
      });
    else map.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/workspaces/:id/study/reset', ({ params }) => {
    const wsId = String(params.id);
    progress.delete(wsId);
    for (const key of [...rated.keys()])
      if (workspaceOf(key.split('/')[0]) === wsId) rated.delete(key);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/workspaces/:id/review', ({ params, request }) => {
    const url = new URL(request.url);
    const group = (url.searchParams.get('group') ??
      'workspace') as ReviewSuggestion['group'];
    const chapterId = url.searchParams.get('chapterId') ?? undefined;
    const mode = (url.searchParams.get('mode') ?? undefined) as
      | ReviewMode
      | undefined;
    const list = inGroup(String(params.id), group, chapterId).slice(0, 20);
    return HttpResponse.json({
      answered: 0,
      chapterId,
      done: [],
      evidence: mode
        ? suggestionsOf(String(params.id)).find((sg) => sg.group === group)
            ?.evidence
        : undefined,
      group,
      items: list,
      mode,
      total: list.length,
    });
  }),
  http.get('/api/learning/progress', ({ request }) => {
    const search = new URL(request.url).searchParams;
    return HttpResponse.json(
      learningProgress(search.get('lead'), search.get('all') === 'true')
    );
  }),
  http.get('/api/workspaces/:id/study/plans', ({ params }) => {
    const wsId = String(params.id);
    return HttpResponse.json(
      studyPlans([
        ...plans.filter((p) => p.workspaceId === wsId),
        ...plans.filter(
          (p) =>
            p.workspaceId !== wsId &&
            p.steps.some((st) => st.workspaceId === wsId)
        ),
      ])
    );
  }),
  http.post('/api/workspaces/:id/study/plans', async ({ params, request }) => {
    const wsId = String(params.id);
    const { name } = (await request.json()) as { name: string };
    if (plans.filter((p) => p.workspaceId === wsId).length >= 10)
      return HttpResponse.json(
        { detail: 'this workspace already has 10 plans' },
        { status: 409 }
      );
    const now = new Date().toISOString();
    const plan: MockPlan = {
      createdAt: now,
      id: `plan_${crypto.randomUUID()}`,
      name,
      steps: [],
      updatedAt: now,
      workspaceId: wsId,
    };
    plans.push(plan);
    return HttpResponse.json({ ...plan, steps: [] }, { status: 201 });
  }),
  http.patch('/api/study/plans/:id', async ({ params, request }) => {
    const plan = plans.find((p) => p.id === params.id);
    if (!plan) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as {
      name?: string;
      steps?: MockPlanStep[];
    };
    if (body.name) plan.name = body.name;
    if (body.steps) plan.steps = body.steps;
    plan.updatedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete('/api/study/plans/:id', ({ params }) => {
    const at = plans.findIndex((p) => p.id === params.id);
    if (at < 0) return new HttpResponse(null, { status: 404 });
    plans.splice(at, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/learning/plans', () =>
    HttpResponse.json(
      studyPlans(
        [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      )
    )
  ),
  http.get('/api/review/overview', () => HttpResponse.json(overview())),
  http.get('/api/review/sessions', ({ request }) =>
    HttpResponse.json(pastReviews(new URL(request.url).searchParams))
  ),
  http.get('/api/review/sessions/:id', ({ params }) => {
    const session = sessions.get(String(params.id));
    if (!session) return new HttpResponse(null, { status: 404 });
    const left = session.items.filter(
      (it) => !session.answers.has(`${it.materialId}/${it.itemId}`)
    );
    const all = pool(session.workspaceId);
    const current = (materialId: string, itemId: string) =>
      all.find((p) => p.materialId === materialId && p.itemId === itemId);
    const done = answeredItems(session, current);
    return HttpResponse.json({
      answered: session.answers.size,
      chapterId: session.chapterId,
      done,
      group: session.group,
      items: left
        .map((it) => current(it.materialId, it.itemId))
        .filter(Boolean),
      mode: session.mode,
      total: session.items.length,
    });
  }),
  http.get('/api/review/sessions/:id/result', ({ params }) => {
    const id = String(params.id);
    const session = sessions.get(id);
    if (session) {
      const all = pool(session.workspaceId);
      const items = answeredItems(session, (materialId, itemId) =>
        all.find((p) => p.materialId === materialId && p.itemId === itemId)
      );
      return HttpResponse.json({
        better: items.filter((it) => it.rating >= 3).length > 0 ? 1 : 0,
        items,
        session: pastRow(id, session),
      });
    }
    const row = SHOWCASE_PAST.find((r) => r.id === id);
    if (!row) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      better: 3,
      items: showcaseResultItems(),
      session: row,
    });
  }),
  http.post('/api/review/sessions/:id/finish', ({ params }) => {
    const session = sessions.get(String(params.id));
    if (!session) return new HttpResponse(null, { status: 404 });
    session.finishedAt ??= Date.now();
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/workspaces/:id/study/attempts', ({ params }) => {
    const items: ItemAttempts[] = db.materials
      .filter(
        (mt) =>
          mt.workspaceId === params.id &&
          !mt.parentMaterialId &&
          (mt.kind === 'quiz' || mt.kind === 'flashcards')
      )
      .map((mt) => {
        const mine = db.attempts
          .filter((at) => at.materialId === mt.id)
          .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
        return {
          count: mine.length,
          materialId: mt.id,
          recent: mine.slice(0, 3).map(db.attemptSummary),
          size:
            mt.kind === 'quiz'
              ? db.quizFromMaterial(mt).questions.length
              : db.cardsFromMaterial(mt).length,
        };
      });
    return HttpResponse.json({ items });
  }),
  http.post('/api/review/ratings', async ({ request }) => {
    const body = (await request.json()) as {
      materialId: string;
      itemId: string;
      rating: number;
      session?: ReviewSessionRef;
      attempt?: { id: string; startedAt: string };
    };
    // Embedded sets record nothing; the study page never sends their ratings.
    if (db.materials.find((x) => x.id === body.materialId)?.parentMaterialId)
      return new HttpResponse(null, { status: 422 });
    rate(body.materialId, body.itemId, body.rating === 1);
    if (body.session)
      answer(body.session, body.materialId, body.itemId, {
        kind: 'card',
        rating: body.rating,
      });
    if (body.attempt)
      recordCard(body.attempt, body.materialId, body.itemId, body.rating);
    return new HttpResponse(null, { status: 204 });
  }),
  // Grades one question, rates it from the score and returns its key.
  http.post('/api/review/check', async ({ request }) => {
    const body = (await request.json()) as {
      materialId: string;
      itemId: string;
      answers: Answers;
      session?: ReviewSessionRef;
    };
    const mt = db.materials.find(
      (x) => x.id === body.materialId && x.kind === 'quiz'
    );
    const question = mt
      ? db
          .quizFromMaterial(mt)
          .questions.find((item) => item.id === body.itemId)
      : undefined;
    if (!question) return new HttpResponse(null, { status: 404 });
    const graded = gradeQuestions([question], body.answers);
    const score = graded.max > 0 ? graded.awarded / graded.max : 0;
    rate(body.materialId, body.itemId, score < 0.5);
    if (body.session)
      answer(body.session, body.materialId, body.itemId, {
        answers: body.answers,
        correct: graded.awarded,
        graded: graded.questions[0],
        kind: 'question',
        // ScoreRating: below 0.5 Again, below 0.7 Hard, otherwise Good.
        rating: score < 0.5 ? 1 : score < 0.7 ? 2 : 3,
        total: graded.max,
      });
    return HttpResponse.json({
      correct: graded.awarded,
      question: graded.questions[0],
      total: graded.max,
    });
  }),
];
