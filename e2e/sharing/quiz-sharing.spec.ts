import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('quiz sharing', () => {
  test('New quiz opens an editable draft', async ({ ownerApi, ownerPage }) => {
    await ownerPage.goto('/create');
    const created = waitForApi(ownerPage, apiEndsWith('/api/quizzes', 'POST'));
    await ownerPage
      .getByRole('button', { exact: true, name: 'New Materials' })
      .click();
    await ownerPage
      .getByRole('menuitem', { exact: true, name: 'Quiz' })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    const quiz = await response.json();
    try {
      await expect(ownerPage).toHaveURL(`/quizzes/${quiz.id}/edit`);
      await expect(
        ownerPage.getByRole('button', { exact: true, name: 'Save' })
      ).toBeEnabled();
    } finally {
      expect((await ownerApi.delete(`/api/quizzes/${quiz.id}`)).status()).toBe(
        204
      );
    }
  });

  test('owner can open a private quiz', async ({ ownerPage, seed }) => {
    const resPromise = waitForApi(
      ownerPage,
      apiEndsWith(`/api/quizzes/${seed.privateQuiz.id}`)
    );
    await ownerPage.goto(`/share/quizzes/${seed.privateQuiz.id}`);
    expect((await resPromise).status()).toBe(200);
    await expect(ownerPage.getByText(seed.privateQuiz.prompt)).toBeVisible();
  });

  test('anonymous visitors open link and public quizzes only through signed links', async ({
    anonymousApi,
    anonymousPage,
    ownerApi,
    seed,
  }) => {
    const sharePath = async (id: string) =>
      (await (await ownerApi.get(`/api/quizzes/${id}`)).json())
        .sharePath as string;
    // The authenticated API stays closed; signed-out reads use the share route.
    for (const quiz of [seed.privateQuiz, seed.linkQuiz, seed.publicQuiz]) {
      const response = await anonymousApi.get(`/api/quizzes/${quiz.id}`);
      expect(response.status()).toBe(401);
    }
    // No Clerk in e2e, so ?anonymous selects the signed-out page.
    for (const quiz of [seed.linkQuiz, seed.publicQuiz]) {
      await anonymousPage.goto(`${await sharePath(quiz.id)}?anonymous`);
      await expect(anonymousPage.getByText(quiz.prompt)).toBeVisible();
      await expect(
        anonymousPage.getByRole('button', { name: 'Clone' })
      ).toHaveCount(0);
      // The public header, not the app's top bar.
      await expect(
        anonymousPage.getByRole('link', { name: 'Sign up' })
      ).toBeVisible();
      await expect(
        anonymousPage.getByRole('button', { name: 'Notifications' })
      ).toHaveCount(0);
    }
    // The private seed quiz sits in a workspace and has no share link, so a
    // private standalone quiz stands in for "signed but private".
    const created = await ownerApi.post('/api/quizzes', {
      data: { name: 'E2E private standalone quiz' },
    });
    expect(created.status()).toBe(201);
    const privateQuiz = await created.json();
    try {
      for (const path of [
        `${privateQuiz.sharePath}?anonymous`,
        `/share/quizzes/${seed.linkQuiz.id}?anonymous`,
      ]) {
        await anonymousPage.goto(path);
        await expect(
          anonymousPage.getByTestId('private-or-unavailable')
        ).toBeVisible();
        await expect(anonymousPage.getByText(seed.linkQuiz.prompt)).toHaveCount(
          0
        );
      }
    } finally {
      expect(
        (await ownerApi.delete(`/api/quizzes/${privateQuiz.id}`)).status()
      ).toBe(204);
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
