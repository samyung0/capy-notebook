import * as Y from 'yjs';

import type { SourceSession } from '@/api/types';

export function decodeSourceState(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (character) => character.charCodeAt(0));
}

/**
 * A source's saved document as one update: its state, then the rows saved
 * over it (delta saves); null when nothing is saved (seed(base)). An Office
 * result is a change over seed(base), as the state alone was. A text state
 * that is still seed(base) with rows over it needs the base bytes: the seed is
 * rebuilt as the collaboration server writes it (client 0, one insert).
 */
export function savedSourceUpdate(
  session: Pick<SourceSession, 'format' | 'state' | 'stateRows'>,
  base?: Uint8Array
): Uint8Array | null {
  const rows = (session.stateRows ?? []).map(decodeSourceState);
  const updates: Uint8Array[] = [];
  if (session.state) updates.push(decodeSourceState(session.state));
  else if (rows.length === 0) return null;
  else if (session.format === 'text') {
    if (!base)
      throw new Error('A text source saved over its seed needs the base');
    updates.push(textSeed(base));
  }
  updates.push(...rows);
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

/** seed(base) of a text source, the collaboration server's lineage. */
export function textSeed(bytes: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.clientID = 0;
    doc
      .getText('source')
      .insert(
        0,
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      );
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** A source's bytes from its presigned URL. */
export async function fetchSourceBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
