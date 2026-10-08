import type { Page } from '@playwright/test';
import { m } from '../i18n';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/** The PPTX menus are Capy's; DOCX and XLSX menus carry BetterOffice's labels, which are these names. */
const PPTX_MENUS = {
  Edit: m.files_office_pptx_menu_edit,
  File: m.files_office_pptx_menu_file,
  Format: m.files_office_pptx_menu_format,
  Insert: m.files_office_pptx_menu_insert,
  View: m.files_office_pptx_menu_view,
};

/** The Office file header's menu bar (a Radix Menubar). */
export function officeMenuBar(page: Page) {
  return page.getByRole('menubar', { name: m.files_office_menu_bar() });
}

/** One of the menu bar's menus in a file of `format`. */
export function officeMenu(
  page: Page,
  format: OfficeFormat,
  name: keyof typeof PPTX_MENUS
) {
  return officeMenuBar(page).getByRole('menuitem', {
    exact: true,
    name: format === 'pptx' ? PPTX_MENUS[name]() : name,
  });
}

/**
 * The editor's Edit menu: it arrives once the editor's replica is ready, as
 * the old Save button became enabled then. View mode has no Edit menu.
 */
export function officeEditMenu(page: Page, format: OfficeFormat) {
  return officeMenu(page, format, 'Edit');
}

/** File › Save, the header's way to save an Office file. */
export async function saveOffice(page: Page, format: OfficeFormat) {
  await officeMenu(page, format, 'File').click();
  await page.getByRole('menuitem', { name: /^Save/ }).click();
}
