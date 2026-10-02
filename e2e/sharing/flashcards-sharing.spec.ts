import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('flashcards sharing', () => {
  test('anonymous visitors study link and public flashcards only through signed links', async ({
    anonymousApi,
    anonymousPage,
    ownerApi,
    seed,
  }) => {
    const sharePath = async (id: string) =>
      (await (await ownerApi.get(`/api/flashcards/${id}`)).json())
        .sharePath as string;
    for (const flashcardSet of [
      seed.privateFlashcardSet,
      seed.linkFlashcardSet,
      seed.publicFlashcardSet,
    ]) {
      const response = await anonymousApi.get(
        `/api/flashcards/${flashcardSet.id}`
      );
      expect(response.status()).toBe(401);
    }
    // No Clerk in e2e, so ?anonymous selects the signed-out page.
    for (const flashcardSet of [
      seed.linkFlashcardSet,
      seed.publicFlashcardSet,
    ]) {
      await anonymousPage.goto(`${await sharePath(flashcardSet.id)}?anonymous`);
      await expect(anonymousPage.getByText(flashcardSet.front)).toBeVisible();
      await expect(
        anonymousPage.getByRole('button', { name: 'Clone flashcards' })
      ).toHaveCount(0);
    }
    // The private seed set sits in a workspace and has no share link, so a
    // private standalone set stands in for "signed but private".
    const created = await ownerApi.post('/api/flashcards', {
      data: { name: 'E2E private standalone flashcards' },
    });
    expect(created.status()).toBe(201);
    const privateSet = await created.json();
    try {
      for (const path of [
        `${privateSet.sharePath}?anonymous`,
        `/share/flashcards/${seed.linkFlashcardSet.id}?anonymous`,
      ]) {
        await anonymousPage.goto(path);
        await expect(
          anonymousPage.getByTestId('private-or-unavailable')
        ).toBeVisible();
      }
    } finally {
      expect(
        (await ownerApi.delete(`/api/materials/${privateSet.id}`)).status()
      ).toBe(204);
    }
  });

  test('private flashcards are denied to signed-in non-members', async ({
    otherPage,
    seed,
  }) => {
    const response = waitForApi(
      otherPage,
      apiEndsWith(`/api/flashcards/${seed.privateFlashcardSet.id}`)
    );
    await otherPage.goto(`/share/flashcards/${seed.privateFlashcardSet.id}`);
    expect((await response).status()).toBe(404);
    await expect(otherPage.getByTestId('private-or-unavailable')).toBeVisible();
    await expect(
      otherPage.getByText(seed.privateFlashcardSet.front)
    ).toHaveCount(0);
  });

  test('link and public flashcards are readable by signed-in viewers without owner controls', async ({
    otherPage,
    seed,
  }) => {
    for (const flashcardSet of [
      seed.linkFlashcardSet,
      seed.publicFlashcardSet,
    ]) {
      const res = waitForApi(
        otherPage,
        apiEndsWith(`/api/flashcards/${flashcardSet.id}`)
      );
      await otherPage.goto(`/share/flashcards/${flashcardSet.id}`);
      expect((await res).status()).toBe(200);
      await expect(otherPage.getByText(flashcardSet.name)).toBeVisible();
      await expect(
        otherPage.getByRole('button', { name: 'Clone flashcards' })
      ).toBeVisible();
      await expect(otherPage.getByLabel('Share flashcards')).toHaveCount(0);
      await expect(otherPage.getByLabel(/Add card/i)).toHaveCount(0);
      await expect(otherPage.getByText(flashcardSet.front)).toBeVisible();
    }

    // Rating should not fire a review mutation for non-owners on shared flashcards.
    await otherPage.goto(`/share/flashcards/${seed.linkFlashcardSet.id}`);
    await expect(
      otherPage.getByText(seed.linkFlashcardSet.front)
    ).toBeVisible();
    await otherPage
      .getByRole('button', { name: /Show answer|Show Answer/i })
      .click();
    const reviewWatch = otherPage.waitForRequest(
      (req) =>
        req.method() === 'PATCH' &&
        req.url().includes('/api/flashcards/cards/'),
      { timeout: 1500 }
    );
    await otherPage.getByRole('button', { name: 'Good' }).click();
    await expect(reviewWatch).rejects.toThrow();
  });

  test('only public flashcards appear on Explore; private/link do not', async ({
    otherPage,
    seed,
  }) => {
    const exploreRes = waitForApi(
      otherPage,
      apiEndsWith('/api/explore/flashcards')
    );
    await otherPage.goto('/explore');
    await otherPage.getByRole('button', { name: /Flashcards/i }).click();
    expect((await exploreRes).status()).toBe(200);
    await expect(
      otherPage.getByText(seed.publicFlashcardSet.name)
    ).toBeVisible();
    await expect(otherPage.getByText(seed.linkFlashcardSet.name)).toHaveCount(
      0
    );
    await expect(
      otherPage.getByText(seed.privateFlashcardSet.name)
    ).toHaveCount(0);
  });

  test('signed-in viewer can clone public and link flashcards; anonymous gets 401', async ({
    anonymousApi,
    otherApi,
    otherPage,
    seed,
  }) => {
    for (const flashcardSet of [
      seed.linkFlashcardSet,
      seed.publicFlashcardSet,
    ]) {
      const clonePromise = waitForApi(
        otherPage,
        apiEndsWith(`/api/flashcards/${flashcardSet.id}/clone`, 'POST')
      );
      await otherPage.goto(`/share/flashcards/${flashcardSet.id}`);
      await otherPage.getByRole('button', { name: 'Clone flashcards' }).click();
      const response = await clonePromise;
      expect(response.status()).toBe(201);
      const body = await response.json();
      try {
        expect(body.privacy).toBe('private');
        expect(body.isOwner).toBe(true);
        const anonymousClone = await anonymousApi.post(
          `/api/flashcards/${flashcardSet.id}/clone`,
          { data: {} }
        );
        expect(anonymousClone.status()).toBe(401);
      } finally {
        expect(
          (await otherApi.delete(`/api/materials/${body.id}`)).status()
        ).toBe(204);
      }
    }
  });

  test('anonymous cannot mutate shared flashcards', async ({
    anonymousApi,
    seed,
  }) => {
    const response = await anonymousApi.patch(
      `/api/flashcards/${seed.linkFlashcardSet.id}/metadata`,
      { data: { name: 'Hacked' } }
    );
    expect(response.status()).toBe(401);
  });

  test('non-member cannot mutate shared flashcards', async ({
    otherApi,
    seed,
  }) => {
    const patch = await otherApi.patch(
      `/api/flashcards/${seed.linkFlashcardSet.id}/metadata`,
      {
        data: { name: 'Hacked' },
      }
    );
    expect(patch.status()).toBe(404);
  });
});
