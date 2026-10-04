import { Document, Hocuspocus } from '@hocuspocus/server';
import { describe, expect, it, vi } from 'vitest';
import {
  drainIsDurable,
  evictMaterialRoomEpoch,
  flushRoomStores,
  parseRoomEvictionMode,
  RoomEvictionCoordinator,
  RoomEvictionState,
  shouldCloseUserConnections,
  shouldPreserveMaterialConnections,
  unloadRoom,
} from './eviction.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  'waits for the complete Hocuspocus store lifecycle, already running: %s',
  async (alreadyRunning) => {
    const before = deferred();
    const beforeEntered = deferred();
    const after = deferred();
    const afterEntered = deferred();
    const save = vi.fn(async () => undefined);
    const host = new Hocuspocus({
      async afterStoreDocument() {
        afterEntered.resolve();
        await after.promise;
      },
      debounce: 60_000,
      extensions: [
        {
          async onStoreDocument() {
            beforeEntered.resolve();
            await before.promise;
          },
          priority: 1000,
        },
      ],
      maxDebounce: 60_000,
      onStoreDocument: save,
      quiet: true,
    });
    const document = new Document('source:f_eviction:epoch:1');
    document.isLoading = false;
    host.documents.set(document.name, document);
    let flushed = false;
    let draining: Promise<void> | undefined;
    try {
      await host.storeDocumentHooks(document, {
        clientsCount: 0,
        document,
        documentName: document.name,
        instance: host,
        lastContext: {},
        lastTransactionOrigin: undefined,
      });
      if (alreadyRunning)
        void host.debouncer.executeNow(`onStoreDocument-${document.name}`);
      draining = flushRoomStores(
        host,
        document.name,
        async () => undefined,
        2000
      ).then(() => {
        flushed = true;
      });
      await beforeEntered.promise;
      expect(flushed).toBe(false);
      expect(save).not.toHaveBeenCalled();
      before.resolve();
      await afterEntered.promise;
      expect(flushed).toBe(false);
      expect(save).toHaveBeenCalledOnce();
      after.resolve();
      await draining;
      await host.unloadDocument(document);
      expect(host.documents.has(document.name)).toBe(false);
    } finally {
      before.resolve();
      after.resolve();
      await draining;
      document.destroy();
    }
  }
);

describe('local room eviction coordination', () => {
  it('runs concurrent duplicate room evictions once', async () => {
    const coordinator = new RoomEvictionCoordinator(60_000);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const first = coordinator.run('room', 'operation', async () => {
      runs += 1;
      await blocked;
    });
    const duplicate = coordinator.run('room', 'operation', async () => {
      runs += 1;
    });

    release();
    await Promise.all([first, duplicate]);
    expect(runs).toBe(1);
  });

  it('does not notify a reloaded room for an already delivered operation', async () => {
    const coordinator = new RoomEvictionCoordinator(60_000);
    let roomGeneration = 1;
    const notifiedGenerations: number[] = [];
    const action = async () => {
      notifiedGenerations.push(roomGeneration);
    };

    await coordinator.run('room', 'first', action);
    roomGeneration = 2;
    await coordinator.run('room', 'first', action);
    await coordinator.run('room', 'second', action);

    expect(notifiedGenerations).toEqual([1, 2]);
  });

  it('does not cache a failed eviction', async () => {
    const coordinator = new RoomEvictionCoordinator(60_000);
    let runs = 0;
    await expect(
      coordinator.run('room', 'operation', async () => {
        runs += 1;
        throw new Error('unload failed');
      })
    ).rejects.toThrow('unload failed');

    await coordinator.run('room', 'operation', async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });

  it('serializes distinct events for the same room', async () => {
    const coordinator = new RoomEvictionCoordinator(60_000);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs: string[] = [];
    const drain = coordinator.run('room', 'compaction', async () => {
      runs.push('drain');
      await blocked;
    });
    const discard = coordinator.run('room', 'acl', async () => {
      runs.push('discard');
    });

    release();
    await Promise.all([drain, discard]);
    expect(runs).toEqual(['drain', 'discard']);
  });
});

describe('room eviction state', () => {
  it('fails closed when an outbox event has an invalid mode', () => {
    expect(parseRoomEvictionMode('drain')).toBe('drain');
    expect(parseRoomEvictionMode('discard')).toBe('discard');
    expect(parseRoomEvictionMode('widen')).toBe('discard');
    expect(parseRoomEvictionMode(undefined)).toBe('discard');
    expect(shouldCloseUserConnections('drain')).toBe(false);
    expect(shouldCloseUserConnections('discard')).toBe(true);
    expect(shouldCloseUserConnections('invalid')).toBe(true);
    expect(
      shouldPreserveMaterialConnections('account-access-restored', 'drain')
    ).toBe(true);
    expect(shouldPreserveMaterialConnections('access-changed', 'drain')).toBe(
      false
    );
    expect(
      shouldPreserveMaterialConnections('account-access-restored', 'invalid')
    ).toBe(false);
  });

  it('lets an accepted store finish during compaction drain', () => {
    const state = new RoomEvictionState();
    state.begin('room', 'drain');

    expect(state.blocks('room')).toBe(true);
    expect(state.blocks('room', true)).toBe(false);
    expect(state.isDiscarding('room')).toBe(false);
  });

  it('blocks stores during a destructive reset', () => {
    const state = new RoomEvictionState();
    state.begin('room', 'discard');

    expect(state.blocks('room')).toBe(true);
    expect(state.blocks('room', true)).toBe(true);
    expect(state.isDiscarding('room')).toBe(true);
  });

  it('keeps a failed destructive unload blocked until a retry succeeds', () => {
    const state = new RoomEvictionState();
    state.reject('room');
    state.begin('room', 'discard');
    state.end('room', 'discard');

    expect(state.blocks('room')).toBe(true);
    expect(state.isRejected('room')).toBe(true);

    state.accept('room');
    expect(state.blocks('room')).toBe(false);
  });

  it('refuses compaction after any final-store failure', () => {
    expect(drainIsDurable(3, 4, false)).toBe(false);
    expect(drainIsDurable(3, 3, true)).toBe(false);
    expect(drainIsDurable(3, 3, false)).toBe(true);
  });
});

describe('material room epoch eviction', () => {
  it('follows every room epoch that becomes current during delivery', async () => {
    const currentRooms = [
      'material:mat_1:schema:2',
      'material:mat_1:schema:3',
      'material:mat_1:schema:3',
    ];
    const evicted: string[] = [];

    await evictMaterialRoomEpoch({
      currentRoom: async () => currentRooms.shift() ?? null,
      evict: async (room) => {
        evicted.push(room);
      },
      initialRoom: 'material:mat_1:schema:1',
      waitForTransition: async () => undefined,
    });

    expect(evicted).toEqual([
      'material:mat_1:schema:1',
      'material:mat_1:schema:2',
      'material:mat_1:schema:3',
    ]);
  });
});

describe('unloadRoom', () => {
  it('closes, flushes and unloads again until the room is gone', async () => {
    let attempts = 0;
    const calls: string[] = [];
    await unloadRoom({
      close: () => calls.push('close'),
      deadline: Date.now() + 5000,
      flush: async () => calls.push('flush'),
      loaded: () => (attempts < 3 ? 'room' : undefined),
      pauseMs: 1,
      unload: async () => {
        attempts += 1;
      },
    });
    expect(attempts).toBe(3);
    expect(calls).toEqual(['close', 'flush', 'close', 'flush']);
  });

  it('throws once the deadline passes with the room still loaded', async () => {
    await expect(
      unloadRoom({
        close: () => {},
        deadline: Date.now() + 20,
        flush: async () => {},
        loaded: () => 'room',
        pauseMs: 5,
        unload: async () => {},
      })
    ).rejects.toThrow('collaboration document remained loaded after eviction');
  });
});
