// Emulates E browser cell commits (one Yjs transaction per commit, uint32 client id)
// on a saved XLSX state, writing the engine's own payload shape for a numeric edit:
//   key   [{"run":"base","offset":R},{"run":"base","offset":C}]
//   value {"value":{"kind":"number","value":N.0},"formula":null}
// Usage: node emulate.mjs <seed.bin> <rows> <edits> <out.bin> [--compact]
// --compact writes the same edits with a short key "R:C" and an Any array [1, N]
// (size estimate only; the prototype engine does not read that encoding).
import { readFile, writeFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';

const [seedPath, rowsArg, editsArg, outPath] = process.argv.slice(2);
const compact = process.argv.includes('--compact');
const rows = Number(rowsArg);
const edits = Number(editsArg);
const seed = new Uint8Array(await readFile(seedPath));
const doc = new Y.Doc({ gc: true });
doc.clientID = 3_000_000_001; // uint32, as src/office-runtime/main.tsx uses
Y.applyUpdate(doc, seed);
const contents = doc.getMap('xlsx:sheets').get('sheet:0').get('contents');
const cols = [0, 1, 2, 3, 4, 5, 7, 8, 9];
const t = performance.now();
for (let i = 0; i < edits; i++) {
  const row = 1 + (Math.floor(i / cols.length) % (rows - 1));
  const col = cols[i % cols.length];
  const value = 500000 + i;
  doc.transact(() => {
    if (compact) contents.set(`${row}:${col}`, [1, value]);
    else
      contents.set(
        `[{"run":"base","offset":${row}},{"run":"base","offset":${col}}]`,
        `{"value":{"kind":"number","value":${value}.0},"formula":null}`
      );
  });
}
const state = Y.encodeStateAsUpdate(doc);
await writeFile(outPath, state);
console.log(
  JSON.stringify({
    seed: seedPath.split(/[\\/]/).pop(),
    edits,
    distinct: contents.size,
    compact,
    seedBytes: seed.length,
    stateBytes: state.length,
    growth: state.length - seed.length,
    perEdit: +((state.length - seed.length) / Math.max(edits, 1)).toFixed(1),
    ms: Math.round(performance.now() - t),
  })
);
