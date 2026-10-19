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
  // The outline row brings the block into view and focuses it; Enter edits.
  await dialog
    .getByRole('button', { name: /^A rectangle has area/ })
    .and(dialog.locator('button:not([aria-haspopup])'))
    .click();
  await expect(dialog.locator('[data-row-key]:focus')).toHaveCount(1);
  await page.keyboard.press('Enter');
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

test('a wide display formula scrolls in its own box with an edge fade, a fitting one has no mask, and the page does not scroll', async ({
  page,
}) => {
  // The smallest supported phone: on narrow widths the stem runs the full
  // width under the number, and the reaction equation just fits at 390 px.
  await page.setViewportSize({ height: 844, width: 360 });
  await page.goto('/materials/qz_1?mode=edit');
  // The first question's reaction equation is wider than a 360 px column.
  const formula = page
    .locator('[data-question-id]')
    .first()
    .getByRole('math')
    .first();
  await expect(formula.locator('.ML__base')).toBeVisible({ timeout: 30_000 });
  await formula.scrollIntoViewIfNeeded();
  // The formula's nearest horizontal scroller with its scroll-fade-x edges
  // (start and end), and any scroller around it that overflows sideways (the
  // page must not). `toEnd` first scrolls the box to its end.
  const measure = (toEnd = false) =>
    formula.evaluate((element, end) => {
      const scrolls = (el: Element) =>
        ['auto', 'scroll'].includes(getComputedStyle(el).overflowX);
      let box: Element | null = element.querySelector('math-field');
      while (box && !scrolls(box)) box = box.parentElement;
      if (box && end) box.scrollLeft = box.scrollWidth;
      const style = box && getComputedStyle(box);
      const outer: string[] = [];
      for (let el = box?.parentElement; el; el = el.parentElement)
        if (scrolls(el) && el.scrollWidth > el.clientWidth)
          outer.push(el.className);
      const page = document.documentElement;
      return {
        client: box?.clientWidth ?? 0,
        fade: `${style?.getPropertyValue('--scroll-fade-start')} ${style?.getPropertyValue('--scroll-fade-end')}`,
        left: box?.scrollLeft ?? 0,
        mask: style?.maskImage,
        outer,
        pageOverflow: page.scrollWidth - page.clientWidth + window.scrollX,
        scroll: box?.scrollWidth ?? 0,
      };
    }, toEnd);
  const before = await measure();
  expect(before.scroll).toBeGreaterThan(before.client);
  expect(before.outer).toEqual([]);
  expect(before.pageOverflow).toBe(0);
  // At rest only the hidden end fades.
  await expect.poll(async () => (await measure()).fade).toBe('0px 28px');
  // The field is inert, so the wheel over it reaches the box.
  const bounds = (await formula.boundingBox())!;
  await page.mouse.move(bounds.x + 40, bounds.y + bounds.height / 2);
  await page.mouse.wheel(200, 0);
  await expect.poll(async () => (await measure()).left).toBeGreaterThan(0);
  const after = await measure();
  expect(after.outer).toEqual([]);
  expect(after.pageOverflow).toBe(0);
  // Scrolled to the end, the end fade is gone and the hidden start fades.
  await expect.poll(async () => (await measure(true)).fade).toBe('28px 0px');
  // Opened on a wide screen the same formula fits: no fade and no mask at
  // all, so its text keeps subpixel antialiasing. (Reloaded: a box that grows
  // to fit while scrolled keeps its last fade until it scrolls again.)
  await page.setViewportSize({ height: 844, width: 1440 });
  await page.reload();
  await expect(formula.locator('.ML__base')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const { client, fade, mask, scroll } = await measure();
      return { fade, fits: scroll <= client, mask };
    })
    .toEqual({ fade: '0px 0px', fits: true, mask: 'none' });
});
