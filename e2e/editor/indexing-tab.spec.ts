import { expect, test } from '@playwright/test';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

test('Indexing tab lists file changes, cancels queued work and processes waiting files', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  // The rail's gear (its aria-label); the empty viewer's quick action shares
  // the name as text and appears once the recent files load.
  await page
    .getByLabel(m.workspace_settings(), { exact: true })
    .first()
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
  // Exact: the MSW scenario panel's toast previews carry a longer label.
  await expect(
    page.getByText(m.files_process_started_title(), { exact: true })
  ).toBeVisible();
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

test('Indexing tab lists note changes and indexes a waiting note now', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByLabel(m.workspace_settings(), { exact: true })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  const row = (name: string) =>
    settings.getByRole('listitem').filter({ hasText: name });
  const waiting = row('Lecture notes — the cell');
  const failed = row('Membranes & transport cheatsheet');

  await expect(waiting).toHaveAttribute('data-state', 'waiting');
  await expect(failed).toHaveAttribute('data-state', 'failed');
  // A failed row shows its error id, never the failure's text.
  await expect(failed.getByTestId('error-id')).toHaveText(
    m.error_id({ id: '0af7651916cd43dd8448eb211c80319c' })
  );
  await expect(
    failed.getByRole('button', { exact: true, name: m.error_action_retry() })
  ).toBeVisible();

  await waiting
    .getByRole('button', { exact: true, name: m.workspace_change_process() })
    .click();
  // Exact: the MSW scenario panel's toast previews carry a longer label.
  await expect(
    page.getByText(m.files_process_started_title(), { exact: true })
  ).toBeVisible();
  await expect(waiting).toHaveAttribute('data-state', 'queued');
  // A queued note job has no Process and no Cancel.
  await expect(waiting.getByRole('button')).toHaveCount(0);
  await expect(waiting).toHaveAttribute('data-state', 'processing', {
    timeout: 20_000,
  });
  await expect(waiting).toHaveCount(0, { timeout: 20_000 });
});

test('a failed file is retried from its row menu and listed in the Indexing tab', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await showPanelView(page, m.workspace_tab_files());
  const name = 'Biology notes - failed.md';
  const fileRow = page
    .locator('.group')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Listed with the other failed files; automatic processing skips them.
  await page
    .getByLabel(m.workspace_settings(), { exact: true })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  const failedRow = settings.getByRole('listitem').filter({ hasText: name });
  await expect(
    failedRow.getByRole('button', { exact: true, name: m.error_action_retry() })
  ).toBeVisible();
  await expect(failedRow.getByTestId('error-id')).toHaveText(
    m.error_id({ id: 'a3ce929d0e0e47364bf92f3577b34da6' })
  );
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
  // Exact: the MSW scenario panel's toast previews carry a longer label.
  await expect(
    page.getByText(m.files_process_started_title(), { exact: true })
  ).toBeVisible();
  // No longer failed: gone from the Indexing tab's list.
  await page
    .getByLabel(m.workspace_settings(), { exact: true })
    .first()
    .click();
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_indexing() })
    .click();
  await expect(
    settings.getByRole('listitem').filter({ hasText: name })
  ).toHaveCount(0);
});
