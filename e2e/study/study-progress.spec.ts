import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import type { Chapter, SourceFile } from '../../src/api/types';
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
  test('Mark as read shows the done check on the file panel row', async ({
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

  test('a mixed review session rates a flashcard and a question, then ends', async ({
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
    for (const data of [
      { itemId: questionId, materialId: quiz.id, score: 1 },
      { itemId: cardId, materialId: cards.id, rating: 1 },
    ]) {
      const res = await ownerApi.post('/api/review/ratings', { data });
      expect(res.status()).toBe(204);
    }

    await ownerPage.goto(`/workspaces/${ws.id}`);
    const review = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { exact: true, name: 'Review' }),
    });
    await expect(
      review.getByText('2 questions and cards in progress')
    ).toBeVisible();
    await review.getByRole('button', { exact: true, name: 'Review' }).click();
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
    await ownerPage.getByRole('button', { exact: true, name: 'True' }).click();
    const questionRated = waitForApi(
      ownerPage,
      apiEndsWith('/api/review/ratings', 'POST')
    );
    await ownerPage.getByRole('button', { exact: true, name: 'Check' }).click();
    expect((await questionRated).status()).toBe(204);
    await expect(ownerPage.getByText('Your answer')).toBeVisible();
    await ownerPage.getByRole('button', { exact: true, name: 'Next' }).click();

    await expect(ownerPage.getByText('2 reviewed')).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Review 20 more' })
    ).toBeVisible();
    expect(ratings).toEqual([
      { itemId: cardId, materialId: cards.id, rating: 3 },
      { itemId: questionId, materialId: quiz.id, score: 1 },
    ]);

    // Done returns to where the session started.
    await ownerPage.getByRole('button', { exact: true, name: 'Done' }).click();
    await expect(ownerPage).toHaveURL(new RegExp(`/workspaces/${ws.id}$`));
  });
});
