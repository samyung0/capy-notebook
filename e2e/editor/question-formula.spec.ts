import { expect, test } from '@playwright/test';
import type { MathfieldElement } from 'mathlive';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('block formula preserves its height and dismisses the virtual keyboard', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const preview = editor
    .getByRole('button', { exact: true, name: m.editor_equation() })
    .last();
  await expect(preview.locator('.ML__base')).toBeVisible();
  await preview
    .locator('..')
    .evaluate((el) => el.setAttribute('data-formula-test', 'block'));
  const paragraph = editor.locator('[data-formula-test="block"]');
  const before = await paragraph.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  await paragraph
    .getByRole('button', { exact: true, name: m.editor_equation() })
    .click();
  const field = paragraph.locator('math-field:not([read-only])');
  await expect(field).toBeVisible();
  const after = await paragraph.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  expect(after).toBeLessThanOrEqual(before + 1);
  const toggle = paragraph.getByRole('button', {
    name: m.question_ui_formula_keyboard(),
  });
  await expect(toggle).toHaveAttribute('data-variant', 'ghost');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeVisible();
  await toggle.click();
  await field.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeVisible();
  await toggle.click();
  await page
    .getByRole('toolbar', { name: m.editor_doc_formatting() })
    .getByRole('button', { exact: true, name: m.editor_bold() })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.mathVirtualKeyboard.visible))
    .toBe(false);
  await paragraph
    .getByRole('button', { exact: true, name: m.editor_equation() })
    .click();
  await toggle.click();
  await field.press('ControlOrMeta+A');
  await page
    .locator('.ML__keyboard [data-keycap-value="5"]')
    .filter({ visible: true })
    .click();
  await expect(field).toHaveJSProperty('value', '5');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.mathVirtualKeyboard.visible))
    .toBe(false);
});

test('question formula accepts physical digits and retains them after commit', async ({
  page,
}) => {
  await page.goto('/qb/mensuration/bank-quadratic?mode=edit');
  // Page readiness: MathLive loads lazily, so this gets the editor-loading
  // allowance openEditorNote uses.
  await expect(
    page.locator('[data-math-preview] .ML__base').first()
  ).toBeVisible({ timeout: 30_000 });
  // The MSW User scenarios panel floats over the footer's bottom-right Edit.
  await page
    .getByRole('button', { exact: true, name: m.question_ui_edit_question() })
    .press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: /^A rectangle has area/ })
    .and(dialog.locator('button:not([aria-haspopup])'))
    .click();
  const editor = dialog.getByRole('textbox', {
    name: m.question_ui_text_and_formulas(),
  });
  await editor
    .getByRole('button', { exact: true, name: m.question_ui_formula() })
    .first()
    .click();
  const formula = editor.locator('math-field:not([read-only])');
  await expect(formula).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: m.question_ui_formula_keyboard() })
  ).toHaveCount(0);
  await formula.press('ControlOrMeta+A');
  await formula.press('5');
  await expect(formula).toHaveJSProperty('value', '5');
  const tex =
    '\\overline{x}+\\frac{\\mathrm{d}^{2}}{\\mathrm{d}x^{2}}\\text{ATP}';
  await formula.evaluate(
    (el, value) => (el as MathfieldElement).setValue(value),
    tex
  );
  await expect(formula.locator('.ML__base')).toContainText('ATP');
  await page.evaluate(() => document.fonts.ready);
  const editing = await formula.locator('.ML__base').boundingBox();
  await formula.press('Enter');
  const preview = editor
    .getByRole('button', { exact: true, name: m.question_ui_formula() })
    .first();
  const rendered = preview.locator('math-field');
  await expect(rendered).toHaveJSProperty('readOnly', true);
  await expect(rendered).toHaveJSProperty('inert', true);
  await expect(rendered).toHaveJSProperty('value', tex);
  await expect(rendered.locator('.ML__base')).toContainText('ATP');
  const viewing = await rendered.locator('.ML__base').boundingBox();
  expect(Math.abs(viewing!.width - editing!.width)).toBeLessThan(0.1);
  expect(Math.abs(viewing!.height - editing!.height)).toBeLessThan(0.1);
  await preview.click();
  await expect(formula).toHaveJSProperty('value', tex);
  await formula.press('ControlOrMeta+A');
  await formula.press('5');
  await dialog
    .getByRole('button', { name: m.question_ui_formula_menu() })
    .click();
  await formula.getByRole('menuitem', { exact: true, name: 'Insert' }).hover();
  await formula.getByRole('menuitem', { name: /Absolute Value/ }).click();
  await expect(formula).toHaveJSProperty('value', '5|\\placeholder{}|');
  await formula.press('ControlOrMeta+A');
  await formula.press('5');
  await formula.press('Enter');
  await expect(formula).toHaveCount(0);
  await editor
    .getByRole('button', { exact: true, name: m.question_ui_formula() })
    .first()
    .click();
  await expect(formula).toHaveJSProperty('value', '5');
});
