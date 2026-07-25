import type { Page, TestInfo } from '@playwright/test';

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
  scripts: { name: string; duration: number }[];
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

export async function throttleCpu(
  page: Page,
  rate: number = CPU_RATE
): Promise<void> {
  const session = await page.context().newCDPSession(page);
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

/** Summarize keystroke responsiveness. `keystrokes` is the number of
 * characters typed; events faster than the 16ms reporting threshold are
 * counted as responsive by definition. */
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
  return {
    inpApproxMs: interactionDurations.length
      ? Math.max(...interactionDurations)
      : 0,
    keystrokes,
    loafCount: state.loafs.length,
    loafTotalBlockingMs: Math.round(
      state.loafs.reduce((sum, l) => sum + l.blocking, 0)
    ),
    maxKeyEventMs: durations.length ? Math.max(...durations) : 0,
    p95SlowKeyEventMs: percentile(durations, 95),
    slowKeyEventRatio: keyEvents.length / Math.max(1, keystrokes * 2),
    slowKeyEvents: keyEvents.length,
    worstLoafs: [...state.loafs]
      .sort((a, b) => b.blocking - a.blocking)
      .slice(0, 3),
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
