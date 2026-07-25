import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('quiz sharing', () => {
  test('owner can open a private quiz', async ({ ownerPage, seed }) => {
    const resPromise = waitForApi(
      ownerPage,
      apiEndsWith(`/api/quizzes/${seed.privateQuiz.id}`)
    );
    await ownerPage.goto(`/share/quizzes/${seed.privateQuiz.id}`);
    expect((await resPromise).status()).toBe(200);
    await expect(ownerPage.getByText(seed.privateQuiz.prompt)).toBeVisible();
  });

  test('anonymous and non-member cannot open a private quiz', async ({
    anonymousPage,
    otherPage,
    seed,
  }) => {
    for (const page of [anonymousPage, otherPage]) {
      const resPromise = waitForApi(
        page,
        apiEndsWith(`/api/quizzes/${seed.privateQuiz.id}`)
      );
      await page.goto(`/share/quizzes/${seed.privateQuiz.id}`);
      expect((await resPromise).status()).toBe(404);
      await expect(page.getByTestId('private-or-unavailable')).toBeVisible();
      await expect(page.getByText(seed.privateQuiz.prompt)).toHaveCount(0);
    }
  });

  test('link and public quizzes are readable; only public appears on Explore', async ({
    anonymousPage,
    otherPage,
    seed,
  }) => {
    const linkRes = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/quizzes/${seed.linkQuiz.id}`)
    );
    await anonymousPage.goto(`/share/quizzes/${seed.linkQuiz.id}`);
    expect((await linkRes).status()).toBe(200);
    await expect(anonymousPage.getByText(seed.linkQuiz.prompt)).toBeVisible();
    await expect(
      anonymousPage.getByRole('button', { name: 'Clone' })
    ).toBeVisible();

    const publicRes = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/quizzes/${seed.publicQuiz.id}`)
    );
    await anonymousPage.goto(`/share/quizzes/${seed.publicQuiz.id}`);
    expect((await publicRes).status()).toBe(200);
    await expect(anonymousPage.getByText(seed.publicQuiz.prompt)).toBeVisible();

    const exploreRes = waitForApi(
      otherPage,
      apiEndsWith('/api/explore/quizzes')
    );
    await otherPage.goto('/explore');
    await otherPage.getByRole('button', { name: /Public quizzes/i }).click();
    expect((await exploreRes).status()).toBe(200);
    await expect(otherPage.getByText(seed.publicQuiz.name)).toBeVisible();
    await expect(otherPage.getByText(seed.linkQuiz.name)).toHaveCount(0);
    await expect(otherPage.getByText(seed.privateQuiz.name)).toHaveCount(0);
  });

  test('signed-in viewer can clone a shared quiz to a private copy', async ({
    otherApi,
    otherPage,
    seed,
  }) => {
    const clonePromise = waitForApi(
      otherPage,
      apiEndsWith(`/api/quizzes/${seed.linkQuiz.id}/clone`, 'POST')
    );
    await otherPage.goto(`/share/quizzes/${seed.linkQuiz.id}`);
    await otherPage.getByRole('button', { name: 'Clone' }).click();
    const res = await clonePromise;
    expect(res.status()).toBe(201);
    const body = await res.json();
    try {
      expect(body.privacy).toBe('private');
      expect(body.isOwner).toBe(true);
    } finally {
      const removedClone = await otherApi.delete(`/api/quizzes/${body.id}`);
      expect(removedClone.status()).toBe(204);
    }
  });

  test('anonymous clone and attempt require sign-in', async ({
    anonymousPage,
    seed,
  }) => {
    await anonymousPage.goto(`/share/quizzes/${seed.linkQuiz.id}`);
    const clonePromise = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/quizzes/${seed.linkQuiz.id}/clone`, 'POST')
    );
    await anonymousPage.getByRole('button', { name: 'Clone' }).click();
    expect((await clonePromise).status()).toBe(401);
    await expect(anonymousPage.getByText('Sign in to clone')).toBeVisible();

    // Boolean question: pick True then Finish.
    await anonymousPage.getByRole('button', { name: /^True$/i }).click();
    const attemptPromise = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/quizzes/${seed.linkQuiz.id}/attempts`, 'POST')
    );
    await anonymousPage.getByRole('button', { name: 'Finish' }).click();
    expect((await attemptPromise).status()).toBe(401);
    await expect(
      anonymousPage.getByText(/Sign in to save your score/i)
    ).toBeVisible();
    await expect(
      anonymousPage.getByTestId('private-or-unavailable')
    ).toHaveCount(0);
  });

  test('non-member cannot record an attempt on a private quiz', async ({
    otherApi,
    seed,
  }) => {
    const res = await otherApi.post(
      `/api/quizzes/${seed.privateQuiz.id}/attempts`,
      {
        data: {
          answers: {},
          correct: 0,
          questions: [],
          total: 1,
          wrong: [],
        },
      }
    );
    expect(res.status()).toBe(404);
  });
});
