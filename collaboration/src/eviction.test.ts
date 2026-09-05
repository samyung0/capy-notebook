import { describe, expect, it } from 'vitest';
import {
  drainIsDurable,
  evictMaterialRoomEpoch,
  parseRoomEvictionMode,
  RoomEvictionCoordinator,
  RoomEvictionState,
  shouldCloseUserConnections,
  shouldPreserveMaterialConnections,
} from './eviction.js';

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
