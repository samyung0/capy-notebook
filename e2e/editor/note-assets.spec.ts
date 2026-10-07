import { expect, test } from '@playwright/test';
import { openEditorNote } from './helpers';

// The server keeps a removed image in its trash for a day, so undo brings the
// same asset back; the browser keeps no bytes of its own.
test('a deleted image comes back on undo', async ({ page }) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const image = editor.getByRole('img', { name: 'animal-cell.svg' });
  await expect(image).toHaveCount(1);

  await image.click({ button: 'right' });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(image).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(image).toHaveCount(1);
  await expect(image).toBeVisible();
});
