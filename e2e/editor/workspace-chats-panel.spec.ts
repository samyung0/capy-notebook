import { expect, type Page, test } from '@playwright/test';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');

async function openWorkspace(page: Page, width: number) {
  await page.setViewportSize({ height: 900, width });
  await page.goto('/workspaces/ws_bio');
}

/** Picks a section in the workspace rail; the landing shows the Dashboard. */
async function openSection(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { exact: true, name })
    .click({ timeout: 60_000 });
}

test.describe('with the default layout', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the right panel starts closed; a chat row and the header toggle open it', async ({
    page,
  }) => {
    await openWorkspace(page, 1600);
    await openSection(page, m.workspace_section_agent());
    const left = leftPanel(page);
    await expect(left.getByText(m.chat_group_pinned())).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('#rail')).toBeHidden();

    await left.getByRole('button', { name: 'What is a cell?' }).click();
    await expect(page.locator('[data-panel-title]').last()).toHaveText(
      m.workspace_tab_chat()
    );
    await expect(page.getByText('A cell is the basic')).toBeVisible();

    // The toggle sits in a file's header (the Dashboard has none, boards H1,
    // H2). Files swaps in the section tree around the chat, which keeps going.
    await openSection(page, m.workspace_tab_files());
    await left
      .locator('[data-workspace-file-tree]')
      .getByText('Cell structure.pdf')
      .click();
    await expect(page.getByText('A cell is the basic')).toBeVisible();
    await page
      .getByRole('button', { name: m.workspace_close_right_panel() })
      .click();
    await expect(page.locator('#rail')).toBeHidden();
    await page.reload();
    const open = page.getByRole('button', {
      name: m.workspace_open_right_panel(),
    });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#rail')).toBeHidden();
    await open.click();
    await expect(page.locator('#rail')).toBeVisible();
  });

  test('the rail avatar menu invites from the Sharing tab', async ({
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
    await expect(page).toHaveURL(/settings=sharing/);
    await expect(
      page
        .getByRole('dialog', { name: m.workspace_settings() })
        .getByRole('tab', { name: m.workspace_sharing(), selected: true })
    ).toBeVisible();
  });
});

test('Agent lists chats, opens them in the right panel and archives them', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_section_agent());
  const left = leftPanel(page);
  await expect(left.getByText(m.chat_group_pinned())).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    left.getByRole('button', { name: 'Exam plan for the cell unit' })
  ).toBeVisible();

  await left.getByRole('button', { name: 'What is a cell?' }).click();
  await expect(page.locator('[data-panel-title]').last()).toHaveText(
    m.workspace_tab_chat()
  );
  await expect(page.getByText('A cell is the basic')).toBeVisible();

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
});

test('Files shows the one tree beside the rail; closed, the right panel has Files with its search', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
  await openSection(page, m.workspace_tab_files());
  const left = leftPanel(page);
  await expect(
    left.locator('[data-workspace-file-tree]').getByText('Cell structure.pdf')
  ).toBeVisible();
  // One Files tree at a time: the right panel offers Chat alone meanwhile.
  await expect(page.locator('[data-workspace-file-tree]')).toHaveCount(1);
  // Pressing the shown section again closes its panel; the right panel's
  // Files view, with its search, comes back.
  await openSection(page, m.workspace_tab_files());
  await expect(left).toHaveCount(0);
  const open = page.getByRole('button', {
    exact: true,
    name: m.workspace_open_right_panel(),
  });
  if (await open.isVisible()) await open.click();
  const right = page.locator('#rail');
  const title = right.locator('[data-panel-title]');
  if ((await title.textContent())?.trim() !== m.workspace_tab_files()) {
    await title.click();
    await page
      .getByRole('menuitem', { exact: true, name: m.workspace_tab_files() })
      .click();
  }
  await right.getByPlaceholder(m.workspace_search_files()).fill('mendel');
  const tree = right.locator('[data-workspace-file-tree]');
  await expect(tree.getByText('Mendelian genetics.pdf')).toBeVisible();
  await expect(tree.getByText('Cell structure.pdf')).toHaveCount(0);
});

test('the Dashboard has no panel; there, history lists archived chats', async ({
  page,
}) => {
  await openWorkspace(page, 1366);
  await showPanelView(page, m.workspace_tab_chat());
  // The right panel's chat offers history only while no section panel shows.
  await expect(leftPanel(page)).toHaveCount(0);
  await page.getByRole('button', { name: m.chat_history() }).click();
  const history = page.getByRole('dialog', { name: m.chat_history() });
  await expect(
    history.getByRole('button', { name: 'Exam plan for the cell unit' })
  ).toBeVisible();
  await history.getByRole('button', { name: m.chat_see_archived() }).click();
  await expect(
    page
      .getByRole('dialog', { name: m.chat_archived_title() })
      .getByText('Lab report draft questions')
  ).toBeVisible();
});

test('a side panel handle trades width with the viewer alone, collapsing and restoring its own panel within one drag', async ({
  page,
}) => {
  // Narrow enough for the viewer's least width to stop the rail: from about
  // 1430px the rail's 50% cap stops it first, with the viewer still wider.
  await openWorkspace(page, 1366);
  await openSection(page, m.workspace_section_agent());
  const left = leftPanel(page);
  await left.getByRole('button', { name: 'What is a cell?' }).click({
    timeout: 60_000,
  });
  await expect(page.locator('#rail')).toBeVisible();
  const width = async (id: string) =>
    Math.round((await page.locator(`#${id}`).boundingBox())?.width ?? 0);
  const files = await width('files');
  const rail = await width('rail');
  // Holds a handle and moves it to each offset in turn, then lets go.
  const drag = async (
    handle: number,
    steps: [number, () => Promise<void>][]
  ) => {
    const box = await page
      .locator('[data-slot=resizable-handle]')
      .nth(handle)
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

  // The rail grows until the viewer is at its least width; the left panel
  // keeps its width.
  await drag(1, [[-600, async () => expect(await width('files')).toBe(files)]]);
  expect(await width('viewer')).toBe(400);
  const wide = await width('rail');
  expect(wide).toBeGreaterThan(rail);
  // Back and forth past its least width, the rail collapses and returns.
  await drag(1, [
    [wide, async () => expect(await width('rail')).toBe(0)],
    [0, async () => expect(await width('rail')).toBe(wide)],
  ]);
  // With the viewer at its least width the left panel cannot grow into the
  // rail; back and forth past its own least width it collapses and returns,
  // the rail keeping its width throughout.
  await drag(0, [
    [300, async () => expect(await width('rail')).toBe(wide)],
    [-files, async () => expect(await width('files')).toBe(0)],
    [0, async () => expect(await width('files')).toBe(files)],
    [300, async () => expect(await width('rail')).toBe(wide)],
  ]);
  expect(await width('files')).toBe(files);
  expect(await width('rail')).toBe(wide);
});
