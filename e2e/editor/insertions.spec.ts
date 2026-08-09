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

    await editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table');

    const option = page
      .getByRole('option')
      .filter({ hasText: 'Insert a 2 × 2 table' });
    await expect(option).toBeVisible();
    await option.click();

    const table = editor.locator('table');
    await expect(table).toBeVisible();
    // Content cells only: the first td of each row is the 8px drag-grip cell.
    const contentCell = table.locator('td[data-table-cell-id]').first();
    const box = await contentCell.boundingBox();
    expect(box, 'table cell has a bounding box').not.toBeNull();
    // Regression: cells collapsed to (near) zero width.
    expect(box!.width).toBeGreaterThan(100);
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
