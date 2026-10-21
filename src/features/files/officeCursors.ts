import type { Awareness } from 'y-protocols/awareness';
import {
  type PresenceConnection,
  presenceNames,
} from '@/features/collaboration/presence';
import {
  isOfficeCursor,
  MAX_PEERS,
  type OfficeCursor,
  type OfficePeer,
} from './officeProtocol';

/**
 * The co-editors' cursors of an Office file (Epo 2026-10-20): each client id
 * the room's awareness gives a cursor, drawn only under the verified name the
 * room's presence gives that id. A name in a peer's awareness is never read,
 * and an id the presence does not list (a reader, or a peer not listed yet)
 * is not drawn.
 */
export function officePeers(
  states: ReadonlyMap<number, unknown>,
  self: number,
  names: ReadonlyMap<number, string>
): OfficePeer[] {
  const peers: OfficePeer[] = [];
  for (const [clientId, state] of states) {
    const name = names.get(clientId);
    const cursor = (state as { cursor?: unknown } | null)?.cursor;
    if (clientId === self || !name || !isOfficeCursor(cursor)) continue;
    peers.push({ clientId, cursor, name });
    if (peers.length === MAX_PEERS) break;
  }
  return peers;
}

/** A session's cursors: its room's awareness (`attach`) and presence
 * (`names`) in, the frame's cursor out (`set`), the peers to draw to
 * `subscribe`'s listeners. */
export function createOfficeCursors() {
  let awareness: Awareness | null = null;
  let names = new Map<number, string>();
  let peers: OfficePeer[] = [];
  const listeners = new Set<(peers: OfficePeer[]) => void>();
  const update = () => {
    peers = awareness
      ? officePeers(awareness.getStates(), awareness.clientID, names)
      : [];
    for (const listener of listeners) listener(peers);
  };
  return {
    attach(next: Awareness | null) {
      awareness?.off('change', update);
      awareness = next;
      awareness?.on('change', update);
      update();
    },
    names(connections: readonly PresenceConnection[] | null) {
      names = presenceNames(connections ?? []);
      update();
    },
    set(cursor: OfficeCursor | null) {
      awareness?.setLocalStateField('cursor', cursor);
    },
    subscribe(listener: (peers: OfficePeer[]) => void) {
      listeners.add(listener);
      listener(peers);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type OfficeCursors = ReturnType<typeof createOfficeCursors>;
