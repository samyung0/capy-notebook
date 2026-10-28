import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CITATION_SCROLL_MS, scrollToCenter } from './scrollToCenter';

// A 400 px tall scroller over a 2,000 px column, with one 20 px box in it.
// The tests run without a DOM, so the elements are plain stand-ins.
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let reduced = false;
const page = new EventTarget();
const scroller = Object.assign(new EventTarget(), {
  clientHeight: 400,
  clientWidth: 300,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  ownerDocument: page,
  scrollBy: ({ top = 0 }: ScrollToOptions) => {
    scroller.scrollTop += top;
  },
  scrollTop: 0,
});
const box = {
  boxTop: 1000,
  getBoundingClientRect: () => ({
    height: 20,
    left: 100,
    top: box.boxTop - scroller.scrollTop,
    width: 100,
  }),
  isConnected: true,
};
/** Where the scroller sits with the box centred. */
const centred = () => box.boxTop + 10 - 200;

beforeEach(() => {
  now = 0;
  frames = new Map();
  reduced = false;
  scroller.scrollTop = 0;
  box.boxTop = 1000;
  let id = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) =>
    frames.delete(frame)
  );
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Runs the frames 16 ms apart until none is pending. */
function runFrames(each?: (frame: number) => void) {
  for (let frame = 1; frames.size; frame++) {
    now += 16;
    each?.(frame);
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }
}

function start() {
  const onEnd = vi.fn();
  scrollToCenter(
    scroller as unknown as HTMLElement,
    box as unknown as Element,
    onEnd
  );
  return { onEnd };
}

it('eases out to the centre in its fixed time, landing exactly there', () => {
  const { onEnd } = start();
  const tops: number[] = [];
  runFrames(() => tops.push(scroller.scrollTop));
  expect(scroller.scrollTop).toBeCloseTo(centred(), 6);
  expect(onEnd).toHaveBeenCalledOnce();
  expect(now).toBeGreaterThanOrEqual(CITATION_SCROLL_MS);
  expect(now).toBeLessThan(CITATION_SCROLL_MS + 16);
  // Ease-out: each frame moves less than the one before.
  const steps = tops.slice(1).map((top, i) => top - tops[i]);
  expect(steps.every((step, i) => i === 0 || step <= steps[i - 1])).toBe(true);
});

it('aims at where the box is now when a page above it grows', () => {
  const { onEnd } = start();
  runFrames((frame) => {
    if (frame === 6) box.boxTop += 300;
  });
  expect(scroller.scrollTop).toBeCloseTo(centred(), 6);
  expect(onEnd).toHaveBeenCalledOnce();
});

it('jumps a long trip to one viewport short, then animates the rest', () => {
  box.boxTop = 5000;
  start();
  expect(scroller.scrollTop).toBeCloseTo(centred() - 400, 6);
  runFrames();
  expect(scroller.scrollTop).toBeCloseTo(centred(), 6);
});

it('stops without landing on wheel, a pointer or a scroll key', () => {
  for (const [target, event] of [
    [scroller, new Event('wheel')],
    [scroller, new Event('pointerdown')],
    [page, Object.assign(new Event('keydown'), { key: 'PageDown' })],
  ] as const) {
    scroller.scrollTop = 0;
    const { onEnd } = start();
    runFrames((frame) => {
      if (frame === 3) target.dispatchEvent(event);
    });
    expect(scroller.scrollTop).toBeLessThan(centred());
    expect(onEnd).not.toHaveBeenCalled();
  }
  // Keys that don't scroll leave it running.
  scroller.scrollTop = 0;
  const { onEnd } = start();
  runFrames((frame) => {
    if (frame === 3)
      page.dispatchEvent(Object.assign(new Event('keydown'), { key: 'c' }));
  });
  expect(onEnd).toHaveBeenCalledOnce();
});

it('lands at once under reduced motion', () => {
  reduced = true;
  const { onEnd } = start();
  expect(scroller.scrollTop).toBeCloseTo(centred(), 6);
  expect(onEnd).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});
