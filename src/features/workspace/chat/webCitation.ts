import type { Citation } from '@/api/types';

/** A web citation's link: an http(s) address only, since the page that
 * supplied it is anyone's. */
export function webHref(url: string | undefined): string | undefined {
  if (!url) return;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : undefined;
  } catch {}
}

/** The site and date under a web citation's title. */
export function webMeta(citation: Citation): string {
  return [citation.siteName, citation.published].filter(Boolean).join(', ');
}

/** The element id of a message's sources-list entry, which a web citation's
 * raised number moves to. */
export function sourceEntryId(messageId: string, index: number): string {
  return `source-${messageId}-${index}`;
}
