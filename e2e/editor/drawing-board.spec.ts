import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The drawing answer's board on its dev route: BlockSuite's edgeless editor with a
 * coordinate plane card, canvas tools over it, the endless plane opened from the
 * card, and the image for marking.
 */

type Stats = { canvas: string[]; marks: number };
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

/** An open plane's editor: the graph editor over the board. */
const planeEditor = (page: Page) => page.locator('.capy-graph-editor');

/** Opens the open plane's ☰ menu; its entries are buttons. */
async function planeMenu(page: Page) {
  await planeEditor(page)
    .getByRole('button', { exact: true, name: 'More' })
    .click();
  return page.getByRole('dialog');
}

/** A point on the open plane or chart, from 0 to 1 across the screen. */
async function onPlane(page: Page) {
  const box = await page
    .locator('.capy-graph-editor, .capy-plane-editor')
    .boundingBox();
  if (!box) throw new Error('no plane');
  return (x: number, y: number) =>
    [box.x + x * box.width, box.y + y * box.height] as const;
}

type Vec = [number, number];
/** A plane's marks' first points, in its units and on the page while it's open: the
 * editor opens at the card's scale with the card's middle in its own. */
async function planePoints(page: Page, polar = false) {
  const box = await planeEditor(page).boundingBox();
  if (!box) throw new Error('no plane');
  const { centre, points, ppu } = await page.evaluate((wanted) => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        layer: {
          canvasElements: {
            h: number;
            elementList: {
              center?: Vec;
              coords?: Vec | Vec[];
              radii?: Vec;
            }[];
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
      // Each mark's first point; an ellipse's is its right handle.
      points: card.elementList.map(({ center, coords, radii }): Vec => {
        if (center && radii) return [center[0] + radii[0], center[1]];
        if (Array.isArray(coords?.[0])) return coords[0] as Vec;
        return (coords as Vec | undefined) ?? [0, 0];
      }),
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
/** The marking image's width and height in pixels. */
const imageSize = async (page: Page) =>
  page.evaluate(
    async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.width, image.height];
    },
    await toImage(page)
  );

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
  await page.locator('capy-note-button').first().click();
  await expect(page.locator('edgeless-note-menu')).toBeVisible();
  await expect(page.locator('edgeless-note-menu .divider')).toHaveCount(0);

  expect(errors).toEqual([]);

  // The stroke reaches the image.
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(before);

  const saved = await save(page);
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(['plane', 'brush']);
});

test('a note takes typing, leaves $$ as text and turns from inline to a card and back', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const at = await onCard(page);
  // The button opens the menu only; a pick there holds the note.
  await page.locator('capy-note-button').first().click();
  await page
    .locator('edgeless-note-menu edgeless-tool-icon-button')
    .first()
    .click();
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

  // Selected, it has nothing about a page mode.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const { gfx } = document.querySelector(
      'affine-edgeless-root'
    ) as unknown as {
      gfx: {
        layer: { blocks: { id: string }[] };
        selection: { clear(): void; set(selection: object): void };
      };
    };
    gfx.selection.set({ editing: false, elements: [gfx.layer.blocks[0].id] });
  });
  const toolbar = page.locator('affine-toolbar-widget');
  await expect(toolbar.getByText('Display in Page')).toHaveCount(0);

  // It starts inline (Epo 2026-11-13); the toolbar's Inline makes it a card, and
  // the style panel's Inline | Card switch makes it inline again.
  const container = page.locator('.affine-note-container');
  await expect(container).toHaveAttribute('data-inline', 'true');
  // As wide and tall as its one line of text, not AFFiNE's 498 wide note.
  const [width, height] = await page.evaluate(() => {
    const note = document.querySelector('affine-edgeless-note') as unknown as {
      model: { props: { xywh: string } };
    };
    return JSON.parse(note.model.props.xywh).slice(2) as number[];
  });
  expect(width).toBeLessThan(200);
  expect(height).toBeLessThan(30);
  // Style is a card's; no note has Size, as no note has a custom height.
  await expect(toolbar.getByLabel('Note Style')).toHaveCount(0);
  await expect(toolbar.getByLabel('Size', { exact: true })).toHaveCount(0);
  await toolbar.getByLabel('Inline', { exact: true }).click();
  await expect(container).toHaveAttribute('data-inline', 'false');
  await expect(toolbar.getByLabel('Size', { exact: true })).toHaveCount(0);
  await toolbar.getByLabel('Note Style').click();
  const panel = page.locator('edgeless-note-style-panel');
  await expect(panel.getByText('Fill color')).toBeVisible();
  await panel.getByRole('button', { name: 'Inline' }).click();
  await expect(container).toHaveAttribute('data-inline', 'true');
  await expect(panel.getByText('Fill color')).toHaveCount(0);
  await expect(toolbar.getByLabel('Note Style')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the shapes panel draws an outline, a hexagon shape and a preset that reopens', async ({
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

  // A hexagon is a shape of its own, placed where the click is.
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Hexagon' }).click();
  await page.mouse.click(...at(0.7, 0.3));
  await expect(page.locator('capy-shape-panel')).toHaveCount(0);
  await expect.poll(() => canvas(page)).toEqual(['plane', 'shape', 'shape']);

  // The panel stays open while the cube follows the pointer, over the card's
  // lower part: the click places it above the panel.
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Cube' }).click();
  await page.mouse.click(...at(0.55, 0.45));
  await expect.poll(() => canvas(page)).toContain('connector');
  await expect.poll(() => canvas(page)).toContain('group');
  // The preset's connector and group store no place, and the board still reopens.
  const placed = await canvas(page);
  const saved = await save(page);
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => canvas(page)).toEqual(placed);
});

test("a shape's switcher offers every shape, and Clear all empties a plane and the board until Undo", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { name: 'Hexagon' }).click();
  await page.mouse.click(...at(0.7, 0.3));
  await expect.poll(() => canvas(page)).toEqual(['plane', 'shape']);
  // Epo 2026-11-13: the switcher lists the shapes panel's ten, polygons included.
  // Placed, the hexagon is selected with its toolbar; another click on it at
  // once would be a double click, which types in it. The shapes panel may still
  // be closing, with its own Pentagon.
  const switcher = page.getByLabel('switch shape type-menu');
  await switcher.getByRole('button', { name: 'Switch shape type' }).click();
  for (const name of [
    'Square',
    'Ellipse',
    'Diamond',
    'Triangle',
    'Rounded rectangle',
    'Right triangle',
    'Parallelogram',
    'Trapezium',
    'Pentagon',
    'Hexagon',
  ])
    await expect(
      switcher.getByRole('button', { exact: true, name })
    ).toBeVisible();
  await switcher.getByRole('button', { name: 'Pentagon' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector(
          'affine-edgeless-root'
        ) as unknown as {
          gfx: {
            layer: { canvasElements: { shapeType?: string; type: string }[] };
          };
        };
        return root.gfx.layer.canvasElements.find(
          ({ type }) => type === 'shape'
        )?.shapeType;
      })
    )
    .toBe('pentagon');

  // A plane's Clear all takes its marks; Undo in the same menu brings them back.
  await page.mouse.dblclick(...at(0.3, 0.6));
  const plane = await onPlane(page);
  await page.getByRole('button', { exact: true, name: 'Point' }).click();
  await page.mouse.click(...plane(0.6, 0.4));
  await expect
    .poll(async () => (await planePoints(page)).points)
    .toHaveLength(1);
  await (await planeMenu(page))
    .getByRole('button', { name: 'Clear all' })
    .click();
  await expect
    .poll(async () => (await planePoints(page)).points)
    .toHaveLength(0);
  await (await planeMenu(page)).getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await planePoints(page)).points)
    .toHaveLength(1);
  await page.getByRole('button', { name: 'Done' }).click();

  // The board's Clear all takes everything, and greys out once it's empty.
  const boardMenu = page.locator('.capy-board-menu .capy-menu-button');
  await boardMenu.click();
  await page.getByRole('menuitem', { name: 'Clear all' }).click();
  await expect.poll(() => canvas(page)).toEqual([]);
  await boardMenu.click();
  await expect(
    page.getByRole('menuitem', { name: 'Clear all' })
  ).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Undo' }).click();
  await expect.poll(() => canvas(page)).toEqual(['plane', 'shape']);
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
  await expect(planeEditor(page)).toHaveCount(0);
  await page.mouse.dblclick(...card(0.5, 0.5));
  await expect(planeEditor(page)).toBeVisible();
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
  // Undo keeps the menu open; a click on the plane closes it and plots.
  await (await planeMenu(page)).getByRole('button', { name: 'Undo' }).click();
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
  await expect(planeEditor(page)).toHaveCount(0);
  expect(await inkIn(page, await toImage(page))).toBeGreaterThan(empty);

  const saved = await save(page);
  await page.evaluate(`window.__reopen(${JSON.stringify(saved)})`);
  await expect.poll(() => marks(page)).toBe(2);

  await page.mouse.dblclick(...card(0.5, 0.5));
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(planeEditor(page)).toHaveCount(0);
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
  await expect(planeEditor(page)).toBeVisible();
  await expect.poll(() => marks(page)).toBe(1);

  await curve.click();
  await page.mouse.click(...at(0.6, 0.6));
  await expect.poll(() => marks(page)).toBe(2);
  await page.getByRole('button', { name: 'Finish curve' }).click();
  await expect.poll(() => marks(page)).toBe(1);

  await curve.click();
  await page.mouse.click(...at(0.6, 0.6));
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(planeEditor(page)).toHaveCount(0);
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
  const menu = await planeMenu(page);
  await expect(menu.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(planeEditor(page)).toBeVisible();

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
      planeEditor(page)
        .locator('canvas')
        .first()
        .evaluate(
          (element) =>
            (element as HTMLCanvasElement).height /
            (window.devicePixelRatio * element.getBoundingClientRect().height)
        )
    )
    .toBeCloseTo(1, 1);

  // Out again, undo carries on into the canvas; the board's ☰ menu stays open through
  // Undo and Redo. The key waits for the editor to be gone, or it lands in it.
  await page.keyboard.press('Escape');
  await expect(planeEditor(page)).toHaveCount(0);
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
    const { minorStep, tickStep } = (await import(
      '/src/features/graph/view.ts' as string
    )) as { minorStep(step: number): number; tickStep(ppu: number): number };
    return minorStep(tickStep(scale));
  }, ppu);
  const rings = Math.hypot(...dropped.at) / step;
  const spokes =
    (Math.atan2(dropped.at[1], dropped.at[0]) * 180) / Math.PI / 15;
  expect(rings).toBeCloseTo(Math.round(rings), 6);
  expect(spokes).toBeCloseTo(Math.round(spokes), 6);

  // A label goes wherever it's dragged, off the rings and spokes (Epo 2026-11-13).
  await page.getByRole('button', { name: 'Label' }).click();
  await page.mouse.click(...polar(0.4, 0.6));
  await page.keyboard.type('Here');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await planePoints(page, true)).points)
    .toHaveLength(2);
  const label = (await planePoints(page, true)).points[1];
  await page.mouse.move(...label.px);
  await page.mouse.down();
  await page.mouse.move(label.px[0] + 37, label.px[1] - 23, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await planePoints(page, true)).points[1].at[0])
    .toBeCloseTo(label.at[0] + 37 / ppu, 6);
  expect((await planePoints(page, true)).points[1].at[1]).toBeCloseTo(
    label.at[1] + 23 / ppu,
    6
  );

  // With Select, a double click on empty paper types a label there, with the canvas
  // label's symbol row (Epo 2026-11-13).
  await page.mouse.dblclick(...polar(0.3, 0.3));
  await page.keyboard.type('a');
  await planeEditor(page).getByRole('button', { name: 'x²' }).click();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await planePoints(page, true)).points)
    .toHaveLength(3);
  await expect(planeEditor(page).getByLabel('Type a label')).toHaveCount(0);
});

test("a label picked alone wears the board's frame, whose corner sizes it, and the plane card turns", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { name: 'Label' }).click();
  await page.mouse.click(...at(0.5, 0.4));
  await page.keyboard.type('Wide');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await planePoints(page)).points)
    .toHaveLength(1);
  const [label] = (await planePoints(page)).points;
  await page.getByRole('button', { name: 'Select' }).click();
  await page.mouse.click(...label.px);
  const plane = () =>
    page.evaluate(() => {
      const { gfx } = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              id: string;
              elementList: { size?: number }[];
              rotate: number;
              type: string;
            }[];
          };
        };
      };
      const card = gfx.layer.canvasElements.find(
        ({ type }) => type === 'plane'
      );
      return {
        id: card?.id ?? '',
        rotate: card?.rotate ?? 0,
        size: card?.elementList[0]?.size,
      };
    });

  // Epo 2026-11-13: the frame's bottom right corner, 6 px out from the 15 px text,
  // dragged out makes the text bigger.
  const width = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    ctx.font = '15px Arial, sans-serif';
    return ctx.measureText('Wide').width;
  });
  const corner = [label.px[0] + width / 2 + 6, label.px[1] + 9 + 6] as const;
  await page.mouse.move(...corner);
  await page.mouse.down();
  await page.mouse.move(corner[0] + 40, corner[1] + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await plane()).size ?? 15).toBeGreaterThan(15);

  // The card turns by the frame's knob, as other cards do.
  await page.getByRole('button', { name: 'Done' }).click();
  const { id } = await plane();
  await page.evaluate((card) => {
    const { gfx } = document.querySelector(
      'affine-edgeless-root'
    ) as unknown as { gfx: { selection: { set(selection: object): void } } };
    gfx.selection.set({ editing: false, elements: [card] });
  }, id);
  const knob = await page
    .locator('edgeless-selected-rect .handle[aria-label="rotate"]')
    .boundingBox();
  if (!knob) throw new Error('the plane card has no rotate knob');
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(knob.x + 80, knob.y + 40, { steps: 6 });
  await page.mouse.up();
  expect((await plane()).rotate).not.toBe(0);
});

test("a selected line's point still moves alone, and Fit shows ten units of an empty plane", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const card = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              elementList: { coords?: Vec[] }[];
              ppu: number;
              type: string;
            }[];
          };
        };
      };
      const plane = root.gfx.layer.canvasElements.find(
        ({ type }) => type === 'plane'
      );
      return {
        ends: plane?.elementList[0]?.coords ?? [],
        ppu: plane?.ppu ?? 0,
      };
    });

  // Epo 2026-11-13: Fit on nothing showed one unit across the screen. Ten
  // units span the editor's shorter side.
  const editor = await planeEditor(page).boundingBox();
  if (!editor) throw new Error('no plane');
  await (await planeMenu(page))
    .getByRole('button', { name: 'Fit to screen' })
    .click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect
    .poll(async () => (await card()).ppu)
    .toBeLessThanOrEqual(Math.min(editor.width, editor.height) / 10 + 1);

  // A line, selected, then its first point dragged: the other end stays put.
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const at = await onPlane(page);
  await page.getByRole('button', { name: 'Line through two points' }).click();
  await page.mouse.click(...at(0.3, 0.6));
  await page.mouse.click(...at(0.6, 0.4));
  await expect.poll(async () => (await card()).ends).toHaveLength(2);
  const [first, last] = (await card()).ends;
  await page.getByRole('button', { name: 'Select' }).click();
  await page.mouse.click(...at(0.45, 0.5));
  const [start] = (await planePoints(page)).points;
  await page.mouse.move(...start.px);
  await page.mouse.down();
  await page.mouse.move(start.px[0] - 60, start.px[1] + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await card()).ends[0]).not.toEqual(first);
  expect((await card()).ends[1]).toEqual(last);
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
              barList: { value: number }[];
              spokeList: { angle: number }[];
              type: string;
            }[];
          };
        };
      };
      const { barList = [], spokeList = [] } =
        root.gfx.layer.canvasElements.findLast(
          ({ type }) => type === 'chart'
        ) ?? {};
      return {
        spokes: spokeList.map(({ angle }) => angle),
        values: barList.map(({ value }) => value),
      };
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

  // Under where the note lands, which is one line tall once it settles.
  await add(`{ ${prelude}
    gfx.surface.addElement({ type: 'shape', shapeType: 'rect', filled: true,
      fillColor: '#000000', strokeColor: '#000000',
      xywh: '[1000,0,300,30]' }); }`);
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
    gfx.surface.addElement({ type: 'plane', fit: false, elements: {}, polar: false,
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
  // Only on screen: the marking image is the area, and its line isn't in it.
  expect(await imageSize(page)).toEqual([1568, 980]);
  await page.evaluate(
    "window.__mount({ answerArea: { label: 'Answer area' }, readOnly: true })"
  );
  await expect(page.locator('affine-edgeless-root')).toHaveCount(1);
  await expect(chip).toHaveCount(0);
});

// A Canvas part (Epo 2026-11-23): the teacher's area moves alone, and the
// student's copy of the teacher's board keeps the question's parts as they are.
test("a teacher's area moves by its label, and a student's copy keeps the question as it is", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const root = "document.querySelector('affine-edgeless-root')";
  const areaAt = () =>
    page.evaluate(() => {
      const rect = document.querySelector('.capy-answer-box rect') as Element;
      return [rect.getAttribute('x'), rect.getAttribute('y')];
    });
  await page.evaluate(
    "window.__mount({ answerArea: { label: 'Answer area', movable: true } })"
  );
  await page.evaluate(`{ const gfx = ${root}.gfx;
    gfx.surface.addElement({ type: 'shape', shapeType: 'rect', filled: true,
      fillColor: '#1971c2', xywh: '[300,300,300,200]' }); }`);
  const chip = await page.locator('.capy-answer-area').boundingBox();
  if (!chip) throw new Error('no label');
  await page.mouse.move(chip.x + 10, chip.y + 10);
  await page.mouse.down();
  await page.mouse.move(chip.x + 110, chip.y + 60, { steps: 8 });
  await page.mouse.up();
  const [x, y] = (await areaAt()).map(Number);
  expect(x).toBeGreaterThan(50);
  expect(y).toBeGreaterThan(20);
  // The area moved alone, in one step to undo.
  expect(await page.evaluate(`${root}.gfx.layer.canvasElements[0].xywh`)).toBe(
    '[300,300,300,200]'
  );
  await page.keyboard.press('ControlOrMeta+z');
  expect(await areaAt()).toEqual(['0', '0']);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await areaAt()).toEqual([String(x), String(y)]);
  const question = await save(page);

  await page.evaluate(
    `window.__mount({ answerArea: { label: 'Answer area' },
      question: { board: ${JSON.stringify(question)}, tip: 'Part of the question' } })`
  );
  expect(await areaAt()).toEqual([String(x), String(y)]);
  // Nothing of the student's yet: an empty answer.
  expect(await canvas(page)).toEqual([]);
  const shape = await page.evaluate(() => {
    const host = document.querySelector('affine-edgeless-root') as unknown as {
      getBoundingClientRect(): DOMRect;
      gfx: { viewport: { toViewCoord(x: number, y: number): number[] } };
    };
    const rect = host.getBoundingClientRect();
    const [vx, vy] = host.gfx.viewport.toViewCoord(450, 400);
    return [rect.left + vx, rect.top + vy] as [number, number];
  });
  // A hover says what it is; a drag from it moves nothing and selects nothing.
  await page.mouse.move(...shape);
  await expect(page.locator('.capy-question-tip')).toHaveText(
    'Part of the question'
  );
  await expect(page.locator('.capy-question-tip')).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(shape[0] + 120, shape[1] + 80, { steps: 6 });
  await page.mouse.up();
  const selected = () =>
    page.evaluate(`[...${root}.gfx.selection.selectedIds]`);
  expect(await selected()).toEqual([]);
  // The student's own stroke: Select all takes it alone, and Delete removes it.
  const stroke = await page.evaluate(`${root}.gfx.surface.addElement({
    type: 'brush', points: [[0, 0], [100, 40]], xywh: '[350,350,100,40]' })`);
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selected()).toEqual([stroke]);
  await page.keyboard.press('Delete');
  expect(await canvas(page)).toEqual([]);
  // The eraser across it leaves it.
  await page.locator('edgeless-eraser-tool-button').first().click();
  await page.mouse.move(shape[0] - 100, shape[1]);
  await page.mouse.down();
  await page.mouse.move(shape[0] + 100, shape[1], { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(`${root}.gfx.gfxElements.length`)).toBe(1);
  // Reopened from the saved answer, it is still part of the question.
  const answer = await save(page);
  await page.evaluate(
    `window.__mount({ answerArea: { label: 'Answer area' },
      saved: ${JSON.stringify(answer)},
      question: { board: ${JSON.stringify(question)}, tip: 'Part of the question' } })`
  );
  expect(
    await page.evaluate(`${root}.gfx.gfxElements.map((e) => e.isLocked())`)
  ).toEqual([true]);
});

test("the marking image fades a question's parts under the student's work", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const add = (fill: string, xywh: string) =>
    page.evaluate(`document.querySelector('affine-edgeless-root').gfx.surface
      .addElement({ type: 'shape', shapeType: 'rect', filled: true,
        fillColor: '${fill}', strokeColor: '${fill}', xywh: '${xywh}' })`);
  // The colour at a board point of the marking image, framing the area at (0, 0).
  const colourAt = async (x: number, y: number) =>
    page.evaluate(
      async ([url, at]) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const output = document.createElement('canvas');
        output.width = image.width;
        output.height = image.height;
        const ctx = output.getContext('2d');
        if (!ctx) throw new Error('no context');
        ctx.drawImage(image, 0, 0);
        const scale = image.width / 1920;
        const data = ctx.getImageData(at[0] * scale, at[1] * scale, 1, 1).data;
        return [data[0], data[1], data[2]];
      },
      [await toImage(page), [x, y]] as const
    );
  // Within the lossy encode's error, on every channel.
  const near = (colour: number[], want: number[]) =>
    expect(
      Math.max(...colour.map((c, i) => Math.abs(c - want[i])))
    ).toBeLessThan(10);
  const blue = [0x19, 0x71, 0xc2];
  const red = [0xe0, 0x31, 0x31];
  await page.evaluate(
    "window.__mount({ answerArea: { label: 'Answer area' } })"
  );
  await add('#1971c2', '[300,300,300,200]');
  // A teacher's own board is drawn at full strength.
  near(await colourAt(380, 400), blue);
  const question = await save(page);

  await page.evaluate(
    `window.__mount({ answerArea: { label: 'Answer area' },
      question: { board: ${JSON.stringify(question)}, tip: 'Part of the question' } })`
  );
  await add('#e03131', '[500,350,300,200]');
  // The question at a quarter of its strength over white, the student's over it.
  near(
    await colourAt(380, 400),
    blue.map((c) => 255 - 0.25 * (255 - c))
  );
  near(await colourAt(550, 425), red);
  near(await colourAt(700, 450), red);
});

test('a note scrolled out of view still reaches the image', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  // A dark note in the answer area's far corner, out of the first view:
  // BlockSuite hides a block out of view at no size.
  await page.evaluate(`{ const gfx = document.querySelector('affine-edgeless-root').gfx;
    const note = gfx.doc.addBlock('affine:note', { xywh: '[1500,880,400,300]',
      background: '#000000', index: gfx.layer.generateIndex() }, gfx.doc.root.id);
    gfx.doc.addBlock('affine:paragraph', {}, note); }`);
  expect(
    await page.evaluate(() =>
      document
        .querySelector('affine-edgeless-note')
        ?.classList.contains('block-idle')
    )
  ).toBe(true);
  // Note fills are half see-through, so the black note is mid grey on white.
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
  // A card starts at Custom size (Epo 2026-11-18): Fit to size is turned on.
  await toolbar.locator('.label', { hasText: 'Custom size' }).click();
  await expect(
    toolbar.locator('.label', { hasText: 'Fit to size' })
  ).toBeVisible();
  await toolbar.getByLabel('Edit the plane').click();
  await expect(planeEditor(page)).toBeVisible();

  // Plotted past the card's right edge, zoomed out so it's on the screen.
  const inside = await onPlane(page);
  // Zoom out sits in the open plane's ☰ menu.
  await (await planeMenu(page))
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
              barList: { label: string; value: number }[];
              labelList: { reach: number; text: string }[];
              spokeList: unknown[];
              type: string;
            }[];
          };
        };
      };
      const { axisMax, barList, labelList, spokeList } =
        root.gfx.layer.canvasElements.findLast(
          ({ type }) => type === 'chart'
        ) ?? {};
      return {
        axisMax,
        labels: labelList?.map(({ text }) => text),
        reaches: labelList?.map(({ reach }) => reach),
        spokes: spokeList?.length,
        values: barList?.map(({ value }) => value),
        words: barList?.map(({ label }) => label),
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
  // Select drags a label anywhere, out from the middle too, not only round (Epo
  // 2026-11-13).
  const reach = (await chart()).reaches?.[0] ?? 0;
  await page.mouse.move(...at(0.55, 0.3));
  await page.mouse.down();
  await page.mouse.move(...at(0.6, 0.12), { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await chart()).reaches?.[0])
    .toBeGreaterThan(reach + 0.1);
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

  // The open plane's nine tools fit one row.
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const tools = planeEditor(page).getByRole('toolbar').getByRole('button');
  await expect(tools).toHaveCount(9);
  const first = await tools.first().boundingBox();
  const last = await tools.last().boundingBox();
  expect(last?.y).toBe(first?.y);
});

test.describe('with a finger', () => {
  test.use({ deviceScaleFactor: 3, hasTouch: true, isMobile: true });

  test("a tap on a note's link opens it from its chip, with the note's foot over the tool row", async ({
    context,
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ height: 800, width: 390 });
    await context.route('https://example.com/**', (route) =>
      route.fulfill({
        body: '<title>Osmosis</title>',
        contentType: 'text/html',
      })
    );
    await openBoard(page);
    // The dev scenario panel sits over the board's foot.
    await page.addStyleTag({
      content: '[data-testid="mock-scenario-panel"] { display: none; }',
    });
    const at = await onCard(page);
    await page.locator('capy-note-button').first().tap();
    await page
      .locator('edgeless-note-menu edgeless-tool-icon-button')
      .first()
      .tap();
    await page.touchscreen.tap(...at(0.5, 0.5));
    await page.waitForFunction(
      () => document.activeElement?.closest('affine-edgeless-note') != null
    );
    await page.keyboard.type('Read osmosis notes');
    await page.keyboard.press('Escape');
    await linkNoteText(page, 5, 7, 'https://example.com/osmosis');
    await onNote(page, 'over the tools');
    // A tap on a selected note types in it, where its own link popup shows.
    await onNote(page, 'unselect');

    // The tap shows the chip and selects the note: no room below it, the chip
    // stays inside the board, over the tool row, and Open opens the page.
    await page.touchscreen.tap(
      ...(await centreOf(page.locator('affine-edgeless-note affine-link')))
    );
    const chip = page.locator('.capy-link-chip');
    await expect(chip).toContainText('example.com/osmosis');
    const covered = await chipCovers(page);
    expect(covered).not.toContain('tool row');
    expect(covered).not.toContain('past the board');
    const opened = context.waitForEvent('page');
    await chip.getByRole('link', { name: 'Open' }).tap();
    expect((await opened).url()).toBe('https://example.com/osmosis');
  });

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
    await expect(planeEditor(page)).toHaveCount(0);
    await page.waitForTimeout(100);
    await page.touchscreen.tap(...card(0.52, 0.51));
    await expect(planeEditor(page)).toBeVisible();

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
    await planeEditor(page)
      .getByRole('button', { exact: true, name: 'More' })
      .tap();
    for (const _ of [1, 2])
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Undo' })
        .tap();
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
    // The image is the answer area alone (Epo 2026-11-23), and Done asks first.
    expect(await imageSize(page)).toEqual([1568, 980]);
    expect(await page.evaluate('window.__board.outside()')).toBe(true);
  });
});

/** Whether the workspace canvas's mock room has stored every change it took
 * (src/mocks/collaboration.ts): a workspace's first canvas is cv_<workspace>_1. */
const roomStored = (page: Page) =>
  page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockBoardStored } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    return mockBoardStored('cv_ws_bio_1');
  });

test('the workspace canvas keeps its plane on reload', async ({ page }) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  const tab = page.getByRole('button', { name: 'Canvas' });
  await tab.waitFor();
  await tab.click();
  // The board mounts once the canvas's room has synced, and a fresh canvas is
  // empty: the Graphs tool places a plane card.
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

  // Every change goes to the canvas's room as it is made, and the room stores
  // a moment after the last one; the mock room keeps that for the tab.
  await expect.poll(() => roomStored(page)).toBe(true);
  // The URL brings the tab back on its own.
  await page.reload();
  await page.waitForFunction(() =>
    (window as unknown as { __board?: { stats(): Stats } }).__board
      ?.stats()
      .canvas.includes('plane')
  );
  await expect.poll(() => marks(page)).toBe(1);
});

test('a canvas opens again at the view its person left it at, and a first open fits everything', async ({
  browser,
  page,
}) => {
  test.slow();
  type View = { centre: [number, number]; zoom: number };
  type Shown = {
    __board?: { fit(room: number[]): void; view(): View | null };
  };
  const viewOf = (on: Page) =>
    on.evaluate(() => (window as Shown).__board?.view() ?? null);
  /** The view once the board has its first: a reload under load joins the
   * room and mounts the board in more than the 5 s a poll waits by default. */
  const opened = async (on = page) => {
    await expect.poll(() => viewOf(on), { timeout: 20_000 }).not.toBeNull();
    return (await viewOf(on)) as View;
  };
  /** The board's own first fit on this screen, with the room a canvas page
   * leaves on a wide one (drawingBoard.ts `fitView`). */
  const fitOf = (on: Page) =>
    on.evaluate(() => {
      const board = (window as Shown).__board;
      board?.fit([90, 40, 130, 40]);
      return board?.view() ?? null;
    }) as Promise<View>;
  const near = (seen: View, wanted: View, step: string) => {
    expect(seen.zoom, step).toBeCloseTo(wanted.zoom, 4);
    expect(seen.centre[0], step).toBeCloseTo(wanted.centre[0], 1);
    expect(seen.centre[1], step).toBeCloseTo(wanted.centre[1], 1);
  };
  /** What the view settles on once it has left `from`: a pinch's zoom eases in. */
  const settled = async (from: View) => {
    await expect.poll(() => opened(), 'the view moves').not.toEqual(from);
    let now = await opened();
    await expect
      .poll(async () => {
        const next = await opened();
        const still = JSON.stringify(next) === JSON.stringify(now);
        now = next;
        return still;
      })
      .toBe(true);
    return now;
  };
  const box = async () => {
    const board = await page.locator('affine-edgeless-root').boundingBox();
    if (!board) throw new Error('no board');
    return board;
  };

  // A first open on this device fits: what the board's own fit shows.
  await page.goto('/workspaces/ws_bio?view=canvas');
  const first = await opened();
  near(first, await fitOf(page), 'a first open');

  // A stroke in the middle, so a view holds something (Q35), stored by the room.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  await page.locator('edgeless-pen-tool-button').first().click();
  const board = await box();
  await page.mouse.move(
    board.x + board.width * 0.4,
    board.y + board.height * 0.4
  );
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(
      board.x + board.width * (0.4 + step * 0.02),
      board.y + board.height * (0.4 + step * 0.015)
    );
  await page.mouse.up();
  await expect.poll(() => canvas(page)).toEqual(['brush']);
  await expect.poll(() => roomStored(page)).toBe(true);

  // Panned by scrolling and zoomed by a pinch over the board.
  await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await page.mouse.wheel(240, 160);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  const left = await settled(first);

  // Away to another page of the workspace and back: the view this device
  // kept, not a fit (Epo 2026-11-19, Q32).
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await page.getByRole('button', { name: 'Canvas' }).click();
  near(await opened(), left, 'back');

  // Panned again and reloaded, with no unmount on the way: the view kept as
  // the page was hidden.
  await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await page.mouse.wheel(-120, -80);
  const again = await settled(left);
  await page.reload();
  near(await opened(), again, 'reloaded');

  // Another person moves everything far off: nothing lies inside the kept
  // view, so the next open fits instead (Epo 2026-11-19, Q35).
  await page.evaluate(async () => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockBoardPeer } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    const peer = mockBoardPeer('cv_ws_bio_1');
    Object.assign(window, { peer });
    for (const [id, element] of Object.entries(peer.elements())) {
      const [x, y, w, h] = JSON.parse(String(element.xywh)) as number[];
      peer.change(id, { xywh: JSON.stringify([x + 8000, y + 8000, w, h]) });
    }
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { gfx } = document.querySelector(
          'affine-edgeless-root'
        ) as unknown as { gfx: { layer: { canvasElements: { x: number }[] } } };
        return gfx.layer.canvasElements[0]?.x ?? 0;
      })
    )
    .toBeGreaterThan(4000);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await page.getByRole('button', { name: 'Canvas' }).click();
  const moved = await opened();
  expect(moved.centre[0], 'not the kept view').toBeGreaterThan(4000);
  near(moved, await fitOf(page), 'nothing in the kept view');

  // Another device keeps nothing: its first open fits.
  const device = await browser.newContext({ viewport: page.viewportSize() });
  const other = await device.newPage();
  await other.goto(new URL('/workspaces/ws_bio?view=canvas', page.url()).href);
  near(await opened(other), await fitOf(other), 'another device');
  await device.close();
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
  // The room's projection names it, so the pruner keeps it.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          fetch('/api/canvases?workspaceId=ws_bio')
            .then((response) => response.json())
            .then(({ items }: { items: { id: string }[] }) =>
              fetch(`/api/canvases/${items[0].id}`)
            )
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

test('the workspace canvas has GIFs, stickers and emoji in a slot, and Formulas in Misc', async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { name: 'Canvas' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await expect(page.locator('capy-formula-slot')).toHaveCount(0);
  // The slot opens KLIPY's view alone, with no Back (Epo 2026-11-12, A + M1).
  await page.locator('capy-gif-sticker-button').click();
  await expect(
    page.locator('capy-misc-panel').getByRole('tab', { name: 'GIFs' })
  ).toBeVisible();
  await expect(
    page.locator('capy-misc-panel').getByRole('button', { name: 'Back' })
  ).toHaveCount(0);
  // The shipped emoji are its third tab (Epo 2026-11-13), not a Misc tile.
  await page
    .locator('capy-misc-panel')
    .getByRole('tab', { name: 'Emoji' })
    .click();
  await expect(page.locator('capy-misc-panel .emoji button')).toHaveCount(48);
  await page.locator('capy-gif-sticker-button').click();
  await placePiece(page, 'capy-misc-panel', 'deriv');
  await page.locator('.capy-formula math-field').waitFor();
  await expect.poll(() => canvas(page)).toContain('formula');
});

test("Misc's YouTube tile places a video, and Edit link changes it in place", async ({
  page,
}) => {
  test.slow();
  await page.goto('/canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await page.locator('capy-misc-button').click();
  const misc = page.locator('capy-misc-panel');
  await misc.getByRole('button', { exact: true, name: 'YouTube' }).click();
  await misc.getByRole('textbox').fill('youtu.be/dQw4w9WgXcQ');
  await misc.getByRole('button', { name: 'Add' }).click();
  const card = page.locator('capy-link-card');
  await expect(card.locator('img')).toBeVisible();
  const before = await card.boundingBox();
  // Edit link (Epo 2026-11-13, E1): the address is in the field.
  await page
    .locator('affine-toolbar-widget')
    .getByLabel('Edit link', { exact: true })
    .click();
  const field = page.locator('capy-link-edit input');
  await expect(field).toHaveValue(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  // Not an address: the field stays open and says so.
  await field.fill('nope');
  await field.press('Enter');
  await expect(page.locator('capy-link-edit .error')).toBeVisible();
  // A web address turns the video into a web card, as wide as it was.
  await field.fill('example.com/notes');
  await field.press('Enter');
  await expect(card).toContainText('example.com');
  const after = await card.boundingBox();
  expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
  expect(after?.height).toBeLessThan(before?.height ?? 0);
});

test("a placed set fills its card, and its Edit is on the card's toolbar", async ({
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
  await page.locator('capy-misc-button').click();
  const misc = page.locator('capy-misc-panel');
  await misc.getByRole('button', { exact: true, name: 'Flashcards' }).click();
  await misc.getByRole('button', { name: /Cell organelles/ }).click();
  const card = page.locator('capy-material-card');
  await expect(card).toContainText('Card 1 of 6');
  // Its face takes the card's height: nothing to scroll (Epo 2026-11-13).
  const body = card.locator('.capy-card-body');
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
  // No Edit in the card; the toolbar's Edit opens its editor, Done closes it.
  await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  const toolbar = page.locator('affine-toolbar-widget');
  await toolbar.getByLabel('Edit', { exact: true }).click();
  await expect(card).not.toContainText('Card 1 of 6');
  await toolbar.getByLabel('Done', { exact: true }).click();
  await expect(card).toContainText('Card 1 of 6');
});

test("the note menu's Link places a link card", async ({ page }) => {
  test.slow();
  await page.goto('/canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  // Link before the note kinds, where the board takes link cards (Epo
  // 2026-11-13, P1): its field opens above the menu's row.
  await page.locator('capy-note-button').click();
  await page
    .locator('edgeless-note-menu')
    .getByLabel('Link', { exact: true })
    .click();
  const field = page.locator('capy-link-add input');
  await field.fill('nope');
  await field.press('Enter');
  await expect(page.locator('capy-link-add .error')).toBeVisible();
  await field.fill('example.com/notes');
  await field.press('Enter');
  await expect(page.locator('capy-link-card')).toContainText('example.com');
  await expect(page.locator('capy-link-add')).toHaveCount(0);
});

test("a plane's editor is in the canvas's URL: Back closes it, and a missing one leaves it", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await placePiece(page, 'capy-graph-slot', 'cart');
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const editor = planeEditor(page);
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(/[?&]open=/);
  await page.goBack();
  await expect(editor).toHaveCount(0);
  await page.goForward();
  await expect(editor).toBeVisible();
  // Done steps back out of it.
  await editor.getByRole('button', { exact: true, name: 'Done' }).click();
  await expect(page).not.toHaveURL(/[?&]open=/);
  // A link to something no longer on the canvas leaves the URL, silently (Epo
  // 2026-11-18), once the board shows and holds no such card. A load fetches
  // the board's chunk again, which is slow on the dev server.
  await page.goto('/workspaces/ws_bio?view=canvas&open=gone-card');
  await expect(page.locator('.capy-board')).toBeVisible({ timeout: 90_000 });
  await expect(page).not.toHaveURL(/[?&]open=/);
});

test("leaving the canvas with a plane's editor open keeps what the editor writes as it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await placePiece(page, 'capy-graph-slot', 'cart');
  /** The plane's scale as its card keeps it, in pixels per unit. */
  const scale = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: { layer: { canvasElements: { ppu?: number }[] } };
      };
      return root.gfx.layer.canvasElements[0]?.ppu ?? null;
    });
  const before = await scale();
  // MathLive loads as the plane's list first opens, here slowly: its first
  // row, which takes focus as it comes in, leaves the More menu opened before
  // it open.
  await page.route(/\/deps\/mathlive\.js/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  await expect(planeEditor(page)).toBeVisible();
  const menu = await planeMenu(page);
  await expect(page.locator('math-field')).toHaveCount(1);
  await menu.getByRole('button', { name: 'Zoom in' }).click();
  await page.keyboard.press('Escape');
  // The card takes the editor's view only as the editor closes.
  expect(await scale()).toBe(before);

  // Away to another page of the workspace with the editor still open: its
  // closing write reaches the room before the room goes.
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await page.getByRole('button', { name: 'Canvas' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await expect.poll(scale).toBeGreaterThan(before ?? Number.NaN);
});

// vendor/blocksuite local change 75: React takes the board's DOM away before
// any effect's cleanup, and each note saves its waiting size as it
// disconnects, into the room still standing.
test("leaving the canvas while a note's size waits on a pause in typing keeps the size", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  /** The note holding `text`, as stored and as shown. */
  const sizes = (text: string) =>
    page.evaluate((held) => {
      const note = [...document.querySelectorAll('affine-edgeless-note')].find(
        (element) => element.textContent?.includes(held)
      ) as unknown as
        | { model: { xywh: string; yBlock: { get(key: string): unknown } } }
        | undefined;
      return note
        ? {
            shown: note.model.xywh,
            stored: String(note.model.yBlock.get('prop:xywh')),
          }
        : null;
    }, text);
  /** How far two sizes are apart, in board units. */
  const apart = (one: string, other: string) => {
    const [, , w, h] = JSON.parse(one) as number[];
    const [, , w2, h2] = JSON.parse(other) as number[];
    return Math.max(Math.abs(w - w2), Math.abs(h - h2));
  };
  const dashboard = await page
    .getByRole('button', { name: 'Dashboard' })
    .elementHandle();
  await page.mouse.dblclick(board.x + board.width / 2, board.y + 160);
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  await page.keyboard.type('Osmosis');
  // Away within the pause (an inline note's width waits on it), once the
  // last key's width is measured (two frames).
  const left = await page.evaluate(
    async ([held, button]) => {
      for (const _ of [0, 1])
        await new Promise((resolve) => requestAnimationFrame(resolve));
      const note = [...document.querySelectorAll('affine-edgeless-note')].find(
        (element) => element.textContent?.includes(held)
      ) as unknown as {
        model: { xywh: string; yBlock: { get(key: string): unknown } };
      };
      const before = {
        shown: note.model.xywh,
        stored: String(note.model.yBlock.get('prop:xywh')),
      };
      (button as HTMLButtonElement).click();
      return before;
    },
    ['Osmosis', dashboard] as const
  );
  expect(apart(left.stored, left.shown)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await page.getByRole('button', { name: 'Canvas' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  // Stored as it was shown, the width and height within a pixel, as the note
  // first shows: before this tab's own write of what it measures (3 s on).
  await page.waitForFunction(
    (held) =>
      [...document.querySelectorAll('affine-edgeless-note')].some((element) =>
        element.textContent?.includes(held)
      ),
    'Osmosis'
  );
  const back = await sizes('Osmosis');
  expect(back && apart(back.stored, left.shown)).toBeLessThan(1);
});

test("a plane's curve bends by its stroke, and the workspace's objects list plots a typed function", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await placePiece(page, 'capy-graph-slot', 'cart');
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  const marks = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              elementList: {
                coords?: Vec[];
                handles?: [Vec, Vec][];
                latex?: string;
                type: string;
              }[];
              type: string;
            }[];
          };
        };
      };
      return (
        root.gfx.layer.canvasElements.find(({ type }) => type === 'plane')
          ?.elementList ?? []
      );
    });

  // Epo 2026-11-13 (K2): the selected curve's stroke pulls that stretch, its points
  // staying where they are. Two points make it straight, so its middle is on it.
  const at = await onPlane(page);
  await page.getByRole('button', { name: 'Curve through points' }).click();
  await page.mouse.click(...at(0.5, 0.6));
  await page.mouse.click(...at(0.8, 0.4));
  await page.getByRole('button', { name: 'Finish curve' }).click();
  await page.getByRole('button', { name: 'Select' }).click();
  await page.mouse.click(...at(0.65, 0.5));
  const [curve] = await marks();
  await page.mouse.move(...at(0.65, 0.5));
  await page.mouse.down();
  await page.mouse.move(...at(0.65, 0.3), { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await marks())[0].handles).toHaveLength(2);
  expect((await marks())[0].coords).toEqual(curve.coords);

  // K1: a double click on a point makes it a corner, its handles on it.
  const [end] = (await planePoints(page)).points;
  await page.mouse.dblclick(...end.px);
  await expect
    .poll(async () => (await marks())[0].handles?.[0])
    .toEqual([end.at, end.at]);

  // L2: the list is open on a wide screen; its last row plots what's typed.
  await expect(page.getByRole('button', { name: 'Objects' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // MathLive takes the keyboard a moment after the click.
  const typeRow = async (text: string) => {
    // The list's last row is the empty one.
    await planeEditor(page).locator('math-field').last().click();
    await page.waitForTimeout(250);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  // A formula row is stored as its typed LaTeX (Epo 2026-11-18).
  await typeRow('sin(x)');
  await expect
    .poll(async () =>
      (await marks()).flatMap(({ latex, type }) =>
        type === 'expression' ? [latex] : []
      )
    )
    .toEqual([expect.stringContaining('\\sin')]);
  // It takes the graph dialog's rows too: named points and what's built on them.
  for (const row of ['A=(1,2)', 'B=(4,3)', 'segment(A,B)']) await typeRow(row);
  await expect
    .poll(async () => (await marks()).map(({ type }) => type))
    .toEqual(expect.arrayContaining(['point', 'point', 'segment']));

  // The answer board has no list, so an answer is drawn rather than typed.
  await openBoard(page);
  await page.mouse.dblclick(...(await onCard(page))(0.5, 0.5));
  await expect(planeEditor(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Objects' })).toHaveCount(0);
});

test("a chart's data pane on the workspace canvas types bars and slices", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  const chart = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as unknown as {
        gfx: {
          layer: {
            canvasElements: {
              axisMax?: number;
              barList?: { label: string; value: number }[];
              labelList?: { text: string }[];
              spokeList?: { angle: number }[];
              type: string;
            }[];
          };
        };
      };
      const found = root.gfx.layer.canvasElements
        .filter(({ type }) => type === 'chart')
        .at(-1);
      return {
        axisMax: found?.axisMax,
        bars: found?.barList ?? [],
        labels: (found?.labelList ?? []).map(({ text }) => text),
        spokes: (found?.spokeList ?? []).map(({ angle }) => angle),
      };
    });
  const toolbar = page.locator('affine-toolbar-widget');
  const pane = page.locator('.capy-plane-list');

  // Epo 2026-11-13 (B1): "+ Bar", then its label and a value past the axis's top.
  await placePiece(page, 'capy-misc-panel', 'bar');
  await toolbar.getByLabel('Edit the chart').click();
  await expect(page.getByRole('button', { name: 'Data' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await pane.getByRole('button', { name: 'Bar' }).click();
  await page.keyboard.type('Mon');
  await pane.getByRole('textbox', { name: 'Value' }).fill('13');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await chart()).bars)
    .toEqual([expect.objectContaining({ label: 'Mon', value: 13 })]);
  expect((await chart()).axisMax).toBeGreaterThanOrEqual(13);
  await page.getByRole('button', { name: 'Done' }).click();

  // P1: two slices from "+ Slice", the first named and set to 25%.
  await page.keyboard.press('v');
  await placePiece(page, 'capy-misc-panel', 'pie');
  await toolbar.getByLabel('Edit the chart').click();
  await pane.getByRole('button', { name: 'Slice' }).click();
  await expect.poll(async () => (await chart()).spokes).toHaveLength(2);
  await pane
    .getByRole('textbox', { name: 'Type a label' })
    .first()
    .fill('Walk');
  await pane.getByRole('textbox', { name: 'Share' }).first().fill('25');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chart()).spokes).toEqual([0, 90]);
  expect((await chart()).labels).toEqual(['Walk']);
});

test("a quiz card's Undo while edited is the quiz's, not the canvas's", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await page.locator('capy-misc-button').click();
  const misc = page.locator('capy-misc-panel');
  await misc.getByRole('button', { exact: true, name: 'Quiz' }).click();
  await misc.getByRole('button', { name: /Genetics check-in/ }).click();
  const card = page.locator('capy-material-card');
  await page
    .locator('affine-toolbar-widget')
    .getByRole('button', { name: 'Edit' })
    .click();
  const first = 'A cross between Aa × Aa gives what genotype ratio?';
  await expect(card).toContainText(first);
  // A question opens by its card, and Delete is at the open card's foot.
  await card
    .getByRole('button', { exact: true, name: 'Edit question 1' })
    .click();
  await card.getByRole('button', { exact: true, name: 'Delete' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(card).not.toContainText(first);
  // The board's menu Undo brings the question back and leaves the card placed.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Undo' }).click();
  await expect(card).toContainText(first);
  await expect(card).toHaveCount(1);
});

test('a double click places an inline note on the workspace canvas', async ({
  page,
}) => {
  test.slow();
  await page.goto('/canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  // Epo 2026-11-13: a note that takes links and lists, not a canvas label (an
  // answer board keeps the label).
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  await page.mouse.dblclick(board.x + board.width / 2, board.y + 160);
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  await page.keyboard.type('Photosynthesis');
  const note = page.locator('affine-edgeless-note');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Photosynthesis');
  await expect(note.locator('[data-inline="true"]')).toHaveCount(1);
  await expect(page.locator('edgeless-text-editor')).toHaveCount(0);

  // The plus on either side of the selected note places the next one, typed in
  // at once (local change 60; Epo 2026-11-13).
  for (const [side, text] of [
    [0, 'Light'],
    [1, 'Chlorophyll'],
  ] as const) {
    await page.keyboard.press('Escape');
    await page.mouse.click(board.x + 40, board.y + board.height - 160);
    await note.first().click();
    await page.locator('.edgeless-auto-complete-arrow').nth(side).click();
    await page.keyboard.type(text);
    await expect(note.filter({ hasText: text })).toHaveCount(1);
  }
  await expect(note).toHaveCount(3);
});

/** Links `length` characters at `index` of the note's text to `href`, as the
 * text toolbar's link button would. */
const linkNoteText = (
  page: Page,
  index: number,
  length: number,
  href: string
) =>
  page.evaluate(
    ([at, count, link]) => {
      const text = document.querySelector(
        'affine-edgeless-note rich-text'
      ) as unknown as {
        inlineEditor: { formatText(range: object, attributes: object): void };
      };
      text.inlineEditor.formatText({ index: at, length: count }, { link });
    },
    [index, length, href] as const
  );

/** Acts on the board's one note: selects it or nothing, turns it to so many
 * degrees, or unturns it with its foot just over the bottom tool row (no room
 * for the link chip below it). Answers its turn. */
const onNote = (
  page: Page,
  action?: 'select' | 'unselect' | 'over the tools' | number
) =>
  page.evaluate((act) => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      getBoundingClientRect(): DOMRect;
      gfx: {
        selection: { clear(): void; set(selection: object): void };
        updateElement(id: string, props: object): void;
        viewport: { toModelCoord(x: number, y: number): [number, number] };
      };
    };
    const { gfx } = root;
    const { model } = document.querySelector(
      'affine-edgeless-note'
    ) as unknown as { model: { id: string; rotate: number; xywh: string } };
    if (act === 'select')
      gfx.selection.set({ editing: false, elements: [model.id] });
    else if (act === 'unselect') gfx.selection.clear();
    else if (typeof act === 'number')
      gfx.updateElement(model.id, { rotate: act });
    else if (act) {
      const tools = document.querySelector('edgeless-toolbar-widget');
      if (!tools) throw new Error('the board has no tool row');
      const [x, , w, h] = JSON.parse(model.xywh) as number[];
      const [, foot] = gfx.viewport.toModelCoord(
        0,
        tools.getBoundingClientRect().top - root.getBoundingClientRect().top - 8
      );
      gfx.updateElement(model.id, {
        rotate: 0,
        xywh: JSON.stringify([x, foot - h, w, h]),
      });
    }
    return model.rotate;
  }, action);

/** What the link chip covers that it must keep off: the note as drawn, its
 * frame's squares, bars and knob, the bottom tool row, or past the board. */
const chipCovers = (page: Page) =>
  page.evaluate(() => {
    const chip = document.querySelector('.capy-link-chip') as HTMLElement;
    const box = chip.getBoundingClientRect();
    const meets = (other: DOMRect) =>
      other.width > 0 &&
      other.height > 0 &&
      box.left < other.right &&
      other.left < box.right &&
      box.top < other.bottom &&
      other.top < box.bottom;
    const covered: string[] = [];
    const note = document.querySelector(
      'affine-edgeless-note [data-testid="edgeless-note-container"]'
    );
    if (note && meets(note.getBoundingClientRect())) covered.push('note');
    for (const handle of document.querySelectorAll(
      'edgeless-selected-rect .handle'
    ))
      if (meets(handle.getBoundingClientRect()))
        covered.push(handle.getAttribute('aria-label') ?? 'handle');
    const tools = document.querySelector('edgeless-toolbar-widget');
    if (tools && meets(tools.getBoundingClientRect())) covered.push('tool row');
    const board = (chip.parentElement as HTMLElement).getBoundingClientRect();
    if (box.top < board.top || box.bottom > board.bottom)
      covered.push('past the board');
    return covered;
  });

const centreOf = async (element: Locator) => {
  const box = await element.boundingBox();
  if (!box) throw new Error('not drawn');
  return [box.x + box.width / 2, box.y + box.height / 2] as const;
};

test("a note's link shows its address on hover, and the frame's knob turns the note", async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  const at = await onCard(page);
  await page.locator('capy-note-button').first().click();
  await page
    .locator('edgeless-note-menu edgeless-tool-icon-button')
    .first()
    .click();
  await page.mouse.click(...at(0.5, 0.5));
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  // Two lines, with a link on each: "osmosis" above "diffusion".
  await page.keyboard.type('Read osmosis notes');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('See diffusion too');
  await page.keyboard.press('Escape');
  await linkNoteText(page, 5, 7, 'https://example.com/osmosis');
  await linkNoteText(page, 23, 9, 'https://example.com/diffusion');
  await page.mouse.click(...at(0.05, 0.05));

  // L1 (Epo 2026-11-13): hovering it, with nothing being typed, shows its address
  // and Open, a new tab.
  const links = page.locator('affine-edgeless-note affine-link');
  await page.mouse.move(...(await centreOf(links.first())));
  const chip = page.locator('.capy-link-chip');
  const open = chip.getByRole('link', { name: 'Open' });
  await expect(chip).toContainText('example.com/osmosis');
  await expect(open).toHaveAttribute('href', 'https://example.com/osmosis');

  // F1: the selected note's frame has a knob above its middle that turns it;
  // the chip moves past the frame, off its squares, bars and knob.
  await onNote(page, 'select');
  await expect.poll(() => chipCovers(page)).toEqual([]);

  // On the way from the link to its chip, crossing the other link leaves the
  // chip on this one, and coming back to the chip ends a hide under way.
  const diffusion = await centreOf(links.nth(1));
  const onOpen = await centreOf(open);
  await page.mouse.move(...diffusion, { steps: 4 });
  await page.mouse.move(...onOpen, { steps: 4 });
  await expect(chip).toContainText('example.com/osmosis');
  await page.mouse.move(...at(0.05, 0.05));
  await page.mouse.move(...onOpen);
  // Past the chip's 150 ms hide.
  await page.waitForTimeout(400);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('example.com/osmosis');
  // Resting on the other link gives it the chip.
  await page.mouse.move(...diffusion, { steps: 4 });
  await expect(chip).toContainText('example.com/diffusion');

  const knob = await page
    .locator('edgeless-selected-rect .handle[aria-label="rotate"]')
    .boundingBox();
  if (!knob) throw new Error('the frame has no rotate knob');
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(knob.x + 80, knob.y + 40, { steps: 6 });
  await page.mouse.up();
  expect(await onNote(page)).not.toBe(0);

  // Turned a quarter, the chip still sits past the turned frame (local change
  // 56 turns the note's inner box, not its element).
  await onNote(page, 90);
  await page.mouse.move(...at(0.05, 0.05));
  await expect(chip).toBeHidden();
  await page.mouse.move(...(await centreOf(links.first())));
  await expect(chip).toContainText('example.com/osmosis');
  await expect.poll(() => chipCovers(page)).toEqual([]);

  // With no room below the note (its foot over the tool row), the chip sits
  // beside it, still clear of the frame, inside the board and over the tool row.
  await onNote(page, 'over the tools');
  await page.mouse.move(...at(0.05, 0.05));
  await expect(chip).toBeHidden();
  const osmosis = await links.first().boundingBox();
  if (!osmosis) throw new Error('the link is not drawn');
  await page.mouse.move(...(await centreOf(links.first())));
  await expect(chip).toContainText('example.com/osmosis');
  await expect.poll(() => chipCovers(page)).toEqual([]);
  const beside = await chip.boundingBox();
  expect(beside?.y).toBeLessThan(osmosis.y + osmosis.height);
});

test("the Canvas page's Misc lists every quiz with its workspace, and New opens a quiz in no workspace in a dialog", async ({
  page,
}) => {
  test.slow();
  await page.goto('/canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await page.locator('capy-misc-button').click();
  const misc = page.locator('capy-misc-panel');
  await expect(
    misc.getByRole('heading', { name: 'Quizzes and flashcards' })
  ).toBeVisible();
  await misc.getByRole('button', { exact: true, name: 'Quiz' }).click();
  // Each tile says its workspace, and one in none says nothing (Epo 2026-11-13, A).
  await expect(
    misc.locator('.card', { hasText: 'Genetics check-in' }).locator('.ws')
  ).toHaveText('Biology 101');
  await expect(
    misc
      .locator('.card', { hasText: 'Shared cell biology quiz' })
      .locator('.ws')
  ).toHaveCount(0);
  // The filter matches the workspace's name too.
  await misc.getByRole('searchbox').fill('calc');
  await expect(misc.locator('.card:not(.new)')).toHaveCount(1);
  await misc.getByRole('searchbox').fill('');
  // New makes one in no workspace (W1), places it and opens its editor in a dialog.
  await misc.getByRole('button', { name: 'New quiz' }).click();
  // Its card runs as it lands, before the list holds the quiz (read once, not
  // waited for: the list catches up a call later).
  const card = page.locator('.capy-card');
  await expect(card.locator('.title')).toHaveText('Quiz 1');
  expect(
    await card.evaluate(({ classList }) => classList.contains('gone'))
  ).toBe(false);
  const dialog = page.getByRole('dialog', { name: 'Quiz 1' });
  // The editor shows after four calls in a row, each behind the mocks' delay:
  // the quiz is made, read, and its two rooms join one after the other.
  await expect(
    dialog.getByRole('button', { name: 'Add question' })
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.capy-card .title')).toHaveText('Quiz 1');
});

test("the workspace canvas's New quiz opens it, and its card runs when the canvas is opened again before the list holds it", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  await page.locator('capy-misc-button').click();
  const misc = page.locator('capy-misc-panel');
  await misc.getByRole('button', { exact: true, name: 'Quiz' }).click();
  await misc.getByRole('button', { name: 'New quiz' }).click();
  // The quiz opens on the Files page; back on the canvas a call later, the
  // list's read after the create is still on its way (read once, not waited for).
  await expect(page).toHaveURL(/material=/);
  await page.getByRole('button', { name: 'Canvas' }).click();
  const card = page.locator('capy-material-card .capy-card');
  await expect(card.locator('.title')).toHaveText('Biology 101 quiz 1');
  expect(
    await card.evaluate(({ classList }) => classList.contains('gone'))
  ).toBe(false);
});

test("the Canvas page is a board of the person's own, and its panel lists and makes canvases", async ({
  page,
}) => {
  test.slow();
  // The picker is the editor's popover (Epo 2026-11-12): its rows are buttons.
  const menu = page.locator('[data-slot=popover-content]');
  // A workspace's first canvas is made as its tab opens.
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
  const panel = page.getByRole('button', { exact: true, name: 'My canvas' });
  await panel.click();
  // Every canvas there is: their own, then the workspace's under its name.
  await expect(menu.getByRole('button', { name: /My canvas/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: /Biology 101/ })).toBeVisible();
  // The pointer crossing the board leaves it open (local change 40).
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await page.mouse.move(board.x + board.width / 2 + 40, board.y + 200, {
    steps: 5,
  });
  await page.waitForTimeout(300);
  await expect(menu.getByRole('button', { name: 'New canvas' })).toBeVisible();
  await menu.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/\/canvas\?c=cv_own_2$/);
  await expect(
    page.getByRole('button', { exact: true, name: 'Untitled canvas' })
  ).toBeVisible();
  // Rename starts from the shown canvas's own name, and the panel takes the new one.
  await page
    .getByRole('button', { exact: true, name: 'Untitled canvas' })
    .click();
  await menu.getByRole('button', { name: 'Rename' }).click();
  const name = page.getByRole('textbox');
  await expect(name).toHaveValue('Untitled canvas');
  await name.fill('Exam plan');
  await name.press('Enter');
  // A workspace's canvas opens in its workspace.
  await page.getByRole('button', { exact: true, name: 'Exam plan' }).click();
  await menu.getByRole('button', { name: /Biology 101/ }).click();
  await expect(page).toHaveURL(
    /\/workspaces\/ws_bio\?c=cv_ws_bio_1&view=canvas/
  );
  // There the picker lists the workspace's canvases alone and makes more
  // (Epo 2026-11-12), each named in the URL.
  const picker = page.locator(
    '[data-workspace-canvas] [data-slot=popover-anchor] button'
  );
  await expect(picker).toHaveText('Biology 101');
  await picker.click();
  await expect(menu.getByRole('button', { name: /Exam plan/ })).toHaveCount(0);
  await menu.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/c=cv_ws_bio_\d+&view=canvas/);
  await expect(page).not.toHaveURL(/c=cv_ws_bio_1&/);
  await expect(picker).toHaveText('Untitled canvas');
  await picker.click();
  await menu.getByRole('button', { name: /Biology 101/ }).click();
  await expect(page).toHaveURL(/c=cv_ws_bio_1&view=canvas/);
  await expect(page.locator('.capy-board')).toHaveCount(1);
});

test('the Canvas page lists its canvases a page at a time', async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { name: 'Canvas' }).click({ timeout: 60_000 });
  await page.waitForFunction(
    () => (window as unknown as { __board?: unknown }).__board
  );
  // The account's page, reached within the app: the mocks forget on a reload.
  await page.evaluate(() => {
    history.pushState({}, '', '/canvas');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/canvas\?c=cv_own_1$/);
  const make = (count: number, from: number) =>
    page.evaluate(
      ([many, first]) =>
        Promise.all(
          Array.from({ length: many }, (_, at) =>
            fetch('/api/canvases', {
              body: JSON.stringify({ title: `Canvas ${first + at}` }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            })
          )
        ).then(() => undefined),
      [count, from]
    );
  // Sixty newer ones put the shown canvas on the list's second page: the panel
  // loads on until it has it, and the page stays on it.
  await make(60, 1);
  await page.getByRole('button', { exact: true, name: 'My canvas' }).click();
  const menu = page.locator('[data-slot=popover-content]');
  const made = menu.getByRole('button', { name: /^Canvas \d+/ });
  await expect(made).toHaveCount(60);
  await expect(menu.getByRole('button', { name: /My canvas/ })).toBeVisible();
  await expect(page).toHaveURL(/\/canvas\?c=cv_own_1$/);
  // One on the first page shown, and fifty more made: the two pages loaded are
  // read again, and the list's end loads the third.
  await made.first().click();
  await expect(page).not.toHaveURL(/c=cv_own_1$/);
  await make(50, 61);
  await page.getByRole('button', { name: /^Canvas \d+/ }).click();
  await expect(made).toHaveCount(100);
  // The list scrolls in a box of its own: the actions under it stay in reach.
  const create = menu.getByRole('button', { name: 'New canvas' });
  await expect(create).toBeInViewport();
  await menu
    .locator('> div')
    .first()
    .evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(made).toHaveCount(110);
  await expect(create).toBeInViewport();
  // Their own come first, then the workspace's.
  await expect(menu.getByRole('button').nth(111)).toHaveText(/Biology 101/);
});

test('the workspace canvas stays in the URL at every width', async ({
  page,
}) => {
  test.slow();
  // Pressed with a page open in the centre, it takes that page's place in the URL.
  await page.goto('/workspaces/ws_bio/study/practice');
  await page.getByRole('button', { name: 'Canvas' }).click();
  await expect(page).toHaveURL(/view=canvas/);
  await expect(page).not.toHaveURL(/\/study\//);
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
  await expect(page).toHaveURL(/view=canvas/);
  await expect(board).toBeVisible();
  await page.reload();
  // A reload loads the board's chunk again, which is slow on the dev server.
  await expect(board).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Dashboard' }).first().click();
  await expect(board).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=canvas/);

  // The browser's back returns to it, and a wide window keeps it.
  await page.goBack();
  await expect(board).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ height: 800, width: 1400 });
  await expect(board).toBeVisible();
  await expect(page).toHaveURL(/view=canvas/);

  // Another section leaves it, and Back returns.
  await page.getByRole('button', { name: 'Files' }).first().click();
  await expect(board).toHaveCount(0);
  await expect(page).toHaveURL(/view=files/);
  await page.goBack();
  await expect(board).toBeVisible({ timeout: 30_000 });
});

test('a saved board leaves its undo history out, and a teacher opens it read-only', async ({
  page,
}) => {
  test.slow();
  await openBoard(page);
  // A point moved 200 times, one undo step each, as dragging it on the plane does;
  // it ends at (10, 5), on the card, so the image shows it.
  await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as unknown as {
      gfx: {
        doc: { captureSync(): void };
        layer: {
          canvasElements: { writeList(elements: object[]): void }[];
        };
      };
    };
    const [card] = root.gfx.layer.canvasElements;
    for (let i = 0; i < 200; i++) {
      root.gfx.doc.captureSync();
      card.writeList([
        { coords: [(i + 1) / 20, (i + 1) / 40], id: 'm', type: 'point' },
      ]);
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
  await expect(planeEditor(page)).toHaveCount(0);
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
    type Model = {
      deserializedXYWH: number[];
      type: string;
      writeList(elements: object[]): void;
    };
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
    plane.writeList([
      { coords: [2, 3], id: 'a', type: 'point' },
      {
        coords: [
          [-1, -1],
          [4, 2],
        ],
        id: 'b',
        type: 'polyline',
      },
      {
        coords: [
          [0, 0],
          [1, 2],
          [3, 1],
          [5, 4],
        ],
        id: 'c',
        type: 'curve',
      },
    ]);
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
    // A chart's lists keyed by id, each item with its order key (Epo 2026-11-22).
    const keyed = (items: { id: string }[]) =>
      Object.fromEntries(
        items.map((element, i) => [element.id, { element, order: `a${i}` }])
      );
    add({
      axisMax: 10,
      axisStep: 2,
      bars: keyed([
        { fill: '#4dabf7', id: '1', label: 'A', value: 4 },
        { fill: '#ff8787', id: '2', label: 'B', value: 7 },
      ]),
      kind: 'bar',
      labels: {},
      spokes: {},
      type: 'chart',
      xywh: `[${x},${y + h + 160},360,240]`,
    });
    add({
      axisMax: 10,
      axisStep: 2,
      bars: {},
      kind: 'pie',
      labels: {},
      spokes: keyed([
        { angle: 0, id: 's1' },
        { angle: 120, fill: '#ffd43b', id: 's2' },
        { angle: 200, id: 's3' },
      ]),
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
    'fill="#ffd43b"', // its filled slice
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
