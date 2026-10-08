import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type CDPSession,
  expect,
  type Frame,
  type Page,
  test,
} from '@playwright/test';
import type * as Y from 'yjs';
import type {
  OfficeAnalysis,
  OfficeFormat,
  OfficeReadyTimings,
} from '../../../src/features/files/officeProtocol';
import { PERF_WORKSPACE_ID } from '../../../src/mocks/perfSeed';
import { m } from '../../../e2e/i18n';
import { cdpSession, percentile, reportMetrics } from './metrics';

/**
 * DOCX, XLSX and PPTX in the Office runtime, on a production build (see
 * playwright.office.config.ts), one small and one large file each: open to
 * first paint, View to Edit ready, keystroke to painted frame at the start and
 * at the end of the file and the heap at each step, a co-editor's remote edits
 * applied in the open editor, plus two view-mode memory probes: two full
 * passes through the file, and closing and reopening it.
 *
 * Timings are on the host's clock, from the click to a runtime message:
 * - open, every format: `ready`, sent once the first pages, grid or slide are
 *   painted, carrying the runtime's own `timings` (officeProtocol.ts,
 *   OfficeReadyTimings);
 * - edit, every format: the edit frame's `ready`, sent once the editor's first
 *   pages, grid or slide are painted, with timings too. XLSX/PPTX budgets are
 *   still on `collaboration-ready`, the editor's replica, which they were
 *   calibrated against; their first paint is report-only until recalibrated.
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
 * WASM memories the frames instantiated (CDP does not count those), per
 * module; and each dedicated worker's JS heap and WASM memories (the DOCX
 * engine), through a browser CDP session attached to it.
 * `performance.measureUserAgentSpecificMemory` needs cross-origin isolation,
 * which the app does not have.
 *
 * XLSX only: large co-editor and local operations (a peer's 8,000-cell paste
 * and row insert, the last a whole recalculation; the same done locally),
 * each to the next painted grid with the frame's main-thread long tasks, and
 * scrolling a 50,000-row sheet (rows-50k.xlsx: gen_large_xlsx.py 1 50000
 * values) with the grid's paints per second.
 */

interface Timings {
  editReadyMs: number;
  keyToFrameP50Ms: number;
  keyToFrameP90Ms: number;
  openFirstPaintMs: number;
}

/**
 * Medians of three runs of the Performance workflow on ubuntu-24.04, all
 * 2026-10-04:
 * - DOCX: runs 37174928433, 37174944257, 37174959817 (every metric within 3%
 *   of its median);
 * - XLSX/PPTX View to Edit and keys: runs 37197306625, 37197311546,
 *   37197316994 on 15136468, all three on AMD EPYC 7763 runners;
 * - XLSX/PPTX open: runs 37200395852, 37200390235, 37200383976 on 253762ea
 *   (one EPYC 9V45, two EPYC 7763), the first runs with `ready` after the
 *   first paint. Those runs kept the other XLSX/PPTX metrics within 80% of
 *   their budgets.
 * For XLSX/PPTX `editReadyMs` ends at `collaboration-ready` (see above). Heap
 * figures are report-only (openwiki/editor-perf.md).
 */
const MEDIANS: Record<Fixture['id'], Timings> = {
  // MSW adds ~1.1 s per call to every open.
  'bio-office-docx': {
    editReadyMs: 3259,
    keyToFrameP50Ms: 138,
    keyToFrameP90Ms: 150,
    openFirstPaintMs: 5289,
  },
  'bio-office-docx-long': {
    editReadyMs: 6230,
    keyToFrameP50Ms: 436,
    keyToFrameP90Ms: 1031,
    openFirstPaintMs: 7954,
  },
  'bio-office-pptx': {
    editReadyMs: 790,
    keyToFrameP50Ms: 11,
    keyToFrameP90Ms: 18,
    openFirstPaintMs: 3183,
  },
  'bio-office-pptx-long': {
    editReadyMs: 2442,
    keyToFrameP50Ms: 69,
    keyToFrameP90Ms: 75,
    openFirstPaintMs: 5728,
  },
  'bio-office-xlsx': {
    editReadyMs: 1244,
    keyToFrameP50Ms: 14,
    keyToFrameP90Ms: 47,
    openFirstPaintMs: 3148,
  },
  'bio-office-xlsx-long': {
    editReadyMs: 5188,
    keyToFrameP50Ms: 12,
    keyToFrameP90Ms: 313,
    openFirstPaintMs: 3732,
  },
};

/** No keystroke budget goes below this: a one-frame wobble fails anything smaller. */
const KEY_BUDGET_FLOOR_MS = 30;

/**
 * 1.3x the median, the same rule as the editor budgets, rounded up to 5 ms
 * below a second and 50 ms above; keystroke budgets at least the floor.
 */
function budgetOf(median: Timings): Timings {
  const limit = (ms: number) => {
    // Rounded first, so 150 x 1.3 stays 195 rather than 195.00000000000003.
    const scaled = Math.round(ms * 130) / 100;
    const step = scaled < 1000 ? 5 : 50;
    return Math.ceil(scaled / step) * step;
  };
  const key = (ms: number) => Math.max(KEY_BUDGET_FLOOR_MS, limit(ms));
  return {
    editReadyMs: limit(median.editReadyMs),
    keyToFrameP50Ms: key(median.keyToFrameP50Ms),
    keyToFrameP90Ms: key(median.keyToFrameP90Ms),
    openFirstPaintMs: limit(median.openFirstPaintMs),
  };
}

type Fixture = (typeof FIXTURES)[number];

/**
 * `cell`: the XLSX cell typing starts in, reached with the arrow keys, and
 * the cell a co-editor writes. The large file's E3 feeds its formulas.
 * `text`: a point in a text box on the first PPTX slide, as fractions of the
 * slide (the small deck's title, the large deck's body text); `end`: the same
 * on the last slide with text (the small deck's title, the references).
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
    end: { slide: 20, x: 0.5, y: 0.5 },
    format: 'pptx',
    id: 'bio-office-pptx',
    name: 'lecture.pptx',
    text: { x: 0.5, y: 0.456 },
  },
  {
    end: { slide: 83, x: 0.5, y: 0.5 },
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
  /** `collaboration-ready`'s, which the bench's own updates must carry. */
  epoch?: number;
  /** An `error`'s text. */
  message?: string;
  timings?: OfficeReadyTimings;
  type: string;
  version?: number;
}

/** The mock collaboration rooms (src/mocks/collaboration.ts), as the
 * load-test build exposes them to the co-editor case. */
interface MockRoom {
  document: Y.Doc;
  target: { id: string; kind: 'material' | 'source' };
}

declare global {
  interface Window {
    __capyMockRooms?: Map<string, MockRoom>;
    __officeBench: { clicks: number[]; messages: RuntimeMessage[] };
    __officeKeys: { keys: number[]; presents: number[] };
    __officeKeysInstalled?: boolean;
    __officeUpdateReceipts: number[];
    __officeRemote: {
      ends: number[];
      frames: number[];
      longTasks: { duration: number; start: number }[];
      posted: number[];
      presents: number[];
      /** Receipts before this probe (installHostProbe's array). */
      receivedFrom: number;
    };
    __officeWasm: WeakRef<WebAssembly.Memory>[];
    __officeWasmModules: {
      memory: WeakRef<WebAssembly.Memory>;
      names: string[];
    }[];
    /** When the XLSX grid canvas was painted (cleared for a frame). */
    __xlsxPaints: number[];
  }
}

/**
 * A WASM module's name from its export names: its wasm-bindgen classes
 * (`__wbg_<class>_free`), else its first own export. The same in the page and
 * in workers, where no URL is at hand.
 */
function moduleLabel(names: string[]) {
  const classes = [
    ...new Set(
      names.flatMap((name) => /^__wbg_(\w+?)_free$/.exec(name)?.[1] ?? [])
    ),
  ].sort();
  if (classes.length) return classes.join('+');
  return (
    names.find((name) => !name.startsWith('__') && name !== 'memory') ??
    'unknown'
  );
}

/** MB per module label. */
function byModule(memories: { bytes: number; names: string[] }[]) {
  const bytes: Record<string, number> = {};
  for (const memory of memories) {
    const label = moduleLabel(memory.names);
    bytes[label] = (bytes[label] ?? 0) + memory.bytes;
  }
  return Object.fromEntries(
    Object.entries(bytes).map(([label, total]) => [label, mb(total)])
  );
}

/**
 * Every frame: keep a weak handle on each WASM instance's exported memory,
 * which CDP's heap figures leave out, with the instance's export names.
 */
async function installWasmProbe(page: Page) {
  await page.addInitScript(() => {
    const memories: WeakRef<WebAssembly.Memory>[] = [];
    const modules: Window['__officeWasmModules'] = [];
    window.__officeWasm = memories;
    window.__officeWasmModules = modules;
    const keep = (instance: WebAssembly.Instance) => {
      for (const value of Object.values(instance.exports))
        if (value instanceof WebAssembly.Memory) {
          memories.push(new WeakRef(value));
          modules.push({
            memory: new WeakRef(value),
            names: Object.keys(instance.exports),
          });
        }
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
    // In the runtime frame: when each host `update` reaches it. Registered
    // here, before any page script, this listener runs before the runtime's
    // own (a window's message listeners run in registration order, capturing
    // or not: measured on 2026-10-06), so it marks the receipt.
    const receipts: number[] = [];
    window.__officeUpdateReceipts = receipts;
    window.addEventListener('message', (event) => {
      if (
        window.parent !== window &&
        event.source === window.parent &&
        (event.data as { type?: unknown })?.type === 'update'
      )
        receipts.push(performance.now());
    });
    window.addEventListener('message', (event) => {
      const data = event.data as Partial<RuntimeMessage>;
      if (
        data?.type === 'ready' ||
        data?.type === 'collaboration-ready' ||
        data?.type === 'update' ||
        data?.type === 'error'
      )
        probe.messages.push({
          analysis: data.analysis,
          at: performance.now(),
          epoch: data.epoch,
          message: data.message,
          timings: data.timings,
          type: data.type,
          version: data.version,
        });
    });
    // The XLSX grid's paints: a frame clears the grid canvas before it draws.
    const paints: number[] = [];
    window.__xlsxPaints = paints;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.closest?.('[data-testid="xlsx-scroll"]'))
        paints.push(performance.now());
      return clearRect.apply(this, args);
    };
  });
}

const countMessages = (page: Page, type: string) =>
  page.evaluate(
    (kind) =>
      window.__officeBench.messages.filter((m) => m.type === kind).length,
    type
  );

type RuntimeSignal = 'collaboration-ready' | 'ready';

/**
 * Click, then wait for the next runtime message of each type: ms on the host
 * clock, one result per type.
 */
async function clickUntil(
  page: Page,
  types: readonly RuntimeSignal[],
  click: () => Promise<void>
) {
  const before = await Promise.all(
    types.map((type) => countMessages(page, type))
  );
  await click();
  await page.waitForFunction(
    ({ counts, kinds }) =>
      kinds.every(
        (kind, index) =>
          window.__officeBench.messages.filter((m) => m.type === kind)
            .length > counts[index]
      ),
    { counts: before, kinds: types },
    { polling: 50, timeout: 240_000 }
  );
  return page.evaluate(
    (kinds) =>
      kinds.map((kind) => {
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
      }),
    types
  );
}

function runtimeFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('office-runtime'));
  if (!frame) throw new Error('No Office runtime frame');
  return frame;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// The runner the numbers come from: CI's ubuntu-24.04 pool mixes CPU models.
const RUNNER = { cpuModel: cpus()[0]?.model ?? 'unknown', cpus: cpus().length };

const browserSessions = new WeakMap<Browser, Promise<CDPSession>>();

/** Per CDP call to a worker; one that does not answer is reported missing. */
const WORKER_CALL_MS = 5000;

/**
 * Each dedicated worker of the page's context (the DOCX engine and its
 * helpers): JS heap after a GC and its WASM memories, overall and per module.
 * Playwright gives workers no CDP session, so a browser session attaches to
 * each one unflattened and talks through Target.sendMessageToTarget. A
 * worker that ends or stops answering on the way is listed as missing, never
 * waited on (every call is bounded, a detach fails what is pending).
 */
async function workerHeaps(page: Page) {
  const browser = page.context().browser();
  if (!browser) throw new Error('No browser to attach to workers');
  let pending = browserSessions.get(browser);
  if (!pending) {
    pending = browser.newBrowserCDPSession();
    browserSessions.set(browser, pending);
  }
  const session = await pending;
  const { targetInfo: own } = await (await cdpSession(page)).send(
    'Target.getTargetInfo'
  );
  const { targetInfos } = await session.send('Target.getTargets');
  const workers = targetInfos.filter(
    (target) =>
      target.type === 'worker' &&
      target.browserContextId === own.browserContextId
  );
  const out = [];
  for (const worker of workers) {
    const named = {
      name: worker.title,
      url: worker.url.split('/').at(-1) ?? worker.url,
    };
    let sessionId: string;
    try {
      ({ sessionId } = await session.send('Target.attachToTarget', {
        flatten: false,
        targetId: worker.targetId,
      }));
    } catch (error) {
      // Ended since the listing.
      out.push({ ...named, missing: String(error).slice(0, 200) });
      continue;
    }
    const replies = new Map<
      number,
      (reply: { error?: { message: string }; result?: unknown }) => void
    >();
    let nextId = 0;
    let detached = false;
    const onMessage = (event: { message: string; sessionId?: string }) => {
      if (event.sessionId !== sessionId) return;
      const reply = JSON.parse(event.message) as {
        error?: { message: string };
        id?: number;
        result?: unknown;
      };
      if (reply.id !== undefined) replies.get(reply.id)?.(reply);
    };
    const onDetached = (event: { sessionId: string }) => {
      if (event.sessionId !== sessionId) return;
      detached = true;
      for (const reply of [...replies.values()])
        reply({ error: { message: 'worker ended' } });
    };
    session.on('Target.receivedMessageFromTarget', onMessage);
    session.on('Target.detachedFromTarget', onDetached);
    const send = <T>(method: string, params: object = {}) =>
      new Promise<T>((resolve, reject) => {
        if (detached) return reject(new Error(`${method}: worker ended`));
        const id = ++nextId;
        const timer = setTimeout(
          () =>
            settle({ error: { message: `no answer in ${WORKER_CALL_MS} ms` } }),
          WORKER_CALL_MS
        );
        const settle = (reply: {
          error?: { message: string };
          result?: unknown;
        }) => {
          clearTimeout(timer);
          replies.delete(id);
          if (reply.error)
            reject(new Error(`${method}: ${reply.error.message}`));
          else resolve(reply.result as T);
        };
        replies.set(id, settle);
        session
          .send('Target.sendMessageToTarget', {
            message: JSON.stringify({ id, method, params }),
            sessionId,
          })
          .catch((error: unknown) =>
            settle({ error: { message: String(error) } })
          );
      });
    // Every live object with the prototype `expression`, mapped in the worker.
    const query = async <T>(expression: string, map: string) => {
      const prototype = await send<{ result: { objectId: string } }>(
        'Runtime.evaluate',
        { expression, objectGroup: 'office-bench' }
      );
      const { objects } = await send<{ objects: { objectId: string } }>(
        'Runtime.queryObjects',
        {
          objectGroup: 'office-bench',
          prototypeObjectId: prototype.result.objectId,
        }
      );
      const mapped = await send<{ result: { value: T } }>(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: `function () { return this.map(${map}); }`,
          objectId: objects.objectId,
          returnByValue: true,
        }
      );
      return mapped.result.value;
    };
    try {
      await send('HeapProfiler.collectGarbage');
      const usage = await send<{ usedSize: number }>('Runtime.getHeapUsage');
      const memories = await query<number[]>(
        'WebAssembly.Memory.prototype',
        '(memory) => memory.buffer.byteLength'
      );
      const instances = await query<{ bytes: number; names: string[] }[]>(
        'WebAssembly.Instance.prototype',
        `(instance) => ({
          bytes: Object.values(instance.exports)
            .filter((value) => value instanceof WebAssembly.Memory)
            .reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
          names: Object.keys(instance.exports),
        })`
      );
      const wasmMB = mb(memories.reduce((sum, bytes) => sum + bytes, 0));
      const wasmModules = byModule(instances);
      out.push({
        ...named,
        jsMB: mb(usage.usedSize),
        // Memories no module exports (created in JS and imported), or, when
        // negative, one memory exported by several instances.
        unattributedMB: unattributed(wasmMB, wasmModules),
        wasmMB,
        wasmModules,
      });
    } catch (error) {
      out.push({ ...named, missing: String(error).slice(0, 200) });
    } finally {
      session.off('Target.receivedMessageFromTarget', onMessage);
      session.off('Target.detachedFromTarget', onDetached);
      // Already gone when the worker ended.
      if (!detached)
        await session
          .send('Target.detachFromTarget', { sessionId })
          .catch(() => undefined);
    }
  }
  return out;
}

const unattributed = (total: number, modules: Record<string, number>) =>
  Math.round(
    (total - Object.values(modules).reduce((sum, value) => sum + value, 0)) *
      10
  ) / 10;

/**
 * The page isolate's retained heap after a GC (runtime frame included), the
 * WASM linear memory still alive in any frame, and the workers' (above).
 */
async function heap(page: Page, { workers: withWorkers = true } = {}) {
  const session = await cdpSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const usage = await session.send('Runtime.getHeapUsage');
  const { documents } = await session.send('Memory.getDOMCounters');
  let wasm = 0;
  const modules: { bytes: number; names: string[] }[] = [];
  for (const frame of page.frames()) {
    const live = await frame.evaluate(() => {
      const memories = new Set(
        (window.__officeWasm ?? []).map((ref) => ref.deref()).filter(Boolean)
      );
      const seen = new Set<WebAssembly.Memory>();
      const modules = [];
      for (const { memory: ref, names } of window.__officeWasmModules ?? []) {
        const memory = ref.deref();
        if (!memory || seen.has(memory)) continue;
        seen.add(memory);
        modules.push({ bytes: memory.buffer.byteLength, names });
      }
      return {
        bytes: [...memories].reduce(
          (sum, memory) => sum + memory!.buffer.byteLength,
          0
        ),
        modules,
      };
    });
    wasm += live.bytes;
    modules.push(...live.modules);
  }
  // Not before a budgeted step: a forced GC and object queries in the
  // engine worker would change what the budgets were calibrated under.
  const workers = withWorkers ? await workerHeaps(page) : null;
  const wasmModules = byModule(modules);
  return {
    // ArrayBuffers and external strings; WASM memory is not among them.
    backingMB: mb(usage.backingStorageSize),
    // Live documents in the renderer: a closed frame that stays counted leaks.
    documents,
    jsMB: mb(usage.usedSize),
    // The frames' WASM (the page's main thread), in all and per module.
    wasmMB: mb(wasm),
    wasmModules,
    unattributedWasmMB: unattributed(mb(wasm), wasmModules),
    // null: not read at this step (see above).
    workers,
    workersJsMB: workers &&
      sum(workers.map((worker) => ('jsMB' in worker ? worker.jsMB : 0))),
    workersMissing:
      workers && workers.filter((worker) => 'missing' in worker).length,
    workersWasmMB:
      workers &&
      sum(workers.map((worker) => ('wasmMB' in worker ? worker.wasmMB : 0))),
  };
}

type Heap = Awaited<ReturnType<typeof heap>>;

const sum = (values: number[]) =>
  Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10;
const delta = (a: number, b: number) => Math.round((a - b) * 10) / 10;
const deltaOf = (a: number | null, b: number | null) =>
  a === null || b === null ? null : delta(a, b);
const growth = (to: Heap, from: Heap) => ({
  backingMB: delta(to.backingMB, from.backingMB),
  documents: to.documents - from.documents,
  jsMB: delta(to.jsMB, from.jsMB),
  wasmMB: delta(to.wasmMB, from.wasmMB),
  workersJsMB: deltaOf(to.workersJsMB, from.workersJsMB),
  workersWasmMB: deltaOf(to.workersWasmMB, from.workersWasmMB),
});

async function openWorkspace(page: Page) {
  await installHostProbe(page);
  await installWasmProbe(page);
  await page.goto(`/workspaces/${PERF_WORKSPACE_ID}`);
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
}

/** Click a file in the tree; for an Office file, wait for its `ready`. */
async function openFile(page: Page, id: string) {
  const link = page.locator(`[data-workspace-file-tree] a[href$="file=${id}"]`);
  await expect(link).toBeVisible({ timeout: 60_000 });
  const [ready] = await clickUntil(page, ['ready'], () => link.click());
  return ready;
}

async function openInView(page: Page, fixture: { id: string }) {
  await openWorkspace(page);
  return openFile(page, fixture.id);
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
  } else await placeInText(page, frame, fixture.text);
}

/** PPTX: a caret at the end of the text box at `point` on the current slide. */
async function placeInText(
  page: Page,
  frame: Frame,
  point: { x: number; y: number }
) {
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Slide is not laid out');
  // A first click selects the shape; a double click selects a word in it.
  await canvas.click({
    clickCount: 2,
    position: { x: box.width * point.x, y: box.height * point.y },
  });
  // The hidden input takes text only with a caret in a text story.
  const input = frame.getByTestId('pptx-text-input');
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute('readonly');
  await page.keyboard.press('ControlOrMeta+End');
}

function cellAt(a1: string) {
  const match = A1.exec(a1);
  if (!match) throw new Error(`Not a cell reference: ${a1}`);
  const col = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return { col, row: Number(match[2]) };
}

/**
 * From where the start typing left off, to the end of the file: the end of
 * the DOCX body, the last used row of the XLSX column, the end of a text box
 * on the last PPTX slide with text. Returns where typing goes.
 */
async function placeCaretAtEnd(page: Page, frame: Frame, fixture: Fixture) {
  if (fixture.format === 'docx') {
    await page.keyboard.press('ControlOrMeta+End');
    return 'body end';
  }
  if (fixture.format === 'xlsx') {
    // Commit the open cell edit, then jump to the column's last used row.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    const nameBox = frame.getByTestId('xlsx-name-box');
    await expect
      .poll(async () => cellAt(await nameBox.inputValue()).row)
      .toBeGreaterThan(cellAt(fixture.cell).row + 1);
    return nameBox.inputValue();
  }
  const slide = frame
    .locator('aside')
    .getByRole('button')
    .nth(fixture.end.slide - 1);
  await slide.click();
  await expect(slide).toHaveAttribute('aria-current', 'page');
  await placeInText(page, frame, fixture.end);
  return `slide ${fixture.end.slide}`;
}

/**
 * Keys at a fixed cadence from the caret where it is; each key's delay to
 * its painted frame.
 */
async function timeKeys(page: Page, frame: Frame, fixture: Fixture) {
  await page.waitForTimeout(1000);
  await frame.evaluate((format) => {
    window.__officeKeys = { keys: [], presents: [] };
    // Once per frame: a second pass reuses the listeners with fresh arrays.
    if (window.__officeKeysInstalled) return;
    window.__officeKeysInstalled = true;
    const probe = () => window.__officeKeys;
    if (format === 'docx') {
      window.addEventListener(
        'keydown',
        () => probe().keys.push(performance.now()),
        true
      );
      document.addEventListener('docx-pages-presented', () =>
        probe().presents.push(performance.now())
      );
      return;
    }
    // The first task after the next frame, rescheduled by each of the key's
    // events, so the latest wins: presents[i] belongs to keys[i].
    const afterFrame = () => {
      const keys = probe();
      const key = keys.keys.length - 1;
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          keys.presents[key] = performance.now();
        };
        channel.port2.postMessage(null);
      });
    };
    window.addEventListener(
      'keydown',
      () => {
        probe().keys.push(performance.now());
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
  const { enters, lags } = await frame.evaluate((format) => {
    const { keys, presents } = window.__officeKeys;
    return {
      // XLSX: each Enter to the next painted grid, the committed value drawn.
      enters: keys.flatMap((key, index) => {
        if (format !== 'xlsx' || index % 6 !== 5) return [];
        const next = window.__xlsxPaints.find((at) => at > key);
        return [next === undefined ? null : next - key];
      }),
      lags: keys.map((key, index) => {
        const next =
          format === 'docx'
            ? presents.find((at) => at > key)
            : presents[index];
        return next === undefined ? null : next - key;
      }),
    };
  }, fixture.format);
  const painted = lags.filter((lag): lag is number => lag !== null);
  const enterPainted = enters.filter((lag): lag is number => lag !== null);
  return {
    // Edits the runtime sent to the room while typing.
    edits: (await countMessages(page, 'update')) - updatesBefore,
    ...(fixture.format === 'xlsx'
      ? {
          enterToPaintP50Ms: Math.round(percentile(enterPainted, 50)),
          enterToPaintP95Ms: Math.round(percentile(enterPainted, 95)),
          unpaintedEnters: enters.length - enterPainted.length,
        }
      : {}),
    keys: lags.length,
    keyToFrameMaxMs: Math.round(Math.max(0, ...painted)),
    keyToFrameP50Ms: Math.round(percentile(painted, 50)),
    keyToFrameP90Ms: Math.round(percentile(painted, 90)),
    keyToFrameP95Ms: Math.round(percentile(painted, 95)),
    unpaintedKeys: lags.length - painted.length,
  };
}

/** Keys at a fixed cadence from the start of the file (placeCaret). */
async function typeAndTime(page: Page, fixture: Fixture) {
  const frame = runtimeFrame(page);
  await placeCaret(page, frame, fixture);
  return timeKeys(page, frame, fixture);
}

const REMOTE_EDITS = 10;

/**
 * A co-editor's edit, as the mock room itself (its own Yjs client) authors
 * it: every participant, the host's source document among them, receives it
 * as remote, and the host forwards it to the runtime frame. Near the start of
 * the file, so it lands on the visible page, grid or slide: `peer ` inside the
 * first text run of the DOCX body or of the first PPTX slide's first text, or
 * a number in the fixture's XLSX cell (a base cell override, as the editor
 * stores one).
 */
async function remoteEdit(page: Page, fixture: Fixture, edit: number) {
  const a1 = fixture.format === 'xlsx' ? cellAt(fixture.cell) : null;
  return page.evaluate(
    ({ a1, edit, format, id }) => {
      const room = [...(window.__capyMockRooms?.values() ?? [])].find(
        (candidate) =>
          candidate.target.kind === 'source' && candidate.target.id === id
      );
      if (!room) throw new Error(`No source room for ${id}`);
      const doc = room.document;
      let bytes = 0;
      const count = (update: Uint8Array) => {
        bytes += update.byteLength;
      };
      doc.on('update', count);
      // Inside a story's first text run of two characters or more, which
      // keeps the text's own formatting and stays clear of the paragraph
      // marks (a DOCX or PPTX story ends with one).
      const insertInRun = (text: Y.Text) => {
        let at = 0;
        for (const op of text.toDelta() as { insert: unknown }[]) {
          if (typeof op.insert === 'string' && op.insert.length >= 2) {
            text.insert(at + 1, 'peer ');
            return true;
          }
          at += typeof op.insert === 'string' ? op.insert.length : 1;
        }
        return false;
      };
      doc.transact(() => {
        if (format === 'docx') {
          if (!insertInRun(doc.getMap('stories').get('body') as Y.Text))
            throw new Error('No DOCX text run to edit');
          return;
        }
        if (format === 'pptx') {
          const first = doc.getArray<string>('pptx:slide-order').get(0);
          const stories = doc.getMap<Y.Text>('pptx:stories');
          const edited = [...stories.keys()]
            .sort()
            .filter((key) => key.startsWith(`story:${first}:`))
            .some((key) => insertInRun(stories.get(key)!));
          if (!edited) throw new Error('No PPTX text on the first slide');
          return;
        }
        const sheet = doc.getArray<string>('xlsx:sheet-order').get(0);
        const contents = (
          doc.getMap<Y.Map<unknown>>('xlsx:sheets').get(sheet) as Y.Map<unknown>
        ).get('contents') as Y.Map<string>;
        // The engine's stable cell key: base row and column points, 0-based,
        // in this key order (the key is compared as text).
        contents.set(
          JSON.stringify([
            { run: 'base', offset: a1!.row - 1 },
            { run: 'base', offset: a1!.col - 1 },
          ]),
          JSON.stringify({
            formula: null,
            value: { kind: 'number', value: 60 + edit },
          })
        );
      }, 'office-bench-peer');
      doc.off('update', count);
      return bytes;
    },
    { a1, edit, format: fixture.format, id: fixture.id }
  );
}

/**
 * The runtime frame's probe for updates the host posts (`update` messages),
 * per delivery:
 * - `queue`: from the host's postMessage (the event's timestamp) to the
 *   frame starting to handle it: the rest of the host's task, which shares
 *   the renderer's main thread, and the wait for the frame's turn;
 * - `apply`: from that receipt to the end of the runtime's synchronous
 *   handler: the receipt is taken by a listener the init script registered
 *   before the runtime's (installHostProbe), the end by one registered after
 *   it. For XLSX and PPTX that is the editor's apply; for DOCX only the
 *   hand-off to the engine worker (`applyScope`);
 * - `toFrame`: from receipt to the next `docx-pages-presented` (DOCX, a real
 *   paint) or to the first task after the next animation frame (XLSX, PPTX:
 *   the next frame, which an asynchronous render could miss; `frameSignal`);
 * - XLSX `toPaint`: from receipt to the next painted grid, the update drawn;
 * - `longTask` (their sum, the time the main thread was blocked) and
 *   `longestTask`: main-thread long tasks from the postMessage to the frame
 *   or, for XLSX, the paint.
 */
async function installRemoteProbe(frame: Frame, format: OfficeFormat) {
  await frame.evaluate((format) => {
    const probe: Window['__officeRemote'] = {
      ends: [],
      frames: [],
      longTasks: [],
      posted: [],
      presents: [],
      receivedFrom: window.__officeUpdateReceipts.length,
    };
    window.__officeRemote = probe;
    const nextTask = (then: () => void) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = then;
      channel.port2.postMessage(null);
    };
    const isUpdate = (event: MessageEvent) =>
      (event.data as { type?: unknown })?.type === 'update';
    // After the runtime's listener: the end of its synchronous handling.
    window.addEventListener('message', (event) => {
      if (!isUpdate(event)) return;
      probe.posted.push(event.timeStamp);
      const index = probe.ends.push(performance.now()) - 1;
      if (format !== 'docx')
        requestAnimationFrame(() =>
          nextTask(() => {
            probe.frames[index] = performance.now();
          })
        );
    });
    document.addEventListener('docx-pages-presented', () =>
      probe.presents.push(performance.now())
    );
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.longTasks.push({
          duration: entry.duration,
          start: entry.startTime,
        });
    }).observe({ type: 'longtask' });
  }, format);
}

/** Delivery `index` (since the probe) reached its frame, for XLSX its paint. */
async function awaitDelivery(
  frame: Frame,
  format: OfficeFormat,
  index: number,
  timeout = 30_000
) {
  await frame
    .waitForFunction(
      ({ format, index }) => {
        const { frames, presents, receivedFrom } = window.__officeRemote;
        const at = window.__officeUpdateReceipts[receivedFrom + index];
        if (at === undefined) return false;
        if (format === 'docx') return presents.some((present) => present > at);
        if (format === 'xlsx')
          return (
            frames[index] !== undefined &&
            window.__xlsxPaints.some((paint) => paint > at)
          );
        return frames[index] !== undefined;
      },
      { format, index },
      { polling: 50, timeout }
    )
    .catch(() => undefined);
}

/** Every delivery's figures since the probe was installed. */
function deliveries(frame: Frame, format: OfficeFormat) {
  return frame.evaluate((format) => {
    const { ends, frames, longTasks, posted, presents, receivedFrom } =
      window.__officeRemote;
    const received = window.__officeUpdateReceipts.slice(receivedFrom);
    return received.map((at, index) => {
      const framed =
        format === 'docx'
          ? presents.find((present) => present > at)
          : frames[index];
      const painted =
        format === 'xlsx'
          ? window.__xlsxPaints.find((paint) => paint > at)
          : undefined;
      const until = Math.max(framed ?? ends[index] ?? at, painted ?? 0);
      const blocking = longTasks.filter(
        ({ start }) => start >= posted[index] - 1 && start < until
      );
      return {
        applyMs: ends[index] === undefined ? null : ends[index] - at,
        longestTaskMs: Math.max(0, ...blocking.map((task) => task.duration)),
        longTaskMs: blocking.reduce((sum, { duration }) => sum + duration, 0),
        queueMs: at - posted[index],
        toFrameMs: framed === undefined ? null : framed - at,
        toPaintMs: painted === undefined ? null : painted - at,
      };
    });
  }, format);
}

const stats = (values: (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return {
    maxMs: Math.round(Math.max(0, ...known)),
    p50Ms: Math.round(percentile(known, 50)),
    p90Ms: Math.round(percentile(known, 90)),
  };
};

/** Remote edits one at a time, each to its frame in the open editor. */
async function timeRemoteEdits(page: Page, fixture: Fixture) {
  const frame = runtimeFrame(page);
  await installRemoteProbe(frame, fixture.format);
  const updateBytes: number[] = [];
  for (let edit = 0; edit < REMOTE_EDITS; edit += 1) {
    updateBytes.push(await remoteEdit(page, fixture, edit));
    await awaitDelivery(frame, fixture.format, edit);
    await page.waitForTimeout(500);
  }
  const edits = await deliveries(frame, fixture.format);
  return {
    apply: stats(edits.map((edit) => edit.applyMs)),
    applyScope:
      fixture.format === 'docx' ? 'handoff only' : 'synchronous apply',
    // Remote updates the runtime received (one per edit).
    arrived: edits.length,
    edits: REMOTE_EDITS,
    frameSignal:
      fixture.format === 'docx' ? 'docx-pages-presented' : 'next frame',
    longestTask: stats(edits.map((edit) => edit.longestTaskMs)),
    longTask: stats(edits.map((edit) => edit.longTaskMs)),
    queue: stats(edits.map((edit) => edit.queueMs)),
    toFrame: stats(edits.map((edit) => edit.toFrameMs)),
    ...(fixture.format === 'xlsx'
      ? { toPaint: stats(edits.map((edit) => edit.toPaintMs)) }
      : {}),
    unframed: edits.filter((edit) => edit.toFrameMs === null).length,
    updateBytes: Math.max(0, ...updateBytes),
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

const benchRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);

/** The XLSX fixtures' files and the mock rooms' states they open with. */
const XLSX_FILES: Record<string, { source: string; state: string }> = {
  'bio-office-xlsx': {
    source: 'e2e/fixtures/files/rich-content/course-guide.xlsx',
    state: 'src/mocks/fixtures/rich-xlsx-checkpoint.bin',
  },
  'bio-office-xlsx-long': {
    source: 'bench/editor/fixtures/office/large-gradebook.xlsx',
    state: 'src/mocks/fixtures/long-xlsx-checkpoint.bin',
  },
};

// A peer's paste and a local one: 1,000 rows by 8 columns from the fixture's cell.
const PASTE = { cols: 8, rows: 1000 };
const pasted = (row: number, col: number) => String((row * 7 + col) % 97);

/**
 * A peer's update made by the XLSX engine in Node, as a co-editor's editor
 * makes it: the fixture opened over its room's state under its own client,
 * `edit` run, the local updates it emits returned.
 */
async function peerUpdates(
  fixture: Fixture,
  edit: (
    handle: import('../../../vendor/betteroffice/packages/xlsx/src/wasm/loader').WorkbookHandle
  ) => void
) {
  const engine = (await import(
    '../../../vendor/betteroffice/packages/xlsx/src/wasm/loader'
  )) as typeof import('../../../vendor/betteroffice/packages/xlsx/src/wasm/loader');
  await engine.initWasm(
    readFileSync(
      path.join(
        benchRoot,
        'vendor/betteroffice/packages/xlsx/src/wasm/generated/xlsx_wasm_bg.wasm'
      )
    )
  );
  const files = XLSX_FILES[fixture.id];
  const handle = engine.openWorkbook(
    readFileSync(path.join(benchRoot, files.source)),
    { clientId: 4_000_000_001, collaborative: true }
  );
  try {
    handle.applyUpdate(readFileSync(path.join(benchRoot, files.state)));
    const updates: Uint8Array[] = [];
    handle.onUpdate((update, origin) => {
      if (origin === 'local') updates.push(update);
    });
    edit(handle);
    return updates;
  } finally {
    handle.dispose();
  }
}

/**
 * Posts updates to the runtime as the host would (from its parent window),
 * bypassing the room: the peer's update reaches only the editor measured.
 */
async function postToRuntime(page: Page, updates: Uint8Array[]) {
  const { epoch, version } = await page.evaluate(() => {
    const ready = window.__officeBench.messages
      .filter((message) => message.type === 'collaboration-ready')
      .at(-1)!;
    return { epoch: ready.epoch!, version: ready.version! };
  });
  const iframe = await runtimeFrame(page).frameElement();
  await iframe.evaluate(
    (element, { encoded, epoch, version }) => {
      const target = element as HTMLIFrameElement;
      for (const text of encoded) {
        const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        target.contentWindow!.postMessage(
          { bytes: bytes.buffer, epoch, type: 'update', version },
          new URL(target.src).origin,
          [bytes.buffer]
        );
      }
    },
    {
      encoded: updates.map((update) => Buffer.from(update).toString('base64')),
      epoch,
      version,
    }
  );
}

/**
 * A local operation in the runtime frame, from `trigger` (a key press or a
 * message posted to the frame) to the next painted grid, with the frame's
 * long tasks in between.
 */
async function timeLocal(
  page: Page,
  frame: Frame,
  trigger: () => Promise<void>,
  startOn: 'keydown' | 'menu-command'
) {
  await frame.evaluate((startOn) => {
    const local = {
      paintsFrom: window.__xlsxPaints.length,
      start: undefined as number | undefined,
      tasks: [] as { duration: number; start: number }[],
    };
    (window as unknown as { __officeLocal: typeof local }).__officeLocal =
      local;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        local.tasks.push({ duration: entry.duration, start: entry.startTime });
    });
    observer.observe({ type: 'longtask' });
    if (startOn === 'keydown')
      window.addEventListener(
        'keydown',
        () => {
          local.start ??= performance.now();
        },
        { capture: true, once: true }
      );
    else
      window.addEventListener('message', function listen(event) {
        if ((event.data as { type?: unknown })?.type !== 'menu-command')
          return;
        // The post's time: this listener runs after the runtime's handler.
        local.start ??= event.timeStamp;
        window.removeEventListener('message', listen);
      });
  }, startOn);
  await trigger();
  const paint = () =>
    frame.evaluate(() => {
      const local = (
        window as unknown as {
          __officeLocal: { paintsFrom: number; start?: number };
        }
      ).__officeLocal;
      return local.start === undefined
        ? undefined
        : window.__xlsxPaints
            .slice(local.paintsFrom)
            .find((at) => at > local.start!);
    });
  await expect.poll(paint, { intervals: [50], timeout: 120_000 }).toBeDefined();
  await page.waitForTimeout(1000);
  return frame.evaluate(() => {
    const local = (
      window as unknown as {
        __officeLocal: {
          paintsFrom: number;
          start: number;
          tasks: { duration: number; start: number }[];
        };
      }
    ).__officeLocal;
    const painted = window.__xlsxPaints
      .slice(local.paintsFrom)
      .find((at) => at > local.start)!;
    const blocking = local.tasks.filter(
      (task) => task.start >= local.start - 1 && task.start < painted
    );
    return {
      longestTaskMs: Math.round(
        Math.max(0, ...blocking.map((task) => task.duration))
      ),
      longTaskMs: Math.round(
        blocking.reduce((sum, task) => sum + task.duration, 0)
      ),
      toPaintMs: Math.round(painted - local.start),
    };
  });
}

/**
 * Scrolls the grid down by `step` px every animation frame for `duration`
 * ms: the grid's paints and the frames per second, the longest gap between
 * paints and the frame's long tasks meanwhile.
 */
function scrollRun(frame: Frame, step: number, duration: number) {
  return frame.evaluate(
    async ({ duration, step }) => {
      const scroll = document.querySelector<HTMLElement>(
        '[data-testid="xlsx-scroll"]'
      )!;
      scroll.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const from = window.__xlsxPaints.length;
      const tasks: { duration: number; start: number }[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          tasks.push({ duration: entry.duration, start: entry.startTime });
      });
      observer.observe({ type: 'longtask' });
      const frames: number[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          frames.push(now);
          if (now - start >= duration) return resolve();
          scroll.scrollTop += step;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const end = performance.now();
      const scrolledPx = scroll.scrollTop;
      await new Promise((resolve) => setTimeout(resolve, 500));
      observer.disconnect();
      const paints = window.__xlsxPaints
        .slice(from)
        .filter((at) => at >= start && at <= end);
      const gaps = paints.slice(1).map((at, index) => at - paints[index]);
      const blocking = tasks.filter(
        (task) => task.start >= start && task.start < end
      );
      const seconds = (end - start) / 1000;
      scroll.scrollTop = 0;
      return {
        framesPerSecond: Math.round(frames.length / seconds),
        longestPaintGapMs: Math.round(Math.max(0, ...gaps)),
        longestTaskMs: Math.round(
          Math.max(0, ...blocking.map((task) => task.duration))
        ),
        longTaskMs: Math.round(
          blocking.reduce((sum, task) => sum + task.duration, 0)
        ),
        paintsPerSecond: Math.round(paints.length / seconds),
        scrolledPx,
        stepPx: step,
      };
    },
    { duration, step }
  );
}

/** The 50,000-row sheet scrolled in the editor (see the file's comment). */
const ROWS_FIXTURE = {
  format: 'xlsx',
  id: 'bio-office-xlsx-rows',
  name: 'rows-50k.xlsx',
} as const;

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
    // Page only until the budgeted steps are done (heap(), workers).
    const openHeap = await heap(page, { workers: false });

    const mode = page.getByRole('button', { name: m.material_mode() });
    await expect(mode).toBeEnabled({ timeout: 60_000 });
    // `ready` is the edit frame's first paint; XLSX/PPTX budgets stay on
    // `collaboration-ready` until recalibrated.
    const [painted, replica = painted] = await clickUntil(
      page,
      fixture.format === 'docx' ? ['ready'] : ['ready', 'collaboration-ready'],
      () => mode.click()
    );
    const edit = { ...replica, firstPaintMs: painted.ms };
    // Let the edit frame's idle work (mirror, glyph cache) settle first.
    await page.waitForTimeout(5000);
    const editHeap = await heap(page, { workers: false });
    const typing = await typeAndTime(page, fixture);
    await page.waitForTimeout(2000);
    const typingHeap = await heap(page);
    // Report-only: the same keys at the end of the file, where the DOCX
    // engine has no later pages to lay out again.
    const frame = runtimeFrame(page);
    const endAt = await placeCaretAtEnd(page, frame, fixture);
    const typingEnd = await timeKeys(page, frame, fixture);
    await page.waitForTimeout(2000);
    const typingEndHeap = await heap(page);

    const budget = budgetOf(MEDIANS[fixture.id]);
    await reportMetrics(
      testInfo,
      `office-${fixture.format}-${fixture.id}`,
      {
        budget: {
          ...budget,
          editFirstPaintMs:
            fixture.format === 'docx' ? budget.editReadyMs : 'report-only',
          heap: 'report-only',
        },
        edit: {
          firstPaintMs: edit.firstPaintMs,
          readyMs: edit.ms,
          runtime: painted.runtime,
        },
        fixture: fixture.name,
        // Report-only: a ceiling still needs defining.
        heap: {
          afterEdit: editHeap,
          afterOpen: openHeap,
          afterTyping: typingHeap,
          afterTypingEnd: typingEndHeap,
        },
        open: { firstPaintMs: open.ms, runtime: open.runtime },
        runner: RUNNER,
        typing: { ...typing, cadenceMs: KEY_CADENCE_MS },
        typingEnd: { ...typingEnd, at: endAt, cadenceMs: KEY_CADENCE_MS },
        units: open.units,
        workerFallbacks: fallbacks.length,
      },
      'unthrottled'
    );
    // Every viewer and editor reports its first paint with the runtime's own timings.
    expect(open.runtime).not.toBeNull();
    expect(painted.runtime).not.toBeNull();
    expect(typing.unpaintedKeys).toBe(0);
    expect(typing.edits).toBeGreaterThan(0);
    expect(typingEnd.unpaintedKeys).toBe(0);
    expect(typingEnd.edits).toBeGreaterThan(0);
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

  // A second peer's edits while the measured editor is open: what applying a
  // remote update costs the editor's main thread (the XLSX editor rebuilds
  // the workbook for one), on its own page so typing stays comparable.
  test(`${fixture.format} ${fixture.name}: co-editor remote edits`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    await openInView(page, fixture);
    const mode = page.getByRole('button', { name: m.material_mode() });
    await expect(mode).toBeEnabled({ timeout: 60_000 });
    await clickUntil(
      page,
      fixture.format === 'docx' ? ['ready'] : ['ready', 'collaboration-ready'],
      () => mode.click()
    );
    await page.waitForTimeout(5000);
    // Report-only case: the workers' memory after View to Edit is read here,
    // where no budget follows.
    const editHeap = await heap(page);
    await page.waitForTimeout(2000);
    const remote = await timeRemoteEdits(page, fixture);
    await page.waitForTimeout(2000);
    const errors = await page.evaluate(() =>
      window.__officeBench.messages
        .filter((message) => message.type === 'error')
        .map((message) => message.message)
    );
    await reportMetrics(
      testInfo,
      `office-${fixture.format}-${fixture.id}-co-editor`,
      {
        budget: 'report-only',
        errors,
        fixture: fixture.name,
        heap: { afterEdit: editHeap, afterRemoteEdits: await heap(page) },
        remote,
        runner: RUNNER,
      },
      'unthrottled'
    );
    expect(errors).toEqual([]);
    expect(remote.arrived).toBe(REMOTE_EDITS);
    expect(remote.unframed).toBe(0);
    // The sheet's own reading of the peer's last value.
    if (fixture.format === 'xlsx') {
      const frame = runtimeFrame(page);
      await placeCaret(page, frame, fixture);
      await expect(frame.getByTestId('xlsx-formula-input')).toHaveValue(
        String(60 + REMOTE_EDITS - 1)
      );
    }
  });

  // XLSX: large operations, a peer's and the user's own, in the open editor.
  if (fixture.format === 'xlsx')
    test(`${fixture.format} ${fixture.name}: large paste and row insert, a peer's and local`, async ({
      context,
      page,
    }, testInfo) => {
      test.setTimeout(600_000);
      await openInView(page, fixture);
      const mode = page.getByRole('button', { name: m.material_mode() });
      await expect(mode).toBeEnabled({ timeout: 60_000 });
      await clickUntil(page, ['ready', 'collaboration-ready'], () =>
        mode.click()
      );
      await page.waitForTimeout(5000);
      const frame = runtimeFrame(page);
      const at = cellAt(fixture.cell);
      const paste = await peerUpdates(fixture, (handle) => {
        const edits = [];
        for (let row = 0; row < PASTE.rows; row += 1)
          for (let col = 0; col < PASTE.cols; col += 1)
            edits.push({
              col: at.col - 1 + col,
              input: pasted(row, col),
              row: at.row - 1 + row,
            });
        handle.editCells(0, edits);
      });
      const insert = await peerUpdates(fixture, (handle) => {
        handle.applyOps([
          { at: at.row - 1, count: 1, sheet: 0, type: 'insertRows' },
        ]);
      });
      await installRemoteProbe(frame, fixture.format);
      await postToRuntime(page, paste);
      await awaitDelivery(frame, fixture.format, 0, 120_000);
      await page.waitForTimeout(1000);
      await postToRuntime(page, insert);
      await awaitDelivery(frame, fixture.format, 1, 120_000);
      await page.waitForTimeout(1000);
      const [peerPaste, peerInsert] = await deliveries(frame, fixture.format);

      // The user's own: a paste from the clipboard at the fixture's cell, and
      // Insert › Row above from Capy's menu.
      for (const origin of [
        new URL(page.url()).origin,
        new URL(frame.url()).origin,
      ])
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin,
        });
      await placeCaret(page, frame, fixture);
      await frame.evaluate(
        ({ cols, rows }) => {
          const lines = [];
          for (let row = 0; row < rows; row += 1)
            lines.push(
              Array.from({ length: cols }, (_, col) =>
                String((row * 7 + col) % 97)
              ).join('\t')
            );
          return navigator.clipboard.writeText(lines.join('\n'));
        },
        PASTE
      );
      const localPaste = await timeLocal(
        page,
        frame,
        () => page.keyboard.press('ControlOrMeta+v'),
        'keydown'
      );
      const { version } = await page.evaluate(
        () =>
          window.__officeBench.messages.find(
            (message) => message.type === 'collaboration-ready'
          )!
      );
      const iframe = await frame.frameElement();
      const localInsert = await timeLocal(
        page,
        frame,
        () =>
          iframe.evaluate(
            (element, version) => {
              const target = element as HTMLIFrameElement;
              target.contentWindow!.postMessage(
                { id: 'insertRowAbove', type: 'menu-command', version },
                new URL(target.src).origin
              );
            },
            version
          ),
        'menu-command'
      );
      const errors = await page.evaluate(() =>
        window.__officeBench.messages
          .filter((message) => message.type === 'error')
          .map((message) => message.message)
      );
      const round = (delivery: (typeof peerPaste) | undefined) =>
        delivery && {
          applyMs: delivery.applyMs === null ? null : Math.round(delivery.applyMs),
          longestTaskMs: Math.round(delivery.longestTaskMs),
          longTaskMs: Math.round(delivery.longTaskMs),
          toPaintMs:
            delivery.toPaintMs === null ? null : Math.round(delivery.toPaintMs),
        };
      await reportMetrics(
        testInfo,
        `office-${fixture.format}-${fixture.id}-large-ops`,
        {
          budget: 'report-only',
          errors,
          fixture: fixture.name,
          heap: await heap(page),
          local: { insertRow: localInsert, paste: localPaste },
          paste: PASTE,
          peer: { insertRow: round(peerInsert), paste: round(peerPaste) },
          runner: RUNNER,
          updateBytes: {
            insertRow: insert.reduce((sum, update) => sum + update.byteLength, 0),
            paste: paste.reduce((sum, update) => sum + update.byteLength, 0),
          },
        },
        'unthrottled'
      );
      expect(errors).toEqual([]);
      expect(peerPaste?.toPaintMs).not.toBeNull();
      expect(peerInsert?.toPaintMs).not.toBeNull();
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
        runner: RUNNER,
        secondPassGrowth: growth(second, first),
      },
      'unthrottled'
    );
  });
}

// The 50,000-row sheet in the editor: open to editable, then scrolling it
// slowly and fast, with the paints the grid keeps up with.
test(`xlsx ${ROWS_FIXTURE.name}: open to Edit and scrolling`, async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const open = await openInView(page, ROWS_FIXTURE);
  const mode = page.getByRole('button', { name: m.material_mode() });
  await expect(mode).toBeEnabled({ timeout: 120_000 });
  const [painted, replica] = await clickUntil(
    page,
    ['ready', 'collaboration-ready'],
    () => mode.click()
  );
  await page.waitForTimeout(5000);
  const editHeap = await heap(page);
  const frame = runtimeFrame(page);
  const scroll = {
    fast: await scrollRun(frame, 600, 3000),
    slow: await scrollRun(frame, 60, 3000),
  };
  await page.waitForTimeout(2000);
  await reportMetrics(
    testInfo,
    `office-xlsx-${ROWS_FIXTURE.id}-scroll`,
    {
      budget: 'report-only',
      edit: { firstPaintMs: painted.ms, readyMs: replica.ms },
      fixture: ROWS_FIXTURE.name,
      heap: { afterEdit: editHeap, afterScroll: await heap(page) },
      open: { firstPaintMs: open.ms },
      runner: RUNNER,
      scroll,
    },
    'unthrottled'
  );
  expect(scroll.slow.paintsPerSecond).toBeGreaterThan(0);
});

// A plain text file to switch to: opening it closes the Office file, as the
// workspace has no close button. Seeded in the same workspace (src/mocks/db.ts).
const TEXT_FILE = 'bio-state-ready';
const CYCLES = 5;
const CYCLED = FIXTURES.filter(
  (fixture) => !fixture.id.endsWith('-long') || fixture.format === 'docx'
);

// The view-mode creep item (todo-office.md) as it was seen: open a file in
// View, close it, again and again, with the heap after each close.
for (const fixture of CYCLED)
  test(`${fixture.format} ${fixture.name}: view-mode heap over open and close`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    await openWorkspace(page);
    const text = page.locator(
      `[data-workspace-file-tree] a[href$="file=${TEXT_FILE}"]`
    );
    await text.click();
    await page.waitForTimeout(2000);
    const beforeOpen = await heap(page);
    const afterClose: Heap[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await openFile(page, fixture.id);
      await page.waitForTimeout(1000);
      await text.click();
      await expect
        .poll(() =>
          page.frames().some((frame) => frame.url().includes('office-runtime'))
        )
        .toBe(false);
      await page.waitForTimeout(1000);
      afterClose.push(await heap(page));
    }
    await reportMetrics(
      testInfo,
      `office-${fixture.format}-${fixture.id}-open-close-heap`,
      {
        afterClose,
        beforeOpen,
        budget: 'report-only',
        cycles: CYCLES,
        fixture: fixture.name,
        // The first close keeps the Office host code; later ones grow ~0.25 MB
        // each for about ten cycles while V8 optimizes host code, then level
        // off (openwiki/editor-perf.md).
        growthAfterFirstClose: growth(afterClose.at(-1)!, afterClose[0]),
        runner: RUNNER,
      },
      'unthrottled'
    );
  });
