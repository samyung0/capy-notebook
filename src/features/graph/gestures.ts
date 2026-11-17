/* The canvas plane's gestures for any graph canvas (Epo 2026-11-16, D4): the
 * wheel or two-finger scroll pans, pinch and Ctrl/⌘-wheel zoom about the
 * pointer, the middle button drags to pan. Moves are gathered and applied once
 * per animation frame; `settle` hears when a gesture ends. */
import type { Vec } from './model';

export type GestureHandlers = {
  pan: (dx: number, dy: number) => void;
  /** Above 1 zooms in, keeping the point under `at` there. */
  zoom: (factor: number, at: Vec) => void;
  /** The view stopped moving: a wheel went quiet, or the last pointer lifted. */
  settle: () => void;
};

/** A wheel goes quiet this long before the gesture counts as settled. */
const WHEEL_SETTLE = 150;

/** Pixels per wheel line, for mice that scroll by lines. */
const LINE = 16;

/** Listens on `target`; positions are in its own box's pixels, divided by
 * `scale()` where the box is drawn scaled. Returns the cleanup. */
export function attachGestures(
  target: HTMLElement,
  handlers: GestureHandlers,
  scale: () => number = () => 1
) {
  let dx = 0;
  let dy = 0;
  let factor = 1;
  let anchor: Vec = [0, 0];
  let frame = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let moved = false;
  const flush = () => {
    frame = 0;
    if (dx || dy) handlers.pan(dx, dy);
    if (factor !== 1) handlers.zoom(factor, anchor);
    dx = 0;
    dy = 0;
    factor = 1;
  };
  const schedule = () => {
    moved = true;
    frame ||= requestAnimationFrame(flush);
  };
  const local = (event: { clientX: number; clientY: number }): Vec => {
    const rect = target.getBoundingClientRect();
    const k = scale();
    return [(event.clientX - rect.left) / k, (event.clientY - rect.top) / k];
  };
  const settle = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    if (moved) handlers.settle();
    moved = false;
  };

  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? LINE : 1;
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      factor *= Math.exp(
        -event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002)
      );
      anchor = local(event);
    } else {
      dx -= event.deltaX * lines;
      dy -= event.deltaY * lines;
    }
    schedule();
    clearTimeout(quiet);
    quiet = setTimeout(settle, WHEEL_SETTLE);
  };

  const pointers = new Map<number, Vec>();
  let pinch = 0;
  let panning = false;
  // The middle button pans here rather than starting the browser's autoscroll.
  const mousedown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };
  const down = (event: PointerEvent) => {
    if (event.button > 1) return;
    target.setPointerCapture?.(event.pointerId);
    const at = local(event);
    pointers.set(event.pointerId, at);
    if (event.button === 1) {
      panning = true;
      return;
    }
    if (pointers.size === 2) {
      // A second finger turns a drag into a pinch.
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      panning = false;
    }
  };
  const move = (event: PointerEvent) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const at = local(event);
    pointers.set(event.pointerId, at);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) {
        factor *= distance / pinch;
        anchor = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
      dx += (at[0] - last[0]) / 2;
      dy += (at[1] - last[1]) / 2;
      pinch = distance;
      schedule();
      return;
    }
    if (panning) {
      dx += at[0] - last[0];
      dy += at[1] - last[1];
      schedule();
    }
  };
  const up = (event: PointerEvent) => {
    const at = pointers.get(event.pointerId);
    if (!at) return;
    pointers.delete(event.pointerId);
    pinch = 0;
    // A pinch's other finger stays down: it pans no further until pressed again.
    panning = false;
    if (!pointers.size) settle();
  };

  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('mousedown', mousedown);
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
  return () => {
    clearTimeout(quiet);
    cancelAnimationFrame(frame);
    target.removeEventListener('wheel', wheel);
    target.removeEventListener('mousedown', mousedown);
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
}
