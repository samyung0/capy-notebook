import { createSlateEditor } from 'platejs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type BlockRun,
  blockRuns,
  MAX_PRESENCE_BYTES,
  readNotePresence,
  sendPointer,
  setNotePresence,
} from './notePresence';

afterEach(() => vi.useRealTimers());

const id = (n: number, length: number) => String(n).padStart(length, '0');
const runs = (count: number, length = 1) =>
  Array.from(
    { length: count },
    (_, n): BlockRun => [id(n, length), id(n, length)]
  );

/** The same list the collaboration server holds (presence.rs tests), so a
 * state either both drop or both read (Epo 2026-10-28). */
describe("a note's presence field list", () => {
  const read = (state: unknown) => readNotePresence(state) !== null;

  it('reads a state holding only listed fields within bounds', () => {
    expect(read({})).toBe(true);
    expect(read({ f: 'AQKS9tMIBwA=', s: 'AQKS9tMIAQA=' })).toBe(true);
    expect(read({ s: 'A'.repeat(64) })).toBe(true);
    expect(read({ p: null })).toBe(true);
    expect(read({ p: ['b1', 0, 1000] })).toBe(true);
    expect(read({ b: runs(16) })).toBe(true);
    expect(read({ uploads: Array.from({ length: 100 }, () => 'u') })).toBe(
      true
    );
  });

  it('drops a state with an unlisted field or a value out of bounds', () => {
    // Today's slate-yjs shape, with a colour every co-editor would draw.
    expect(
      read({ data: { color: 'url(https://example.com/x)' }, selection: null })
    ).toBe(false);
    expect(read({ s: 'A'.repeat(65) })).toBe(false);
    expect(read({ s: 'not base64!' })).toBe(false);
    expect(read({ p: ['b1', 1001, 0] })).toBe(false);
    expect(read({ p: ['b1', 0.5, 0] })).toBe(false);
    expect(read({ p: ['i'.repeat(65), 0, 0] })).toBe(false);
    expect(read({ b: runs(17) })).toBe(false);
    expect(read({ b: [['a']] })).toBe(false);
    expect(read({ uploads: ['u'.repeat(33)] })).toBe(false);
    expect(read({ uploads: Array.from({ length: 101 }, () => 'u') })).toBe(
      false
    );
    expect(read(null)).toBe(false);
    expect(read([])).toBe(false);
  });
});

describe('sending a note presence', () => {
  it('sends only when a field changed', () => {
    const awareness = new Awareness(new Y.Doc());
    const sent = vi.fn();
    awareness.on('update', sent);
    setNotePresence(awareness, { s: 'AA==' });
    setNotePresence(awareness, { s: 'AA==' });
    setNotePresence(awareness, { p: ['b1', 1, 2] });
    setNotePresence(awareness, { p: ['b1', 1, 2] });
    expect(sent).toHaveBeenCalledTimes(2);
    expect(awareness.getLocalState()).toMatchObject({
      p: ['b1', 1, 2],
      s: 'AA==',
    });
  });

  /** Q524 (Epo 2026-10-28): a state that would pass the room's 4 KiB cap
   * goes without its block selection runs, which go again once it fits. */
  it('leaves the block runs out of a state past 4 KiB', () => {
    const awareness = new Awareness(new Y.Doc());
    const size = () =>
      new TextEncoder().encode(JSON.stringify(awareness.getLocalState()))
        .length;
    const uploads = Array.from({ length: 100 }, (_, n) => id(n, 32));
    const selection = runs(16, 64);
    setNotePresence(awareness, {
      p: ['p'.repeat(64), 1000, 1000],
      s: 'A'.repeat(64),
      uploads,
    });
    setNotePresence(awareness, { b: selection });
    expect(awareness.getLocalState()).toMatchObject({ s: 'A'.repeat(64) });
    expect(awareness.getLocalState()?.b).toBeUndefined();
    expect(awareness.getLocalState()?.uploads).toHaveLength(100);
    expect(size()).toBeLessThanOrEqual(MAX_PRESENCE_BYTES);
    // The uploads end: the runs fit again.
    setNotePresence(awareness, { uploads: undefined });
    expect(awareness.getLocalState()?.b).toEqual(selection);
  });
});

describe('block selection runs', () => {
  const editor = createSlateEditor({
    value: [
      { children: [{ text: '1' }], id: 'p1', type: 'p' },
      { children: [{ text: '2' }], id: 'p2', type: 'p' },
      { children: [{ text: '3' }], id: 'p3', type: 'p' },
      {
        children: [{ children: [{ text: '4' }], id: 'c1', type: 'p' }],
        id: 'col',
        type: 'column',
      },
      { children: [{ text: '5' }], id: 'p5', type: 'p' },
    ],
  });

  it('folds selected blocks into runs of adjacent siblings in order', () => {
    expect(blockRuns(editor, new Set(['p5', 'p1', 'p2']))).toEqual([
      ['p1', 'p2'],
      ['p5', 'p5'],
    ]);
    expect(blockRuns(editor, new Set(['p3', 'col', 'p5']))).toEqual([
      ['p3', 'p5'],
    ]);
    // A nested block starts a run of its own.
    expect(blockRuns(editor, new Set(['col', 'c1']))).toEqual([
      ['col', 'col'],
      ['c1', 'c1'],
    ]);
    expect(blockRuns(editor, new Set())).toBeUndefined();
  });

  it('sends none past 16 runs', () => {
    const many = createSlateEditor({
      value: Array.from({ length: 34 }, (_, n) => ({
        children: [{ text: '' }],
        id: `b${n}`,
        type: 'p',
      })),
    });
    const every = (count: number) =>
      new Set(Array.from({ length: count }, (_, n) => `b${n * 2}`));
    expect(blockRuns(many, every(16))).toHaveLength(16);
    expect(blockRuns(many, every(17))).toBeUndefined();
  });
});

/** A block under the pointer: 200 × 100 at (100, 50). */
class Block extends EventTarget {
  dataset = { blockId: 'b1' };
  closest() {
    return this;
  }
  contains() {
    return true;
  }
  getBoundingClientRect() {
    return { height: 100, left: 100, top: 50, width: 200 };
  }
}

const pointerEvent = (type: string, x: number, y: number, kind = 'mouse') =>
  Object.assign(new Event(type), {
    clientX: x,
    clientY: y,
    pointerType: kind,
  });

it('sends the pointer as 0–1000 of its block, at most every 50 ms, and null once it leaves', () => {
  vi.useFakeTimers();
  const awareness = new Awareness(new Y.Doc());
  const root = new Block();
  const stop = sendPointer(root as unknown as HTMLElement, awareness);
  const pointer = () => awareness.getLocalState()?.p;
  root.dispatchEvent(pointerEvent('pointermove', 150, 75));
  expect(pointer()).toEqual(['b1', 250, 250]);
  root.dispatchEvent(pointerEvent('pointermove', 200, 100));
  root.dispatchEvent(pointerEvent('pointermove', 400, 200));
  expect(pointer()).toEqual(['b1', 250, 250]);
  vi.advanceTimersByTime(50);
  // The latest, clamped to the block's box.
  expect(pointer()).toEqual(['b1', 1000, 1000]);
  vi.advanceTimersByTime(100);
  root.dispatchEvent(pointerEvent('pointermove', 100, 50, 'touch'));
  expect(pointer()).toEqual(['b1', 1000, 1000]);
  root.dispatchEvent(pointerEvent('pointerleave', 0, 0));
  expect(pointer()).toBeNull();
  stop();
  root.dispatchEvent(pointerEvent('pointermove', 150, 75));
  expect(pointer()).toBeNull();
});
