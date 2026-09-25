import { readFile } from 'node:fs/promises';
import { office, Y, formatOf } from './lib.mjs';
const path = process.argv[2];
const keys = process.argv.slice(3);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(formatOf(path), bytes);
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);
const shown = new Map();
function walk(type) {
  const items = [];
  for (let it = type._start; it; it = it.right) items.push(it);
  for (const last of type._map.values()) items.push(last);
  for (const it of items) {
    const c = it.content;
    const key = it.parentSub ?? (c.key ? 'format:' + c.key : c.constructor.name);
    if (keys.includes(key) && (shown.get(key) ?? 0) < 2) {
      shown.set(key, (shown.get(key) ?? 0) + 1);
      console.log(key, String(JSON.stringify("arr" in c ? c.arr : "value" in c ? c.value : "embed" in c ? c.embed : c.str)).slice(0, 1500));
    }
    if (c.constructor.name === 'ContentType') walk(c.type);
  }
}
for (const [, t] of doc.share) walk(t);
