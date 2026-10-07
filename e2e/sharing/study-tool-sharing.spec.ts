import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { seed } from '../fixtures/seed';
import { apiEndsWith, waitForApi } from '../helpers/api';
import { m } from '../i18n';

// What visitors see on shared quizzes and flashcard sets. The authorization
// rules behind it (anonymous 401s, stranger 404s, clone and attempt gates) are
// asserted in Go: server/internal/httpapi/share_access_test.go.

type Seeded = { id: string; name: string; text: string };

const kinds = [
  {
    api: '/api/quizzes',
    clone: m.action_clone_quiz(),
    // A standalone quiz is deleted through its own route.
    deletePath: (id: string) => `/api/quizzes/${id}`,
    explore: { api: '/api/explore/quizzes', tab: m.explore_tab_quizzes() },
    kind: 'quiz',
    link: { ...seed.linkQuiz, text: seed.linkQuiz.prompt },
    private: { ...seed.privateQuiz, text: seed.privateQuiz.prompt },
    public: { ...seed.publicQuiz, text: seed.publicQuiz.prompt },
    share: '/share/quizzes',
  },
  {
    api: '/api/flashcards',
    clone: m.action_clone_flashcards(),
    deletePath: (id: string) => `/api/materials/${id}`,
    explore: {
      api: '/api/explore/flashcards',
      tab: m.explore_tab_flashcards(),
    },
    kind: 'flashcards',
    link: { ...seed.linkFlashcardSet, text: seed.linkFlashcardSet.front },
    private: {
      ...seed.privateFlashcardSet,
      text: seed.privateFlashcardSet.front,
    },
    public: { ...seed.publicFlashcardSet, text: seed.publicFlashcardSet.front },
    share: '/share/flashcards',
  },
] as const;

/** ⋮ → Clone opens the dashboard's dialog, which clones on confirm. */
async function cloneThroughDashboard(page: Page, label: string) {
  await page.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: label }).click();
  await page.waitForURL((url) => url.searchParams.has('clone'));
  await page
    .getByRole('dialog', { name: label })
    .getByRole('button', { exact: true, name: m.action_clone() })
    .click();
}

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
    .getByRole('button', { exact: true, name: m.files_new_block() })
    .click();
  await ownerPage
    .getByRole('menuitem', { exact: true, name: m.editor_quiz() })
    .click();
  const response = await created;
  expect(response.status()).toBe(201);
  const quiz = await response.json();
  try {
    await expect(ownerPage).toHaveURL(`/quizzes/${quiz.id}/edit`);
    await expect(
      ownerPage.getByRole('button', { exact: true, name: m.action_save() })
    ).toBeEnabled();
  } finally {
    expect((await ownerApi.delete(`/api/quizzes/${quiz.id}`)).status()).toBe(
      204
    );
  }
});

for (const kind of kinds) {
  test.describe(`${kind.kind} sharing`, () => {
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
        // The same ⋮ and header for every visitor; neither reads the session.
        await expect(
          anonymousPage.getByRole('button', { name: m.a11y_open_menu() })
        ).toBeVisible();
        await expect(
          anonymousPage.getByRole('link', { name: m.summary_sign_up() })
        ).toHaveAttribute('href', '/sign-up');
        await expect(anonymousPage.locator('[data-unread-count]')).toHaveCount(
          0
        );
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
            anonymousPage.getByRole('heading', {
              name: m.error_not_found_page_title(),
            })
          ).toBeVisible();
          await expect(anonymousPage.getByText(kind.link.text)).toHaveCount(0);
        }
      } finally {
        expect(
          (await ownerApi.delete(kind.deletePath(privateItem.id))).status()
        ).toBe(204);
      }
    });

    test('a signed-in visitor sees an unsigned link as not found', async ({
      otherPage,
    }) => {
      // The Worker answers unsigned links with the 404 page, whoever is signed in.
      await otherPage.goto(`${kind.share}/${kind.private.id}`);
      await expect(
        otherPage.getByRole('heading', { name: m.error_not_found_page_title() })
      ).toBeVisible();
      await expect(otherPage.getByText(kind.private.text)).toHaveCount(0);
    });

    test('signed-in visitors read link and public ones from the shared data and save to their account', async ({
      otherPage,
      ownerApi,
    }) => {
      for (const item of [kind.link, kind.public]) {
        const path = await sharePath(ownerApi, kind.api, item);
        const response = waitForApi(
          otherPage,
          apiEndsWith(path.replace('/share/', '/p/'))
        );
        await otherPage.goto(path);
        const read = await response;
        expect(read.status()).toBe(200);
        if (kind.kind === 'quiz') {
          // Taking reads no answer key.
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
          otherPage.getByRole('link', { name: m.summary_sign_up() })
        ).toBeVisible();
      }
      // The session is read only when saving: signed in, it goes to the account.
      if (kind.kind === 'quiz') {
        const saved = waitForApi(
          otherPage,
          apiEndsWith(`/api/quizzes/${kind.public.id}/attempts`, 'POST')
        );
        await otherPage
          .getByRole('button', { exact: true, name: m.quiz_submit() })
          .click();
        expect((await saved).status()).toBe(201);
      } else {
        const saved = waitForApi(
          otherPage,
          apiEndsWith('/api/review/ratings', 'POST')
        );
        await otherPage
          .getByRole('button', { name: m.flashcards_show_answer() })
          .click();
        await otherPage.getByRole('button', { name: m.srs_good() }).click();
        expect((await saved).ok()).toBe(true);
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
      ownerApi,
    }) => {
      for (const item of [kind.link, kind.public]) {
        const cloned = waitForApi(
          otherPage,
          apiEndsWith(`${kind.api}/${item.id}/clone`, 'POST')
        );
        await otherPage.goto(await sharePath(ownerApi, kind.api, item));
        await cloneThroughDashboard(otherPage, kind.clone);
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

test('a link note opens for signed-out visitors and clones for signed-in ones', async ({
  anonymousPage,
  otherApi,
  otherPage,
  ownerApi,
}) => {
  const body = `E2E shared note ${Date.now()}`;
  const created = await ownerApi.post('/api/materials', {
    data: {
      content: {
        schemaVersion: 1,
        value: [{ children: [{ text: body }], id: 'body', type: 'p' }],
      },
      kind: 'note',
      title: body,
    },
  });
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string };
  try {
    const shared = await ownerApi.patch(`/api/materials/${note.id}/sharing`, {
      data: { privacy: 'link' },
    });
    expect(shared.status()).toBe(200);
    const list = (await (await ownerApi.get('/api/materials')).json()) as {
      items: { id: string; sharePath?: string }[];
    };
    const path = list.items.find((item) => item.id === note.id)?.sharePath;
    expect(path).toMatch(/^\/share\/notes\//);

    await anonymousPage.goto(`${path}?anonymous`);
    await expect(anonymousPage.getByText(body).first()).toBeVisible();

    const cloned = waitForApi(
      otherPage,
      apiEndsWith(`/api/materials/${note.id}/clone`, 'POST')
    );
    await otherPage.goto(path as string);
    await cloneThroughDashboard(otherPage, m.action_clone_note());
    const response = await cloned;
    expect(response.status()).toBe(201);
    const copy = (await response.json()) as { id: string };
    await expect(otherPage).toHaveURL(`/materials/${copy.id}`);
    expect((await otherApi.delete(`/api/materials/${copy.id}`)).status()).toBe(
      204
    );
  } finally {
    await ownerApi.delete(`/api/materials/${note.id}`);
  }
});
