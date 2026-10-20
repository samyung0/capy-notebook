import type { OfficeCursor, OfficePeer } from '@/features/files/officeProtocol';

/** A co-editor's cursor to draw: when the frame last heard of it, and when
 * the cursor last moved (the editors' name flags show for a while after). */
export interface RemoteCursor extends OfficePeer {
  movedAt: number;
  seenAt: number;
}

/** At most one cursor message per this many ms, as the fork's providers. */
export const CURSOR_SEND_MS = 80;

const cursorKey = (cursor: OfficeCursor) => JSON.stringify(cursor);

/**
 * The frame's side of Office cursors (Epo 2026-10-20): the co-editors' cursors
 * Capy sends (`receive`, labelled there from the room's presence) and this
 * editor's own going out (`send`, at most one message per `CURSOR_SEND_MS`,
 * the last one always). Each format's editor reads it through its adapter.
 */
export function createCursorChannel(
  post: (cursor: OfficeCursor | null) => void
) {
  let peers: RemoteCursor[] = [];
  const listeners = new Set<() => void>();
  let pending: OfficeCursor | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    sentAt = Date.now();
    post(pending);
  };
  return {
    get peers(): readonly RemoteCursor[] {
      return peers;
    },
    receive(next: readonly OfficePeer[]) {
      const now = Date.now();
      const before = new Map(peers.map((peer) => [peer.clientId, peer]));
      peers = next.map((peer) => {
        const old = before.get(peer.clientId);
        const moved = !old || cursorKey(old.cursor) !== cursorKey(peer.cursor);
        return { ...peer, movedAt: moved ? now : old.movedAt, seenAt: now };
      });
      for (const listener of listeners) listener();
    },
    /** `broadcast` false (a DOCX edit moved it) keeps it for the next send. */
    send(cursor: OfficeCursor | null, broadcast = true) {
      pending = cursor;
      if (!broadcast || timer) return;
      const wait = CURSOR_SEND_MS - (Date.now() - sentAt);
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CursorChannel = ReturnType<typeof createCursorChannel>;

/** One adapter's peers, rebuilt only when the channel's change. */
export function mappedPeers<T>(
  channel: CursorChannel,
  map: (peer: RemoteCursor) => T | null
) {
  let source: readonly RemoteCursor[] | null = null;
  let mapped: T[] = [];
  return () => {
    if (source !== channel.peers) {
      source = channel.peers;
      mapped = source.flatMap((peer) => map(peer) ?? []);
    }
    return mapped;
  };
}
