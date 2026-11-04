import { HttpResponse, http } from 'msw';
import type {
  ItemAttempts,
  PastReview,
  Practice,
  PracticeReview,
  ReviewAnswer,
  ReviewItem,
  ReviewMode,
  ReviewReason,
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
import { assignmentClosedAt } from './assignments';
import * as db from './db';

/* Study progress and review, per signed-in user (the mock has one). A
 * rating is remembered with its lapses; there is no FSRS here, so "least
 * retained" is most lapses, then oldest. */

type Rated = { lapses: number; at: number };

/** Practised quizzes and sets per workspace, as study_progress rows. */
const progress = new Map<string, Set<string>>();
const enabled = new Map<string, boolean>();
const rated = new Map<string, Rated>(); // `${materialId}/${itemId}`

function items(wsId: string) {
  let map = progress.get(wsId);
  if (!map) {
    map = new Set();
    progress.set(wsId, map);
  }
  return map;
}

// Biology 101 opens with some history, as in the mocks.
for (const id of ['qz_1', 'qz_2', 'dk_1']) items('ws_bio').add(id);
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
// Genetics practised once a week ago, so Practice suggests it as fading.
rated.set('qz_2/q7', { at: Date.now() - 7 * 86_400_000, lapses: 0 });
// A twice-missed ordering question from yesterday: Calculus has a review
// but no Quick review.
items('ws_calc').add('qz_3');
rated.set('qz_3/q29', { at: Date.now() - 86_400_000, lapses: 2 });

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
      correct: 0,
      id: ref.id,
      kind: 'flashcards',
      materialId: setId,
      pct: 0,
      quizName: mt.title,
      startedAt: ref.startedAt,
      takenAt: at,
      topics: [],
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

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
/** Workspaces with progress but no items in the mock, so Learning's Review
 * overview lists a realistic spread (Organic Chemistry and English Literature
 * open their real, empty workspaces). */
const SHOWCASE = [
  { iconId: 'waves-04', name: 'Organic Chemistry', workspaceId: 'ws_chem' },
  { iconId: 'waves-05', name: 'English Literature', workspaceId: 'ws_eng' },
  {
    iconId: 'waves-06',
    name: 'Physics: mechanics',
    workspaceId: 'ws_demo_physics',
  },
  { iconId: 'waves-07', name: 'Spanish A2', workspaceId: 'ws_demo_spanish2' },
];

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
  for (const id of items(wsId)) {
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
            !it.question.parts[0].group &&
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
  if (wsId) items(wsId).add(materialId);
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
  group: ReviewSessionRef['group'];
  topicId?: string;
  mode?: ReviewMode;
  items: { materialId: string; itemId: string; reason?: ReviewReason }[];
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
      group: ref.group,
      items: ref.items,
      lastAnswerAt: Date.now(),
      mode: ref.mode,
      startedAt: Date.now(),
      topicId: ref.topicId,
      workspaceId: ref.workspaceId,
    };
    sessions.set(ref.id, session);
  }
  session.answers.set(`${materialId}/${itemId}`, a);
  session.lastAnswerAt = Date.now();
  if (session.answers.size >= session.items.length)
    session.finishedAt ??= Date.now();
}

function topicOf(materialId: string) {
  return db.materials.find((x) => x.id === materialId)?.topicId ?? null;
}

function inGroup(
  wsId: string,
  group: ReviewSuggestion['group'],
  topicId?: string
) {
  return pool(wsId).filter((it) =>
    group === 'topic'
      ? topicOf(it.materialId) === topicId
      : group === 'others'
        ? !topicOf(it.materialId)
        : true
  );
}

/** Why a session serves an item: never rated, missed, or fading. */
function reasonOf(it: { materialId: string; itemId: string }): ReviewReason {
  const rank = rated.get(`${it.materialId}/${it.itemId}`);
  if (!rank) return 'new';
  return rank.lapses > 0 ? 'missed' : 'fading';
}

/** The group's quizzes in reading order, top-level and untrashed. */
function groupQuizzes(
  wsId: string,
  group: ReviewSuggestion['group'],
  topicId?: string
) {
  const order = (id?: string | null) =>
    db.topics.find((t) => t.id === id)?.order ?? Number.MAX_SAFE_INTEGER;
  return db.materials
    .filter(
      (mt) =>
        mt.workspaceId === wsId &&
        mt.kind === 'quiz' &&
        !mt.parentMaterialId &&
        (group === 'topic'
          ? mt.topicId === topicId
          : group === 'others'
            ? !mt.topicId
            : true)
    )
    .sort((a, b) => order(a.topicId) - order(b.topicId));
}

/** Questions of the group's quizzes never rated, for a manual session. */
function newQuestions(
  wsId: string,
  group: ReviewSuggestion['group'],
  topicId?: string
): ReviewItem[] {
  return groupQuizzes(wsId, group, topicId).flatMap((mt) =>
    db
      .quizFromMaterial(mt)
      .questions.filter((q) => !rated.has(`${mt.id}/${q.id}`))
      .map((question) => ({
        itemId: question.id,
        kind: 'question' as const,
        materialId: mt.id,
        materialTitle: mt.title,
        question: learnerView(question),
      }))
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
    evidence: {
      forgotten: 3,
      lastPractisedAt: daysAgo(2),
      missed: 1,
      repeated: 0,
      young: 8,
    },
    group: 'topic',
    iconId: 'waves-05',
    items: 9,
    mode: 'learned',
    topicId: 'ch_demo_ibp',
    topicName: 'Integration by parts',
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
        group: s.group,
        iconId: ws?.iconId ?? '',
        id,
        lastAnswerAt: new Date(s.lastAnswerAt).toISOString(),
        topicName: db.topics.find((ch) => ch.id === s.topicId)?.name,
        total: s.items.length,
        workspaceId: s.workspaceId,
        workspaceName: ws?.name ?? s.workspaceId,
      };
    });
}

/** A top-level quiz or flashcard set, what a manual review draws from. */
const isQuiz = (id: string) =>
  db.materials.some(
    (mt) =>
      mt.id === id &&
      !mt.parentMaterialId &&
      (mt.kind === 'quiz' || mt.kind === 'flashcards')
  );

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
          canReview:
            pool(wsId).length > 0 ||
            db.materials.some((mt) => mt.workspaceId === wsId && isQuiz(mt.id)),
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
          canReview: i !== 3,
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
    finishedAt: daysAgo(1),
    group: 'topic',
    iconId: 'waves-04',
    id: 'past_1',
    lastAnswerAt: daysAgo(1),
    mode: 'tricky',
    quiz: { correct: 7.5, total: 11 },
    startedAt: new Date(Date.now() - 86_400_000 - 660_000).toISOString(),
    topicName: 'Membranes & transport',
    total: 18,
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    answered: 9,
    finishedAt: daysAgo(2),
    group: 'topic',
    iconId: 'waves-05',
    id: 'past_2',
    lastAnswerAt: daysAgo(2),
    mode: 'learned',
    quiz: { correct: 6, total: 9 },
    startedAt: new Date(Date.now() - 2 * 86_400_000 - 360_000).toISOString(),
    topicName: 'Integration by parts',
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
    case 'topic':
      return r.group === 'topic' ? (r.topicName ?? '').toLowerCase() : null;
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
  const reasons = new Map(
    session.items.map((it) => [`${it.materialId}/${it.itemId}`, it.reason])
  );
  return [...session.answers].flatMap(([key, a]): ReviewAnswer[] => {
    const [materialId, itemId] = key.split('/');
    const found = current(materialId, itemId);
    if (!found) return [];
    // The learner view's question gives way to the graded one.
    const { question: _learner, ...rest } = found;
    const item = { ...rest, reason: reasons.get(key) };
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
    topicId: s.topicId,
    topicName: db.topics.find((ch) => ch.id === s.topicId)?.name,
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

// Biology 101's Membranes & transport was reviewed once (Practice's "Only
// you" row): two of three questions right.
{
  const quiz = db.materials.find((x) => x.id === 'qz_1');
  const questions = quiz ? db.quizFromMaterial(quiz).questions : [];
  const picked = ['q4', 'q12', 'q15'].flatMap(
    (id) => questions.find((q) => q.id === id) ?? []
  );
  const at = Date.now() - 2 * 86_400_000;
  sessions.set('5f0c2a41-7c3e-4c55-9d2b-1e8a9c4b6d02', {
    answers: new Map(
      picked.map((question, i): [string, Answer] => {
        const graded = gradeQuestions([question], {});
        return [
          `qz_1/${question.id}`,
          {
            answers: {},
            correct: i === 1 ? 0 : graded.max,
            graded: graded.questions[0],
            kind: 'question',
            rating: i === 1 ? 1 : 3,
            total: graded.max,
          },
        ];
      })
    ),
    finishedAt: at,
    group: 'topic',
    items: picked.map((question, i) => ({
      itemId: question.id,
      materialId: 'qz_1',
      reason: i === 2 ? 'new' : 'missed',
    })),
    lastAnswerAt: at,
    startedAt: at - 6 * 60_000,
    topicId: 'ch_2',
    workspaceId: 'ws_bio',
  });
}

/** Practice as the server reads it: this workspace's suggestions over its
 * questions, every quiz in reading order with the best attempt, the
 * caller's topic reviews; staff also get member counts (the mock's are
 * fixed: six members, a group average once five tried). */
export function practiceBody(wsId: string, staff: boolean): Practice {
  // One suggestion per topic with rated questions: tricky when missed.
  const groups = new Map<string, ReviewItem[]>();
  for (const it of pool(wsId))
    if (it.kind === 'question') {
      const key = topicOf(it.materialId) ?? '';
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
  const ws = db.workspaces.find((w) => w.id === wsId);
  const suggestions: ReviewSuggestion[] = [...groups]
    .map(([topicId, list]): ReviewSuggestion => {
      const ranks = list.map(
        (it) =>
          rated.get(`${it.materialId}/${it.itemId}`) ?? { at: 0, lapses: 0 }
      );
      const missed = ranks.filter((r) => r.lapses > 0).length;
      return {
        evidence: {
          forgotten: Math.ceil(list.length / 2),
          lastPractisedAt: new Date(
            Math.max(...ranks.map((r) => r.at))
          ).toISOString(),
          missed,
          repeated: ranks.filter((r) => r.lapses > 1).length,
          young: list.length,
        },
        group: topicId ? 'topic' : 'others',
        iconId: ws?.iconId ?? '',
        items: list.length,
        mode: missed ? 'tricky' : 'fading',
        topicId: topicId || undefined,
        topicName: db.topics.find((t) => t.id === topicId)?.name,
        workspaceId: wsId,
        workspaceName: ws?.name ?? wsId,
      };
    })
    .sort((a, b) => b.items - a.items)
    .slice(0, 3);
  const TRIED = [5, 2, 6, 0];
  const AVERAGE = [0.74, 0, 0.81, 0];
  const quizzes = groupQuizzes(wsId, 'workspace').map((mt, i) => {
    const best = db.attempts
      .filter((a) => a.materialId === mt.id && a.kind === 'quiz' && a.total > 0)
      .sort((a, b) => b.correct / b.total - a.correct / a.total)[0];
    const tried = TRIED[i % TRIED.length];
    return {
      best: best ? { correct: best.correct, total: best.total } : undefined,
      assignmentClosedAt: assignmentClosedAt(mt.id),
      id: mt.id,
      questions: db.quizFromMaterial(mt).questions.length,
      title: mt.title,
      topicId: mt.topicId ?? undefined,
      ...(staff
        ? {
            average: tried >= 5 ? AVERAGE[i % AVERAGE.length] : undefined,
            triedBy: tried,
          }
        : {}),
    };
  });
  const reviews = new Map<string, PracticeReview>();
  for (const [, session] of [...sessions].sort(
    (a, b) => b[1].lastAnswerAt - a[1].lastAnswerAt
  )) {
    if (session.workspaceId !== wsId) continue;
    if (session.group !== 'topic' && session.group !== 'others') continue;
    const marks = [...session.answers.values()].flatMap((a) =>
      a.kind === 'question' ? [a] : []
    );
    if (!marks.length) continue;
    const best = {
      correct: marks.reduce((n, a) => n + a.correct, 0),
      total: marks.reduce((n, a) => n + a.total, 0),
    };
    const key = `${session.group}:${session.topicId ?? ''}`;
    const seen = reviews.get(key);
    if (!seen)
      reviews.set(key, {
        best,
        group: session.group,
        lastAt: new Date(session.lastAnswerAt).toISOString(),
        questions: session.items.length,
        topicId: session.topicId,
      });
    else if (best.correct / best.total > seen.best.correct / seen.best.total)
      seen.best = best;
  }
  return {
    quizzes,
    reviews: [...reviews.values()],
    suggestions: items(wsId).size > 0 ? suggestions : [],
    ...(staff ? { members: 6 } : {}),
  };
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
      'workspace') as ReviewSessionRef['group'];
    const topicId = url.searchParams.get('topicId') ?? undefined;
    const mode = (url.searchParams.get('mode') ?? undefined) as
      | ReviewMode
      | undefined;
    // Practice's topic sessions serve questions only; without a mode they
    // mix in questions not seen yet, alternating with practised ones.
    const questionsOnly = url.searchParams.get('items') === 'quiz';
    let practised = inGroup(String(params.id), group, topicId);
    if (questionsOnly)
      practised = practised.filter((it) => it.kind === 'question');
    const fresh =
      questionsOnly && !mode
        ? newQuestions(String(params.id), group, topicId)
        : [];
    const mixed: ReviewItem[] = [];
    for (let i = 0; i < Math.max(practised.length, fresh.length); i++)
      mixed.push(...[practised[i], fresh[i]].filter((it) => !!it));
    const list = mixed
      .slice(0, questionsOnly ? 10 : 20)
      .map((it) => ({ ...it, reason: reasonOf(it) }));
    return HttpResponse.json({
      answered: 0,
      done: [],
      evidence: mode
        ? suggestionsOf(String(params.id)).find((sg) => sg.group === group)
            ?.evidence
        : undefined,
      group,
      items: list,
      mode,
      topicId,
      total: list.length,
    });
  }),
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
      done,
      group: session.group,
      items: left.flatMap((it) => {
        const found = current(it.materialId, it.itemId);
        return found ? [{ ...found, reason: it.reason }] : [];
      }),
      mode: session.mode,
      topicId: session.topicId,
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
  http.get('/api/workspaces/:id/practice', ({ params }) => {
    const wsId = String(params.id);
    const ws = db.workspaces.find((w) => w.id === wsId);
    return HttpResponse.json(
      practiceBody(
        wsId,
        ws?.kind === 'class' && (ws.role === 'owner' || ws.role === 'editor')
      )
    );
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
