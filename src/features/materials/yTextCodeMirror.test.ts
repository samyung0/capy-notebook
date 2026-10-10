import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyChanges, deltaChanges } from './yTextCodeMirror';

// Two peers' editors bound to one Mermaid source (live-items DESIGN.md 6.4),
// without a DOM: each round both make one or two concurrent multi-range
// edits, then sync through Yjs. Both editors and both texts end equal.
it('converges two editors bound to one source through concurrent edits', () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  const docs = [new Y.Doc(), new Y.Doc()];
  const texts = docs.map((doc) => doc.getText('source'));
  texts[0].insert(0, 'flowchart TD\n  A --> B\n');
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
  const states = texts.map((text) =>
    EditorState.create({ doc: text.toString() })
  );
  texts.forEach((text, i) => {
    text.observe((event, transaction) => {
      if (transaction.origin === `cm${i}`) return;
      states[i] = states[i].update({
        changes: deltaChanges(event.delta),
      }).state;
    });
  });
  for (let round = 0; round < 300; round++) {
    for (const i of [0, 1]) {
      const length = states[i].doc.length;
      const from = random(length + 1);
      const changes =
        random(2) === 0
          ? [
              {
                from,
                insert: 'xyz'.slice(0, 1 + random(3)),
                to: Math.min(length, from + random(3)),
              },
            ]
          : [
              { from: 0, insert: '%' },
              { from: length, insert: '\n' },
            ];
      const tr = states[i].update({ changes });
      applyChanges(texts[i], tr.changes, `cm${i}`);
      states[i] = tr.state;
    }
    Y.applyUpdate(
      docs[1],
      Y.encodeStateAsUpdate(docs[0], Y.encodeStateVector(docs[1]))
    );
    Y.applyUpdate(
      docs[0],
      Y.encodeStateAsUpdate(docs[1], Y.encodeStateVector(docs[0]))
    );
  }
  expect(texts[1].toString()).toBe(texts[0].toString());
  expect(states[0].doc.toString()).toBe(texts[0].toString());
  expect(states[1].doc.toString()).toBe(texts[0].toString());
  expect(texts[0].length).toBeGreaterThan(300);
});
