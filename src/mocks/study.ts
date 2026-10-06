import { HttpResponse, http } from 'msw';
import type { ReviewItem, StudySummary } from '@/api/types';
import { parseFlashcardsBlock } from '@/features/materials/blocks';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
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
  Map<string, { kind: 'file' | 'material'; state: State }>
>();
const enabled = new Map<string, boolean>();
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
items('ws_bio').set('f_1', { kind: 'file', state: 'done' });
items('ws_bio').set('f_2', { kind: 'file', state: 'done' });
items('ws_bio').set('qz_1', { kind: 'material', state: 'done' });
items('ws_bio').set('dk_1', { kind: 'material', state: 'started' });
for (const [card, lapses] of [
  ['c_4', 2],
  ['c_7', 1],
  ['c_1', 0],
] as const)
  rated.set(`dk_1/${card}`, { at: Date.now() - lapses * 3_600_000, lapses });
// A missed quiz question, so a session has a question to check too.
rated.set('qz_1/q4', { at: Date.now() - 7_200_000, lapses: 1 });

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

function summary(wsId: string): StudySummary {
  const all = pool(wsId);
  const ws = db.workspaces.find((w) => w.id === wsId);
  return {
    enabled: enabled.get(wsId) ?? true,
    items: [...items(wsId)].map(([id, it]) => ({
      ...(it.kind === 'file' ? { fileId: id } : { materialId: id }),
      state: it.state,
    })),
    quickReview: all.filter(
      (it) =>
        it.kind === 'card' &&
        (rated.get(`${it.materialId}/${it.itemId}`)?.lapses ?? 0) > 0
    ),
    recentAttempts: db.attempts
      .filter((a) => a.workspaceName === ws?.name)
      .slice(0, 5)
      .map(db.attemptSummary),
    reviewable: all.length,
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
    const map = items(wsId);
    if (map.get(materialId)?.state !== 'done')
      map.set(materialId, { kind: 'material', state: 'started' });
  }
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
    if (body.state)
      map.set(id, {
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
  http.get('/api/workspaces/:id/review', ({ params }) =>
    HttpResponse.json({ items: pool(String(params.id)).slice(0, 20) })
  ),
  http.get('/api/review/workspaces', () =>
    HttpResponse.json({
      workspaces: [...progress.keys()]
        .filter((wsId) => enabled.get(wsId) ?? true)
        .map((wsId) => {
          const ws = db.workspaces.find((w) => w.id === wsId);
          const total =
            db.files.filter((f) => f.workspaceId === wsId).length +
            db.materials.filter(
              (x) => x.workspaceId === wsId && !x.parentMaterialId
            ).length;
          return {
            done: [...items(wsId).values()].filter((it) => it.state === 'done')
              .length,
            name: ws?.name ?? wsId,
            reviewable: pool(wsId).length,
            total,
            workspaceId: wsId,
          };
        }),
    })
  ),
  http.post('/api/review/ratings', async ({ request }) => {
    const body = (await request.json()) as {
      materialId: string;
      itemId: string;
      rating: number;
    };
    rate(body.materialId, body.itemId, body.rating === 1);
    return new HttpResponse(null, { status: 204 });
  }),
  // Grades one question, rates it from the score and returns its key.
  http.post('/api/review/check', async ({ request }) => {
    const body = (await request.json()) as {
      materialId: string;
      itemId: string;
      answers: Answers;
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
    rate(body.materialId, body.itemId, graded.awarded / graded.max < 0.5);
    return HttpResponse.json({
      correct: graded.awarded,
      question: graded.questions[0],
      total: graded.max,
    });
  }),
];
