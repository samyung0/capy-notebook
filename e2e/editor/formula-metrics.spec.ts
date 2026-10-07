import { expect, test } from '@playwright/test';
import type { MathfieldElement } from 'mathlive';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('plain text keeps its font and width, and conjugates use one arrow step per character', async ({
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
  await preview.click();
  const field = editor.locator('math-field:not([read-only])');
  await expect(field).toBeVisible();
  await field.evaluate((el) =>
    (el as MathfieldElement).setValue('\\text{ATP and glucose}')
  );
  await field.press('Enter');
  await expect(preview.locator('.ML__base')).toHaveText('ATP and glucose');
  const view = await preview.locator('.ML__base').evaluate((el) => ({
    font: getComputedStyle(el.querySelector('.ML__text')!).font,
    width: el.getBoundingClientRect().width,
  }));
  await preview.click();
  await expect(field.locator('.ML__text')).toHaveCount(15);
  const edit = await field.locator('.ML__text').evaluateAll((els) => ({
    fonts: [...new Set(els.map((el) => getComputedStyle(el).font))],
    width: els.reduce(
      (width, el) => width + el.getBoundingClientRect().width,
      0
    ),
  }));
  expect(edit.fonts).toEqual([view.font]);
  expect(Math.abs(edit.width - view.width)).toBeLessThan(1);

  for (const [tex, stops] of [
    ['a+\\overline{z}+b', [0, 1, 2, 5, 6, 7]],
    ['a+\\overline{xyz}+b', [0, 1, 2, 4, 5, 7, 8, 9]],
    ['a+\\frac{x}{y}+b', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ] as const) {
    await field.evaluate((el, value) => {
      const math = el as MathfieldElement;
      math.setValue(value);
      math.position = 0;
    }, tex);
    for (const position of stops.slice(1)) {
      await field.press('ArrowRight');
      await expect(field).toHaveJSProperty('position', position);
    }
    for (const position of [...stops].reverse().slice(1)) {
      await field.press('ArrowLeft');
      await expect(field).toHaveJSProperty('position', position);
    }
    await expect(field).toHaveJSProperty('value', tex);
  }
  await field.evaluate((el) => {
    const math = el as MathfieldElement;
    math.setValue('\\overline{xy}');
    math.position = 2;
  });
  await field.press('z');
  await expect(field).toHaveJSProperty('value', '\\overline{xzy}');
});
