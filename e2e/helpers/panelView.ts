import type { Page } from '@playwright/test';
import { m } from '../i18n';

/** Shows Files or Chat in an lg viewport. Files is the one tree shown: the
 * rail's Files section beside the rail (already shown while a file is open;
 * pressing the shown section would close it), or the right panel's Files
 * view while no section shows Files. Chat is the right panel's view, picked
 * through its title dropdown after opening the panel. */
export async function showPanelView(page: Page, name: string) {
  if (name === m.workspace_tab_files()) {
    const files = page
      .getByRole('navigation', { name: m.workspace_rail_label() })
      .getByRole('button', { exact: true, name });
    await files.waitFor();
    const tree = page.locator('[data-workspace-file-tree]');
    if (!(await tree.first().isVisible())) await files.click();
    await tree.first().waitFor();
    return;
  }
  const open = page.getByRole('button', {
    exact: true,
    name: m.workspace_open_right_panel(),
  });
  const close = page.getByRole('button', {
    exact: true,
    name: m.workspace_close_right_panel(),
  });
  // The toggle renders after the workspace loads; deciding before then skips
  // opening a closed panel.
  await open.or(close).waitFor();
  if (await open.isVisible()) await open.click();
  const title = page.locator('[data-panel-title]').last();
  if ((await title.textContent())?.trim() === name) return;
  await title.click();
  await page.getByRole('menuitem', { exact: true, name }).click();
}
