import { expect, type Page, test } from '@playwright/test';

/**
 * The drawing answer's board on its dev route: BlockSuite's edgeless editor, a
 * pen stroke and a typed label, the sheet and both in the image for marking, the
 * answer reopening from what it saved, and the tools added on top of it.
 */

const canvas = (page: Page) => page.evaluate('window.__board.stats().canvas');

test('draws, labels, renders to an image and reopens', async ({ page }) => {
  // Opening the editor from source is slow on a loaded runner.
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/drawing');
  await page.locator('edgeless-pen-tool-button').first().click();

  const sheet = page.locator('.edgeless-background > div').first();
  const box = await sheet.boundingBox();
  if (!box) throw new Error('no sheet');
  const at = (x: number, y: number) =>
    [box.x + x * box.width, box.y + y * box.height] as const;

  await page.mouse.move(...at(0.1, 0.2));
  await page.mouse.down();
  for (let step = 1; step <= 20; step++)
    await page.mouse.move(...at(0.1 + step * 0.04, 0.2 + step * 0.03));
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['brush']);

  // The note menu holds no image, link or file buttons, or the divider after them.
  await page.locator('edgeless-note-senior-button').first().click();
  await expect(page.locator('edgeless-note-menu')).toBeVisible();
  await expect(page.locator('edgeless-note-menu .divider')).toHaveCount(0);

  await page.keyboard.press('v');
  await page.mouse.dblclick(...at(0.7, 0.3));
  await page.keyboard.type('label');
  await page.mouse.click(...at(0.05, 0.9));
  await expect.poll(() => canvas(page)).toEqual(['brush', 'text']);
  expect(errors).toEqual([]);

  const image = await page.evaluate('window.__board.toImage()');
  expect(image).toMatch(/^data:image\/png;base64,/);

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(['brush', 'text']);
});

test('plots on the sheet, places a preset and a formula, and undoes outside the toolbar', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/drawing');
  const sheet = page.locator('.edgeless-background > div').first();
  // Opening the editor from source is slow on a loaded runner.
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  if (!box) throw new Error('no sheet');
  // Grid units: the axes cross at (41, 360) on the 820 by 520 sheet.
  const at = (x: number, y: number) =>
    [
      box.x + ((41 + 41 * x) / 820) * box.width,
      box.y + ((360 - 40 * y) / 520) * box.height,
    ] as const;

  // A new shape has no fill: the panel's square draws an outline.
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Square' }).click();
  await page.mouse.move(...at(5, 6));
  await page.mouse.down();
  await page.mouse.move(...at(8, 4), { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['shape']);

  // A preset is grouped straight connectors, and it closes the panel.
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Hexagon' }).click();
  await page.mouse.click(...at(11, 6));
  await expect(page.locator('capy-shape-panel')).toHaveCount(0);
  await expect.poll(() => canvas(page)).toContain('group');
  await expect.poll(() => canvas(page)).toContain('connector');

  // Curve: clicks snap, the last point clicked again finishes it.
  await page.locator('capy-maths-button').first().click();
  await page.getByRole('button', { name: 'Curve through points' }).click();
  for (const [x, y] of [
    [0, 0],
    [1, -1],
    [2, 0],
    [3, 3],
  ] as const)
    await page.mouse.click(...at(x, y));
  await page.mouse.click(...at(3, 3));
  await expect.poll(() => canvas(page)).toContain('brush');

  // The formula is drawn on the canvas and reopens from what it saved.
  await page.getByRole('button', { name: 'Formula' }).click();
  await page.locator('.capy-formula math-field').waitFor();
  await page.keyboard.type('x^2+s');
  await page.locator('.capy-formula .primary').click();
  await expect.poll(() => canvas(page)).toContain('formula');

  const image = await page.evaluate('window.__board.toImage()');
  expect(image).toMatch(/^data:image\/png;base64,/);

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toContain('formula');

  // Undo sits outside the toolbar, beside zoom.
  await page.mouse.click(...at(1, 1));
  await page.locator('edgeless-pen-tool-button').first().click();
  await page.mouse.move(...at(12, 1));
  await page.mouse.down();
  await page.mouse.move(...at(14, 2), { steps: 5 });
  await page.mouse.up();
  const strokes = () =>
    canvas(page).then((types) =>
      (types as string[]).filter((t) => t === 'brush')
    );
  await expect.poll(async () => (await strokes()).length).toBe(2);
  // The dev route's scenario panel covers this corner, on no real page.
  await page
    .locator('.capy-board-history button')
    .first()
    .dispatchEvent('click');
  await expect.poll(async () => (await strokes()).length).toBe(1);
  expect(errors).toEqual([]);
});

test('a phone has undo at the top and the toolbar at full width', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 720, width: 360 });
  await page.goto('/dev/drawing');
  await page.locator('.edgeless-background > div').first().waitFor();
  const undo = await page.locator('.capy-board-history').boundingBox();
  expect(undo?.y).toBeLessThan(60);
  expect(
    await page.locator('edgeless-toolbar-widget smooth-corner').boundingBox()
  ).toMatchObject({ width: 344, x: 8 });
});
