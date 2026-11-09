/**
 * The browser closes a page's collaboration connections after 60 minutes
 * without keyboard, pointer, touch or wheel input, and opens them again on
 * the next input or focus (Epo 2026-10-20); the server keeps no idle timer of
 * its own. A hidden page gets no input, so 60 minutes hidden closes them too.
 * Scroll events are not input: a page scrolls itself (a streaming chat).
 * Input inside an Office frame never reaches this page; the runtime reports
 * it (`frameInput`).
 *
 * A hidden page sleeps sooner, at 5 minutes, once nothing it holds forbids it
 * (Epo 2026-11-04, `mayHide`: nothing unsent, no Office or text room), so a
 * forgotten editor's tab holds no room; it wakes when it shows.
 */
export const IDLE_MS = 60 * 60 * 1000;
export const HIDDEN_SLEEP_MS = 5 * 60 * 1000;
/** How often a hidden page holding unsent edits asks again. */
const HIDDEN_RECHECK_MS = 30 * 1000;

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

/** Calls `sleep` once the page has been idle for `IDLE_MS`, or hidden for
 * `HIDDEN_SLEEP_MS` while `mayHide` allows, and `wake` on the input, focus or
 * showing after. Returns the stop function. */
export function watchIdle(
  {
    mayHide = () => false,
    sleep,
    wake,
  }: { mayHide?: () => boolean; sleep: () => void; wake: () => void },
  target: EventTarget = window,
  page:
    | Pick<
        Document,
        'addEventListener' | 'removeEventListener' | 'visibilityState'
      >
    | undefined = typeof document === 'undefined' ? undefined : document
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
  let hiding: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    hiding = undefined;
    if (asleep) return;
    if (!mayHide()) {
      hiding = setTimeout(hide, HIDDEN_RECHECK_MS);
      return;
    }
    asleep = true;
    clearTimeout(timer);
    timer = undefined;
    sleep();
  };
  const visibility = () => {
    clearTimeout(hiding);
    hiding = undefined;
    if (page?.visibilityState === 'hidden')
      hiding = setTimeout(hide, HIDDEN_SLEEP_MS);
    else active();
  };
  const options = { capture: true, passive: true };
  for (const type of INPUTS) target.addEventListener(type, active, options);
  target.addEventListener('focus', active);
  target.addEventListener(FRAME_INPUT, active);
  page?.addEventListener('visibilitychange', visibility);
  if (page?.visibilityState === 'hidden') visibility();
  timer = setTimeout(check, IDLE_MS);
  return () => {
    clearTimeout(timer);
    clearTimeout(hiding);
    page?.removeEventListener('visibilitychange', visibility);
    for (const type of INPUTS)
      target.removeEventListener(type, active, options);
    target.removeEventListener('focus', active);
    target.removeEventListener(FRAME_INPUT, active);
  };
}
