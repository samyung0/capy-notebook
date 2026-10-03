import { expect, type Frame, type Page, test } from '@playwright/test';
import { PERF_WORKSPACE_ID } from '../../../src/mocks/perfSeed';
import { percentile, reportMetrics } from './metrics';

/**
 * DOCX in the Office runtime, on a production build (see
 * playwright.office.config.ts): open to first paint, View to Edit ready, and
 * keystroke to painted frame, for the 15-page CJK fixture and the 62-page
 * generated one. No budgets yet: they come from the first runs on the CI
 * runner, as the editor budgets did (openwiki/editor-perf.md).
 *
 * The runtime sends `ready` once its first pages are painted, with its own
 * timings (officeProtocol.ts, OfficeReadyTimings). The host measures from the
 * click to that message on its own clock; the typing loop reads the frame
 * directly, since Playwright can evaluate inside the cross-origin runtime.
 * Unthrottled: CDP's CPU throttle reaches neither the runtime frame's process
 * nor the engine workers, so a multiplier would skew main thread against
 * worker.
 */

const FIXTURES = [
  { id: 'bio-office-docx', name: 'exchange-plan.docx' },
  { id: 'bio-office-docx-long', name: 'long-handbook.docx' },
] as const;
const KEYS = 40;
const KEY_CADENCE_MS = 120;

interface ReadyMessage {
  at: number;
  pageCount: number;
  timings?: { loadMs: number; paintMs: number };
}

declare global {
  interface Window {
    __officeBench: { clicks: number[]; ready: ReadyMessage[] };
    __docxKeys: { keys: number[]; presents: number[] };
  }
}

// Host clock: the last click and every DOCX `ready` the runtime posts.
async function installHostProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { clicks: [] as number[], ready: [] as ReadyMessage[] };
    window.__officeBench = probe;
    window.addEventListener(
      'click',
      () => probe.clicks.push(performance.now()),
      true
    );
    window.addEventListener('message', (event) => {
      const data = event.data as {
        analysis?: { format?: string; pageCount?: number };
        timings?: ReadyMessage['timings'];
        type?: string;
      };
      if (data?.type !== 'ready' || data.analysis?.format !== 'docx') return;
      probe.ready.push({
        at: performance.now(),
        pageCount: data.analysis.pageCount ?? 0,
        timings: data.timings,
      });
    });
  });
}

/** Click, then wait for the next DOCX `ready`: ms on the host clock. */
async function clickUntilReady(page: Page, click: () => Promise<void>) {
  const before = await page.evaluate(() => window.__officeBench.ready.length);
  await click();
  await page.waitForFunction(
    (count) => window.__officeBench.ready.length > count,
    before,
    { polling: 50, timeout: 240_000 }
  );
  return page.evaluate(() => {
    const { clicks, ready } = window.__officeBench;
    const last = ready[ready.length - 1];
    return {
      ms: Math.round(last.at - clicks[clicks.length - 1]),
      pageCount: last.pageCount,
      runtime: last.timings,
    };
  });
}

function runtimeFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('office-runtime'));
  if (!frame) throw new Error('No Office runtime frame');
  return frame;
}

/** Keys at a fixed cadence; each key's delay to the next painted frame. */
async function typeAndTime(page: Page) {
  const frame = runtimeFrame(page);
  const canvas = frame.locator('canvas[data-page-index="0"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('First page is not laid out');
  // Body text near the top of the first page (both fixtures open with prose).
  await page.mouse.click(box.x + box.width / 2, box.y + 200);
  await page.waitForTimeout(1000);
  await frame.evaluate(() => {
    const probe = { keys: [] as number[], presents: [] as number[] };
    window.__docxKeys = probe;
    window.addEventListener(
      'keydown',
      () => probe.keys.push(performance.now()),
      true
    );
    document.addEventListener('docx-pages-presented', () =>
      probe.presents.push(performance.now())
    );
  });
  for (let index = 0; index < KEYS; index += 1) {
    await page.keyboard.press(index % 6 === 5 ? 'Space' : 'a');
    await page.waitForTimeout(KEY_CADENCE_MS);
  }
  // The last key's frame, or give up after 30 s (counted as unpainted).
  await frame
    .waitForFunction(
      () => {
        const { keys, presents } = window.__docxKeys;
        return presents.length > 0 && presents.at(-1)! > keys.at(-1)!;
      },
      undefined,
      { polling: 100, timeout: 30_000 }
    )
    .catch(() => undefined);
  const lags = await frame.evaluate(() => {
    const { keys, presents } = window.__docxKeys;
    return keys.map((key) => {
      const next = presents.find((at) => at > key);
      return next === undefined ? null : next - key;
    });
  });
  const painted = lags.filter((lag): lag is number => lag !== null);
  return {
    keys: lags.length,
    keyToFrameP50Ms: Math.round(percentile(painted, 50)),
    keyToFrameP90Ms: Math.round(percentile(painted, 90)),
    keyToFrameMaxMs: Math.round(Math.max(0, ...painted)),
    unpaintedKeys: lags.length - painted.length,
  };
}

for (const fixture of FIXTURES) {
  test(`docx ${fixture.name}: open, View to Edit, typing`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    await installHostProbe(page);
    const fallbacks: string[] = [];
    page.on('console', (message) => {
      if (/falling back to the main-thread engine/.test(message.text()))
        fallbacks.push(message.text());
    });

    await page.goto(`/workspaces/${PERF_WORKSPACE_ID}`);
    await page.getByRole('button', { exact: true, name: 'Files' }).click();
    const link = page.locator(
      `[data-workspace-file-tree] a[href$="file=${fixture.id}"]`
    );
    await expect(link).toBeVisible({ timeout: 60_000 });
    const open = await clickUntilReady(page, () => link.click());

    const mode = page.getByRole('button', { name: 'Material mode' });
    await expect(mode).toBeEnabled({ timeout: 60_000 });
    const edit = await clickUntilReady(page, () => mode.click());
    // Let the edit frame's idle work (mirror, glyph cache) settle first.
    await page.waitForTimeout(5000);
    const typing = await typeAndTime(page);

    await reportMetrics(testInfo, `office-docx-${fixture.id}`, {
      edit: { readyMs: edit.ms, runtime: edit.runtime },
      fixture: fixture.name,
      open: { firstPaintMs: open.ms, runtime: open.runtime },
      pages: open.pageCount,
      typing: { ...typing, cadenceMs: KEY_CADENCE_MS },
      workerFallbacks: fallbacks.length,
    }, 'unthrottled');
    expect(typing.unpaintedKeys).toBe(0);
    expect(fallbacks).toEqual([]);
  });
}
