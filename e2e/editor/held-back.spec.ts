import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { officeEditMenu } from '../helpers/office';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

/** The tab holds back its collaboration messages (or stops). */
function hold(page: Page, held: boolean) {
  return page.evaluate(async (held) => {
    const path = '/src/features/collaboration/held.ts';
    const { setHeld } = await import(path);
    const tab = window as unknown as { heldBy?: object };
    tab.heldBy ??= {};
    setHeld(tab.heldBy, held);
  }, held);
}

const inert = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => node.closest('[inert]') !== null);

// Security regression (rate-limit review r3 S1/S7): while the tab holds back
// its collaboration messages (Epo 2026-10-18) nothing in a note's editor takes
// an edit: its content, its toolbar, the Ctrl+K command palette and an open
// palette.
test('a note takes no edits while the tab holds back its messages', async ({
  page,
}) => {
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  const palette = `[aria-label="${m.editor_command_palette()}"]`;
  const undo = `button[aria-label="${m.editor_undo()}"]`;

  await hold(page, true);
  expect(await inert(page, '[data-slate-editor]')).toBe(true);
  expect(await inert(page, undo)).toBe(true);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toHaveCount(0);

  await hold(page, false);
  expect(await inert(page, '[data-slate-editor]')).toBe(false);
  expect(await inert(page, undo)).toBe(false);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toBeVisible();
  // An open palette takes no input once the tab holds back.
  await hold(page, true);
  expect(await inert(page, palette)).toBe(true);
});

// Security regression (rate-limit review r3 S7, r4 L1): while the tab holds
// back its collaboration messages the XLSX editor stays open but busy (the
// host's `sending` message, the runtime's `sending` prop): its grid is
// aria-busy and a Delete changes nothing; once the tab sends again, a Delete
// clears the cell.
test('an XLSX grid is busy and takes no Delete while the tab holds back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 30_000 });
  const grid = frame.getByTestId('xlsx-scroll');
  const nameBox = frame.getByTestId('xlsx-name-box');
  const formula = frame.getByTestId('xlsx-formula-input');
  await nameBox.fill('H5');
  await nameBox.press('Enter');
  await expect(formula).toHaveValue('2');

  await hold(page, true);
  await expect(grid).toHaveAttribute('aria-busy', 'true');
  await grid.focus();
  await page.keyboard.press('Delete');
  await expect(formula).toHaveValue('2');

  await hold(page, false);
  await expect(grid).not.toHaveAttribute('aria-busy', 'true');
  await grid.focus();
  await page.keyboard.press('Delete');
  await expect(formula).toHaveValue('');
});
