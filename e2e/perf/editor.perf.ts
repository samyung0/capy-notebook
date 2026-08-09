import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from '../../src/mocks/perfSeed';
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
 * PERF_CPU=4 throttle and the Vite DEV build (unminified, React dev mode,
 * StrictMode double-render), which inflates absolute numbers well beyond
 * production. Values are ~2x the numbers observed at recalibration (Aug 2026,
 * after the editor moved to Yjs collaboration); if one trips, profile with
 * DevTools Performance under the same throttle before touching it — the
 * attached `worstLoafs` script attribution usually names the offender.
 *
 * Observed at recalibration against the ~2MB / 7.4k-node load-test note (dev
 * build, unthrottled opens, cpu x4 elsewhere):
 * - opening it: ~16s interactive (11s blocking), ~2s read-only (0.25s blocking)
 * - small doc typing: INP ~150ms, ~30ms blocking per keystroke
 * - near-limit typing: INP ~1.6s, ~900ms blocking per keystroke (!) —
 *   per-keystroke cost scales with document size
 * - save cycle: ~24s blocking, of which ~9s is the projection refetch and the
 *   rest is the editor re-rendering the whole document because the checkpoint
 *   acknowledgement updates the footer stats. Both are React render storms
 *   rather than serialization cost, so this budget is deliberately loose: it
 *   documents a known problem instead of pretending the number is healthy.
 * - scroll: ~7 FPS, ~95% janky frames
 */
const BUDGET = {
  large: {
    // Wall-clock from navigation to a synced, editable Plate instance. Measured
    // unthrottled: this path is already tens of seconds without any slowdown.
    interactiveOpenMs: 35_000,
    readOnlyOpenMs: 8000,
    // The checkpoint cycle: debounce, Yjs commit, the acknowledgement's state
    // updates, and the projection refetch that follows.
    saveCycleBlockingMs: 45_000,
    typingBlockingPerKeystrokeMs: 1800,
    typingInpMs: 3000,
  },
  scroll: {
    avgFps: 4,
    // Every frame of a document this size is already janky, so the dropped
    // ratio can no longer get meaningfully worse; the worst single frame still
    // can, and is what a regression shows up in.
    longestFrameMs: 4000,
  },
  small: {
    typingBlockingPerKeystrokeMs: 90,
    typingInpMs: 600,
  },
};

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

/** The editor reports `Synced` once Yjs has the document and `Saved` once the
 * service acknowledges a checkpoint; either means the editor is live. */
async function expectLive(page: Page): Promise<void> {
  await expect(saveState(page)).toHaveText(/Synced|Saved/, {
    timeout: 120_000,
  });
}

interface OpenResult {
  editor: Locator;
  openMs: number;
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
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(note.id)}`
  );

  const openAnyway = page.getByTestId('heavy-material-open');
  const openReadOnly = page.getByTestId('heavy-material-read-only');
  const editor = page.locator('[contenteditable="true"]').first();

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
      editor,
      'read-only never mounts an editable surface'
    ).toHaveCount(0);
  } else {
    await expect(editor).toBeVisible({ timeout: 120_000 });
    await expect(editor.getByText(note.readyText).first()).toBeVisible({
      timeout: 120_000,
    });
    await expectLive(page);
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

/** First keystrokes after load pay one-off costs (lazy module evaluation, JIT
 * warm-up); exclude them so the measurement reflects steady-state. The warm-up
 * also schedules a checkpoint, whose acknowledgement invalidates the material
 * query and re-renders the editor — wait that cycle out so it does not land
 * inside the measured typing window. */
async function warmUpTyping(page: Page): Promise<void> {
  await page.keyboard.type(' warm up words first', { delay: KEY_DELAY_MS });
  await expect(saveState(page)).toHaveText('Saved', { timeout: 120_000 });
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

    expect(stats.inpApproxMs, 'worst interaction while typing').toBeLessThan(
      BUDGET.small.typingInpMs
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
    // then invalidates the material query, and the projection response
    // re-renders the editor. Measure that whole tail separately.
    //
    // CAVEAT: under MSW the mock collaboration provider does the service's job
    // — Yjs-to-Slate conversion, validation, byte accounting — synchronously on
    // the main thread. This number is therefore an upper bound that includes
    // work a real deployment does server-side.
    await resetMetrics(page);
    await expect(saveState(page)).toHaveText('Saved', { timeout: 120_000 });
    await page.waitForTimeout(5000);
    const saveCycle = blockingStats(await collectMetrics(page));

    await reportMetrics(testInfo, 'typing-large-document', {
      document: await documentWeight(page, PERF_LARGE_NOTE.id),
      saveCycle,
      typing,
    });

    expect(typing.inpApproxMs, 'worst interaction while typing').toBeLessThan(
      BUDGET.large.typingInpMs
    );
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
