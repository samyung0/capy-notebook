// Exact per-cell byte breakdown of the seeded XLSX state and of its semantic baseline.
// Usage: node breakdown.mjs <file.xlsx>
// State: walks every Yjs item and recomputes its update-v1 encoded length from the
// Item.write rules (info, origins/parent, parentSub, content), then checks the sum
// against Y.encodeStateAsUpdate. Baseline: splits each entry's JSON into fields.
import { readFile } from 'node:fs/promises';
import { office, Y, baselineBytes } from '../storage/lib.mjs';

const path = process.argv[2];
const bytes = new Uint8Array(await readFile(path));
const t0 = performance.now();
const seed = await office.seedOffice('xlsx', bytes);
const seedMs = performance.now() - t0;
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);

const varuint = (n) => {
  let len = 1;
  n = Number(n);
  while (n >= 128) {
    n = Math.floor(n / 128);
    len++;
  }
  return len;
};
const varstr = (s) => {
  const b = Buffer.byteLength(s);
  return varuint(b) + b;
};
function anyLen(v) {
  if (v === undefined) return 1;
  if (v === null) return 1;
  if (typeof v === 'string') return 1 + varstr(v);
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'bigint') return 9;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) {
      // writeVarInt: sign bit in the first byte
      let n = Math.abs(v);
      let len = 1;
      n = Math.floor(n / 64);
      while (n > 0) {
        n = Math.floor(n / 128);
        len++;
      }
      return 1 + len;
    }
    return Math.fround(v) === v ? 5 : 9;
  }
  if (v instanceof Uint8Array) return 1 + varuint(v.length) + v.length;
  if (Array.isArray(v)) return 1 + varuint(v.length) + v.reduce((s, x) => s + anyLen(x), 0);
  const entries = Object.entries(v);
  return 1 + varuint(entries.length) + entries.reduce((s, [k, x]) => s + varstr(k) + anyLen(x), 0);
}
function contentLen(c) {
  switch (c.constructor.name) {
    case 'ContentAny':
      return varuint(c.arr.length) + c.arr.reduce((s, v) => s + anyLen(v), 0);
    case 'ContentType':
      return 1; // type ref (YMap/YArray have no extra fields)
    case 'ContentString':
      return varstr(c.str);
    case 'ContentDeleted':
      return varuint(c.len);
    case 'ContentBinary':
      return varuint(c.content.length) + c.content.length;
    default:
      throw new Error(`unhandled content ${c.constructor.name}`);
  }
}
// Encoded length of one Item in update v1, split into components.
function itemParts(item) {
  const parts = { info: 1, origin: 0, parent: 0, key: 0, content: 0 };
  if (item.origin) parts.origin = varuint(item.origin.client) + varuint(item.origin.clock);
  if (item.rightOrigin)
    parts.origin += varuint(item.rightOrigin.client) + varuint(item.rightOrigin.clock);
  if (!item.origin && !item.rightOrigin) {
    const parent = item.parent;
    if (parent._item === null) {
      const name = [...doc.share.entries()].find(([, t]) => t === parent)[0];
      parts.parent = 1 + varstr(name);
    } else parts.parent = 1 + varuint(parent._item.id.client) + varuint(parent._item.id.clock);
    if (item.parentSub !== null) parts.key = varstr(item.parentSub);
  }
  parts.content = contentLen(item.content);
  return parts;
}

// Walk every struct in the store, grouped by the container path it lives in.
const groups = new Map();
const add = (group, parts, extra = {}) => {
  const g = groups.get(group) ?? { items: 0, info: 0, origin: 0, parent: 0, key: 0, content: 0, keyText: 0, valueText: 0 };
  g.items++;
  for (const k of ['info', 'origin', 'parent', 'key', 'content']) g[k] += parts[k];
  g.keyText += extra.keyText ?? 0;
  g.valueText += extra.valueText ?? 0;
  groups.set(group, g);
};
function pathOf(type) {
  const names = [];
  while (type._item) {
    names.unshift(type._item.parentSub ?? '?');
    type = type._item.parent;
  }
  const root = [...doc.share.entries()].find(([, t]) => t === type)?.[0] ?? '?';
  return [root, ...names];
}
let structBytes = 0;
let clientBlocks = 0;
for (const [client, structs] of doc.store.clients) {
  clientBlocks++;
  for (const s of structs) {
    if (s.constructor.name !== 'Item') {
      add(`<${s.constructor.name}>`, { info: 1, origin: 0, parent: 0, key: 0, content: varuint(s.length) });
      continue;
    }
    const p = pathOf(s.parent);
    let group = p.join('/');
    if (p[0] === 'xlsx:sheets' && p.length === 3) group = `xlsx:sheets/<sheet>/${p[2]}`;
    if (p[0] === 'xlsx:axis-catalog' && p.length >= 2) group = `xlsx:axis-catalog/<sheet>/${p.slice(2).join('/')}`;
    const parts = itemParts(s);
    const value = s.content.constructor.name === 'ContentAny' ? s.content.arr[0] : undefined;
    add(group, parts, {
      keyText: s.parentSub ? Buffer.byteLength(s.parentSub) : 0,
      valueText: typeof value === 'string' ? Buffer.byteLength(value) : 0,
    });
    structBytes += parts.info + parts.origin + parts.parent + parts.key + parts.content;
  }
}
const total = seed.state.length;
const cells = doc.getMap('xlsx:sheets');
let cellCount = 0;
let formulaCells = 0;
const contentValues = { number: [0, 0], text: [0, 0], formula: [0, 0], other: [0, 0] };
for (const [, sheet] of cells) {
  for (const [, v] of sheet.get('contents')) {
    cellCount++;
    const parsed = JSON.parse(v);
    const kind = parsed.formula ? 'formula' : parsed.value.kind in contentValues ? parsed.value.kind : 'other';
    if (parsed.formula) formulaCells++;
    contentValues[kind][0]++;
    contentValues[kind][1] += Buffer.byteLength(v);
  }
}
let styledCells = 0;
for (const [, sheet] of cells) styledCells += sheet.get('styles').size;
console.log(JSON.stringify({ file: path.split(/[\\/]/).pop(), sourceBytes: bytes.length, stateBytes: total, seedMs: Math.round(seedMs), clientBlocks, structBytesComputed: structBytes, headerAndDeleteSet: total - structBytes, contentEntries: cellCount, styleEntries: styledCells, formulaCells }));
for (const [group, g] of [...groups.entries()].sort((a, b) => b[1].info + b[1].origin + b[1].parent + b[1].key + b[1].content - (a[1].info + a[1].origin + a[1].parent + a[1].key + a[1].content))) {
  const sum = g.info + g.origin + g.parent + g.key + g.content;
  console.log(JSON.stringify({ group, items: g.items, bytes: sum, perItem: +(sum / g.items).toFixed(1), info: g.info, origin: g.origin, parentRef: g.parent, keyWithLen: g.key, contentWithHeaders: g.content, keyText: g.keyText, valueText: g.valueText }));
}
console.log(JSON.stringify({ contentValueJsonByKind: Object.fromEntries(Object.entries(contentValues).map(([k, [n, b]]) => [k, { n, bytes: b, avg: n ? +(b / n).toFixed(1) : 0 }])) }));

// Sample values
for (const [, sheet] of cells) {
  const contents = [...sheet.get('contents').entries()];
  const styles = [...sheet.get('styles').entries()];
  const sample = (arr, pred) => arr.find(pred);
  console.log('sample number', JSON.stringify(sample(contents, ([, v]) => v.includes('"number"') && !v.includes('"text":'))));
  console.log('sample text', JSON.stringify(sample(contents, ([, v]) => v.includes('"kind":"text"'))));
  console.log('sample formula', JSON.stringify(sample(contents, ([, v]) => v.includes('"formula":{'))));
  console.log('sample style', JSON.stringify(styles[0]));
  break;
}

// Baseline
if (!process.argv.includes('--no-baseline')) {
  const t1 = performance.now();
  const entries = await office.officeBaseline(bytes, seed);
  const baselineMs = performance.now() - t1;
  const total = baselineBytes(entries, 'xlsx');
  const kinds = {};
  const isCell = (e) => e.id.includes(':[');
  for (const e of entries) {
    const k = isCell(e) ? (e.id.endsWith(':format') ? 'cell:format' : 'cell:text') : `other:${e.kind}`;
    const r = (kinds[k] ??= { n: 0, json: 0, id: 0, kind: 0, label: 0, value: 0, position: 0, punct: 0 });
    const json = Buffer.byteLength(JSON.stringify(e)) + 1; // + array comma
    r.n++;
    r.json += json;
    const fieldLen = (name, v) => Buffer.byteLength(JSON.stringify(name)) + 1 + Buffer.byteLength(JSON.stringify(v));
    r.id += fieldLen('id', e.id);
    r.kind += fieldLen('kind', e.kind);
    r.label += fieldLen('label', e.label);
    r.value += fieldLen('value', e.value);
    r.position += fieldLen('position', e.position);
    r.punct = r.json - r.id - r.kind - r.label - r.value - r.position;
  }
  console.log(JSON.stringify({ baselineBytes: total, baselineMs: Math.round(baselineMs), entries: entries.length }));
  for (const [k, r] of Object.entries(kinds))
    console.log(JSON.stringify({ kind: k, n: r.n, bytes: r.json, perEntry: +(r.json / r.n).toFixed(1), idField: +(r.id / r.n).toFixed(1), kindField: +(r.kind / r.n).toFixed(1), labelField: +(r.label / r.n).toFixed(1), valueField: +(r.value / r.n).toFixed(1), positionField: +(r.position / r.n).toFixed(1), punctuation: +(r.punct / r.n).toFixed(1) }));
  const cellText = entries.find((e) => isCell(e) && !e.id.endsWith(':format'));
  const cellFormat = entries.find((e) => isCell(e) && e.id.endsWith(':format'));
  console.log('sample text entry', JSON.stringify(cellText));
  console.log('sample format entry', JSON.stringify(cellFormat));
}
