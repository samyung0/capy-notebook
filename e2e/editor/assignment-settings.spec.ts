import { expect, test } from '@playwright/test';
import { m } from '../i18n';

const LAST_PUBLISHED = new RegExp(
  m.assignment_last_published({ date: '' }).trim()
);

// Epo 2026-11-05: an assignment's actions sit on its Settings tab, with no ⋮.
test('Settings holds the actions: Republish moves the last published time, Edit quiz opens it', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_genetics'
  );
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

  await page.getByRole('link', { name: m.assignment_edit_quiz() }).click();
  await expect(page).toHaveURL(/material=/);
  await expect(
    page.getByTestId('content-header').getByText('Genetics check-in')
  ).toBeVisible({ timeout: 30_000 });
});

test('a draft has its Publish row first, and publishing brings the tabs', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_draft');
  await page
    .getByRole('button', { exact: true, name: m.assignment_publish() })
    .click({ timeout: 60_000 });
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_settings() })
  ).toBeVisible();
});

test('a closed assignment keeps Edit quiz and has no Republish', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_cells&tab=settings'
  );
  await expect(
    page.getByRole('link', { name: m.assignment_edit_quiz() })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(LAST_PUBLISHED)).toHaveCount(0);
});

test.describe('at phone width', () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test('a link to Settings shows its tab, past the row’s edge', async ({
    page,
  }) => {
    await page.goto(
      '/workspaces/ws_bio?study=assignments&assignment=as_genetics&tab=settings'
    );
    await expect(
      page.getByRole('tab', { name: m.assignment_tab_settings() })
    ).toBeInViewport({ ratio: 1, timeout: 60_000 });
  });
});
