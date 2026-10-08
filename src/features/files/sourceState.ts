import * as Y from 'yjs';

import type { SourceSession } from '@/api/types';

export function decodeSourceState(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (character) => character.charCodeAt(0));
}

/** A source's saved updates: its state, then the rows saved over it (delta
 * saves); none when nothing is saved (seed(base)). */
function savedSourceUpdates(
  session: Pick<SourceSession, 'state' | 'stateRows'>
): Uint8Array[] {
  return [
    ...(session.state ? [session.state] : []),
    ...(session.stateRows ?? []),
  ].map(decodeSourceState);
}

/**
 * A source's saved document as one update; null when nothing is saved. An
 * Office result is a change over seed(base), as the state alone was; a text
 * one is whole, since a text source's first row carries its seed. Only for a
 * consumer that takes one update (the Office view frame): a document applies
 * the updates in order instead (`applySavedSource`), without the merge.
 */
export function savedSourceUpdate(
  session: Pick<SourceSession, 'state' | 'stateRows'>
): Uint8Array | null {
  const updates = savedSourceUpdates(session);
  if (updates.length === 0) return null;
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

/** Applies a source's saved updates to `doc` in order, in one transaction;
 * whether anything was saved. */
export function applySavedSource(
  doc: Y.Doc,
  session: Pick<SourceSession, 'state' | 'stateRows'>,
  origin?: unknown
): boolean {
  const updates = savedSourceUpdates(session);
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, update, origin);
  }, origin);
  return updates.length > 0;
}
