import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { chooseAllBlocksEntry } from '../helpers/editor';
import { openEditorNote } from './helpers';

test.describe('inline and block insertions', () => {
  test('mention dropdown opens inside a heading and inserts a member', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.headingText
    );

    // Regression: the dropdown rendered inline (not portaled) and never
    // became visible inside headings.
    await editor.getByText(EDITOR_NOTE.headingText, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' @');

    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    const member = listbox.getByRole('option', { name: /Kate Malone/ });
    await expect(member).toBeVisible();
    await member.click();

    await expect(editor.locator('h1').getByText(/Kate Malone/)).toBeVisible();
  });

  test('mention dropdown works in a plain paragraph', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' @');

    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: /Kate Malone/ }).click();
    await expect(editor.getByText(/Kate Malone/)).toBeVisible();
  });

  test('slash command inserts a table', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );

    // Clicking the text node often lands mid-word; End+Enter then race and
    // `/table` gets inserted as plain text ("paragr/tableaph") with no menu.
    const paragraph = editor.getByText(EDITOR_NOTE.thirdParagraph, {
      exact: true,
    });
    const box = await paragraph.boundingBox();
    expect(box, 'paragraph has a bounding box').not.toBeNull();
    await page.mouse.click(box!.x + box!.width - 1, box!.y + box!.height / 2);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await page.keyboard.type('table');

    const option = listbox
      .getByRole('option')
      .filter({ hasText: 'Insert a 2 × 2 table' });
    await expect(option).toBeVisible();
    await option.click();

    const table = editor.locator('table');
    await expect(table).toBeVisible();
  });

  test('toolbar table menu inserts a table', async ({ page }) => {
    // Keep the table controls in view without scrolling for this insertion test.
    await page.setViewportSize({ height: 1000, width: 2560 });
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );

    await editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }).click();
    await page.keyboard.press('End');

    const trigger = page.getByRole('button', { name: 'Table controls' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const table = page.getByRole('button', { exact: true, name: 'Table' });
    await expect(table).toBeFocused();
    await page.keyboard.press('Enter');
    const grid = page.getByRole('grid');
    await expect(grid).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('data-state', 'closed');
    await expect(editor).toBeFocused();
    await expect(editor.locator('table tr')).toHaveCount(3);
    await expect(editor.locator('table')).toBeVisible();
  });

  test('table of contents lists headings and follows a retitle', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    await page.keyboard.press('End');
    await chooseAllBlocksEntry(page, 'Table of contents');

    const contents = editor.getByRole('navigation');
    await expect(
      contents.getByRole('button', { name: EDITOR_NOTE.headingText })
    ).toBeVisible();

    // The heading list is cached per top-level block and reused whenever that
    // block's identity is unchanged, so the case that has to keep working is
    // the one where a cached block really did change.
    await editor.locator('h1').click();
    // Wait for Slate to take the click's selection; its late DOM sync would
    // otherwise move the caret back from where End put it.
    await expect(page.getByRole('button', { name: 'Block type' })).toHaveText(
      'Heading 1'
    );
    await page.keyboard.press('End');
    await page.keyboard.type(' updated');

    await expect(
      contents.getByRole('button', {
        name: `${EDITOR_NOTE.headingText} updated`,
      })
    ).toBeVisible();
  });
});
