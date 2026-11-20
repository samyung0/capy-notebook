import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { showChatHistory, showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// A workspace opens with Add file's dialog but without the drive pickers' code
// (MSAL with OneDrive's) or the chat's Markdown code: the pickers load as
// Import opens (Epo 2026-11-20), the Markdown once the page is idle (Q681), and
// a note asks for its one room token as it opens (Q618).

const WORKSPACE = `/workspaces/${EDITOR_WORKSPACE_ID}`;
const SAVED_CHAT = 'Answer: prose, code + math';

function watchRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

const asked = (urls: string[], part: string) =>
  urls.filter((url) => url.includes(part));

/** Opens the workspace from the list page, after `before` ran there: the chat
 * Markdown's idle load meets whatever it set up. */
async function openWorkspaceAfter(page: Page, before: () => Promise<unknown>) {
  await page.goto('/workspaces');
  await expect(
    page.getByRole('button', { exact: true, name: m.action_new_workspace() })
  ).toBeVisible({ timeout: 60_000 });
  const done = await before();
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, WORKSPACE);
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
  return done;
}

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

/** Holds what the page asks for from a URL matching `pattern`; the returned
 * release lets it go on. */
async function hold(page: Page, pattern: string) {
  await page.evaluate(async (name) => {
    const browserPath = '/src/mocks/browser.ts';
    const { http, worker } = await import(browserPath);
    const held = new Promise((releaseHeld) => {
      Object.assign(window, { releaseHeld });
    });
    worker.use(
      http.all(new RegExp(name), async () => {
        await held;
      })
    );
  }, pattern);
  return () =>
    page.evaluate(() =>
      (window as unknown as { releaseHeld: () => void }).releaseHeld()
    );
}

/** The drive pickers' modules, MSAL among them (its settings' check,
 * msalConfig, comes with the dialog). */
const PICKERS = [
  'googlePicker',
  'onedrivePicker',
  'msalPickerAuth',
  'msal-browser',
];

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

test('a workspace opens with Add file but without its pickers or the chat Markdown, which loads at idle', async ({
  page,
}) => {
  const urls = watchRequests(page);
  await page.goto(WORKSPACE);
  const shown = page.getByRole('heading', { exact: true, name: 'Biology 101' });
  await expect(shown).toBeVisible({ timeout: 60_000 });
  // No chat is open: the page's idle time loads it.
  await expect
    .poll(() => asked(urls, 'proseBody').length, { timeout: 30_000 })
    .toBe(1);
  expect(asked(urls, '/AddSourceDialog')).toHaveLength(1);
  await showPanelView(page, m.workspace_tab_files());
  await addMenu(page).hover();
  await page.waitForTimeout(1500);
  for (const picker of PICKERS) expect(asked(urls, picker)).toEqual([]);
});

test('a saved chat opened offline reads formatted, its Markdown loaded at idle', async ({
  context,
  page,
}) => {
  const urls = watchRequests(page);
  await openWorkspace(page);
  await expect
    .poll(() => asked(urls, 'proseBody').length, { timeout: 30_000 })
    .toBe(1);
  // Asked for at idle: wait until its module graph is in, the dev server's many
  // files included, before the connection goes. The chat's messages are in the
  // cache as the persisted cache would hold them (MSW development stores none).
  await page.evaluate(async () => {
    const paths = [
      '/src/features/workspace/chat/blocks/proseBody.tsx',
      '/src/api/queryClient.ts',
      '/src/api/hooks.ts',
    ];
    const [, { queryClient }, { messagesQuery }] = await Promise.all(
      paths.map((path) => import(path))
    );
    await queryClient.prefetchQuery(messagesQuery('conv_chat-answer-prose'));
  });
  await showChatHistory(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  const answer = page.locator('[data-chat-answer]').first();
  await expect(
    answer.locator('[data-streamdown="strong"]').first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(answer.locator('[data-prose]')).toHaveCount(0);
  await context.setOffline(false);
});

test("Add file opens, and Import loads its Google and Microsoft pickers' code", async ({
  page,
}) => {
  const urls = watchRequests(page);
  await openWorkspace(page);
  await openAddFile(page);
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  await expect(
    dialog.getByRole('button', { name: m.source_upload_computer() })
  ).toBeVisible({ timeout: 30_000 });
  for (const picker of PICKERS) expect(asked(urls, picker)).toEqual([]);
  await dialog.getByRole('tab', { name: m.action_import() }).click();
  for (const picker of PICKERS)
    await expect
      .poll(() => asked(urls, picker).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
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

test("closing Add file while a picker's code loads leaves nothing to arrive", async ({
  page,
}) => {
  const urls = watchRequests(page);
  // Without its upload policy an inspection would not start anyway.
  const policy = page.waitForResponse((response) =>
    response.url().includes('source-upload-policy')
  );
  await openWorkspace(page);
  await openAddFile(page);
  await policy;
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  const release = await hold(page, 'googlePicker');
  await dialog.getByRole('tab', { name: m.action_import() }).click();
  const google = dialog.getByRole('button', { name: 'Google Drive' });
  await google.click();
  // The press holds the pickers while its code loads.
  await expect(google).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'OneDrive' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await release();
  await page.waitForTimeout(1500);
  expect(asked(urls, 'import-inspect')).toEqual([]);
});

test('a picker pressed twice while its code loads opens once', async ({
  page,
}) => {
  const urls = watchRequests(page);
  const policy = page.waitForResponse((response) =>
    response.url().includes('source-upload-policy')
  );
  await openWorkspace(page);
  await openAddFile(page);
  await policy;
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  const release = await hold(page, 'googlePicker');
  await dialog.getByRole('tab', { name: m.action_import() }).click();
  await dialog
    .getByRole('button', { name: 'Google Drive' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await release();
  await expect(
    dialog.getByText('cloud-notes-1.docx', { exact: true })
  ).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(asked(urls, 'import-inspect')).toHaveLength(1);
});

test('a picker whose code will not load says so when pressed, and the dialog stays', async ({
  page,
}) => {
  await openWorkspace(page);
  await failModule(page, 'googlePicker');
  await openAddFile(page);
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  await dialog.getByRole('tab', { name: m.action_import() }).click();
  // Import's load ahead failing says nothing.
  await page.waitForTimeout(1500);
  const failed = page.getByText(m.error_chunk_title(), { exact: true });
  await expect(failed).toHaveCount(0);
  await expect(async () => {
    await dialog.getByRole('button', { name: 'Google Drive' }).click();
    await expect(failed).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-error-surface]')).toHaveCount(0);
});

test('Add file opens offline at once', async ({ context, page }) => {
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  await context.setOffline(true);
  await openAddFile(page);
  // The page's own offline toast shows; the dialog needs nothing more.
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  await expect(
    dialog.getByRole('button', { name: m.source_upload_computer() })
  ).toBeVisible({ timeout: 2000 });
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
  await openWorkspaceAfter(page, () => failModule(page, 'proseBody'));
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

test("an editor's note asks for its one token while its read is out", async ({
  page,
}) => {
  await openWorkspace(page);
  const release = await hold(page, `/api/materials/${EDITOR_NOTE.id}$`);
  const urls = watchRequests(page);
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator(`[data-workspace-file-tree] a[href*="material=${EDITOR_NOTE.id}"]`)
    .click();
  await expect.poll(() => asked(urls, TOKEN).length).toBe(1);
  // The comments go behind the read, as an editor's Plate mounts.
  expect(asked(urls, DISCUSSIONS)).toEqual([]);
  await release();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(
    editor.getByText(EDITOR_NOTE.firstParagraph).first()
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(asked(urls, TOKEN)).toHaveLength(1);
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
  expect(tokens).toEqual([null]);
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

test('someone refused, then let in, opens the note on a fresh token', async ({
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
  const link = (id: string) =>
    page.locator(`[data-workspace-file-tree] a[href*="material=${id}"]`);
  await link(EDITOR_NOTE.id).click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const { worker } = await import(browserPath);
    worker.resetHandlers();
  });
  await link('mat_note_1').click();
  await expect(page.getByText(m.error_not_found_title())).toHaveCount(0, {
    timeout: 30_000,
  });
  await link(EDITOR_NOTE.id).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(
    editor.getByText(EDITOR_NOTE.firstParagraph).first()
  ).toBeVisible({ timeout: 60_000 });
  expect(asked(urls, TOKEN)).toHaveLength(2);
});

test('an answer past 2 s of waiting shows its words, busy, and formats when its code lands', async ({
  page,
}) => {
  const release = await openWorkspaceAfter(page, () => hold(page, 'proseBody'));
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  const held = page.locator('[data-chat-answer] [data-prose]').first();
  await expect(held).toBeAttached({ timeout: 30_000 });
  await expect(held).toBeHidden();
  await expect(held).toHaveAttribute('aria-busy', 'true');
  // A sentence of the fixture, raw markers and all.
  await expect(held).toBeVisible({ timeout: 4000 });
  await expect(held).toHaveAttribute('data-prose', 'slow');
  await expect(held).toContainText('**');
  await release();
  const answer = page.locator('[data-chat-answer]').first();
  await expect(
    answer.locator('[data-streamdown="strong"]').first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(answer.locator('[data-prose]')).toHaveCount(0);
});

/** The chat's scroller, short enough that a saved chat overflows it. */
async function openHeldChat(page: Page) {
  await page.setViewportSize({ height: 420, width: 1280 });
  const release = await openWorkspaceAfter(page, () => hold(page, 'proseBody'));
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  await expect(
    page.locator('[data-chat-answer] [data-prose]').first()
  ).toBeAttached({ timeout: 30_000 });
  const thread = page
    .locator('[data-chat-answer]')
    .first()
    .locator('xpath=ancestor::div[contains(@class,"scroll-fade-y")][1]');
  await expect
    .poll(() =>
      thread.evaluate((box) => box.scrollHeight > box.clientHeight + 40)
    )
    .toBe(true);
  return { release, thread };
}

const distanceToEnd = (box: Element) =>
  box.scrollHeight - box.clientHeight - box.scrollTop;

test('a reader at the end stays there as the Markdown lands', async ({
  page,
}) => {
  const { release, thread } = await openHeldChat(page);
  await release();
  await expect(page.locator('[data-streamdown="strong"]').first()).toBeAttached(
    { timeout: 30_000 }
  );
  await expect.poll(() => thread.evaluate(distanceToEnd)).toBeLessThan(8);
});

test('a reader who scrolled up keeps their place as the Markdown lands', async ({
  page,
}) => {
  const { release, thread } = await openHeldChat(page);
  await thread.evaluate((box) => {
    box.scrollTop = 0;
  });
  // The scroll event has been handled.
  await page.waitForTimeout(200);
  await release();
  await expect(page.locator('[data-streamdown="strong"]').first()).toBeAttached(
    { timeout: 30_000 }
  );
  await page.waitForTimeout(200);
  expect(await thread.evaluate((box) => box.scrollTop)).toBe(0);
});

test('a preload that failed says nothing, and only asking to open says so', async ({
  page,
}) => {
  // The Markdown's idle load fails, quietly.
  await openWorkspaceAfter(page, () => failModule(page, 'proseBody'));
  await page.waitForTimeout(1500);
  await expect(page.getByText(m.error_chunk_title())).toHaveCount(0);
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  await expect(page.locator('[data-prose="failed"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(m.error_chunk_title())).toBeVisible();
});

test('a link with ?add= opens Add file', async ({ page }) => {
  await page.goto(`${WORKSPACE}?add=upload`);
  await expect(
    page.getByRole('dialog', { name: m.action_add_file() })
  ).toBeVisible({ timeout: 60_000 });
});

test('coming back from connecting a drive reopens Add file on Import', async ({
  page,
}) => {
  await page.addInitScript(
    ([key, value]) => sessionStorage.setItem(key, value),
    [
      'capy:connect-resume',
      JSON.stringify({ provider: 'google', workspaceId: EDITOR_WORKSPACE_ID }),
    ]
  );
  await page.goto(WORKSPACE);
  const dialog = page.getByRole('dialog', { name: m.action_add_file() });
  await expect(
    dialog.getByRole('tab', { name: m.action_import(), selected: true })
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('capy:connect-resume'))
    )
    .toBeNull();
});
