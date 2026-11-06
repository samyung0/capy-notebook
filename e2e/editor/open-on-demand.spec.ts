import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { showChatHistory, showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// A workspace opens without Add file's code (MSAL with it) or the chat's
// Markdown code, each loads as it's wanted, and a note asks for its one room
// token as it opens (Q618, Q619).

const WORKSPACE = `/workspaces/${EDITOR_WORKSPACE_ID}`;
const NOTE = `${WORKSPACE}?material=${EDITOR_NOTE.id}`;
const SAVED_CHAT = 'Answer: prose, code + math';

function watchRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

const asked = (urls: string[], part: string) =>
  urls.filter((url) => url.includes(part));

async function openWorkspace(page: Page) {
  await page.goto(WORKSPACE);
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
}

/** Fails a module of the page's code as a removed file or a dead network does. */
const failModule = (page: Page, part: string) =>
  page.evaluate(async (name) => {
    const browserPath = '/src/mocks/browser.ts';
    const { http, HttpResponse, worker } = await import(browserPath);
    worker.use(http.get(new RegExp(name), () => HttpResponse.error()));
  }, part);

const addMenu = (page: Page) =>
  page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { exact: true, name: m.action_new_file_or_topic() });

async function openAddFile(page: Page) {
  await showPanelView(page, m.workspace_tab_files());
  await addMenu(page).click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
}

test('a workspace opens without Add file or the chat Markdown, which load when wanted', async ({
  page,
}) => {
  const urls = watchRequests(page);
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  await page.waitForTimeout(1500);
  expect(asked(urls, '/AddSourceDialog')).toEqual([]);
  expect(asked(urls, 'msal')).toEqual([]);
  expect(asked(urls, 'proseBody')).toEqual([]);

  // Hovering what opens it starts the load, before any click.
  await addMenu(page).hover();
  await expect.poll(() => asked(urls, '/AddSourceDialog').length).toBe(1);
  await expect
    .poll(() => asked(urls, 'msal').length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // And hovering a saved chat the Markdown's.
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).hover();
  await expect.poll(() => asked(urls, 'proseBody').length).toBe(1);
});

test('Add file opens, with its Google and Microsoft pickers', async ({
  page,
}) => {
  await openWorkspace(page);
  await openAddFile(page);
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  await expect(
    dialog.getByRole('button', { name: m.source_upload_computer() })
  ).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('tab', { name: m.action_import() }).click();
  // Under MSW each picker hands over a mock file at once. A click does nothing
  // until the upload policy answers, and picking a file again keeps its one row.
  const rows = dialog.getByText('cloud-notes-1.docx', { exact: true });
  await expect(async () => {
    await dialog.getByRole('button', { name: 'Google Drive' }).click();
    await expect(rows).toHaveCount(1, { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'OneDrive' }).click();
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
});

test('Add file whose code will not load says so and leaves the page', async ({
  page,
}) => {
  await openWorkspace(page);
  await failModule(page, 'AddSourceDialog');
  await openAddFile(page);
  await expect(
    page.getByText(m.error_chunk_title(), { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-error-surface]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-file-tree]')).toBeVisible();
});

test('Add file offline with its code not loaded shows the offline toast', async ({
  context,
  page,
}) => {
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  await context.setOffline(true);
  await addMenu(page).click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  await expect(
    page.getByText(m.error_offline_title(), { exact: true }).first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-error-surface]')).toHaveCount(0);
  await context.setOffline(false);
});

test('a saved chat draws its Markdown', async ({ page }) => {
  await openWorkspace(page);
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  const answer = page.locator('[data-chat-answer]').first();
  await expect(
    answer.locator('[data-streamdown="strong"]').first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(answer.locator('[data-prose]')).toHaveCount(0);
});

test('a chat whose Markdown code will not load shows its words as they are', async ({
  page,
}) => {
  await openWorkspace(page);
  await failModule(page, 'proseBody');
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  const plain = page.locator('[data-prose="failed"]').first();
  await expect(plain).toBeVisible({ timeout: 30_000 });
  // A sentence of the fixture, raw markers and all.
  await expect(plain).toContainText('**');
  await expect(
    page.getByText(m.error_chunk_title(), { exact: true })
  ).toBeVisible();
  await expect(page.locator('[data-error-surface]')).toHaveCount(0);
});

const TOKEN = `/materials/${EDITOR_NOTE.id}/collaboration-token`;
const DISCUSSIONS = `/materials/${EDITOR_NOTE.id}/discussions`;

test("an editor's note asks for its one token as it opens, ahead of its comments", async ({
  page,
}) => {
  const urls = watchRequests(page);
  await page.goto(NOTE);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(
    editor.getByText(EDITOR_NOTE.firstParagraph).first()
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(asked(urls, TOKEN)).toHaveLength(1);
  // The comments are asked for behind the read: the token no longer is.
  const order = urls.filter(
    (url) => url.includes(TOKEN) || url.includes(DISCUSSIONS)
  );
  expect(order[0]).toContain(TOKEN);
});

test("a viewer's note asks for one token, and its read channel joins with it", async ({
  page,
}) => {
  await page.goto(WORKSPACE);
  await page.evaluate(async (id) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const row = db.materials.find((item: { id: string }) => item.id === id);
    row.capabilities = {
      ...row.capabilities,
      canEdit: false,
      canEditContent: false,
    };
  }, EDITOR_NOTE.id);
  const tokens: (string | null)[] = [];
  page.on('request', (request) => {
    if (request.url().includes(TOKEN)) tokens.push(request.postData());
  });
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator(`[data-workspace-file-tree] a[href*="material=${EDITOR_NOTE.id}"]`)
    .click();
  const preview = page.getByTestId('material-preview');
  await expect(
    preview.getByText(EDITOR_NOTE.firstParagraph).first()
  ).toBeVisible({ timeout: 60_000 });
  // A collaborator's words reach the View: its channel joined on that token.
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const path = '/src/mocks/collaboration.ts';
          const { mockNotePeer } = (await import(
            path
          )) as typeof import('../../src/mocks/collaboration');
          try {
            mockNotePeer(id).append([
              {
                children: [{ text: 'A peer wrote this.' }],
                id: 'peer',
                type: 'p',
              },
            ] as never);
            return true;
          } catch {
            return false;
          }
        }, EDITOR_NOTE.id),
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect(preview.getByText('A peer wrote this.').first()).toBeVisible({
    timeout: 30_000,
  });
  expect(tokens).toHaveLength(1);
});

test('someone refused gets one quiet refused token and the refused read page', async ({
  page,
}) => {
  await page.goto(WORKSPACE);
  await page.evaluate(async (id) => {
    const browserPath = '/src/mocks/browser.ts';
    const { http, HttpResponse, worker } = await import(browserPath);
    const refused = () =>
      HttpResponse.json({ detail: 'no access' }, { status: 403 });
    worker.use(
      http.get(`/api/materials/${id}`, refused),
      http.post(`/api/materials/${id}/collaboration-token`, refused)
    );
  }, EDITOR_NOTE.id);
  const urls = watchRequests(page);
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator(`[data-workspace-file-tree] a[href*="material=${EDITOR_NOTE.id}"]`)
    .click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  // Long enough for a retry or a second ask.
  await page.waitForTimeout(4000);
  expect(asked(urls, TOKEN)).toHaveLength(1);
  // Only the read's page says anything: no toast, no strip, no second surface.
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByText(m.editor_collab_unavailable())).toHaveCount(0);
  await expect(page.locator('[data-error-surface]')).toHaveCount(1);
});
