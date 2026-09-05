import { describe, expect, it, vi } from 'vitest';
import {
  FailedStoreRetryRunner,
  type FailedStoreSnapshot,
} from './failedStoreRetry.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('failed-store retries', () => {
  it('skips an overlapping retry pass while the current pass is running', async () => {
    const queued = new Map<string, FailedStoreSnapshot>([
      ['material:mat_1:1', { checkpointIds: [], state: new Uint8Array([1]) }],
    ]);
    const release = deferred();
    const retry = vi.fn(async (_room, _snapshot, clearIfCurrent) => {
      await release.promise;
      clearIfCurrent();
    });
    const runner = new FailedStoreRetryRunner(queued, retry);

    const firstPass = runner.run();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    await expect(runner.run()).resolves.toBeUndefined();

    expect(retry).toHaveBeenCalledOnce();
    release.resolve();
    await firstPass;
    expect(queued.size).toBe(0);
  });

  it('retains a newer snapshot when an older retry completes', async () => {
    const room = 'material:mat_1:1';
    const older = {
      checkpointIds: ['checkpoint-1'],
      state: new Uint8Array([1]),
    };
    const newer = {
      checkpointIds: ['checkpoint-2'],
      state: new Uint8Array([2]),
    };
    const queued = new Map<string, FailedStoreSnapshot>([[room, older]]);
    const release = deferred();
    const retry = vi.fn(async (_room, snapshot, clearIfCurrent) => {
      if (snapshot === older) {
        await release.promise;
      }
      clearIfCurrent();
    });
    const runner = new FailedStoreRetryRunner(queued, retry);

    const firstPass = runner.run();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    queued.set(room, newer);
    release.resolve();
    await firstPass;

    expect(queued.get(room)).toBe(newer);
    await runner.run();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(queued.has(room)).toBe(false);
  });
});
