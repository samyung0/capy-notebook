// JS heap held by one room's Y.Doc (the collaboration service keeps one per open room).
import { readFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';
const state = new Uint8Array(await readFile(process.argv[2]));
global.gc(); const before = process.memoryUsage().heapUsed;
const doc = new Y.Doc({ gc: true });
Y.applyUpdate(doc, state);
global.gc(); const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ state: process.argv[2].split(/[\/]/).pop(), stateBytes: state.length, heapMB: +((after - before) / 1048576).toFixed(1) }));
doc.destroy();
