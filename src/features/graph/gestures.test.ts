import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachGestures, type GestureHandlers } from './gestures';

/** A box at (10, 20) on the page, 200 × 100. */
class Box extends EventTarget {
  getBoundingClientRect() {
    return { height: 100, left: 10, top: 20, width: 200 };
  }
  setPointerCapture() {
    // Captured pointers keep arriving here; nothing to do in a test.
  }
}

let frames: FrameRequestCallback[] = [];
const nextFrame = () => {
  const run = frames;
  frames = [];
  for (const callback of run) callback(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  frames = [];
});

const send = (target: Box, type: string, fields: Record<string, unknown>) =>
  target.dispatchEvent(
    Object.assign(new Event(type, { cancelable: true }), {
      button: 0,
      buttons: 1,
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      metaKey: false,
      pointerId: 1,
      ...fields,
    })
  );

const setup = () => {
  const target = new Box();
  const handlers = {
    pan: vi.fn<GestureHandlers['pan']>(),
    settle: vi.fn<GestureHandlers['settle']>(),
    zoom: vi.fn<GestureHandlers['zoom']>(),
  };
  attachGestures(target as unknown as HTMLElement, handlers);
  return { handlers, target };
};

it('pans with the wheel once a frame, settling once it goes quiet', () => {
  const { handlers, target } = setup();
  send(target, 'wheel', { deltaX: 4, deltaY: 10 });
  send(target, 'wheel', { deltaY: 5 });
  expect(handlers.pan).not.toHaveBeenCalled();
  nextFrame();
  expect(handlers.pan).toHaveBeenCalledOnce();
  expect(handlers.pan).toHaveBeenCalledWith(-4, -15);
  expect(handlers.settle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(150);
  expect(handlers.settle).toHaveBeenCalledOnce();
});

it('zooms about the pointer with Ctrl or ⌘ and the wheel', () => {
  const { handlers, target } = setup();
  send(target, 'wheel', {
    clientX: 60,
    clientY: 70,
    ctrlKey: true,
    deltaY: -10,
  });
  send(target, 'wheel', {
    clientX: 60,
    clientY: 70,
    deltaY: -10,
    metaKey: true,
  });
  nextFrame();
  expect(handlers.pan).not.toHaveBeenCalled();
  const [factor, at] = handlers.zoom.mock.calls[0];
  expect(factor).toBeCloseTo(Math.exp(0.1) * Math.exp(0.02));
  expect(at).toEqual([50, 50]);
});

it('pinches to zoom about the fingers’ middle', () => {
  const { handlers, target } = setup();
  send(target, 'pointerdown', { clientX: 60, clientY: 70, pointerId: 1 });
  send(target, 'pointerdown', { clientX: 110, clientY: 70, pointerId: 2 });
  send(target, 'pointermove', { clientX: 160, clientY: 70, pointerId: 2 });
  nextFrame();
  const [factor, at] = handlers.zoom.mock.calls[0];
  expect(factor).toBeCloseTo(2);
  expect(at).toEqual([100, 50]);
  send(target, 'pointerup', { pointerId: 2 });
  send(target, 'pointerup', { pointerId: 1 });
  expect(handlers.settle).toHaveBeenCalledOnce();
});

it('pans with a middle-button drag', () => {
  const { handlers, target } = setup();
  send(target, 'pointerdown', { button: 1, clientX: 60, clientY: 70 });
  send(target, 'pointermove', { clientX: 70, clientY: 50 });
  send(target, 'pointermove', { clientX: 75, clientY: 50 });
  nextFrame();
  expect(handlers.pan).toHaveBeenCalledWith(15, -20);
  send(target, 'pointerup', {});
  expect(handlers.settle).toHaveBeenCalledOnce();
});
