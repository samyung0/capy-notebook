import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// From lg Files and Chat are pages: a side panel beside the rail and the centre.
// The one chat is the Chat page's centre, or a window over a file opened from
// the Files page's chat button (Epo 2026-11-14).
const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');
const chatPage = (page: Page) => page.locator('[data-workspace-chat-page]');
const composer = (page: Page) =>
  chatPage(page).getByRole('textbox', { name: m.chat_placeholder() });
const chatButton = (page: Page) => page.locator('[data-workspace-chat-button]');

async function openWorkspace(page: Page, width: number, search = '') {
  await page.setViewportSize({ height: 900, width });
  await page.goto(`/workspaces/ws_bio${search}`);
}

const railButton = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { exact: true, name });

/** Picks a section in the workspace rail; the landing shows the Dashboard. */
async function openSection(page: Page, name: string) {
  await railButton(page, name).click({ timeout: 60_000 });
}

/** The Chat page on one of its chats. */
async function openChatRow(page: Page, name = 'What is a cell?') {
  await openSection(page, m.workspace_section_agent());
  await leftPanel(page).getByRole('button', { name }).click({
    timeout: 60_000,
  });
  await expect(chatPage(page).getByRole('heading', { name })).toBeVisible();
}

/** A file from the Files page's tree. */
async function openFile(page: Page, name: string) {
  await openSection(page, m.workspace_tab_files());
  await leftPanel(page)
    .locator('[data-workspace-file-tree]')
    .getByText(name)
    .click();
  await expect(
    page.locator('#viewer').getByRole('heading', { name })
  ).toBeVisible();
}

const width = async (page: Page, id: string) =>
  Math.round((await page.locator(`#${id}`).boundingBox())?.width ?? 0);

test("the rail avatar menu invites from Members' Manage tab", async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { name: m.workspace_account_menu() })
    .click({ timeout: 60_000 });
  await page
    .getByRole('menuitem', { name: m.workspace_invite_member() })
    .click();
  await expect(page).toHaveURL(/\/workspaces\/ws_bio\/members$/);
  await expect(
    page.getByRole('tab', { name: m.members_tab_manage(), selected: true })
  ).toBeVisible();
  await expect(
    page.getByPlaceholder(m.members_invite_placeholder())
  ).toBeVisible();
});

test('the Chat page lists chats beside the one it shows', async ({ page }) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_section_agent());
  await expect(page).toHaveURL(/view=chat/);
  const left = leftPanel(page);
  await expect(left.getByText(m.chat_group_pinned())).toBeVisible({
    timeout: 60_000,
  });
  expect(await width(page, 'left')).toBe(340);
  await expect(chatPage(page)).toHaveAttribute(
    'data-workspace-chat-page',
    'page'
  );
  // The Chat page has no chat button.
  await expect(chatButton(page)).toHaveCount(0);

  await left.getByRole('button', { name: 'What is a cell?' }).click();
  await expect(
    chatPage(page).getByRole('heading', { name: 'What is a cell?' })
  ).toBeVisible();
  await expect(chatPage(page).getByText('A cell is the basic')).toBeVisible();
  await expect(
    left.getByRole('button', { name: 'What is a cell?' })
  ).toHaveAttribute('aria-current', 'true');

  await chatPage(page)
    .getByRole('button', { name: m.a11y_open_menu() })
    .click();
  await page.getByRole('menuitem', { name: m.chat_new() }).click();
  await expect(
    chatPage(page).getByRole('heading', { name: m.chat_new() })
  ).toBeVisible();
  await expect(composer(page)).toBeVisible();
});

test('Get started opens a new chat on the Chat page', async ({ page }) => {
  await openWorkspace(page, 1600, '?chat=new');
  await expect(composer(page)).toBeVisible({ timeout: 60_000 });
  await expect(railButton(page, m.workspace_section_agent())).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(
    chatPage(page).getByRole('heading', { name: m.chat_new() })
  ).toBeVisible();
  await expect(page).not.toHaveURL(/chat=new/);
});

test('Agent lists chats and archives, restores and deletes them', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_section_agent());
  const left = leftPanel(page);
  await expect(left.getByText(m.chat_group_pinned())).toBeVisible({
    timeout: 60_000,
  });
  const target = left.getByRole('button', { name: 'What is a cell?' });
  await target.hover();
  await target
    .locator('..')
    .getByRole('button', { name: m.a11y_open_menu() })
    .click();
  await page.getByRole('menuitem', { name: m.chat_archive() }).click();
  await expect(target).toHaveCount(0);

  await left.getByRole('button', { name: m.chat_archived_title() }).click();
  const dialog = page.getByRole('dialog', { name: m.chat_archived_title() });
  await expect(dialog.getByText('What is a cell?')).toBeVisible();
  await dialog.getByRole('button', { name: m.chat_unarchive_all() }).click();
  await expect(dialog.getByText(m.common_nothing_yet())).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(target).toBeVisible();

  // Delete asks first.
  await target.hover();
  await target
    .locator('..')
    .getByRole('button', { name: m.a11y_open_menu() })
    .click();
  await page.getByRole('menuitem', { name: m.action_delete() }).click();
  const confirm = page.getByRole('dialog', {
    name: m.chat_delete_title({ title: 'What is a cell?' }),
  });
  await confirm.getByRole('button', { name: m.action_delete() }).click();
  await expect(target).toHaveCount(0);
  // The list stays; the deleted chat left the centre for a new one.
  await expect(left.getByText(m.chat_group_pinned())).toBeVisible();
});

test('the Files page shows recent files, and its chat button opens a window over the file', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_tab_files());
  await expect(page).toHaveURL(/view=files/);
  await expect(
    page
      .locator('#viewer')
      .getByRole('heading', { name: m.dashboard_recent_files() })
  ).toBeVisible({ timeout: 60_000 });
  // With nothing open the window opens over the recent files, still Files.
  await chatButton(page).click();
  await expect(chatPage(page)).toHaveAttribute(
    'data-workspace-chat-page',
    'window'
  );
  await expect(page).toHaveURL(/view=files-chat/);
  await chatPage(page).getByRole('button', { name: m.action_close() }).click();
  await expect(page).toHaveURL(/view=files$/);
  await openFile(page, 'Mendelian genetics.pdf');

  await chatButton(page).click();
  await expect(chatPage(page)).toHaveAttribute(
    'data-workspace-chat-page',
    'window'
  );
  await expect(page).toHaveURL(/file=.*view=chat|view=chat.*file=/);
  await expect(
    page.locator('#viewer').getByRole('heading', {
      name: 'Mendelian genetics.pdf',
    })
  ).toBeVisible();
  await chatPage(page).getByRole('button', { name: m.action_close() }).click();
  await expect(chatPage(page)).toBeHidden();
  await expect(chatButton(page)).toBeVisible();

  // Expand moves the same chat to the Chat page.
  await chatButton(page).click();
  await chatPage(page)
    .getByRole('button', { name: m.chat_open_page() })
    .click();
  await expect(chatPage(page)).toHaveAttribute(
    'data-workspace-chat-page',
    'page'
  );
  await expect(page).not.toHaveURL(/file=/);
  await expect(leftPanel(page).getByText(m.chat_group_pinned())).toBeVisible();
});

test('a file a chat opens shows under its window, the chat kept', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openChatRow(page);
  await chatPage(page)
    .getByRole('button', { name: /exchange-plan\.docx/ })
    .click();
  await expect(
    page.locator('#viewer').getByRole('heading', { name: 'exchange-plan.docx' })
  ).toBeVisible();
  await expect(chatPage(page)).toHaveAttribute(
    'data-workspace-chat-page',
    'window'
  );
  await expect(chatPage(page).getByText('A cell is the basic')).toBeVisible();
  await expect(railButton(page, m.workspace_tab_files())).toHaveAttribute(
    'aria-current',
    'page'
  );
});

test('other pages have no side panel and no chat button', async ({ page }) => {
  await openWorkspace(page, 1440);
  await expect(
    page
      .locator('#viewer')
      .getByRole('heading', { level: 1, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left')).toBeHidden();
  await expect(chatButton(page)).toHaveCount(0);
  await openSection(page, m.study_panel_practice());
  await expect(
    page
      .locator('#viewer')
      .getByRole('heading', { level: 1, name: m.study_panel_practice() })
  ).toBeVisible();
  await expect(page.locator('#left')).toBeHidden();
  await expect(chatButton(page)).toHaveCount(0);
});

test('a chat keeps its draft through other pages and streams on while hidden', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openChatRow(page);
  await composer(page).fill('A draft kept');

  await openSection(page, m.workspace_tab_files());
  await expect(composer(page)).toBeHidden();
  await openSection(page, m.workspace_section_dashboard());
  await expect(page.locator('#left')).toBeHidden();
  await openSection(page, m.workspace_section_agent());
  await expect(
    chatPage(page).getByRole('heading', { name: 'What is a cell?' })
  ).toBeVisible();
  await expect(composer(page)).toHaveValue('A draft kept');

  // Sent, then left: the answer lands while the chat is hidden.
  await composer(page).press('Enter');
  const stop = chatPage(page).getByRole('button', { name: m.chat_stop() });
  await expect(stop).toBeVisible();
  await openSection(page, m.workspace_tab_files());
  await expect(composer(page)).toBeHidden();
  await page.waitForTimeout(4000);
  await openSection(page, m.workspace_section_agent());
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(
    chatPage(page).locator('[data-chat-answer]').last()
  ).toBeInViewport();
});

test('Files shows one tree under its search; pressing the shown section folds and unfolds its side panel', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_tab_files());
  const left = leftPanel(page);
  const tree = page.locator('[data-workspace-file-tree]');
  await expect(tree).toHaveCount(1);
  await expect(tree.getByText('Cell structure.pdf')).toBeVisible();
  await left.getByPlaceholder(m.workspace_search_files()).fill('mendel');
  await expect(tree.getByText('Mendelian genetics.pdf')).toBeVisible();
  await expect(tree.getByText('Cell structure.pdf')).toHaveCount(0);

  await openSection(page, m.workspace_tab_files());
  await expect(page.locator('#left')).toBeHidden();
  await expect(tree).toHaveCount(0);
  await expect(page).toHaveURL(/view=files/);
  await openSection(page, m.workspace_tab_files());
  await expect(tree.getByText('Cell structure.pdf')).toBeVisible();
});

test('a page has one h1', async ({ page }) => {
  await openWorkspace(page, 1440);
  const headings = page.locator('h1');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
  await expect(headings).toHaveCount(1);
  await openSection(page, m.study_panel_practice());
  await expect(
    page.getByRole('heading', { level: 1, name: m.study_panel_practice() })
  ).toBeVisible();
  await expect(headings).toHaveCount(1);
  await openFile(page, 'Cell structure.pdf');
  await expect(headings).toHaveCount(1);
  await openSection(page, m.workspace_section_agent());
  await expect(leftPanel(page).getByText(m.chat_group_pinned())).toBeVisible();
  await expect(headings).toHaveCount(1);
});

test('the side panel handle trades width with the viewer up to half the group, collapsing and restoring within one drag', async ({
  page,
}) => {
  await openWorkspace(page, 1366);
  await openChatRow(page);
  const start = await width(page, 'left');
  expect(start).toBe(340);
  const group = start + (await width(page, 'viewer'));
  // Holds the handle and moves it to each offset in turn, then lets go.
  const drag = async (steps: [number, () => Promise<void>][]) => {
    const box = await page
      .locator('[data-slot=resizable-handle]')
      .boundingBox();
    if (!box) throw new Error('No handle');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const [dx, check] of steps) {
      await page.mouse.move(x + dx, y, { steps: 4 });
      await check();
    }
    await page.mouse.up();
  };

  // Wider, the panel stops at half; the viewer keeps the rest.
  await drag([
    [
      900,
      async () => expect(await width(page, 'left')).toBe(Math.round(group / 2)),
    ],
  ]);
  const wide = await width(page, 'left');
  expect(await width(page, 'viewer')).toBeGreaterThan(400);
  // Files and Chat share that width.
  await openSection(page, m.workspace_tab_files());
  expect(await width(page, 'left')).toBe(wide);

  // Back and forth past its least width, the panel collapses and returns.
  await drag([
    [-wide, async () => expect(await width(page, 'left')).toBe(0)],
    [0, async () => expect(await width(page, 'left')).toBe(wide)],
  ]);
  expect(await width(page, 'left')).toBe(wide);
});

test('the page is in the URL, back steps through it, and a new visit opens the Dashboard', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await openSection(page, m.workspace_section_agent());
  await expect(page).toHaveURL(/view=chat/);
  await openSection(page, m.workspace_tab_files());
  await expect(page).toHaveURL(/view=files/);
  await expect(
    page.locator('[data-workspace-file-tree]').first()
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/view=chat/);
  await expect(railButton(page, m.workspace_section_agent())).toHaveAttribute(
    'aria-current',
    'page'
  );

  // A new visit opens the Dashboard, whatever was open last time.
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Biology 101' })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.locator('#left')).toBeHidden();
});

test('the chat list comes a page at a time, and a search looks through every page', async ({
  page,
}) => {
  test.slow();
  // Short enough that the first page's end is out of reach until scrolled to.
  await page.setViewportSize({ height: 600, width: 1600 });
  // A page that reads none of this workspace's chats; the mocks forget on a reload.
  await page.goto('/files');
  await expect(page.getByRole('heading', { name: m.nav_files() })).toBeVisible({
    timeout: 60_000,
  });
  const before = await page.evaluate(async () => {
    const listed = await fetch('/api/workspaces/ws_bio/conversations');
    await Promise.all(
      Array.from({ length: 110 }, (_, at) =>
        fetch('/api/workspaces/ws_bio/conversations', {
          body: JSON.stringify({ title: `Paged chat ${at + 1}` }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      )
    );
    return ((await listed.json()) as { items: unknown[] }).items.length;
  });
  await page.evaluate(() => {
    history.pushState({}, '', '/workspaces/ws_bio');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await openSection(page, m.workspace_section_agent());
  const list = leftPanel(page).locator('.scroll-fade-y').first();
  const rows = list.locator('.line-clamp-1');
  await expect(rows).toHaveCount(50, { timeout: 60_000 });
  // The list's end loads the next page.
  await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(rows).toHaveCount(100);
  // The oldest chat is on the last page, which a search goes on to load.
  const search = leftPanel(page).getByRole('textbox', {
    name: m.chat_search(),
  });
  await search.fill('What is a cell');
  await expect(
    leftPanel(page).getByRole('button', { name: 'What is a cell?' })
  ).toBeVisible();
  await search.fill('');
  await expect(rows).toHaveCount(before + 110);
});
