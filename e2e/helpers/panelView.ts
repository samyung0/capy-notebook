import type { Page } from '@playwright/test';

/** Shows a view of the workspace's right panel (Files, Chat, Study) through
 * its title dropdown; the left panel's title comes first when it is open. */
export async function showPanelView(page: Page, name: string) {
  const title = page.locator('[data-panel-title]').last();
  if ((await title.textContent())?.trim() === name) return;
  await title.click();
  await page.getByRole('menuitem', { exact: true, name }).click();
}
