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

  test('slash command inserts a table whose cells keep their width', async ({
    page,
  }) => {
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
    // Content cells only: the first td of each row is the 8px drag-grip cell.
    const contentCell = table.locator('td[data-table-cell-id]').first();
    const cellBox = await contentCell.boundingBox();
    expect(cellBox, 'table cell has a bounding box').not.toBeNull();
    // Regression: cells collapsed to (near) zero width.
    expect(cellBox!.width).toBeGreaterThan(100);
  });

  test('toolbar table menu inserts a table', async ({ page }) => {
    // The toolbar drops whole groups from the right until it fits, and the
    // default viewport leaves the editor pane too narrow to keep this one.
    await page.setViewportSize({ height: 1000, width: 2560 });
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );

    await editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }).click();
    await page.keyboard.press('End');

    // The menu body lives under the dropdown content so that Radix leaves it
    // unmounted while closed — its selection subscriptions re-rendered the
    // toolbar on every keystroke otherwise. This walks the whole path to prove
    // the split did not break the menu.
    await page.getByRole('button', { name: 'Table controls' }).click();
    await page.getByRole('menuitem', { exact: true, name: 'Table' }).hover();
    await page.getByRole('gridcell', { name: 'Insert 3 by 3 table' }).click();

    await expect(editor.locator('table')).toBeVisible();
    await expect(editor.locator('td[data-table-cell-id]')).toHaveCount(9);
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
    await page.keyboard.press('End');
    await page.keyboard.type(' updated');

    await expect(
      contents.getByRole('button', {
        name: `${EDITOR_NOTE.headingText} updated`,
      })
    ).toBeVisible();
  });

  test('column layout keeps per-column width', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.secondParagraph
    );

    await editor
      .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      .click();
    await page.keyboard.press('End');
    await chooseAllBlocksEntry(page, 'Three equal columns');

    const columns = editor.locator('[data-slot="column"]');
    await expect(columns).toHaveCount(3);
    for (const column of await columns.all()) {
      const box = await column.boundingBox();
      expect(box, 'column has a bounding box').not.toBeNull();
      // Regression: columns collapsed to zero width.
      expect(box!.width).toBeGreaterThan(80);
    }
  });
});
