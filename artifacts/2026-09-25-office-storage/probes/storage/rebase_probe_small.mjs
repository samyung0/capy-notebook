// What does rebaseOffice add on top of a fresh seed of the export?
import { readFile } from 'node:fs/promises';
import { office, Y, formatOf, checkpoint, DETERMINISM } from './lib.mjs';
const path = process.argv[2];
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(format, bytes);
const editable = await office.inspectOffice(bytes, seed);
function commands(offset, n) {
  if (format === 'xlsx') {
    const cells = editable.filter((e) => /![E]\d+$/.test(e.label) && !/!E1$/.test(e.label)).slice(offset, offset + n);
    return cells.map((e) => ({ type: 'set_cell', sheet: e.label.split('!')[0], cell: e.label.split('!')[1], expectedValue: e.value, value: String(Number(e.value) + 7) }));
  }
  return editable.filter((e) => e.value.split(' ').length > 3).slice(offset, offset + n).map((e) => ({ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value + ' edited' }));
}
const captured = (await office.applyOfficeCommands(bytes, seed, commands(0, 3))).state;
const B = await office.exportOffice(bytes, checkpoint(format, bytes, captured), DETERMINISM('job-r'));
const latest = (await office.applyOfficeCommands(bytes, checkpoint(format, bytes, captured), commands(3, 3))).state;
const seedB = (await office.seedOffice(format, B)).state;
const rebased = await office.rebaseOffice(bytes, checkpoint(format, bytes, captured), checkpoint(format, bytes, latest), B);
function roots(state) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = {};
  for (const [name] of doc.share) {
    const sub = new Y.Doc();
    // size of a root = encoded bytes of the items reachable from it (approx via JSON)
    let bytesOf = 0;
    const walk = (type) => {
      for (let it = type._start; it; it = it.right) visit(it);
      for (const last of type._map.values()) for (let it = last; it; it = it.left) visit(it);
    };
    const visit = (it) => {
      const c = it.content;
      if (c.constructor.name === 'ContentBinary') bytesOf += c.content.length;
      else if (c.constructor.name === 'ContentAny') bytesOf += c.arr.reduce((s, v) => s + (v instanceof Uint8Array ? v.length : Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x instanceof Uint8Array ? 'B'.repeat(x.length) : x)) ?? '')), 0);
      else if (c.constructor.name === 'ContentString') bytesOf += Buffer.byteLength(c.str);
      if (c.constructor.name === 'ContentType') walk(c.type);
    };
    walk(doc.share.get(name));
    out[name] = bytesOf;
    sub.destroy();
  }
  return out;
}
const r = roots(rebased.state), s = roots(seedB);
const diff = Object.fromEntries(Object.keys({ ...r, ...s }).map((k) => [k, (r[k] ?? 0) - (s[k] ?? 0)]).filter(([, v]) => v));
console.log(JSON.stringify({ file: path.split('/').pop(), source: bytes.length, exported: B.length, seedB: seedB.length, rebased: rebased.state.length, latest: latest.length, rootPayloadDiff: diff, rebasedRoots: r }));
