import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Browser, type Page, test } from '@playwright/test';
import {
  type Expected,
  LARGE,
  makeBoard,
  openBoard,
  TYPICAL,
} from './canvasBoards';
import { percentile, reportMetrics, throttleCpu } from './metrics';

/**
 * How long the drawing board takes to show, report only (Epo 2026-11-07, "how long
 * does it take to draw the board?"):
 * - a cold open of the full board in stages: the board's chunk downloading, its
 *   parse and evaluate (chunk done to mount start), the mount, and the first frame
 *   holding every element; locally and over a 10 Mbps, 50 ms link;
 * - `drawBoardPreview` (the SVG drawn from the saved data, no editor) on the
 *   typical and large boards: the string, then the image's decode and paint.
 * Each at 1x and 4x CPU. Run with: pnpm bench:canvas board-stages
 */

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.results',
  'canvas-dist'
);
const OPENS = 3;
const PREVIEW_RUNS = 10;
const RATES = [1, 4];
const NETWORKS = {
  local: null,
  '10mbps': { download: (10e6 / 8) | 0, latency: 50, upload: (5e6 / 8) | 0 },
};
/** A list row's preview, and the answer area's. */
const PREVIEW_SIZES = [
  { height: 120, width: 180 },
  { height: 400, width: 600 },
];

const median = (values: number[]) => Math.round(percentile(values, 50));

async function coldOpen(
  browser: Browser,
  rate: number,
  network: (typeof NETWORKS)[keyof typeof NETWORKS],
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
      const watch = () => {
        const layer = (
          document.querySelector('affine-edgeless-root') as
            | (HTMLElement & {
                gfx?: {
                  layer: { blocks: unknown[]; canvasElements: unknown[] };
                };
              })
            | null
        )?.gfx?.layer;
        if (
          layer &&
          layer.canvasElements.length >= expected.canvas &&
          layer.blocks.length >= expected.blocks
        ) {
          requestAnimationFrame(() => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () =>
              performance.mark('board:painted');
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
  if (network) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      downloadThroughput: network.download,
      latency: network.latency,
      offline: false,
      uploadThroughput: network.upload,
    });
  }
  await page.goto('/dev/drawing');
  await page.waitForFunction(
    () => performance.getEntriesByName('board:painted').length > 0,
    null,
    { polling: 250, timeout: 300_000 }
  );
  const stages = await page.evaluate(() => {
    const at = (name: string) => performance.getEntriesByName(name)[0].startTime;
    const mountStart = at('board:mount-start');
    const scripts = performance
      .getEntriesByType('resource')
      .filter((entry) => /\.(js|css)$/.test(new URL(entry.name).pathname))
      .filter((entry) => entry.startTime < mountStart) as PerformanceResourceTiming[];
    const [nav] = performance.getEntriesByType(
      'navigation'
    ) as PerformanceNavigationTiming[];
    // The board's chunk is the largest file; the app's own start is everything else.
    const board = [...scripts].sort(
      (a, b) => b.encodedBodySize - a.encodedBodySize
    )[0];
    const chunksDone = Math.max(...scripts.map((entry) => entry.responseEnd));
    return {
      boardChunkStart: board.startTime,
      chunkDownload: board.responseEnd - board.startTime,
      chunksDone,
      firstFrame: at('board:painted') - at('board:mount-end'),
      html: nav.responseEnd,
      mount: at('board:mount-end') - mountStart,
      parseEvaluate: mountStart - chunksDone,
      total: at('board:painted'),
    };
  });
  await context.close();
  return stages;
}

type Stages = Awaited<ReturnType<typeof coldOpen>>;

const medians = (runs: Stages[]) =>
  Object.fromEntries(
    (Object.keys(runs[0]) as (keyof Stages)[]).map((key) => [
      key,
      median(runs.map((run) => run[key])),
    ])
  );

async function previews(browser: Browser, docs: Record<string, string>) {
  const page = await browser.newPage();
  await openBoard(page);
  const out: Record<string, unknown> = {};
  for (const rate of RATES) {
    await throttleCpu(page, rate);
    for (const [name, doc] of Object.entries(docs))
      for (const size of PREVIEW_SIZES) {
        out[`${name} ${size.width}x${size.height} ${rate}x`] =
          await page.evaluate(
            async ({ doc, runs, size }) => {
              const draw = (
                window as unknown as {
                  __preview: (
                    saved: string,
                    size: { height: number; width: number }
                  ) => string;
                }
              ).__preview;
              const strings: number[] = [];
              const decodes: number[] = [];
              const paints: number[] = [];
              let svg = '';
              for (let run = 0; run < runs; run++) {
                const start = performance.now();
                svg = draw(doc, size);
                strings.push(performance.now() - start);
                // A comment per run, so no decode is served from the image cache.
                const image = new Image(size.width, size.height);
                const decodeStart = performance.now();
                image.src = `data:image/svg+xml,${encodeURIComponent(`${svg}<!--${run}-->`)}`;
                await image.decode();
                decodes.push(performance.now() - decodeStart);
                const paintStart = performance.now();
                document.body.append(image);
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => {
                    const channel = new MessageChannel();
                    channel.port1.onmessage = () => resolve();
                    channel.port2.postMessage(null);
                  })
                );
                paints.push(performance.now() - paintStart);
                image.remove();
              }
              const mid = (values: number[]) =>
                [...values].sort((a, b) => a - b)[values.length >> 1];
              const ms = (value: number) => Math.round(value * 10) / 10;
              return {
                decodeMs: ms(mid(decodes)),
                firstStringMs: ms(strings[0]),
                paintMs: ms(mid(paints)),
                stringMs: ms(mid(strings)),
                svgKb: Math.round(svg.length / 102.4) / 10,
              };
            },
            { doc, runs: PREVIEW_RUNS, size }
          );
      }
  }
  await page.close();
  return out;
}

/** A board mounted as Draw mounts it, with the answer area, timed to the first frame
 * that holds it. */
const mountReady = (page: Page, doc: string | undefined) =>
  page.evaluate(async (doc) => {
    const start = performance.now();
    (window as unknown as { __mount: (options: object) => void }).__mount({
      answerArea: { label: 'Answer area' },
      saved: doc,
    });
    await new Promise<void>((resolve) => {
      const watch = () => {
        if (!document.querySelector('.edgeless-background rect[stroke="#9aa0a6"]')) {
          requestAnimationFrame(watch);
          return;
        }
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve();
          channel.port2.postMessage(null);
        });
      };
      watch();
    });
    return performance.now() - start;
  }, doc);

/**
 * Draw with the module already fetched and evaluated (fix 4): in a fresh context
 * the dev route loads the module and mounts nothing (`?unmounted`), then the first
 * mount (a student's first Draw on the page) and a second one are timed; and the JS
 * heap and DOM nodes the first board adds, after a collection.
 */
async function firstDraws(
  browser: Browser,
  boards: Record<string, string | undefined>
) {
  const out: Record<string, unknown> = {};
  for (const rate of RATES)
    for (const [name, doc] of Object.entries(boards)) {
      const runs: {
        again: number;
        first: number;
        heapMb: number;
        nodes: number;
        shown: number;
      }[] =
        [];
      for (let i = 0; i < OPENS; i++) {
        const context = await browser.newContext({
          viewport: { height: 800, width: 1280 },
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await page.goto('/dev/drawing?unmounted');
        await page.waitForFunction(() => '__mount' in window, null, {
          timeout: 120_000,
        });
        await page.waitForTimeout(1000);
        const memory = async () => {
          await cdp.send('HeapProfiler.collectGarbage');
          const { usedSize } = await cdp.send('Runtime.getHeapUsage');
          const { nodes } = await cdp.send('Memory.getDOMCounters');
          return { heap: usedSize, nodes };
        };
        const before = await memory();
        await throttleCpu(page, rate);
        const first = await mountReady(page, doc);
        const again = await mountReady(page, doc);
        // Mounted ahead out of sight, as an answer's board is: Draw only shows it.
        await page.evaluate(() => {
          (document.querySelector('[class*="h-dvh"]') as HTMLElement).style.visibility =
            'hidden';
        });
        await mountReady(page, doc);
        const shown = await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const start = performance.now();
              (document.querySelector('[class*="h-dvh"]') as HTMLElement).style.visibility =
                '';
              requestAnimationFrame(() => {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => resolve(performance.now() - start);
                channel.port2.postMessage(null);
              });
            })
        );
        await throttleCpu(page, 1);
        const after = await memory();
        runs.push({
          again,
          first,
          heapMb: (after.heap - before.heap) / 1e6,
          nodes: after.nodes - before.nodes,
          shown,
        });
        await context.close();
      }
      out[`${name} ${rate}x`] = {
        againMs: median(runs.map((run) => run.again)),
        firstMs: median(runs.map((run) => run.first)),
        firstRunsMs: runs.map((run) => Math.round(run.first)),
        heapMb: Math.round(percentile(runs.map((run) => run.heapMb), 50) * 10) / 10,
        nodes: median(runs.map((run) => run.nodes)),
        shownAheadMs: median(runs.map((run) => run.shown)),
      };
    }
  return out;
}

/** The JS and CSS before the mount, gzipped, from the build. */
async function bytes(browser: Browser) {
  const page = await browser.newPage();
  await openBoard(page);
  const names = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((name) => /\.(js|css)$/.test(name))
  );
  await page.close();
  const files = await Promise.all(
    [...new Set(names)].map(async (name) => {
      const body = await readFile(path.join(OUT_DIR, name));
      return { gzip: gzipSync(body).byteLength, name, raw: body.byteLength };
    })
  );
  const kb = (value: number) => Math.round(value / 102.4) / 10;
  return {
    gzipKb: kb(files.reduce((sum, file) => sum + file.gzip, 0)),
    largest: [...files]
      .sort((a, b) => b.gzip - a.gzip)
      .slice(0, 6)
      .map((file) => ({ gzipKb: kb(file.gzip), name: file.name, rawKb: kb(file.raw) })),
    rawKb: kb(files.reduce((sum, file) => sum + file.raw, 0)),
  };
}

test('how long the board takes to show: open stages and the preview', async ({
  browser,
}, testInfo) => {
  const typical = await makeBoard(browser, TYPICAL);
  const large = await makeBoard(browser, LARGE);
  const boards = {
    blank: { expected: { blocks: 0, canvas: 1 }, saved: undefined },
    typical: { expected: typical.expected, saved: typical.saved.doc },
  };
  const open: Record<string, unknown> = {};
  for (const [network, conditions] of Object.entries(NETWORKS))
    for (const rate of RATES)
      for (const [name, board] of Object.entries(boards)) {
        const runs: Stages[] = [];
        for (let i = 0; i < OPENS; i++)
          runs.push(
            await coldOpen(browser, rate, conditions, board.expected, board.saved)
          );
        open[`${name} ${rate}x ${network}`] = medians(runs);
      }
  await reportMetrics(testInfo, 'canvas-stages', {
    bytes: await bytes(browser),
    draw: await firstDraws(browser, {
      blank: undefined,
      typical: typical.saved.doc,
    }),
    open,
    preview: await previews(browser, {
      large: large.saved.doc,
      typical: typical.saved.doc,
    }),
  });
});
