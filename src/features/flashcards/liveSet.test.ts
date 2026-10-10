import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyTextChange, mapOffset } from '@/features/collaboration/yText';
import { addCard, cardFace, readCards, seedCards } from './liveSet';

function peers(): [Y.Doc, Y.Doc, () => void] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };
  return [a, b, sync];
}

it('converges when two writers add cards and type in the same face', () => {
  const [a, b, sync] = peers();
  seedCards(a, [{ back: 'b', front: 'Cell', id: 'c1' }]);
  sync();
  const fromA = addCard(a);
  const fromB = addCard(b);
  // Both appended after c1: same key, broken by id the same way everywhere.
  const faceA = cardFace(a, 'c1', 'front');
  const faceB = cardFace(b, 'c1', 'front');
  if (!(faceA && faceB)) throw new Error('missing face');
  applyTextChange(faceA, 'Cell wall');
  applyTextChange(faceB, 'The Cell');
  sync();
  expect(readCards(a)).toEqual(readCards(b));
  expect(readCards(a).map((card) => card.id)).toEqual([
    'c1',
    ...[fromA, fromB].sort(),
  ]);
  expect(readCards(a)[0]?.front).toBe('The Cell wall');
});

it('changes only what differs and keeps surrogate pairs whole', () => {
  const text = new Y.Doc().getText('t');
  text.insert(0, 'a😀b');
  const deltas: Y.YTextEvent['delta'][] = [];
  text.observe((event) => deltas.push(event.delta));
  applyTextChange(text, 'a😁b');
  expect(text.toString()).toBe('a😁b');
  expect(deltas[0]).toEqual([{ retain: 1 }, { delete: 2 }, { insert: '😁' }]);
});

it('carries a caret through a remote change', () => {
  expect(mapOffset(5, [{ retain: 2 }, { insert: 'xyz' }])).toBe(8);
  expect(mapOffset(5, [{ retain: 6 }, { insert: 'xyz' }])).toBe(5);
  expect(mapOffset(5, [{ retain: 1 }, { delete: 10 }])).toBe(1);
});
