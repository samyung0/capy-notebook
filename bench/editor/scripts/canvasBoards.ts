import { type Browser, expect, type Page } from '@playwright/test';

/** The boards bench:canvas opens, made in the page through BlockSuite's own API and
 * saved, so they always match the board's current format. */

export type Size = {
  formulas: number;
  notes: number;
  paragraphs: number;
  shapes: number;
  strokes: number;
  /** Where strokes, shapes and formulas go; the plane card is 820 by 520. */
  width: number;
  height: number;
};

/** A drawn answer: a sketch on the plane with a few shapes, formulas and cards. */
export const TYPICAL: Size = {
  formulas: 2,
  height: 520,
  notes: 2,
  paragraphs: 2,
  shapes: 3,
  strokes: 40,
  width: 820,
};
/** Far past an answer: what the board must still handle. */
export const LARGE: Size = {
  formulas: 10,
  height: 1600,
  notes: 30,
  paragraphs: 3,
  shapes: 30,
  strokes: 200,
  width: 2400,
};
const STROKE_POINTS = 30;

/** Eight drawn answers on one board, as the board of the 2026-11-06 label
 * measurement held: 25 plane cards with points, a curve, a line and labels, 64
 * formula cards and 32 note cards; in each answer also a canvas label, two
 * labelled shapes joined by a connector and a few strokes, so every label a
 * student types has one to type in. Answers are 1920 by 1200, four to a row. */
export const DENSE = {
  answer: { gap: 200, h: 1200, w: 1920 },
  answers: 8,
  formulas: 64,
  notes: 32,
  planes: 25,
  strokes: 10,
};

export type Expected = { blocks: number; canvas: number };

declare global {
  interface Window {
    __benchBoard?: string;
    __benchExpected?: Expected;
    __benchOpen?: {
      loafs: { blocking: number; end: number }[];
      painted?: number;
    };
    __benchInputs?: { at: number[]; presents: number[] };
    /** Long animation frames' durations, for the hidden mount. */
    __benchLoafs?: number[];
    __board?: {
      fit(padding: [number, number, number, number]): void;
      save(): { bytes: number; doc: string };
      stats(): { blocks: string[]; canvas: string[] };
    };
    __mount?: (options: object) => void;
  }
}

/** What the board's page exposes on its root element, as far as the bench uses it. */
export type Root = HTMLElement & {
  gfx: {
    layer: {
      blocks: { flavour: string; id: string; xywh: string }[];
      canvasElements: unknown[];
    };
    surface: {
      addElement(props: object): string;
      deleteElement(id: string): void;
    };
    viewport: {
      setViewport(zoom: number, center: [number, number]): void;
      width: number;
      toViewCoord(x: number, y: number): [number, number];
    };
  };
  std: {
    store: {
      addBlock(flavour: string, props: object, parent: string): string;
      getBlock(id: string): {
        model: { props: { text: { insert(text: string, at: number): void } } };
      };
      root: { id: string };
    };
  };
};

export async function openBoard(page: Page) {
  await page.goto('/dev/drawing');
  await page.waitForFunction(
    () => window.__board?.stats().canvas.includes('plane'),
    null,
    {
      timeout: 120_000,
    }
  );
}

/**
 * Saves the board once every note card holds its measured height, as a board a
 * person typed is saved. Each card is added 120 high and its text wraps taller;
 * the tab that added it measures it once drawn and stores that with the save
 * (local change 75). Saved before that, a tab opening the board shows the
 * size it measures at once but writes it 3 s later, a write of every card
 * inside the measured inputs. Other blocks (an image, an embed) have no
 * measured height.
 */
async function saveMeasured(page: Page) {
  await page.evaluate(() => window.__board?.fit([40, 40, 40, 40]));
  await page.waitForFunction(
    () => {
      const { gfx } = document.querySelector('affine-edgeless-root') as Root;
      const notes = gfx.layer.blocks.filter(
        ({ flavour }) => flavour === 'affine:note'
      );
      return notes.every(({ id, xywh }) => {
        const mask = document.querySelector<HTMLElement>(
          `affine-edgeless-note[data-block-id="${id}"] .affine-note-mask`
        );
        const [, , , h] = JSON.parse(xywh) as number[];
        return !!mask && Math.abs(mask.offsetHeight - h) < 1;
      });
    },
    null,
    { timeout: 60_000 }
  );
  return page.evaluate(() => {
    const board = window.__board;
    if (!board) throw new Error('no board');
    const stats = board.stats();
    return {
      expected: { blocks: stats.blocks.length, canvas: stats.canvas.length },
      saved: board.save(),
    };
  });
}

/** A board of the given size, made on an unthrottled page and saved. */
export async function makeBoard(browser: Browser, size: Size) {
  const page = await browser.newPage();
  await openBoard(page);
  await page.evaluate(
    ({ size, STROKE_POINTS }) => {
      const { gfx, std } = document.querySelector(
        'affine-edgeless-root'
      ) as Root;
      const { store } = std;
      // A fixed sequence, so every run draws the same board.
      let seed = 7;
      const random = () => {
        seed = (seed * 16_807) % 2_147_483_647;
        return seed / 2_147_483_647;
      };
      const WIDTH = size.width;
      const HEIGHT = size.height;
      for (let i = 0; i < size.strokes; i++) {
        let x = random() * WIDTH;
        let y = random() * HEIGHT;
        const points: [number, number][] = [];
        for (let p = 0; p < STROKE_POINTS; p++) {
          x += (random() - 0.5) * 24;
          y += (random() - 0.5) * 24;
          points.push([x, y]);
        }
        gfx.surface.addElement({
          color: '#1f2937',
          lineWidth: 4,
          points,
          type: 'brush',
        });
      }
      for (let i = 0; i < size.shapes; i++)
        gfx.surface.addElement({
          shapeType: i % 2 ? 'ellipse' : 'rect',
          type: 'shape',
          xywh: `[${random() * WIDTH},${random() * HEIGHT},90,60]`,
        });
      for (let i = 0; i < size.formulas; i++)
        gfx.surface.addElement({
          latex: `\\frac{${i}x^2+1}{\\sqrt{x+${i}}}`,
          type: 'formula',
          xywh: `[${random() * WIDTH},${random() * HEIGHT},160,60]`,
        });
      for (let i = 0; i < size.notes; i++) {
        const note = store.addBlock(
          'affine:note',
          {
            // Below the plane card, whose double click opens the plane.
            xywh: `[${(i % 6) * 400},${700 + Math.floor(i / 6) * 320},260,120]`,
          },
          store.root.id
        );
        for (let p = 0; p < size.paragraphs; p++) {
          const paragraph = store.addBlock('affine:paragraph', {}, note);
          store
            .getBlock(paragraph)
            .model.props.text.insert(
              `Card ${i + 1}, line ${p + 1}: the force on the block is mass times acceleration.`,
              0
            );
        }
      }
    },
    { size, STROKE_POINTS }
  );
  const made = await saveMeasured(page);
  await page.close();
  return made;
}

/** What a dense board's first answer holds, for the inputs typed into it. */
export type DenseTargets = {
  connector: string;
  formula: string;
  label: string;
  note: string;
  plane: string;
  shape: string;
};

/** The dense board, made on an unthrottled page and saved, answer by answer
 * (strokes, plane cards, formulas, notes, shapes, a connector, a label). Its
 * notes sit under every canvas element, as notes placed before the drawing
 * (a question's cards) do, so all 200 canvas elements share one canvas: the
 * most a canvas element's change can have to draw again. */
export async function makeDenseBoard(browser: Browser) {
  const page = await browser.newPage();
  await openBoard(page);
  const targets = await page.evaluate(
    ({ dense, STROKE_POINTS }) => {
      const { gfx, std } = document.querySelector(
        'affine-edgeless-root'
      ) as Root;
      const { store } = std;
      // Without the dev page's own plane card: the answers bring theirs.
      for (const element of [...gfx.layer.canvasElements] as {
        id: string;
        type: string;
      }[])
        if (element.type === 'plane') gfx.surface.deleteElement(element.id);
      let seed = 11;
      const random = () => {
        seed = (seed * 16_807) % 2_147_483_647;
        return seed / 2_147_483_647;
      };
      const { answer } = dense;
      // Order keys for a plane's elements: `a` and one base-62 digit.
      const DIGITS =
        '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const keyed = (elements: ({ id: string } & Record<string, unknown>)[]) =>
        Object.fromEntries(
          elements.map((element, i) => [
            element.id,
            { element, order: `a${DIGITS[i]}` },
          ])
        );
      // What a student marks on a plane: four named points, a segment, a curve,
      // a line and two labels.
      const planeElements = (n: number) =>
        keyed([
          ...['A', 'B', 'C', 'D'].map((name, i) => ({
            coords: [1 + i * 3, 1 + ((i * 2 + n) % 5)],
            id: `p${n}-${i}`,
            name,
            type: 'point',
          })),
          { id: `s${n}`, points: [`p${n}-0`, `p${n}-1`], type: 'segment' },
          {
            coords: [
              [0, 0],
              [2, 3],
              [4, 1],
              [7, 4],
              [10, 2],
            ],
            id: `c${n}`,
            type: 'curve',
          },
          {
            coords: [
              [0, 6],
              [14, -2],
            ],
            id: `l${n}`,
            type: 'polyline',
          },
          { coords: [3, 6], id: `t${n}-0`, text: 'v = 3 m/s', type: 'text' },
          { coords: [11, 5], id: `t${n}-1`, text: 'max', type: 'text' },
        ]);
      const targets: Record<string, string> = {};
      let planes = 0;
      let formulas = 0;
      let notes = 0;
      for (let a = 0; a < dense.answers; a++) {
        const ox = (a % 4) * (answer.w + answer.gap);
        const oy = Math.floor(a / 4) * (answer.h + answer.gap);
        const at = (x: number, y: number, w: number, h: number) =>
          `[${ox + x},${oy + y},${w},${h}]`;
        for (let i = 0; i < dense.strokes; i++) {
          let x = 40 + random() * 1000;
          let y = 880 + random() * 260;
          const points: [number, number][] = [];
          for (let p = 0; p < STROKE_POINTS; p++) {
            x += (random() - 0.5) * 24;
            y += (random() - 0.5) * 24;
            points.push([ox + x, oy + y]);
          }
          gfx.surface.addElement({
            color: '#1f2937',
            lineWidth: 4,
            points,
            type: 'brush',
          });
        }
        // Three plane cards an answer, the remainder in the first.
        const planeSpots: [number, number][] = [
          [40, 40],
          [640, 40],
          [1240, 40],
          [1240, 760],
        ];
        const planesHere =
          Math.floor(dense.planes / dense.answers) +
          (a === 0 ? dense.planes % dense.answers : 0);
        for (let i = 0; i < planesHere; i++) {
          const [x, y] = planeSpots[i];
          const id = gfx.surface.addElement({
            elements: planeElements(planes),
            fit: false,
            polar: false,
            ppu: 30,
            type: 'plane',
            x0: -1,
            xywh: at(x, y, 520, 340),
            y0: (340 * 0.7) / 30,
          });
          targets.plane ??= id;
          planes++;
        }
        for (let i = 0; i < dense.formulas / dense.answers; i++) {
          const id = gfx.surface.addElement({
            latex: `\\frac{${formulas}x^2+1}{\\sqrt{x+${i}}}`,
            type: 'formula',
            xywh: at(40 + i * 230, 420, 160, 60),
          });
          targets.formula ??= id;
          formulas++;
        }
        for (let i = 0; i < dense.notes / dense.answers; i++) {
          const note = store.addBlock(
            'affine:note',
            {
              xywh: at(40 + i * 300, 540, 260, 120),
            },
            store.root.id
          );
          for (let p = 0; p < 2; p++) {
            const paragraph = store.addBlock('affine:paragraph', {}, note);
            store
              .getBlock(paragraph)
              .model.props.text.insert(
                `Card ${notes + 1}, line ${p + 1}: the force is mass times acceleration.`,
                0
              );
          }
          targets.note ??= note;
          notes++;
        }
        const shape = gfx.surface.addElement({
          shapeType: 'rect',
          text: 'F = ma',
          type: 'shape',
          xywh: at(400, 780, 140, 70),
        });
        const next = gfx.surface.addElement({
          shapeType: 'ellipse',
          text: 'a = F/m',
          type: 'shape',
          xywh: at(800, 780, 140, 70),
        });
        const connector = gfx.surface.addElement({
          source: { id: shape },
          target: { id: next },
          type: 'connector',
        });
        const label = gfx.surface.addElement({
          text: 'Label',
          type: 'text',
          xywh: at(40, 790, 80, 30),
        });
        targets.shape ??= shape;
        targets.connector ??= connector;
        targets.label ??= label;
      }
      return targets as DenseTargets;
    },
    { dense: DENSE, STROKE_POINTS }
  );
  const made = await saveMeasured(page);
  await page.close();
  return { ...made, targets };
}

/** The places a student types on a board, on the dense board's first answer:
 * a canvas label, a shape's label, a connector's label, a note card, a formula
 * card, and a plane card's own label in its editor. */
export const TYPING_PATHS = [
  'label',
  'shape',
  'connector',
  'note',
  'formula',
  'plane',
] as const;
export type TypingPath = (typeof TYPING_PATHS)[number];

/** Where an element or block of the board is on the page, in CSS pixels; `at`
 * is a point inside it as a share of its width and height. */
export const screenOf = (
  page: Page,
  id: string,
  at: [number, number] = [0.5, 0.5]
) =>
  page.evaluate(
    ({ at, id }) => {
      const root = document.querySelector('affine-edgeless-root') as Root & {
        gfx: {
          getElementById(id: string): { xywh: string } | null;
          viewport: { left: number; top: number };
        };
      };
      const model = root.gfx.getElementById(id);
      if (!model) throw new Error(`no ${id}`);
      const [x, y, w, h] = JSON.parse(model.xywh) as number[];
      const { viewport } = root.gfx;
      const [vx, vy] = viewport.toViewCoord(x + w * at[0], y + h * at[1]);
      return [vx + viewport.left, vy + viewport.top] as [number, number];
    },
    { at, id }
  );

/** Opens the path's editor on the first answer's element; resolves once typing
 * goes into it, and returns how to read what was typed. */
export async function startTyping(
  page: Page,
  path: TypingPath,
  targets: DenseTargets
) {
  const focused = (selector: string) =>
    page.waitForFunction(
      (selector) => {
        // Through shadow roots: a math-field's focus is inside its own.
        for (
          let active = document.activeElement;
          active;
          active = active.shadowRoot?.activeElement ?? null
        )
          if (active.closest(selector)) return true;
        return false;
      },
      selector,
      { timeout: 30_000 }
    );
  switch (path) {
    case 'label': {
      const [x, y] = await screenOf(page, targets.label);
      await page.mouse.dblclick(x, y);
      await focused('edgeless-text-editor');
      await page.keyboard.press('End');
      return () => page.locator('edgeless-text-editor').innerText();
    }
    case 'shape': {
      const [x, y] = await screenOf(page, targets.shape);
      await page.mouse.dblclick(x, y);
      await focused('edgeless-shape-text-editor');
      await page.keyboard.press('End');
      return () => page.locator('edgeless-shape-text-editor').innerText();
    }
    case 'connector': {
      // Halfway along the connector, between its two shapes.
      const [x, y] = await screenOf(page, targets.shape, [1.93, 0.5]);
      await page.mouse.dblclick(x, y);
      await focused('edgeless-connector-label-editor');
      return () => page.locator('edgeless-connector-label-editor').innerText();
    }
    case 'note': {
      const [x, y] = await screenOf(page, targets.note, [0.3, 0.2]);
      await page.mouse.dblclick(x, y);
      await focused('affine-edgeless-note');
      await page.keyboard.press('End');
      return () =>
        page
          .locator(`affine-edgeless-note[data-block-id="${targets.note}"]`)
          .innerText();
    }
    case 'formula': {
      const [x, y] = await screenOf(page, targets.formula);
      await page.mouse.dblclick(x, y);
      await focused('math-field');
      return () =>
        page.evaluate(
          () =>
            (
              document.querySelector('.capy-formula math-field') as
                | (HTMLElement & { value: string })
                | null
            )?.value ?? ''
        );
    }
    case 'plane': {
      const [x, y] = await screenOf(page, targets.plane);
      await page.mouse.dblclick(x, y);
      const editor = page.locator('.capy-graph-editor canvas').first();
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await editor.focus();
      await page.keyboard.press('t');
      // Empty paper, up and right of the card's marks, clear of the objects
      // list a workspace's editor opens at its top left.
      const box = await editor.boundingBox();
      if (!box) throw new Error('no plane editor');
      await page.mouse.click(
        box.x + box.width * 0.85,
        box.y + box.height * 0.2
      );
      await focused('.capy-graph-editor input');
      return () =>
        page.locator('.capy-graph-editor input').first().inputValue();
    }
  }
}
