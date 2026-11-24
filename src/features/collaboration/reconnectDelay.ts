/** The first reconnect waits a random time up to this; each later one's
 * ceiling doubles (Epo 2026-11-24, "Add jitter": up to 1–2 s on the first
 * retry, growing with backoff). */
export const RECONNECT_BASE_MS = 1000;
/** The ceiling stops growing here. */
export const RECONNECT_MAX_MS = 30_000;

/**
 * How long reconnect number `attempt` (0 for the first) waits: a random time
 * up to its ceiling ("full jitter"), so the clients that a deploy, an
 * eviction or a dropped network cut off together come back spread out, not
 * in one join storm. The tab's socket (`socket.ts`) and every room's rejoin
 * (`roomReconnector`: notes, items, Office and text files) wait by it.
 */
export function reconnectDelay(attempt: number): number {
  return (
    Math.random() * Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  );
}
