import { readFileSync } from 'node:fs';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { beforeAll, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { MaterialValue } from '@/features/materials/document';
import { initSync } from './generated/late_merge.js';
import { hiddenDocument, holdsUnsent } from './lateMerge';
import { mergeRequest } from './lateMerge.worker';

/** The sample the native merge is held to (collaboration-rs late-merge
 * tests/sample.rs): a tab's document, the room's collected one, and the
 * merged update. */
const sample = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../../collaboration-rs/crates/late-merge/tests/fixtures/sample-${name}.bin`,
        import.meta.url
      )
    )
  );

// Node cannot fetch the packaged wasm URL; the bytes go to the glue the
// worker uses, whose init() is then a no-op.
beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL('./generated/late_merge_bg.wasm', import.meta.url)
    ),
  });
});

it('merges in the worker to exactly the bytes the native merge gives', async () => {
  const current = sample('current');
  const reply = await mergeRequest({
    current: current.slice().buffer,
    old: sample('old').slice().buffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  const merged = new Uint8Array(reply.merged);
  expect(merged).toEqual(sample('merged'));
  // And the same hidden text: the tab's typing in blocks the other session
  // deleted.
  expect(reply.hidden).toEqual(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../collaboration-rs/crates/late-merge/tests/fixtures/sample-hidden.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  );
  expect(reply.hidden.length).toBeGreaterThan(0);
  // Yjs takes the update whole: nothing waits for a unit it lacks.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, current);
  Y.applyUpdate(doc, merged);
  expect(doc.store.pendingStructs).toBeNull();
  expect(doc.store.pendingDs).toBeNull();
});

it('re-authors the same edits under the assigned id, all of them under it', async () => {
  const current = sample('current');
  const author = 4242;
  const reply = await mergeRequest({
    author,
    current: current.slice().buffer,
    old: sample('old').slice().buffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  const reauthored = new Uint8Array(reply.merged);
  const { structs } = Y.decodeUpdate(reauthored);
  expect(structs.length).toBeGreaterThan(0);
  expect(structs.every((struct) => struct.id.client === author)).toBe(true);
  // The text the merge under the tab's own ids gives.
  const read = (update: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, current);
    Y.applyUpdate(doc, update);
    expect(doc.store.pendingStructs).toBeNull();
    return doc.get('content', Y.XmlText).toString();
  };
  expect(read(reauthored)).toBe(read(sample('merged')));
});

it('answers what is not a Yjs document with the reason, not a throw', async () => {
  const reply = await mergeRequest({
    current: sample('current').slice().buffer,
    old: new Uint8Array([1, 2, 3]).buffer,
  });
  expect(reply).toEqual({
    error: expect.stringContaining('not a Yjs document'),
  });
});

it('needs no merge when the old document holds nothing the current one lacks', () => {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'abc');
  const same = Y.encodeStateAsUpdate(doc);
  expect(holdsUnsent(same, doc)).toBe(false);
  const tab = (edit: (text: Y.Text) => void) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, same);
    edit(copy.getText('t'));
    return Y.encodeStateAsUpdate(copy);
  };
  expect(
    holdsUnsent(
      tab((text) => text.insert(3, 'd')),
      doc
    )
  ).toBe(true);
  // A deletion alone is an edit to merge too.
  expect(
    holdsUnsent(
      tab((text) => text.delete(1, 1)),
      doc
    )
  ).toBe(true);
});

it('returns text typed into a block someone deleted, which the recovery document holds', async () => {
  const room = new Y.Doc();
  const value: MaterialValue = [
    { children: [{ text: 'abc' }], id: 'b1', type: 'p' },
    { children: [{ text: 'kept' }], id: 'b2', type: 'p' },
  ];
  room.get('content', Y.XmlText).applyDelta(slateNodesToInsertDelta(value));
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
  const block = (
    tab.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
  )[0].insert;
  block.insert(3, 'XY');
  // Another session deletes the block.
  room.get('content', Y.XmlText).delete(0, 1);
  const reply = await mergeRequest({
    current: Y.encodeStateAsUpdate(room).buffer as ArrayBuffer,
    old: Y.encodeStateAsUpdate(tab).buffer as ArrayBuffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  expect(reply.hidden).toEqual([
    { block: expect.any(Object), blockId: 'b1', text: 'XY' },
  ]);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, hiddenDocument(reply.hidden));
  expect(yTextToSlateElement(kept.get('content', Y.XmlText)).children).toEqual([
    { children: [{ text: 'XY' }], id: 'b1', type: 'p' },
  ]);
});
