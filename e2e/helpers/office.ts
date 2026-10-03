import type { Page } from '@playwright/test';

/** The Office file header's menu bar (a Radix Menubar). */
export function officeMenuBar(page: Page) {
  return page.getByRole('menubar', { name: 'Menu bar' });
}

/** One of the menu bar's menus, by its label. */
export function officeMenu(page: Page, name: string) {
  return officeMenuBar(page).getByRole('menuitem', { exact: true, name });
}

/**
 * The editor's Edit menu: it arrives once the editor's replica is ready, as
 * the old Save button became enabled then. View mode has no Edit menu.
 */
export function officeEditMenu(page: Page) {
  return officeMenu(page, 'Edit');
}

/** File › Save, the header's way to save an Office file. */
export async function saveOffice(page: Page) {
  await officeMenu(page, 'File').click();
  await page.getByRole('menuitem', { name: /^Save/ }).click();
}
