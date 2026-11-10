import type { InfiniteData } from '@tanstack/react-query';

/** A cursor-paged list's rows in order, each id once: a row whose place
 * changed between two page fetches stays where it first came. */
export function pagedRows<T extends { id: string }>(
  data: InfiniteData<{ items: T[] }, unknown>
): T[] {
  const seen = new Set<string>();
  return data.pages
    .flatMap((page) => page.items)
    .filter(({ id }) => !seen.has(id) && !!seen.add(id));
}
