// Look inside a seeded DOCX state: roots, a few delta ops, and what each
// pilcrow payload key and each run-boundary field weighs (JSON bytes).
// Usage: node inspect.mjs file.docx [samples]
import { readFile } from 'node:fs/promises';
import { office, Y } from '../storage/lib.mjs';

const path = process.argv[2];
const samples = Number(process.argv[3] ?? 3);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice('docx', bytes);
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);
const json = (v) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `<bin ${x.length}>` : x));
const len = (v) => (v === undefined ? 0 : Buffer.byteLength(json(v)));

console.log('state', seed.state.length, 'roots', [...doc.share.keys()]);
for (const [name, type] of doc.share) console.log(' root', name, type.constructor.name, type._map?.size, type._length);

const stories = doc.getMap('stories');
console.log('stories', [...stories.keys()].length, [...stories.keys()].slice(0, 8));
const body = stories.get('body');
const delta = body.toDelta();
let shown = 0;
for (const op of delta) {
  if (shown++ >= samples * 4) break;
  if (typeof op.insert === 'string') console.log('TEXT', JSON.stringify(op.insert.slice(0, 40)), json(op.attributes ?? {}));
  else {
    const map = op.insert;
    const obj = map instanceof Y.Map ? map.toJSON() : op.insert;
    console.log('EMBED', json(obj).slice(0, 1600), 'attrs', json(op.attributes ?? {}));
  }
}

// Weigh every embed payload key, and the run-boundary fields.
const keyBytes = {};
const boundaryField = {};
let boundaries = 0, runs = 0, emptyRuns = 0, withPc = 0;
const kinds = {};
for (const [, story] of stories) {
  for (const op of story.toDelta()) {
    if (typeof op.insert === 'string') continue;
    const obj = op.insert.toJSON();
    kinds[obj._kind] = (kinds[obj._kind] ?? 0) + 1;
    for (const [k, v] of Object.entries(obj)) keyBytes[`${obj._kind}.${k}`] = (keyBytes[`${obj._kind}.${k}`] ?? 0) + len(v);
    if (obj._kind !== 'pilcrow' || !obj._originalRunBoundaries) continue;
    boundaries++;
    for (const b of obj._originalRunBoundaries) {
      runs++;
      if (!b.text) emptyRuns++;
      if (b.propertyChanges) withPc++;
      for (const [k, v] of Object.entries(b)) boundaryField[k] = (boundaryField[k] ?? 0) + len(v);
    }
  }
}
console.log('embed kinds', json(kinds));
console.log('embed key bytes (JSON)', json(Object.fromEntries(Object.entries(keyBytes).sort((a, b) => b[1] - a[1]).slice(0, 30))));
console.log('boundaries', { paragraphs: boundaries, runs, emptyRuns, withPc }, 'field bytes', json(boundaryField));
