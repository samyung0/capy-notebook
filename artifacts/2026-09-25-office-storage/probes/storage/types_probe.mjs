import { readFile } from 'node:fs/promises';
import { office, Y, formatOf } from './lib.mjs';
const path = process.argv[2];
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(format, bytes);
const editable = await office.inspectOffice(bytes, seed);
const target = editable.filter((e) => e.value.length > 40)[3];
const [loc] = await office.locateOfficeTargets(bytes, seed, [target.id]);
console.log('target', target.id, JSON.stringify(loc), target.value.length);
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);
const root = doc.getMap(loc.path[0]);
const story = root.get(loc.path[1]);
console.log('story type', story?.constructor?.name, 'length', story?.length);
if (story instanceof Y.Text) {
  const delta = story.toDelta();
  let off = 0;
  for (const op of delta) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    if (off + len > loc.range[0] - 3 && off < loc.range[1] + 3)
      console.log(' op@', off, typeof op.insert === 'string' ? JSON.stringify(op.insert.slice(0, 40)) + `..(${len})` : JSON.stringify(op.insert).slice(0, 200), JSON.stringify(op.attributes ?? {}).slice(0, 200));
    off += len;
  }
}
