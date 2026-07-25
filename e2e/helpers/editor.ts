import type { Locator, Page } from '@playwright/test';

export function formattingToolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'Document formatting' });
}

export function allBlocksMenu(page: Page): Locator {
  return page.locator('[data-all-blocks-menu]');
}

export async function openAllBlocks(page: Page): Promise<Locator> {
  await formattingToolbar(page)
    .getByRole('button', { name: 'All blocks' })
    .click();
  const menu = allBlocksMenu(page);
  await menu.waitFor({ state: 'visible' });
  return menu;
}

export async function chooseAllBlocksEntry(
  page: Page,
  name: string
): Promise<void> {
  const menu = await openAllBlocks(page);
  await menu.getByRole('button', { exact: true, name }).click();
}
