import { slateNodesToInsertDelta } from '@slate-yjs/core';
import * as Y from 'yjs';
import type { MergeReply, MergeRequest } from './lateMerge.worker';

/** Text a late merge would hide: it sits in a block someone deleted. */
export interface HiddenText {
  /** The block it sat in, in the tab's document (a Yjs item id). */
  block: { client: number; clock: number };
  /** That block's Plate id, when it has one. */
  blockId: string | null;
  text: string;
}

/** How long a merge may take from its start: a late tab that would wait
 * longer keeps its edits read-only for copying instead. */
export const LATE_MERGE_DEADLINE_MS = 10_000;

/**
 * The late merge of the in-place GC (openwiki/frontend/plate-editor.md "The
 * late path"): a session older than the room's collection window may name
 * units a collection discarded, so its unsent edits never go raw. Given its
 * old document and the room's current one, this answers one ordinary update
 * holding those edits under their own ids, placed after their nearest left
 * neighbour the current document still holds (stable left); the tab applies
 * it to the new document and sends it like any edit. `hidden` is the text
 * the tab shows that the merged note would not (it sits in a block someone
 * deleted): the tab keeps it as one refused row, for copying (Developer
 * Epo, 2026-10-24).
 *
 * With `author` (the session's assigned client id) the edits are
 * re-authored instead: the same places, as new edits under that id, for
 * edits under an id the room never assigned or no longer holds. That is not
 * repeat-safe: it runs once per group of stored edits, which the result
 * replaces at once.
 *
 * Runs in a worker that is gone afterwards, so neither it nor its WASM is
 * in the main bundle or stays loaded. Past `LATE_MERGE_DEADLINE_MS` the
 * worker is stopped and the merge fails.
 */
export function mergeLate(
  old: Uint8Array,
  current: Uint8Array,
  author?: number
): Promise<{ hidden: HiddenText[]; merged: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./lateMerge.worker.ts', import.meta.url),
      {
        name: 'late-merge',
        type: 'module',
      }
    );
    const deadline = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          `The late merge did not finish in ${LATE_MERGE_DEADLINE_MS / 1000} s`
        )
      );
    }, LATE_MERGE_DEADLINE_MS);
    const done = () => {
      clearTimeout(deadline);
      worker.terminate();
    };
    worker.onmessage = ({ data }: MessageEvent<MergeReply>) => {
      done();
      if ('error' in data) reject(new Error(data.error));
      else
        resolve({ hidden: data.hidden, merged: new Uint8Array(data.merged) });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      done();
      reject(new Error(event.message || 'The late merge worker failed'));
    };
    const request: MergeRequest = {
      author,
      current: current.slice().buffer,
      old: old.slice().buffer,
    };
    worker.postMessage(request, [request.current, request.old]);
  });
}

/** Whether `old` holds anything `doc` lacks: a unit past its clocks, or a
 * deletion it has not made. Without either there is nothing to merge, and
 * the worker and its WASM need not load. */
export function holdsUnsent(old: Uint8Array, doc: Y.Doc): boolean {
  const held = Y.decodeStateVector(Y.encodeStateVector(doc));
  const clocks = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(old));
  for (const [client, clock] of clocks)
    if (clock > (held.get(client) ?? 0)) return true;
  const deleted = Y.createDeleteSetFromStructStore(doc.store);
  const both = Y.mergeDeleteSets([deleted, Y.decodeUpdate(old).ds]);
  return !Y.equalDeleteSets(both, deleted);
}

/** A note holding each block's hidden text as one paragraph, in order: the
 * refused row the recovery view shows for copying. */
export function hiddenDocument(hidden: readonly HiddenText[]): Uint8Array {
  const doc = new Y.Doc();
  doc.get('content', Y.XmlText).applyDelta(
    slateNodesToInsertDelta(
      hidden.map((part) => ({
        children: [{ text: part.text }],
        id: part.blockId ?? crypto.randomUUID(),
        type: 'p',
      }))
    )
  );
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
