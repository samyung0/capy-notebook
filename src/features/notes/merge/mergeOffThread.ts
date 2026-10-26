import type { MaterialElement } from '@/features/materials/document';
import type { BlockConflict, CopyPair, MergeStep } from './blockMerge';

export interface Diffed {
  conflicts: BlockConflict[];
  steps: MergeStep[];
}

/** `mergeCopies` in its own worker (merge.worker.ts, review r1 L1): the
 * diff of a near-limit note stays off the main thread. */
export function mergeOffThread(pairs: CopyPair[], theirs: MaterialElement[]) {
  return new Promise<Diffed>((resolve, reject) => {
    const worker = new Worker(new URL('./merge.worker.ts', import.meta.url), {
      name: 'note-merge',
      type: 'module',
    });
    worker.onmessage = ({ data }: MessageEvent<Diffed | { error: string }>) => {
      worker.terminate();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'note merge failed'));
    };
    worker.postMessage({ pairs, theirs });
  });
}
