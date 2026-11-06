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
  await page.getByRole('button', { exact: true, name: 'Label' }).click();
  await page.mouse.click(...at(0.7, 0.3));
  await page.keyboard.type('label');
  // A blank line in a label is one line tall.
  await page.keyboard.press('Enter');
  const blank = page.locator('edgeless-text-editor v-line').nth(1);
  expect((await blank.boundingBox())?.height).toBeLessThan(60);
  await page.keyboard.press('Backspace');
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

  // Selected, it has its height button, and nothing about a page mode.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const { gfx } = document.querySelector(
      'affine-edgeless-root'
    ) as unknown as {
      gfx: {
        layer: { blocks: { id: string }[] };
        selection: { set(selection: object): void };
      };
    };
    gfx.selection.set({ editing: false, elements: [gfx.layer.blocks[0].id] });
  });
  const toolbar = page.locator('affine-toolbar-widget');
  await expect(toolbar.getByLabel('Size', { exact: true })).toBeVisible();
  await expect(toolbar.getByText('Display in Page')).toHaveCount(0);
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

  // A right click plots nothing.
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.5, 0.5), { button: 'right' });
  await expect.poll(() => marks(page)).toBe(0);

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
  await expect(
    page.getByRole('button', { name: 'Finish curve' })
  ).toBeVisible();
  await page.mouse.click(...at(0.55, 0.3));
  await expect(page.getByRole('button', { name: 'Finish curve' })).toHaveCount(
    0
  );
  await expect(
    page.getByRole('button', { name: 'Move the plane' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => marks(page)).toBe(1);

  // A point, then the eraser takes it, and undo brings it back.
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.7, 0.45));
  await expect.poll(() => marks(page)).toBe(2);
  await page.getByRole('button', { name: 'Erase a mark' }).click();
  await page.mouse.click(...at(0.7, 0.45));
  await expect.poll(() => marks(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(2);

  // With no mark open, Escape does what Done does.
  await page.keyboard.press('Escape');
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(empty);

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => marks(page)).toBe(2);

  await page.mouse.dblclick(...card(0.5, 0.5));
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Escape ends the open mark first, and a mark with one point goes', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const card = await onCard(page);
  await page.mouse.dblclick(...card(0.5, 0.5));
  const at = await onPlane(page);
  const curve = page.getByRole('button', { name: 'Curve through points' });

  await curve.click();
  await page.mouse.click(...at(0.3, 0.6));
  await page.mouse.click(...at(0.4, 0.4));
  await page.keyboard.press('Escape');
  await expect(page.locator('.capy-plane-editor')).toBeVisible();
  await expect.poll(() => marks(page)).toBe(1);

  await curve.click();
  await page.mouse.click(...at(0.6, 0.6));
  await expect.poll(() => marks(page)).toBe(2);
  await page.getByRole('button', { name: 'Finish curve' }).click();
  await expect.poll(() => marks(page)).toBe(1);

  await curve.click();
  await page.mouse.click(...at(0.6, 0.6));
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  await expect.poll(() => marks(page)).toBe(1);
});

test('undo inside the plane stops at what was done there', async ({ page }) => {
  test.slow();
  await openBoard(page);
  const card = await onCard(page);
  await page.locator('edgeless-pen-tool-button').first().click();
  await page.mouse.move(...card(0.1, 0.2));
  await page.mouse.down();
  await page.mouse.move(...card(0.3, 0.4), { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush']);

  await page.keyboard.press('v');
  await page.mouse.move(...card(0.5, 0.5));
  await page.mouse.dblclick(...card(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.4, 0.4));
  await expect.poll(() => marks(page)).toBe(1);

  for (const _ of [1, 2, 3]) await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(0);
  expect(await canvas(page)).toEqual(['plane', 'brush']);
  await expect(
    page.getByRole('button', { name: 'Undo' }).first()
  ).toBeDisabled();

  // Both redo keys, whatever the Shift key does to the letter.
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => marks(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => marks(page)).toBe(1);

  // A height change alone redraws at the new size.
  const size = page.viewportSize();
  if (!size) throw new Error('no viewport');
  await page.setViewportSize({ height: size.height - 120, width: size.width });
  await expect
    .poll(() =>
      page
        .locator('.capy-plane-editor canvas')
        .evaluate(
          (element) =>
            (element as HTMLCanvasElement).height /
            (window.devicePixelRatio * element.getBoundingClientRect().height)
        )
    )
    .toBeCloseTo(1, 1);

  // Out again, undo carries on into the canvas.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => canvas(page)).toEqual(['plane']);
});

test("selecting shows AFFiNE's toolbar, and a card keeps a real size", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const at = await onCard(page);
  await page.mouse.click(...at(0.5, 0.5));
  const toolbar = page.locator('affine-toolbar-widget');
  await expect(toolbar.getByLabel('Connect')).toBeVisible();
  await toolbar.getByLabel('More', { exact: true }).click();
  await expect(toolbar.getByText('Duplicate')).toBeVisible();
  await expect(toolbar.getByText('linked doc')).toHaveCount(0);
  await expect(toolbar.getByText('Frame section')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Its bottom right corner, dragged past the top left.
  await page.mouse.click(...at(0.5, 0.5));
  await page.mouse.move(...at(1, 1));
  await page.mouse.down();
  await page.mouse.move(...at(-0.2, -0.2), { steps: 8 });
  await page.mouse.up();
  const size = await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        layer: {
          canvasElements: { h: number; type: string; w: number }[];
        };
      };
    };
    const card = root.gfx.layer.canvasElements.find(
      ({ type }) => type === 'plane'
    );
    return [card?.w, card?.h];
  });
  expect(size[0]).toBeGreaterThanOrEqual(120);
  expect(size[1]).toBeGreaterThanOrEqual(80);
  expect(errors).toEqual([]);
});

test('the image stacks as the screen does, and many formulas settle', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const add = (script: string) => page.evaluate(script);
  const prelude = `const root = document.querySelector('affine-edgeless-root');
    const gfx = root.gfx;`;

  await add(`{ ${prelude}
    gfx.surface.addElement({ type: 'shape', shapeType: 'rect', filled: true,
      fillColor: '#000000', strokeColor: '#000000',
      xywh: '[1000,0,300,200]' }); }`);
  const seen = await inkIn(page, await toImage(page));
  await add(`{ ${prelude}
    const note = gfx.doc.addBlock('affine:note', { xywh: '[980,-20,340,240]',
      index: gfx.layer.generateIndex() }, gfx.doc.root.id);
    gfx.doc.addBlock('affine:paragraph', {}, note); }`);
  await expect
    .poll(async () => inkIn(page, await toImage(page)))
    .toBeLessThan(seen * 0.8);

  // More formulas than used to be kept: they all draw, then the board rests.
  await add(`{ ${prelude}
    for (let i = 0; i < 70; i++)
      gfx.surface.addElement({ type: 'formula', latex: 'x_{' + i + '}',
        xywh: '[' + (i * 40) + ',600,36,36]' }); }`);
  const image = await toImage(page);
  const refreshes = await page.evaluate(async () => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: { surfaceComponent: { renderer: { refresh(): void } } };
    };
    const { renderer } = root.gfx.surfaceComponent;
    const original = renderer.refresh;
    let count = 0;
    renderer.refresh = function refresh() {
      count++;
      original.call(renderer);
    };
    await new Promise((resolve) => setTimeout(resolve, 1500));
    renderer.refresh = original;
    return count;
  });
  expect(refreshes).toBeLessThan(5);
  expect(await inkIn(page, image)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a plane card has its pen and size, and fits its marks', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  const cardSize = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: { type: string; w: number }[];
          };
        };
      };
      return root.gfx.layer.canvasElements.find(({ type }) => type === 'plane')
        ?.w;
    });
  const before = (await cardSize()) ?? 0;
  await page.mouse.click(...at(0.5, 0.5));
  const toolbar = page.locator('affine-toolbar-widget');
  await expect(toolbar.locator('.label', { hasText: 'Connect' })).toBeVisible();
  await toolbar.getByLabel('Edit the plane').click();
  await expect(page.locator('.capy-plane-editor')).toBeVisible();

  // Plotted past the card's right edge, zoomed out so it's on the screen.
  const inside = await onPlane(page);
  // The dev scenario panel covers the zoom buttons here.
  await page
    .getByRole('button', { exact: true, name: 'Zoom out' })
    .dispatchEvent('click');
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...inside(0.95, 0.5));
  await expect.poll(() => marks(page)).toBe(1);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(cardSize).not.toBe(before);

  // The toggle, and a corner drag, make it custom.
  await expect(
    toolbar.locator('.label', { hasText: 'Fit to size' })
  ).toBeVisible();
  await toolbar.locator('.label', { hasText: 'Fit to size' }).click();
  await expect(
    toolbar.locator('.label', { hasText: 'Custom size' })
  ).toBeVisible();
  await toolbar.locator('.label', { hasText: 'Custom size' }).click();
  await expect(
    toolbar.locator('.label', { hasText: 'Fit to size' })
  ).toBeVisible();
  const after = await onCard(page);
  await page.mouse.move(...after(1, 1));
  await page.mouse.down();
  await page.mouse.move(...after(0.8, 0.8), { steps: 6 });
  await page.mouse.up();
  await expect(
    toolbar.locator('.label', { hasText: 'Custom size' })
  ).toBeVisible();
});

test('bar and pie charts are their own cards, with no coordinates', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const chart = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              axisMax: number;
              bars: { label: string; value: number }[];
              labels: { text: string }[];
              spokes: number[];
              type: string;
            }[];
          };
        };
      };
      const { axisMax, bars, labels, spokes } =
        root.gfx.layer.canvasElements.findLast(
          ({ type }) => type === 'chart'
        ) ?? {};
      return {
        axisMax,
        labels: labels?.map(({ text }) => text),
        spokes: spokes?.length,
        values: bars?.map(({ value }) => value),
        words: bars?.map(({ label }) => label),
      };
    });
  const charts = async (name: string) => {
    await page.locator('capy-charts-button').first().click();
    await page.getByRole('button', { exact: true, name }).click();
  };
  const toolbar = page.locator('affine-toolbar-widget');

  // A bar chart: three places to start from. A plane's Size isn't on its toolbar.
  await charts('Bar chart');
  await expect(toolbar.getByLabel('Edit the chart')).toBeVisible();
  await expect(
    toolbar.locator('.label', { hasText: 'Fit to size' })
  ).toHaveCount(0);
  await toolbar.getByLabel('Edit the chart').click();
  const at = await onPlane(page);
  const box = await page.locator('.capy-plane-editor').boundingBox();
  if (!box) throw new Error('no editor');
  const plotY = (value: number) =>
    (box.height - 128 - ((box.height - 192) * value) / 10) / box.height;
  await page.mouse.move(...at(0.2, plotY(1)));
  await page.mouse.down();
  await page.mouse.move(...at(0.2, plotY(8)), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await chart()).values).toEqual([8]);

  // A second bar in the free place, then the first made shorter.
  await page.mouse.click(...at(0.5, plotY(5)));
  await expect.poll(async () => (await chart()).values).toEqual([8, 5]);
  await page.mouse.click(...at(0.15, plotY(3)));
  await expect.poll(async () => (await chart()).values).toEqual([3, 5]);

  // Fit brings the axis to the tallest, and a typed one holds.
  await page.getByRole('button', { name: 'Fit' }).click();
  await expect.poll(async () => (await chart()).axisMax).toBe(6);
  const axis = page.getByRole('textbox', { name: 'Axis to' });
  await axis.fill('10');
  await axis.press('Enter');
  await expect.poll(async () => (await chart()).axisMax).toBe(10);

  // A label under a bar; Escape stays in the chart while one is being typed.
  await page.getByRole('button', { name: 'Type a label' }).click();
  await page.mouse.click(...at(0.15, plotY(1)));
  const label = page.locator('.capy-chart-label');
  await label.fill('Maths');
  await label.press('Enter');
  await expect.poll(async () => (await chart()).words).toEqual(['Maths', '']);

  await page.getByRole('button', { name: 'Erase a mark' }).click();
  await page.mouse.click(...at(0.5, plotY(1)));
  await expect.poll(async () => (await chart()).values).toEqual([3]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);

  // A pie: a line at each click, a label, and the eraser.
  await page.keyboard.press('v');
  await charts('Pie chart');
  await toolbar.getByLabel('Edit the chart').click();
  await page.mouse.click(...at(0.7, 0.5));
  await expect.poll(async () => (await chart()).spokes).toBe(2);
  await page.getByRole('button', { name: 'Type a label' }).click();
  await page.mouse.click(...at(0.55, 0.3));
  await page.locator('.capy-chart-label').fill('Science');
  await page.locator('.capy-chart-label').press('Enter');
  await expect.poll(async () => (await chart()).labels).toEqual(['Science']);
  await page.getByRole('button', { name: 'Erase a mark' }).click();
  await page.mouse.click(...at(0.7, 0.5));
  await expect.poll(async () => (await chart()).spokes).toBe(1);
  await page.getByRole('button', { name: 'Done' }).click();

  const saved = (await page.evaluate('window.__board.save()')) as string;
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(async () => (await chart()).labels).toEqual(['Science']);
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
  await page.locator('capy-formula-button').first().click();
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

test.describe('with a finger', () => {
  test.use({ deviceScaleFactor: 3, hasTouch: true, isMobile: true });

  test('a double tap opens the plane, and a big board still makes an image', async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ height: 800, width: 390 });
    await openBoard(page);
    const card = await onCard(page);
    await page.touchscreen.tap(...card(0.5, 0.5));
    await expect(
      page.locator('affine-toolbar-widget').getByLabel('Connect')
    ).toBeVisible();
    await page.waitForTimeout(600);
    await page.touchscreen.tap(...card(0.5, 0.5));
    await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
    await page.waitForTimeout(100);
    await page.touchscreen.tap(...card(0.52, 0.51));
    await expect(page.locator('.capy-plane-editor')).toBeVisible();

    // Plotted by tapping, ended by the button, undone by the real one over the plane.
    const at = await onPlane(page);
    // The dev scenario panel covers the tool row here.
    await page
      .getByRole('button', { name: 'Curve through points' })
      .dispatchEvent('click');
    await page.touchscreen.tap(...at(0.3, 0.4));
    await page.touchscreen.tap(...at(0.6, 0.5));
    await page.getByRole('button', { name: 'Finish curve' }).tap();
    await expect.poll(() => marks(page)).toBe(1);
    const undo = page.locator('.capy-board-history button').first();
    await undo.tap();
    await undo.tap();
    await expect.poll(() => marks(page)).toBe(0);
    await page.getByRole('button', { name: 'Done' }).tap();

    // The charts tool is past the toolbar's arrows, under the dev scenario panel here.
    await page.addStyleTag({
      content: '[data-testid="mock-scenario-panel"] { display: none; }',
    });
    await page.keyboard.press('Escape');
    // Two to a page on a phone: Note and Pen, Shapes and Maths, Charts and Formula.
    const next = page.locator('.senior-nav-button-wrapper.next icon-button');
    await next.tap();
    await expect(page.locator('capy-maths-button')).toHaveCount(1);
    await next.tap();
    await page.locator('capy-charts-button').first().tap();
    await page.getByRole('button', { exact: true, name: 'Bar chart' }).tap();
    await page
      .locator('affine-toolbar-widget')
      .getByLabel('Edit the chart')
      .tap();
    await expect(page.locator('.capy-chart-axis')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).tap();

    // Past what a phone's canvas takes at the device's scale.
    await page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: { surface: { addElement(props: object): string } };
      };
      root.gfx.surface.addElement({
        shapeType: 'rect',
        type: 'shape',
        xywh: '[3000,3000,200,200]',
      });
    });
    const size = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return Math.max(image.width, image.height);
      },
      await toImage(page)
    );
    expect(size).toBeLessThanOrEqual(2400);
  });
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
  // The URL brings the tab back on its own.
  await page.reload();
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  await expect.poll(() => marks(page)).toBe(1);
});

test('the workspace canvas stays in the URL at every width', async ({
  page,
}) => {
  test.slow();
  // Pressed with a page open in the centre, it takes that page's place in the URL.
  await page.goto('/workspaces/ws_bio?study=practice');
  await page.getByRole('button', { name: 'Canvas' }).click();
  await expect(page).toHaveURL(/panel=canvas/);
  await expect(page).not.toHaveURL(/study=/);
  const board = page.locator('.capy-board');
  await board.waitFor();

  // An iPad keeps the rail, with undo over the toolbar's end no more: top right.
  const rail = page.getByRole('navigation', { name: 'Workspace' });
  await page.setViewportSize({ height: 800, width: 900 });
  await expect(rail).toBeVisible();
  await expect(board).toBeVisible();
  const boardBox = await board.boundingBox();
  const undoBox = await page.locator('.capy-board-history').boundingBox();
  expect(undoBox && boardBox && undoBox.y - boardBox.y).toBe(8);

  // Below the rail the board stays, and only the back button leaves it.
  await page.setViewportSize({ height: 800, width: 700 });
  await expect(rail).toHaveCount(0);
  await expect(page).toHaveURL(/panel=canvas/);
  await expect(board).toBeVisible();
  await page.reload();
  // A reload loads the board's chunk again, which is slow on the dev server.
  await expect(board).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Dashboard' }).first().click();
  await expect(board).toHaveCount(0);
  await expect(page).not.toHaveURL(/panel=canvas/);

  // The browser's back returns to it, and a wide window keeps it.
  await page.goBack();
  await expect(board).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ height: 800, width: 1400 });
  await expect(board).toBeVisible();
  await expect(page).toHaveURL(/panel=canvas/);

  // Another section leaves it, and Back returns.
  await page.getByRole('button', { name: 'Files' }).first().click();
  await expect(board).toHaveCount(0);
  await expect(page).toHaveURL(/panel=files/);
  await page.goBack();
  await expect(board).toBeVisible({ timeout: 30_000 });
});
