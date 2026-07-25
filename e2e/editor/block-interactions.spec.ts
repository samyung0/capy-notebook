import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import {
  blockSelectionOverlays,
  hoverBlockHandle,
  openBlockContextMenu,
  openEditorNote,
} from './helpers';

test.describe('block selection and context menu', () => {
  test('clicking a drag handle selects the block with a visible overlay', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);

    const handle = await hoverBlockHandle(page, EDITOR_NOTE.firstParagraph);
    await handle.click();

    await expect(blockSelectionOverlays(page)).toHaveCount(1);
    await expect(blockSelectionOverlays(page).first()).toBeVisible();
  });

  test('right-clicking a block selects it and opens the context menu', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.secondParagraph);

    const menu = await openBlockContextMenu(page, EDITOR_NOTE.secondParagraph);

    await expect(
      menu.getByRole('menuitem', { name: 'Duplicate' })
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    await expect(blockSelectionOverlays(page)).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

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

  test('select-all escalates from text selection to block selection', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+a');

    // Seed has 4 blocks: heading + three paragraphs.
    await expect(blockSelectionOverlays(page)).toHaveCount(4);
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

    const first = editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true });
    const third = editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true });
    await expect(first).toBeVisible();
    const firstBox = await first.boundingBox();
    const thirdBox = await third.boundingBox();
    expect(firstBox && thirdBox && firstBox.y > thirdBox.y).toBe(true);
  });
});
