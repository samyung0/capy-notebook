import { expect, type Page, test } from '@playwright/test';

/**
 * The drawing answer's board on its dev route: BlockSuite's edgeless editor with a
 * coordinate plane card, canvas tools over it, the endless plane opened from the
 * card, and the image for marking.
 */

type Stats = { canvas: string[]; marks: number; span: number };
const STROKE_PATH = /<path d="([^"]*)" stroke="#e03131"/;
const WHOLE_PIXELS = /^M[\d LM]+$/;
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

/** Picks a piece out of a toolbar slot (a click lifts it) and drops it in the middle
 * of the board. */
async function placePiece(page: Page, slot: string, kind: string) {
  // The dev scenario panel sits over the toolbar's right end.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  // Misc's pieces are tiles in its panel, which its button opens.
  if (slot === 'capy-misc-panel')
    await page.locator('capy-misc-button').click();
  await page
    .locator(
      `${slot} ${slot === 'capy-misc-panel' ? '.tile' : '.piece'}[data-kind="${kind}"]`
    )
    .first()
    .click();
  const board = await page.locator('affine-edgeless-root').boundingBox();
  if (!board) throw new Error('no board');
  // Misc's panel covers the board's middle, and a drop on it puts nothing down.
  const middle = [
    board.x + board.width * (slot === 'capy-misc-panel' ? 0.25 : 0.5),
    board.y + board.height * 0.4,
  ] as const;
  await page.mouse.move(...middle, { steps: 6 });
  await page.mouse.click(...middle);
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

type Vec = [number, number];
/** A plane's marks' first points, in its units and on the page while it's open: the
 * editor opens at the card's scale with the card's middle in its own. */
async function planePoints(page: Page, polar = false) {
  const box = await page.locator('.capy-plane-editor').boundingBox();
  if (!box) throw new Error('no plane');
  const { centre, points, ppu } = await page.evaluate((wanted) => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        layer: {
          canvasElements: {
            h: number;
            marks: { at?: Vec; points?: Vec[] }[];
            polar: boolean;
            ppu: number;
            type: string;
            w: number;
            x0: number;
            y0: number;
          }[];
        };
      };
    };
    const card = root.gfx.layer.canvasElements.find(
      (element) => element.type === 'plane' && element.polar === wanted
    );
    if (!card) throw new Error('no plane');
    return {
      centre: [
        card.x0 + card.w / 2 / card.ppu,
        card.y0 - card.h / 2 / card.ppu,
      ],
      points: card.marks.map((mark) => mark.at ?? mark.points?.[0] ?? [0, 0]),
      ppu: card.ppu,
    };
  }, polar);
  return {
    points: points.map(([x, y]) => ({
      at: [x, y] as Vec,
      px: [
        box.x + box.width / 2 + (x - centre[0]) * ppu,
        box.y + box.height / 2 + (centre[1] - y) * ppu,
      ] as Vec,
    })),
    ppu,
  };
}

/** How much of an image falls in a band of red values, ink by default: an empty sheet
 * and a drawn one differ. */
const inkIn = (page: Page, dataUrl: string, band: [number, number] = [0, 60]) =>
  page.evaluate(
    async ([url, low, high]) => {
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
      for (let i = 0; i < data.length; i += 4)
        if (data[i] >= low && data[i] < high) dark++;
      return dark;
    },
    [dataUrl, ...band] as const
  );

/** The marking image, as a data URL. */
const toImage = (page: Page) =>
  page.evaluate(async () => {
    const board = (
      window as unknown as { __board: { toImage(): Promise<Blob> } }
    ).__board;
    const blob = await board.toImage();
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  });
const save = (page: Page) =>
  page.evaluate('window.__board.save().doc') as Promise<string>;

test('draws over the card and reopens from what it saved', async ({ page }) => {
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

  expect(errors).toEqual([]);

  // The stroke reaches the image.
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(before);

  const saved = await save(page);
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush']);
});

test('a note card takes typing and leaves $$ as text', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('edgeless-note-senior-button').first().click();
  await page.mouse.click(...at(0.5, 0.5));
  // The new note takes the focus a moment later on a loaded machine; keys
  // typed before then are lost.
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
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

test('the shapes panel draws an outline and places a preset that reopens', async ({
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
  // The preset's connector and group store no place, and the board still reopens.
  const placed = await canvas(page);
  const saved = await save(page);
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(placed);
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
  await page.locator('.capy-plane-editor .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Undo' }).click();
  await page.mouse.click(...at(0.55, 0.3));
  await expect(
    page.getByRole('button', { name: 'Finish curve' })
  ).toBeVisible();
  await page.mouse.click(...at(0.55, 0.3));
  await expect(page.getByRole('button', { name: 'Finish curve' })).toHaveCount(
    0
  );
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect.poll(() => marks(page)).toBe(1);

  // A point, then the eraser takes it, and undo brings it back.
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.7, 0.45));
  await expect.poll(() => marks(page)).toBe(2);
  await page.getByRole('button', { name: 'Erase a mark' }).click();
  // On the point where it snapped: the eraser reaches only as far as its ring.
  await page.mouse.click(...(await planePoints(page)).points[1].px);
  await expect.poll(() => marks(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(2);

  // With no mark open, Escape does what Done does.
  await page.keyboard.press('Escape');
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(empty);

  const saved = await save(page);
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
  // Undo sits in the open plane's ☰ menu; Escape closes the menu first.
  const planeMenu = page.locator('.capy-plane-editor .capy-menu');
  await planeMenu.getByRole('button', { name: 'More' }).click();
  await expect(
    planeMenu.getByRole('menuitem', { name: 'Undo' })
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(planeMenu.getByRole('menu')).toHaveCount(0);

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

  // Out again, undo carries on into the canvas; the board's ☰ menu stays open through
  // Undo and Redo.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => marks(page)).toBe(0);
  const boardMenu = page.locator('.capy-board-menu');
  await boardMenu.getByRole('button', { name: 'More' }).click();
  await boardMenu.getByRole('menuitem', { name: 'Undo' }).click();
  await expect.poll(() => canvas(page)).toEqual(['plane']);
  await boardMenu.getByRole('menuitem', { name: 'Redo' }).click();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush']);
});

test('in a plane, selected points move together, and the eraser takes what its ring covers', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.4, 0.4));
  await page.mouse.click(...at(0.6, 0.4));
  await expect.poll(() => marks(page)).toBe(2);

  // A box picks both; dragging one takes the other along.
  await page.getByRole('button', { name: 'Select' }).click();
  await page.mouse.move(...at(0.3, 0.3));
  await page.mouse.down();
  await page.mouse.move(...at(0.7, 0.5), { steps: 5 });
  await page.mouse.up();
  const [first, second] = (await planePoints(page)).points;
  await page.mouse.move(...first.px);
  await page.mouse.down();
  await page.mouse.move(first.px[0] + 80, first.px[1] - 80, { steps: 6 });
  await page.mouse.up();
  const [moved, along] = (await planePoints(page)).points;
  const [dx, dy] = [moved.at[0] - first.at[0], moved.at[1] - first.at[1]];
  expect(dx).toBeGreaterThan(0);
  expect(along.at[0] - second.at[0]).toBeCloseTo(dx);
  expect(along.at[1] - second.at[1]).toBeCloseTo(dy);

  // The eraser reaches as far as its ring, 8 px round the pointer.
  await page.getByRole('button', { name: 'Erase a mark' }).click();
  await page.mouse.click(moved.px[0] + 10, moved.px[1]);
  expect(await marks(page)).toBe(2);
  await page.mouse.click(moved.px[0] + 6, moved.px[1]);
  await expect.poll(() => marks(page)).toBe(1);

  // On a polar plane a point moved whole lands where a ring crosses a spoke.
  await page.getByRole('button', { name: 'Done' }).click();
  await placePiece(page, 'capy-graph-slot', 'polar');
  await page
    .locator('affine-toolbar-widget')
    .getByLabel('Edit the plane')
    .click();
  const polar = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...polar(0.6, 0.4));
  await expect
    .poll(async () => (await planePoints(page, true)).points)
    .toHaveLength(1);
  const {
    points: [placed],
    ppu,
  } = await planePoints(page, true);
  await page.getByRole('button', { name: 'Select' }).click();
  await page.mouse.move(...placed.px);
  await page.mouse.down();
  await page.mouse.move(placed.px[0] + 60, placed.px[1] + 40, { steps: 6 });
  await page.mouse.up();
  const [dropped] = (await planePoints(page, true)).points;
  expect(dropped.at).not.toEqual(placed.at);
  const step = await page.evaluate(async (scale) => {
    const { tickStep } = (await import(
      '/src/features/questions/graphTicks.ts' as string
    )) as { tickStep(ppu: number): number };
    const { minorStep } = (await import(
      '/src/features/blocksuite/boardGeometry.ts' as string
    )) as { minorStep(step: number): number };
    return minorStep(tickStep(scale));
  }, ppu);
  const rings = Math.hypot(...dropped.at) / step;
  const spokes =
    (Math.atan2(dropped.at[1], dropped.at[0]) * 180) / Math.PI / 15;
  expect(rings).toBeCloseTo(Math.round(rings), 6);
  expect(spokes).toBeCloseTo(Math.round(spokes), 6);
});

test('in a chart, Select moves several bars, or several lines, together', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const chart = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              bars: { value: number }[];
              spokes: number[];
              type: string;
            }[];
          };
        };
      };
      const { bars = [], spokes = [] } =
        root.gfx.layer.canvasElements.findLast(
          ({ type }) => type === 'chart'
        ) ?? {};
      return { spokes, values: bars.map(({ value }) => value) };
    });
  const toolbar = page.locator('affine-toolbar-widget');
  const select = page.getByRole('button', { name: 'Select' });

  await placePiece(page, 'capy-misc-panel', 'bar');
  await toolbar.getByLabel('Edit the chart').click();
  const at = await onPlane(page);
  const box = await page.locator('.capy-plane-editor').boundingBox();
  if (!box) throw new Error('no editor');
  const plotY = (value: number) =>
    (box.height - 128 - ((box.height - 192) * value) / 10) / box.height;
  await page.mouse.click(...at(0.2, plotY(3)));
  await page.mouse.click(...at(0.5, plotY(5)));
  await expect.poll(async () => (await chart()).values).toEqual([3, 5]);
  // A box over both, then the first dragged up by 3 takes the second along.
  await select.click();
  await page.mouse.move(...at(0.05, plotY(9.5)));
  await page.mouse.down();
  await page.mouse.move(...at(0.62, plotY(0.5)), { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(...at(0.2, plotY(1.5)));
  await page.mouse.down();
  await page.mouse.move(...at(0.2, plotY(6)), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await chart()).values).toEqual([6, 8]);
  await page.getByRole('button', { name: 'Done' }).click();

  // A pie's two lines, boxed, turn round together.
  await page.keyboard.press('v');
  await placePiece(page, 'capy-misc-panel', 'pie');
  await toolbar.getByLabel('Edit the chart').click();
  await page.mouse.click(...at(0.7, 0.5));
  await expect.poll(async () => (await chart()).spokes).toHaveLength(2);
  const before = (await chart()).spokes;
  const cx = box.x + box.width / 2;
  const cy = box.y + 64 + (box.height - 156) / 2;
  const r = Math.min(box.width - 32, box.height - 156) / 2;
  await select.click();
  await page.mouse.move(cx - 60, cy - r * 0.9);
  await page.mouse.down();
  await page.mouse.move(cx + r * 0.8, cy + 40, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(cx, cy - r / 2);
  await page.mouse.down();
  await page.mouse.move(
    cx + (r / 2) * Math.sin(Math.PI / 6),
    cy - (r / 2) * Math.cos(Math.PI / 6),
    {
      steps: 6,
    }
  );
  await page.mouse.up();
  await expect.poll(async () => (await chart()).spokes[0]).not.toBe(before[0]);
  const turned = (await chart()).spokes;
  expect(turned[0] - before[0]).toBeGreaterThan(20);
  expect(turned[1]).toBe(before[1] + turned[0] - before[0]);
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

  // A card's paper, half see-through on the screen, is opaque in the image, as in
  // previews: a black box under one doesn't show through as grey.
  await add(`{ ${prelude}
    gfx.surface.addElement({ type: 'shape', shapeType: 'rect', filled: true,
      fillColor: '#000000', strokeColor: '#000000',
      xywh: '[1000,300,300,200]' }); }`);
  const grey = await inkIn(page, await toImage(page), [100, 160]);
  await add(`{ ${prelude}
    gfx.surface.addElement({ type: 'plane', fit: false, marks: [], polar: false,
      ppu: 41, x0: 100, y0: 100, xywh: '[1000,300,300,200]' }); }`);
  expect(
    (await inkIn(page, await toImage(page), [100, 160])) - grey
  ).toBeLessThan(2000);

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

test('a pen stroke keeps its first points, and closing on its start leaves no dot', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('edgeless-pen-tool-button').first().click();
  // A circle that starts with steps inside the 2 px drag threshold and ends 1 px
  // from where it began.
  const [cx, cy] = at(0.5, 0.5);
  const radius = 60;
  await page.mouse.move(cx + radius, cy);
  await page.mouse.down();
  for (let step = 1; step <= 4; step++)
    await page.mouse.move(cx + radius, cy + step * 0.4);
  for (let step = 1; step <= 36; step++) {
    const angle = (step / 36) * 2 * Math.PI;
    await page.mouse.move(
      cx + radius * Math.cos(angle),
      cy + radius * Math.sin(angle)
    );
  }
  await page.mouse.move(cx + radius, cy - 1);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await canvas(page)).toEqual(['plane', 'brush']);
  const { first, zoom } = (await page.evaluate(`{
    const gfx = document.querySelector('affine-edgeless-root').gfx;
    const brush = gfx.layer.canvasElements.find((element) => element.type === 'brush');
    ({ first: brush.points.slice(0, 2), zoom: gfx.viewport.zoom });
  }`)) as { first: number[][]; zoom: number };
  const [[x0, y0], [x1, y1]] = first;
  expect(Math.hypot(x1 - x0, y1 - y0) * zoom).toBeLessThan(2);
});

test('the answer area is fitted, keeps its screen size, and stays out of the image', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.evaluate(
    "window.__mount({ answerArea: { label: 'Answer area' } })"
  );
  const chip = page.locator('.capy-answer-area');
  await expect(chip).toHaveText('Answer area');
  const boxes = () =>
    page.evaluate(() => {
      const box = (selector: string) => {
        const { bottom, height, left, top, width } = (
          document.querySelector(selector) as Element
        ).getBoundingClientRect();
        return { bottom, height, left, top, width };
      };
      return {
        area: box('.edgeless-background rect[stroke="#9aa0a6"]'),
        chip: box('.capy-answer-area'),
      };
    });
  const { area, chip: label } = await boxes();
  // Fitted: the box spans most of the window's width, its label on its corner.
  expect(area.width).toBeGreaterThan(page.viewportSize()!.width / 2);
  expect(area.left).toBeGreaterThan(0);
  expect(label.height).toBeCloseTo(20, 0);
  expect(label.bottom).toBeCloseTo(area.top, 0);
  expect(label.left).toBeCloseTo(area.left, 0);
  await page.evaluate(
    "document.querySelector('affine-edgeless-root').gfx.viewport.setZoom(2)"
  );
  await expect.poll(async () => (await boxes()).chip.height).toBeCloseTo(20, 0);
  // Only on screen: an empty board's span is the 820 × 520 default with its margin.
  expect((await stats(page)).span).toBe(836);
  await page.evaluate(
    "window.__mount({ answerArea: { label: 'Answer area' }, readOnly: true })"
  );
  await expect(page.locator('affine-edgeless-root')).toHaveCount(1);
  await expect(chip).toHaveCount(0);
});

test('a note scrolled out of view still reaches the image', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  // A dark note far to the right: BlockSuite hides a block out of view at no size.
  await page.evaluate(`{ const gfx = document.querySelector('affine-edgeless-root').gfx;
    const note = gfx.doc.addBlock('affine:note', { xywh: '[4000,0,400,300]',
      background: '#000000', index: gfx.layer.generateIndex() }, gfx.doc.root.id);
    gfx.doc.addBlock('affine:paragraph', {}, note); }`);
  expect(
    await page.evaluate(() =>
      document
        .querySelector('affine-edgeless-note')
        ?.classList.contains('block-idle')
    )
  ).toBe(true);
  // Note fills are half see-through (N2), so the black note is mid grey on white.
  expect(await inkIn(page, await toImage(page), [100, 160])).toBeGreaterThan(
    10_000
  );
  // Left as it was found.
  expect(
    await page.evaluate(() =>
      document
        .querySelector('affine-edgeless-note')
        ?.classList.contains('block-idle')
    )
  ).toBe(true);
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
  // Zoom out sits in the open plane's ☰ menu.
  const planeMenu = page.locator('.capy-plane-editor .capy-menu');
  await planeMenu.getByRole('button', { name: 'More' }).click();
  await planeMenu
    .getByRole('button', { exact: true, name: 'Zoom out' })
    .click();
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
  const charts = (kind: 'bar' | 'pie') =>
    placePiece(page, 'capy-misc-panel', kind);
  const toolbar = page.locator('affine-toolbar-widget');

  // A bar chart: three places to start from. A plane's Size isn't on its toolbar.
  await charts('bar');
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
  await page.locator('.capy-chart-editor .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Fit to screen' }).click();
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
  await charts('pie');
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

  const saved = await save(page);
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
  // The √x piece puts down its card and opens it to fill in.
  await placePiece(page, 'capy-formula-slot', 'sqrt');
  const field = page.locator('.capy-formula math-field');
  await field.waitFor();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'formula']);
  await field.evaluate((element) => {
    (element as HTMLInputElement).value = '\\nosuchcommand{';
  });
  await page.locator('.capy-formula .primary').click();
  await expect(page.locator('.capy-formula-error')).toBeVisible();
  await expect(field).toBeVisible();

  await field.evaluate((element) => {
    (element as HTMLInputElement).value = '\\sqrt{x}+y';
  });
  await page.locator('.capy-formula .primary').click();
  await expect.poll(() => canvas(page)).toContain('formula');

  // Past the root's own width, the bitmap's top rows hold nothing.
  const inkAbove = await page.evaluate(async () => {
    type Drawn = { h: number; w: number };
    const { drawing, replay } = (await import(
      '/src/features/blocksuite/boardFormulaDraw.ts' as string
    )) as {
      drawing(latex: string): Promise<Drawn>;
      replay(ctx: CanvasRenderingContext2D, drawn: Drawn): void;
    };
    // The laid-out formula, replayed at its own size.
    const drawn = await drawing('\\sqrt{x}+y');
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.ceil(drawn.w);
    bitmap.height = Math.ceil(drawn.h);
    const ctx = bitmap.getContext('2d');
    if (!ctx) throw new Error('no context');
    replay(ctx, drawn);
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

test('a phone has the menu at the top and the toolbar at full width', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 720, width: 360 });
  await openBoard(page);
  const menu = await page.locator('.capy-board-menu').boundingBox();
  expect(menu?.y).toBeLessThan(60);
  expect(
    await page.locator('edgeless-toolbar-widget smooth-corner').boundingBox()
  ).toMatchObject({ width: 344, x: 8 });

  // The open plane's nine tools fit their panel.
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const row = page.locator('.capy-plane-row');
  await expect(row.getByRole('button')).toHaveCount(9);
  expect(
    await row.evaluate((element) => element.scrollWidth - element.clientWidth)
  ).toBeLessThanOrEqual(0);
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
    // Undo is in the menu, which stays open for it, as for the zoom row.
    await page.locator('.capy-plane-editor .capy-menu-button').tap();
    for (const _ of [1, 2])
      await page.getByRole('menuitem', { name: 'Undo' }).tap();
    await expect.poll(() => marks(page)).toBe(0);
    await page.getByRole('button', { name: 'Done' }).tap();

    // The charts tool is past the toolbar's arrows, under the dev scenario panel here.
    await page.addStyleTag({
      content: '[data-testid="mock-scenario-panel"] { display: none; }',
    });
    await page.keyboard.press('Escape');
    // Two to a page on a phone: Note and Pen, Shapes and Graphs, Formulas and Misc.
    const next = page.locator('.senior-nav-button-wrapper.next icon-button');
    await next.tap();
    await expect(page.locator('capy-graph-slot')).toHaveCount(1);
    await next.tap();
    // A tap puts the bars in the middle of the view.
    await page.locator('capy-misc-button').tap();
    await page.locator('capy-misc-panel .tile[data-kind="bar"]').tap();
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
    const [long, short] = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return [
          Math.max(image.width, image.height),
          Math.min(image.width, image.height),
        ];
      },
      await toImage(page)
    );
    expect(long).toBeLessThanOrEqual(1568);
    // The far shape is drawn nearer, so the rest isn't squashed.
    expect(short).toBeGreaterThan(long / 4);
    // span is that drawn-nearer side in board units, not the 3,200 the board covers.
    const { span } = await stats(page);
    expect(span).toBeGreaterThan(820);
    expect(span).toBeLessThan(3000);
  });
});

/** Whether the workspace canvas's device copy in IndexedDB (src/lib/localDb.ts)
 * is the board as it is now. */
const copyIsCurrent = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        // The mocks keep their own database; their canvas is cv_<workspace>.
        const opened = indexedDB.open('capy-local-msw');
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const read = opened.result
            .transaction('drawingDrafts')
            .objectStore('drawingDrafts')
            .get('canvas:cv_ws_bio');
          read.onsuccess = () => {
            opened.result.close();
            const { __board: board } = window as unknown as {
              __board: { snapshot(): string };
            };
            resolve(read.result?.doc === board.snapshot());
          };
        };
      })
  );

test('the workspace canvas keeps its plane on reload', async ({ page }) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  const tab = page.getByRole('button', { name: 'Canvas' });
  await tab.waitFor();
  await tab.click();
  // The board mounts once the canvas and its stored board have loaded, and a
  // fresh canvas is empty: the Graphs tool places a plane card.
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await placePiece(page, 'capy-graph-slot', 'cart');
  await expect.poll(() => canvas(page)).toEqual(['plane']);
  const card = await onCard(page);
  await page.mouse.dblclick(...card(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...at(0.4, 0.4));
  await expect.poll(() => marks(page)).toBe(1);
  await page.keyboard.press('Escape');

  // Kept in this browser 400 ms after the last change, with no request; the
  // reload comes before the save 2 s after it (WorkspaceCanvas.tsx), which the
  // mocks would forget on reload.
  await expect.poll(() => copyIsCurrent(page), { intervals: [50] }).toBe(true);
  // The URL brings the tab back on its own.
  await page.reload();
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  await expect.poll(() => marks(page)).toBe(1);
});

test('an image pasted or picked on the workspace canvas is stored as its asset and opens from it', async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  const tab = page.getByRole('button', { name: 'Canvas' });
  await tab.waitFor();
  await tab.click();
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  type Images = { images(): { file?: Blob; id: string }[] };
  const imageIds = () =>
    page.evaluate(() =>
      (window as unknown as { __board: Images }).__board
        .images()
        .map(({ id }) => id)
    );
  // A paste on the board, as the clipboard hands an image over.
  await page.locator('.capy-board').click({ position: { x: 300, y: 200 } });
  await page.evaluate(async () => {
    const drawn = document.createElement('canvas');
    drawn.width = 320;
    drawn.height = 200;
    const context = drawn.getContext('2d');
    if (!context) throw new Error('no 2d canvas');
    context.fillStyle = '#2f7d56';
    context.fillRect(0, 0, 320, 200);
    const png = await new Promise<Blob | null>((resolve) =>
      drawn.toBlob(resolve, 'image/png')
    );
    if (!png) throw new Error('no image');
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
    document.querySelector('.capy-board editor-host')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
        composed: true,
      })
    );
  });
  // Uploaded at once as the canvas's image asset: its block keeps the asset's id.
  await expect.poll(imageIds).toEqual([expect.stringMatching(/^asset_mock_/)]);
  const [assetId] = await imageIds();
  // The save 2 s after names it, so the pruner keeps it.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          fetch('/api/workspaces/ws_bio/canvas')
            .then((response) => response.json())
            .then((canvas: { imageAssetIds: string[] }) => canvas.imageAssetIds)
        ),
      { timeout: 15_000 }
    )
    .toEqual([assetId]);
  // Opened again, the board has no file in hand: the image comes from its asset.
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await tab.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector<HTMLImageElement>('affine-edgeless-image img')
            ?.naturalWidth ?? 0
      )
    )
    .toBe(320);
  expect(await imageIds()).toEqual([assetId]);

  // Misc's Image tile picks a file from the device, for a phone with no paste
  // or drop: it lands and is stored the same way.
  const png = await page.evaluate(() => {
    const drawn = document.createElement('canvas');
    drawn.width = 120;
    drawn.height = 80;
    drawn.getContext('2d')?.fillRect(0, 0, 120, 80);
    return drawn.toDataURL('image/png').split(',')[1];
  });
  await page.locator('capy-misc-button').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('capy-misc-panel [data-pick="image"]').click();
  await (await chooser).setFiles({
    buffer: Buffer.from(png, 'base64'),
    mimeType: 'image/png',
    name: 'picked.png',
  });
  await expect
    .poll(imageIds)
    .toEqual([assetId, expect.stringMatching(/^asset_mock_/)]);
});

test("the Canvas page is a board of the person's own, and its panel lists and makes canvases", async ({
  page,
}) => {
  test.slow();
  // A workspace's canvas exists once its tab was opened.
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { name: 'Canvas' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  // The account's page, reached within the app: the mocks forget on a reload.
  await page.evaluate(() => {
    history.pushState({}, '', '/canvas');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  // With none of their own yet, a first one is made and named in the URL.
  await expect(page).toHaveURL(/\/canvas\?c=cv_own_1$/);
  await expect(page.locator('.capy-board')).toHaveCount(1);
  const panel = page.getByRole('button', { name: 'My canvas' });
  await panel.click();
  // Every canvas there is: their own, then the workspace's under its name.
  await expect(page.getByRole('menuitem', { name: /My canvas/ })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: /Biology 101/ })
  ).toBeVisible();
  await page.getByRole('menuitem', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/\/canvas\?c=cv_own_2$/);
  await expect(
    page.getByRole('button', { name: 'Untitled canvas' })
  ).toBeVisible();
  // Rename starts from the shown canvas's own name, and the panel takes the new one.
  await page.getByRole('button', { name: 'Untitled canvas' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const name = page.getByRole('textbox');
  await expect(name).toHaveValue('Untitled canvas');
  await name.fill('Exam plan');
  await name.press('Enter');
  // A workspace's canvas opens in its workspace.
  await page.getByRole('button', { name: 'Exam plan' }).click();
  await page.getByRole('menuitem', { name: /Biology 101/ }).click();
  await expect(page).toHaveURL(/\/workspaces\/ws_bio\?panel=canvas/);
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

  // An iPad keeps the rail, and the menu sits top right, clear of the toolbar.
  const rail = page.getByRole('navigation', { name: 'Workspace' });
  await page.setViewportSize({ height: 800, width: 900 });
  await expect(rail).toBeVisible();
  await expect(board).toBeVisible();
  const boardBox = await board.boundingBox();
  const menuBox = await page.locator('.capy-board-menu').boundingBox();
  expect(menuBox && boardBox && menuBox.y - boardBox.y).toBe(8);

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

test('a saved board leaves its undo history out, and a teacher opens it read-only', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  // 200 points plotted one undo step at a time, as clicks on the plane add them.
  await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        doc: { captureSync(): void };
        layer: { canvasElements: { marks: object[] }[] };
      };
    };
    const [card] = root.gfx.layer.canvasElements;
    for (let i = 0; i < 200; i++) {
      root.gfx.doc.captureSync();
      card.marks = [
        ...card.marks,
        { at: [i / 10, i / 20], id: `m${i}`, kind: 'dot' },
      ];
    }
  });
  const live = (await stats(page)) as Stats & { bytes: number };
  const { bytes, doc } = (await page.evaluate('window.__board.save()')) as {
    bytes: number;
    doc: string;
  };
  expect(bytes).toBeLessThan(live.bytes / 4);

  // Room for a question card pinned over the board's top left.
  await page.evaluate(
    `window.__reopen(${JSON.stringify(doc)}, true, [16, 16, 16, 372])`
  );
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  // A teacher's menu zooms but has no undo.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await expect(page.getByRole('menuitem', { name: 'Undo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('edgeless-toolbar-widget')).toHaveCount(0);
  const board = await page.locator('.capy-board').boundingBox();
  const card = (await onCard(page))(0, 0);
  expect(board && card[0] - board.x).toBeGreaterThanOrEqual(371);
  const at = await onCard(page);
  await page.mouse.dblclick(...at(0.5, 0.5));
  await expect(page.locator('.capy-plane-editor')).toHaveCount(0);
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(0);

  // The board's styles leave the app's own truncate alone.
  const alignSelf = await page.evaluate(() => {
    const row = document.createElement('div');
    row.className = 'flex items-center';
    row.innerHTML = '<span class="truncate">x</span>';
    document.body.append(row);
    const value = getComputedStyle(row.firstElementChild as Element).alignSelf;
    row.remove();
    return value;
  });
  expect(alignSelf).not.toBe('stretch');

  // What isn't a board says so, and mounts nothing.
  const error = await page.evaluate(() => {
    try {
      (window as unknown as { __reopen(saved: string): void }).__reopen('AAAA');
      return null;
    } catch (thrown) {
      return (thrown as Error).name;
    }
  });
  expect(error).toBe('BoardLoadError');
});

test('a preview draws every kind on the board from its data, framed as the image', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.evaluate(() => {
    type Model = { deserializedXYWH: number[]; marks: unknown[]; type: string };
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        layer: { canvasElements: Model[] };
        surface: { addElement(props: Record<string, unknown>): string };
      };
      std: {
        store: {
          addBlock(
            flavour: string,
            props: Record<string, unknown>,
            parent: string
          ): string;
          getModelById(id: string): {
            text: { insert(text: string, at: number): void };
          };
          root: { id: string };
          spaceDoc: { getText(name: string): object };
        };
      };
    };
    const { gfx, std } = root;
    const { store } = std;
    // A free Y.Text of the board's own Yjs, as the tools give shapes and text.
    const YText = store.spaceDoc.getText('preview-spec')
      .constructor as new () => {
      insert(at: number, text: string): void;
    };
    const text = (value: string) => {
      const y = new YText();
      y.insert(0, value);
      return y;
    };
    const add = (props: Record<string, unknown>) =>
      gfx.surface.addElement(props);
    const plane = gfx.layer.canvasElements.find(
      ({ type }) => type === 'plane'
    ) as Model;
    plane.marks = [
      { at: [2, 3], id: 'a', kind: 'dot' },
      {
        id: 'b',
        kind: 'line',
        points: [
          [-1, -1],
          [4, 2],
        ],
      },
      {
        id: 'c',
        kind: 'curve',
        points: [
          [0, 0],
          [1, 2],
          [3, 1],
          [5, 4],
        ],
      },
    ];
    const [x, y, w, h] = plane.deserializedXYWH;
    add({
      color: '#e03131',
      lineWidth: 4,
      points: Array.from({ length: 40 }, (_, i) => [
        i * 6,
        30 + Math.sin(i / 4) * 25,
      ]),
      type: 'brush',
      xywh: `[${x},${y + h + 40},250,70]`,
    });
    const box = add({
      fillColor: '#ffe066',
      filled: true,
      shapeType: 'rect',
      strokeColor: '#000000',
      strokeWidth: 2,
      text: text('Force'),
      type: 'shape',
      xywh: `[${x + w + 60},${y},160,90]`,
    });
    const ring = add({
      fillColor: 'transparent',
      filled: false,
      shapeType: 'ellipse',
      strokeColor: '#1971c2',
      strokeWidth: 2,
      type: 'shape',
      xywh: `[${x + w + 60},${y + 250},160,100]`,
    });
    add({
      source: { id: box, position: [0.5, 1] },
      stroke: '#000000',
      strokeWidth: 2,
      target: { id: ring, position: [0.5, 0] },
      type: 'connector',
    });
    add({
      color: '#000000',
      fontSize: 20,
      text: text('mass = 2 kg\nv = 3 m/s'),
      textAlign: 'left',
      type: 'text',
      xywh: `[${x + w + 60},${y + 400},220,60]`,
    });
    add({
      latex: '\\frac{1}{2}mv^2',
      type: 'formula',
      xywh: `[${x + 300},${y + h + 40},200,60]`,
    });
    add({
      axisMax: 10,
      axisStep: 2,
      bars: [
        { fill: '#4dabf7', id: '1', label: 'A', value: 4 },
        { fill: '#ff8787', id: '2', label: 'B', value: 7 },
      ],
      kind: 'bar',
      labels: [],
      spokes: [],
      type: 'chart',
      xywh: `[${x},${y + h + 160},360,240]`,
    });
    add({
      axisMax: 10,
      axisStep: 2,
      bars: [],
      kind: 'pie',
      labels: [],
      spokes: [0, 120, 200],
      type: 'chart',
      xywh: `[${x + 400},${y + h + 160},240,240]`,
    });
    const note = store.addBlock(
      'affine:note',
      { xywh: `[${x + 520},${y + 40},260,90]` },
      store.root.id
    );
    const paragraph = store.addBlock('affine:paragraph', {}, note);
    store.getModelById(paragraph).text.insert('Energy is kept', 0);
  });
  const doc = await save(page);
  const preview = (await page.evaluate(
    ([saved]) =>
      (
        window as unknown as {
          __preview(
            saved: string,
            size: { height: number; width: number }
          ): string;
        }
      ).__preview(saved, { height: 400, width: 600 }),
    [doc]
  )) as string;
  // The note shares its place in the stack with the card under it, and goes over it.
  expect(preview.indexOf('Energy is kept')).toBeGreaterThan(
    preview.indexOf('stroke="#dededb"')
  );
  for (const part of [
    'stroke="#e03131"', // the brush
    'fill="#ffe066"', // the filled box
    '<ellipse',
    'Force',
    'mass = 2 kg',
    '\\frac{1}{2}mv^2',
    'fill="#4dabf7"', // a bar
    '<circle', // the pie
    'Energy is kept',
  ])
    expect(preview).toContain(part);
  // Saved to whole pixels: the stroke, drawn through fractions, has none left.
  const stroke = preview.match(STROKE_PATH)?.[1] ?? '';
  expect(stroke).toMatch(WHOLE_PIXELS);
  // Well formed: a list shows it as an image.
  const drawn = await page.evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    return [image.width, image.height];
  }, preview);
  expect(drawn).toEqual([600, 400]);
  expect(
    await page.evaluate(
      ([saved]) => {
        try {
          (
            window as unknown as {
              __preview(saved: string, size: object): string;
            }
          ).__preview(saved, { height: 10, width: 10 });
        } catch (error) {
          return (error as Error).name;
        }
        return 'drawn';
      },
      ['AAAA']
    )
  ).toBe('BoardLoadError');
});
