import {
  type Browser,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import {
  PERF_COMMON_NOTE,
  PERF_COMMON_SEED_KEY,
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from '../../../src/mocks/perfSeed';
import {
  blockingStats,
  CPU_RATE,
  cdpSession,
  collectMetrics,
  frameStats,
  installPerfInstrumentation,
  percentile,
  reportMetrics,
  resetMetrics,
  startFrameSampler,
  stopFrameSampler,
  throttleCpu,
  typingStats,
} from './metrics';

/**
 * Which editor this run measures (`PERF_EDITOR`, set for the config too):
 * - unset: Plate, the four budgeted cases only (production promotion);
 * - `plate`: those, plus Plate's side of the BlockSuite comparison (the
 *   common-subset note, heap and first key after open, a peer burst);
 * - `blocks`: BlockSuite (`VITE_DOCUMENT_LAYOUT=blocks`, which the config
 *   passes its dev server: one Vite process serves one layout), every case
 *   under its Plate name with a `blocks-` prefix, report-only (D8: no speed
 *   gate, todo-blocksuite-spike.md).
 */
const EDITOR = process.env.PERF_EDITOR ?? '';
const BLOCKS = EDITOR === 'blocks';
const COMPARE = EDITOR === 'plate' || BLOCKS;
const caseName = (name: string) => (BLOCKS ? `blocks-${name}` : name);

// Plain words only — no autoformat/slash/markdown trigger characters, so the
// measurement reflects the steady-state typing path.
const TYPING_TEXT =
  'measuring editor latency with plain words that avoid every input rule trigger in the registry';
const KEY_DELAY_MS = 40;

/**
 * Budgets are regression tripwires, not UX targets. They assume the default
 * PERF_CPU=4 throttle and the Vite DEV build (unminified, React dev mode,
 * StrictMode double-render), which inflates absolute numbers well beyond
 * production. Values are ~2x the numbers observed at recalibration (Aug 2026,
 * after the per-keystroke work described below was cut); if one trips, run
 * `typingProfile.perf.ts` under the same throttle before touching it — the
 * attached `worstLoafs` script attribution and that profile's watched frames
 * usually name the offender between them.
 *
 * Observed at recalibration against the ~2MB / 7.4k-node load-test note (dev
 * build, unthrottled opens, cpu x4 elsewhere):
 * - opening it: ~16s interactive (11s blocking), ~2s read-only (0.2s blocking).
 *   Open is now the worst number here and the one left to attack.
 * - small doc typing: INP ~130ms, ~2.5ms blocking per keystroke
 * - near-limit typing: INP ~0.5s, ~310ms blocking per keystroke
 * - save cycle: ~0.4s blocking
 * - scroll: ~40 FPS, ~5% janky frames
 *
 * Typing and scroll used to be far worse (~1.1s per keystroke, ~7 FPS). Three
 * things were paying per keystroke regardless of what was edited: the chunk
 * size left the document in four chunks so one character re-created ~1000
 * element descriptors, the table-of-contents query walked every node and
 * returned a fresh array that no equality check could match, and the toolbar's
 * table menu subscribed to the selected cells while closed. The same chunk
 * size was also the granularity of the `content-visibility: auto` boxes, which
 * is why scrolling moved with it.
 *
 * The budgets are Plate's: BlockSuite's cases assert only that they ran.
 */
const BUDGET = {
  // Ceilings sit at ~1.3x the median of three ubuntu-24.04 runs on 2026-09-03
  // (mixed AMD EPYC 9V74 / Intel Xeon pool, CPU x4). They are the only perf
  // gate and only a human lowers them. See openwiki/editor-perf.md.
  large: {
    // Wall-clock from navigation to a synced, editable Plate instance. Measured
    // unthrottled: this path is already tens of seconds without any slowdown.
    interactiveOpenMs: 20_000, // median 15,165
    // Rebaselined 2026-10-04 to ~1.3x the median of six runs on 37fa7e53
    // (3,118; it was 1,952 on 2026-09-03). The growth is the workspace page's
    // startup imports, not the read-only render; trimming them back under
    // 2,600 is tracked in openwiki/editor-perf.md.
    readOnlyOpenMs: 4050,
    // Debounce, Yjs commit, the acknowledgement's state updates, and the
    // projection invalidation. Nothing here may touch the document tree, so
    // this budget is the tripwire for a regression that reconnects the save
    // path to the editor's render.
    saveCycleBlockingMs: 475, // median 362
    typingBlockingPerKeystrokeMs: 275, // median 209
    typingP95KeyEventMs: 395, // median 304
  },
  scroll: {
    avgFps: 38, // median 50.2, higher is better
    longestFrameMs: 370, // median 283
  },
  small: {
    // GHA measures 0ms; the floor exists so a local run has something to hit.
    typingBlockingPerKeystrokeMs: 10,
    // Event durations come in 8ms steps, so 1.3x (73) would sit one step above
    // the median and fail on the next step; held at 1.5x (median 56).
    typingP95KeyEventMs: 84,
  },
};

/** The single worst keystroke, reported but never failed on: one GC pause or
 * two queued keystrokes in one frame set it, so it spreads too far run to run
 * (small 80-128ms, large 336-528ms on one SHA). Over these, a run warns. */
const WORST_KEY_WARNING_MS = { large: 500, small: 85 };

function warnOnWorstKey(
  testInfo: TestInfo,
  label: string,
  inpApproxMs: number,
  ceiling: number
) {
  if (BLOCKS || inpApproxMs < ceiling) return;
  const description = `${label}: worst keystroke ${inpApproxMs}ms (warning above ${ceiling}ms, not a failure)`;
  testInfo.annotations.push({ description, type: 'warning' });
  console.warn(`[perf] ${description}`);
}

type PerfNote =
  | typeof PERF_COMMON_NOTE
  | typeof PERF_LARGE_NOTE
  | typeof PERF_SMALL_NOTE;

/** The weight the app itself reports for a fixture, so a report never claims a
 * document shape the generator has since drifted away from. Read through the
 * page: the mocks live in a service worker, which `page.request` bypasses.
 * BlockSuite's also counts its placeholder blocks: the load-test note's
 * `capy:*` blocks (columns, TOC, Mermaid, video...) render as placeholders
 * there, so its large-note cases are lighter than Plate's. */
async function documentWeight(page: Page, materialId: string) {
  return page.evaluate(
    async ([workspaceId, id, blocks]) => {
      const response = await fetch(`/api/workspaces/${workspaceId}/materials`);
      const materials = (await response.json()) as {
        id: string;
        nodeCount: number;
        sizeBytes: number;
      }[];
      const material = materials.find((entry) => entry.id === id);
      return {
        nodeCount: material?.nodeCount ?? 0,
        sizeBytes: material?.sizeBytes ?? 0,
        ...(blocks && {
          placeholderBlocks: document.querySelectorAll(
            '[data-capy-placeholder]'
          ).length,
        }),
      };
    },
    [PERF_WORKSPACE_ID, materialId, BLOCKS] as const
  );
}

/** How the reader answered the heavy-document interstitial. `readOnly` skips
 * the collaboration handshake and the editing plugins, which is the cheaper
 * path the gate exists to offer. */
type OpenChoice = 'interactive' | 'readOnly';

const saveState = (page: Page) => page.getByTestId('editor-save-state');

/** The editor is live while Synced, Syncing or Saved; pending checkpoints
 * must not add persistence latency to the interactive-open measurement. */
async function expectLive(page: Page): Promise<void> {
  await expect(saveState(page)).toHaveAttribute(
    'data-save-state',
    /^(synced|syncing|saved)$/,
    {
      timeout: 120_000,
    }
  );
}

/**
 * BlockSuite's note has no save state: it is live once its blocks are
 * editable (after its room synced) and show `readyText`. Checked in the page
 * with native DOM calls that stop at the first match: a Playwright locator
 * walks the whole DOM, shadow roots included, in JS on the page's main thread
 * at every poll, and BlockSuite renders every block (about 0.7 s a check on
 * the laptop, unthrottled), so its polls slowed the open they measured.
 */
async function blocksReady(page: Page, readyText: string) {
  await page.waitForFunction(
    (text) => {
      const note = document.querySelector('[data-blocksuite-note]');
      if (!note?.querySelector('[contenteditable="true"]')) return false;
      const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.textContent?.includes(text)) return true;
      return false;
    },
    readyText,
    { polling: 100, timeout: 120_000 }
  );
}

interface OpenResult {
  editor: Locator;
  openMs: number;
}

/** The note's editing surface: Plate's editable, or the BlockSuite note's
 * scroll container (each block's text is its own editable there). */
const editorOf = (page: Page) =>
  BLOCKS
    ? page.locator('[data-blocksuite-note]')
    : page.locator('[contenteditable="true"]').first();

/** The common-subset note's size as a fraction of the load-test note's:
 * 1 (both near the limit), or less for a local smoke run, where it is too
 * small to be gated. */
const COMMON_SCALE = Number(process.env.PERF_COMMON_SCALE ?? 1);

/** The common-subset note is seeded only for pages that ask (perfSeed.ts). */
async function seedCommonNote(page: Page) {
  await page.addInitScript(
    ([key, scale]) => sessionStorage.setItem(key, scale),
    [PERF_COMMON_SEED_KEY, String(COMMON_SCALE)] as const
  );
}

/**
 * Navigate straight to a note and answer the heavy-document interstitial.
 * Whether the gate appears is asserted rather than tolerated: the perf fixture
 * sits well past `MATERIAL_RENDER_WARNING`, so a missing gate means the gate
 * regressed and every number below it would be measuring a different path.
 */
async function openNote(
  page: Page,
  note: PerfNote,
  { choice = 'interactive' }: { choice?: OpenChoice } = {}
): Promise<OpenResult> {
  const gated =
    note === PERF_LARGE_NOTE || (note === PERF_COMMON_NOTE && COMMON_SCALE === 1);
  const startedAt = Date.now();
  await page.goto(
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(note.id)}&mode=${choice === 'readOnly' ? 'view' : 'edit'}`
  );

  const openAnyway = page.getByTestId('heavy-material-open');
  const openReadOnly = page.getByTestId('heavy-material-read-only');
  const editor = editorOf(page);

  if (gated) {
    await expect(openAnyway, 'heavy-document interstitial').toBeVisible({
      timeout: 120_000,
    });
    await (choice === 'readOnly' ? openReadOnly : openAnyway).click();
  }

  if (choice === 'readOnly') {
    await expect(
      page.getByRole('main').getByText(note.readyText).first()
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.locator('[contenteditable="true"]'),
      'read-only never mounts an editable surface'
    ).toHaveCount(0);
  } else {
    if (BLOCKS) await blocksReady(page, note.readyText);
    else {
      await expect(editor).toBeVisible({ timeout: 120_000 });
      await expect(editor.getByText(note.readyText).first()).toBeVisible({
        timeout: 120_000,
      });
      await expectLive(page);
    }
    if (!gated) {
      await expect(openAnyway, 'small note must not be gated').toHaveCount(0);
    }
  }

  const openMs = Date.now() - startedAt;
  // Let initial render and decoration effects settle so they do not pollute
  // the measurement window.
  await page.waitForTimeout(1500);
  return { editor, openMs };
}

/** The caret at the end of the note's title: a click at its text's right
 * edge, then End (which macOS does not take in an editable). */
async function caretAtReadyText(page: Page, editor: Locator, note: PerfNote) {
  const text = editor.getByText(note.readyText).first();
  const box = await text.boundingBox();
  if (!box) throw new Error(`${note.readyText} has no bounding box`);
  await text.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press('End');
}

/** First keystrokes after load pay one-off costs (lazy module evaluation, JIT
 * warm-up); exclude them so the measurement reflects steady-state. The warm-up
 * also schedules a checkpoint, whose acknowledgement invalidates the material
 * query and re-renders the editor — wait that cycle out so it does not land
 * inside the measured typing window. A BlockSuite room has no checkpoint under
 * MSW (its edits are stored when the room empties), so it only settles. */
async function warmUpTyping(page: Page): Promise<void> {
  await page.keyboard.type(' warm up words first', { delay: KEY_DELAY_MS });
  if (BLOCKS) {
    await page.waitForTimeout(2000);
  } else {
    await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
      timeout: 120_000,
    });
    // The acknowledgement also triggers a projection refetch (~1s of mock
    // latency) whose response re-renders the editor.
    await page.waitForTimeout(4000);
  }
  await resetMetrics(page);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The page's JS heap after a forced GC, and its DOM nodes. */
async function heapAfterOpen(page: Page) {
  const session = await cdpSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const { usedSize } = await session.send('Runtime.getHeapUsage');
  const { nodes } = await session.send('Memory.getDOMCounters');
  return { domNodes: nodes, jsMB: round1(usedSize / 2 ** 20) };
}

/**
 * The first keystroke into a freshly opened note, at CPU x`CPU_RATE`: from
 * its keydown to the first task after the next animation frame (the frame
 * that shows it), and its Event Timing duration (0 below the 16 ms floor).
 */
async function firstKeyAfterOpen(page: Page, editor: Locator, note: PerfNote) {
  await caretAtReadyText(page, editor, note);
  await throttleCpu(page);
  await resetMetrics(page);
  await page.evaluate(() => {
    const probe = window as unknown as { __firstKeyMs?: number };
    probe.__firstKeyMs = undefined;
    document.addEventListener(
      'keydown',
      (event) => {
        const start = event.timeStamp;
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            probe.__firstKeyMs = performance.now() - start;
          };
          channel.port2.postMessage(null);
        });
      },
      { capture: true, once: true }
    );
  });
  await page.keyboard.type('x');
  const toNextFrameMs = await (
    await page.waitForFunction(
      () => (window as unknown as { __firstKeyMs?: number }).__firstKeyMs,
      undefined,
      { timeout: 60_000 }
    )
  ).jsonValue();
  await page.waitForTimeout(500);
  const { inpApproxMs, loafTotalBlockingMs } = typingStats(
    await collectMetrics(page),
    1
  );
  await throttleCpu(page, 1);
  return {
    eventMs: inpApproxMs,
    loafTotalBlockingMs,
    toNextFrameMs: Math.round(toNextFrameMs as number),
  };
}

/* Each choice gets its own context. Opening a near-limit document leaves
 * the renderer with enough retained memory that a second open in the same
 * context measures the garbage collector as much as the editor. */
async function measureOpen(
  browser: Browser,
  note: PerfNote,
  choice: OpenChoice
) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await installPerfInstrumentation(page);
    if (note === PERF_COMMON_NOTE) await seedCommonNote(page);
    // Absorb app boot and shared-chunk compilation on a throwaway
    // navigation so the measured open does not pay for it.
    await openNote(page, PERF_SMALL_NOTE);
    const opened = await openNote(page, note, { choice });
    const stats = {
      ...blockingStats(await collectMetrics(page)),
      openMs: opened.openMs,
    };
    const weight = await documentWeight(page, note.id);
    if (!(COMPARE && choice === 'interactive')) return { stats, weight };
    return {
      stats: {
        ...stats,
        firstKey: await firstKeyAfterOpen(page, opened.editor, note),
        heapAfterOpen: await heapAfterOpen(page),
      },
      weight,
    };
  } finally {
    await context.close();
  }
}

/** Typing at the end of a near-limit note's title, then the save cycle. */
async function typingNearLimit(page: Page, note: PerfNote) {
  await installPerfInstrumentation(page);
  if (note === PERF_COMMON_NOTE) await seedCommonNote(page);
  // Warm the editor's input path on the small fixture. Warming on the
  // near-limit fixture would schedule a large checkpoint whose acknowledgement
  // can overlap the measured typing window under heavy CPU throttling.
  const warm = await openNote(page, PERF_SMALL_NOTE);
  await caretAtReadyText(page, warm.editor, PERF_SMALL_NOTE);
  await throttleCpu(page);
  await warmUpTyping(page);
  await throttleCpu(page, 1);

  const { editor } = await openNote(page, note);

  await caretAtReadyText(page, editor, note);
  await throttleCpu(page);
  await resetMetrics(page);

  await page.keyboard.type(` ${TYPING_TEXT}`, { delay: KEY_DELAY_MS });
  await page.waitForTimeout(500);
  const typing = typingStats(
    await collectMetrics(page),
    TYPING_TEXT.length + 1
  );

  // The checkpoint fires 1s after the last keystroke; the acknowledgement
  // updates the footer stats and invalidates the projection. Measure that
  // whole tail separately. React runs it through the scheduler rather than an
  // input handler, so a regression shows up as one long
  // `performWorkUntilDeadline` frame rather than as slower keystrokes.
  //
  // CAVEAT: under MSW the mock collaboration provider does the service's job
  // — Yjs-to-Slate conversion, validation, byte accounting — synchronously on
  // the main thread. This number is therefore an upper bound that includes
  // work a real deployment does server-side. A BlockSuite room takes no
  // checkpoint under MSW, so its "save cycle" is the same 6 s after typing
  // with only the editor's own work in it.
  await resetMetrics(page);
  if (BLOCKS) await page.waitForTimeout(1000);
  else
    await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
      timeout: 120_000,
    });
  await page.waitForTimeout(5000);
  const saveCycle = {
    ...blockingStats(await collectMetrics(page)),
    ...(BLOCKS && { checkpoint: 'none under MSW' }),
  };
  // Checked after the save cycle, which starts 1 s after the last key.
  if (COMPARE)
    await expect(
      editor.getByText(`${note.readyText} ${TYPING_TEXT}`).first(),
      'every key landed'
    ).toBeVisible();
  return {
    document: await documentWeight(page, note.id),
    saveCycle,
    typing,
  };
}

/** ~4s of continuous wheel scrolling down, then back up. */
async function scrollNearLimit(page: Page, note: PerfNote) {
  await installPerfInstrumentation(page);
  if (note === PERF_COMMON_NOTE) await seedCommonNote(page);
  const { editor } = await openNote(page, note);

  await throttleCpu(page);
  const box = await editor.boundingBox();
  if (!box) throw new Error('editor has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);

  await startFrameSampler(page);
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(100);
  }
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(100);
  }
  await stopFrameSampler(page);

  const frames = frameStats((await collectMetrics(page)).frames);
  expect(frames.sampledFrames, 'frame sampler produced data').toBeGreaterThan(
    50
  );
  return {
    document: await documentWeight(page, note.id),
    ...frames,
  };
}

const BURST_KEYS = Number(process.env.PERF_BURST_KEYS ?? 2000);
/** The burst's time box: Plate never applied all 2,000 keys within the
 * test's 10 minutes on GHA, so the case reports how far an editor got
 * (`keysApplied`, `keysPerSecond`) instead of failing. */
const BURST_MS = Number(process.env.PERF_BURST_MS ?? 180_000);
/** How long the editor may take to show the last applied key. */
const BURST_SETTLE_MS = 120_000;
const BURST_TEXT = 'peer burst words ';

/**
 * A peer's burst of up to `BURST_KEYS` keystrokes at the end of the note's
 * title, at CPU x`CPU_RATE`, for at most `BURST_MS`: one Yjs transaction per
 * key on the mock room's own client (`window.__capyMockRooms`, as
 * runtime.office.ts's co-editor case), each delivered in its own task as fast
 * as the main thread takes them. The room applies each to the editor's
 * document synchronously, so `apply*` is the editor's synchronous handling of
 * one remote update (its Yjs observers and model updates); rendering follows
 * in later tasks. `settledMs` runs to the first frame whose title text shows
 * the last applied key (null if it did not within `BURST_SETTLE_MS`).
 */
async function peerBurst(page: Page, note: PerfNote) {
  await installPerfInstrumentation(page);
  if (note === PERF_COMMON_NOTE) await seedCommonNote(page);
  const { editor } = await openNote(page, note);
  await throttleCpu(page);
  await resetMetrics(page);
  const burst = await editor.evaluate(
    async (root, { blocks, budgetMs, id, keys, readyText, settleMs, text }) => {
      interface YText {
        insert(index: number, text: string): void;
        length: number;
        toString(): string;
      }
      interface YDoc {
        getMap(name: string): Map<string, Map<string, unknown>> & {
          get(key: string): { get(key: string): unknown } | undefined;
        };
        share: Map<string, { toDelta(): { insert: unknown }[] }>;
        transact(fn: () => void, origin?: unknown): void;
      }
      const rooms = (
        window as unknown as {
          __capyMockRooms?: Map<
            string,
            { document: YDoc; target: { id: string; kind: string } }
          >;
        }
      ).__capyMockRooms;
      const room = [...(rooms?.values() ?? [])].find(
        (candidate) =>
          candidate.target.kind === 'material' && candidate.target.id === id
      );
      if (!room) throw new Error(`No mock room for ${id}`);
      const doc = room.document;
      // The note's first block, its title heading.
      let title: YText;
      if (blocks) {
        const map = doc.getMap('blocks');
        const first = (
          map.get('note')?.get('sys:children') as { get(i: number): string }
        ).get(0);
        title = map.get(first)?.get('prop:text') as YText;
      } else {
        title = doc.share.get('content')!.toDelta()[0].insert as YText;
      }
      if (!title) throw new Error('No title block in the room');

      const typed = text.repeat(Math.ceil(keys / text.length)).slice(0, keys);
      // The title's text node: one run, as nothing in it is formatted.
      const shows = (tail: string) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          if (node.textContent?.includes(readyText))
            return node.textContent.endsWith(tail);
        return false;
      };
      const nextTask = () =>
        new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve();
          channel.port2.postMessage(null);
        });

      const apply: number[] = [];
      const started = performance.now();
      for (const key of typed) {
        if (performance.now() - started > budgetMs) break;
        const at = performance.now();
        doc.transact(() => title.insert(title.length, key), 'perf-peer');
        apply.push(performance.now() - at);
        await nextTask();
      }
      const appliedMs = performance.now() - started;
      const tail = typed.slice(0, apply.length).slice(-24);
      const deadline = performance.now() + settleMs;
      let settledMs: number | null = null;
      while (performance.now() < deadline) {
        if (shows(tail)) {
          settledMs = performance.now() - started;
          break;
        }
        await new Promise(requestAnimationFrame);
      }
      return { apply, appliedMs, settledMs };
    },
    {
      blocks: BLOCKS,
      budgetMs: BURST_MS,
      id: note.id,
      keys: BURST_KEYS,
      readyText: note.readyText,
      settleMs: BURST_SETTLE_MS,
      text: BURST_TEXT,
    }
  );
  const metrics = blockingStats(await collectMetrics(page));
  await throttleCpu(page, 1);
  return {
    applyMaxMs: round1(Math.max(...burst.apply)),
    applyP50Ms: round1(percentile(burst.apply, 50)),
    applyP95Ms: round1(percentile(burst.apply, 95)),
    applyTotalMs: Math.round(burst.apply.reduce((sum, ms) => sum + ms, 0)),
    appliedMs: Math.round(burst.appliedMs),
    budgetMs: BURST_MS,
    document: await documentWeight(page, note.id),
    keys: BURST_KEYS,
    keysApplied: burst.apply.length,
    keysPerSecond: round1((burst.apply.length * 1000) / burst.appliedMs),
    settledMs:
      burst.settledMs === null ? null : Math.round(burst.settledMs),
    ...metrics,
  };
}

test.describe('editor performance', () => {
  test('open cost — near-limit document', async ({ browser }, testInfo) => {
    // Read-only is the same static renderer in both layouts: Plate's only.
    const readOnly = BLOCKS
      ? null
      : await measureOpen(browser, PERF_LARGE_NOTE, 'readOnly');
    const interactive = await measureOpen(
      browser,
      PERF_LARGE_NOTE,
      'interactive'
    );

    await reportMetrics(testInfo, caseName('open-large-document'), {
      document: interactive.weight,
      interactive: interactive.stats,
      readOnly: readOnly?.stats ?? null,
    });

    // BlockSuite's cases report only (D8: no speed gate).
    if (!readOnly) return;
    expect(
      interactive.stats.openMs,
      'time to an editable, synced near-limit document'
    ).toBeLessThan(BUDGET.large.interactiveOpenMs);
    expect(
      readOnly.stats.openMs,
      'time to a read-only near-limit document'
    ).toBeLessThan(BUDGET.large.readOnlyOpenMs);
    // The interstitial only earns its place while the read-only path is the
    // cheaper way in.
    expect(
      readOnly.stats.openMs,
      'read-only must stay cheaper than the interactive path'
    ).toBeLessThan(interactive.stats.openMs);
  });

  test(`typing latency — small document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await installPerfInstrumentation(page);
    const { editor } = await openNote(page, PERF_SMALL_NOTE);

    await caretAtReadyText(page, editor, PERF_SMALL_NOTE);
    await throttleCpu(page);
    await warmUpTyping(page);

    await page.keyboard.type(` ${TYPING_TEXT}`, { delay: KEY_DELAY_MS });
    await page.waitForTimeout(500);

    const stats = typingStats(
      await collectMetrics(page),
      TYPING_TEXT.length + 1
    );
    await reportMetrics(testInfo, caseName('typing-small-document'), stats);

    warnOnWorstKey(
      testInfo,
      'small document',
      stats.inpApproxMs,
      WORST_KEY_WARNING_MS.small
    );
    if (BLOCKS) return;
    expect(stats.p95SlowKeyEventMs, 'p95 keystroke while typing').toBeLessThan(
      BUDGET.small.typingP95KeyEventMs
    );
    expect(
      stats.blockingPerKeystrokeMs,
      'main-thread blocking per keystroke'
    ).toBeLessThan(BUDGET.small.typingBlockingPerKeystrokeMs);
  });

  test(`typing latency and save cycle — near-limit document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    const result = await typingNearLimit(page, PERF_LARGE_NOTE);
    await reportMetrics(testInfo, caseName('typing-large-document'), result);

    warnOnWorstKey(
      testInfo,
      'near-limit document',
      result.typing.inpApproxMs,
      WORST_KEY_WARNING_MS.large
    );
    if (BLOCKS) return;
    expect(
      result.typing.p95SlowKeyEventMs,
      'p95 keystroke while typing'
    ).toBeLessThan(BUDGET.large.typingP95KeyEventMs);
    expect(
      result.typing.blockingPerKeystrokeMs,
      'main-thread blocking per keystroke'
    ).toBeLessThan(BUDGET.large.typingBlockingPerKeystrokeMs);
    expect(
      result.saveCycle.loafTotalBlockingMs,
      'main-thread blocking during the save cycle'
    ).toBeLessThan(BUDGET.large.saveCycleBlockingMs);
  });

  test(`scroll frame rate — near-limit document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    const frames = await scrollNearLimit(page, PERF_LARGE_NOTE);
    await reportMetrics(testInfo, caseName('scroll-large-document'), frames);

    if (BLOCKS) return;
    expect(frames.avgFps, 'average FPS while scrolling').toBeGreaterThan(
      BUDGET.scroll.avgFps
    );
    expect(frames.longestFrameMs, 'worst frame while scrolling').toBeLessThan(
      BUDGET.scroll.longestFrameMs
    );
  });
});

/**
 * Plate against BlockSuite on the common-subset note (blocks both render for
 * real, at the load-test note's size), plus a peer burst. Report-only, for
 * D8's "no worse than Plate" (todo-blocksuite-spike.md, "6. Measure").
 */
test.describe('editor comparison', () => {
  test.skip(!COMPARE, 'set PERF_EDITOR=plate or blocks');

  test('open cost — common-subset document', async ({ browser }, testInfo) => {
    const interactive = await measureOpen(
      browser,
      PERF_COMMON_NOTE,
      'interactive'
    );
    await reportMetrics(testInfo, caseName('open-common-document'), {
      document: interactive.weight,
      interactive: interactive.stats,
    });
  });

  test(`typing latency and save cycle — common-subset document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await reportMetrics(
      testInfo,
      caseName('typing-common-document'),
      await typingNearLimit(page, PERF_COMMON_NOTE)
    );
  });

  test(`scroll frame rate — common-subset document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await reportMetrics(
      testInfo,
      caseName('scroll-common-document'),
      await scrollNearLimit(page, PERF_COMMON_NOTE)
    );
  });

  test(`peer burst — common-subset document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await reportMetrics(
      testInfo,
      caseName('peer-burst-common-document'),
      await peerBurst(page, PERF_COMMON_NOTE)
    );
  });
});
