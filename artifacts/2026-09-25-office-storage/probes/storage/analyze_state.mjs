// Break a seeded state down by root type and content class (payload bytes).
// Usage: node analyze_state.mjs file [--baseline]
import { readFile } from 'node:fs/promises';
import { office, Y, formatOf } from './lib.mjs';

const path = process.argv[2];
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(format, bytes);
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);

const size = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x instanceof Uint8Array ? 'B'.repeat(x.length) : x)) ?? '');
function contentBytes(c) {
  switch (c.constructor.name) {
    case 'ContentString': return ['string', size(c.str)];
    case 'ContentFormat': return [`format:${c.key}`, size(c.key) + size(c.value)];
    case 'ContentEmbed': return ['embed', size(c.embed)];
    case 'ContentAny': return ['any', c.arr.reduce((s, v) => s + size(v), 0)];
    case 'ContentJSON': return ['json', c.arr.reduce((s, v) => s + size(v), 0)];
    case 'ContentBinary': return ['binary', c.content.length];
    case 'ContentType': return ['type', 1];
    case 'ContentDeleted': return ['deleted', 0];
    default: return [c.constructor.name, 0];
  }
}
const table = new Map();
const add = (root, kind, n) => {
  const key = `${root}\t${kind}`;
  const row = table.get(key) ?? { items: 0, bytes: 0 };
  row.items++;
  row.bytes += n;
  table.set(key, row);
};
// Walk every item reachable from the roots (list children and map entries).
const seen = new Set();
function walk(type, root) {
  const items = [];
  for (let it = type._start; it; it = it.right) items.push(it);
  for (const last of type._map.values()) for (let it = last; it; it = it.left) items.push(it);
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    const [kind, n] = contentBytes(item.content);
    const sub = item.parentSub ? `.${/^[\w:.-]{1,24}$/.test(item.parentSub) ? item.parentSub : '<key>'}` : '';
    add(root, kind + (kind === 'any' || kind === 'binary' ? sub : ''), n);
    if (item.content.constructor.name === 'ContentType') walk(item.content.type, root);
  }
}
for (const [name, type] of doc.share) walk(type, name);
const rows = [...table.entries()].map(([k, v]) => [k, v]).sort((a, b) => b[1].bytes - a[1].bytes);
console.log(`${path}: state ${seed.state.length} bytes, items ${seen.size}`);
let payload = 0;
for (const [k, v] of rows.slice(0, 25)) {
  payload += v.bytes;
  console.log(`  ${k.padEnd(60)} items=${String(v.items).padStart(7)} payload=${String(v.bytes).padStart(10)}`);
}
console.log(`  top-25 payload ${payload}; all payload ${rows.reduce((s, [, v]) => s + v.bytes, 0)}`);

if (process.argv.includes('--baseline')) {
  const entries = await office.officeBaseline(bytes, seed);
  const per = {};
  for (const e of entries) {
    const k = e.kind;
    per[k] ??= { n: 0, json: 0, value: 0, id: 0, label: 0, position: 0 };
    per[k].n++;
    per[k].json += size(e) + 1;
    per[k].value += size(e.value);
    per[k].id += size(e.id);
    per[k].label += size(e.label);
    per[k].position += size(e.position);
  }
  console.log('baseline by kind', JSON.stringify(per));
  console.log('sample entries', JSON.stringify(entries.slice(0, 4)));
}
