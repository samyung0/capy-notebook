import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');
const composer = (page: Page) =>
  leftPanel(page).getByRole('textbox', { name: m.chat_placeholder() });

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

/** Agent on one of its chats. */
async function openChatRow(page: Page, name = 'What is a cell?') {
  await openSection(page, m.workspace_section_agent());
  await leftPanel(page).getByRole('button', { name }).click({
    timeout: 60_000,
  });
  await expect(leftPanel(page).getByRole('heading', { name })).toBeVisible();
}

const width = async (page: Page, id: string) =>
  Math.round((await page.locator(`#${id}`).boundingBox())?.width ?? 0);

test('the rail avatar menu invites from the Sharing tab', async ({ page }) => {
  await openWorkspace(page, 1600);
  await page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { name: m.workspace_account_menu() })
    .click({ timeout: 60_000 });
  await page
    .getByRole('menuitem', { name: m.workspace_invite_member() })
    .click();
  await expect(page).toHaveURL(/settings=sharing/);
  await expect(
    page
      .getByRole('dialog', { name: m.workspace_settings() })
      .getByRole('tab', { name: m.workspace_sharing(), selected: true })
  ).toBeVisible();
});

test('a chat replaces the history in the same panel, at the same width, and back returns to it', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_section_agent());
  const left = leftPanel(page);
  const pinned = left.getByText(m.chat_group_pinned());
  await expect(pinned).toBeVisible({ timeout: 60_000 });
  expect(await width(page, 'left')).toBe(340);

  await left.getByRole('button', { name: 'What is a cell?' }).click();
  await expect(
    left.getByRole('heading', { name: 'What is a cell?' })
  ).toBeVisible();
  await expect(left.getByText('A cell is the basic')).toBeVisible();
  await expect(pinned).toBeHidden();
  expect(await width(page, 'left')).toBe(340);

  await left.getByRole('button', { name: m.chat_history() }).click();
  await expect(pinned).toBeVisible();
  await expect(
    left.getByRole('button', { name: 'What is a cell?' })
  ).toHaveAttribute('aria-current', 'true');

  await left.getByRole('button', { name: m.chat_new() }).click();
  await expect(left.getByRole('heading', { name: m.chat_new() })).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(pinned).toBeHidden();
});

test('Get started opens a new chat in Agent', async ({ page }) => {
  await openWorkspace(page, 1600, '?chat=new');
  await expect(composer(page)).toBeVisible({ timeout: 60_000 });
  await expect(railButton(page, m.workspace_section_agent())).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(
    leftPanel(page).getByRole('heading', { name: m.chat_new() })
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
  await expect(dialog.getByText(m.chat_no_archived())).toBeVisible();
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
  // The history stays; the deleted chat left the chat panel for a new one.
  await expect(left.getByText(m.chat_group_pinned())).toBeVisible();
});

test('a file stays open beside a chat, and a citation opens in the centre with the chat kept', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_tab_files());
  await leftPanel(page)
    .locator('[data-workspace-file-tree]')
    .getByText('Mendelian genetics.pdf')
    .click();
  const centre = page.locator('#viewer');
  await expect(
    centre.getByRole('heading', { name: 'Mendelian genetics.pdf' })
  ).toBeVisible();

  await openChatRow(page);
  await expect(
    centre.getByRole('heading', { name: 'Mendelian genetics.pdf' })
  ).toBeVisible();

  await leftPanel(page)
    .getByRole('button', { name: /exchange-plan\.docx/ })
    .click();
  await expect(
    centre.getByRole('heading', { name: 'exchange-plan.docx' })
  ).toBeVisible();
  await expect(leftPanel(page).getByText('A cell is the basic')).toBeVisible();
  await expect(railButton(page, m.workspace_section_agent())).toHaveAttribute(
    'aria-current',
    'page'
  );
});

test('a chat sits beside the Dashboard, and a Practice page, which keep the centre', async ({
  page,
}) => {
  await openWorkspace(page, 1440);
  const dashboard = page
    .locator('#viewer')
    .getByRole('heading', { level: 1, name: 'Biology 101' });
  await expect(dashboard).toBeVisible({ timeout: 60_000 });
  // The Dashboard has no panel.
  await expect(page.locator('#left')).toBeHidden();
  await openChatRow(page);
  await expect(dashboard).toBeVisible();

  await openSection(page, m.workspace_tab_study());
  await expect(
    page
      .locator('#viewer')
      .getByRole('heading', { level: 1, name: m.study_panel_practice() })
  ).toBeVisible();
  await openSection(page, m.workspace_section_agent());
  await expect(leftPanel(page).getByText('A cell is the basic')).toBeVisible();
  await expect(
    page
      .locator('#viewer')
      .getByRole('heading', { level: 1, name: m.study_panel_practice() })
  ).toBeVisible();
});

test('a chat keeps its draft through other sections and streams on while hidden', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openChatRow(page);
  await expect(leftPanel(page).getByText('A cell is the basic')).toBeVisible();
  await composer(page).fill('A draft kept');

  await openSection(page, m.workspace_tab_files());
  await expect(
    leftPanel(page).locator('[data-workspace-file-tree]')
  ).toHaveCount(1);
  await expect(composer(page)).toBeHidden();
  await openSection(page, m.workspace_section_dashboard());
  await expect(page.locator('#left')).toBeHidden();
  await openSection(page, m.workspace_section_agent());
  await expect(
    leftPanel(page).getByRole('heading', { name: 'What is a cell?' })
  ).toBeVisible();
  await expect(composer(page)).toHaveValue('A draft kept');

  // Sent, then left: the answer lands while the chat is hidden.
  await composer(page).press('Enter');
  const stop = leftPanel(page).getByRole('button', { name: m.chat_stop() });
  await expect(stop).toBeVisible();
  await openSection(page, m.workspace_tab_files());
  await expect(composer(page)).toBeHidden();
  await page.waitForTimeout(4000);
  await openSection(page, m.workspace_section_agent());
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(
    leftPanel(page).locator('[data-chat-answer]').last()
  ).toBeInViewport();
});

test('Files shows one tree under its search; pressing the shown section closes and reopens its panel', async ({
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
  await openSection(page, m.workspace_tab_study());
  await expect(
    page.getByRole('heading', { level: 1, name: m.study_panel_practice() })
  ).toBeVisible();
  await expect(headings).toHaveCount(1);
  await openSection(page, m.workspace_tab_files());
  await page
    .locator('[data-workspace-file-tree]')
    .getByText('Cell structure.pdf')
    .click();
  await expect(
    page.getByRole('heading', { name: 'Cell structure.pdf' })
  ).toBeVisible();
  await expect(headings).toHaveCount(1);
});

test('the panel handle trades width with the viewer up to half the group, collapsing and restoring within one drag', async ({
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
  // The chat and history share that width.
  await leftPanel(page).getByRole('button', { name: m.chat_history() }).click();
  expect(await width(page, 'left')).toBe(wide);
  await openSection(page, m.workspace_tab_files());
  expect(await width(page, 'left')).toBe(wide);

  // Back and forth past its least width, the panel collapses and returns.
  await drag([
    [-wide, async () => expect(await width(page, 'left')).toBe(0)],
    [0, async () => expect(await width(page, 'left')).toBe(wide)],
  ]);
  expect(await width(page, 'left')).toBe(wide);
});

test('the open panel is in the URL, back steps through it, and each workspace remembers its own', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  const rail = page.getByRole('navigation', {
    name: m.workspace_rail_label(),
  });
  const section = (name: string) =>
    rail.getByRole('button', { exact: true, name });
  const panel = page.locator('[data-workspace-left-panel]');
  await section(m.workspace_section_agent()).click({ timeout: 60_000 });
  await expect(page).toHaveURL(/panel=agent/);
  await section(m.workspace_tab_files()).click();
  await expect(page).toHaveURL(/panel=files/);
  await expect(
    page.locator('[data-workspace-file-tree]').first()
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/panel=agent/);
  await expect(section(m.workspace_section_agent())).toHaveAttribute(
    'aria-current',
    'page'
  );

  // Visiting again opens what was last open, here and only here.
  await page.goto('/workspaces/ws_bio');
  await expect(page).toHaveURL(/panel=agent/);
  await expect(panel).toBeVisible();
  await page.goto('/workspaces/ws_eng');
  await expect(page).toHaveURL(/panel=none/);
  await expect(panel).toBeHidden();
});
