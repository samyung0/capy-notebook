import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  buildLargePerfDocument,
  countPerfNodes,
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from '../../src/mocks/perfSeed';
import {
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
 * production. Values are calibrated to ~2x the numbers observed at harness
 * creation (Jul 2026); if one trips, profile with DevTools Performance under
 * the same throttle before touching it — the attached `worstLoafs` script
 * attribution usually names the offender.
 *
 * Observed at calibration (dev build, cpu x4, after typing warm-up):
 * - small doc: INP ~70ms, blocking ~0.1s over 94 keystrokes
 * - 8k-node doc: INP ~2s, blocking ~63s over 94 keystrokes (!) — per-keystroke
 *   cost scales with document size; see the perf notes in
 *   openwiki/frontend/plate-editor.md
 * - save cycle on 8k-node doc: ~1.3s blocking with lightweight PATCH ack
 * - scroll on 8k-node doc: ~26-34 FPS, 24-43% janky frames
 */
const BUDGET = {
  large: {
    // Full save cycle of a near-limit document: flush serialization walk plus
    // lightweight acknowledgement handling. This budget intentionally fails
    // if the API starts echoing/parsing the complete document again.
    flushBlockingMs: 3500,
    typingBlockingMs: 120_000,
    typingInpMs: 4000,
  },
  scroll: {
    avgFps: 15,
    droppedFrameRatio: 0.7,
  },
  small: {
    // Share of keydown/keyup events slower than the 16ms reporting threshold.
    slowKeyEventRatio: 0.85,
    // Total main-thread blocking beyond 50ms tasks during the typing burst.
    typingBlockingMs: 6000,
    // Worst single interaction (INP-style) while typing.
    typingInpMs: 900,
  },
};

/** First keystrokes after load pay one-off costs (lazy module evaluation,
 * JIT warm-up); exclude them so the measurement reflects steady-state.
 * The warm-up schedules an autosave (5s debounce); wait for its PATCH
 * round-trip and give the response handling (which re-parses the saved
 * document) time to finish, so neither lands inside the measured typing
 * window. The measured burst itself stays under the 5s debounce. */
async function warmUpTyping(page: Page): Promise<void> {
  await page.keyboard.type(' warm up words first', { delay: KEY_DELAY_MS });
  // 5s debounce + ~1s mock latency + several seconds of throttled response
  // handling. (A waitForResponse would be nicer, but Playwright does not
  // reliably observe requests fulfilled by MSW's service worker.)
  await page.waitForTimeout(12_000);
  await resetMetrics(page);
}

const LARGE_NOTE_NODE_COUNT = countPerfNodes(buildLargePerfDocument());

async function openNote(
  page: Page,
  materialId: string,
  readyText: string
): Promise<Locator> {
  await page.goto(
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(materialId)}`
  );
  // The near-limit fixture is heavy enough to earn the open-anyway
  // interstitial; the harness measures the interactive path behind it.
  const openAnyway = page.getByTestId('heavy-material-open');
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(openAnyway.or(editor).first()).toBeVisible({ timeout: 60_000 });
  if (await openAnyway.isVisible()) await openAnyway.click();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(editor.getByText(readyText).first()).toBeVisible({
    timeout: 60_000,
  });
  // Let initial render and decoration effects settle so they do not pollute
  // the measurement window.
  await page.waitForTimeout(1500);
  return editor;
}

test.describe('editor performance', () => {
  test(`typing latency — small document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await installPerfInstrumentation(page);
    const editor = await openNote(
      page,
      PERF_SMALL_NOTE.id,
      PERF_SMALL_NOTE.readyText
    );

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
    expect(stats.slowKeyEventRatio, 'share of slow key events').toBeLessThan(
      BUDGET.small.slowKeyEventRatio
    );
    expect(
      stats.loafTotalBlockingMs,
      'main-thread blocking during typing'
    ).toBeLessThan(BUDGET.small.typingBlockingMs);
  });

  test(`typing latency and save flush — near-limit document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await installPerfInstrumentation(page);
    // Warm the Plate/React input path on the small fixture. Warming on the
    // 8k-node fixture would schedule a large autosave whose response handling
    // can overlap the measured typing window under heavy CPU throttling.
    const warmEditor = await openNote(
      page,
      PERF_SMALL_NOTE.id,
      PERF_SMALL_NOTE.readyText
    );
    await warmEditor.getByText(PERF_SMALL_NOTE.readyText).click();
    await page.keyboard.press('End');
    await throttleCpu(page);
    await warmUpTyping(page);
    await throttleCpu(page, 1);

    const editor = await openNote(
      page,
      PERF_LARGE_NOTE.id,
      PERF_LARGE_NOTE.readyText
    );

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

    // The debounced autosave fires 5s after the last keystroke and performs
    // the full normalize/validate/serialize walk, then response handling
    // re-parses the saved document. Measure the whole cycle separately.
    await resetMetrics(page);
    await page.waitForTimeout(10_000);
    const flushState = await collectMetrics(page);
    const flush = {
      loafCount: flushState.loafs.length,
      loafTotalBlockingMs: Math.round(
        flushState.loafs.reduce((sum, loaf) => sum + loaf.blocking, 0)
      ),
      worstLoafs: [...flushState.loafs]
        .sort((a, b) => b.blocking - a.blocking)
        .slice(0, 3),
    };

    await reportMetrics(testInfo, 'typing-large-document', {
      flush,
      nodeCount: LARGE_NOTE_NODE_COUNT,
      typing,
    });

    expect(typing.inpApproxMs, 'worst interaction while typing').toBeLessThan(
      BUDGET.large.typingInpMs
    );
    expect(
      typing.loafTotalBlockingMs,
      'main-thread blocking during typing'
    ).toBeLessThan(BUDGET.large.typingBlockingMs);
    expect(
      flush.loafTotalBlockingMs,
      'main-thread blocking during save flush'
    ).toBeLessThan(BUDGET.large.flushBlockingMs);
  });

  test(`scroll frame rate — near-limit document (cpu x${CPU_RATE})`, async ({
    page,
  }, testInfo) => {
    await installPerfInstrumentation(page);
    const editor = await openNote(
      page,
      PERF_LARGE_NOTE.id,
      PERF_LARGE_NOTE.readyText
    );

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
      nodeCount: LARGE_NOTE_NODE_COUNT,
      ...frames,
    });

    expect(frames.sampledFrames, 'frame sampler produced data').toBeGreaterThan(
      50
    );
    expect(frames.avgFps, 'average FPS while scrolling').toBeGreaterThan(
      BUDGET.scroll.avgFps
    );
    expect(
      frames.droppedFrameRatio,
      'share of janky frames (>34ms)'
    ).toBeLessThan(BUDGET.scroll.droppedFrameRatio);
  });
});
