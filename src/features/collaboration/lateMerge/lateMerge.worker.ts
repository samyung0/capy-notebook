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

export type MergeReply = { merged: ArrayBuffer } | { error: string };

/** No base: the room's collection keeps every client's clock, so the units
 * the fetched document holds are what the room acknowledged, and the merge
 * skips them. */
const NO_BASE = new Uint8Array();

/** One merge; the WASM loads on the first (a no-op once loaded). */
export async function mergeRequest({
  author,
  current,
  old,
}: MergeRequest): Promise<MergeReply> {
  try {
    await init();
    const [from, to] = [new Uint8Array(old), new Uint8Array(current)];
    const merged =
      author === undefined
        ? merge(from, NO_BASE, to)
        : reauthor(from, NO_BASE, to, author);
    return { merged: merged.slice().buffer };
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
