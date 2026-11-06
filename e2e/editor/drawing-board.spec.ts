import { expect, type Page, test } from '@playwright/test';

/**
 * The drawing answer's board on its dev route: BlockSuite's edgeless editor, a
 * pen stroke and a typed label, the sheet and both in the image for marking, and
 * the answer reopening from what it saved.
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
