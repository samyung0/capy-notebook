import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type Page, test } from '@playwright/test';
import {
  type DenseTargets,
  makeDenseBoard,
  openBoard,
  type Root,
  startTyping,
  TYPING_PATHS,
  type TypingPath,
} from './canvasBoards';
import { type CpuProfile, profileSection } from './cpuProfile';
import { CPU_RATE, cdpSession, percentile, throttleCpu } from './metrics';

/**
 * What holds a key on a busy board (2026-11-23), report only: on the dense board
 * (8 answers: 25 plane cards, 64 formulas, 32 note cards), each place a student
 * types (a canvas label, a shape's label, a connector's label, a note card, a
 * formula card and a plane card's own label in its editor) at CPU_RATE, with the
 * first answer in view at 100% and with the whole board in view. Each key is
 * timed as bench:canvas times inputs (first event to the first task after the
 * next frame) and split by the browser's Event Timing into input delay,
 * processing and presentation delay. `PERF_PROFILE_DIR` also writes a CPU
 * profile summary per path there.
 *
 * Opt-in, as it asserts little and takes a while:
 *   PERF_BOARD_TYPING=1 pnpm bench:canvas board-typing
 * `PERF_TYPING_PATHS` (comma separated) and `PERF_TYPING_VIEWS` (`answer`,
 * `whole`) narrow it; `PERF_CANVAS_BASE_URL` runs it against a running build
 * (a dev server too), and `PERF_TYPING_VIA=room` there types on the Canvas page,
 * the board in the mock collaboration room (MSW).
 */

const KEYS = 30;
const KEY_CADENCE_MS = 100;
const VIEWS = ['answer', 'whole'] as const;
type View = (typeof VIEWS)[number];

/** On the Canvas page through the mock collaboration room (a dev server with
 * MSW), where students and teachers type now; otherwise the board's own page. */
const ROOM = process.env.PERF_TYPING_VIA === 'room';

const picked = <T extends string>(all: readonly T[], env?: string) =>
  env ? all.filter((one) => env.split(',').includes(one)) : [...all];

/** Frames worth naming in a profile whether or not they make the top lists. */
const WATCH = [
  'drawGraph',
  'drawPlane',
  'planeRenderer',
  'formulaRenderer',
  'replay',
  '_render',
  '_renderByBound',
  'refresh',
  '_updateRect',
  'updateElement',
  'requestUpdate',
  'performUpdate',
  'getBoundingClientRect',
  'measure',
];

type EventEntry = {
  duration: number;
  interactionId: number;
  name: string;
  processingEnd: number;
  processingStart: number;
  startTime: number;
};

declare global {
  interface Window {
    __benchEvents?: EventEntry[];
  }
}

/** Every key event's Event Timing entry (16 ms and longer, the spec's floor). */
async function watchEvents(page: Page) {
  await page.addInitScript(() => {
    window.__benchEvents = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEventTiming & { interactionId: number };
        window.__benchEvents?.push({
          duration: e.duration,
          interactionId: e.interactionId,
          name: e.name,
          processingEnd: e.processingEnd,
          processingStart: e.processingStart,
          startTime: e.startTime,
        });
      }
    }).observe({
      durationThreshold: 16,
      type: 'event',
    } as PerformanceObserverInit);
  });
}

/** As board.canvas.ts: each key from its keydown to the first task after the
 * frame after its last event. */
async function installKeyProbe(page: Page) {
  await page.evaluate(() => {
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
    window.addEventListener(
      'keydown',
      () => {
        inputs.at.push(performance.now());
        afterFrame();
      },
      { capture: true, passive: true }
    );
    for (const type of ['keypress', 'input'])
      window.addEventListener(type, afterFrame, {
        capture: true,
        passive: true,
      });
    window.__benchEvents = [];
  });
}

const round = (ms: number) => Math.round(ms);

/** The keys' delays, and per key the Event Timing split of its longest event and
 * the events drawn in the same frame (as web-vitals attributes INP). */
async function keyStats(page: Page) {
  await page.waitForFunction(
    () => {
      const inputs = window.__benchInputs;
      return !!inputs && inputs.presents[inputs.at.length - 1] !== undefined;
    },
    null,
    { polling: 100, timeout: 60_000 }
  );
  const { delays, events } = await page.evaluate(() => {
    const inputs = window.__benchInputs;
    if (!inputs) throw new Error('no probe');
    return {
      delays: inputs.at.map((at, i) => (inputs.presents[i] ?? Number.NaN) - at),
      events: window.__benchEvents ?? [],
    };
  });
  const byKey = new Map<number, EventEntry[]>();
  for (const event of events)
    if (event.interactionId && event.name !== 'keyup')
      byKey.set(event.interactionId, [
        ...(byKey.get(event.interactionId) ?? []),
        event,
      ]);
  const splits = [...byKey.values()].map((entries) => {
    const longest = entries.reduce((a, b) => (b.duration > a.duration ? b : a));
    const end = longest.startTime + longest.duration;
    const frame = entries.filter(
      (entry) => Math.abs(entry.startTime + entry.duration - end) < 8
    );
    const first = frame.reduce((a, b) => (b.startTime < a.startTime ? b : a));
    const processed = Math.max(...frame.map((entry) => entry.processingEnd));
    return {
      duration: longest.duration,
      inputDelay: first.processingStart - first.startTime,
      presentation: Math.max(0, end - processed),
      processing: processed - first.processingStart,
    };
  });
  const p = (values: number[], at: number) => round(percentile(values, at));
  const split = (key: keyof (typeof splits)[number]) => ({
    p50: p(
      splits.map((one) => one[key]),
      50
    ),
    p90: p(
      splits.map((one) => one[key]),
      90
    ),
  });
  const painted = delays.filter((delay) => Number.isFinite(delay));
  return {
    eventTiming: {
      duration: split('duration'),
      inputDelay: split('inputDelay'),
      presentation: split('presentation'),
      processing: split('processing'),
      // Keys under 16 ms have no entry.
      timed: splits.length,
    },
    keys: delays.length,
    maxMs: round(Math.max(...painted)),
    p50Ms: p(painted, 50),
    p90Ms: p(painted, 90),
    unpainted: delays.length - painted.length,
  };
}

/** The first answer at 100% from its left edge, or the whole board as it
 * opened (fitted). */
async function setView(page: Page, view: View) {
  if (view === 'whole') return;
  await page.evaluate(() => {
    const { viewport } = (
      document.querySelector('affine-edgeless-root') as Root
    ).gfx;
    viewport.setViewport(1, [viewport.width / 2 - 20, 560]);
  });
  await page.waitForTimeout(1000);
}

/** A page holding the dense board, its view set, CPU at CPU_RATE. */
async function openDense(browser: Browser, saved: string, view: View) {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await watchEvents(page);
  if (ROOM) {
    // The Canvas page's board through the mock collaboration room, which reads
    // its stored state under this key (src/mocks/collaboration.ts).
    await page.addInitScript(
      (stored) => {
        const { getItem } = Storage.prototype;
        Storage.prototype.getItem = function (name: string) {
          const kept = getItem.call(this, name);
          return name.startsWith('capy.mock.board.material:')
            ? (kept ?? stored)
            : kept;
        };
      },
      JSON.stringify({ state: saved, version: 2 })
    );
    await page.goto('/canvas');
    await page.waitForFunction(
      () => window.__board?.stats().canvas.includes('plane'),
      null,
      { timeout: 120_000 }
    );
  } else {
    await page.addInitScript((saved) => {
      window.__benchBoard = saved;
    }, saved);
    await openBoard(page);
  }
  await page.waitForTimeout(2000);
  await setView(page, view);
  await throttleCpu(page, CPU_RATE);
  return { context, errors, page };
}

/** Types KEYS keys into `path` on a fresh page; with `profileDir`, under a CPU
 * profile summarised there. */
async function typeOn(
  browser: Browser,
  saved: string,
  targets: DenseTargets,
  path: TypingPath,
  view: View,
  profileDir?: string
) {
  const { context, errors, page } = await openDense(browser, saved, view);
  const typed = await startTyping(page, path, targets);
  await page.waitForTimeout(1000);
  await installKeyProbe(page);
  const session = await cdpSession(page);
  if (profileDir) {
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: 200 });
    await session.send('Profiler.start');
  }
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.press(i % 6 === 5 ? 'b' : 'a');
    await page.waitForTimeout(KEY_CADENCE_MS);
  }
  const stats = await keyStats(page);
  if (profileDir) {
    const { profile } = (await session.send('Profiler.stop')) as unknown as {
      profile: CpuProfile;
    };
    await writeFile(
      join(profileDir, `${path}-${view}.txt`),
      profileSection(`${path}, ${view} view`, profile, {}, { watch: WATCH }),
      'utf8'
    );
  }
  const text = await typed();
  await context.close();
  return { errors, reached: text.includes('aaaaab'), ...stats };
}

test('typing on a dense board, per place a student types', async ({
  browser,
}, testInfo) => {
  // biome-ignore lint/suspicious/noSkippedTests: report only, opt-in.
  test.skip(
    !process.env.PERF_BOARD_TYPING,
    'report only; set PERF_BOARD_TYPING=1 to run'
  );
  const dense = await makeDenseBoard(browser);
  const results: Record<string, unknown> = {
    board: { bytes: dense.saved.bytes, ...dense.expected },
    cpu: CPU_RATE,
    via: ROOM ? 'room' : 'board',
  };
  for (const view of picked(VIEWS, process.env.PERF_TYPING_VIEWS))
    for (const path of picked(TYPING_PATHS, process.env.PERF_TYPING_PATHS))
      results[`${path}-${view}`] = await typeOn(
        browser,
        dense.saved.doc,
        dense.targets,
        path,
        view,
        process.env.PERF_PROFILE_DIR
      );
  const body = JSON.stringify(results, null, 2);
  console.log(`[perf] board-typing (cpu x${CPU_RATE}):\n${body}`);
  await testInfo.attach('board-typing', {
    body,
    contentType: 'application/json',
  });
});
