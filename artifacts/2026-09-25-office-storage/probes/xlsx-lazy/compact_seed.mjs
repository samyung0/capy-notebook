// Size of today's full seed if cells used compact keys and values (estimate only):
//   key "R,C" for base points; value Any array: number [1,v], text [2,s], bool [3,b],
//   formula [5, text, cached, ...per reference [start,end,sheet,r0,rlen,c0,clen,flags]];
//   style value: first 16 hex digits of the format hash.
import { readFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';
const seed = new Uint8Array(await readFile(process.argv[2]));
const src = new Y.Doc();
Y.applyUpdate(src, seed);
const out = new Y.Doc();
out.clientID = 123456789012345; // 47-bit, like the bootstrap ids
const short = (k) => { const [r, c] = JSON.parse(k); return r.run === 'base' && c.run === 'base' ? `${r.offset},${c.offset}` : k; };
const value = (json) => {
  const { value: v, formula } = JSON.parse(json);
  const cached = v.kind === 'number' ? [1, v.value] : v.kind === 'text' ? [2, v.value] : v.kind === 'bool' ? [3, v.value] : v.kind === 'error' ? [4, v.value] : [0];
  if (!formula) return cached;
  const refs = formula.bindings.map((b) => [b.start, b.end, Number(b.sheet.split(':')[1] ?? 0), b.range.rows[0].start, b.range.rows[0].len, b.range.cols[0].start, b.range.cols[0].len, b.range.flags.reduce((m, f, i) => m | (f ? 1 << i : 0), 0)]);
  return [5, formula.text, cached, refs];
};
let cells = 0, styles = 0;
out.transact(() => {
  const sheetsOut = out.getMap('xlsx:sheets');
  for (const [key, sheet] of src.getMap('xlsx:sheets')) {
    const s = new Y.Map();
    sheetsOut.set(key, s);
    const contents = new Y.Map(), st = new Y.Map();
    s.set('contents', contents);
    s.set('styles', st);
    for (const [k, v] of sheet.get('contents')) { contents.set(short(k), value(v)); cells++; }
    for (const [k, v] of sheet.get('styles')) { st.set(short(k), v.slice(0, 16)); styles++; }
  }
});
const cellsBytes = Y.encodeStateAsUpdate(out).length;
// Everything outside contents/styles, from the breakdown of the real seed.
console.log(JSON.stringify({ seed: process.argv[2].split(/[\/]/).pop(), seedBytes: seed.length, cells, styles, compactCellsAndStylesBytes: cellsBytes, perCell: +(cellsBytes / cells).toFixed(1) }));
