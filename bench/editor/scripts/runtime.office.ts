import { expect, type Frame, type Page, test } from '@playwright/test';
import type {
  OfficeAnalysis,
  OfficeFormat,
  OfficeReadyTimings,
} from '../../../src/features/files/officeProtocol';
import { PERF_WORKSPACE_ID } from '../../../src/mocks/perfSeed';
import { cdpSession, percentile, reportMetrics } from './metrics';

/**
 * DOCX, XLSX and PPTX in the Office runtime, on a production build (see
 * playwright.office.config.ts), one small and one large file each: open to
 * first paint, View to Edit ready, keystroke to painted frame and the JS heap
 * at each step, plus a view-mode memory probe over two full passes.
 *
 * Timings are on the host's clock, from the click to a runtime message:
 * - DOCX: `ready`, sent once its first pages are painted (in edit mode too),
 *   carrying the runtime's own `timings` (officeProtocol.ts,
 *   OfficeReadyTimings).
 * - XLSX/PPTX open: `ready` without timings, sent once the file is parsed and
 *   laid out: one frame before the grid paints (XLSX), before the slide's
 *   pictures decode (PPTX).
 * - XLSX/PPTX edit: `collaboration-ready`, the editor's replica, reported in
 *   the same React commit as the editor's first real paint.
 * Typing reads the frame directly, since Playwright can evaluate inside the
 * cross-origin runtime: DOCX to the next `docx-pages-presented`; XLSX/PPTX,
 * which apply input on the frame's main thread, to the first task after the
 * next frame following the key's last event (keydown, keypress, input).
 * Unthrottled: CDP's CPU throttle reaches neither the runtime frame's process
 * nor the engine workers, so a multiplier would skew main thread against
 * worker.
 *
 * Heap: CDP Runtime.getHeapUsage after a forced GC, for the page's isolate,
 * which holds the runtime frame too (same site, so same process), plus the
 * WASM memories the frames instantiated (CDP counts neither those nor
 * workers, such as the DOCX engine). `performance.measureUserAgentSpecificMemory`
 * needs cross-origin isolation, which the app does not have.
 */

/**
 * ~1.3x the median of three runs of the Performance workflow on ubuntu-24.04,
 * the same rule as the editor budgets, rounded up to 5 ms below a second and
 * 50 ms above. DOCX: 2026-10-04 runs 37174928433, 37174944257, 37174959817
 * (every metric within 3% of its median). XLSX and PPTX: 2026-10-04 runs
 * 37197306625, 37197311546, 37197316994 on 15136468, all three on AMD EPYC
 * 7763 runners. For XLSX/PPTX `openFirstPaintMs` ends at `ready` and
 * `editReadyMs` at `collaboration-ready` (see above). Heap figures are
 * report-only (openwiki/editor-perf.md).
 */
const BUDGET: Record<
  Fixture['id'],
  {
    editReadyMs: number;
    keyToFrameP50Ms: number;
    keyToFrameP90Ms: number;
    openFirstPaintMs: number;
  }
> = {
  'bio-office-docx': {
    editReadyMs: 4250, // median 3,259
    keyToFrameP50Ms: 180, // median 138
    keyToFrameP90Ms: 195, // median 150
    openFirstPaintMs: 6900, // median 5,289 (MSW adds ~1.1 s per call)
  },
  'bio-office-docx-long': {
    editReadyMs: 8100, // median 6,230
    keyToFrameP50Ms: 570, // median 436
    keyToFrameP90Ms: 1340, // median 1,031
    openFirstPaintMs: 10_350, // median 7,954
  },
  'bio-office-pptx': {
    editReadyMs: 1050, // median 790
    keyToFrameP50Ms: 15, // median 11
    keyToFrameP90Ms: 25, // median 18
    openFirstPaintMs: 3950, // median 3,038
  },
  'bio-office-pptx-long': {
    editReadyMs: 3200, // median 2,442
    keyToFrameP50Ms: 90, // median 69
    keyToFrameP90Ms: 100, // median 75
    openFirstPaintMs: 5900, // median 4,530
  },
  'bio-office-xlsx': {
    editReadyMs: 1650, // median 1,244
    keyToFrameP50Ms: 20, // median 14
    keyToFrameP90Ms: 65, // median 47
    openFirstPaintMs: 4050, // median 3,086
  },
  'bio-office-xlsx-long': {
    editReadyMs: 6750, // median 5,188
    keyToFrameP50Ms: 20, // median 12
    keyToFrameP90Ms: 410, // median 313
    openFirstPaintMs: 5000, // median 3,825
  },
};

type Fixture = (typeof FIXTURES)[number];

/**
 * `cell`: the XLSX cell typing starts in. It must be on screen at 1280x800:
 * the editor neither scrolls a cell selected by keyboard into view nor takes
 * typing in one that is off screen. The large file's E3 feeds its formulas.
 * `text`: a point in a text box on the first PPTX slide, as fractions of the
 * slide (the small deck's title, the large deck's body text).
 */
const FIXTURES = [
  { format: 'docx', id: 'bio-office-docx', name: 'exchange-plan.docx' },
  { format: 'docx', id: 'bio-office-docx-long', name: 'long-handbook.docx' },
  {
    cell: 'F5',
    format: 'xlsx',
    id: 'bio-office-xlsx',
    name: 'course-guide.xlsx',
  },
  {
    cell: 'E3',
    format: 'xlsx',
    id: 'bio-office-xlsx-long',
    name: 'large-gradebook.xlsx',
  },
  {
    format: 'pptx',
    id: 'bio-office-pptx',
    name: 'lecture.pptx',
    text: { x: 0.5, y: 0.456 },
  },
  {
    format: 'pptx',
    id: 'bio-office-pptx-long',
    name: 'jp_llm2.pptx',
    text: { x: 0.5, y: 0.456 },
  },
] as const;

const A1 = /^([A-Z]+)(\d+)$/;
const FALLBACK = /falling back to the main-thread engine/;
const KEYS = 40;
const KEY_CADENCE_MS = 120;
// Every sixth key: a space in text, Enter (commit, next row) in a sheet.
const TYPED = {
  docx: ['a', 'Space'],
  pptx: ['a', 'Space'],
  xlsx: ['7', 'Enter'],
};

interface RuntimeMessage {
  analysis?: OfficeAnalysis;
  at: number;
  timings?: OfficeReadyTimings;
  type: string;
}

declare global {
  interface Window {
    __officeBench: { clicks: number[]; messages: RuntimeMessage[] };
    __officeKeys: { keys: number[]; presents: number[] };
    __officeWasm: WeakRef<WebAssembly.Memory>[];
  }
}

/**
 * Every frame: keep a weak handle on each WASM instance's exported memory,
 * which CDP's heap figures leave out.
 */
async function installWasmProbe(page: Page) {
  await page.addInitScript(() => {
    const memories: WeakRef<WebAssembly.Memory>[] = [];
    window.__officeWasm = memories;
    const keep = (instance: WebAssembly.Instance) => {
      for (const value of Object.values(instance.exports))
        if (value instanceof WebAssembly.Memory)
          memories.push(new WeakRef(value));
    };
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    const streaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
    const fromResult = (
      result: WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource
    ) => {
      keep('instance' in result ? result.instance : result);
      return result;
    };
    WebAssembly.instantiate = ((...args: Parameters<typeof instantiate>) =>
      instantiate(...args).then(fromResult)) as typeof WebAssembly.instantiate;
    WebAssembly.instantiateStreaming = (...args) =>
      streaming(...args).then((result) => {
        keep(result.instance);
        return result;
      });
    WebAssembly.Instance = new Proxy(WebAssembly.Instance, {
      construct(target, args) {
        const instance = Reflect.construct(
          target,
          args
        ) as WebAssembly.Instance;
        keep(instance);
        return instance;
      },
    });
  });
}

// Host clock: the last click and the runtime messages the spec waits on.
async function installHostProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { clicks: [] as number[], messages: [] as RuntimeMessage[] };
    window.__officeBench = probe;
    window.addEventListener(
      'click',
      () => probe.clicks.push(performance.now()),
      true
    );
    window.addEventListener('message', (event) => {
      const data = event.data as Partial<RuntimeMessage>;
      if (
        data?.type === 'ready' ||
        data?.type === 'collaboration-ready' ||
        data?.type === 'update'
      )
        probe.messages.push({
          analysis: data.analysis,
          at: performance.now(),
          timings: data.timings,
          type: data.type,
        });
    });
  });
}

const countMessages = (page: Page, type: string) =>
  page.evaluate(
    (kind) =>
      window.__officeBench.messages.filter((m) => m.type === kind).length,
    type
  );

/** Click, then wait for the next runtime message of `type`: ms on the host clock. */
async function clickUntil(
  page: Page,
  type: 'collaboration-ready' | 'ready',
  click: () => Promise<void>
) {
  const before = await countMessages(page, type);
  await click();
  await page.waitForFunction(
    ({ count, kind }) =>
      window.__officeBench.messages.filter((m) => m.type === kind).length >
      count,
    { count: before, kind: type },
    { polling: 50, timeout: 240_000 }
  );
  return page.evaluate((kind) => {
    const { clicks, messages } = window.__officeBench;
    const last = messages.filter((m) => m.type === kind).at(-1)!;
    const analysis = last.analysis;
    return {
      ms: Math.round(last.at - clicks.at(-1)!),
      runtime: last.timings ?? null,
      // Pages, sheets or slides.
      units: analysis
        ? analysis.format === 'docx'
          ? analysis.pageCount
          : analysis.format === 'xlsx'
            ? analysis.sheetCount
            : analysis.slideCount
        : null,
    };
  }, type);
}

function runtimeFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('office-runtime'));
  if (!frame) throw new Error('No Office runtime frame');
  return frame;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * The page isolate's retained heap after a GC (runtime frame included) and the
 * WASM linear memory still alive in any frame.
 */
async function heap(page: Page) {
  const session = await cdpSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const usage = await session.send('Runtime.getHeapUsage');
  let wasm = 0;
  for (const frame of page.frames())
    wasm += await frame.evaluate(() => {
      const live = new Set(
        (window.__officeWasm ?? []).map((ref) => ref.deref()).filter(Boolean)
      );
      return [...live].reduce(
        (sum, memory) => sum + memory!.buffer.byteLength,
        0
      );
    });
  return {
    // ArrayBuffers and external strings; WASM memory is not among them.
    backingMB: mb(usage.backingStorageSize),
    jsMB: mb(usage.usedSize),
    wasmMB: mb(wasm),
  };
}

async function openInView(page: Page, fixture: Fixture) {
  await installHostProbe(page);
  await installWasmProbe(page);
  await page.goto(`/workspaces/${PERF_WORKSPACE_ID}`);
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  const link = page.locator(
    `[data-workspace-file-tree] a[href$="file=${fixture.id}"]`
  );
  await expect(link).toBeVisible({ timeout: 60_000 });
  return clickUntil(page, 'ready', () => link.click());
}

/** Click where typing should start and check the caret is there. */
async function placeCaret(page: Page, frame: Frame, fixture: Fixture) {
  if (fixture.format === 'docx') {
    const box = await frame
      .locator('canvas[data-page-index="0"]')
      .boundingBox();
    if (!box) throw new Error('First page is not laid out');
    // Body text near the top of the first page (both fixtures open with prose).
    await page.mouse.click(box.x + box.width / 2, box.y + 200);
  } else if (fixture.format === 'xlsx') {
    const box = await frame
      .locator('[data-testid="xlsx-scroll"]')
      .boundingBox();
    if (!box) throw new Error('Grid is not laid out');
    await page.mouse.click(box.x + 300, box.y + 120);
    // Walk from the clicked cell to the target with the arrow keys.
    const nameBox = frame.getByTestId('xlsx-name-box');
    const from = cellAt(await nameBox.inputValue());
    const to = cellAt(fixture.cell);
    for (const [delta, back, forward] of [
      [to.col - from.col, 'ArrowLeft', 'ArrowRight'],
      [to.row - from.row, 'ArrowUp', 'ArrowDown'],
    ] as const)
      for (let step = 0; step < Math.abs(delta); step += 1)
        await page.keyboard.press(delta < 0 ? back : forward);
    await expect(nameBox).toHaveValue(fixture.cell);
  } else {
    const canvas = frame.getByTestId('pptx-slide-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Slide is not laid out');
    // A first click selects the shape; a double click selects a word in it.
    await canvas.click({
      clickCount: 2,
      position: {
        x: box.width * fixture.text.x,
        y: box.height * fixture.text.y,
      },
    });
    // The hidden input takes text only with a caret in a text story.
    const input = frame.getByTestId('pptx-text-input');
    await expect(input).toBeFocused();
    await expect(input).not.toHaveAttribute('readonly');
    await page.keyboard.press('ControlOrMeta+End');
  }
}

function cellAt(a1: string) {
  const match = A1.exec(a1);
  if (!match) throw new Error(`Not a cell reference: ${a1}`);
  const col = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return { col, row: Number(match[2]) };
}

/** Keys at a fixed cadence; each key's delay to its painted frame. */
async function typeAndTime(page: Page, fixture: Fixture) {
  const frame = runtimeFrame(page);
  await placeCaret(page, frame, fixture);
  await page.waitForTimeout(1000);
  await frame.evaluate((format) => {
    const probe = { keys: [] as number[], presents: [] as number[] };
    window.__officeKeys = probe;
    if (format === 'docx') {
      window.addEventListener(
        'keydown',
        () => probe.keys.push(performance.now()),
        true
      );
      document.addEventListener('docx-pages-presented', () =>
        probe.presents.push(performance.now())
      );
      return;
    }
    // The first task after the next frame, rescheduled by each of the key's
    // events, so the latest wins: presents[i] belongs to keys[i].
    const afterFrame = () => {
      const key = probe.keys.length - 1;
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          probe.presents[key] = performance.now();
        };
        channel.port2.postMessage(null);
      });
    };
    window.addEventListener(
      'keydown',
      () => {
        probe.keys.push(performance.now());
        afterFrame();
      },
      true
    );
    window.addEventListener('keypress', afterFrame, true);
    window.addEventListener('input', afterFrame, true);
  }, fixture.format);
  const updatesBefore = await countMessages(page, 'update');
  const [key, sixth] = TYPED[fixture.format];
  for (let index = 0; index < KEYS; index += 1) {
    await page.keyboard.press(index % 6 === 5 ? sixth : key);
    await page.waitForTimeout(KEY_CADENCE_MS);
  }
  // The last key's frame, or give up after 30 s (counted as unpainted).
  await frame
    .waitForFunction(
      (format) => {
        const { keys, presents } = window.__officeKeys;
        return format === 'docx'
          ? presents.length > 0 && presents.at(-1)! > keys.at(-1)!
          : presents[keys.length - 1] !== undefined;
      },
      fixture.format,
      { polling: 100, timeout: 30_000 }
    )
    .catch(() => undefined);
  const lags = await frame.evaluate((format) => {
    const { keys, presents } = window.__officeKeys;
    return keys.map((key, index) => {
      const next =
        format === 'docx' ? presents.find((at) => at > key) : presents[index];
      return next === undefined ? null : next - key;
    });
  }, fixture.format);
  const painted = lags.filter((lag): lag is number => lag !== null);
  return {
    // Edits the runtime sent to the room while typing.
    edits: (await countMessages(page, 'update')) - updatesBefore,
    keys: lags.length,
    keyToFrameMaxMs: Math.round(Math.max(0, ...painted)),
    keyToFrameP50Ms: Math.round(percentile(painted, 50)),
    keyToFrameP90Ms: Math.round(percentile(painted, 90)),
    unpaintedKeys: lags.length - painted.length,
  };
}

/**
 * One full pass of the view: every page, every sheet's rows and columns, or
 * every slide, then back to the start.
 */
async function viewPass(frame: Frame, format: OfficeFormat) {
  await frame.evaluate(async (kind) => {
    const settle = async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    if (kind === 'pptx') {
      const next = document.querySelector<HTMLButtonElement>(
        '[data-testid="pptx-next-slide"]'
      )!;
      while (!next.disabled) {
        next.click();
        // Pictures decode off the main thread before the slide paints.
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      document.querySelector<HTMLButtonElement>('.pptx-viewer-slide')!.click();
      await settle();
      return;
    }
    // The element that scrolls the document (DOCX) or the active sheet.
    const scroller = () =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter((el) =>
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)
        )
        .sort(
          (a, b) =>
            b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
        )[0];
    const sweep = async () => {
      const el = scroller();
      for (let top = 0; top < el.scrollHeight; top += el.clientHeight) {
        el.scrollTop = top;
        await settle();
      }
      el.scrollTop = 0;
      for (let left = 0; left < el.scrollWidth; left += el.clientWidth) {
        el.scrollLeft = left;
        await settle();
      }
      el.scrollLeft = 0;
      await settle();
    };
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    if (kind === 'docx' || tabs.length === 0) return sweep();
    for (const tab of tabs) {
      tab.click();
      await settle();
      await sweep();
    }
    tabs[0].click();
    await settle();
  }, format);
}

for (const fixture of FIXTURES) {
  test(`${fixture.format} ${fixture.name}: open, View to Edit, typing`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    const fallbacks: string[] = [];
    page.on('console', (message) => {
      if (FALLBACK.test(message.text())) fallbacks.push(message.text());
    });

    const open = await openInView(page, fixture);
    await page.waitForTimeout(2000);
    const openHeap = await heap(page);

    const mode = page.getByRole('button', { name: 'Material mode' });
    await expect(mode).toBeEnabled({ timeout: 60_000 });
    const edit = await clickUntil(
      page,
      fixture.format === 'docx' ? 'ready' : 'collaboration-ready',
      () => mode.click()
    );
    // Let the edit frame's idle work (mirror, glyph cache) settle first.
    await page.waitForTimeout(5000);
    const editHeap = await heap(page);
    const typing = await typeAndTime(page, fixture);
    await page.waitForTimeout(2000);
    const typingHeap = await heap(page);

    const budget = BUDGET[fixture.id];
    await reportMetrics(
      testInfo,
      `office-${fixture.format}-${fixture.id}`,
      {
        budget: { ...budget, heap: 'report-only' },
        edit: { readyMs: edit.ms, runtime: edit.runtime },
        fixture: fixture.name,
        // Report-only: a ceiling still needs defining.
        heap: {
          afterEdit: editHeap,
          afterOpen: openHeap,
          afterTyping: typingHeap,
        },
        open: { firstPaintMs: open.ms, runtime: open.runtime },
        typing: { ...typing, cadenceMs: KEY_CADENCE_MS },
        units: open.units,
        workerFallbacks: fallbacks.length,
      },
      'unthrottled'
    );
    expect(typing.unpaintedKeys).toBe(0);
    expect(typing.edits).toBeGreaterThan(0);
    expect(fallbacks).toEqual([]);
    expect.soft(open.ms).toBeLessThanOrEqual(budget.openFirstPaintMs);
    expect.soft(edit.ms).toBeLessThanOrEqual(budget.editReadyMs);
    expect
      .soft(typing.keyToFrameP50Ms)
      .toBeLessThanOrEqual(budget.keyToFrameP50Ms);
    expect
      .soft(typing.keyToFrameP90Ms)
      .toBeLessThanOrEqual(budget.keyToFrameP90Ms);
  });

  // The view-mode creep item (todo-office.md): heap growth over two full
  // passes, the first warming caches, the second showing what keeps growing.
  test(`${fixture.format} ${fixture.name}: view-mode heap over full passes`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    await openInView(page, fixture);
    await page.waitForTimeout(2000);
    const frame = runtimeFrame(page);
    const open = await heap(page);
    const started = Date.now();
    await viewPass(frame, fixture.format);
    const passMs = Date.now() - started;
    await page.waitForTimeout(1000);
    const first = await heap(page);
    await viewPass(frame, fixture.format);
    await page.waitForTimeout(1000);
    const second = await heap(page);
    const delta = (a: number, b: number) => Math.round((a - b) * 10) / 10;
    const growth = (to: typeof open, from: typeof open) => ({
      backingMB: delta(to.backingMB, from.backingMB),
      jsMB: delta(to.jsMB, from.jsMB),
      wasmMB: delta(to.wasmMB, from.wasmMB),
    });
    await reportMetrics(
      testInfo,
      `office-${fixture.format}-${fixture.id}-view-heap`,
      {
        budget: 'report-only',
        firstPassGrowth: growth(first, open),
        fixture: fixture.name,
        heap: {
          afterFirstPass: first,
          afterOpen: open,
          afterSecondPass: second,
        },
        passMs,
        secondPassGrowth: growth(second, first),
      },
      'unthrottled'
    );
  });
}
