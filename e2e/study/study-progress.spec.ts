import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import type { StudySummary, Topic } from '../../src/api/types';
import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';
import { m } from '../i18n';

// Study progress is per user, so each test works in its own workspace.

async function addTopic(
  api: APIRequestContext,
  workspaceId: string,
  name: string
) {
  const res = await api.post(`/api/workspaces/${workspaceId}/topics`, {
    data: { name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as Topic;
}

async function placeInTopic(
  api: APIRequestContext,
  workspaceId: string,
  topicId: string,
  materialIds: string[]
) {
  const res = await api.post(`/api/workspaces/${workspaceId}/content/reorder`, {
    data: {
      items: materialIds.map((id) => ({ id, type: 'material' })),
      topicId,
    },
  });
  expect(res.status()).toBe(204);
}

async function createMaterial(
  api: APIRequestContext,
  workspaceId: string,
  kind: 'quiz' | 'flashcards',
  title: string,
  value: unknown[]
) {
  const res = await api.post(`/api/workspaces/${workspaceId}/materials`, {
    data: { content: { schemaVersion: 1, value }, kind, title },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

/** True/false questions: closed parts the server grades without Jev. */
function quizValue(questions: Array<{ prompt: string; correct: boolean }>) {
  return [
    {
      children: questions.map(({ prompt, correct }, index) => {
        const id = `q_${index + 1}`;
        return {
          children: [{ text: '' }],
          id,
          question: {
            id,
            labels: 'letters',
            layout: 'paper',
            parts: [
              {
                answer: { correct, type: 'boolean' },
                blocks: [{ text: prompt, type: 'text' }],
                id: `${id}:part:1`,
                marks: 1,
                solution: [],
              },
            ],
            stem: [],
          },
          type: 'quiz_question',
        };
      }),
      id: 'quiz_root',
      type: 'quiz',
    },
  ];
}

/** Card ids are global keys, so each call mints its own. */
function cardsValue(faces: Array<[string, string]>) {
  return [
    {
      children: faces.map(([front, back]) => ({
        children: [
          { children: [{ text: front }], type: 'flashcard_front' },
          { children: [{ text: back }], type: 'flashcard_back' },
        ],
        id: `c_e2e_${randomUUID()}`,
        type: 'flashcard',
      })),
      id: 'cards_root',
      type: 'flashcards',
    },
  ];
}

async function readStudy(api: APIRequestContext, workspaceId: string) {
  const res = await api.get(`/api/workspaces/${workspaceId}/study`);
  expect(res.status()).toBe(200);
  return (await res.json()) as StudySummary;
}

/** Clicks a rating tile and waits for the rating it posts. */
async function rate(page: Page, rating: string) {
  const rated = waitForApi(page, apiEndsWith('/api/review/ratings', 'POST'));
  await page.getByRole('button', { exact: true, name: rating }).click();
  expect((await rated).status()).toBe(204);
}

test.describe('study progress', () => {
  test('a checked quiz and a studied set are reviewable, and Learning opens a whole-workspace review', async ({
    ownerApi,
    ownerPage,
    workspaceFactory,
  }) => {
    test.setTimeout(120_000);
    const ws = await workspaceFactory.create({
      name: `E2E Study Practice ${randomUUID()}`,
    });
    const questions = [
      { correct: true, prompt: 'Wetland plants absorb carbon.' },
      { correct: false, prompt: 'Mangroves grow only in fresh water.' },
    ];
    const faces: Array<[string, string]> = [
      ['Estuary', 'Where a river meets the sea'],
      ['Salt marsh', 'Coastal grassland flooded by tides'],
    ];
    const quiz = (title: string) =>
      createMaterial(ownerApi, ws.id, 'quiz', title, quizValue(questions));
    const set = (title: string) =>
      createMaterial(ownerApi, ws.id, 'flashcards', title, cardsValue(faces));
    const finishedQuiz = await quiz('Finished quiz');
    const finishedSet = await set('Finished cards');
    const startedQuiz = await quiz('Started quiz');
    const startedSet = await set('Started cards');

    // A quiz answered in part and left unchecked: nothing reaches the server.
    await ownerPage.goto(`/quizzes/${startedQuiz.id}/attempt`);
    await ownerPage
      .getByRole('button', { exact: true, name: m.question_ui_true() })
      .first()
      .click();
    await expect(
      ownerPage.getByText(m.quiz_checked_count({ checked: 0, total: 2 }))
    ).toBeVisible();
    // Another checked question by question: one right, one wrong.
    await ownerPage.goto(`/quizzes/${finishedQuiz.id}/attempt`);
    const trueButtons = ownerPage.getByRole('button', {
      exact: true,
      name: m.question_ui_true(),
    });
    await trueButtons.nth(0).click();
    await trueButtons.nth(1).click();
    for (let i = 0; i < 2; i++) {
      const checked = waitForApi(
        ownerPage,
        apiEndsWith(`/api/quizzes/${finishedQuiz.id}/check`, 'POST')
      );
      // A checked question loses its button, so the first is the next one.
      await ownerPage
        .getByRole('button', {
          exact: true,
          name: m.question_ui_check(),
        })
        .first()
        .click();
      expect((await checked).status()).toBe(200);
    }
    await expect(
      ownerPage.getByRole('button', { name: m.quiz_redo() })
    ).toBeVisible();

    // A set studied to the end: Again sends the first card to the back.
    await ownerPage.goto(`/flashcards/${finishedSet.id}`);
    const showAnswer = ownerPage.getByRole('button', {
      name: m.flashcards_show_answer(),
    });
    await showAnswer.click();
    for (const tile of [
      m.srs_again(),
      m.srs_hard(),
      m.srs_good(),
      m.srs_easy(),
    ]) {
      await expect(
        ownerPage.getByRole('button', { exact: true, name: tile })
      ).toBeVisible();
    }
    await rate(ownerPage, m.srs_again());
    await showAnswer.click();
    await rate(ownerPage, m.srs_good());
    await expect(ownerPage.getByText(faces[0][0])).toBeVisible();
    await showAnswer.click();
    await rate(ownerPage, m.srs_good());
    await expect(
      ownerPage.getByRole('button', { name: m.flashcards_study_again() })
    ).toBeVisible();
    // Another left after its first card.
    await ownerPage.goto(`/flashcards/${startedSet.id}`);
    await showAnswer.click();
    await rate(ownerPage, m.srs_easy());

    const study = await readStudy(ownerApi, ws.id);
    expect(
      study.recentAttempts.map(({ correct, materialId, total }) => ({
        correct,
        materialId,
        total,
      }))
    ).toEqual([{ correct: 1, materialId: finishedQuiz.id, total: 2 }]);
    // Both questions of the attempt, both finished cards, one started card.
    expect(study.reviewable).toBe(5);

    // A whole-workspace session over the five practised items, which
    // mixes in the new ones (the untouched quiz, the started set's other
    // cards).
    const manual = await ownerApi.get(
      `/api/workspaces/${ws.id}/review?group=workspace`
    );
    const sessionTotal = (await manual.json()).items.length;
    expect(sessionTotal).toBeGreaterThan(5);
    await ownerPage.goto(
      `/learning/review/${ws.id}?group=workspace&from=workspace`
    );
    await expect(
      ownerPage.getByRole('progressbar', {
        exact: true,
        name: m.flashcards_card_position({ position: 1, total: sessionTotal }),
      })
    ).toBeVisible();
  });

  test('a mixed review session rates a flashcard and checks a question, then ends', async ({
    ownerApi,
    ownerPage,
    workspaceFactory,
  }) => {
    const ws = await workspaceFactory.create({
      name: `E2E Study Review ${randomUUID()}`,
    });
    // Card ids are global keys, so each run mints its own.
    const cardId = `c_e2e_review_${randomUUID()}`;
    const questionId = 'q_review_1';
    const prompt = 'Review prompt: is this statement true?';
    const quiz = await createMaterial(ownerApi, ws.id, 'quiz', 'Review quiz', [
      {
        children: [
          {
            children: [{ text: '' }],
            id: questionId,
            question: {
              id: questionId,
              labels: 'letters',
              layout: 'paper',
              parts: [
                {
                  answer: { correct: true, type: 'boolean' },
                  blocks: [{ text: prompt, type: 'text' }],
                  id: `${questionId}:part:1`,
                  marks: 1,
                  solution: [],
                },
              ],
              stem: [],
            },
            type: 'quiz_question',
          },
        ],
        id: 'review_quiz_root',
        type: 'quiz',
      },
    ]);
    const cards = await createMaterial(
      ownerApi,
      ws.id,
      'flashcards',
      'Review cards',
      [
        {
          children: [
            {
              children: [
                {
                  children: [{ text: 'Review front' }],
                  type: 'flashcard_front',
                },
                { children: [{ text: 'Review back' }], type: 'flashcard_back' },
              ],
              id: cardId,
              type: 'flashcard',
            },
          ],
          id: 'review_cards_root',
          type: 'flashcards',
        },
      ]
    );
    // Review draws only on rated items. A question answered right (Good) is
    // better retained than a card missed (Again), so the card comes first.
    // The server grades and rates a question's check.
    const seeded = await ownerApi.post('/api/review/check', {
      data: {
        answers: { [`${questionId}:part:1`]: true },
        itemId: questionId,
        materialId: quiz.id,
      },
    });
    expect(seeded.status()).toBe(200);
    expect(await seeded.json()).toMatchObject({ correct: 1, total: 1 });
    const cardRating = await ownerApi.post('/api/review/ratings', {
      data: { itemId: cardId, materialId: cards.id, rating: 1 },
    });
    expect(cardRating.status()).toBe(204);

    // A whole-workspace review.
    await ownerPage.goto(
      `/learning/review/${ws.id}?group=workspace&from=workspace`
    );
    await expect(
      ownerPage.getByRole('progressbar', {
        exact: true,
        name: m.flashcards_card_position({ position: 1, total: 2 }),
      })
    ).toBeVisible();

    const ratings: Record<string, unknown>[] = [];
    ownerPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/review/ratings'))
        ratings.push(req.postDataJSON());
    });

    await expect(ownerPage.getByText('Review front')).toBeVisible();
    await ownerPage
      .getByRole('button', { name: m.flashcards_show_answer() })
      .click();
    await expect(ownerPage.getByText('Review back')).toBeVisible();
    const cardRated = waitForApi(
      ownerPage,
      apiEndsWith('/api/review/ratings', 'POST')
    );
    await ownerPage
      .getByRole('button', { exact: true, name: m.srs_good() })
      .click();
    expect((await cardRated).status()).toBe(204);

    await expect(ownerPage.getByText(prompt)).toBeVisible();
    await expect(
      ownerPage.getByRole('progressbar', {
        exact: true,
        name: m.flashcards_card_position({ position: 2, total: 2 }),
      })
    ).toBeVisible();
    // The question arrives answer-free; Check returns its key and rates it.
    await ownerPage
      .getByRole('button', { exact: true, name: m.question_ui_true() })
      .click();
    const questionChecked = waitForApi(
      ownerPage,
      apiEndsWith('/api/review/check', 'POST')
    );
    await ownerPage
      .getByRole('button', { exact: true, name: m.review_check() })
      .click();
    const checked = await questionChecked;
    expect(checked.status()).toBe(200);
    const checkBody = checked.request().postDataJSON();
    expect(checkBody).toMatchObject({
      answers: { [`${questionId}:part:1`]: true },
      itemId: questionId,
      materialId: quiz.id,
      session: { group: 'workspace', workspaceId: ws.id },
    });
    expect(checkBody.session.items).toHaveLength(2);
    await expect(
      ownerPage.getByText(m.question_ui_your_answer())
    ).toBeVisible();
    // Next after the last item opens the result: the question right with
    // its mark, the card rated Good.
    await ownerPage
      .getByRole('button', { exact: true, name: m.action_next() })
      .click();
    const rows = ownerPage.getByRole('button', { expanded: false });
    await expect(rows.filter({ hasText: m.review_result_right() })).toHaveCount(
      1
    );
    await expect(
      ownerPage.getByText(m.srs_good(), { exact: true })
    ).toHaveCount(1);
    await expect(
      ownerPage.getByText(m.review_result_mark({ awarded: '1' }), {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: m.review_again() })
    ).toBeVisible();
    // Both answers carry the same session, recorded with the first one.
    expect(ratings).toHaveLength(1);
    expect(ratings[0]).toMatchObject({
      itemId: cardId,
      materialId: cards.id,
      rating: 3,
      session: { id: checkBody.session.id },
    });

    // Back from a workspace review opens the workspace's Practice.
    await ownerPage
      .getByRole('button', { exact: true, name: m.action_back() })
      .click();
    await expect(ownerPage).toHaveURL(
      new RegExp(`/workspaces/${ws.id}[?]study=practice$`)
    );

    // The finished session is in Past reviews with one card and one question.
    const past = await ownerApi.get('/api/review/sessions');
    expect(past.status()).toBe(200);
    const [recorded] = (await past.json()).items;
    expect(recorded).toMatchObject({
      answered: 2,
      cards: { correct: 1, total: 1 },
      id: checkBody.session.id,
      quiz: { correct: 1, total: 1 },
      total: 2,
      workspaceId: ws.id,
    });
  });

  test("Practice: a topic session serves the topic's questions with why, marks each and keeps the result", async ({
    ownerApi,
    ownerPage,
    workspaceFactory,
  }) => {
    const ws = await workspaceFactory.create({
      name: `E2E Practice ${randomUUID()}`,
    });
    const topic = await addTopic(ownerApi, ws.id, 'Osmosis');
    const quiz = await createMaterial(
      ownerApi,
      ws.id,
      'quiz',
      'Osmosis check',
      quizValue([{ correct: true, prompt: 'Water moves by osmosis.' }])
    );
    await placeInTopic(ownerApi, ws.id, topic.id, [quiz.id]);

    // Every quiz members can see is practice. In a personal workspace, the
    // default, the owner practises too; in a class they see its use instead.
    await ownerPage.goto(`/workspaces/${ws.id}?study=practice`);
    await expect(ownerPage.getByText('Osmosis check').first()).toBeVisible();
    await expect(
      ownerPage.getByText(m.practice_col_best()).first()
    ).toBeVisible();
    const setKind = async (kind: 'class' | 'personal') =>
      expect(
        (
          await ownerApi.patch(`/api/workspaces/${ws.id}`, { data: { kind } })
        ).status()
      ).toBe(200);
    await setKind('class');
    await ownerPage.reload();
    await expect(
      ownerPage.getByText(m.practice_col_tried()).first()
    ).toBeVisible();
    await setKind('personal');

    // Practise on the topic: its question not seen yet, then marked.
    await ownerPage.goto(
      `/workspaces/${ws.id}?study=practice&group=topic&topicId=${topic.id}`
    );
    const dialog = ownerPage.getByRole('dialog', {
      name: m.practice_session_title({ topic: 'Osmosis' }),
    });
    await expect(dialog.getByText(m.practice_reason_new())).toBeVisible();
    await dialog
      .getByRole('button', { exact: true, name: m.review_start() })
      .locator('visible=true')
      .click();
    await ownerPage
      .getByRole('button', { exact: true, name: m.question_ui_true() })
      .click();
    await ownerPage
      .getByRole('button', { exact: true, name: m.review_check() })
      .click();
    await ownerPage
      .getByRole('button', { exact: true, name: m.action_next() })
      .click();
    await expect(ownerPage).toHaveURL(/[?&]review=/);
    await expect(
      ownerPage.getByText(m.practice_right_of({ correct: 1, total: 1 }))
    ).toBeVisible();

    // The session is kept as the learner's own review of the topic.
    const practice = await ownerApi.get(`/api/workspaces/${ws.id}/practice`);
    expect(practice.status()).toBe(200);
    expect((await practice.json()).reviews).toMatchObject([
      { best: { correct: 1, total: 1 }, group: 'topic', topicId: topic.id },
    ]);
  });

  test('hidden progress: the Study switch in workspace settings, and settings stay in the URL', async ({
    ownerApi,
    ownerPage,
    workspaceFactory,
  }) => {
    const workspace = await workspaceFactory.create({
      name: `Progress hidden ${randomUUID().slice(0, 8)}`,
    });
    const off = await ownerApi.put(
      `/api/workspaces/${workspace.id}/study/enabled`,
      { data: { enabled: false } }
    );
    expect(off.status()).toBe(204);
    const errors: string[] = [];
    ownerPage.on('pageerror', (error) => errors.push(error.message));

    await ownerPage.goto(`/workspaces/${workspace.id}?settings=study`);
    const hide = ownerPage.getByRole('switch', {
      name: m.study_hide_progress(),
    });
    await expect(hide).toBeChecked();
    const shown = waitForApi(
      ownerPage,
      apiEndsWith(`/api/workspaces/${workspace.id}/study/enabled`, 'PUT')
    );
    await hide.click();
    expect((await shown).status()).toBe(204);
    await ownerPage.keyboard.press('Escape');

    // Back with settings open leaves in-app (a goto would leave the
    // document, so the router never runs) and closes the dialog once.
    await ownerPage.goto('/workspaces');
    await ownerPage.getByRole('link', { name: workspace.name }).first().click();
    await ownerPage
      .getByLabel(m.workspace_settings(), { exact: true })
      .first()
      .click();
    await expect(ownerPage).toHaveURL(/settings=/);
    await ownerPage.goBack();
    await expect(ownerPage).toHaveURL(/\/workspaces$/);
    await expect(ownerPage.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
