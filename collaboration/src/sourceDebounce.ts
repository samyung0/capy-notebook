import type { Hocuspocus } from '@hocuspocus/server';
import { SOURCE_ROOM_PATTERN } from './auth.js';

const STORE_PREFIX = 'onStoreDocument-';

/**
 * Hocuspocus debounces every room's store with one configured delay. Source
 * rooms (Office and text files) save on their own, longer delay; an immediate
 * store (delay 0, as eviction and shutdown request) stays immediate, and
 * material rooms keep the configured one.
 */
export function debounceSourceStores(
  host: Pick<Hocuspocus, 'debouncer'>,
  debounceMs: number,
  maxDebounceMs: number
) {
  const debounce = host.debouncer.debounce;
  host.debouncer.debounce = (id, func, delay, maxDelay) =>
    delay !== 0 &&
    id.startsWith(STORE_PREFIX) &&
    SOURCE_ROOM_PATTERN.test(id.slice(STORE_PREFIX.length))
      ? debounce(id, func, debounceMs, maxDebounceMs)
      : debounce(id, func, delay, maxDelay);
}

/** Whether the room's debounced store is still waiting to run. */
export function storeDebounced(
  host: Pick<Hocuspocus, 'debouncer'>,
  room: string
) {
  return host.debouncer.isDebounced(`${STORE_PREFIX}${room}`);
}

/**
 * Whether a source room's checkpoint request persists now: an explicit save
 * (flush) does, and an idle request does when no debounced store is waiting
 * to carry its receipt.
 */
export function persistsNow(
  host: Pick<Hocuspocus, 'debouncer'>,
  room: string,
  flush: boolean
) {
  return flush || !storeDebounced(host, room);
}
