import type { MergeReply } from './lateMerge.worker';

/**
 * The late merge of the in-place GC (openwiki/frontend/plate-editor.md "The
 * late path"): a session older than the room's collection window may name
 * units a collection discarded, so its unsent edits never go raw. Given its
 * old document and the room's current one, this answers one ordinary update
 * holding those edits under their own ids, placed after their nearest left
 * neighbour the current document still holds (stable left); the tab applies
 * it to the new document and sends it like any edit. Runs in a worker that
 * is gone afterwards, so neither it nor its WASM is in the main bundle or
 * stays loaded.
 */
export function mergeLate(
  old: Uint8Array,
  current: Uint8Array
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./lateMerge.worker.ts', import.meta.url),
      {
        name: 'late-merge',
        type: 'module',
      }
    );
    worker.onmessage = ({ data }: MessageEvent<MergeReply>) => {
      worker.terminate();
      if ('error' in data) reject(new Error(data.error));
      else resolve(new Uint8Array(data.merged));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      reject(new Error(event.message || 'The late merge worker failed'));
    };
    const request = {
      current: current.slice().buffer,
      old: old.slice().buffer,
    };
    worker.postMessage(request, [request.current, request.old]);
  });
}
