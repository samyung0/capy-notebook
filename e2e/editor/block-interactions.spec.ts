import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import {
  hoverBlockHandle,
  openBlockContextMenu,
  openEditorNote,
} from './helpers';

test.describe('block editing', () => {
  test('context menu Duplicate copies the block', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.secondParagraph
    );

    const menu = await openBlockContextMenu(page, EDITOR_NOTE.secondParagraph);
    await menu.getByRole('menuitem', { name: 'Duplicate' }).click();

    await expect(
      editor.getByText(EDITOR_NOTE.secondParagraph, { exact: true })
    ).toHaveCount(2);
  });

  test('context menu Delete removes the block', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );

    const menu = await openBlockContextMenu(page, EDITOR_NOTE.thirdParagraph);
    await menu.getByRole('menuitem', { name: 'Delete' }).click();

    await expect(
      editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true })
    ).toHaveCount(0);
    // The rest of the document is untouched.
    await expect(
      editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
    ).toBeVisible();
  });

  test('context menu Turn into converts the block type', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    const menu = await openBlockContextMenu(page, EDITOR_NOTE.firstParagraph);
    await menu.getByRole('menuitem', { name: 'Turn into' }).hover();
    await page.getByRole('menuitem', { name: 'Heading 2' }).click();

    await expect(
      editor
        .locator('h2')
        .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
    ).toBeVisible();
  });

  test('dragging a handle reorders blocks', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    const handle = await hoverBlockHandle(page, EDITOR_NOTE.firstParagraph);
    await handle.dragTo(
      editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }),
      {
        targetPosition: { x: 40, y: 20 },
      }
    );

    await expect(editor).toContainText(EDITOR_NOTE.firstParagraph);
    await expect(editor).toContainText(EDITOR_NOTE.thirdParagraph);
    await expect
      .poll(async () => {
        const text = await editor.innerText();
        return (
          text.indexOf(EDITOR_NOTE.firstParagraph) >
          text.indexOf(EDITOR_NOTE.thirdParagraph)
        );
      })
      .toBe(true);
  });
});
