import { expect, test } from '@playwright/test';
import type { MathfieldElement } from 'mathlive';
import { openEditorNote } from './helpers';

test('formula menus reopen after outside dismissal and replacing the editor', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const preview = editor
    .getByRole('button', { exact: true, name: 'Equation' })
    .last();
  const field = editor.locator('math-field:not([read-only])');
  const toggle = editor.getByRole('button', { name: 'Formula menu' });
  for (let round = 0; round < 3; round++) {
    await preview.click();
    await expect(field).toBeVisible();
    await toggle.click();
    if (round > 0) {
      await field
        .getByRole('menuitem', { exact: true, name: 'Insert' })
        .hover();
      await expect(
        field.getByRole('menuitem', { name: /Absolute Value/ })
      ).toBeVisible();
    }
    await page.mouse.click(420, 350);
    await expect(field.getByRole('menu')).toHaveCount(0);
    await toggle.click();
    await expect(field.getByRole('menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(field.getByRole('menu')).toHaveCount(0);
    await field.press('Enter');
    await expect(field).toHaveCount(0);
  }
  await preview.click();
  await toggle.click();
  await expect(field.getByRole('menu')).toHaveCount(1);
  // Focus changes or editor teardown can replace the formula with a menu open.
  await field.dispatchEvent('blur');
  await expect(field).toHaveCount(0);
  await preview.click();
  await toggle.click();
  await expect(field.getByRole('menu')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('formula menu inserts matrices and templates, switches modes, and copies and pastes LaTeX', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  await editor
    .getByRole('button', { exact: true, name: 'Equation' })
    .last()
    .click();
  const field = editor.locator('math-field:not([read-only])');
  await expect(field).toBeVisible();
  await field.press('ControlOrMeta+A');
  await field.press('Backspace');
  const toggle = editor.getByRole('button', { name: 'Formula menu' });
  await toggle.click();
  const menu = field.getByRole('menu').first();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Insert Matrix',
    'Insert',
    'Mode',
    'Copy',
    /Paste/,
  ]);
  await expect(menu).toHaveCSS('border-radius', '8px');
  await expect(menu).toHaveCSS('font-size', '14px');
  await field
    .getByRole('menuitem', { exact: true, name: 'Insert Matrix' })
    .hover();
  const grid = field.locator('.insert-matrix-submenu');
  await expect(grid).toBeVisible();
  await grid.getByRole('menuitem').nth(7).click(); // 2 rows, 3 columns
  await expect(field).toBeVisible();
  await expect
    .poll(() => field.evaluate((el) => (el as MathfieldElement).value))
    .toContain('\\begin{pmatrix}');
  const matrix = await field.evaluate((el) => (el as MathfieldElement).value);
  expect(matrix.match(/\\placeholder/g)).toHaveLength(6);
  await field.press('Enter');
  const preview = editor
    .getByRole('button', { exact: true, name: 'Equation' })
    .last();
  await expect(preview.locator('.ML__base')).toHaveText(/▢.*▢.*▢.*▢.*▢.*▢/);
  await expect(preview.locator('.ML__base')).not.toContainText('\\placeholder');
  await preview.screenshot({
    path: test.info().outputPath('matrix-placeholders.png'),
  });
  await preview.click();
  await expect(field).toHaveJSProperty('value', matrix);
  await toggle.click();
  await field.getByRole('menuitem', { exact: true, name: 'Copy' }).hover();
  await field.getByRole('menuitem', { name: /Copy as LaTeX/ }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('\\begin{pmatrix}');
  await field.press('ControlOrMeta+A');
  await field.press('Backspace');
  await toggle.click();
  await field.getByRole('menuitem', { name: /Paste/ }).click();
  await expect
    .poll(() => field.evaluate((el) => (el as MathfieldElement).value))
    .toBe(matrix);
  await field.press('ControlOrMeta+A');
  await field.press('Backspace');
  await toggle.click();
  await field.getByRole('menuitem', { exact: true, name: 'Insert' }).hover();
  await field.getByRole('menuitem', { name: /Absolute Value/ }).click();
  await expect
    .poll(() => field.evaluate((el) => (el as MathfieldElement).value))
    .toContain('|');
  await field.press('Enter');
  await expect(preview.locator('.ML__base')).toContainText('▢');
  await expect(preview.locator('.ML__base')).not.toContainText('\\placeholder');
  await preview.click();
  await field.press('ControlOrMeta+A');
  await field.press('Backspace');
  await toggle.click();
  await field.getByRole('menuitem', { exact: true, name: 'Mode' }).hover();
  const mathMode = field.getByRole('menuitemcheckbox', {
    exact: true,
    name: 'Math',
  });
  const check = await mathMode.locator('.ui-checkmark').boundingBox();
  const label = await mathMode.locator('.label').boundingBox();
  expect(check!.width).toBe(12);
  expect(check!.height).toBe(12);
  expect(label!.x - check!.x - check!.width).toBe(8);
  expect(
    Math.abs(check!.y + check!.height / 2 - label!.y - label!.height / 2)
  ).toBeLessThan(1);
  await mathMode
    .locator('..')
    .screenshot({ path: test.info().outputPath('formula-mode-menu.png') });
  await field
    .getByRole('menuitemcheckbox', { exact: true, name: 'Text' })
    .click();
  await expect(field).toHaveJSProperty('mode', 'text');
  await field.pressSequentially('ATP');
  await toggle.click();
  await field.getByRole('menuitem', { exact: true, name: 'Mode' }).hover();
  await field
    .getByRole('menuitemcheckbox', { exact: true, name: 'Math' })
    .click();
  await expect(field).toHaveJSProperty('mode', 'math');
  await field.pressSequentially('->');
  await expect(field).toHaveJSProperty('value', '\\text{ATP}\\to');
  await toggle.click();
  await page.screenshot({ path: test.info().outputPath('formula-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(field).toBeVisible();
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await editor
    .getByRole('button', { exact: true, name: 'Equation' })
    .last()
    .click();
  await expect(field).toHaveJSProperty('value', '\\text{ATP}\\to');
});

test('text caret stays on the math baseline and physical arrow shortcuts survive commit', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  await editor
    .getByRole('button', { exact: true, name: 'Equation' })
    .last()
    .click();
  const field = editor.locator('math-field:not([read-only])');
  await expect(field).toBeVisible();
  const mathCaret = await field.locator('.ML__caret').boundingBox();
  await field.locator('.ML__text').nth(1).click();
  await expect(field).toHaveJSProperty('mode', 'text');
  const textCaret = await field.locator('.ML__text-caret').boundingBox();
  expect(mathCaret).not.toBeNull();
  expect(textCaret).not.toBeNull();
  expect(textCaret!.height).toBe(0);
  expect(Math.abs(textCaret!.y - mathCaret!.y)).toBeLessThanOrEqual(1);
  await field.press('x');
  await expect
    .poll(() =>
      field.evaluate((element) => (element as MathfieldElement).value)
    )
    .toContain('\\text{ATxP}');
  await field.pressSequentially('->');
  await expect
    .poll(() =>
      field.evaluate((element) => (element as MathfieldElement).value)
    )
    .toContain('\\text{ATx->P}');
  // A text-mode caret can remain at a run edge after typing or deleting there.
  await field.evaluate((element) => {
    const math = element as MathfieldElement;
    math.setValue('\\text{ATP}+x');
    math.position = 3;
    math.mode = 'text';
  });
  await field.pressSequentially('->');
  await expect(field).toHaveJSProperty('value', '\\text{ATP}\\to+x');
  await field.evaluate((element) => {
    const math = element as MathfieldElement;
    math.position = 0;
    math.mode = 'text';
  });
  await field.pressSequentially('->');
  await expect(field).toHaveJSProperty('value', '\\to\\text{ATP}\\to+x');
  await field.press('ControlOrMeta+A');
  await field.press('Backspace');
  await field.press('-');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Period');
  await page.keyboard.up('Shift');
  await expect(field).toHaveJSProperty('value', '\\to');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(
    editor.getByRole('button', { exact: true, name: 'Equation' }).last()
  ).toContainText('→');
});

for (const kind of ['block', 'inline'] as const) {
  test(`${kind} formula keeps its layout and selection legible in a light app on a dark system`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('capy.theme', 'latte'));
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const buttons = editor.getByRole('button', {
      exact: true,
      name: 'Equation',
    });
    const button = kind === 'block' ? buttons.last() : buttons.first();
    await button.scrollIntoViewIfNeeded();
    await expect(button.locator('.ML__base')).toBeVisible();
    const container = await button.locator('..').elementHandle();
    const before = await container!.boundingBox();
    expect(before).not.toBeNull();
    await button.click();
    const field = editor.locator('math-field:not([read-only])');
    await expect(field).toBeVisible();
    await expect(field).toHaveJSProperty('selectionIsCollapsed', true);
    const original = await field.elementHandle();
    const wrapper = field.locator('..').locator('..');
    const keyboard = wrapper.getByRole('button', { name: 'Formula keyboard' });
    const wrapperBox = await wrapper.boundingBox();
    const menuBox = await wrapper
      .getByRole('button', { name: 'Formula menu' })
      .boundingBox();
    expect(
      wrapperBox!.x + wrapperBox!.width - menuBox!.x - menuBox!.width
    ).toBe(8);
    if (kind === 'inline') {
      await expect(keyboard).toHaveCount(0);
      expect(
        Math.abs(
          menuBox!.y +
            menuBox!.height / 2 -
            wrapperBox!.y -
            wrapperBox!.height / 2
        )
      ).toBeLessThan(1);
      const fieldBox = await field.boundingBox();
      expect(menuBox!.x - fieldBox!.x - fieldBox!.width).toBeGreaterThanOrEqual(
        8
      );
    } else {
      const keyboardBox = await keyboard.boundingBox();
      expect(menuBox!.x).toBe(keyboardBox!.x);
      expect(menuBox!.y).toBeGreaterThanOrEqual(
        keyboardBox!.y + keyboardBox!.height
      );
    }
    const initialValue = await field.evaluate(
      (element) => (element as MathfieldElement).value
    );
    const after = await container!.boundingBox();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);

    if (kind === 'block') {
      const padding = await field
        .locator('[part="container"]')
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            bottom: Number.parseFloat(style.paddingBottom),
            top: Number.parseFloat(style.paddingTop),
          };
        });
      expect(padding.top).toBeGreaterThanOrEqual(16);
      expect(padding.bottom).toBeGreaterThanOrEqual(16);
      await field.click({ position: { x: 10, y: 8 } });
      await expect(field).toBeFocused();
      const text = field.locator('.ML__text').first();
      await expect(text).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(text).toHaveCSS('font-family', /KaTeX_Main/);
    }

    await field.press('Home');
    const caret = field.locator('.ML__caret, .ML__text-caret').first();
    await expect(caret).toHaveCount(1);
    const caretStyle = await caret.evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      // Resolve the app theme's text colour to rgb() for comparison.
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-primary)';
      document.body.append(probe);
      const textPrimary = getComputedStyle(probe).color;
      probe.remove();
      return {
        color: style.borderRightColor,
        fontSize: Number.parseFloat(style.fontSize),
        height: Number.parseFloat(style.height),
        textPrimary,
      };
    });
    // The caret follows the light app theme, not the dark system.
    expect(caretStyle.color).toBe(caretStyle.textPrimary);
    expect(caretStyle.height).toBeGreaterThanOrEqual(caretStyle.fontSize - 0.1);

    const formula = field.locator('.ML__latex');
    const bounds = await formula.boundingBox();
    expect(bounds).not.toBeNull();
    const foreground = await field.evaluate(
      (element) => getComputedStyle(element).color
    );
    await page.mouse.move(bounds!.x + 1, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        bounds!.x + (bounds!.width * step) / 8,
        bounds!.y + bounds!.height / 2
      );
      await expect(field.locator('.ML__selected').first()).toHaveCSS(
        'color',
        foreground
      );
      expect(
        await field.evaluate(
          (element, initial) => element === initial,
          original
        )
      ).toBe(true);
    }
    await page.mouse.up();
    await expect(field).toHaveJSProperty('value', initialValue);
    await expect(field).toHaveJSProperty('selectionIsCollapsed', false);
    await page.screenshot({
      path: test.info().outputPath(`${kind}-selection.png`),
    });
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    const closed = await container!.boundingBox();
    expect(Math.abs(closed!.height - before!.height)).toBeLessThanOrEqual(1);
  });
}
