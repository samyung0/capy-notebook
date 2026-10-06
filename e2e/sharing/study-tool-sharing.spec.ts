import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { seed } from '../fixtures/seed';
import { apiEndsWith, waitForApi } from '../helpers/api';

// What visitors see on shared quizzes and flashcard sets. The authorization
// rules behind it (anonymous 401s, stranger 404s, clone and attempt gates) are
// asserted in Go: server/internal/httpapi/share_access_test.go.

type Seeded = { id: string; name: string; text: string };

const kinds = [
  {
    api: '/api/quizzes',
    clone: 'Clone',
    // A standalone quiz is deleted through its own route.
    deletePath: (id: string) => `/api/quizzes/${id}`,
    explore: { api: '/api/explore/quizzes', tab: /Public quizzes/i },
    kind: 'quiz',
    link: { ...seed.linkQuiz, text: seed.linkQuiz.prompt },
    ownerControls: [],
    private: { ...seed.privateQuiz, text: seed.privateQuiz.prompt },
    public: { ...seed.publicQuiz, text: seed.publicQuiz.prompt },
    share: '/share/quizzes',
  },
  {
    api: '/api/flashcards',
    clone: 'Clone flashcards',
    deletePath: (id: string) => `/api/materials/${id}`,
    explore: { api: '/api/explore/flashcards', tab: /Flashcards/i },
    kind: 'flashcards',
    link: { ...seed.linkFlashcardSet, text: seed.linkFlashcardSet.front },
    ownerControls: ['Share flashcards', /Add card/i],
    private: {
      ...seed.privateFlashcardSet,
      text: seed.privateFlashcardSet.front,
    },
    public: { ...seed.publicFlashcardSet, text: seed.publicFlashcardSet.front },
    share: '/share/flashcards',
  },
] as const;

async function sharePath(
  ownerApi: APIRequestContext,
  api: string,
  item: Seeded
) {
  return (await (await ownerApi.get(`${api}/${item.id}`)).json())
    .sharePath as string;
}

test('New quiz opens an editable draft', async ({ ownerApi, ownerPage }) => {
  await ownerPage.goto('/files?tab=blocks');
  const created = waitForApi(ownerPage, apiEndsWith('/api/quizzes', 'POST'));
  await ownerPage
    .getByRole('button', { exact: true, name: 'New block' })
    .click();
  await ownerPage.getByRole('menuitem', { exact: true, name: 'Quiz' }).click();
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

for (const kind of kinds) {
  test.describe(`${kind.kind} sharing`, () => {
    test('the owner opens a private one', async ({ ownerPage }) => {
      const response = waitForApi(
        ownerPage,
        apiEndsWith(`${kind.api}/${kind.private.id}`)
      );
      await ownerPage.goto(`${kind.share}/${kind.private.id}`);
      expect((await response).status()).toBe(200);
      await expect(ownerPage.getByText(kind.private.text)).toBeVisible();
    });

    test('signed-out visitors open link and public ones only through signed links', async ({
      anonymousPage,
      ownerApi,
    }) => {
      // No Clerk in e2e, so ?anonymous selects the signed-out page.
      for (const item of [kind.link, kind.public]) {
        await anonymousPage.goto(
          `${await sharePath(ownerApi, kind.api, item)}?anonymous`
        );
        await expect(anonymousPage.getByText(item.text)).toBeVisible();
        await expect(
          anonymousPage.getByRole('button', { name: kind.clone })
        ).toHaveCount(0);
        // The public header, not the app's top bar.
        await expect(
          anonymousPage.getByRole('link', { name: 'Sign up' })
        ).toBeVisible();
        await expect(
          anonymousPage.getByRole('button', { name: 'Notifications' })
        ).toHaveCount(0);
      }
      // The private seed sits in a workspace and has no share link, so a
      // private standalone one stands in for "signed but private".
      const created = await ownerApi.post(kind.api, {
        data: { name: `E2E private standalone ${kind.kind}` },
      });
      expect(created.status()).toBe(201);
      const privateItem = await created.json();
      try {
        for (const path of [
          `${privateItem.sharePath}?anonymous`,
          `${kind.share}/${kind.link.id}?anonymous`,
        ]) {
          await anonymousPage.goto(path);
          await expect(
            anonymousPage.getByTestId('private-or-unavailable')
          ).toBeVisible();
          await expect(anonymousPage.getByText(kind.link.text)).toHaveCount(0);
        }
      } finally {
        expect(
          (await ownerApi.delete(kind.deletePath(privateItem.id))).status()
        ).toBe(204);
      }
    });

    test('a signed-in non-member sees a private one as unavailable', async ({
      otherPage,
    }) => {
      const response = waitForApi(
        otherPage,
        apiEndsWith(`${kind.api}/${kind.private.id}`)
      );
      await otherPage.goto(`${kind.share}/${kind.private.id}`);
      expect((await response).status()).toBe(404);
      await expect(
        otherPage.getByTestId('private-or-unavailable')
      ).toBeVisible();
      await expect(otherPage.getByText(kind.private.text)).toHaveCount(0);
    });

    test('signed-in visitors read link and public ones without owner controls', async ({
      otherPage,
    }) => {
      for (const item of [kind.link, kind.public]) {
        const response = waitForApi(
          otherPage,
          apiEndsWith(`${kind.api}/${item.id}`)
        );
        await otherPage.goto(`${kind.share}/${item.id}`);
        const read = await response;
        expect(read.status()).toBe(200);
        if (kind.kind === 'quiz') {
          // Viewing and taking read no answer key.
          const { questions } = await read.json();
          expect(questions.length).toBeGreaterThan(0);
          expect(JSON.stringify(questions)).not.toMatch(
            /"(correct|accepted|pairs|solution|markscheme)"/
          );
        }
        await expect(otherPage.getByText(item.text)).toBeVisible();
        if (kind.kind === 'flashcards')
          await expect(otherPage.getByText(item.name)).toBeVisible();
        await expect(
          otherPage.getByRole('button', { name: kind.clone })
        ).toBeVisible();
        for (const label of kind.ownerControls) {
          await expect(otherPage.getByLabel(label)).toHaveCount(0);
        }
      }
    });

    test('only public ones appear on Explore', async ({ otherPage }) => {
      const explore = waitForApi(otherPage, apiEndsWith(kind.explore.api));
      await otherPage.goto('/explore');
      await otherPage.getByRole('button', { name: kind.explore.tab }).click();
      expect((await explore).status()).toBe(200);
      await expect(otherPage.getByText(kind.public.name)).toBeVisible();
      await expect(otherPage.getByText(kind.link.name)).toHaveCount(0);
      await expect(otherPage.getByText(kind.private.name)).toHaveCount(0);
    });

    test('signed-in visitors clone link and public ones to private copies', async ({
      otherApi,
      otherPage,
    }) => {
      for (const item of [kind.link, kind.public]) {
        const cloned = waitForApi(
          otherPage,
          apiEndsWith(`${kind.api}/${item.id}/clone`, 'POST')
        );
        await otherPage.goto(`${kind.share}/${item.id}`);
        await otherPage.getByRole('button', { name: kind.clone }).click();
        const response = await cloned;
        expect(response.status()).toBe(201);
        const body = await response.json();
        try {
          expect(body.privacy).toBe('private');
          expect(body.isOwner).toBe(true);
        } finally {
          expect(
            (await otherApi.delete(kind.deletePath(body.id))).status()
          ).toBe(204);
        }
      }
    });
  });
}
