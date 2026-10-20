import type { Page } from '@playwright/test';
import { m } from '../i18n';

/** Shows a view of the workspace's right panel (Files, Chat, Study) through
 * its title dropdown, opening the panel first when it is closed; the left
 * panel's title comes first when it is open. */
export async function showPanelView(page: Page, name: string) {
  const open = page.getByRole('button', {
    exact: true,
    name: m.workspace_open_right_panel(),
  });
  if (await open.isVisible()) await open.click();
  const title = page.locator('[data-panel-title]').last();
  if ((await title.textContent())?.trim() === name) return;
  await title.click();
  await page.getByRole('menuitem', { exact: true, name }).click();
}
