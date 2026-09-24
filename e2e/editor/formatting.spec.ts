import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { chooseAllBlocksEntry } from '../helpers/editor';
import { openEditorNote } from './helpers';

test.describe('formatting', () => {
  test('toolbar scrolls on narrow screens and honors group settings', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    await page.setViewportSize({ height: 900, width: 900 });
    const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
    const scroller = toolbar.locator('.scroll-fade-x');
    const groups = scroller.locator('[data-toolbar-group]');
    await expect(groups).toHaveCount(8);
    await expect(scroller.locator('[data-toolbar-group][hidden]')).toHaveCount(
      0
    );
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true);
    await expect(scroller).toHaveCSS('overflow-x', 'auto');
    const settings = toolbar.getByRole('button', {
      name: 'Editor command settings',
    });
    await expect(settings).toBeInViewport();

    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const table = toolbar.getByRole('button', {
      exact: true,
      name: 'Table controls',
    });
    await expect(table).toBeInViewport();
    await table.click();
    await page.getByRole('button', { exact: true, name: 'Table' }).click();
    await expect(
      page.getByRole('gridcell', { name: 'Insert 2 by 2 table' })
    ).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await settings.click();
    const dialog = page.getByRole('dialog', { name: 'Editor commands' });
    await dialog.getByRole('switch', { name: /Text decorations/ }).click();
    await dialog.getByRole('button', { exact: true, name: 'Apply' }).click();
    await expect(groups).toHaveCount(7);
    await expect(
      toolbar.getByRole('button', { exact: true, name: 'Bold' })
    ).toHaveCount(0);
    await page.setViewportSize({ height: 1000, width: 2560 });
    await expect(groups).toHaveCount(7);
    await expect(
      toolbar.getByRole('button', { exact: true, name: 'Bold' })
    ).toHaveCount(0);
  });

  test('bold applies and clear formatting strips it from the selection', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 1000, width: 2560 });
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );

    // Double-click selects the word under the cursor.
    await editor
      .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
      .dblclick();
    const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
    const floating = page.getByRole('toolbar', { name: 'Selection actions' });
    const bold = toolbar.getByRole('button', { exact: true, name: 'Bold' });
    const floatingBold = floating.getByRole('button', {
      exact: true,
      name: 'Bold',
    });
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(editor.locator('strong')).toHaveCount(1);
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(floatingBold).toHaveAttribute('aria-pressed', 'true');
    await expect(bold).toHaveCSS('width', '32px');
    await expect(bold.locator('svg')).toHaveCSS('width', '16px');
    await expect(bold.locator('svg')).toHaveAttribute('stroke-width', '1.8');
    await page.mouse.move(0, 0);
    const activeColor = await bold.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    expect(activeColor).not.toBe('rgba(0, 0, 0, 0)');
    await expect(floatingBold).toHaveCSS('background-color', activeColor);

    // Both toolbars preserve and act on the same text selection.
    await floatingBold.click();
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await expect(editor.locator('strong')).toHaveCount(0);
    await bold.click();
    await expect(floatingBold).toHaveAttribute('aria-pressed', 'true');

    // Regression: removeMarks() without keys cleared nothing for an expanded
    // selection, so this button used to be a no-op.
    await chooseAllBlocksEntry(page, 'Clear formatting');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await expect(
      editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
    ).toBeVisible();
  });

  test('clear formatting strips multiple stacked marks', async ({ page }) => {
    await page.setViewportSize({ height: 1000, width: 2560 });
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
    const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
    for (const name of ['Bold', 'Italic', 'Underline']) {
      await expect(
        toolbar.getByRole('button', { exact: true, name })
      ).toHaveAttribute('aria-pressed', 'true');
    }

    await page.keyboard.press('ArrowRight');
    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    for (const name of ['Bold', 'Italic', 'Underline']) {
      await expect(
        toolbar.getByRole('button', { exact: true, name })
      ).toHaveAttribute('aria-pressed', 'false');
    }
    await editor.locator('strong').dblclick();

    await chooseAllBlocksEntry(page, 'Clear formatting');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(editor.locator('em')).toHaveCount(0);
    await expect(editor.locator('u')).toHaveCount(0);
  });

  test('link state and floating actions share toolbar buttons', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 1000, width: 2560 });
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
    const linkButton = toolbar.getByRole('button', {
      exact: true,
      name: 'Link',
    });
    await editor
      .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
      .dblclick();
    await linkButton.click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: 'Link URL' })
      .fill('https://example.com/');
    await dialog.getByRole('button', { exact: true, name: 'Apply' }).click();
    const link = editor.getByRole('link', { name: /./ });
    await link.click();
    await expect(linkButton).toHaveAttribute('aria-pressed', 'true');
    const actions = page.getByRole('toolbar', { name: 'Link actions' });
    await expect(
      actions.getByRole('link', { name: 'Open link in a new tab' })
    ).toHaveAttribute('href', 'https://example.com/');
    await actions.getByRole('button', { name: 'Edit link' }).click();
    await page
      .getByRole('textbox', { name: 'Link URL' })
      .fill('https://example.org/');
    await page.getByRole('button', { name: 'Save link' }).click();
    await expect(link).toHaveAttribute('href', 'https://example.org/');
    await actions.getByRole('button', { name: 'Remove link' }).click();
    await expect(linkButton).toHaveAttribute('aria-pressed', 'false');
    await expect(editor.getByRole('link')).toHaveCount(0);
  });

  test('toolbar follows lists, alignment, tables and column layouts', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 1000, width: 2560 });
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
    const first = editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true });
    await first.click();
    for (const name of ['Numbered list', 'Bulleted list', 'Task list']) {
      const button = toolbar.getByRole('button', { exact: true, name });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await editor
        .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
        .click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await first.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    await toolbar
      .getByRole('button', { exact: true, name: 'Text alignment' })
      .click();
    const center = page.getByRole('button', { exact: true, name: 'Center' });
    await center.click();
    await expect(center).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { exact: true, name: 'Left' })
    ).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');

    const twoColumns = toolbar.getByRole('button', {
      exact: true,
      name: 'Two columns',
    });
    const threeColumns = toolbar.getByRole('button', {
      exact: true,
      name: 'Three equal columns',
    });
    await twoColumns.click();
    await editor.locator('[data-slot="column"]').first().click();
    await expect(twoColumns).toHaveAttribute('aria-pressed', 'true');
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'false');
    const columnMenu = page.locator('[data-slot="popover-content"]').filter({
      has: page.getByRole('button', {
        exact: true,
        name: 'Two equal columns',
      }),
    });
    await expect(
      columnMenu.getByRole('button', { exact: true, name: 'Two equal columns' })
    ).toHaveAttribute('aria-pressed', 'true');
    await columnMenu
      .getByRole('button', { exact: true, name: 'Three equal columns' })
      .click();
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'true');
    await expect(twoColumns).toHaveAttribute('aria-pressed', 'false');

    await editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }).click();
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'false');
    const table = toolbar.getByRole('button', {
      exact: true,
      name: 'Table controls',
    });
    await table.click();
    await expect(table).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { exact: true, name: 'Table' }).click();
    await page.getByRole('gridcell', { name: 'Insert 2 by 2 table' }).click();
    await editor.locator('td').first().click();
    await expect(table).toHaveAttribute('aria-pressed', 'true');
    await editor
      .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      .click();
    await expect(table).toHaveAttribute('aria-pressed', 'false');
  });
});
