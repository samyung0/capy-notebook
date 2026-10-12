/** How long a hidden tab keeps a reader's room joined (REVIEW5 N5). */
export const HIDDEN_LEAVE_MS = 5 * 60_000;

type Page = Pick<
  Document,
  'addEventListener' | 'removeEventListener' | 'visibilityState'
>;

/**
 * Keeps a reader's room joined while the tab can be seen: `join` runs now
 * (it returns its leave), a tab hidden for 5 minutes leaves, and the tab
 * joins again once it shows, so a forgotten reader tab does not keep the
 * room loaded on the server. Returns the stop.
 */
export function whileVisible(
  join: () => () => void,
  page: Page | undefined = typeof document === 'undefined'
    ? undefined
    : document
): () => void {
  let leave: (() => void) | null = join();
  if (!page) return () => leave?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    if (page.visibilityState === 'hidden')
      timer = setTimeout(() => {
        leave?.();
        leave = null;
      }, HIDDEN_LEAVE_MS);
    else leave ??= join();
  };
  page.addEventListener('visibilitychange', changed);
  if (page.visibilityState === 'hidden') changed();
  return () => {
    clearTimeout(timer);
    page.removeEventListener('visibilitychange', changed);
    leave?.();
    leave = null;
  };
}
