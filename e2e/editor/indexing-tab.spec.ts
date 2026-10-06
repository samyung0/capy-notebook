import { expect, test } from '@playwright/test';

test('Indexing tab lists file changes, cancels queued work and processes waiting files', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { exact: true, name: 'Workspace settings' })
    .click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings.getByRole('button', { exact: true, name: 'Indexing' }).click();
  const row = (name: string) =>
    settings.getByRole('listitem').filter({ hasText: name });

  await expect(
    settings.getByText('File changes', { exact: true })
  ).toBeVisible();
  await expect(row('exchange-plan.docx')).toHaveAttribute(
    'data-state',
    'processing'
  );
  // Started work cannot be cancelled.
  await expect(row('exchange-plan.docx').getByRole('button')).toHaveCount(0);
  await expect(row('course-guide.xlsx')).toContainText("Couldn't process");
  await expect(
    settings.getByRole('switch', { name: 'Auto process edits' })
  ).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath('indexing-tab.png'),
  });

  await row('lecture.pptx')
    .getByRole('button', { exact: true, name: 'Cancel' })
    .click();
  await expect(row('lecture.pptx')).toHaveAttribute('data-state', 'waiting');

  await row('Organelles cheatsheet.md')
    .getByRole('button', { exact: true, name: 'Process' })
    .click();
  await expect(page.getByText('Processing started')).toBeVisible();
  await expect(row('Organelles cheatsheet.md')).toHaveAttribute(
    'data-state',
    'queued'
  );
  // The tab polls while work is in flight: the processing file finishes and
  // the queued one starts.
  await expect(row('exchange-plan.docx')).toHaveCount(0, { timeout: 20_000 });
  await expect(row('Organelles cheatsheet.md')).toHaveAttribute(
    'data-state',
    'processing',
    { timeout: 20_000 }
  );
});

test('a failed file is retried from its row menu and listed in the Indexing tab', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  const name = 'Biology notes - failed.md';
  const fileRow = page
    .locator('.group')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Listed with the other failed files; automatic processing skips them.
  await page
    .getByRole('button', { exact: true, name: 'Workspace settings' })
    .click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings.getByRole('button', { exact: true, name: 'Indexing' }).click();
  await expect(
    settings
      .getByRole('listitem')
      .filter({ hasText: name })
      .getByRole('button', { exact: true, name: 'Retry processing' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The row menu opens the upload panel on the stored file.
  await fileRow.hover();
  await fileRow.getByRole('button', { name: 'Open menu' }).click();
  await page
    .getByRole('menuitem', { exact: true, name: 'Retry processing' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Retry processing' });
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { exact: true, name: 'Retry processing' })
    .click();
  await expect(page.getByText('Processing started')).toBeVisible();
  // No longer failed: gone from the Indexing tab's list.
  await page
    .getByRole('button', { exact: true, name: 'Workspace settings' })
    .click();
  await settings.getByRole('button', { exact: true, name: 'Indexing' }).click();
  await expect(
    settings.getByRole('listitem').filter({ hasText: name })
  ).toHaveCount(0);
});
