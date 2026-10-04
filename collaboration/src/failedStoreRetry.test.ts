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
    let now = 0;
    const runner = new FailedStoreRetryRunner(queued, retry, () => now);

    const firstPass = runner.run();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    queued.set(room, newer);
    release.resolve();
    await firstPass;

    expect(queued.get(room)).toBe(newer);
    // A newer failure waits out the room's backoff.
    now = 5000;
    await runner.run();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(queued.has(room)).toBe(false);
  });

  it('backs a failing room off from 5 s to 60 s', async () => {
    const queued = new Map<string, FailedStoreSnapshot>([
      ['source:f:epoch:1', { checkpointIds: [], state: new Uint8Array([1]) }],
    ]);
    let now = 0;
    const attempts: number[] = [];
    const runner = new FailedStoreRetryRunner(
      queued,
      async () => {
        attempts.push(now);
      },
      () => now
    );
    // A pass every second for five minutes; the room keeps failing.
    for (; now <= 300_000; now += 1000) await runner.run();
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    expect(gaps.slice(0, 5)).toEqual([5000, 10_000, 20_000, 40_000, 60_000]);
    expect(Math.max(...gaps)).toBe(60_000);
    // A save that clears it resets the backoff.
    queued.clear();
    await runner.run();
    queued.set('source:f:epoch:1', {
      checkpointIds: [],
      state: new Uint8Array([2]),
    });
    const before = attempts.length;
    await runner.run();
    expect(attempts.length).toBe(before + 1);
  });

  it('holds live saves back until a failing room is due again', async () => {
    const room = 'source:f:epoch:1';
    const queued = new Map<string, FailedStoreSnapshot>([
      [room, { checkpointIds: [], state: new Uint8Array([1]) }],
    ]);
    let now = 0;
    const runner = new FailedStoreRetryRunner(
      queued,
      async () => {},
      () => now
    );
    // Not yet retried: a live save may run.
    expect(runner.waiting(room)).toBe(false);
    await runner.run();
    // The retry failed: live saves wait for the 5 s step.
    now = 4000;
    expect(runner.waiting(room)).toBe(true);
    now = 5000;
    expect(runner.waiting(room)).toBe(false);
    // A save that succeeded clears the wait.
    queued.clear();
    now = 1000;
    expect(runner.waiting(room)).toBe(false);
  });
});
