import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { CPU_RATE, percentile, reportMetrics, throttleCpu } from "./metrics";

/**
 * The drawing board (BlockSuite's edgeless editor, `/dev/drawing`) in a production
 * build: a cold open of an empty board and of a large one, then on the large one
 * panning, zooming, a pen stroke and typing in a note card, each input's delay to
 * its painted frame, all at CPU_RATE (4x by default). The bytes the open downloads
 * are reported, never gated.
 *
 * The large board is made in the page through BlockSuite's own API and saved, so it
 * always matches the board's current format: strokes, shapes, formulas and note
 * cards over the plane card.
 */

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".results",
  "canvas-dist",
);

const STROKES = 200;
const STROKE_POINTS = 30;
const SHAPES = 30;
const FORMULAS = 10;
const NOTES = 30;
const NOTE_PARAGRAPHS = 3;
/** Cold opens per board; the median is the run's figure. */
const OPENS = 3;
const WHEELS = 20;
const WHEEL_CADENCE_MS = 100;
const PEN_MOVES = 40;
const PEN_CADENCE_MS = 32;
const KEYS = 30;
const KEY_CADENCE_MS = 100;

type Timings = {
  emptyOpenMs: number;
  largeOpenMs: number;
  panP90Ms: number;
  penP90Ms: number;
  typingP90Ms: number;
  zoomP90Ms: number;
};

/**
 * Medians of three `canvas` job runs of the Performance workflow, as Office's are.
 * Null until those runs are recorded: the bench then reports and gates nothing.
 */
const MEDIANS: Timings | null = null;

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
    emptyOpenMs: limit(median.emptyOpenMs),
    largeOpenMs: limit(median.largeOpenMs),
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
  await page.goto("/dev/drawing");
  await page.waitForFunction(
    () => window.__board?.stats().canvas.includes("plane"),
    null,
    {
      timeout: 120_000,
    },
  );
}

/** The large board, made on an unthrottled page and saved. */
async function makeLargeBoard(browser: Browser) {
  const page = await browser.newPage();
  await openBoard(page);
  const made = await page.evaluate(
    ({ FORMULAS, NOTE_PARAGRAPHS, NOTES, SHAPES, STROKE_POINTS, STROKES }) => {
      const { gfx, std } = document.querySelector(
        "affine-edgeless-root",
      ) as Root;
      const { store } = std;
      // A fixed sequence, so every run draws the same board.
      let seed = 7;
      const random = () => {
        seed = (seed * 16_807) % 2_147_483_647;
        return seed / 2_147_483_647;
      };
      const WIDTH = 2400;
      const HEIGHT = 1600;
      for (let i = 0; i < STROKES; i++) {
        let x = random() * WIDTH;
        let y = random() * HEIGHT;
        const points: [number, number][] = [];
        for (let p = 0; p < STROKE_POINTS; p++) {
          x += (random() - 0.5) * 24;
          y += (random() - 0.5) * 24;
          points.push([x, y]);
        }
        gfx.surface.addElement({
          color: "#1f2937",
          lineWidth: 4,
          points,
          type: "brush",
        });
      }
      for (let i = 0; i < SHAPES; i++)
        gfx.surface.addElement({
          shapeType: i % 2 ? "ellipse" : "rect",
          type: "shape",
          xywh: `[${random() * WIDTH},${random() * HEIGHT},90,60]`,
        });
      for (let i = 0; i < FORMULAS; i++)
        gfx.surface.addElement({
          latex: `\\frac{${i}x^2+1}{\\sqrt{x+${i}}}`,
          type: "formula",
          xywh: `[${random() * WIDTH},${random() * HEIGHT},160,60]`,
        });
      for (let i = 0; i < NOTES; i++) {
        const note = store.addBlock(
          "affine:note",
          {
            // Below the plane card, whose double click opens the plane.
            xywh: `[${(i % 6) * 400},${700 + Math.floor(i / 6) * 320},260,120]`,
          },
          store.root.id,
        );
        for (let p = 0; p < NOTE_PARAGRAPHS; p++) {
          const paragraph = store.addBlock("affine:paragraph", {}, note);
          store
            .getBlock(paragraph)
            .model.props.text.insert(
              `Card ${i + 1}, line ${p + 1}: the force on the block is mass times acceleration.`,
              0,
            );
        }
      }
      const board = window.__board;
      if (!board) throw new Error("no board");
      const stats = board.stats();
      return {
        expected: { blocks: stats.blocks.length, canvas: stats.canvas.length },
        saved: board.save(),
      };
    },
    { FORMULAS, NOTE_PARAGRAPHS, NOTES, SHAPES, STROKE_POINTS, STROKES },
  );
  await page.close();
  return made;
}

/**
 * One cold open in a fresh context at CPU_RATE: from navigation to the first frame
 * after the board holds every element, and the long frames up to 5 s later.
 */
async function coldOpen(browser: Browser, expected: Expected, saved?: string) {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ expected, saved }) => {
      if (saved) window.__benchBoard = saved;
      window.__benchExpected = expected;
      const open: NonNullable<Window["__benchOpen"]> = { loafs: [] };
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
        type: "long-animation-frame",
      } as PerformanceObserverInit);
      const watch = () => {
        const root = document.querySelector("affine-edgeless-root") as
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
    { expected, saved },
  );
  await throttleCpu(page, CPU_RATE);
  await page.goto("/dev/drawing");
  await page.waitForFunction(
    () => window.__benchOpen?.painted !== undefined,
    null,
    {
      polling: 250,
      timeout: 180_000,
    },
  );
  await page.waitForTimeout(5000);
  const result = await page.evaluate(() => {
    const open = window.__benchOpen;
    if (!open?.painted) throw new Error("never painted");
    const [mountStart] = performance.getEntriesByName("board:mount-start");
    const [mountEnd] = performance.getEntriesByName("board:mount-end");
    const later = open.loafs.filter(
      (loaf) => loaf.end <= (open.painted as number) + 5000,
    );
    const resources = performance
      .getEntriesByType("resource")
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
  await context.close();
  return result;
}

const median = (values: number[]) => percentile(values, 50);
const round = (ms: number) => Math.round(ms);

async function coldOpens(browser: Browser, expected: Expected, saved?: string) {
  const runs = [];
  for (let i = 0; i < OPENS; i++)
    runs.push(await coldOpen(browser, expected, saved));
  return {
    mountMs: round(median(runs.map((run) => run.mountMs ?? 0))),
    paintedMs: round(median(runs.map((run) => run.paintedMs))),
    paintedRunsMs: runs.map((run) => round(run.paintedMs)),
    resources: runs[0].resources,
    settledMs: round(median(runs.map((run) => run.settledMs))),
    totalBlockingMs: round(median(runs.map((run) => run.totalBlockingMs))),
  };
}

/** The JS and CSS an open requested, raw and gzipped, from the build. */
async function bytesOf(resources: string[]) {
  const files = await Promise.all(
    [...new Set(resources)].map(async (name) => {
      const body = await readFile(path.join(OUT_DIR, name));
      return { gzip: gzipSync(body).byteLength, name, raw: body.byteLength };
    }),
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
  follows: string[],
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
          { capture: true, passive: true },
        );
      for (const type of follows)
        window.addEventListener(type, afterFrame, {
          capture: true,
          passive: true,
        });
    },
    { follows, starts },
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
    { polling: 100, timeout: 30_000 },
  );
  const delays = await page.evaluate(() => {
    const inputs = window.__benchInputs;
    if (!inputs) throw new Error("no probe");
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

/** A note card's centre on screen. */
const noteCentre = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector("affine-edgeless-root") as Root;
    const note = root.gfx.layer.blocks[0];
    const [x, y, w, h] = JSON.parse(note.xywh) as number[];
    const rect = root.getBoundingClientRect();
    const [left, top] = root.gfx.viewport.toViewCoord(x + w / 2, y + h / 2);
    return [rect.x + left, rect.y + top] as const;
  });

test("the drawing board opens and responds within its budgets", async ({
  browser,
}, testInfo) => {
  const errors: string[] = [];
  const large = await makeLargeBoard(browser);

  const empty = await coldOpens(browser, { blocks: 0, canvas: 1 });
  const largeOpen = await coldOpens(browser, large.expected, large.saved.doc);

  // The interactions, on one page holding the large board.
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((saved) => {
    window.__benchBoard = saved;
  }, large.saved.doc);
  await openBoard(page);
  await page.waitForTimeout(2000);
  await throttleCpu(page, CPU_RATE);

  // Typing first, while the open's fit keeps the first card in view.
  const [noteX, noteY] = await noteCentre(page);
  await page.mouse.dblclick(noteX, noteY);
  await page.waitForFunction(
    () => !!document.activeElement?.closest("affine-edgeless-note"),
  );
  await page.keyboard.press("End");
  await page.waitForTimeout(500);
  await installInputProbe(page, ["keydown"], ["keypress", "input"]);
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.press(i % 6 === 5 ? "Space" : "a");
    await page.waitForTimeout(KEY_CADENCE_MS);
  }
  const typing = await inputDelays(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(
    page.locator("affine-edgeless-note", { hasText: "aaaaa a" }),
  ).toHaveCount(1);

  // A pen stroke across the middle.
  const brushes = async () =>
    (await page.evaluate(() => window.__board?.stats().canvas ?? [])).filter(
      (type) => type === "brush",
    ).length;
  const brushesBefore = await brushes();
  await page.locator("edgeless-pen-tool-button").first().click();
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await installInputProbe(page, ["pointermove"], []);
  for (let i = 1; i <= PEN_MOVES; i++) {
    await page.mouse.move(400 + i * 10, 400 + Math.sin(i / 4) * 80);
    await page.waitForTimeout(PEN_CADENCE_MS);
  }
  const pen = await inputDelays(page);
  await page.mouse.up();
  await expect.poll(brushes).toBe(brushesBefore + 1);
  await page.keyboard.press("v");

  // Panning and zooming with the wheel over the canvas.
  await page.mouse.move(640, 400);
  await installInputProbe(page, ["wheel"], []);
  for (let i = 0; i < WHEELS; i++) {
    await page.mouse.wheel(0, i < WHEELS / 2 ? 120 : -120);
    await page.waitForTimeout(WHEEL_CADENCE_MS);
  }
  const pan = await inputDelays(page);
  await installInputProbe(page, ["wheel"], []);
  await page.keyboard.down("Control");
  for (let i = 0; i < WHEELS; i++) {
    await page.mouse.wheel(0, i < WHEELS / 2 ? -60 : 60);
    await page.waitForTimeout(WHEEL_CADENCE_MS);
  }
  await page.keyboard.up("Control");
  const zoom = await inputDelays(page);
  await context.close();

  const timings: Timings = {
    emptyOpenMs: empty.paintedMs,
    largeOpenMs: largeOpen.paintedMs,
    panP90Ms: pan.p90Ms,
    penP90Ms: pen.p90Ms,
    typingP90Ms: typing.p90Ms,
    zoomP90Ms: zoom.p90Ms,
  };
  const budget = MEDIANS ? budgetOf(MEDIANS) : "uncalibrated";
  await reportMetrics(testInfo, "canvas-board", {
    board: {
      bytes: large.saved.bytes,
      ...large.expected,
    },
    budget,
    bytes: {
      empty: await bytesOf(empty.resources),
      large: await bytesOf(largeOpen.resources),
    },
    open: {
      empty: { ...empty, resources: undefined },
      large: { ...largeOpen, resources: undefined },
    },
    pan,
    pen,
    timings,
    typing,
    zoom,
  });

  expect(errors).toEqual([]);
  for (const step of [typing, pen, pan, zoom]) expect(step.unpainted).toBe(0);
  if (budget === "uncalibrated") return;
  for (const key of Object.keys(timings) as (keyof Timings)[])
    expect.soft(timings[key], key).toBeLessThanOrEqual(budget[key]);
});
