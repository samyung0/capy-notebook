// Loads pairs of note states in Yjs, the browser's CRDT, from the repository's
// node_modules: each collected state must read as the state it was collected
// from (the content root projected as slate-yjs reads it), with nothing
// pending, before and after the rows stored after it are applied to each, as
// a load replays them. gc_views.rs writes the pairs and runs this.
// Usage: node gc_yjs_load.mjs <pairs.json> <repository root>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [file, root] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const Y = require('yjs');
const yjsDir = path.dirname(path.dirname(require.resolve('yjs')));
const { version } = JSON.parse(
  readFileSync(path.join(yjsDir, 'package.json'), 'utf8')
);

const sharedValue = (value) => {
  if (value instanceof Y.Text) {
    return value.toString();
  }
  if (value instanceof Y.Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, inner]) => [key, sharedValue(inner)])
    );
  }
  if (value instanceof Y.Array) {
    return value.toArray().map(sharedValue);
  }
  return value;
};

const sameMarks = (a, b) => {
  const marks = (leaf) =>
    Object.keys(leaf)
      .filter((key) => key !== 'text')
      .sort()
      .map((key) => [key, leaf[key]]);
  return JSON.stringify(marks(a)) === JSON.stringify(marks(b));
};

const children = (xmlText) => {
  const out = [];
  for (const op of xmlText.toDelta()) {
    if (typeof op.insert === 'string') {
      const leaf = { text: op.insert, ...(op.attributes ?? {}) };
      const last = out.at(-1);
      // slate-yjs merges equal neighbouring runs.
      if (last && 'text' in last && sameMarks(last, leaf)) {
        last.text += leaf.text;
      } else {
        out.push(leaf);
      }
    } else if (op.insert instanceof Y.XmlText) {
      const node = Object.fromEntries(
        Object.entries(op.insert.getAttributes()).map(([key, value]) => [
          key,
          sharedValue(value),
        ])
      );
      node.children = children(op.insert);
      out.push(node);
    } else {
      out.push({ embed: true });
    }
  }
  if (out.length === 0) {
    out.push({ text: '' });
  }
  return out;
};

const canonical = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
};

const read = (doc) => ({
  pending: doc.store.pendingStructs !== null || doc.store.pendingDs !== null,
  value: canonical(children(doc.get('content', Y.XmlText))),
});

// The state's reading, and its reading after `rows`.
const load = (base64, rows) => {
  const doc = new Y.Doc();
  doc.get('content', Y.XmlText);
  Y.applyUpdate(doc, Buffer.from(base64, 'base64'));
  const loaded = read(doc);
  for (const row of rows) {
    Y.applyUpdate(doc, Buffer.from(row, 'base64'));
  }
  return [loaded, read(doc)];
};

const { pairs } = JSON.parse(readFileSync(file, 'utf8'));
let differ = 0;
let pending = 0;
let withRows = 0;
for (const pair of pairs) {
  const before = load(pair.before, pair.later);
  const after = load(pair.after, pair.later);
  withRows += pair.later.length > 0 ? 1 : 0;
  if ([...before, ...after].some((reading) => reading.pending)) {
    pending += 1;
  }
  if (before.some((reading, k) => reading.value !== after[k].value)) {
    differ += 1;
  }
}
process.stdout.write(
  `yjs ${version}: ${pairs.length} pairs (${withRows} with later rows), ${pairs.length - differ} same, ${differ} differ, ${pending} pending\n`
);
if (differ > 0 || pending > 0 || withRows === 0) {
  process.exitCode = 1;
}
