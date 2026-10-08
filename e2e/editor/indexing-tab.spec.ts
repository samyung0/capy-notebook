import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('Indexing tab lists file changes, cancels queued work and processes waiting files', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  const row = (name: string) =>
    settings.getByRole('listitem').filter({ hasText: name });

  await expect(
    settings.getByText(m.workspace_file_changes(), { exact: true })
  ).toBeVisible();
  await expect(row('exchange-plan.docx')).toHaveAttribute(
    'data-state',
    'processing'
  );
  // Started work cannot be cancelled.
  await expect(row('exchange-plan.docx').getByRole('button')).toHaveCount(0);
  await expect(row('course-guide.xlsx')).toHaveAttribute(
    'data-state',
    'failed'
  );
  await expect(
    settings.getByRole('switch', { name: m.workspace_auto_process() })
  ).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath('indexing-tab.png'),
  });

  await row('lecture.pptx')
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await expect(row('lecture.pptx')).toHaveAttribute('data-state', 'waiting');

  await row('Organelles cheatsheet.md')
    .getByRole('button', { exact: true, name: m.workspace_change_process() })
    .click();
  await expect(page.getByText(m.files_process_started_title())).toBeVisible();
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
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  const name = 'Biology notes - failed.md';
  const fileRow = page
    .locator('.group')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Listed with the other failed files; automatic processing skips them.
  await page
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  await expect(
    settings
      .getByRole('listitem')
      .filter({ hasText: name })
      .getByRole('button', { exact: true, name: m.error_action_retry() })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The row menu opens the upload panel on the stored file.
  await fileRow.hover();
  await fileRow.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page
    .getByRole('menuitem', { exact: true, name: m.files_retry_processing() })
    .click();
  const dialog = page.getByRole('dialog', { name: m.files_retry_processing() });
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { exact: true, name: m.files_retry_processing() })
    .click();
  await expect(page.getByText(m.files_process_started_title())).toBeVisible();
  // No longer failed: gone from the Indexing tab's list.
  await page
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .click();
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  await expect(
    settings.getByRole('listitem').filter({ hasText: name })
  ).toHaveCount(0);
});
