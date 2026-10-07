import { expect, test } from '@playwright/test';
import type { MathfieldElement } from 'mathlive';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('inline editing overlays its control without moving a formula near the line end', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const preview = editor
    .getByRole('button', { exact: true, name: m.editor_equation() })
    .first();
  await expect(preview.locator('.ML__base')).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  const before = await preview.evaluate((button) => {
    const paragraph = button
      .closest('[data-slate-node="element"]')!
      .parentElement!.closest('[data-slate-node="element"]')! as HTMLElement;
    paragraph.dataset.formulaParagraph = '';
    const formula = button
      .querySelector('math-field')!
      .shadowRoot!.querySelector('.ML__base')!;
    const box = formula.getBoundingClientRect();
    paragraph.style.width = `${box.right - paragraph.getBoundingClientRect().left + 2}px`;
    const suffix = document.createElement('span');
    suffix.dataset.formulaSuffix = '';
    suffix.textContent = ' Following text';
    paragraph.append(suffix);
    return {
      formula: formula.getBoundingClientRect().toJSON(),
      height: paragraph.getBoundingClientRect().height,
      suffix: suffix.getBoundingClientRect().toJSON(),
    };
  });
  await preview.click();
  const field = editor.locator('math-field:not([read-only])');
  await expect(field).toBeFocused();
  const after = await field.evaluate((el) => ({
    formula: el
      .shadowRoot!.querySelector('.ML__base')!
      .getBoundingClientRect()
      .toJSON(),
    height: document
      .querySelector('[data-formula-paragraph]')!
      .getBoundingClientRect().height,
    suffix: document
      .querySelector('[data-formula-suffix]')!
      .getBoundingClientRect()
      .toJSON(),
  }));
  for (const part of ['formula', 'suffix'] as const) {
    for (const dimension of ['x', 'y', 'width', 'height']) {
      expect(
        Math.abs(after[part][dimension] - before[part][dimension]),
        `${part} ${dimension}`
      ).toBeLessThan(1);
    }
  }
  expect(after.height).toBe(before.height);
  const menu = editor.getByRole('button', {
    name: m.question_ui_formula_menu(),
  });
  await menu.click();
  await expect(
    field.getByRole('menuitem', { exact: true, name: 'Insert' })
  ).toBeVisible();
});

test('a wrapped inline formula stays painted when opening and finishing editing', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const preview = editor
    .getByRole('button', { exact: true, name: m.editor_equation() })
    .first();
  await preview.click();
  const field = editor.locator('math-field:not([read-only])');
  const latex = '\\Delta G=\\Delta H-T\\Delta S+\\overline{x}+\\frac{a}{b}';
  await field.evaluate(
    (el, value) => (el as MathfieldElement).setValue(value),
    latex
  );
  await field.press('Enter');
  await expect(preview.locator('.ML__base')).toBeVisible();
  await preview.locator('..').evaluate((el) => {
    el.dataset.formulaSlot = '';
  });
  const slot = editor.locator('[data-formula-slot]');
  // Force the formula onto the next line, where a collapsed editor is conspicuous.
  await slot.evaluate((el) => {
    el.style.display = 'inline-block';
    el.style.marginLeft = '200px';
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const frames = await slot.evaluate(async (el) => {
      const frames: { width: number; text: string }[] = [];
      const sample = () => {
        const field = el.querySelector('math-field');
        const content = field?.shadowRoot?.querySelector('.ML__base');
        frames.push({
          text: content?.textContent ?? '',
          width: content?.getBoundingClientRect().width ?? 0,
        });
      };
      const done = new Promise<void>((resolve) => {
        const frame = () => {
          sample();
          if (frames.length < 8) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      el.querySelector('button')!.click();
      await done;
      return frames;
    });
    expect(
      frames.every((frame) => frame.width > 100 && frame.text.includes('Δ')),
      JSON.stringify(frames)
    ).toBe(true);
    await expect(field).toBeFocused();
    const closingFrames = await slot.evaluate(
      async (el, blur) => {
        const frames: { width: number; text: string }[] = [];
        const done = new Promise<void>((resolve) => {
          const frame = () => {
            const content = el
              .querySelector('math-field')
              ?.shadowRoot?.querySelector('.ML__base');
            frames.push({
              text: content?.textContent ?? '',
              width: content?.getBoundingClientRect().width ?? 0,
            });
            if (frames.length < 8) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        const field = el.querySelector('math-field')!;
        if (blur) field.blur();
        else
          field.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })
          );
        await done;
        return frames;
      },
      attempt % 2 === 1
    );
    expect(
      closingFrames.every(
        (frame) => frame.width > 100 && frame.text.includes('Δ')
      ),
      JSON.stringify(closingFrames)
    ).toBe(true);
    await expect(preview.locator('.ML__base')).toBeVisible();
  }
});
