import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type MaterialValue,
  normalizeMaterialValue,
} from '@/features/materials/document';
import { NoteBlocks } from './liveNoteBlocks';

/* A live note View's value (live-items DESIGN.md 3): handed over from the
 * painted projection, then rebuilt block by block. */

const p = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});

/** A room holding `value`, a View's copy of it following through `blocks`,
 * and a way to send the room's changes to the copy. */
function setup(value: unknown[]) {
  const room = new Y.Doc();
  const roomRoot = room.get('content', Y.XmlText);
  roomRoot.applyDelta(slateNodesToInsertDelta(value as never));
  const doc = new Y.Doc();
  const root = doc.get('content', Y.XmlText);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const blocks = new NoteBlocks(root);
  let changed = 0;
  root.observeDeep((events) => {
    if (blocks.apply(events)) changed++;
  });
  const send = () =>
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
  const block = (index: number) =>
    (roomRoot.toDelta() as { insert: Y.XmlText }[])[index].insert;
  return { block, blocks, changed: () => changed, roomRoot, send };
}

it('hands over keeping every painted block the room holds unchanged', () => {
  const { blocks } = setup([
    p('a', 'one'),
    p('b', 'two, edited'),
    p('c', 'three'),
  ]);
  // The projection painted before the room's latest edit to block b.
  const painted = normalizeMaterialValue([
    p('a', 'one'),
    p('b', 'two'),
    p('c', 'three'),
  ] as MaterialValue);
  const value = blocks.handOver(painted);
  expect(value[0]).toBe(painted[0]);
  expect(value[1]).not.toBe(painted[1]);
  expect(value[1].children).toEqual([{ text: 'two, edited' }]);
  expect(value[2]).toBe(painted[2]);
});

it('rebuilds only the block a remote keystroke touched', () => {
  const { block, blocks, send } = setup([
    p('a', 'one'),
    p('b', 'two'),
    p('c', 'three'),
  ]);
  const before = blocks.handOver([]);
  block(1).insert(3, 'x');
  send();
  expect(blocks.value[0]).toBe(before[0]);
  expect(blocks.value[1].children).toEqual([{ text: 'twox' }]);
  expect(blocks.value[2]).toBe(before[2]);
});

it('keeps the other blocks when one is inserted or removed', () => {
  const { blocks, roomRoot, send } = setup([p('a', 'one'), p('b', 'two')]);
  const before = blocks.handOver([]);
  roomRoot.applyDelta(slateNodesToInsertDelta([p('z', 'new')] as never));
  send();
  expect(blocks.value.map((node) => node.id)).toEqual(['z', 'a', 'b']);
  expect(blocks.value[1]).toBe(before[0]);
  expect(blocks.value[2]).toBe(before[1]);
  roomRoot.delete(1, 1);
  send();
  expect(blocks.value.map((node) => node.id)).toEqual(['z', 'b']);
  expect(blocks.value[1]).toBe(before[1]);
});

it('reads a Mermaid source typed in as its string and leaves comment marks out', () => {
  const { block, blocks, changed, send } = setup([
    {
      children: [{ children: [{ text: '' }], type: 'mermaid_caption' }],
      id: 'd1',
      source: 'graph TD',
      type: 'mermaid',
    },
    p('b', 'remark'),
  ]);
  blocks.handOver([]);
  (block(0).getAttribute('source') as unknown as Y.Text).insert(
    8,
    '\n  A --> B'
  );
  block(1).format(0, 3, { comment_t1: true });
  send();
  // One update: one new value.
  expect(changed()).toBe(1);
  expect((blocks.value[0] as { source?: unknown }).source).toBe(
    'graph TD\n  A --> B'
  );
  expect(blocks.value[1].children).toEqual([{ text: 'rem' }, { text: 'ark' }]);
});
