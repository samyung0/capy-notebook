import type { CDPSession, Page, TestInfo } from '@playwright/test';

/** CPU slowdown applied while measuring (not during page load). 4x roughly
 * approximates a mid-tier laptop; use PERF_CPU=6 or higher for low-end
 * mobile-class hardware. */
export const CPU_RATE = Number(process.env.PERF_CPU ?? 4);

export interface EventSample {
  duration: number;
  interactionId: number;
  name: string;
}

export interface LoafSample {
  blocking: number;
  duration: number;
  scripts: { name: string; duration: number; source: string }[];
}

export interface PerfState {
  events: EventSample[];
  frames: number[];
  loafs: LoafSample[];
}

/** Must run before navigation. Installs, on every document in the context:
 * - an Event Timing observer (keystroke/pointer processing durations; entries
 *   below 16ms are not reported, which is the spec minimum threshold);
 * - a Long Animation Frame observer with script attribution;
 * - a requestAnimationFrame-based frame-delta sampler for FPS measurement. */
export async function installPerfInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      events: [] as { name: string; duration: number; interactionId: number }[],
      frames: [] as number[],
      loafs: [] as {
        duration: number;
        blocking: number;
        scripts: { name: string; duration: number }[];
      }[],
      sampling: false,
    };

    (window as unknown as { __perf: unknown }).__perf = {
      reset() {
        state.events.length = 0;
        state.loafs.length = 0;
      },
      startFrames() {
        state.frames.length = 0;
        state.sampling = true;
        let last: number | null = null;
        const loop = (now: number) => {
          if (last !== null) state.frames.push(now - last);
          last = now;
          if (state.sampling) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      },
      state,
      stopFrames() {
        state.sampling = false;
      },
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEventTiming & { interactionId?: number };
        state.events.push({
          duration: e.duration,
          interactionId: e.interactionId ?? 0,
          name: e.name,
        });
      }
    }).observe({
      buffered: true,
      durationThreshold: 16,
      type: 'event',
    } as PerformanceObserverInit);

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as unknown as {
            duration: number;
            blockingDuration?: number;
            scripts?: {
              invoker?: string;
              sourceURL?: string;
              sourceFunctionName?: string;
              sourceCharPosition?: number;
              duration: number;
            }[];
          };
          state.loafs.push({
            blocking: e.blockingDuration ?? 0,
            duration: e.duration,
            scripts: (e.scripts ?? [])
              .map((s) => ({
                duration: s.duration,
                name: s.invoker || s.sourceURL || 'unknown',
                // `invoker` only names the listener kind ("MessagePort.onmessage"
                // covers React's scheduler, MSW, and Hocuspocus alike), so keep
                // the registering script too.
                source: `${s.sourceFunctionName || '?'} @ ${
                  s.sourceURL || '?'
                }:${s.sourceCharPosition ?? -1}`,
              }))
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 3),
          });
        }
      }).observe({
        buffered: true,
        type: 'long-animation-frame',
      } as PerformanceObserverInit);
    } catch {
      // Chromium < 123: LoAF unavailable; loaf metrics stay empty.
    }
  });
}

/** One CDP session per page. Chromium keeps the throttling rate of every
 * attached session and applies the slowest one, so a fresh session can raise
 * the rate but never lower it — `throttleCpu(page, 1)` on a second session
 * leaves the earlier slowdown in place. */
const cdpSessions = new WeakMap<Page, Promise<CDPSession>>();

function cdpSession(page: Page): Promise<CDPSession> {
  let session = cdpSessions.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    cdpSessions.set(page, session);
  }
  return session;
}

export async function throttleCpu(
  page: Page,
  rate: number = CPU_RATE
): Promise<void> {
  const session = await cdpSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

export async function resetMetrics(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __perf: { reset(): void } }).__perf.reset()
  );
}

export async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __perf: { startFrames(): void } }
    ).__perf.startFrames()
  );
}

export async function stopFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __perf: { stopFrames(): void } }
    ).__perf.stopFrames()
  );
}

export async function collectMetrics(page: Page): Promise<PerfState> {
  return page.evaluate(() => {
    const state = (window as unknown as { __perf: { state: PerfState } }).__perf
      .state;
    return JSON.parse(JSON.stringify(state)) as PerfState;
  });
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
}

/** Total main-thread blocking (time beyond 50ms inside long animation frames)
 * plus the script attribution for the worst offenders. */
export function blockingStats(state: PerfState) {
  return {
    loafCount: state.loafs.length,
    loafTotalBlockingMs: Math.round(
      state.loafs.reduce((sum, loaf) => sum + loaf.blocking, 0)
    ),
    worstLoafs: [...state.loafs]
      .sort((a, b) => b.blocking - a.blocking)
      .slice(0, 3),
  };
}

/**
 * Summarize keystroke responsiveness. `keystrokes` is the number of characters
 * typed. Only events slower than the observer's 16ms threshold are reported at
 * all, so `slowKeyEventRatio` saturates near 1 under CPU throttling and is kept
 * as context rather than as an assertion; per-keystroke blocking and the worst
 * interaction are the numbers that still move when the editor gets slower.
 */
export function typingStats(state: PerfState, keystrokes: number) {
  const keyEvents = state.events.filter(
    (e) => e.name === 'keydown' || e.name === 'keyup'
  );
  const durations = keyEvents.map((e) => e.duration);
  // INP-style: worst processing duration among distinct interactions.
  const byInteraction = new Map<number, number>();
  for (const e of state.events) {
    if (e.interactionId > 0) {
      byInteraction.set(
        e.interactionId,
        Math.max(byInteraction.get(e.interactionId) ?? 0, e.duration)
      );
    }
  }
  const interactionDurations = [...byInteraction.values()];
  const blocking = blockingStats(state);
  return {
    ...blocking,
    blockingPerKeystrokeMs:
      Math.round(
        (blocking.loafTotalBlockingMs / Math.max(1, keystrokes)) * 10
      ) / 10,
    inpApproxMs: interactionDurations.length
      ? Math.max(...interactionDurations)
      : 0,
    keystrokes,
    maxKeyEventMs: durations.length ? Math.max(...durations) : 0,
    p95SlowKeyEventMs: percentile(durations, 95),
    slowKeyEventRatio:
      Math.round((keyEvents.length / Math.max(1, keystrokes * 2)) * 1000) /
      1000,
    slowKeyEvents: keyEvents.length,
  };
}

export function frameStats(frames: number[]) {
  // Ignore the first frame after sampling starts; it absorbs setup cost.
  const deltas = frames.slice(1);
  if (deltas.length === 0) {
    return {
      avgFps: 0,
      droppedFrameRatio: 0,
      longestFrameMs: 0,
      sampledFrames: 0,
    };
  }
  const total = deltas.reduce((sum, d) => sum + d, 0);
  return {
    avgFps: Math.round((1000 / (total / deltas.length)) * 10) / 10,
    // Frames that took more than two vsync intervals (~33ms) — visible jank.
    droppedFrameRatio:
      Math.round((deltas.filter((d) => d > 34).length / deltas.length) * 1000) /
      1000,
    longestFrameMs: Math.round(Math.max(...deltas)),
    sampledFrames: deltas.length,
  };
}

export async function reportMetrics(
  testInfo: TestInfo,
  name: string,
  data: unknown
): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  console.log(`[perf] ${name} (cpu x${CPU_RATE}):\n${body}`);
  await testInfo.attach(name, { body, contentType: 'application/json' });
}
