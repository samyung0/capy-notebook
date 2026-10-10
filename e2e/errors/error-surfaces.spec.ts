import { expect, test } from '../fixtures/actors';
import { expectErrorSurface } from '../helpers/errors';
import { summaryPath } from '../helpers/workspace';
import { m } from '../i18n';

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

    const surface = await expectErrorSurface(ownerPage, 'page');
    await expect(surface).toHaveCount(1);
    await expect(surface.getByText(m.error_server_title())).toBeVisible();
    await expect(
      surface.getByRole('button', { name: m.error_action_retry() })
    ).toBeVisible();
  });

  test('private and missing workspace summaries stay non-disclosing', async ({
    anonymousPage,
    seed,
  }) => {
    const bodies: string[] = [];
    for (const id of [seed.privateWorkspace.id, 'ws_e2e_missing_summary']) {
      // The summary fetch runs on the server, outside browser route interception.
      const response = await anonymousPage.goto(await summaryPath(id));
      expect(response?.status()).toBe(404);
      expect(response?.headers()['cache-control']).toBe('no-store');
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      await expect(
        anonymousPage.getByRole('heading', {
          name: m.error_not_found_page_title(),
        })
      ).toBeVisible();
      await expect(
        anonymousPage.getByText(seed.privateWorkspace.name)
      ).toHaveCount(0);
      bodies.push(await anonymousPage.locator('body').innerText());
    }
    expect(bodies[0]).toBe(bodies[1]);
  });

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
