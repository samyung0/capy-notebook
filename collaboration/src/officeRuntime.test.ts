import { afterEach, expect, test, vi } from 'vitest';

// A stand-in for the engine worker thread: it records what the queue posts and
// answers only when a test emits a message for it.
const { FakeWorker, workers } = vi.hoisted(() => {
  class FakeWorker {
    readonly posted: unknown[] = [];
    terminated = false;
    private readonly handlers = new Map<string, (value: unknown) => void>();
    constructor() {
      workers.push(this);
    }
    on(event: string, handler: (value: unknown) => void) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, value: unknown) {
      this.handlers.get(event)?.(value);
    }
    postMessage(message: unknown) {
      this.posted.push(message);
    }
    ref() {}
    unref() {}
    terminate() {
      this.terminated = true;
      this.emit('exit', 1);
      return Promise.resolve(1);
    }
  }
  const workers: FakeWorker[] = [];
  return { FakeWorker, workers };
});
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

async function load() {
  vi.resetModules();
  workers.length = 0;
  const runtime = await import('./officeRuntime.js');
  return {
    ...runtime,
    seed: () => runtime.runOffice('seedOffice', 'docx', new Uint8Array()),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('a wasm-bindgen broken-object error replaces the worker like a trap; a refusal keeps it', async () => {
  const { OfficeEngineError, seed } = await load();
  const refused = seed();
  const broken = seed();
  const [first] = workers;
  expect(first.posted).toHaveLength(1);
  first.emit('message', { error: 'stale_target: changed', trap: false });
  await expect(refused).rejects.toBeInstanceOf(OfficeEngineError);
  expect(first.terminated).toBe(false);
  expect(first.posted).toHaveLength(2);
  first.emit('message', {
    error: 'attempted to take ownership of Rust value while it was borrowed',
    trap: false,
  });
  await expect(broken).rejects.toBeInstanceOf(OfficeEngineError);
  expect(first.terminated).toBe(true);
  const next = seed();
  expect(workers).toHaveLength(2);
  workers[1].emit('message', { value: 'fresh' });
  await expect(next).resolves.toBe('fresh');
});

test('a timed-out call fails, the queue moves to a new worker and a late result is dropped', async () => {
  vi.useFakeTimers();
  const { seed } = await load();
  const hung = seed();
  const queued = seed();
  const [first] = workers;
  const timedOut = expect(hung).rejects.toThrow('Office seedOffice timed out');
  await vi.advanceTimersByTimeAsync(120_000);
  await timedOut;
  expect(first.terminated).toBe(true);
  expect(workers[1].posted).toHaveLength(1);
  first.emit('message', { value: 'late' });
  workers[1].emit('message', { value: 'queued' });
  await expect(queued).resolves.toBe('queued');
});
