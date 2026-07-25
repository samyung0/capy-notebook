import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('deck sharing', () => {
  test('private deck is denied to anonymous and non-members', async ({
    anonymousPage,
    otherPage,
    seed,
  }) => {
    for (const page of [anonymousPage, otherPage]) {
      const resPromise = waitForApi(
        page,
        apiEndsWith(`/api/decks/${seed.privateDeck.id}`)
      );
      await page.goto(`/share/decks/${seed.privateDeck.id}`);
      expect((await resPromise).status()).toBe(404);
      await expect(page.getByTestId('private-or-unavailable')).toBeVisible();
      await expect(page.getByText(seed.privateDeck.front)).toHaveCount(0);
    }
  });

  test('link and public decks are readable without owner controls', async ({
    anonymousPage,
    seed,
  }) => {
    for (const deck of [seed.linkDeck, seed.publicDeck]) {
      const res = waitForApi(
        anonymousPage,
        apiEndsWith(`/api/decks/${deck.id}`)
      );
      await anonymousPage.goto(`/share/decks/${deck.id}`);
      expect((await res).status()).toBe(200);
      await expect(anonymousPage.getByText(deck.name)).toBeVisible();
      await expect(
        anonymousPage.getByRole('button', { name: 'Clone deck' })
      ).toBeVisible();
      await expect(anonymousPage.getByLabel('Share deck')).toHaveCount(0);
      await expect(anonymousPage.getByLabel(/Add card/i)).toHaveCount(0);
      await expect(anonymousPage.getByText(deck.front)).toBeVisible();
    }

    // Rating should not fire a review mutation for non-owners on the link deck.
    await anonymousPage.goto(`/share/decks/${seed.linkDeck.id}`);
    await expect(anonymousPage.getByText(seed.linkDeck.front)).toBeVisible();
    await anonymousPage
      .getByRole('button', { name: /Show answer|Show Answer/i })
      .click();
    const reviewWatch = anonymousPage.waitForRequest(
      (req) => req.method() === 'PATCH' && req.url().includes('/api/cards/'),
      { timeout: 1500 }
    );
    await anonymousPage.getByRole('button', { name: 'Good' }).click();
    await expect(reviewWatch).rejects.toThrow();
  });

  test('only public decks appear on Explore; private/link do not', async ({
    otherPage,
    seed,
  }) => {
    const exploreRes = waitForApi(otherPage, apiEndsWith('/api/explore/decks'));
    await otherPage.goto('/explore');
    await otherPage.getByRole('button', { name: /Flashcards/i }).click();
    expect((await exploreRes).status()).toBe(200);
    await expect(otherPage.getByText(seed.publicDeck.name)).toBeVisible();
    await expect(otherPage.getByText(seed.linkDeck.name)).toHaveCount(0);
    await expect(otherPage.getByText(seed.privateDeck.name)).toHaveCount(0);
  });

  test('signed-in viewer can clone a shared deck; anonymous gets 401', async ({
    anonymousPage,
    otherApi,
    otherPage,
    seed,
  }) => {
    const clonePromise = waitForApi(
      otherPage,
      apiEndsWith(`/api/decks/${seed.linkDeck.id}/clone`, 'POST')
    );
    await otherPage.goto(`/share/decks/${seed.linkDeck.id}`);
    await otherPage.getByRole('button', { name: 'Clone deck' }).click();
    const res = await clonePromise;
    expect(res.status()).toBe(201);
    const body = await res.json();
    try {
      expect(body.privacy).toBe('private');
      expect(body.isOwner).toBe(true);

      const anonClone = waitForApi(
        anonymousPage,
        apiEndsWith(`/api/decks/${seed.linkDeck.id}/clone`, 'POST')
      );
      await anonymousPage.goto(`/share/decks/${seed.linkDeck.id}`);
      await anonymousPage.getByRole('button', { name: 'Clone deck' }).click();
      expect((await anonClone).status()).toBe(401);
      await expect(anonymousPage.getByText('Sign in to clone')).toBeVisible({
        timeout: 5000,
      });
    } finally {
      const removedClone = await otherApi.delete(`/api/materials/${body.id}`);
      expect(removedClone.status()).toBe(204);
    }
  });

  test('non-member cannot mutate a shared deck', async ({ otherApi, seed }) => {
    const patch = await otherApi.patch(`/api/decks/${seed.linkDeck.id}`, {
      data: { name: 'Hacked' },
    });
    expect(patch.status()).toBe(404);
  });
});
