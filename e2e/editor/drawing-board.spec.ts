import { expect, type Page, test } from '@playwright/test';

/**
 * The drawing answer's board on its dev route: BlockSuite's edgeless editor with a
 * coordinate plane card, canvas tools over it, the endless plane opened from the
 * card, and the image for marking.
 */

type Stats = { canvas: string[]; marks: number };
const stats = (page: Page) =>
  page.evaluate('window.__board.stats()') as Promise<Stats>;
const canvas = (page: Page) => stats(page).then(({ canvas: types }) => types);
const marks = (page: Page) => stats(page).then(({ marks: count }) => count);

/** Opening the editor from source is slow on a loaded runner, so wait for the card. */
async function openBoard(page: Page, url = '/dev/drawing') {
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
}

/** A point on the first card, from 0 to 1 across it, on the page. */
async function onCard(page: Page) {
  const box = (await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      getBoundingClientRect(): DOMRect;
      gfx: {
        layer: {
          canvasElements: {
            h: number;
            type: string;
            w: number;
            x: number;
            y: number;
          }[];
        };
        viewport: { toViewCoord(x: number, y: number): [number, number] };
      };
    };
    const card = root.gfx.layer.canvasElements.find(
      ({ type }) => type === 'plane'
    );
    if (!card) throw new Error('no card');
    const rect = root.getBoundingClientRect();
    const [left, top] = root.gfx.viewport.toViewCoord(card.x, card.y);
    const [right, bottom] = root.gfx.viewport.toViewCoord(
      card.x + card.w,
      card.y + card.h
    );
    return {
      h: bottom - top,
      w: right - left,
      x: rect.x + left,
      y: rect.y + top,
    };
  })) as { h: number; w: number; x: number; y: number };
  return (x: number, y: number) =>
    [box.x + x * box.w, box.y + y * box.h] as const;
}

/** A point on the open plane, from 0 to 1 across the screen. */
async function onPlane(page: Page) {
  const box = await page.locator('.capy-plane-editor').boundingBox();
  if (!box) throw new Error('no plane');
  return (x: number, y: number) =>
    [box.x + x * box.width, box.y + y * box.height] as const;
}

/** How much of an image isn't white: an empty sheet and a drawn one differ. */
const inkIn = (page: Page, dataUrl: string) =>
  page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const output = document.createElement('canvas');
    output.width = image.width;
    output.height = image.height;
    const ctx = output.getContext('2d');
    if (!ctx) throw new Error('no context');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 60) dark++;
    return dark;
  }, dataUrl);

const toImage = (page: Page) =>
  page.evaluate('window.__board.toImage()') as Promise<string>;

test('draws over the card, labels, and reopens from what it saved', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const at = await onCard(page);

  const before = await inkIn(page, await toImage(page));
  await page.locator('edgeless-pen-tool-button').first().click();
  await page.mouse.move(...at(0.1, 0.2));
  await page.mouse.down();
  for (let step = 1; step <= 20; step++)
    await page.mouse.move(...at(0.1 + step * 0.04, 0.2 + step * 0.03));
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush']);

  // The note menu holds no image, link or file buttons, or the divider after them.
  await page.locator('edgeless-note-senior-button').first().click();
  await expect(page.locator('edgeless-note-menu')).toBeVisible();
  await expect(page.locator('edgeless-note-menu .divider')).toHaveCount(0);

  // A label goes on top of the card from the maths menu.
  await page.keyboard.press('v');
  await page.locator('capy-maths-button').first().click();
  await page.getByRole('button', { name: 'Add a label' }).click();
  await page.mouse.click(...at(0.7, 0.3));
  await page.keyboard.type('label');
  await page.mouse.click(...at(0.05, 0.9));
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush', 'text']);
  expect(errors).toEqual([]);

  // The stroke and label reach the image.
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(before);

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush', 'text']);
});

test('a note card takes typing and leaves $$ as text', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('edgeless-note-senior-button').first().click();
  await page.mouse.click(...at(0.5, 0.5));
  await page.keyboard.type('see $$x^2$$ here');
  await expect(page.locator('affine-edgeless-note')).toContainText(
    'see $$x^2$$ here'
  );
  expect(errors).toEqual([]);
});

test('the shapes panel draws an outline and places a preset', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Square' }).click();
  await page.mouse.move(...at(0.2, 0.2));
  await page.mouse.down();
  await page.mouse.move(...at(0.4, 0.4), { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'shape']);

  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Hexagon' }).click();
  await page.mouse.click(...at(0.7, 0.3));
  await expect(page.locator('capy-shape-panel')).toHaveCount(0);
  await expect.poll(() => canvas(page)).toContain('connector');
  await expect.poll(() => canvas(page)).toContain('group');
});

test('double click opens the plane: it plots, undoes each click, and Escape leaves', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const card = await onCard(page);
  const empty = await inkIn(page, await toImage(page));

  // One click only selects the card; the canvas pen never reaches the plane.
  await page.mouse.click(...card(0.5, 0.5));
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  await page.mouse.dblclick(...card(0.5, 0.5));
  await expect(page.locator('.capy-plane-editor')).toBeVisible();
  const at = await onPlane(page);

  // A curve grows a click at a time; undo steps back one click, and clicking its
  // last point again finishes it.
  await page.getByRole('button', { name: 'Curve through points' }).click();
  for (const [x, y] of [
    [0.3, 0.6],
    [0.4, 0.7],
    [0.5, 0.5],
  ] as const)
    await page.mouse.click(...at(x, y));
  await expect.poll(() => marks(page)).toBe(1);
  await page
    .locator('.capy-board-history button')
    .first()
    .dispatchEvent('click');
  await page.mouse.click(...at(0.55, 0.3));
  await page.mouse.click(...at(0.55, 0.3));
  await expect.poll(() => marks(page)).toBe(1);

  // A bar, filled, and a pie finished by clicking its centre.
  await page.getByRole('button', { name: 'Bars: drag up' }).click();
  await page.locator('.capy-plane-tools .fills button').nth(5).click();
  await page.mouse.move(...at(0.7, 0.6));
  await page.mouse.down();
  await page.mouse.move(...at(0.7, 0.3), { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => marks(page)).toBe(2);

  await page.getByRole('button', { name: 'Pie: click' }).click();
  await page.mouse.click(...at(0.2, 0.3));
  await page.mouse.click(...at(0.2, 0.15));
  await page.mouse.click(...at(0.28, 0.4));
  await page.mouse.click(...at(0.2, 0.3));
  await expect.poll(() => marks(page)).toBe(3);

  // The eraser takes one mark, and undo brings it back.
  await page.getByRole('button', { name: 'Erase a mark' }).click();
  await page.mouse.click(...at(0.7, 0.45));
  await expect.poll(() => marks(page)).toBe(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(3);

  // Escape does what Done does.
  await page.keyboard.press('Escape');
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(empty);

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => marks(page)).toBe(3);

  await page.mouse.dblclick(...card(0.5, 0.5));
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the eraser leaves the card, and scrolling over it moves the canvas', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('edgeless-eraser-tool-button').first().click();
  await page.mouse.move(...at(0.2, 0.5));
  await page.mouse.down();
  await page.mouse.move(...at(0.8, 0.5), { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['plane']);

  await page.keyboard.press('v');
  const [x, y] = at(0.5, 0.5);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 100);
  await expect
    .poll(async () => (await onCard(page))(0, 0)[1])
    .toBeLessThan(at(0, 0)[1]);
});

test('a formula that cannot be read stays open, and a root stops at its contents', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.locator('capy-maths-button').first().click();
  await page.getByRole('button', { name: 'Formula' }).click();
  const field = page.locator('.capy-formula math-field');
  await field.waitFor();
  await field.evaluate((element) => {
    (element as HTMLInputElement).value = '\\nosuchcommand{';
  });
  await page.locator('.capy-formula .primary').click();
  await expect(page.locator('.capy-formula-error')).toBeVisible();
  await expect(field).toBeVisible();
  await expect.poll(() => canvas(page)).toEqual(['plane']);

  await field.evaluate((element) => {
    (element as HTMLInputElement).value = '\\sqrt{x}+y';
  });
  await page.locator('.capy-formula .primary').click();
  await expect.poll(() => canvas(page)).toContain('formula');

  // Past the root's own width, the bitmap's top rows hold nothing.
  const inkAbove = await page.evaluate(async () => {
    const { drawing } = (await import(
      '/src/features/blocksuite/boardFormula.ts' as string
    )) as {
      drawing(latex: string): Promise<{ canvas: HTMLCanvasElement }>;
    };
    const { canvas: bitmap } = await drawing('\\sqrt{x}+y');
    const ctx = bitmap.getContext('2d');
    if (!ctx) throw new Error('no context');
    const from = Math.floor(bitmap.width * 0.7);
    const { data } = ctx.getImageData(
      from,
      0,
      bitmap.width - from,
      Math.floor(bitmap.height * 0.25)
    );
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 60) ink++;
    return ink;
  });
  expect(inkAbove).toBe(0);
});

test('a phone has undo at the top and the toolbar at full width', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 720, width: 360 });
  await openBoard(page);
  const undo = await page.locator('.capy-board-history').boundingBox();
  expect(undo?.y).toBeLessThan(60);
  expect(
    await page.locator('edgeless-toolbar-widget smooth-corner').boundingBox()
  ).toMatchObject({ width: 344, x: 8 });
});

test('the workspace canvas keeps its plane on reload', async ({ page }) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  const tab = page.getByRole('button', { name: 'Canvas' });
  await tab.waitFor();
  await tab.click();
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  const card = await onCard(page);
  await page.mouse.dblclick(...card(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.4, 0.4));
  await expect.poll(() => marks(page)).toBe(1);
  await page.keyboard.press('Escape');

  // Saved in this browser after a short wait, with no request.
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('capy.workspace.canvas.ws_bio'))
    )
    .not.toBeNull();
  await page.waitForTimeout(700);
  await page.reload();
  await tab.click();
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  await expect.poll(() => marks(page)).toBe(1);
});
