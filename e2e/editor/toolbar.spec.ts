import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { formattingToolbar, openAllBlocks } from '../helpers/editor';
import { openEditorNote } from './helpers';

/** The last two widths are below anything the app is designed for and exist
 * only to prove the all-blocks group is the last thing standing. */
const WIDTHS = [1280, 1024, 800, 520, 420] as const;

test.describe('responsive toolbar', () => {
  test('the all-blocks menu survives every width', async ({ page }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const allBlocks = formattingToolbar(page).getByRole('button', {
      name: 'All blocks',
    });

    for (const width of WIDTHS) {
      await page.setViewportSize({ height: 720, width });
      await expect(allBlocks).toBeVisible();

      // Visibility is not enough. The responsive container clips its overflow,
      // and a button past its right edge still reports a bounding box while
      // being impossible to click, so ask the document what is actually painted
      // where the button claims to be.
      const reachable = await allBlocks.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2
        );
        return button.contains(hit);
      });
      expect(reachable, `all-blocks button unreachable at ${width}px`).toBe(
        true
      );
    }

    const menu = await openAllBlocks(page);
    await expect(
      menu.getByRole('heading', { exact: true, name: 'General' })
    ).toBeVisible();
  });
});
