import { expect, type Page, test } from '@playwright/test';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');

async function openWorkspace(page: Page, width: number) {
  await page.setViewportSize({ height: 900, width });
  await page.goto('/workspaces/ws_bio');
}

test.describe('with the default layout', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the right panel starts closed; a chat row and the header toggle open it', async ({
    page,
  }) => {
    await openWorkspace(page, 1600);
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

    await page
      .getByRole('button', { name: m.workspace_close_right_panel() })
      .click();
    await expect(page.locator('#rail')).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole('button', { name: m.workspace_open_right_panel() })
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#rail')).toBeHidden();
  });

  test('the members menu invites from the Sharing tab', async ({ page }) => {
    await openWorkspace(page, 1600);
    await leftPanel(page)
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

test('the left panel lists chats, opens them in the right panel and archives them', async ({
  page,
}) => {
  await openWorkspace(page, 1600);
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

test('the Files view searches the tree by name', async ({ page }) => {
  await openWorkspace(page, 1600);
  const left = leftPanel(page);
  await left.locator('[data-panel-title]').click();
  await page
    .getByRole('menuitem', { exact: true, name: m.workspace_tab_files() })
    .click();
  await left.getByPlaceholder(m.workspace_search_files()).fill('mendel');
  const tree = left.locator('[data-workspace-file-tree]');
  await expect(tree.getByText('Mendelian genetics.pdf')).toBeVisible();
  await expect(tree.getByText('Cell structure.pdf')).toHaveCount(0);
  // The right panel keeps its own Files view while the left panel is open.
  await showPanelView(page, m.workspace_tab_files());
  await expect(page.locator('[data-workspace-file-tree]')).toHaveCount(2);
});

test('the panel starts open; closed, history lists archived chats', async ({
  page,
}) => {
  await openWorkspace(page, 1366);
  await showPanelView(page, m.workspace_tab_chat());
  await expect(leftPanel(page)).toBeVisible();
  // The rail offers Chat history only while the left panel is closed.
  await page
    .getByRole('button', { name: m.workspace_close_side_panel() })
    .click();
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
  await openWorkspace(page, 1440);
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
