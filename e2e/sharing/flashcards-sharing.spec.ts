import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('flashcards sharing', () => {
  test('private flashcards are denied to anonymous and non-members', async ({
    anonymousPage,
    otherPage,
    seed,
  }) => {
    for (const page of [anonymousPage, otherPage]) {
      const resPromise = waitForApi(
        page,
        apiEndsWith(`/api/flashcards/${seed.privateFlashcardSet.id}`)
      );
      await page.goto(`/share/flashcards/${seed.privateFlashcardSet.id}`);
      expect((await resPromise).status()).toBe(404);
      await expect(page.getByTestId('private-or-unavailable')).toBeVisible();
      await expect(page.getByText(seed.privateFlashcardSet.front)).toHaveCount(
        0
      );
    }
  });

  test('link and public flashcards are readable without owner controls', async ({
    anonymousPage,
    seed,
  }) => {
    for (const flashcardSet of [
      seed.linkFlashcardSet,
      seed.publicFlashcardSet,
    ]) {
      const res = waitForApi(
        anonymousPage,
        apiEndsWith(`/api/flashcards/${flashcardSet.id}`)
      );
      await anonymousPage.goto(`/share/flashcards/${flashcardSet.id}`);
      expect((await res).status()).toBe(200);
      await expect(anonymousPage.getByText(flashcardSet.name)).toBeVisible();
      await expect(
        anonymousPage.getByRole('button', { name: 'Clone flashcards' })
      ).toBeVisible();
      await expect(anonymousPage.getByLabel('Share flashcards')).toHaveCount(0);
      await expect(anonymousPage.getByLabel(/Add card/i)).toHaveCount(0);
      await expect(anonymousPage.getByText(flashcardSet.front)).toBeVisible();
    }

    // Rating should not fire a review mutation for non-owners on shared flashcards.
    await anonymousPage.goto(`/share/flashcards/${seed.linkFlashcardSet.id}`);
    await expect(
      anonymousPage.getByText(seed.linkFlashcardSet.front)
    ).toBeVisible();
    await anonymousPage
      .getByRole('button', { name: /Show answer|Show Answer/i })
      .click();
    const reviewWatch = anonymousPage.waitForRequest(
      (req) =>
        req.method() === 'PATCH' &&
        req.url().includes('/api/flashcards/cards/'),
      { timeout: 1500 }
    );
    await anonymousPage.getByRole('button', { name: 'Good' }).click();
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

  test('signed-in viewer can clone shared flashcards; anonymous gets 401', async ({
    anonymousPage,
    otherApi,
    otherPage,
    seed,
  }) => {
    const clonePromise = waitForApi(
      otherPage,
      apiEndsWith(`/api/flashcards/${seed.linkFlashcardSet.id}/clone`, 'POST')
    );
    await otherPage.goto(`/share/flashcards/${seed.linkFlashcardSet.id}`);
    await otherPage.getByRole('button', { name: 'Clone flashcards' }).click();
    const res = await clonePromise;
    expect(res.status()).toBe(201);
    const body = await res.json();
    try {
      expect(body.privacy).toBe('private');
      expect(body.isOwner).toBe(true);

      const anonClone = waitForApi(
        anonymousPage,
        apiEndsWith(`/api/flashcards/${seed.linkFlashcardSet.id}/clone`, 'POST')
      );
      await anonymousPage.goto(`/share/flashcards/${seed.linkFlashcardSet.id}`);
      await anonymousPage
        .getByRole('button', { name: 'Clone flashcards' })
        .click();
      expect((await anonClone).status()).toBe(401);
      await expect(anonymousPage.getByText('Sign in to clone')).toBeVisible({
        timeout: 5000,
      });
    } finally {
      const removedClone = await otherApi.delete(`/api/materials/${body.id}`);
      expect(removedClone.status()).toBe(204);
    }
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
