import * as Y from 'yjs';

import type { SourceSession } from '@/api/types';

export function decodeSourceState(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (character) => character.charCodeAt(0));
}

/**
 * A source's saved document as one update: its state, then the rows saved
 * over it (delta saves); null when nothing is saved (seed(base)). An Office
 * result is a change over seed(base), as the state alone was; a text one is
 * whole, since a text source's first row carries its seed.
 */
export function savedSourceUpdate(
  session: Pick<SourceSession, 'state' | 'stateRows'>
): Uint8Array | null {
  const updates = [
    ...(session.state ? [session.state] : []),
    ...(session.stateRows ?? []),
  ].map(decodeSourceState);
  if (updates.length === 0) return null;
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}
