// Content inserted above the view, kept from moving what the reader sees.
// Chrome anchors only away from scrollTop 0 and Safari before 27 not at
// all, so insertions go through holdPosition. iOS Safari cancels a
// fling, or drops the write, when script sets scrollTop during a touch scroll,
// its momentum or its bounce, so they also wait for scrollSettled.

const QUIET_MS = 150;
let touching = false;
let scrolledAt = 0;
if (typeof document !== 'undefined') {
  const options = { capture: true, passive: true };
  const touch = (event: TouchEvent) => {
    touching = event.touches.length > 0;
  };
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const)
    document.addEventListener(type, touch, options);
  // Scroll events do not bubble; a capturing listener sees every scroller's.
  document.addEventListener(
    'scroll',
    () => {
      scrolledAt = performance.now();
    },
    options
  );
}

/** Resolves once no finger is down and nothing has scrolled for 150 ms: a
 * fling's momentum and bounce, a wheel or a scripted scroll have ended. */
export async function scrollSettled() {
  for (;;) {
    const wait = touching
      ? QUIET_MS
      : scrolledAt + QUIET_MS - performance.now();
    if (wait <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Keeps `element` where it is on screen across the next DOM change: call it
 * just before the change and the returned function once the change is in the
 * DOM (a layout effect), which moves the scroll position by however far the
 * change shifted the element within the content. The scroller's own anchoring
 * is off in between so the browser cannot adjust as well.
 */
export function holdPosition(element: Element) {
  let scroller = element.parentElement;
  while (
    scroller &&
    !['auto', 'scroll', 'overlay'].includes(
      getComputedStyle(scroller).overflowY
    )
  )
    scroller = scroller.parentElement;
  // Offset within the scrolled content: scrolling while React renders the
  // change moves the screen position but not this, so it is kept.
  const offset = () =>
    element.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
  const top = offset();
  if (scroller) scroller.style.overflowAnchor = 'none';
  return () => {
    if (!scroller) return;
    if (element.isConnected) scroller.scrollTop += offset() - top;
    scroller.style.overflowAnchor = '';
  };
}
