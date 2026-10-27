import init, { merge, reauthor } from './generated/late_merge.js';
import type { HiddenBlock } from './lateMerge';

/* The late merge of the in-place GC in a worker: the Rust merge compiled to
   WASM (collaboration-rs/crates/late-merge, built by
   scripts/build-late-merge.mjs). The worker and the WASM load only on the
   late path (lateMerge.ts). */

export interface MergeRequest {
  /** Re-author the edits under this client id (the session's assigned one)
   * instead of keeping theirs. */
  author?: number;
  /** The room's current document as fetched (a v1 state). */
  current: ArrayBuffer;
  /** The tab's old document (a v1 state): its unsent edits are merged. */
  old: ArrayBuffer;
}

/** `hidden`: the blocks holding what the tab shows that the merged document
 * would not (it sits in a block someone deleted). */
export type MergeResult =
  | { hidden: HiddenBlock[]; merged: ArrayBuffer }
  | { error: string };

/** What the worker posts: `ready` once the WASM loaded (the tab then sends
 * its request and its deadline starts), then the result. */
export type MergeReply = { ready: true } | MergeResult;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One merge; the WASM loads on the first (a no-op once loaded). */
export async function mergeRequest({
  author,
  current,
  old,
}: MergeRequest): Promise<MergeResult> {
  try {
    await init();
    const [from, to] = [new Uint8Array(old), new Uint8Array(current)];
    const result =
      author === undefined ? merge(from, to) : reauthor(from, to, author);
    const reply = {
      hidden: JSON.parse(result.hidden) as HiddenBlock[],
      merged: result.update.slice().buffer,
    };
    result.free();
    return reply;
  } catch (error) {
    return { error: message(error) };
  }
}

// Absent under vitest, which calls mergeRequest directly.
if (typeof self !== 'undefined') {
  // The WASM loads as the worker starts; the tab sends its request once it
  // heard `ready`.
  void init().then(
    () => self.postMessage({ ready: true } satisfies MergeReply),
    (error: unknown) =>
      self.postMessage({ error: message(error) } satisfies MergeReply)
  );
  self.onmessage = async ({ data }: MessageEvent<MergeRequest>) => {
    const reply = await mergeRequest(data);
    self.postMessage(reply, 'merged' in reply ? [reply.merged] : []);
  };
}
