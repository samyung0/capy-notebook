import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import type {
  BoardBox,
  BoardPresenceView,
  BoardTextPoint,
} from '@/features/blocksuite/drawingBoard';
import { presenceClients } from '@/features/collaboration/presence';
import { bytesToBase64 } from '@/lib/base64';
import {
  type BoardPresence,
  encodeCaret,
  mergeBoxes,
  placeOutline,
  placeText,
  placeUploads,
  readBoardPeer,
  readBoardPresence,
  resolveCaret,
  sendBoardPresence,
  uploadBox,
  uploadId,
} from './boardPresence';

afterEach(() => vi.useRealTimers());

// The page's observer of the board element's attributes: what it calls is kept
// on the element it watches, for `board().editor` to call.
vi.stubGlobal(
  'MutationObserver',
  class {
    private readonly changed: () => void;
    constructor(changed: () => void) {
      this.changed = changed;
    }
    observe(target: { attributesChanged?: () => void }) {
      target.attributesChanged = this.changed;
    }
    disconnect() {}
  }
);

const ids = (count: number) =>
  JSON.stringify({ b: Array.from({ length: count }, () => 'a') });
const id = (units: number) => JSON.stringify({ b: ['é'.repeat(units)] });
const uploads = (count: number, units: number) =>
  JSON.stringify({
    uploads: Array.from({ length: count }, () => 'u'.repeat(units)),
  });

/** The canvas contract's vector list (section 6), the same one the
 * collaboration server holds (presence.rs tests): a state either both drop or
 * both read. */
describe("a board's presence field list", () => {
  const read = (state: string) =>
    readBoardPresence(JSON.parse(state) as unknown) !== null;

  it('reads a state holding only listed fields within bounds', () => {
    for (const state of [
      '{}',
      '{"p":null}',
      '{"p":[0,-1000000000]}',
      '{"b":[]}',
      ids(16),
      id(64),
      '{"s":"AA==","f":"AA=="}',
      // A note's uploads, shape and bounds.
      '{"uploads":[]}',
      '{"uploads":["abc"]}',
      uploads(1, 32),
      uploads(100, 1),
    ])
      expect(read(state), state).toBe(true);
  });

  it('drops a state with an unlisted field or a value out of bounds', () => {
    for (const state of [
      '{"p":[0.5,0]}',
      '{"p":[1000000001,0]}',
      '{"p":["b1",0,0]}',
      '{"p":[0]}',
      ids(17),
      id(65),
      '{"b":[["a","b"]]}',
      '{"s":"not base64!"}',
      uploads(1, 33),
      uploads(101, 1),
      '{"uploads":"abc"}',
      '{"uploads":[1]}',
      '{"selectionV2":[]}',
      '{"user":{"name":"x"}}',
      '[]',
    ])
      expect(read(state), state).toBe(false);
  });
});

/** A board with one note's paragraph on it, as presence reads it, and this
 * tab's awareness in its room. The board is at 200%, its origin 100 px into
 * the page. */
function board() {
  const doc = new Y.Doc();
  const text = new Y.Text('Cells divide');
  doc.getMap('blocks').set('p1', new Y.Map([['prop:text', text]]));
  const page = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(),
    hidden: false,
  });
  let editing = false;
  const host = Object.assign(new EventTarget(), {
    attributesChanged: () => {},
    hasAttribute: () => editing,
    ownerDocument: page,
  });
  /** A card's editor opens over the board, or closes. */
  const editor = (open: boolean) => {
    editing = open;
    host.attributesChanged();
  };
  const shown = {
    caret: null as ReturnType<BoardPresenceView['caret']>,
    selected: [] as string[],
    uploads: [] as BoardBox[],
  };
  const heard = { selection: () => {}, uploads: () => {}, view: () => {} };
  const view: BoardPresenceView = {
    boxOf: (elements) =>
      elements.includes('shape1') ? { h: 40, w: 80, x: 10, y: 20 } : null,
    caret: () => shown.caret,
    host: host as unknown as HTMLElement,
    onSelection: (listener) => {
      heard.selection = listener;
      return () => {};
    },
    onUploads: (listener) => {
      heard.uploads = listener;
      return () => {};
    },
    onView: (listener) => {
      heard.view = listener;
      return () => {};
    },
    selected: () => shown.selected,
    // A line of text 20 units tall, a unit a character.
    textBoxes: (focus, anchor) => ({
      caret: { h: 20, w: 0, x: focus.index, y: 0 },
      range: anchor
        ? [
            {
              h: 20,
              w: Math.abs(focus.index - anchor.index),
              x: Math.min(focus.index, anchor.index),
              y: 0,
            },
          ]
        : [],
    }),
    toBoard: (x, y) => [(x - 100) / 2, (y - 100) / 2],
    uploads: () => shown.uploads,
    view: () => ({ left: 100, top: 100, width: 800, zoom: 2 }),
  };
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const move = (x: number, y: number, pointerType = 'mouse') =>
    host.dispatchEvent(
      Object.assign(new Event('pointermove'), {
        clientX: x,
        clientY: y,
        pointerType,
      })
    );
  const select = (elements: string[], caret: typeof shown.caret = null) => {
    Object.assign(shown, { caret, selected: elements });
    heard.selection();
  };
  const at = (index: number): BoardTextPoint => ({ index, text });
  const state = () => awareness.getLocalState() as BoardPresence | null;
  /** This tab's images going up, or none (also as the board locks). */
  const upload = (boxes: BoardBox[]) => {
    shown.uploads = boxes;
    heard.uploads();
  };
  return {
    at,
    awareness,
    doc,
    editor,
    heard,
    host,
    move,
    select,
    state,
    text,
    upload,
    view,
  };
}

it('sends the pointer in whole board units, at most every 50 ms, and null once it leaves', () => {
  vi.useFakeTimers();
  const { awareness, heard, host, move, state, view } = board();
  let sent = 0;
  awareness.on('update', () => {
    sent += 1;
  });
  const stop = sendBoardPresence(view, awareness);
  vi.advanceTimersByTime(50);
  move(301, 140);
  expect(state()).toEqual({ p: [101, 20] });
  // A burst within the window goes once, ending on the latest place.
  const before = sent;
  for (let x = 302; x <= 340; x += 2) move(x, 140);
  expect(sent).toBe(before);
  vi.advanceTimersByTime(50);
  expect(state()).toEqual({ p: [120, 20] });
  expect(sent).toBe(before + 1);
  // A touch is no pointer.
  move(700, 700, 'touch');
  vi.advanceTimersByTime(50);
  expect(state()).toEqual({ p: [120, 20] });
  // The board panned under the still pointer.
  view.toBoard = (x, y) => [x - 100, y - 100];
  heard.view();
  vi.advanceTimersByTime(50);
  expect(state()).toEqual({ p: [240, 40] });
  host.dispatchEvent(new Event('pointerleave'));
  vi.advanceTimersByTime(50);
  expect(state()).toEqual({ p: null });
  stop();
  expect(state()).toBeNull();
});

it("withdraws the pointer as a card's editor opens over it, and sends it again as it closes", () => {
  vi.useFakeTimers();
  const { awareness, editor, move, state, view } = board();
  sendBoardPresence(view, awareness);
  vi.advanceTimersByTime(50);
  move(301, 140);
  expect(state()).toEqual({ p: [101, 20] });
  vi.advanceTimersByTime(50);
  // No pointer move follows either.
  editor(true);
  expect(state()).toEqual({ p: null });
  vi.advanceTimersByTime(50);
  editor(false);
  expect(state()).toEqual({ p: [101, 20] });
});

it('sends the selected elements, and a caret as soon as it is placed', () => {
  vi.useFakeTimers();
  const { at, awareness, doc, select, state, view } = board();
  sendBoardPresence(view, awareness);
  vi.advanceTimersByTime(50);
  // A shape selected for editing its text has no caret: its id alone.
  select(['shape1']);
  expect(state()).toEqual({ b: ['shape1'], p: null });
  vi.advanceTimersByTime(50);
  // A click into a note's text, nothing typed.
  select(['note1'], { anchor: at(5), focus: at(5) });
  const placed = state();
  expect(placed?.b).toEqual(['note1']);
  expect(placed?.f).toBeUndefined();
  expect(resolveCaret(doc, placed?.s ?? '')).toMatchObject({ index: 5 });
  vi.advanceTimersByTime(50);
  // A range dragged backwards: the caret is at its focus.
  select(['note1'], { anchor: at(12), focus: at(6) });
  const ranged = state();
  expect(resolveCaret(doc, ranged?.s ?? '')).toMatchObject({ index: 12 });
  expect(resolveCaret(doc, ranged?.f ?? '')).toMatchObject({ index: 6 });
  expect(readBoardPresence(ranged)).not.toBeNull();
  vi.advanceTimersByTime(50);
  // More than 16 elements send none, as a note's runs.
  select(Array.from({ length: 17 }, (_, n) => `e${n}`));
  expect(state()).toEqual({ p: null });
});

it('draws a peer the room names: an outline, and a caret and range in text', () => {
  const { at, awareness, doc, text, view } = board();
  const peer = new Awareness(new Y.Doc());
  const relay = (state: BoardPresence) => {
    peer.setLocalState(state);
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(peer, [peer.clientID]),
      'server'
    );
  };
  const named = presenceClients([
    { avatar: null, clients: [peer.clientID], name: 'Ben', person: 11 },
  ]);
  relay({ b: ['shape1'], f: encodeCaret(at(9)), s: encodeCaret(at(6)) });
  // A client the room has not listed yet is not drawn.
  expect(readBoardPeer(awareness, new Map(), peer.clientID)).toBeUndefined();
  const ben = readBoardPeer(awareness, named, peer.clientID);
  if (!ben) throw new Error('no peer');
  expect(ben).toMatchObject({ color: 3, name: 'Ben' });
  expect(placeOutline(view, 7, ben)).toEqual({
    color: 3,
    h: 40,
    key: '7:b',
    kind: 'outline',
    name: 'Ben',
    w: 80,
    x: 10,
    y: 20,
  });
  expect(placeText(view, doc, 7, ben)).toEqual([
    expect.objectContaining({ h: 20, key: '7:r0', kind: 'range', w: 3, x: 6 }),
    expect.objectContaining({ key: '7:c', kind: 'caret', x: 9 }),
  ]);
  // Text typed before the caret moves it: the position is relative.
  text.insert(0, '> ');
  expect(placeText(view, doc, 7, ben).at(-1)).toMatchObject({ x: 11 });
});

it('skips a caret naming a root type, and makes none for it', () => {
  const { doc } = board();
  const crafted = bytesToBase64(
    Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(new Y.Doc().getText('made'), 0)
    )
  );
  expect(resolveCaret(doc, crafted)).toBeNull();
  expect([...doc.share.keys()]).toEqual(['blocks']);
});

it('tints a line once, however many boxes the page gives for it, and keeps lines apart', () => {
  const box = (x: number, y: number, w: number, h = 20): BoardBox => ({
    h,
    w,
    x,
    y,
  });
  expect(
    mergeBoxes([
      // One line in two pieces of text and the span around them.
      box(40, 0, 30),
      box(70, 0, 50),
      box(40, 0, 80),
      // The next line, brushing the first by two units.
      box(0, 18, 60),
    ])
  ).toEqual([box(40, 0, 80), box(0, 18, 60)]);
});

it('sends the images going up, each named by its box, and none from a locked board', () => {
  vi.useFakeTimers();
  const { state, upload, view, awareness } = board();
  const stop = sendBoardPresence(view, awareness);
  vi.advanceTimersByTime(50);
  const box = { h: 300.4, w: 400, x: -1_000_000_000, y: 20.6 };
  upload([box]);
  vi.advanceTimersByTime(50);
  const sent = state()?.uploads ?? [];
  expect(sent).toHaveLength(1);
  expect(sent[0].length).toBeLessThanOrEqual(32);
  expect(uploadBox(sent[0])).toEqual({ h: 300, w: 400, x: -1e9, y: 21 });
  // Landed, refused, or the board locked (a read channel takes no uploads):
  // the field goes.
  upload([]);
  vi.advanceTimersByTime(50);
  expect(state()).not.toHaveProperty('uploads');
  stop();
});

it("draws a peer's uploads where they will land, and nothing for an id naming no box", () => {
  const id = uploadId({ h: 30, w: 40, x: 10, y: -20 }) as string;
  const marks = placeUploads(7, {
    color: 2,
    name: 'Ana',
    presence: { uploads: [id, 'abc', '1,2,0,4'] },
  });
  expect(marks).toEqual([
    {
      color: 2,
      h: 30,
      key: `7:u${id}`,
      kind: 'upload',
      name: 'Ana',
      w: 40,
      x: 10,
      y: -20,
    },
  ]);
});
