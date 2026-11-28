import { expect, type Page, test } from '@playwright/test';
import { skipWhileFilesEditable } from '../helpers/filesViewOnly';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// Files are view-only (Q852 A, Q853 A): /me says so (the mocks mirror Go's
// switch, src/mocks/db.ts FILES_EDITABLE), so an Office or text file opens in
// View with no Edit, no edit session and no room token, and the Create tab
// offers no Blank DOCX or XLSX; a note keeps its room and saves. The first
// two run only while the switch is off.

/** Every request path (and query) the page makes. */
function watchRequests(page: Page) {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    paths.push(url.pathname + url.search);
  });
  return paths;
}

/** What a file's open asked for that only Edit asks for. */
const editRequests = (paths: string[], fileId: string) =>
  paths.filter(
    (path) =>
      path.startsWith(`/api/files/${fileId}/collaboration-token`) ||
      path === `/api/files/${fileId}/source-session` ||
      path.startsWith(`/api/files/${fileId}/thumbnail`)
  );

test('an Office file and a text file open in View with no Edit, edit session or room token', async ({
  page,
}) => {
  skipWhileFilesEditable();
  test.setTimeout(120_000);
  const paths = watchRequests(page);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  expect(paths).toContain(
    '/api/files/bio-office-docx/source-session?view=true'
  );
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveCount(0);

  await page.goto('/workspaces/ws_bio?file=f_2');
  await expect(page.locator('[data-source-status]')).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => paths.includes('/api/files/f_2/source-session?view=true'))
    .toBe(true);
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveCount(0);
  expect(editRequests(paths, 'bio-office-docx')).toEqual([]);
  expect(editRequests(paths, 'f_2')).toEqual([]);
});

test('the Create tab offers no Blank DOCX or Blank XLSX', async ({ page }) => {
  skipWhileFilesEditable();
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { exact: true, name: m.action_new_file_or_topic() })
    .click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('tab', { exact: true, name: m.action_create() })
    .click();
  await expect(
    dialog.getByText(m.create_kind_note(), { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByText(m.source_create_blank_docx(), { exact: true })
  ).toHaveCount(0);
  await expect(
    dialog.getByText(m.source_create_blank_xlsx(), { exact: true })
  ).toHaveCount(0);
});

test('a note still opens its room and saves', async ({ page }) => {
  const paths = watchRequests(page);
  await page.goto('/workspaces/ws_bio?material=mat_e2e_editor');
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  const status = page.getByTestId('editor-save-state');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      paths.includes('/api/materials/mat_e2e_editor/collaboration-token')
    )
    .toBe(true);
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText(' still editable');
  await expect(editor).toContainText('still editable');
  await expect(status).toHaveAttribute('data-save-state', 'saved', {
    timeout: 15_000,
  });
});
