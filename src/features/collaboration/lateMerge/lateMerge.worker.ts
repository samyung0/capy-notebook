import init, { merge, reauthor } from './generated/late_merge.js';

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

/** `dropped`: units the tab shows that the update lacks (they sat in a
 * block the current document no longer holds). */
export type MergeReply =
  | { dropped: number; merged: ArrayBuffer }
  | { error: string };

/** One merge; the WASM loads on the first (a no-op once loaded). */
export async function mergeRequest({
  author,
  current,
  old,
}: MergeRequest): Promise<MergeReply> {
  try {
    await init();
    const [from, to] = [new Uint8Array(old), new Uint8Array(current)];
    const result =
      author === undefined ? merge(from, to) : reauthor(from, to, author);
    const reply = {
      dropped: result.dropped,
      merged: result.update.slice().buffer,
    };
    result.free();
    return reply;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Absent under vitest, which calls mergeRequest directly.
if (typeof self !== 'undefined')
  self.onmessage = async ({ data }: MessageEvent<MergeRequest>) => {
    const reply = await mergeRequest(data);
    self.postMessage(reply, 'merged' in reply ? [reply.merged] : []);
  };
