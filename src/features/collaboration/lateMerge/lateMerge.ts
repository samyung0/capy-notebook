import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import * as Y from 'yjs';
import type { MergeReply, MergeRequest } from './lateMerge.worker';

/** A top-level block of the tab's document (its Yjs item id) holding
 * something a late merge would hide: it sits in a block someone deleted. */
export interface HiddenBlock {
  client: number;
  clock: number;
}

/** How long a merge may take once its WASM loaded: a late tab that would
 * wait longer keeps its edits read-only for copying instead. */
export const LATE_MERGE_DEADLINE_MS = 10_000;

/**
 * The late merge of the in-place GC (openwiki/frontend/plate-editor.md "The
 * late path"): a session older than the room's collection window may name
 * units a collection discarded, so its unsent edits never go raw. Given its
 * old document and the room's current one, this answers one ordinary update
 * holding those edits under their own ids, placed after their nearest left
 * neighbour the current document still holds (stable left); the tab applies
 * it to the new document and sends it like any edit. `hidden` names the
 * blocks of the tab's document holding what the merged note would not show
 * (inside a block someone deleted): the tab keeps them as one refused row,
 * for copying (Developer Epo, 2026-10-24).
 *
 * With `author` (the session's assigned client id) the edits are
 * re-authored instead: the same places, as new edits under that id, for
 * edits under an id the room never assigned or no longer holds. That is not
 * repeat-safe: it runs once per group of stored edits, which the result
 * replaces at once.
 *
 * Runs in a worker that is gone afterwards, so neither it nor its WASM is
 * in the main bundle or stays loaded. `LATE_MERGE_DEADLINE_MS` after the
 * WASM loaded (a slow download is not merge time) the worker is stopped
 * and the merge fails.
 */
export function mergeLate(
  old: Uint8Array,
  current: Uint8Array,
  author?: number
): Promise<{ hidden: HiddenBlock[]; merged: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./lateMerge.worker.ts', import.meta.url),
      {
        name: 'late-merge',
        type: 'module',
      }
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(deadline);
      worker.terminate();
    };
    worker.onmessage = ({ data }: MessageEvent<MergeReply>) => {
      if ('ready' in data) {
        deadline = setTimeout(() => {
          worker.terminate();
          reject(
            new Error(
              `The late merge did not finish in ${LATE_MERGE_DEADLINE_MS / 1000} s`
            )
          );
        }, LATE_MERGE_DEADLINE_MS);
        return;
      }
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

/** A note holding the named blocks of the tab's document `old` whole (text,
 * inline elements, embeds), each once, in its order: the refused row the
 * recovery view shows for copying. */
export function hiddenDocument(
  old: Uint8Array,
  hidden: readonly HiddenBlock[]
): Uint8Array {
  const tab = new Y.Doc();
  Y.applyUpdate(tab, old);
  const named = new Set(
    hidden.map(({ client, clock }) => `${client}:${clock}`)
  );
  // Each top-level block is one embedded XmlText of the content root.
  const blocks = tab
    .get('content', Y.XmlText)
    .toDelta()
    .flatMap(({ insert }: { insert: unknown }) => {
      const id = insert instanceof Y.XmlText ? insert._item?.id : undefined;
      return id && named.has(`${id.client}:${id.clock}`)
        ? [yTextToSlateElement(insert as Y.XmlText)]
        : [];
    });
  tab.destroy();
  const doc = new Y.Doc();
  doc.get('content', Y.XmlText).applyDelta(slateNodesToInsertDelta(blocks));
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
