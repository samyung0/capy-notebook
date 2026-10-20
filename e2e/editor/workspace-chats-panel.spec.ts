import { expect, type Page, test } from '@playwright/test';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');

async function openWorkspace(page: Page, width: number) {
  await page.setViewportSize({ height: 900, width });
  await page.goto('/workspaces/ws_bio');
}

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
  await expect(left.getByRole('button', { name: /Kate Malone/ })).toBeVisible();

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

test('below 1536px the panel starts closed and history lists archived chats', async ({
  page,
}) => {
  await openWorkspace(page, 1366);
  await showPanelView(page, m.workspace_tab_chat());
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
