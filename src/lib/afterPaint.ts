/** Resolves once the browser has painted the page as it arrived, so the work
 * that follows (full stylesheets, hydration code, analytics) never starts
 * ahead of first paint. A hidden tab paints nothing, so it goes on at once. */
export function afterPaint(): Promise<void> {
  if (document.visibilityState === 'hidden') return Promise.resolve();
  // requestAnimationFrame runs just before a paint; a task queued there runs
  // after it.
  return new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve))
  );
}
