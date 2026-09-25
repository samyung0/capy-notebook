// CPU that scales with the stored state on every keystroke:
//  - collaboration beforeHandleMessage for a source room: assertUpdatePreservesContributors
//    (encode room + apply into a candidate + apply update) and the byte-limit check
//    (the same again plus one more encode), server.ts:539-555;
//  - the browser draft writer: Y.encodeStateAsUpdate(shared) per update, then an
//    IndexedDB put of { base, state } (useSourceSession.ts:396-410).
// Usage: node per_update_cost.mjs label=state.bin ...
import { readFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const arg of process.argv.slice(2)) {
  const [label, path] = arg.split('=');
  const state = await readFile(path);
  const room = new Y.Doc();
  Y.applyUpdate(room, state);
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  let update;
  client.on('update', (u) => (update = u));
  const firstText = [...client.share.values()].find((t) => t instanceof Y.Text) ?? client.getText('probe');
  const server = [];
  const draft = [];
  for (let i = 0; i < 7; i++) {
    firstText.insert(0, 'a');
    let t = performance.now();
    const c1 = new Y.Doc({ gc: true });
    Y.applyUpdate(c1, Y.encodeStateAsUpdate(room));
    Y.applyUpdate(c1, update);
    c1.destroy();
    const c2 = new Y.Doc();
    Y.applyUpdate(c2, Y.encodeStateAsUpdate(room));
    Y.applyUpdate(c2, update);
    Y.encodeStateAsUpdate(c2).byteLength;
    c2.destroy();
    Y.applyUpdate(room, update);
    server.push(performance.now() - t);
    t = performance.now();
    Y.encodeStateAsUpdate(client);
    draft.push(performance.now() - t);
  }
  console.log(JSON.stringify({ label, state: state.length, serverPerMessageMs: +median(server).toFixed(1), draftEncodeMs: +median(draft).toFixed(1) }));
  room.destroy();
  client.destroy();
}
