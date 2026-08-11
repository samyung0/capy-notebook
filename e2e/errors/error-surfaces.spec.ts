import { expect, test } from '../fixtures/actors';
import { expectErrorSurface } from '../helpers/errors';

const apiError = (status: number, detail: string) => ({
  detail,
  status,
  title: status === 401 ? 'Unauthorized' : 'Not Found',
});

test.describe('standardized error surfaces', () => {
  test('a primary workspace failure renders one workspace error surface', async ({
    ownerPage,
    workspaceFactory,
  }) => {
    const workspace = await workspaceFactory.create({
      name: 'Error surface workspace',
    });
    await ownerPage.route(`**/api/workspaces/${workspace.id}`, (route) =>
      route.fulfill({
        body: JSON.stringify(apiError(500, 'Injected workspace failure.')),
        contentType: 'application/json',
        status: 500,
      })
    );

    await ownerPage.goto(`/workspaces/${workspace.id}`);

    const surface = await expectErrorSurface(
      ownerPage,
      'page',
      'Unable to load workspace.'
    );
    await expect(surface).toHaveCount(1);
  });

  for (const status of [401, 404] as const) {
    test(`a public workspace ${status} response stays non-disclosing`, async ({
      anonymousPage,
      seed,
    }) => {
      const workspace = seed.publicWorkspace;
      await anonymousPage.route(`**/api/workspaces/${workspace.id}`, (route) =>
        route.fulfill({
          body: JSON.stringify(
            apiError(
              status,
              status === 401 ? 'Sign in required.' : 'Workspace missing.'
            )
          ),
          contentType: 'application/json',
          status,
        })
      );

      await anonymousPage.goto(`/share/workspaces/${workspace.id}`);

      const surface = await expectErrorSurface(
        anonymousPage,
        'page',
        'This item is private or unavailable.'
      );
      await expect(surface).toHaveCount(1);
      await expect(anonymousPage.getByText(workspace.name)).toHaveCount(0);
    });
  }

  test('browser offline state renders the connection status', async ({
    ownerPage,
  }) => {
    await ownerPage.goto('/');
    await expect(ownerPage.locator('main')).toBeVisible();
    try {
      await ownerPage.context().setOffline(true);
      // Chromium's DevTools offline emulation does not consistently emit the
      // browser event that TanStack's onlineManager listens for.
      await ownerPage.evaluate(() =>
        window.dispatchEvent(new Event('offline'))
      );
      await expect(
        ownerPage.locator('[data-connection-status="offline"]')
      ).toBeVisible();
    } finally {
      await ownerPage.context().setOffline(false);
      await ownerPage.evaluate(() => window.dispatchEvent(new Event('online')));
    }
  });
});
