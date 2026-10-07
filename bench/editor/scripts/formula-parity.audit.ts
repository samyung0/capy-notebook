import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { MathfieldElement } from 'mathlive';
import { openEditorNote } from '../../../e2e/editor/helpers';
import { m } from '../../../e2e/i18n';

// MathLive upgrade audit (pnpm bench:formula): every Insert and matrix
// template, empty and filled, inline and block, must render the same in View
// as in Edit. Captures and geometry JSON land in bench/editor/.results/.

function formulaGeometry(root: Element) {
  const origin = root.getBoundingClientRect();
  return [...root.querySelectorAll('span')]
    .filter(
      (el) =>
        el.matches('.ML__frac-line, .overline-line, .ML__sqrt-line') ||
        (!el.childElementCount && !!el.textContent?.trim())
    )
    .map((el) => {
      const box = el.getBoundingClientRect();
      return {
        bounds: [box.x - origin.x, box.y - origin.y, box.width, box.height],
        font: getComputedStyle(el).font,
        text: el.textContent,
      };
    });
}

for (const mode of ['inline', 'block'] as const) {
  test(`${mode} audit of every formula insertion template`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const editor = await openEditorNote(
      page,
      'mat_note_bio_feature_matrix',
      'Editor feature matrix'
    );
    const previews = editor.getByRole('button', {
      exact: true,
      name: m.editor_equation(),
    });
    const preview = mode === 'block' ? previews.last() : previews.first();
    await preview.click();
    const field = editor.locator('math-field:not([read-only])');
    await expect(field).toBeVisible();
    // Use the installed library's actual menu commands, including every grid cell.
    const templates = await field.evaluate((el) => {
      const math = el as MathfieldElement;
      const results: { id: string; latex: string }[] = [];
      for (const group of math.menuItems) {
        if (
          !('id' in group) ||
          !['insert', 'insert-matrix'].includes(group.id ?? '') ||
          !('submenu' in group)
        )
          continue;
        for (const item of group.submenu) {
          if (!('onMenuSelect' in item) || !item.onMenuSelect) continue;
          math.setValue('');
          item.onMenuSelect({});
          results.push({ id: item.id ?? '', latex: math.value });
        }
      }
      return results;
    });
    expect(templates).toHaveLength(38);
    type Bounds = Awaited<ReturnType<typeof field.boundingBox>>;
    const results: {
      id: string;
      latex: string;
      edit: Bounds;
      view: Bounds;
      widthDelta: number;
      heightDelta: number;
    }[] = [];
    for (const template of templates) {
      for (const filled of [false, true]) {
        const id = `${template.id}-${filled ? 'filled' : 'empty'}`;
        const source = filled
          ? template.latex.replaceAll('\\placeholder{}', '{x}')
          : template.latex;
        const latex = await field.evaluate((el, value) => {
          const math = el as MathfieldElement;
          math.setValue(value, { selectionMode: 'after' });
          return math.value;
        }, source);
        await expect(field).toHaveJSProperty('selectionIsCollapsed', true);
        await page.evaluate(() => document.fonts.ready);
        await field.scrollIntoViewIfNeeded();
        const edit = await field.locator('.ML__base').first().boundingBox();
        const editGeometry = await field
          .locator('.ML__base')
          .evaluate(formulaGeometry);
        const editBox = await field.locator('.ML__latex').boundingBox();
        expect(edit!.width).toBeLessThan(400);
        await page.screenshot({
          clip: {
            height: editBox!.height,
            width: edit!.width + 4,
            x: edit!.x - 2,
            y: editBox!.y,
          },
          path: test.info().outputPath(`${id}-edit.png`),
          style:
            '.ML__caret::after, .ML__text-caret::after { visibility: hidden !important; }',
        });
        await field.press('Enter');
        await expect(preview.locator('.ML__base')).toBeVisible();
        const view = await preview.locator('.ML__base').first().boundingBox();
        expect(view!.width).toBeLessThan(400);
        const text = await preview.locator('.ML__base').innerText();
        expect(text).not.toContain('\\placeholder');
        expect(text).not.toMatch(/\\[a-zA-Z]/);
        await expect(preview.locator('.ML__error')).toHaveCount(0);
        const viewBox = await preview.locator('.ML__latex').boundingBox();
        expect(Math.abs(view!.width - edit!.width), id).toBeLessThan(0.1);
        expect(Math.abs(view!.height - edit!.height), id).toBeLessThan(0.1);
        const viewGeometry = await preview
          .locator('.ML__base')
          .evaluate(formulaGeometry);
        expect(viewGeometry.length, id).toBe(editGeometry.length);
        for (const [index, atom] of viewGeometry.entries()) {
          expect(atom.text, id).toBe(editGeometry[index].text);
          expect(atom.font, id).toBe(editGeometry[index].font);
          for (const [dimension, value] of atom.bounds.entries()) {
            expect(
              Math.abs(value - editGeometry[index].bounds[dimension]),
              id
            ).toBeLessThan(0.1);
          }
        }
        await page.screenshot({
          clip: {
            height: viewBox!.height,
            width: view!.width + 4,
            x: view!.x - 2,
            y: viewBox!.y,
          },
          path: test.info().outputPath(`${id}-view.png`),
        });
        results.push({
          edit,
          heightDelta: view!.height - edit!.height,
          id,
          latex,
          view,
          widthDelta: view!.width - edit!.width,
        });
        await preview.click();
        await expect(field).toBeVisible();
        await expect(field).toHaveJSProperty('value', latex);
      }
    }
    const report = test.info().outputPath(`${mode}-parity.json`);
    await writeFile(report, JSON.stringify(results, null, 2));
    await test.info().attach(`${mode}-parity.json`, {
      contentType: 'application/json',
      path: report,
    });
    expect(errors).toEqual([]);
  });
}
