import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import {
  hoverBlockHandle,
  openBlockContextMenu,
  openEditorNote,
  selectEditorLine,
} from './helpers';

test.describe('block editing', () => {
  test('column drag indicators meet at one gap and viewing hides borders', async ({
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
      .getByRole('button', { name: 'Drag to reorder column' });
    await columns.first().hover();
    await expect(columns.first()).toHaveCSS('border-left-style', 'dashed');
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
    const line = editor.locator('[data-column-drop-line]');
    await expect(line).toHaveCount(1);
    const afterMiddle = (await line.boundingBox())!;
    await page.mouse.move(last.x + 10, last.y + last.height / 2, { steps: 6 });
    await expect(
      columns.nth(2).locator('[data-column-drop-line]')
    ).toBeVisible();
    const beforeLast = (await line.boundingBox())!;
    expect(beforeLast.x).toBeCloseTo(afterMiddle.x, 0);
    expect(beforeLast.x + beforeLast.width / 2).toBeCloseTo(
      (middle.x + middle.width + last.x) / 2,
      0
    );
    await page.mouse.up();
    await expect
      .poll(() => columns.allTextContents())
      .toEqual(['Eukaryote animal', 'Prokaryote', 'Eukaryote plant']);
    await page
      .getByRole('button', { exact: true, name: 'Material mode' })
      .click();
    const staticColumns = page.locator('.slate-column');
    await expect(staticColumns.first()).toHaveCSS(
      'border-left-color',
      'rgba(0, 0, 0, 0)'
    );
    await expect(
      page.getByRole('button', { name: 'Drag to reorder column' })
    ).toHaveCount(0);
  });
  test('callout and code styles use compact popovers and preserve editing', async ({
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
    const alignment = await callout.evaluate((element) => {
      const icon = element
        .querySelector('[data-callout-icon]')!
        .getBoundingClientRect();
      const paragraph = element.querySelector('.slate-p')!;
      const text = document.createRange();
      text.selectNodeContents(paragraph.querySelector('[data-slate-string]')!);
      const firstLine = text.getClientRects()[0];
      return Math.abs(
        icon.top + icon.height / 2 - firstLine.top - firstLine.height / 2
      );
    });
    expect(alignment).toBeLessThan(1);
    await callout.getByRole('button', { name: 'Callout style' }).click();
    const variants = page.getByRole('dialog', { name: 'Callout style' });
    await expect(
      variants.getByRole('button', { exact: true, name: 'Info' })
    ).toHaveAttribute('aria-pressed', 'true');
    await variants
      .getByRole('button', { exact: true, name: 'Success' })
      .click();
    await expect(variants).toBeHidden();
    await expect(
      callout.getByRole('button', { name: 'Callout style' })
    ).toHaveText('Success');
    await expect(editor).toBeFocused();

    const code = editor.locator('pre');
    await code.getByRole('button', { name: 'Code language' }).click();
    const languages = page.getByRole('dialog', { name: 'Code language' });
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
      code.getByRole('button', { name: 'Code language' })
    ).toHaveText('JavaScript');
    await expect(editor).toBeFocused();
  });

  test('todo text uses one indent and its empty hint clears the checkbox', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const todoText = 'Todo open — try each toolbar control';
    const todo = editor.getByText(todoText, {
      exact: true,
    });
    const bullet = editor.getByText('Bulleted item — organelles', {
      exact: true,
    });
    const bulletLeft = await bullet.evaluate(
      (element) => element.getBoundingClientRect().left
    );
    expect(
      await todo.evaluate((element) => element.getBoundingClientRect().left)
    ).toBeCloseTo(bulletLeft, 0);
    await selectEditorLine(page, todo);
    await page.keyboard.press('Backspace');
    const empty = editor.locator('.slate-p[placeholder]');
    await expect(empty).toHaveCount(1);
    const spacing = await empty.evaluate((element) => {
      const checkbox = element
        .querySelector('input[type="checkbox"]')!
        .getBoundingClientRect();
      const caret = element
        .querySelector('[data-slate-zero-width]')!
        .getBoundingClientRect();
      return {
        gap: caret.left - checkbox.right,
        hintLeft: element.getBoundingClientRect().left,
      };
    });
    expect(spacing.hintLeft).toBeCloseTo(bulletLeft, 0);
    expect(spacing.gap).toBeCloseTo(8, 0);
    await page.keyboard.press('Tab');
    expect(
      await empty.evaluate((element) => element.getBoundingClientRect().left)
    ).toBeCloseTo(bulletLeft + 24, 0);
    await page.keyboard.press('Shift+Tab');
    expect(
      await empty.evaluate((element) => element.getBoundingClientRect().left)
    ).toBeCloseTo(bulletLeft, 0);
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

  test('list handles and todo checkboxes align with the first line of wrapped rows', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 360 });
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    for (const title of [
      'Bulleted item — organelles',
      'Numbered step — isolate the variable',
      'Todo checked — skim the matrix',
      'Todo open — try each toolbar control',
    ]) {
      const text = editor.getByText(title, { exact: true });
      await text.hover();
      await expect
        .poll(() =>
          text.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const firstLine = range.getClientRects()[0];
            const wrapper = element.closest('[data-slot="block-wrapper"]')!;
            return Math.max(
              ...Array.from(
                wrapper.querySelectorAll(
                  'button[aria-label="Drag block"], input[type="checkbox"]'
                ),
                (control) => {
                  const rect = control.getBoundingClientRect();
                  return Math.abs(
                    rect.y +
                      rect.height / 2 -
                      firstLine.y -
                      firstLine.height / 2
                  );
                }
              )
            );
          })
        )
        .toBeLessThan(2);
    }
    const checkbox = editor.getByRole('checkbox', {
      name: 'Mark task complete',
    });
    await checkbox.check();
    await expect(
      editor.getByRole('checkbox', { name: 'Mark task incomplete' })
    ).toHaveCount(2);
  });

  test('heading handles align with the first text line at every size', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 360 });
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    for (const title of [
      'Editor feature matrix',
      'Headings',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'Heading 6',
    ]) {
      const heading = editor.getByRole('heading', { exact: true, name: title });
      await heading.hover();
      const handle = editor
        .locator('[data-slot="block-wrapper"]')
        .filter({
          has: page.getByRole('heading', { exact: true, name: title }),
        })
        .last()
        .getByRole('button', { exact: true, name: 'Drag block' });
      await expect
        .poll(() =>
          handle.evaluate((element) => {
            const text = element
              .closest('[data-slot="block-wrapper"]')!
              .querySelector('[data-slate-string]')!;
            const range = document.createRange();
            range.selectNodeContents(text);
            const firstLine = range.getClientRects()[0];
            const handleRect = element.getBoundingClientRect();
            return Math.abs(
              handleRect.y +
                handleRect.height / 2 -
                (firstLine.y + firstLine.height / 2)
            );
          })
        )
        .toBeLessThan(2);
    }
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
