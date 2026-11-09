import type { Browser, Page } from '@playwright/test';

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
      blocks: { id: string; xywh: string }[];
      canvasElements: unknown[];
    };
    surface: { addElement(props: object): string };
    viewport: { toViewCoord(x: number, y: number): [number, number] };
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

/** A board of the given size, made on an unthrottled page and saved. */
export async function makeBoard(browser: Browser, size: Size) {
  const page = await browser.newPage();
  await openBoard(page);
  const made = await page.evaluate(
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
      const board = window.__board;
      if (!board) throw new Error('no board');
      const stats = board.stats();
      return {
        expected: { blocks: stats.blocks.length, canvas: stats.canvas.length },
        saved: board.save(),
      };
    },
    { size, STROKE_POINTS }
  );
  await page.close();
  return made;
}

