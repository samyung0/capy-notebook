import { afterEach, expect, it, vi } from 'vitest';
import { type CopyPair, mergeCopies } from './blockMerge';
import { mergeOffThread } from './mergeOffThread';

/* Review r1 L1 (Q397): the bind merge's diff runs off the main thread. */

const p = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});

const WORKER_FILE = /merge\.worker\.ts$/;

afterEach(() => vi.unstubAllGlobals());

it('diffs in a module worker and answers with its result', async () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onerror: ((event: { message: string }) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    terminate = vi.fn();
    readonly options: WorkerOptions;
    readonly url: URL;
    constructor(url: URL, options: WorkerOptions) {
      this.options = options;
      this.url = url;
      workers.push(this);
    }
    postMessage({
      pairs,
      theirs,
    }: {
      pairs: CopyPair[];
      theirs: CopyPair['mine'];
    }) {
      queueMicrotask(() =>
        this.onmessage?.({ data: mergeCopies(pairs, theirs) })
      );
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const pairs = [{ base: [p('a', 'A')], mine: [p('a', 'A mine')] }];
  const theirs = [p('a', 'A')];
  await expect(mergeOffThread(pairs, theirs)).resolves.toEqual(
    mergeCopies(pairs, theirs)
  );
  expect(workers).toHaveLength(1);
  expect(workers[0].url.pathname).toMatch(WORKER_FILE);
  expect(workers[0].options).toMatchObject({ type: 'module' });
  expect(workers[0].terminate).toHaveBeenCalled();
});
