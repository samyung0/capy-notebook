import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import {
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from '../../../src/mocks/perfSeed';
import {
  blockingStats,
  CPU_RATE,
  collectMetrics,
  frameStats,
  installPerfInstrumentation,
  reportMetrics,
  resetMetrics,
  startFrameSampler,
  stopFrameSampler,
  throttleCpu,
  typingStats,
} from './metrics';

// Plain words only — no autoformat/slash/markdown trigger characters, so the
// measurement reflects the steady-state typing path.
const TYPING_TEXT =
  'measuring editor latency with plain words that avoid every input rule trigger in the registry';
const KEY_DELAY_MS = 40;

/**
 * Budgets are regression tripwires, not UX targets. They assume the default
 * PERF_CPU=4 throttle. Since 2026-11-24 the harness measures a production
 * build with MSW in the page (Vite's production mode, minified, React
 * production mode; Epo, "Yes, move it" and "Yes, production mode"), and the
 * numbers below were recalibrated on it on 2026-11-24 (Epo, "approve for
 * now") by the steps below. If one trips, run `typingProfile.perf.ts`
 * under the same throttle before touching it — the attached `worstLoafs`
 * script attribution and that profile's watched frames usually name the
 * offender between them.
 *
 * Recalibrating on the production build (last done 2026-11-24, on 5b054df3a):
 * 1. The Windows Editor dispatches the Performance workflow three times on one
 *    commit, with only the editor suite (office, canvas, stress and
 *    share_pages unticked). The Mac never dispatches it.
 * 2. Each run's `perf-snapshot` artifact (`build: "production"`) holds its
 *    cases and its runner (`cpuModel`). Check the runs against each other
 *    first; a run far off the other two is left out and another dispatched.
 * 3. The opens (`large.interactiveOpenMs`, `large.readOnlyOpenMs`) are taken
 *    on the slowest CPU model in the runs (AMD EPYC 7763 so far), as
 *    bench:canvas's open was (Epo's "Yes, slower runner": opens differ 40-60%
 *    across the pool, and a budget from the faster runners fails on it):
 *    1.3x the median of that runner's runs once three exist, and 1.3x its one
 *    run until then (with two, the slower), from `open-large-document`'s
 *    `interactive.openMs` and `readOnly.openMs`. Later dispatches that draw
 *    it replace the figure with the median once there are three.
 * 4. The inputs are 1.3x the median of all three runs, whatever runner:
 *    `typing-large-document`'s `typing.p95SlowKeyEventMs`,
 *    `typing.blockingPerKeystrokeMs` and `saveCycle.loafTotalBlockingMs`, and
 *    `scroll-large-document`'s `longestFrameMs`; its `avgFps` budget is the
 *    median divided by 1.3 (higher is better). `typing-small-document`'s
 *    `p95SlowKeyEventMs` takes 1.5x (event durations come in 8 ms steps, so
 *    1.3x sits one step above the median), and its `blockingPerKeystrokeMs`
 *    keeps the 10 ms floor while 1.3x its median is under it.
 * 5. Round as bench:canvas's `budgetOf` does: up to 5 ms below a second and
 *    50 ms above; FPS down to a whole frame.
 * 6. Replace each number below with its budget and a comment naming its three
 *    runs (ids, runner, values) and median, as `MEDIANS` in board.canvas.ts
 *    does, and update openwiki/editor-perf.md.
 *
 * Observed at the dev build's recalibration against the ~2MB / 7.4k-node
 * load-test note (Aug 2026; unthrottled opens, cpu x4 elsewhere):
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
 */
const BUDGET = {
  // 1.3x the medians of three Performance runs of the production build on
  // 5b054df3a, 2026-11-24 (CPU x4), opens from the slower runner (steps above).
  // Run values are listed as 45330694331 / 45330707441 (AMD EPYC 7763) /
  // 45330721726 (AMD EPYC 9V45). They are the only perf gate and only a human
  // lowers them. See openwiki/editor-perf.md.
  large: {
    // BUDGET: both opens await recalibration on the fixed measure
    // (2026-11-24, bench/editor/reports/2026-11-24-editable-open-breakdown.md).
    // They were set on the old one, where read-only stopped ~0.1 s after its
    // click, on the note's title in the left panel (on screen behind the
    // gate), and interactive waited for the page's first contenteditable (a
    // MathLive field in the paint until its DOM left when idle) and then ran a
    // text scan of the 26k-element editable. Both now end once the frame first
    // showing the note's first block is rendered (`waitForNote`). On the Mac
    // at CI speed (2.2x) that put read-only 2.1 s later (2,450 to 4,599 ms)
    // and interactive 2.3 s sooner (8,867 to 6,587). New figures come from
    // three CI runs of the fixed bench by the steps above, and need Epo's
    // word; until then a read-only miss is the measure, not a regression.
    // Wall-clock from navigation to a synced, editable Plate instance. Measured
    // unthrottled. 1.3x the slower EPYC 7763 run: 8,491 / 9,119 / 7,399.
    interactiveOpenMs: 11_900,
    // 1.3x the slower EPYC 7763 run: 2,137 / 2,279 / 2,602.
    readOnlyOpenMs: 3000,
    // Debounce, Yjs commit, the acknowledgement's state updates, and the
    // projection invalidation. Nothing here may touch the document tree, so
    // this budget is the tripwire for a regression that reconnects the save
    // path to the editor's render. Median 115 (118 / 115 / 64).
    saveCycleBlockingMs: 150,
    typingBlockingPerKeystrokeMs: 5, // median 1.2 (1.2 / 1.5 / 0.3)
    typingP95KeyEventMs: 95, // median 72 (72 / 72 / 64)
  },
  scroll: {
    avgFps: 40, // median 52.7 (52.7 / 50.3 / 53.4), higher is better
    longestFrameMs: 130, // median 100 (83 / 100 / 117)
  },
  small: {
    // GHA measures 0ms (0 / 0 / 0); the floor exists so a local run has
    // something to hit.
    typingBlockingPerKeystrokeMs: 10,
    // Event durations come in 8ms steps, so 1.3x (45) would allow only one
    // step above the median; held at 1.5x (median 32: 32 / 32 / 32).
    typingP95KeyEventMs: 50,
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
  if (inpApproxMs < ceiling) return;
  const description = `${label}: worst keystroke ${inpApproxMs}ms (warning above ${ceiling}ms, not a failure)`;
  testInfo.annotations.push({ description, type: 'warning' });
  console.warn(`[perf] ${description}`);
}

type PerfNote = typeof PERF_LARGE_NOTE | typeof PERF_SMALL_NOTE;

/** The weight the app itself reports for a fixture, so a report never claims a
 * document shape the generator has since drifted away from. Read through the
 * page: the mocks live in a service worker, which `page.request` bypasses. */
async function documentWeight(page: Page, materialId: string) {
  return page.evaluate(
    async ([workspaceId, id]) => {
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
      };
    },
    [PERF_WORKSPACE_ID, materialId]
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

interface OpenResult {
  editor: Locator;
  openMs: number;
}

/** A note's block in either surface; the first is the note's first block. */
const BLOCK = '[data-slate-node="element"]';
/** The note's editable (Plate's). MathLive's fields are contenteditable too,
 * in the read-only document and in the paint the editor takes over from
 * (hidden, and its DOM removed when idle). */
const EDITABLE = '[data-slate-editor="true"][contenteditable="true"]';

/**
 * Until the note itself is on screen: the frame that first shows its first
 * block, in the read-only document (`material-preview`) or, once the room is
 * live, in the editable, has been rendered (style, layout and paint). Checked
 * every animation frame in the page (`raf` polling); a task posted from that
 * frame's callback runs once its rendering is done. So an open ends there:
 * not on a locator's next retry (up to 0.5 s later), not on the note's title
 * in the left panel (on screen behind the gate), and not after a text scan of
 * the whole editable (26k elements on the near-limit note, ~0.33 s a scan).
 */
async function waitForNote(page: Page, note: PerfNote, choice: OpenChoice) {
  await page.waitForFunction(
    ({ block, editable, readOnly, text }) => {
      let first: Element | null | undefined;
      if (readOnly) {
        first = document.querySelector(
          `[data-testid="material-preview"] ${block}`
        );
      } else {
        const state = document
          .querySelector('[data-testid="editor-save-state"]')
          ?.getAttribute('data-save-state');
        if (state === 'synced' || state === 'syncing' || state === 'saved')
          first = document.querySelector(editable)?.querySelector(block);
      }
      if (
        !(
          first?.textContent?.includes(text) &&
          first.checkVisibility({ visibilityProperty: true })
        )
      )
        return false;
      return new Promise<boolean>((done) => setTimeout(() => done(true), 0));
    },
    {
      block: BLOCK,
      editable: EDITABLE,
      readOnly: choice === 'readOnly',
      text: note.readyText,
    },
    { polling: 'raf', timeout: 120_000 }
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
  const gated = note === PERF_LARGE_NOTE;
  const startedAt = Date.now();
  await page.goto(
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(note.id)}&mode=${choice === 'readOnly' ? 'view' : 'edit'}`
  );

  const openAnyway = page.getByTestId('heavy-material-open');
  const openReadOnly = page.getByTestId('heavy-material-read-only');
  const editor = page.locator(EDITABLE).first();

  if (gated) {
    await expect(openAnyway, 'heavy-document interstitial').toBeVisible({
      timeout: 120_000,
    });
    await (choice === 'readOnly' ? openReadOnly : openAnyway).click();
  }

  await waitForNote(page, note, choice);
  const openMs = Date.now() - startedAt;

  // What the wait saw, as assertions with their own messages.
  if (choice === 'readOnly') {
    await expect(
      page.getByTestId('material-preview').locator(BLOCK).first()
    ).toContainText(note.readyText);
    // Any Plate editor, read-only ones too: slate-react's always carries
    // contenteditable, the static document (`data-slate-editor` as well)
    // never does.
    await expect(
      page.locator('[data-slate-editor="true"][contenteditable]'),
      'read-only never mounts an editor'
    ).toHaveCount(0);
  } else {
    await expectLive(page);
    await expect(editor).toBeVisible();
    await expect(editor.locator(BLOCK).first()).toContainText(note.readyText);
    if (!gated) {
      await expect(openAnyway, 'small note must not be gated').toHaveCount(0);
    }
  }

  // Let initial render and decoration effects settle so they do not pollute
  // the measurement window.
  await page.waitForTimeout(1500);
  return { editor, openMs };
}

/** First keystrokes after load pay one-off costs (lazy module evaluation, JIT
 * warm-up); exclude them so the measurement reflects steady-state. The warm-up
 * also schedules a checkpoint, whose acknowledgement invalidates the material
 * query and re-renders the editor — wait that cycle out so it does not land
 * inside the measured typing window. */
async function warmUpTyping(page: Page): Promise<void> {
  await page.keyboard.type(' warm up words first', { delay: KEY_DELAY_MS });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 120_000,
  });
  // The acknowledgement also triggers a projection refetch (~1s of mock
  // latency) whose response re-renders the editor.
  await page.waitForTimeout(4000);
  await resetMetrics(page);
}

test.describe('editor performance', () => {
  test('open cost — near-limit document', async ({ browser }, testInfo) => {
    /* Each choice gets its own context. Opening a near-limit document leaves
     * the renderer with enough retained memory that a second open in the same
     * context measures the garbage collector as much as the editor. */
    const measure = async (choice: OpenChoice) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await installPerfInstrumentation(page);
        // Absorb app boot and shared-chunk compilation on a throwaway
        // navigation so the measured open does not pay for it.
        await openNote(page, PERF_SMALL_NOTE);
        const opened = await openNote(page, PERF_LARGE_NOTE, { choice });
        return {
          stats: {
            ...blockingStats(await collectMetrics(page)),
            openMs: opened.openMs,
          },
          weight: await documentWeight(page, PERF_LARGE_NOTE.id),
        };
      } finally {
        await context.close();
      }
    };

    const readOnly = await measure('readOnly');
    const interactive = await measure('interactive');

    await reportMetrics(testInfo, 'open-large-document', {
      document: interactive.weight,
      interactive: interactive.stats,
      readOnly: readOnly.stats,
    });

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

    await editor.getByText(PERF_SMALL_NOTE.readyText).click();
    await page.keyboard.press('End');
    await throttleCpu(page);
    await warmUpTyping(page);

    await page.keyboard.type(` ${TYPING_TEXT}`, { delay: KEY_DELAY_MS });
    await page.waitForTimeout(500);

    const stats = typingStats(
      await collectMetrics(page),
      TYPING_TEXT.length + 1
    );
    await reportMetrics(testInfo, 'typing-small-document', stats);

    warnOnWorstKey(
      testInfo,
      'small document',
      stats.inpApproxMs,
      WORST_KEY_WARNING_MS.small
    );
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
    await installPerfInstrumentation(page);
    // Warm the Plate/React input path on the small fixture. Warming on the
    // near-limit fixture would schedule a large checkpoint whose acknowledgement
    // can overlap the measured typing window under heavy CPU throttling.
    const warm = await openNote(page, PERF_SMALL_NOTE);
    await warm.editor.getByText(PERF_SMALL_NOTE.readyText).click();
    await page.keyboard.press('End');
    await throttleCpu(page);
    await warmUpTyping(page);
    await throttleCpu(page, 1);

    const { editor } = await openNote(page, PERF_LARGE_NOTE);

    await editor.getByText(PERF_LARGE_NOTE.readyText).first().click();
    await page.keyboard.press('End');
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
    // work a real deployment does server-side.
    await resetMetrics(page);
    await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
      timeout: 120_000,
    });
    await page.waitForTimeout(5000);
    const saveCycle = blockingStats(await collectMetrics(page));

    await reportMetrics(testInfo, 'typing-large-document', {
      document: await documentWeight(page, PERF_LARGE_NOTE.id),
      saveCycle,
      typing,
    });

    warnOnWorstKey(
      testInfo,
      'near-limit document',
      typing.inpApproxMs,
      WORST_KEY_WARNING_MS.large
    );
    expect(
      typing.p95SlowKeyEventMs,
      'p95 keystroke while typing'
    ).toBeLessThan(BUDGET.large.typingP95KeyEventMs);
    expect(
      typing.blockingPerKeystrokeMs,
      'main-thread blocking per keystroke'
    ).toBeLessThan(BUDGET.large.typingBlockingPerKeystrokeMs);
    expect(
      saveCycle.loafTotalBlockingMs,
      'main-thread blocking during the save cycle'
    ).toBeLessThan(BUDGET.large.saveCycleBlockingMs);
  });

  test(`scroll frame rate — near-limit document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await installPerfInstrumentation(page);
    const { editor } = await openNote(page, PERF_LARGE_NOTE);

    await throttleCpu(page);
    const box = await editor.boundingBox();
    if (!box) throw new Error('editor has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + 100);

    await startFrameSampler(page);
    // ~4s of continuous wheel scrolling down, then back up.
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(100);
    }
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(100);
    }
    await stopFrameSampler(page);

    const state = await collectMetrics(page);
    const frames = frameStats(state.frames);
    await reportMetrics(testInfo, 'scroll-large-document', {
      document: await documentWeight(page, PERF_LARGE_NOTE.id),
      ...frames,
    });

    expect(frames.sampledFrames, 'frame sampler produced data').toBeGreaterThan(
      50
    );
    expect(frames.avgFps, 'average FPS while scrolling').toBeGreaterThan(
      BUDGET.scroll.avgFps
    );
    expect(frames.longestFrameMs, 'worst frame while scrolling').toBeLessThan(
      BUDGET.scroll.longestFrameMs
    );
  });
});
