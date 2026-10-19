/**
 * Bearer tokens that arrive in the address bar (a summary page's Open
 * `/open/{id}.{sig}`, an emailed `/workspace-invites/{token}`, a public page's
 * `?clone=<kind>:<token>`) leave it before anything records the page: the boot
 * module moves each into this tab's sessionStorage and replaces the address,
 * without a reload, with a placeholder (Sam 2026-10-19, review C1). The page
 * then reads the token from here (a refresh too) and drops it once used or
 * refused. Summary pages (`/w/{id}.{sig}`) are the Worker's and load no Sentry.
 */

export type StashKind = 'clone' | 'invite' | 'open';

/** The address-bar placeholder for a stashed token. */
export const STASHED = '-';

const KEY = 'capy:url-token:';
const PATHS: [StashKind, RegExp][] = [
  ['open', /^\/open\/([^/]+)\/?$/],
  ['invite', /^\/workspace-invites\/([^/]+)\/?$/],
];

interface Place {
  hash: string;
  pathname: string;
  search: string;
}

/** Moves the address bar's token into storage and returns the token-free
 * address, or null when it holds none. */
export function stashUrlTokens(
  place: Place,
  storage: Pick<Storage, 'setItem'>
): string | null {
  let pathname = place.pathname;
  let moved = false;
  for (const [kind, pattern] of PATHS) {
    const token = pathname.match(pattern)?.[1];
    if (token && token !== STASHED) {
      storage.setItem(KEY + kind, decodeURIComponent(token));
      pathname = pathname.replace(token, STASHED);
      moved = true;
    }
  }
  const search = new URLSearchParams(place.search);
  const clone = search.get('clone');
  if (clone && clone !== STASHED) {
    storage.setItem(KEY + 'clone', clone);
    search.set('clone', STASHED);
    moved = true;
  }
  if (!moved) return null;
  const query = search.toString();
  return pathname + (query ? `?${query}` : '') + place.hash;
}

/** The token a route was opened with: its own value, or the stashed one for
 * the placeholder ('' when that is gone). */
export function stashedToken(kind: StashKind, value: string): string {
  if (value !== STASHED) return value;
  try {
    return sessionStorage.getItem(KEY + kind) ?? '';
  } catch {
    return '';
  }
}

/** Drops a stashed token once it was used or refused. */
export function clearStashedToken(kind: StashKind): void {
  try {
    sessionStorage.removeItem(KEY + kind);
  } catch {
    // Storage unavailable: nothing was stashed.
  }
}
