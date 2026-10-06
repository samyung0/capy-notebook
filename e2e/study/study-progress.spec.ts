import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import type { Chapter, SourceFile, StudySummary } from '../../src/api/types';
import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

// Study progress is per user, so each test either works in its own workspace
// or acts as a user no other spec records progress for.

async function addChapter(
  api: APIRequestContext,
  workspaceId: string,
  name: string
) {
  const res = await api.post(`/api/workspaces/${workspaceId}/chapters`, {
    data: { name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as Chapter;
}

async function placeInChapter(
  api: APIRequestContext,
  workspaceId: string,
  chapterId: string,
  materialIds: string[]
) {
  const res = await api.post(`/api/workspaces/${workspaceId}/content/reorder`, {
    data: {
      chapterId,
      items: materialIds.map((id) => ({ id, type: 'material' })),
    },
  });
  expect(res.status()).toBe(204);
}

async function setStudyItem(
  api: APIRequestContext,
  workspaceId: string,
  target: { fileId: string } | { materialId: string },
  state?: 'done' | 'removed'
) {
  const res = await api.put(`/api/workspaces/${workspaceId}/study/items`, {
    data: { ...target, ...(state ? { state } : {}) },
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

function stateOf(study: StudySummary, id: string) {
  return study.items.find((it) => it.fileId === id || it.materialId === id)
    ?.state;
}

/** Clicks a rating tile and waits for the rating it posts. */
async function rate(page: Page, rating: 'Again' | 'Hard' | 'Good' | 'Easy') {
  const rated = waitForApi(page, apiEndsWith('/api/review/ratings', 'POST'));
  await page.getByRole('button', { exact: true, name: rating }).click();
  expect((await rated).status()).toBe(204);
}

/** A file row's ⋮ menu in the Files panel. */
async function openRowMenu(page: Page, name: string) {
  const row = page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { name })
    .locator('xpath=..');
  await row.hover();
  await row.getByRole('button', { name: 'Open menu' }).click();
}

test.describe('study progress', () => {
  test('a file is marked read and unread from its row menu and its header', async ({
    editorApi,
    editorPage,
    seed,
  }) => {
    // The editor member records progress on the seeded private file.
    const workspaceId = seed.privateWorkspace.id;
    const fileName = seed.privateWorkspace.secretFile;
    const files = (await (
      await editorApi.get(`/api/workspaces/${workspaceId}/files`)
    ).json()) as SourceFile[];
    const file = files.find((f) => f.name === fileName);
    if (!file) throw new Error(`Seed file ${fileName} is missing`);
    // A retry starts from an untouched file.
    await setStudyItem(editorApi, workspaceId, { fileId: file.id });

    const doneMark = editorPage
      .locator('[data-workspace-file-tree]')
      .getByRole('link', { name: fileName })
      .getByLabel('Done', { exact: true });
    const filesTab = editorPage.getByRole('button', {
      exact: true,
      name: 'Files',
    });
    try {
      await editorPage.goto(`/workspaces/${workspaceId}`);
      await filesTab.click();
      await expect(
        editorPage
          .locator('[data-workspace-file-tree]')
          .getByRole('link', { name: fileName })
      ).toBeVisible();
      await expect(doneMark).toHaveCount(0);

      const marked = waitForApi(
        editorPage,
        apiEndsWith(`/api/workspaces/${workspaceId}/study/items`, 'PUT')
      );
      await openRowMenu(editorPage, fileName);
      await editorPage
        .getByRole('menuitem', { exact: true, name: 'Mark as read' })
        .click();
      const response = await marked;
      expect(response.status()).toBe(204);
      expect(response.request().postDataJSON()).toEqual({
        fileId: file.id,
        state: 'done',
      });
      await expect(doneMark).toBeVisible();

      // The mark is the server's record, not local state.
      await editorPage.reload();
      await filesTab.click();
      await expect(doneMark).toBeVisible();

      await openRowMenu(editorPage, fileName);
      await editorPage
        .getByRole('menuitem', { exact: true, name: 'Mark as unread' })
        .click();
      await expect(doneMark).toHaveCount(0);

      // The open file's header toggles the same record.
      await editorPage
        .locator('[data-workspace-file-tree]')
        .getByRole('link', { name: fileName })
        .click();
      await expect(editorPage).toHaveURL(
        new RegExp(`[?&]file=${file.id}(&|$)`)
      );
      const header = editorPage.getByTestId('content-header');
      let put = waitForApi(
        editorPage,
        apiEndsWith(`/api/workspaces/${workspaceId}/study/items`, 'PUT')
      );
      await header.getByRole('button', { name: 'Mark as read' }).click();
      expect((await put).status()).toBe(204);
      await expect(
        header.getByRole('button', { name: 'Mark as unread' })
      ).toBeVisible();
      await expect(doneMark).toBeVisible();
      expect(stateOf(await readStudy(editorApi, workspaceId), file.id)).toBe(
        'done'
      );
      put = waitForApi(
        editorPage,
        apiEndsWith(`/api/workspaces/${workspaceId}/study/items`, 'PUT')
      );
      await header.getByRole('button', { name: 'Mark as unread' }).click();
      expect((await put).status()).toBe(204);
      await expect(
        header.getByRole('button', { name: 'Mark as read' })
      ).toBeVisible();
      await expect(doneMark).toHaveCount(0);
      expect(
        stateOf(await readStudy(editorApi, workspaceId), file.id)
      ).toBeUndefined();
    } finally {
      await setStudyItem(editorApi, workspaceId, { fileId: file.id });
    }
  });

  test('Continue opens the next item that is neither done nor removed', async ({
    materialFactory,
    ownerApi,
    ownerPage,
    workspaceFactory,
  }) => {
    const ws = await workspaceFactory.create({
      name: `E2E Study Continue ${randomUUID()}`,
    });
    const note = (title: string) =>
      materialFactory.createNote({
        blockId: `${title.toLowerCase().replace(/\s/g, '_')}_body`,
        body: `${title} body`,
        title,
        workspaceId: ws.id,
      });
    const one = await addChapter(ownerApi, ws.id, 'Chapter one');
    const two = await addChapter(ownerApi, ws.id, 'Chapter two');
    const read = await note('Read note');
    const skipped = await note('Skipped note');
    const next = await note('Next note');
    const later = await note('Later note');
    await placeInChapter(ownerApi, ws.id, one.id, [read.id, skipped.id]);
    await placeInChapter(ownerApi, ws.id, two.id, [next.id, later.id]);
    await setStudyItem(ownerApi, ws.id, { materialId: read.id }, 'done');
    await setStudyItem(ownerApi, ws.id, { materialId: skipped.id }, 'removed');

    // The Study tab is open when no item is.
    await ownerPage.goto(`/workspaces/${ws.id}`);
    // Up next is the row holding Continue; the Files panel lists the same
    // titles, so match inside that row only.
    const continueButton = ownerPage.getByRole('button', {
      exact: true,
      name: 'Continue',
    });
    const upNext = continueButton.locator('xpath=..');
    await expect(upNext.getByText(next.title, { exact: true })).toBeVisible();
    await continueButton.click();
    await expect(ownerPage).toHaveURL(
      new RegExp(`[?&]material=${next.id}(&|$)`)
    );
    await expect(
      ownerPage.getByRole('heading', { exact: true, name: next.title })
    ).toBeVisible();

    // Reading it moves Continue on to the item after it.
    await ownerPage.getByRole('button', { name: 'Mark as read' }).click();
    await expect(upNext.getByText(later.title, { exact: true })).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Mark as unread' })
    ).toBeVisible();
  });

  test('quizzes and flashcard sets go started and done, Continue skips the done ones, and Learning counts them', async ({
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
    // Week 1 is finished by the steps below; Week 2 is only started.
    const one = await addChapter(ownerApi, ws.id, 'Week 1');
    const two = await addChapter(ownerApi, ws.id, 'Week 2');
    await placeInChapter(ownerApi, ws.id, one.id, [
      finishedQuiz.id,
      finishedSet.id,
    ]);
    await placeInChapter(ownerApi, ws.id, two.id, [
      startedQuiz.id,
      startedSet.id,
    ]);

    // A quiz answered in part and left: nothing reaches the server.
    await ownerPage.goto(`/quizzes/${startedQuiz.id}/attempt`);
    await ownerPage
      .getByRole('button', { exact: true, name: 'True' })
      .first()
      .click();
    await expect(ownerPage.getByText('1 of 2 answered')).toBeVisible();
    // Another submitted: one right, one wrong.
    await ownerPage.goto(`/quizzes/${finishedQuiz.id}/attempt`);
    const trueButtons = ownerPage.getByRole('button', {
      exact: true,
      name: 'True',
    });
    await trueButtons.nth(0).click();
    await trueButtons.nth(1).click();
    await expect(ownerPage.getByText('2 of 2 answered')).toBeVisible();
    const submitted = waitForApi(
      ownerPage,
      apiEndsWith(`/api/quizzes/${finishedQuiz.id}/attempts`, 'POST')
    );
    await ownerPage
      .getByRole('button', { exact: true, name: 'Submit answers' })
      .click();
    expect((await submitted).status()).toBe(201);
    await expect(
      ownerPage.getByRole('button', { name: 'Redo quiz' })
    ).toBeVisible();

    // A set studied to the end: Again sends the first card to the back.
    await ownerPage.goto(`/flashcards/${finishedSet.id}`);
    const showAnswer = ownerPage.getByRole('button', { name: 'Show answer' });
    await showAnswer.click();
    for (const tile of ['Again', 'Hard', 'Good', 'Easy']) {
      await expect(
        ownerPage.getByRole('button', { exact: true, name: tile })
      ).toBeVisible();
    }
    await rate(ownerPage, 'Again');
    await showAnswer.click();
    await rate(ownerPage, 'Good');
    await expect(ownerPage.getByText(faces[0][0])).toBeVisible();
    await showAnswer.click();
    await rate(ownerPage, 'Good');
    await expect(
      ownerPage.getByRole('heading', { name: 'Done for now' })
    ).toBeVisible();
    // Another left after its first card.
    await ownerPage.goto(`/flashcards/${startedSet.id}`);
    await showAnswer.click();
    await rate(ownerPage, 'Easy');

    const study = await readStudy(ownerApi, ws.id);
    expect(stateOf(study, finishedQuiz.id)).toBe('done');
    expect(stateOf(study, startedQuiz.id)).toBeUndefined();
    expect(stateOf(study, finishedSet.id)).toBe('done');
    expect(stateOf(study, startedSet.id)).toBe('started');
    expect(
      study.recentAttempts.map(({ correct, materialId, total }) => ({
        correct,
        materialId,
        total,
      }))
    ).toEqual([{ correct: 1, materialId: finishedQuiz.id, total: 2 }]);
    // Both questions of the attempt, both finished cards, one started card.
    expect(study.reviewable).toBe(5);

    // Continue passes Week 1 and opens the quiz that was only started.
    await ownerPage.goto(`/workspaces/${ws.id}`);
    const continueButton = ownerPage.getByRole('button', {
      exact: true,
      name: 'Continue',
    });
    await expect(
      continueButton.locator('xpath=..').getByText(startedQuiz.title)
    ).toBeVisible();
    await continueButton.click();
    await expect(ownerPage).toHaveURL(
      new RegExp(`[?&]material=${startedQuiz.id}(&|$)`)
    );

    // Learning → Review: five to review, 2 of 4 done, and its Review opens
    // the session.
    await ownerPage.goto('/learning');
    const row = ownerPage
      .getByText(ws.name, { exact: true })
      .locator('xpath=ancestor::div[.//button[normalize-space()="Review"]][1]');
    await expect(row.getByText('5', { exact: true })).toBeVisible();
    await expect(row.getByText('2 of 4', { exact: true })).toBeVisible();
    await row.getByRole('button', { exact: true, name: 'Review' }).click();
    await expect(ownerPage).toHaveURL(
      `/learning/review/${ws.id}?from=learning`
    );
    await expect(ownerPage.getByText('5 left')).toBeVisible();
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

    await ownerPage.goto(`/workspaces/${ws.id}`);
    await ownerPage
      .getByRole('button', { exact: true, name: 'Review' })
      .click();
    await expect(ownerPage).toHaveURL(
      `/learning/review/${ws.id}?from=workspace`
    );
    await expect(ownerPage.getByText('2 left')).toBeVisible();

    const ratings: Record<string, unknown>[] = [];
    ownerPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/review/ratings'))
        ratings.push(req.postDataJSON());
    });

    await expect(ownerPage.getByText('Review front')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Show answer' }).click();
    await expect(ownerPage.getByText('Review back')).toBeVisible();
    const cardRated = waitForApi(
      ownerPage,
      apiEndsWith('/api/review/ratings', 'POST')
    );
    await ownerPage.getByRole('button', { exact: true, name: 'Good' }).click();
    expect((await cardRated).status()).toBe(204);

    await expect(ownerPage.getByText(prompt)).toBeVisible();
    await expect(ownerPage.getByText('1 left')).toBeVisible();
    // The question arrives answer-free; Check returns its key and rates it.
    await ownerPage.getByRole('button', { exact: true, name: 'True' }).click();
    const questionChecked = waitForApi(
      ownerPage,
      apiEndsWith('/api/review/check', 'POST')
    );
    await ownerPage.getByRole('button', { exact: true, name: 'Check' }).click();
    const checked = await questionChecked;
    expect(checked.status()).toBe(200);
    expect(checked.request().postDataJSON()).toEqual({
      answers: { [`${questionId}:part:1`]: true },
      itemId: questionId,
      materialId: quiz.id,
    });
    await expect(ownerPage.getByText('Your answer')).toBeVisible();
    await ownerPage.getByRole('button', { exact: true, name: 'Next' }).click();

    await expect(ownerPage.getByText('2 reviewed')).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Review 20 more' })
    ).toBeVisible();
    expect(ratings).toEqual([
      { itemId: cardId, materialId: cards.id, rating: 3 },
    ]);

    // Done returns to where the session started.
    await ownerPage.getByRole('button', { exact: true, name: 'Done' }).click();
    await expect(ownerPage).toHaveURL(new RegExp(`/workspaces/${ws.id}$`));
  });
});
