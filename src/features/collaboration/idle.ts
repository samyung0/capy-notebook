/**
 * The browser closes a page's collaboration connections after 60 minutes
 * without keyboard, pointer, touch or wheel input, and opens them again on
 * the next input or focus (Epo 2026-10-20); the server keeps no idle timer of
 * its own. A hidden page gets no input, so 60 minutes hidden closes them too.
 * Scroll events are not input: a page scrolls itself (a streaming chat).
 * Input inside an Office frame never reaches this page; the runtime reports
 * it (`frameInput`).
 */
export const IDLE_MS = 60 * 60 * 1000;

export const INPUTS = [
  'keydown',
  'pointerdown',
  'pointermove',
  'touchstart',
  'wheel',
] as const;

const FRAME_INPUT = 'capy-frame-input';

/** Input inside an Office frame, as its runtime reports it: counts as this
 * page's own. */
export function frameInput(target: EventTarget = window) {
  target.dispatchEvent(new Event(FRAME_INPUT));
}

/** Calls `sleep` once the page has been idle for `IDLE_MS`, and `wake` on
 * the input or focus after. Returns the stop function. */
export function watchIdle(
  { sleep, wake }: { sleep: () => void; wake: () => void },
  target: EventTarget = window
) {
  let last = Date.now();
  let asleep = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One timer, re-armed only when it fires: input just moves `last`, so a
  // moving pointer costs a number write.
  const check = () => {
    const idle = Date.now() - last;
    if (idle < IDLE_MS) {
      timer = setTimeout(check, IDLE_MS - idle);
      return;
    }
    asleep = true;
    timer = undefined;
    sleep();
  };
  const active = () => {
    last = Date.now();
    if (!asleep) return;
    asleep = false;
    timer = setTimeout(check, IDLE_MS);
    wake();
  };
  const options = { capture: true, passive: true };
  for (const type of INPUTS) target.addEventListener(type, active, options);
  target.addEventListener('focus', active);
  target.addEventListener(FRAME_INPUT, active);
  timer = setTimeout(check, IDLE_MS);
  return () => {
    clearTimeout(timer);
    for (const type of INPUTS)
      target.removeEventListener(type, active, options);
    target.removeEventListener('focus', active);
    target.removeEventListener(FRAME_INPUT, active);
  };
}
