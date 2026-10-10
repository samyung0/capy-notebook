import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { getMaterialCollaborationToken } from '@/api/hooks';
import { RoomProvider, type RoomProviderConfig } from './roomProvider';
import { LOCAL_EDIT } from './yText';

/* A live item's room (a flashcard set; live-items DESIGN.md): its own Y.Doc
 * joined on the tab's shared collaboration socket, with a token per room.
 * Writers edit the document directly (fields bind to its texts); readers
 * hold a read channel and render what it holds (Epo, 2026-10-10). */

export type ItemRoomStatus =
  | 'connecting'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'unavailable';

export interface ItemRoomSnapshot {
  access: 'read' | 'write' | null;
  status: ItemRoomStatus;
  /** The document holds the room's state (painted from it, editable). */
  synced: boolean;
}

/** What a room needs of its provider (the MSW stand-in implements it too). */
export type ItemProvider = Pick<
  RoomProvider,
  'connect' | 'destroy' | 'disconnect'
>;

let mockFactory: ((config: RoomProviderConfig) => ItemProvider) | null = null;

export function registerMockItemProvider(
  factory: (config: RoomProviderConfig) => ItemProvider
) {
  mockFactory = factory;
}

/** Under MSW the in-page room stands in for the collaboration server. */
function createItemProvider(config: RoomProviderConfig): ItemProvider {
  if (USE_MSW) {
    if (!mockFactory) throw new Error('Mock item provider is not registered');
    return mockFactory(config);
  }
  return new RoomProvider(config);
}

const RETRY_MS = 1500;

export class ItemRoom {
  readonly doc = new Y.Doc();
  readonly undo: Y.UndoManager;
  private provider: ItemProvider | null = null;
  private snapshot: ItemRoomSnapshot = {
    access: null,
    status: 'connecting',
    synced: false,
  };
  private unsynced = 0;
  private destroyed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly materialId: string;

  constructor(materialId: string) {
    this.materialId = materialId;
    // The document holds only this item: Undo covers this user's own edits
    // to it, never others' or the server's.
    this.undo = new Y.UndoManager(this.doc, {
      captureTimeout: 500,
      trackedOrigins: new Set([LOCAL_EDIT]),
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  private set(patch: Partial<ItemRoomSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (
      next.access === this.snapshot.access &&
      next.status === this.snapshot.status &&
      next.synced === this.snapshot.synced
    )
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private live() {
    return this.unsynced > 0 ? 'syncing' : 'synced';
  }

  async start() {
    let first: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
    try {
      first = await getMaterialCollaborationToken(this.materialId);
    } catch {
      if (!this.destroyed) this.set({ status: 'unavailable' });
      return;
    }
    if (this.destroyed) return;
    this.set({ access: first.access === 'write' ? 'write' : 'read' });
    let cached: string | null = first.token;
    this.provider = createItemProvider({
      document: this.doc,
      name: first.room,
      onAuthenticationFailed: ({ reason }) => {
        if (
          reason === 'collaboration-not-found' ||
          reason === 'collaboration-forbidden'
        ) {
          this.set({ status: 'unavailable' });
          this.provider?.disconnect();
          return;
        }
        // Read-only now (a frozen account, a full owner, a demotion) or a
        // refusal the client retries: join again with a fresh token.
        this.rejoin();
      },
      onClose: ({ code, reason }) => {
        if (code === 4403) {
          this.set({ status: 'unavailable' });
          return;
        }
        if (reason === 'socket closed') {
          this.set({ status: 'offline' });
          return;
        }
        this.rejoin();
      },
      onSynced: ({ state }) => {
        this.set(
          state
            ? { status: this.live(), synced: true }
            : {
                status:
                  this.snapshot.status === 'offline' ? 'offline' : 'connecting',
              }
        );
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsynced = number;
        if (this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: this.live() });
      },
      token: async () => {
        if (cached) {
          const token = cached;
          cached = null;
          return token;
        }
        const fresh = await getMaterialCollaborationToken(this.materialId);
        this.set({ access: fresh.access === 'write' ? 'write' : 'read' });
        return fresh.token;
      },
      url: first.url,
    });
    this.provider.connect();
  }

  private rejoin() {
    if (this.destroyed || this.retry) return;
    this.provider?.disconnect();
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!this.destroyed) this.provider?.connect();
    }, RETRY_MS);
  }

  /** Edits not yet acknowledged by the server. */
  get hasUnsyncedChanges() {
    return this.unsynced > 0;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retry);
    this.provider?.destroy();
    this.undo.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }
}

/**
 * The item's room while `enabled`: created on mount, joined once the token
 * arrives, left on unmount.
 */
export function useItemRoom(materialId: string | null, enabled = true) {
  const [room, setRoom] = useState<ItemRoom | null>(null);
  useEffect(() => {
    if (!(materialId && enabled)) return;
    const created = new ItemRoom(materialId);
    setRoom(created);
    void created.start();
    return () => {
      created.destroy();
      setRoom((current) => (current === created ? null : current));
    };
  }, [materialId, enabled]);
  const snapshot = useSyncExternalStore(
    room?.subscribe ?? noSubscribe,
    room?.getSnapshot ?? initialSnapshot
  );
  return { room, snapshot };
}

const noSubscribe = () => () => undefined;
const INITIAL: ItemRoomSnapshot = {
  access: null,
  status: 'connecting',
  synced: false,
};
const initialSnapshot = () => INITIAL;
