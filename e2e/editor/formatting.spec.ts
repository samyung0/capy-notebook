import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { chooseAllBlocksEntry } from '../helpers/editor';
import { openEditorNote } from './helpers';

test.describe('formatting', () => {
  test('bold applies and clear formatting strips it from the selection', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    // Double-click selects the word under the cursor.
    await editor
      .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
      .dblclick();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(editor.locator('strong')).toHaveCount(1);

    // Regression: removeMarks() without keys cleared nothing for an expanded
    // selection, so this button used to be a no-op.
    await chooseAllBlocksEntry(page, 'Clear formatting');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(
      editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
    ).toBeVisible();
  });

  test('clear formatting strips multiple stacked marks', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.secondParagraph
    );

    await editor
      .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      .dblclick();
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.press('ControlOrMeta+i');
    await page.keyboard.press('ControlOrMeta+u');
    await expect(editor.locator('strong')).toHaveCount(1);
    await expect(editor.locator('em')).toHaveCount(1);
    await expect(editor.locator('u')).toHaveCount(1);

    await chooseAllBlocksEntry(page, 'Clear formatting');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(editor.locator('em')).toHaveCount(0);
    await expect(editor.locator('u')).toHaveCount(0);
  });
});
