import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import {
  hoverBlockHandle,
  openBlockContextMenu,
  openEditorNote,
  selectEditorLine,
} from './helpers';

test.describe('block editing', () => {
  test('column drag reorders columns and View hides the column handles', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const group = editor
      .locator('.slate-column_group')
      .filter({ hasText: 'Prokaryote' });
    await group.evaluate((element) =>
      element.scrollIntoView({ block: 'center' })
    );
    const columns = group.locator('[data-slot="column"]');
    const handle = columns
      .first()
      .getByRole('button', { name: m.editor_drag_column() });
    await columns.first().hover();
    const source = (await handle.boundingBox())!;
    const middle = (await columns.nth(1).boundingBox())!;
    const last = (await columns.nth(2).boundingBox())!;
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      middle.x + middle.width - 10,
      middle.y + middle.height / 2,
      { steps: 12 }
    );
    await page.mouse.move(last.x + 10, last.y + last.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => columns.allTextContents())
      .toEqual(['Eukaryote animal', 'Prokaryote', 'Eukaryote plant']);
    await page
      .getByRole('button', { exact: true, name: m.material_mode() })
      .click();
    await expect(
      page.getByRole('button', { name: m.editor_drag_column() })
    ).toHaveCount(0);
  });
  test('callout and code style popovers switch the style and keep editor focus', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const callout = editor
      .locator('.slate-callout')
      .filter({ hasText: 'Info callout' });
    await callout
      .getByRole('button', { name: m.editor_callout_style() })
      .click();
    const variants = page.getByRole('dialog', {
      name: m.editor_callout_style(),
    });
    await expect(
      variants.getByRole('button', {
        exact: true,
        name: m.editor_callout_info(),
      })
    ).toHaveAttribute('aria-pressed', 'true');
    await variants
      .getByRole('button', { exact: true, name: m.editor_callout_success() })
      .click();
    await expect(variants).toBeHidden();
    await expect(
      callout.getByRole('button', { name: m.editor_callout_style() })
    ).toHaveAttribute('data-block-style', 'success');
    await expect(editor).toBeFocused();

    const code = editor.locator('pre');
    await code.getByRole('button', { name: m.editor_code_language() }).click();
    const languages = page.getByRole('dialog', {
      name: m.editor_code_language(),
    });
    const python = languages.getByRole('button', {
      exact: true,
      name: 'Python',
    });
    await expect(python).toHaveAttribute('aria-pressed', 'true');
    await languages
      .getByRole('button', { exact: true, name: 'JavaScript' })
      .click();
    await expect(languages).toBeHidden();
    await expect(
      code.getByRole('button', { name: m.editor_code_language() })
    ).toHaveText('JavaScript');
    await expect(editor).toBeFocused();
  });

  test('an emptied todo keeps its placeholder and takes typing', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const todo = editor.getByText('Todo open — try each toolbar control', {
      exact: true,
    });
    await selectEditorLine(page, todo);
    await page.keyboard.press('Backspace');
    await expect(editor.locator('.slate-p[placeholder]')).toHaveCount(1);
    await page.keyboard.type('New task');
    await expect(editor.getByText('New task', { exact: true })).toBeVisible();
  });

  test('horizontal rule padding selects the rule for keyboard deletion', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const rule = editor.getByRole('separator');
    const ruleBlock = editor.locator('.slate-hr');
    await ruleBlock.click({ position: { x: 60, y: 5 } });
    await expect(rule).toHaveClass(/ring-line-strong/);
    await page.keyboard.press('Backspace');
    await expect(rule).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rule).toHaveCount(1);
    await rule.click();
    await expect(rule).toHaveClass(/ring-line-strong/);
    await page.keyboard.press('Delete');
    await expect(rule).toHaveCount(0);
    await expect(
      editor.getByRole('heading', { exact: true, name: 'Quote & divider' })
    ).toBeVisible();
  });

  test('checking a todo marks it complete', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    await editor
      .getByRole('checkbox', { name: m.editor_task_complete() })
      .check();
    await expect(
      editor.getByRole('checkbox', { name: m.editor_task_incomplete() })
    ).toHaveCount(2);
  });

  test('context menu Duplicate copies the block', async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.secondParagraph
    );

    const menu = await openBlockContextMenu(page, EDITOR_NOTE.secondParagraph);
    await menu.getByRole('menuitem', { name: m.editor_duplicate() }).click();

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
    await menu.getByRole('menuitem', { name: m.action_delete() }).click();

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
    await menu.getByRole('menuitem', { name: m.editor_turn_into() }).hover();
    await page.getByRole('menuitem', { name: m.editor_heading_2() }).click();

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

  test('chunked notes keep gutter handles visible and draggable', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const first = 'Left-aligned paragraph (default).';
    const last = 'Right-aligned paragraph.';
    const handle = await hoverBlockHandle(page, first);
    await expect(editor.locator('[data-slate-chunk]').first()).toHaveCSS(
      'content-visibility',
      'auto'
    );
    // Visibility alone ignores paint containment. Check the actual hit target.
    expect(
      await handle.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          )
        );
      })
    ).toBe(true);

    await handle.dragTo(editor.getByText(last, { exact: true }), {
      targetPosition: { x: 40, y: 20 },
    });
    await expect
      .poll(async () => {
        const text = await editor.innerText();
        return text.indexOf(first) > text.indexOf(last);
      })
      .toBe(true);
  });
});
