import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
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

  await hold(true);
  expect(await inert(page, '[data-slate-editor]')).toBe(true);
  expect(await inert(page, undo)).toBe(true);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toHaveCount(0);

  await hold(false);
  expect(await inert(page, '[data-slate-editor]')).toBe(false);
  expect(await inert(page, undo)).toBe(false);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toBeVisible();
  // An open palette takes no input once the tab holds back.
  await hold(true);
  expect(await inert(page, palette)).toBe(true);
});
