import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Q454 and Q455 (Epo 2026-10-27): a Move tells an open tab through the
// file's room right before the drain, and a workspace page follows a file
// into the workspace that holds it now.

const FILE = 'mock-scenario-text';
const MOVED_TO = 'ws_bio';
const MOVED_TO_NAME = 'Biology 101';

function toast(page: Page, title: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: title });
}

/** The mock file row moves to `workspaceId` (no room message). */
async function moveRow(page: Page, workspaceId: string) {
  await page.evaluate(
    async ({ id, to }) => {
      const path = '/src/mocks/db.ts';
      const db = await import(path);
      const file = db.files.find((row: { id: string }) => row.id === id);
      file.workspaceId = to;
      file.chapterId = null;
    },
    { id: FILE, to: workspaceId }
  );
}

/** A client-side visit, as a bookmark opened in this tab: MSW's database
 * stays, where a page load would rebuild it. */
async function visit(page: Page, url: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

test('a Move heard through the open room toasts and follows the file without a reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/workspaces/ws_scenarios?file=${FILE}&mode=edit`);
  const input = page.getByRole('textbox', { name: m.source_edit_raw() });
  await expect(input).not.toHaveValue('', { timeout: 30_000 });
  await page.evaluate(() => {
    (window as { stayed?: boolean }).stayed = true;
  });
  await page.evaluate(
    async ({ id, to }) => {
      const path = '/src/mocks/collaboration.ts';
      const { announceSourceMoved } = await import(path);
      announceSourceMoved(id, to);
    },
    { id: FILE, to: MOVED_TO }
  );
  await expect(
    toast(page, m.file_moved_to_workspace({ workspace: MOVED_TO_NAME }))
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${MOVED_TO}\\?file=${FILE}&mode=edit$`)
  );
  await expect(
    page.getByText(MOVED_TO_NAME, { exact: true }).first()
  ).toBeVisible();
  // The drained room's reconnect joined again: still editing, same page.
  await expect(input).toBeEditable();
  await input.fill(`${await input.inputValue()}\nTyped after the move.`);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );
  expect(
    await page.evaluate(() => (window as { stayed?: boolean }).stayed)
  ).toBe(true);
  // Once per tab per move.
  await expect(
    toast(page, m.file_moved_to_workspace({ workspace: MOVED_TO_NAME }))
  ).toHaveCount(1);
});

test('a bookmark naming the old workspace opens the file in its own', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 30_000,
  });
  await moveRow(page, MOVED_TO);
  await visit(page, `/workspaces/ws_scenarios?file=${FILE}&page=2`);
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${MOVED_TO}\\?file=${FILE}&page=2$`)
  );
  await expect(
    page.getByText(MOVED_TO_NAME, { exact: true }).first()
  ).toBeVisible();
});

test('a file moved where this user cannot follow closes with the moved toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 30_000,
  });
  await moveRow(page, 'ws_unreadable');
  await visit(page, `/workspaces/ws_scenarios?file=${FILE}`);
  await expect(toast(page, m.file_moved_elsewhere())).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces\/ws_scenarios$/);
});
