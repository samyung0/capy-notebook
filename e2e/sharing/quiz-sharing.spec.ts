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

  test('anonymous full reads require sign-in for every visibility', async ({
    anonymousApi,
    anonymousPage,
    seed,
  }) => {
    for (const quiz of [seed.privateQuiz, seed.linkQuiz, seed.publicQuiz]) {
      const response = await anonymousApi.get(`/api/quizzes/${quiz.id}`);
      expect(response.status()).toBe(401);
      expect(await response.text()).not.toContain(quiz.prompt);
      await anonymousPage.goto(`/share/quizzes/${quiz.id}`);
      await expect(
        anonymousPage.getByTestId('private-or-unavailable')
      ).toBeVisible();
      await expect(anonymousPage.getByText(quiz.prompt)).toHaveCount(0);
      await expect(
        anonymousPage.getByRole('button', { name: 'Clone' })
      ).toHaveCount(0);
    }
  });

  test('signed-in non-member cannot open a private quiz', async ({
    otherPage,
    seed,
  }) => {
    const response = waitForApi(
      otherPage,
      apiEndsWith(`/api/quizzes/${seed.privateQuiz.id}`)
    );
    await otherPage.goto(`/share/quizzes/${seed.privateQuiz.id}`);
    expect((await response).status()).toBe(404);
    await expect(otherPage.getByTestId('private-or-unavailable')).toBeVisible();
    await expect(otherPage.getByText(seed.privateQuiz.prompt)).toHaveCount(0);
  });

  test('link and public quizzes are readable by signed-in viewers; only public appears on Explore', async ({
    otherPage,
    seed,
  }) => {
    const linkRes = waitForApi(
      otherPage,
      apiEndsWith(`/api/quizzes/${seed.linkQuiz.id}`)
    );
    await otherPage.goto(`/share/quizzes/${seed.linkQuiz.id}`);
    expect((await linkRes).status()).toBe(200);
    await expect(otherPage.getByText(seed.linkQuiz.prompt)).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Clone' })
    ).toBeVisible();

    const publicRes = waitForApi(
      otherPage,
      apiEndsWith(`/api/quizzes/${seed.publicQuiz.id}`)
    );
    await otherPage.goto(`/share/quizzes/${seed.publicQuiz.id}`);
    expect((await publicRes).status()).toBe(200);
    await expect(otherPage.getByText(seed.publicQuiz.prompt)).toBeVisible();

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

  test('signed-in viewer can clone public and link quizzes to private copies', async ({
    otherApi,
    otherPage,
    seed,
  }) => {
    for (const quiz of [seed.linkQuiz, seed.publicQuiz]) {
      const clonePromise = waitForApi(
        otherPage,
        apiEndsWith(`/api/quizzes/${quiz.id}/clone`, 'POST')
      );
      await otherPage.goto(`/share/quizzes/${quiz.id}`);
      await otherPage.getByRole('button', { name: 'Clone' }).click();
      const response = await clonePromise;
      expect(response.status()).toBe(201);
      const body = await response.json();
      try {
        expect(body.privacy).toBe('private');
        expect(body.isOwner).toBe(true);
      } finally {
        expect(
          (await otherApi.delete(`/api/quizzes/${body.id}`)).status()
        ).toBe(204);
      }
    }
  });

  test('anonymous clone and attempt require sign-in', async ({
    anonymousApi,
    seed,
  }) => {
    for (const quiz of [seed.privateQuiz, seed.linkQuiz, seed.publicQuiz]) {
      const clone = await anonymousApi.post(`/api/quizzes/${quiz.id}/clone`, {
        data: {},
      });
      expect(clone.status()).toBe(401);
      const attempt = await anonymousApi.post(
        `/api/quizzes/${quiz.id}/attempts`,
        {
          data: { answers: {}, correct: 0, questions: [], total: 1, wrong: [] },
        }
      );
      expect(attempt.status()).toBe(401);
    }
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
