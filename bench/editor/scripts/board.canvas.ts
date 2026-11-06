import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CPU_RATE, percentile, reportMetrics, throttleCpu } from './metrics';

/**
 * The drawing board (BlockSuite's edgeless editor, `/dev/drawing`) in a production
 * build (Q686 A): a blank board's cold open at 1x, then at CPU_RATE (4x by default)
 * a typical board's and a large one's cold opens, and on each panning, zooming, a
 * pen stroke and typing in a note card, each input's delay to its painted frame.
 * Gated: the blank and typical cold opens and the typical board's inputs. Reported
 * only: warm opens, the large board and the bytes each open downloads.
 *
 * Both boards are made in the page through BlockSuite's own API and saved, so they
 * always match the board's current format: strokes, shapes, formulas and note
 * cards around the plane card.
 */

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.results',
  'canvas-dist'
);

type Size = {
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
const TYPICAL: Size = {
  formulas: 2,
  height: 520,
  notes: 2,
  paragraphs: 2,
  shapes: 3,
  strokes: 40,
  width: 820,
};
/** Far past an answer: what the board must still handle. */
const LARGE: Size = {
  formulas: 10,
  height: 1600,
  notes: 30,
  paragraphs: 3,
  shapes: 30,
  strokes: 200,
  width: 2400,
};
const STROKE_POINTS = 30;
/** Cold opens per board; the median is the run's figure. */
const OPENS = 3;
const WHEELS = 20;
const WHEEL_CADENCE_MS = 100;
const PEN_MOVES = 40;
const PEN_CADENCE_MS = 32;
const KEYS = 30;
const KEY_CADENCE_MS = 100;

/** The typical board's gated figures. */
type Timings = {
  /** The blank board's cold open, at 1x. */
  blankOpenMs: number;
  /** The typical board's cold open, at CPU_RATE. */
  openMs: number;
  panP90Ms: number;
  penP90Ms: number;
  typingP90Ms: number;
  zoomP90Ms: number;
};

/**
 * Medians of three `canvas` job runs of the Performance workflow, as Office's are:
 * 42252998330, 42253016137 and 42253034659 on 630705a96 (2026-11-07). The first
 * calibration (7d470b2e5, on 4cf06a4b6) measured the large board and the blank open
 * at 4x, so it doesn't carry over.
 */
const MEDIANS: Timings | null = {
  blankOpenMs: 807,
  openMs: 2921,
  panP90Ms: 43,
  penP90Ms: 33,
  typingP90Ms: 22,
  zoomP90Ms: 76,
};

/** No input budget goes below this: a one-frame wobble fails anything smaller. */
const INPUT_BUDGET_FLOOR_MS = 30;

/** 1.3x the median, Office's rule: rounded up to 5 ms below a second, 50 ms above. */
function budgetOf(median: Timings): Timings {
  const limit = (ms: number) => {
    const scaled = Math.round(ms * 130) / 100;
    const step = scaled < 1000 ? 5 : 50;
    return Math.ceil(scaled / step) * step;
  };
  const input = (ms: number) => Math.max(INPUT_BUDGET_FLOOR_MS, limit(ms));
  return {
    blankOpenMs: limit(median.blankOpenMs),
    openMs: limit(median.openMs),
    panP90Ms: input(median.panP90Ms),
    penP90Ms: input(median.penP90Ms),
    typingP90Ms: input(median.typingP90Ms),
    zoomP90Ms: input(median.zoomP90Ms),
  };
}

type Expected = { blocks: number; canvas: number };

declare global {
  interface Window {
    __benchBoard?: string;
    __benchExpected?: Expected;
    __benchOpen?: {
      loafs: { blocking: number; end: number }[];
      painted?: number;
    };
    __benchInputs?: { at: number[]; presents: number[] };
    __board?: {
      save(): { bytes: number; doc: string };
      stats(): { blocks: string[]; canvas: string[] };
    };
  }
}

/** What the board's page exposes on its root element, as far as the bench uses it. */
type Root = HTMLElement & {
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

async function openBoard(page: Page) {
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
async function makeBoard(browser: Browser, size: Size) {
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

/**
 * A cold open in a fresh context at `rate`, then a warm one (the build's files
 * cached) on the same page: each from navigation to the first frame after the
 * board holds every element, and the long frames up to 5 s later.
 */
async function openTwice(
  browser: Browser,
  rate: number,
  expected: Expected,
  saved?: string
) {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ expected, saved }) => {
      if (saved) window.__benchBoard = saved;
      window.__benchExpected = expected;
      const open: NonNullable<Window['__benchOpen']> = { loafs: [] };
      window.__benchOpen = open;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const loaf = entry as PerformanceEntry & {
            blockingDuration?: number;
          };
          open.loafs.push({
            blocking: loaf.blockingDuration ?? 0,
            end: loaf.startTime + loaf.duration,
          });
        }
      }).observe({
        buffered: true,
        type: 'long-animation-frame',
      } as PerformanceObserverInit);
      const watch = () => {
        const root = document.querySelector('affine-edgeless-root') as
          | (HTMLElement & {
              gfx?: { layer: { blocks: unknown[]; canvasElements: unknown[] } };
            })
          | null;
        const layer = root?.gfx?.layer;
        if (
          layer &&
          layer.canvasElements.length >= expected.canvas &&
          layer.blocks.length >= expected.blocks
        ) {
          // The first task after the next frame: that frame drew the full board.
          requestAnimationFrame(() => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
              open.painted = performance.now();
            };
            channel.port2.postMessage(null);
          });
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    },
    { expected, saved }
  );
  await throttleCpu(page, rate);
  const cold = await measureOpen(page);
  const warm = await measureOpen(page);
  await context.close();
  return { cold, warm };
}

async function measureOpen(page: Page) {
  await page.goto('/dev/drawing');
  await page.waitForFunction(
    () => window.__benchOpen?.painted !== undefined,
    null,
    {
      polling: 250,
      timeout: 180_000,
    }
  );
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const open = window.__benchOpen;
    if (!open?.painted) throw new Error('never painted');
    const [mountStart] = performance.getEntriesByName('board:mount-start');
    const [mountEnd] = performance.getEntriesByName('board:mount-end');
    const later = open.loafs.filter(
      (loaf) => loaf.end <= (open.painted as number) + 5000
    );
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((name) => /\.(js|css)$/.test(name));
    return {
      mountMs:
        mountEnd && mountStart
          ? mountEnd.startTime - mountStart.startTime
          : null,
      mountStartMs: mountStart?.startTime ?? null,
      paintedMs: open.painted,
      resources,
      settledMs: Math.max(open.painted, ...later.map((loaf) => loaf.end)),
      totalBlockingMs: later.reduce((sum, loaf) => sum + loaf.blocking, 0),
    };
  });
}

const median = (values: number[]) => percentile(values, 50);
const round = (ms: number) => Math.round(ms);

type Open = Awaited<ReturnType<typeof measureOpen>>;

/** The median of each figure over the runs. */
const summary = (runs: Open[]) => ({
  mountMs: round(median(runs.map((run) => run.mountMs ?? 0))),
  paintedMs: round(median(runs.map((run) => run.paintedMs))),
  paintedRunsMs: runs.map((run) => round(run.paintedMs)),
  settledMs: round(median(runs.map((run) => run.settledMs))),
  totalBlockingMs: round(median(runs.map((run) => run.totalBlockingMs))),
});

/** OPENS cold opens, each followed by a warm one; the cold ones' files for bytes. */
async function opens(
  browser: Browser,
  rate: number,
  expected: Expected,
  saved?: string
) {
  const runs = [];
  for (let i = 0; i < OPENS; i++)
    runs.push(await openTwice(browser, rate, expected, saved));
  return {
    cold: summary(runs.map((run) => run.cold)),
    resources: runs[0].cold.resources,
    warm: summary(runs.map((run) => run.warm)),
  };
}

/** The JS and CSS an open requested, raw and gzipped, from the build. */
async function bytesOf(resources: string[]) {
  const files = await Promise.all(
    [...new Set(resources)].map(async (name) => {
      const body = await readFile(path.join(OUT_DIR, name));
      return { gzip: gzipSync(body).byteLength, name, raw: body.byteLength };
    })
  );
  const kb = (bytes: number) => Math.round(bytes / 102.4) / 10;
  return {
    files: files.length,
    gzipKb: kb(files.reduce((sum, file) => sum + file.gzip, 0)),
    largest: [...files]
      .sort((a, b) => b.gzip - a.gzip)
      .slice(0, 5)
      .map((file) => ({ gzipKb: kb(file.gzip), name: file.name })),
    rawKb: kb(files.reduce((sum, file) => sum + file.raw, 0)),
  };
}

/**
 * Times each input from its first event to the first task after the next frame,
 * rescheduled by the input's later events (the latest wins), as Office times keys.
 */
async function installInputProbe(
  page: Page,
  starts: string[],
  follows: string[]
) {
  await page.evaluate(
    ({ follows, starts }) => {
      const inputs = { at: [] as number[], presents: [] as number[] };
      window.__benchInputs = inputs;
      const afterFrame = () => {
        const index = inputs.at.length - 1;
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            inputs.presents[index] = performance.now();
          };
          channel.port2.postMessage(null);
        });
      };
      for (const type of starts)
        window.addEventListener(
          type,
          () => {
            inputs.at.push(performance.now());
            afterFrame();
          },
          { capture: true, passive: true }
        );
      for (const type of follows)
        window.addEventListener(type, afterFrame, {
          capture: true,
          passive: true,
        });
    },
    { follows, starts }
  );
}

/** Each input's delay to its frame, once the last one has one (30 s at most). */
async function inputDelays(page: Page) {
  await page.waitForFunction(
    () => {
      const inputs = window.__benchInputs;
      return !!inputs && inputs.presents[inputs.at.length - 1] !== undefined;
    },
    null,
    { polling: 100, timeout: 30_000 }
  );
  const delays = await page.evaluate(() => {
    const inputs = window.__benchInputs;
    if (!inputs) throw new Error('no probe');
    return inputs.at.map((at, i) => (inputs.presents[i] ?? Number.NaN) - at);
  });
  const painted = delays.filter((delay) => Number.isFinite(delay));
  return {
    inputs: delays.length,
    maxMs: round(Math.max(...painted)),
    p50Ms: round(percentile(painted, 50)),
    p90Ms: round(percentile(painted, 90)),
    unpainted: delays.length - painted.length,
  };
}

/** A point on the first note card's last line: its centre can fall between lines. */
const noteLine = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as Root;
    const { id } = root.gfx.layer.blocks[0];
    const lines = document.querySelectorAll(
      `affine-edgeless-note[data-block-id="${id}"] affine-paragraph`
    );
    const line = lines[lines.length - 1]?.getBoundingClientRect();
    if (!line) throw new Error('no note line');
    return [line.left + 20, line.top + line.height / 2] as const;
  });

/** Typing, a pen stroke, pans and zooms on one page holding the saved board. */
async function interactions(browser: Browser, saved: string, errors: string[]) {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((saved) => {
    window.__benchBoard = saved;
  }, saved);
  await openBoard(page);
  await page.waitForTimeout(2000);
  await throttleCpu(page, CPU_RATE);

  // Typing first, while the open's fit keeps the first card in view.
  const [lineX, lineY] = await noteLine(page);
  await page.mouse.dblclick(lineX, lineY);
  await page.waitForFunction(
    () => !!document.activeElement?.closest('affine-edgeless-note'),
    null,
    { timeout: 30_000 }
  );
  await page.keyboard.press('End');
  await page.waitForTimeout(500);
  await installInputProbe(page, ['keydown'], ['keypress', 'input']);
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.press(i % 6 === 5 ? 'Space' : 'a');
    await page.waitForTimeout(KEY_CADENCE_MS);
  }
  const typing = await inputDelays(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(
    page.locator('affine-edgeless-note', { hasText: 'aaaaa a' })
  ).toHaveCount(1);

  // A pen stroke across the middle.
  const brushes = async () =>
    (await page.evaluate(() => window.__board?.stats().canvas ?? [])).filter(
      (type) => type === 'brush'
    ).length;
  const brushesBefore = await brushes();
  await page.locator('edgeless-pen-tool-button').first().click();
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await installInputProbe(page, ['pointermove'], []);
  for (let i = 1; i <= PEN_MOVES; i++) {
    await page.mouse.move(400 + i * 10, 400 + Math.sin(i / 4) * 80);
    await page.waitForTimeout(PEN_CADENCE_MS);
  }
  const pen = await inputDelays(page);
  await page.mouse.up();
  await expect.poll(brushes).toBe(brushesBefore + 1);
  await page.keyboard.press('v');

  // Panning and zooming with the wheel over the canvas.
  await page.mouse.move(640, 400);
  await installInputProbe(page, ['wheel'], []);
  for (let i = 0; i < WHEELS; i++) {
    await page.mouse.wheel(0, i < WHEELS / 2 ? 120 : -120);
    await page.waitForTimeout(WHEEL_CADENCE_MS);
  }
  const pan = await inputDelays(page);
  await installInputProbe(page, ['wheel'], []);
  await page.keyboard.down('Control');
  for (let i = 0; i < WHEELS; i++) {
    await page.mouse.wheel(0, i < WHEELS / 2 ? -60 : 60);
    await page.waitForTimeout(WHEEL_CADENCE_MS);
  }
  await page.keyboard.up('Control');
  const zoom = await inputDelays(page);
  await context.close();

  return { pan, pen, typing, zoom };
}

test('the drawing board opens and responds within its budgets', async ({
  browser,
}, testInfo) => {
  const errors: string[] = [];
  const typical = await makeBoard(browser, TYPICAL);
  const large = await makeBoard(browser, LARGE);

  // Blank: the plane card alone, as a new answer opens.
  const blankOpen = await opens(browser, 1, { blocks: 0, canvas: 1 });
  const typicalOpen = await opens(
    browser,
    CPU_RATE,
    typical.expected,
    typical.saved.doc
  );
  const largeOpen = await opens(
    browser,
    CPU_RATE,
    large.expected,
    large.saved.doc
  );

  const onTypical = await interactions(browser, typical.saved.doc, errors);
  const onLarge = await interactions(browser, large.saved.doc, errors);

  const timings: Timings = {
    blankOpenMs: blankOpen.cold.paintedMs,
    openMs: typicalOpen.cold.paintedMs,
    panP90Ms: onTypical.pan.p90Ms,
    penP90Ms: onTypical.pen.p90Ms,
    typingP90Ms: onTypical.typing.p90Ms,
    zoomP90Ms: onTypical.zoom.p90Ms,
  };
  const budget = MEDIANS ? budgetOf(MEDIANS) : 'uncalibrated';
  const opened = ({ cold, warm }: typeof blankOpen) => ({ cold, warm });
  // Gated: `timings`. Report-only: warm opens, the large board and the bytes.
  await reportMetrics(testInfo, 'canvas-board', {
    blank: { cpu: 1, open: opened(blankOpen) },
    boards: {
      large: { bytes: large.saved.bytes, ...large.expected },
      typical: { bytes: typical.saved.bytes, ...typical.expected },
    },
    budget,
    bytes: {
      blank: await bytesOf(blankOpen.resources),
      large: await bytesOf(largeOpen.resources),
      typical: await bytesOf(typicalOpen.resources),
    },
    large: { open: opened(largeOpen), ...onLarge },
    timings,
    typical: { open: opened(typicalOpen), ...onTypical },
  });

  expect(errors).toEqual([]);
  for (const steps of [onTypical, onLarge])
    for (const step of Object.values(steps)) expect(step.unpainted).toBe(0);
  if (budget === 'uncalibrated') return;
  for (const key of Object.keys(timings) as (keyof Timings)[])
    expect.soft(timings[key], key).toBeLessThanOrEqual(budget[key]);
});
