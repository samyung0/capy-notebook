import { INPUTS } from '@/features/collaboration/idle';

/** At most one report a minute: Capy's idle close waits 60 minutes. */
export const REPORT_EVERY_MS = 60_000;

/**
 * Reports input in the frame to Capy (`post`): its idle close watches only its
 * own page, which the frame's events never reach (review B1). The first input
 * after a quiet minute reports at once, so a closed connection reopens on it.
 * Returns the stop function.
 */
export function reportInput(post: () => void, target: EventTarget = window) {
  let last = Number.NEGATIVE_INFINITY;
  const input = () => {
    const now = Date.now();
    if (now - last < REPORT_EVERY_MS) return;
    last = now;
    post();
  };
  const options = { capture: true, passive: true };
  for (const type of INPUTS) target.addEventListener(type, input, options);
  target.addEventListener('focus', input);
  return () => {
    for (const type of INPUTS) target.removeEventListener(type, input, options);
    target.removeEventListener('focus', input);
  };
}
