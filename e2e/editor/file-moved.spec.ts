import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Q454, Q455, Q462 and Q467 (Epo 2026-10-27, 2026-10-28): a Move tells an
// open tab through the file's room right before the drain, and the tab acts
// on it at once; a workspace page opened without that message follows a file
// into the workspace that holds it now. Every follow is a normal open (its
// mode from this device, no page or full screen) that replaces history.

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

/** The Move's room message to every open tab of the file. */
async function announceMove(page: Page, workspaceId: string) {
  await page.evaluate(
    async ({ id, to }) => {
      const path = '/src/mocks/collaboration.ts';
      const { announceSourceMoved } = await import(path);
      announceSourceMoved(id, to);
    },
    { id: FILE, to: workspaceId }
  );
}

/** The file becomes unreadable (deleted or access lost: 404 either way). */
async function dropRow(page: Page) {
  await page.evaluate(async (id) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const at = db.files.findIndex((row: { id: string }) => row.id === id);
    db.files.splice(at, 1);
  }, FILE);
}

/** Opens the file and waits for its text. */
async function openFile(page: Page, url: string) {
  await page.goto(url);
  const input = page.getByRole('textbox', { name: m.source_edit_raw() });
  await expect(input).not.toHaveValue('', { timeout: 30_000 });
  return input;
}

/** A client-side visit, as a bookmark opened in this tab: MSW's database
 * stays, where a page load would rebuild it. */
async function visit(page: Page, url: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

test('a Move heard while typing follows the file at once, with no dialog and no reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  // The first open's mode=edit is this device's mode for the file from now.
  const input = await openFile(
    page,
    `/workspaces/ws_scenarios?file=${FILE}&mode=edit`
  );
  await page.evaluate(() => {
    (window as { stayed?: boolean }).stayed = true;
  });
  // Typed and moved before the save (Q465): nothing asks on the way.
  await input.fill(`${await input.inputValue()}\nTyped before the move.`);
  await announceMove(page, MOVED_TO);
  await expect(
    toast(page, m.file_moved_to_workspace({ workspace: MOVED_TO_NAME }))
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${MOVED_TO}\\?file=${FILE}$`)
  );
  await expect(
    page.getByText(MOVED_TO_NAME, { exact: true }).first()
  ).toBeVisible();
  // The drained room's reconnect joined again: still editing, nothing lost.
  await expect(input).toBeEditable();
  await expect(input).toHaveValue(/Typed before the move\./);
  await input.fill(`${await input.inputValue()}\nTyped after the move.`);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );
  expect(
    await page.evaluate(() => (window as { stayed?: boolean }).stayed)
  ).toBe(true);
  expect(dialogs).toEqual([]);
  // One toast for the one message.
  await expect(
    toast(page, m.file_moved_to_workspace({ workspace: MOVED_TO_NAME }))
  ).toHaveCount(1);
});

test('a bookmark naming the old workspace opens the file in its own, replacing history', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 30_000,
  });
  await moveRow(page, MOVED_TO);
  await visit(
    page,
    `/workspaces/ws_scenarios?file=${FILE}&page=2&mode=edit&fullscreen=true`
  );
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${MOVED_TO}\\?file=${FILE}$`)
  );
  await expect(
    page.getByText(MOVED_TO_NAME, { exact: true }).first()
  ).toBeVisible();
  // The redirect replaced the bookmark's entry: Back leaves it behind.
  await page.goBack();
  await expect(page).toHaveURL(/\/workspaces\/ws_scenarios$/);
});

test('a bookmark to a file that is standalone now opens its own page', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 30_000,
  });
  await moveRow(page, '');
  await visit(page, `/workspaces/ws_scenarios?file=${FILE}&page=2&mode=edit`);
  await expect(page).toHaveURL(new RegExp(`/files/${FILE}$`));
});

test('a Move heard into a workspace this user cannot read closes the file where it is', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFile(
    page,
    `/workspaces/ws_scenarios?file=${FILE}&mode=edit&fullscreen=true`
  );
  await announceMove(page, 'ws_unreadable');
  await expect(toast(page, m.file_moved_elsewhere())).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces\/ws_scenarios$/);
});

test('nothing remembers a heard Move: the file unreadable later shows the file error', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFile(page, `/workspaces/ws_scenarios?file=${FILE}&mode=edit`);
  await announceMove(page, MOVED_TO);
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${MOVED_TO}\\?file=${FILE}$`)
  );
  await dropRow(page);
  // Later (its read gone stale), an old link to the file, from a chat
  // citation say, opens it again.
  await visit(page, '/workspaces/ws_scenarios');
  await page.waitForTimeout(5500);
  await visit(page, `/workspaces/ws_scenarios?file=${FILE}`);
  await expect(page.getByText(m.error_file_body())).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/ws_scenarios\\?file=${FILE}$`)
  );
  await expect(toast(page, m.file_moved_elsewhere())).toHaveCount(0);
});
