import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { showChatHistory, showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// A workspace opens without Add file's code (MSAL with it) or the chat's
// Markdown code: Add file loads as it's wanted, the Markdown once the page is
// idle (Q681), and a note asks for its one room token as it opens (Q618, Q619).

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

test('a workspace opens without Add file or the chat Markdown: the Markdown loads at idle, Add file on hover', async ({
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
  await showPanelView(page, m.workspace_tab_files());
  await page.waitForTimeout(1500);
  expect(asked(urls, '/AddSourceDialog')).toEqual([]);
  expect(asked(urls, 'msal')).toEqual([]);

  // Hovering what opens it starts the load, before any click.
  await addMenu(page).hover();
  await expect.poll(() => asked(urls, '/AddSourceDialog').length).toBe(1);
  await expect
    .poll(() => asked(urls, 'msal').length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(asked(urls, 'proseBody')).toHaveLength(1);
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

test('hovering Add file offline loads nothing, and online it still opens', async ({
  context,
  page,
}) => {
  const urls = watchRequests(page);
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  await context.setOffline(true);
  await addMenu(page).hover();
  await addMenu(page).focus();
  await page.waitForTimeout(800);
  expect(asked(urls, '/AddSourceDialog')).toEqual([]);
  await context.setOffline(false);
  await openAddFile(page);
  await expect(
    page.getByRole('dialog', { name: m.action_add_file() })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(m.error_chunk_title())).toHaveCount(0);
});

test('a preload that failed says nothing, and only asking to open says so', async ({
  page,
}) => {
  // The Markdown's idle load and Add file's hover both fail, quietly.
  await openWorkspaceAfter(page, async () => {
    await failModule(page, 'proseBody');
    await failModule(page, '/AddSourceDialog');
  });
  await showPanelView(page, m.workspace_tab_files());
  await addMenu(page).hover();
  await page.waitForTimeout(1500);
  await expect(page.getByText(m.error_chunk_title())).toHaveCount(0);
  await showChatHistory(page);
  await page.getByRole('button', { name: SAVED_CHAT }).click();
  await expect(page.locator('[data-prose="failed"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(m.error_chunk_title())).toBeVisible();
});

test('a first Add file on a slow load says so within moments, then opens', async ({
  page,
}) => {
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  const release = await hold(page, '/AddSourceDialog');
  await addMenu(page).click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  const waiting = page.locator('[data-toast="loading"]');
  await expect(waiting).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await release();
  await expect(
    page.getByRole('dialog', { name: m.action_add_file() })
  ).toBeVisible({ timeout: 30_000 });
  await expect(waiting).toHaveCount(0);
});

test('Add file does not arrive once the user has moved elsewhere', async ({
  page,
}) => {
  await openWorkspace(page);
  await showPanelView(page, m.workspace_tab_files());
  const release = await hold(page, '/AddSourceDialog');
  await addMenu(page).click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  const waiting = page.locator('[data-toast="loading"]');
  await expect(waiting).toBeVisible({ timeout: 1000 });
  await page.getByRole('heading', { exact: true, name: 'Biology 101' }).click();
  await expect(waiting).toHaveCount(0);
  await release();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Asked for again, it opens at once.
  await openAddFile(page);
  await expect(
    page.getByRole('dialog', { name: m.action_add_file() })
  ).toBeVisible({ timeout: 2000 });
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
