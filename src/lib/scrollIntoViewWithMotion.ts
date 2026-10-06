const activeScrolls = new WeakMap<Element, () => void>();

/** Scrolls the element's nearest scrolling ancestor so the element sits
 * `offset` px below its top, eased with the motion tokens (the editor TOC and
 * the bank's question list). Each frame sets the position itself, re-aiming
 * at the element, so content loading above it cannot cancel or misplace the
 * scroll the way it does a native smooth scroll. */
export function scrollIntoViewWithMotion(element: HTMLElement, offset = 36) {
  let ancestor = element.parentElement;
  while (ancestor) {
    const { overflowY } = getComputedStyle(ancestor);
    if (
      ['auto', 'scroll', 'overlay'].includes(overflowY) &&
      ancestor.scrollHeight > ancestor.clientHeight
    )
      break;
    ancestor = ancestor.parentElement;
  }

  const scroller = ancestor ?? document.scrollingElement;
  if (!scroller) return;
  activeScrolls.get(scroller)?.();

  const start = scroller.scrollTop;
  const target = () => {
    const viewportTop =
      scroller === document.scrollingElement
        ? 0
        : scroller.getBoundingClientRect().top + scroller.clientTop;
    return Math.max(
      0,
      Math.min(
        scroller.scrollTop +
          element.getBoundingClientRect().top -
          viewportTop -
          offset,
        scroller.scrollHeight - scroller.clientHeight
      )
    );
  };
  const top = target();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || top === start) {
    scroller.scrollTo({ behavior: 'instant', top });
    return;
  }

  const tokens = getComputedStyle(element);
  // An empty native animation evaluates the CSS easing without animating the
  // document's appearance. Motion duration tokens are expressed in milliseconds.
  const animation = scroller.animate([], {
    duration: Number.parseFloat(
      tokens.getPropertyValue('--motion-duration-fast')
    ),
    easing: tokens.getPropertyValue('--motion-ease-smooth-out').trim(),
    fill: 'both',
    id: 'toc-scroll',
  });
  const controller = new AbortController();
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    animation.cancel();
    controller.abort();
    activeScrolls.delete(scroller);
  };
  activeScrolls.set(scroller, stop);
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    document.addEventListener(type, stop, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
  }

  const tick = () => {
    if (!element.isConnected) {
      stop();
      return;
    }
    const progress = animation.effect!.getComputedTiming().progress;
    if (typeof progress === 'number') {
      scroller.scrollTo({
        behavior: 'instant',
        top: start + (target() - start) * progress,
      });
    }
    if (progress === 1) stop();
    else frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
