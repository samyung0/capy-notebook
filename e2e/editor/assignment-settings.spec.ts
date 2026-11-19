import { expect, test } from '@playwright/test';
import { startAssignmentAsMember } from '../helpers/assignments';
import { m } from '../i18n';

const LAST_PUBLISHED = new RegExp(
  m.assignment_last_published({ date: '' }).trim()
);

// Epo 2026-11-05: an assignment's actions sit on its Settings tab, with no ⋮;
// a graded quiz's quiz edits on its Questions tab (Epo 2026-11-15).
test('Settings holds the actions: Republish moves the last published time', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio/assignments?assignment=as_genetics');
  await page
    .getByRole('tab', { name: m.assignment_tab_settings() })
    .click({ timeout: 60_000 });
  await expect(page).toHaveURL(/tab=settings/);
  await expect(
    page.getByRole('button', { name: m.a11y_open_menu() })
  ).toHaveCount(0);

  const hint = page.getByText(LAST_PUBLISHED);
  const before = await hint.innerText();
  await page
    .getByRole('button', { exact: true, name: m.assignment_republish() })
    .click();
  await page
    .getByRole('dialog', { name: m.assignment_republish_title() })
    .getByRole('button', { exact: true, name: m.assignment_republish() })
    .click();
  await expect(hint).not.toHaveText(before);
});

test('a draft publishes from its header, and publishing brings Responses', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio/assignments?assignment=as_draft');
  await page
    .getByRole('button', { exact: true, name: m.assignment_publish() })
    .click({ timeout: 60_000 });
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_responses() })
  ).toBeVisible();
});

test('a closed assignment has no Republish', async ({ page }) => {
  await page.goto(
    '/workspaces/ws_bio/assignments?assignment=as_cells&tab=settings'
  );
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_settings() })
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole('button', { exact: true, name: m.assignment_republish() })
  ).toHaveCount(0);
});

test.describe('as a member', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem('capy.scenario.last', 'workspace-member')
    );
  });

  test('a page open through a republish reads the new questions', async ({
    page,
  }) => {
    await startAssignmentAsMember(page, 'as_paper');
    const take = page.locator('[data-assignment-take]');
    const first = take.locator('h2').getByText('Which organelle makes most');
    await expect(first).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() =>
      fetch('/api/assignments/as_paper/republish', { method: 'POST' })
    );
    await expect(page.getByText(m.assignment_questions_updated())).toBeVisible({
      timeout: 30_000,
    });
    await expect(first).toHaveCount(0);
    await expect(take).toBeVisible();
  });
});

test.describe('at phone width', () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test('a link to Settings shows its tab, past the row’s edge', async ({
    page,
  }) => {
    await page.goto(
      '/workspaces/ws_bio/assignments?assignment=as_genetics&tab=settings'
    );
    await expect(
      page.getByRole('tab', { name: m.assignment_tab_settings() })
    ).toBeInViewport({ ratio: 1, timeout: 60_000 });
  });
});
