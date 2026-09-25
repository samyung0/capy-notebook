// Latest = captured + more commits (same browser client, later clock), on other cells.
// Usage: node emulate_more.mjs <captured.bin> <rows> <from> <edits> <out.bin>
import { readFile, writeFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';
const [capturedPath, rowsArg, fromArg, editsArg, outPath] = process.argv.slice(2);
const rows = Number(rowsArg), from = Number(fromArg), edits = Number(editsArg);
const doc = new Y.Doc({ gc: true });
doc.clientID = 3_000_000_002;
Y.applyUpdate(doc, new Uint8Array(await readFile(capturedPath)));
const contents = doc.getMap('xlsx:sheets').get('sheet:0').get('contents');
const cols = [0, 1, 2, 3, 4, 5, 7, 8, 9];
for (let i = from; i < from + edits; i++) {
  const row = 1 + (Math.floor(i / cols.length) % (rows - 1));
  const col = cols[i % cols.length];
  doc.transact(() => contents.set(`[{"run":"base","offset":${row}},{"run":"base","offset":${col}}]`, `{"value":{"kind":"number","value":${700000 + i}.0},"formula":null}`));
}
const state = Y.encodeStateAsUpdate(doc);
await writeFile(outPath, state);
console.log(JSON.stringify({ captured: capturedPath, stateBytes: state.length }));
