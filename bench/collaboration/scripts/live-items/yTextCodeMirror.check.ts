/* Checks the CodeMirror <-> Y.Text prototype without a DOM: random local
 * multi-range edits on two peers, synced through Yjs, both editors and both
 * texts equal afterwards. node_modules/.bin/tsx <this file> */
import { EditorState } from '@codemirror/state';
import { Y } from './load';
import { applyChanges, deltaChanges } from './yTextCodeMirror';

let seed = 7;
const random = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const docs = [new Y.Doc(), new Y.Doc()];
const texts = docs.map((doc) => doc.getText('source'));
texts[0].insert(0, 'flowchart TD\n  A --> B\n');
Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
const states = texts.map((text) => EditorState.create({ doc: text.toString() }));
texts.forEach((text, i) =>
  text.observe((event, tr) => {
    if (tr.origin === `cm${i}`) return;
    states[i] = states[i].update({ changes: deltaChanges(event.delta) }).state;
  })
);
for (let round = 0; round < 300; round++) {
  // Both peers edit before syncing (concurrent), one or two ranges each.
  for (const i of [0, 1]) {
    const length = states[i].doc.length;
    const from = random(length + 1);
    const ranges =
      random(2) === 0
        ? [{ from, insert: 'xyz'.slice(0, 1 + random(3)), to: Math.min(length, from + random(3)) }]
        : [
            { from: 0, insert: '%' },
            { from: length, insert: '\n' },
          ];
    const tr = states[i].update({ changes: ranges });
    applyChanges(texts[i], tr.changes, `cm${i}`);
    states[i] = tr.state;
  }
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0], Y.encodeStateVector(docs[1])));
  Y.applyUpdate(docs[0], Y.encodeStateAsUpdate(docs[1], Y.encodeStateVector(docs[0])));
}
const same =
  texts[0].toString() === texts[1].toString() &&
  states[0].doc.toString() === texts[0].toString() &&
  states[1].doc.toString() === texts[1].toString();
console.log(JSON.stringify({ chars: texts[0].length, converged: same, rounds: 300 }));
if (!same) process.exit(1);
