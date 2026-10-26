/// <reference lib="webworker" />

import { type CopyPair, mergeCopies } from './blockMerge';

/* The bind merge's diff (Q229, Q397), off the main thread: a near-limit
 * note's three versions are compared here, and the page applies the steps. */
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = ({
  data,
}: MessageEvent<{ pairs: CopyPair[]; theirs: CopyPair['mine'] }>) => {
  try {
    workerScope.postMessage(mergeCopies(data.pairs, data.theirs));
  } catch (error) {
    workerScope.postMessage({ error: String(error) });
  }
};
