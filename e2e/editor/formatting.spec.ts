import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { chooseAllBlocksEntry } from '../helpers/editor';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test.describe('formatting', () => {
  test('undo and redo work after the editor loses selection', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' history probe');
    const outside = page.getByRole('textbox', {
      name: m.chat_placeholder(),
    });
    await outside.click();
    await expect(editor).not.toBeFocused();
    await expect(
      page.getByRole('button', { exact: true, name: m.editor_undo() })
    ).toBeEnabled();
    await page
      .getByRole('button', { exact: true, name: m.editor_undo() })
      .click();
    await expect(editor).not.toContainText('history probe');
    await outside.click();
    await expect(
      page.getByRole('button', { exact: true, name: m.editor_redo() })
    ).toBeEnabled();
    await page
      .getByRole('button', { exact: true, name: m.editor_redo() })
      .click();
    await expect(editor).toContainText('history probe');
  });
  test('block type popover applies a keyboard choice and returns focus to the editor', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    const trigger = page.getByRole('button', {
      exact: true,
      name: m.editor_block_type(),
    });
    await trigger.click();
    const popup = page.locator(
      '[data-slot="popover-content"][data-state="open"]'
    );
    await expect(
      popup.getByRole('button', {
        exact: true,
        name: m.editor_block_paragraph(),
      })
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(
      popup.getByRole('button', { exact: true, name: m.editor_heading_2() })
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      editor.getByRole('heading', {
        level: 2,
        name: EDITOR_NOTE.firstParagraph,
      })
    ).toBeVisible();
    await expect(editor).toBeFocused();
    await trigger.click();
    await expect(
      popup.getByRole('button', { exact: true, name: m.editor_heading_2() })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
  });

  test('toolbar scrolls on narrow screens and honors group settings', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    await page.setViewportSize({ height: 900, width: 900 });
    const toolbar = page.getByRole('toolbar', {
      name: m.editor_doc_formatting(),
    });
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
    const settings = toolbar.getByRole('button', {
      name: m.editor_prefs_settings(),
    });
    await expect(settings).toBeInViewport();

    await scroller.hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await page.mouse.wheel(0, -1000);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBe(0);
    await page.mouse.wheel(0, 10_000);
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            element.scrollWidth - element.clientWidth - element.scrollLeft
        )
      )
      .toBeLessThanOrEqual(1);
    const table = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_table_controls(),
    });
    await expect(table).toBeInViewport();
    await table.click();
    await page
      .getByRole('button', { exact: true, name: m.editor_table() })
      .click();
    await expect(
      page.getByRole('gridcell', {
        name: m.editor_insert_table_size({ cols: '2', rows: '2' }),
      })
    ).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.mouse.move(0, 0);
    await table.hover();
    await expect(
      page
        .locator('[data-slot="tooltip-content"]')
        .filter({ hasText: m.editor_table_controls() })
    ).toBeVisible();
    const overflowDuringScroll = page.evaluate(async () => {
      let maxOverflow = 0;
      for (let frame = 0; frame < 30; frame++) {
        await new Promise(requestAnimationFrame);
        maxOverflow = Math.max(
          maxOverflow,
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
      }
      return maxOverflow;
    });
    await page.mouse.wheel(0, -10_000);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBe(0);
    expect(await overflowDuringScroll).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      )
      .toBe(0);

    await settings.click();
    const dialog = page.getByRole('dialog', { name: m.editor_prefs_title() });
    await dialog
      .getByRole('tab', { exact: true, name: m.editor_prefs_commands() })
      .click();
    await dialog
      .getByRole('switch', { name: m.editor_prefs_decorations() })
      .click();
    await dialog
      .getByRole('button', { exact: true, name: m.action_apply() })
      .click();
    await expect(groups).toHaveCount(7);
    await expect(
      toolbar.getByRole('button', { exact: true, name: m.editor_bold() })
    ).toHaveCount(0);
    await page.setViewportSize({ height: 1000, width: 2560 });
    await expect(groups).toHaveCount(7);
    await expect(
      toolbar.getByRole('button', { exact: true, name: m.editor_bold() })
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
    const toolbar = page.getByRole('toolbar', {
      name: m.editor_doc_formatting(),
    });
    const floating = page.getByRole('toolbar', {
      name: m.editor_selection_actions(),
    });
    const bold = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_bold(),
    });
    const floatingBold = floating.getByRole('button', {
      exact: true,
      name: m.editor_bold(),
    });
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(editor.locator('strong')).toHaveCount(1);
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(floatingBold).toHaveAttribute('aria-pressed', 'true');

    // Both toolbars preserve and act on the same text selection.
    await floatingBold.click();
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await expect(editor.locator('strong')).toHaveCount(0);
    await bold.click();
    await expect(floatingBold).toHaveAttribute('aria-pressed', 'true');

    // Regression: removeMarks() without keys cleared nothing for an expanded
    // selection, so this button used to be a no-op.
    await chooseAllBlocksEntry(page, m.editor_clear_formatting());
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
    const toolbar = page.getByRole('toolbar', {
      name: m.editor_doc_formatting(),
    });
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

    await chooseAllBlocksEntry(page, m.editor_clear_formatting());
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
    const toolbar = page.getByRole('toolbar', {
      name: m.editor_doc_formatting(),
    });
    const linkButton = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_link(),
    });
    await editor
      .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
      .dblclick();
    await linkButton.click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: m.editor_link_url() })
      .fill('https://example.com/');
    await dialog
      .getByRole('button', { exact: true, name: m.action_apply() })
      .click();
    const link = editor.getByRole('link', { name: /./ });
    await link.click();
    await expect(linkButton).toHaveAttribute('aria-pressed', 'true');
    const actions = page.getByRole('toolbar', {
      name: m.editor_link_actions(),
    });
    await expect(
      actions.getByRole('link', { name: m.editor_link_open() })
    ).toHaveAttribute('href', 'https://example.com/');
    await actions.getByRole('button', { name: m.editor_link_edit() }).click();
    await page
      .getByRole('textbox', { name: m.editor_link_url() })
      .fill('https://example.org/');
    await page.getByRole('button', { name: m.editor_link_save() }).click();
    await expect(link).toHaveAttribute('href', 'https://example.org/');
    await actions.getByRole('button', { name: m.editor_link_remove() }).click();
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
    const toolbar = page.getByRole('toolbar', {
      name: m.editor_doc_formatting(),
    });
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
      .getByRole('button', { exact: true, name: m.editor_text_alignment() })
      .click();
    const center = page.getByRole('button', {
      exact: true,
      name: m.editor_align_center(),
    });
    await center.click();
    await expect(center).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { exact: true, name: m.editor_align_left() })
    ).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');

    const twoColumns = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_two_columns(),
    });
    const threeColumns = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_columns_equal_3(),
    });
    await twoColumns.click();
    await editor.locator('[data-slot="column"]').first().click();
    await expect(twoColumns).toHaveAttribute('aria-pressed', 'true');
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'false');
    const columnMenu = page.locator('[data-slot="popover-content"]').filter({
      has: page.getByRole('button', {
        exact: true,
        name: m.editor_columns_equal_2(),
      }),
    });
    await expect(
      columnMenu.getByRole('button', {
        exact: true,
        name: m.editor_columns_equal_2(),
      })
    ).toHaveAttribute('aria-pressed', 'true');
    await columnMenu
      .getByRole('button', { exact: true, name: m.editor_columns_equal_3() })
      .click();
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'true');
    await expect(twoColumns).toHaveAttribute('aria-pressed', 'false');

    const columnGroup = editor.locator('.slate-column_group').first();
    for (let cycle = 0; cycle < 3; cycle++) {
      await columnMenu
        .getByRole('button', { exact: true, name: m.editor_columns_equal_2() })
        .click();
      await expect(columnGroup.locator('.slate-p')).toHaveCount(2);
      await columnMenu
        .getByRole('button', { exact: true, name: m.editor_columns_equal_3() })
        .click();
      await expect(columnGroup.locator('.slate-p')).toHaveCount(3);
    }

    await editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true }).click();
    await expect(threeColumns).toHaveAttribute('aria-pressed', 'false');
    const table = toolbar.getByRole('button', {
      exact: true,
      name: m.editor_table_controls(),
    });
    await table.click();
    await expect(table).toHaveAttribute('aria-pressed', 'false');
    await page
      .getByRole('button', { exact: true, name: m.editor_table() })
      .click();
    await page
      .getByRole('gridcell', {
        name: m.editor_insert_table_size({ cols: '2', rows: '2' }),
      })
      .click();
    await editor.locator('td').first().click();
    await expect(table).toHaveAttribute('aria-pressed', 'true');
    await editor
      .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      .click();
    await expect(table).toHaveAttribute('aria-pressed', 'false');
  });
});
