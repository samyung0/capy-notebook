import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';

/** Scrolls to the note's `headingOrder`th top-level heading from a table of
 * contents button; server-rendered notes call it from plain script. */
export function scrollToTocHeading(button: Element, headingOrder: number) {
  const root = button.closest('[data-slate-editor]');
  if (!root) return;
  const heads = root.querySelectorAll<HTMLElement>(
    ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'
  );
  const heading = heads[headingOrder];
  if (heading) scrollIntoViewWithMotion(heading);
}
