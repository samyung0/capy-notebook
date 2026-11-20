import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import * as Y from 'yjs';
import { initSync } from './lateMerge/generated/late_merge.js';
import { applyMerged } from './lateMerge/lateMerge';
import { mergeRequest } from './lateMerge/lateMerge.worker';
import {
  type EarlySession,
  earlyChain,
  mergeInputs,
  onRenamed,
  type RenameBase,
  renameClients,
  renamePosition,
  renameRefusal,
  renameUndo,
  withoutClients,
} from './renameClient';

/* A canvas's early edits renamed in place (Q38), against Yjs's own structs:
 * these fail when a Yjs upgrade moves what the rename rewrites. */

const ROOM = 1;
const PEER = 2;
/** An earlier tab's temporary id, then this tab's. */
const EARLIER = 1001;
const OWN = 1002;
const ASSIGNED = 5000;

function doc(client: number) {
  const made = new Y.Doc();
  made.clientID = client;
  return made;
}

/** A document's state vector. */
const stateOf = (d: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(d));

/** A board's shape: a surface block with its elements map, and a note
 * block's text. */
const elements = (d: Y.Doc) =>
  (d.getMap<Y.Map<unknown>>('blocks').get('surface') as Y.Map<unknown>).get(
    'elements'
  ) as Y.Map<Y.Map<unknown>>;
const note = (d: Y.Doc) =>
  (d.getMap<Y.Map<unknown>>('blocks').get('note') as Y.Map<unknown>).get(
    'text'
  ) as Y.Text;

/** A local edit, as BlockSuite makes one: under the document's id. */
const edit = (d: Y.Doc, change: () => void) => d.transact(change, d.clientID);

function stroke(d: Y.Doc, id: string, x = 0) {
  edit(d, () => {
    const made = new Y.Map<unknown>();
    made.set('type', 'brush');
    made.set('xywh', `[${x},0,10,10]`);
    made.set('points', [
      [x, 0],
      [x + 10, 10],
    ]);
    elements(d).set(id, made);
  });
}

/** The room's board, with a shape and a note, as a device copy holds it. */
function roomBoard() {
  const room = doc(ROOM);
  room.transact(() => {
    const surface = new Y.Map<unknown>();
    room.getMap('blocks').set('surface', surface);
    const shapes = new Y.Map<Y.Map<unknown>>();
    surface.set('elements', shapes);
    const square = new Y.Map<unknown>();
    square.set('type', 'shape');
    square.set('xywh', '[0,0,100,100]');
    shapes.set('square', square);
    const block = new Y.Map<unknown>();
    room.getMap('blocks').set('note', block);
    block.set('text', new Y.Text('Room'));
  });
  return room;
}

/** A board painted from the room's copy that an earlier tab and this one
 * edited before the join: strokes, a map value written twice, a deleted
 * stroke of its own, typing in a note, and edits next to the earlier tab's. */
function earlyBoard() {
  const room = roomBoard();
  const copy = Y.encodeStateAsUpdate(room);
  const earlier = doc(EARLIER);
  Y.applyUpdate(earlier, copy);
  stroke(earlier, 'one');
  edit(earlier, () => note(earlier).insert(4, ' early'));
  const board = doc(OWN);
  Y.applyUpdate(board, copy);
  const history = new Set(board.store.clients.keys());
  Y.applyUpdate(board, Y.encodeStateAsUpdate(earlier), 'restore');
  const base: RenameBase = { history, painted: stateOf(board) };
  const undo = new Y.UndoManager(board.getMap('blocks'), {
    trackedOrigins: new Set([OWN]),
  });
  onRenamed(board, (renamed, to) => renameUndo(undo, renamed, to));
  stroke(board, 'two', 20);
  undo.stopCapturing();
  stroke(board, 'gone', 40);
  edit(board, () => elements(board).delete('gone'));
  undo.stopCapturing();
  // Over the earlier tab's value, then over its own.
  edit(board, () => elements(board).get('one')?.set('xywh', '[5,5,10,10]'));
  edit(board, () => elements(board).get('one')?.set('xywh', '[6,6,10,10]'));
  edit(board, () => elements(board).get('square')?.set('xywh', '[1,1,9,9]'));
  // Typing after the earlier tab's text and inside its own.
  edit(board, () => note(board).insert(10, ' and own'));
  edit(board, () => note(board).insert(14, '!'));
  undo.stopCapturing();
  return { base, board, history, room, undo };
}

const json = (d: Y.Doc) => d.getMap('blocks').toJSON();
const clients = (d: Y.Doc) => [
  ...Y.decodeStateVector(Y.encodeStateVector(d)).keys(),
];
const items = (d: Y.Doc) =>
  [...d.store.clients.values()]
    .flat()
    .filter((struct): struct is Y.Item => struct instanceof Y.Item);

/** The ids items name (their origins, their redo) that are no struct the
 * document holds. */
function unresolved(d: Y.Doc) {
  const missing: Y.ID[] = [];
  for (const item of items(d))
    for (const id of [item.origin, item.rightOrigin, item.redone])
      if (id && Y.getState(d.store, id.client) <= id.clock) missing.push(id);
  return missing;
}

const PENDING = /pending/;

const rename = (board: Y.Doc, base: RenameBase) =>
  renameClients(board, [EARLIER, OWN], ASSIGNED, base);

it('keeps the document the same, each struct under the new id at its offset', () => {
  const { base, board } = earlyBoard();
  const before = json(board);
  const earlierEnd = Y.getState(board.store, EARLIER);
  const ownEnd = Y.getState(board.store, OWN);
  const renamed = rename(board, base);
  expect(renamed).toEqual(
    new Map([
      [EARLIER, 0],
      [OWN, earlierEnd],
    ])
  );
  expect(board.clientID).toBe(ASSIGNED);
  expect(clients(board).sort()).toEqual([ROOM, ASSIGNED]);
  expect(Y.getState(board.store, ASSIGNED)).toBe(earlierEnd + ownEnd);
  // Each struct names the client and clock it sits at.
  for (const [client, structs] of board.store.clients) {
    let clock = 0;
    for (const struct of structs) {
      expect(struct.id).toEqual(Y.createID(client, clock));
      clock += struct.length;
    }
  }
  expect(json(board)).toEqual(before);
  expect(unresolved(board)).toEqual([]);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(board));
  expect(fresh.store.pendingStructs).toBeNull();
  expect(json(fresh)).toEqual(before);
});

it('writes what comes after under the new id, next to the renamed edits', () => {
  const { base, board } = earlyBoard();
  rename(board, base);
  edit(board, () => note(board).insert(note(board).length, ' later'));
  stroke(board, 'after', 60);
  expect(clients(board).sort()).toEqual([ROOM, ASSIGNED]);
  expect(unresolved(board)).toEqual([]);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(board));
  expect(fresh.store.pendingStructs).toBeNull();
  expect(json(fresh)).toEqual(json(board));
  expect(note(fresh).toString()).toBe('Room early and! own later');
});

it("converges with the room's state, which another person changed meanwhile", () => {
  const { base, board, room } = earlyBoard();
  const peer = doc(PEER);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
  stroke(peer, 'theirs', 80);
  edit(peer, () => note(peer).insert(0, '> '));
  edit(peer, () => elements(peer).get('square')?.set('xywh', '[2,2,8,8]'));
  Y.applyUpdate(room, Y.encodeStateAsUpdate(peer));
  rename(board, base);
  // Another tab takes the renamed board, then each takes the room's state.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(board));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(room));
  Y.applyUpdate(other, Y.encodeStateAsUpdate(room));
  Y.applyUpdate(room, Y.encodeStateAsUpdate(board));
  expect(json(other)).toEqual(json(board));
  expect(json(room)).toEqual(json(board));
  expect(Object.keys(elements(room).toJSON()).sort()).toEqual([
    'one',
    'square',
    'theirs',
    'two',
  ]);
  expect(note(room).toString()).toBe('> Room early and! own');
  expect(room.store.pendingStructs).toBeNull();
  expect(clients(room).sort()).toEqual([ROOM, PEER, ASSIGNED]);
});

it('takes an offline stroke back on Undo after the rename, and Redo puts it back', () => {
  const { base, board, room, undo } = earlyBoard();
  rename(board, base);
  // The typing and the value writes.
  undo.undo();
  expect(note(board).toString()).toBe('Room early');
  expect(elements(board).get('one')?.get('xywh')).toBe('[0,0,10,10]');
  // The stroke drawn and erased changes nothing; the stroke before it goes.
  undo.undo();
  expect(elements(board).has('two')).toBe(false);
  expect(elements(board).has('one')).toBe(true);
  Y.applyUpdate(room, Y.encodeStateAsUpdate(board));
  expect(elements(room).has('two')).toBe(false);
  undo.redo();
  expect(elements(board).has('two')).toBe(true);
  expect(unresolved(board)).toEqual([]);
});

it("follows an Undo's redo copy made before the rename", () => {
  const board = doc(OWN);
  const text = board.getText('t');
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([OWN]) });
  onRenamed(board, (renamed, to) => renameUndo(undo, renamed, to));
  edit(board, () => text.insert(0, 'abc'));
  undo.stopCapturing();
  edit(board, () => text.delete(0, 3));
  undo.stopCapturing();
  // The delete undone: a copy of the text, its original naming it `redone`.
  undo.undo();
  expect(text.toString()).toBe('abc');
  expect(items(board).some((item) => item.redone)).toBe(true);
  renameClients(board, [OWN], ASSIGNED, {
    history: new Set(),
    painted: new Map(),
  });
  expect(unresolved(board)).toEqual([]);
  undo.redo();
  expect(text.toString()).toBe('');
  undo.undo();
  expect(text.toString()).toBe('abc');
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(board));
  expect(fresh.getText('t').toString()).toBe('abc');
});

it('refuses a rename that would not be sound', () => {
  const { base, board } = earlyBoard();
  expect(renameRefusal(board, [EARLIER, OWN], ROOM, base)).toBe(
    'the new client id is in the document'
  );
  expect(renameRefusal(board, [ROOM, OWN], ASSIGNED, base)).toBe(
    "a temporary client id is in the room's history"
  );
  // An update whose base the document lacks waits pending.
  const peer = doc(PEER);
  edit(peer, () => peer.getText('elsewhere').insert(0, 'a'));
  const known = Y.encodeStateVector(peer);
  edit(peer, () => peer.getText('elsewhere').insert(1, 'b'));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(peer, known));
  expect(renameRefusal(board, [EARLIER, OWN], ASSIGNED, base)).toBe(
    'the document holds pending updates'
  );
  expect(() => rename(board, base)).toThrow(PENDING);
});

// Review M2, the join's check: an edit the early sessions never saw (here a
// peer's, as the room's state before the rename would bring it) may have had
// a conflict settled against a temporary id.
it('refuses a rename once the document holds edits made after it painted', () => {
  const { base, board, room } = earlyBoard();
  expect(renameRefusal(board, [EARLIER, OWN], ASSIGNED, base)).toBeNull();
  const peer = doc(PEER);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
  edit(peer, () => elements(peer).get('square')?.set('xywh', '[3,3,9,9]'));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(peer));
  expect(renameRefusal(board, [EARLIER, OWN], ASSIGNED, base)).toBe(
    'the document holds edits its early sessions never saw'
  );
});

/** Three reloads before the join (review M1): S0 draws and types, S1 paints
 * S0's rows and edits after its edits, S2 paints both. Answers S2's board,
 * what it painted, and the two earlier sessions as their rows say. */
function reloadedTwice() {
  const room = roomBoard();
  const copy = Y.encodeStateAsUpdate(room);
  const zero = doc(3000);
  Y.applyUpdate(zero, copy);
  const zeroPainted = stateOf(zero);
  stroke(zero, 'one');
  edit(zero, () => note(zero).insert(4, ' zero'));
  const one = doc(2000);
  Y.applyUpdate(one, copy);
  Y.applyUpdate(one, Y.encodeStateAsUpdate(zero));
  const onePainted = stateOf(one);
  edit(one, () => elements(one).get('one')?.set('xywh', '[5,5,10,10]'));
  edit(one, () => note(one).insert(9, ' one'));
  const board = doc(4000);
  Y.applyUpdate(board, copy);
  const history = new Set(board.store.clients.keys());
  Y.applyUpdate(board, Y.encodeStateAsUpdate(zero));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(one));
  const painted = stateOf(board);
  edit(board, () => note(board).insert(13, ' two'));
  const sessions: EarlySession[] = [
    { client: 3000, earlier: [], state: zeroPainted },
    { client: 2000, earlier: [3000], state: onePainted },
  ];
  return { board, history, painted, sessions };
}

it("orders earlier tabs' ids by what each painted, whatever order their rows come in", () => {
  const { board, history, painted, sessions } = reloadedTwice();
  // Rows come sorted by session uuid: here S1's first.
  const { chain, offending } = earlyChain(painted, [...sessions].reverse());
  expect(chain).toEqual([3000, 2000]);
  expect(offending).toEqual([]);
  const shown = json(board);
  renameClients(board, [...chain, 4000], ASSIGNED, { history, painted });
  // Anyone takes the renamed state: no origin names a clock ahead of it.
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(board));
  expect(fresh.store.pendingStructs).toBeNull();
  expect(json(fresh)).toEqual(shown);
  expect(note(fresh).toString()).toBe('Room zero one two');
});

// Review M2, at the open: the rename may take only a chain of sessions, each
// after everything else the board paints.
it('leaves out of the chain a session that edited beside another, or beside what it never painted, and every one after it', () => {
  const { painted, sessions } = reloadedTwice();
  const [zero, one] = sessions;
  // Two tabs early at once: neither painted the other.
  const beside = { client: 5000, earlier: [], state: zero.state };
  const twoTabs = new Map([
    ...zero.state,
    [3000, painted.get(3000) ?? 0],
    [5000, 3],
  ]);
  const both = earlyChain(twoTabs, [zero, beside]);
  expect(both.chain).toEqual([3000]);
  expect(both.offending).toEqual([5000]);
  // The copy (or an assigned id's rows) holds an edit S0 never painted: S0
  // and S1, which painted it, both go.
  const newer = new Map([...painted, [ROOM, (painted.get(ROOM) ?? 0) + 1]]);
  expect(earlyChain(newer, sessions)).toEqual({
    chain: [],
    offending: [3000, 2000],
  });
  // A row that says nothing of what it painted follows nothing.
  expect(
    earlyChain(painted, [zero, { ...one, state: new Map() }]).offending
  ).toEqual([2000]);
  // A temporary id no rows are under (S0's, its rows gone) is not taken.
  expect(earlyChain(painted, [one]).offending.sort()).toEqual([2000, 3000]);
});

it("holds everything but the named clients' structs and deletions without them", () => {
  const board = doc(OWN);
  Y.applyUpdate(board, Y.encodeStateAsUpdate(roomBoard()));
  stroke(board, 'kept');
  const peer = doc(PEER);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(board));
  stroke(peer, 'theirs', 20);
  stroke(peer, 'erased', 40);
  edit(peer, () => elements(peer).delete('erased'));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(peer));
  const rest = withoutClients(board, [PEER]);
  if (!rest) throw new Error('nothing left');
  expect(rest.store.pendingDs).toBeNull();
  expect(rest.store.pendingStructs).toBeNull();
  expect(Object.keys(elements(rest).toJSON()).sort()).toEqual([
    'kept',
    'square',
  ]);
  expect(clients(rest).sort()).toEqual([ROOM, OWN]);
  // What another client placed against theirs cannot stand without them.
  edit(board, () => elements(board).get('theirs')?.set('xywh', '[1,1,1,1]'));
  expect(withoutClients(board, [PEER])).toBeNull();
});

// Review m2: a text editor keeps its caret as positions naming the text's
// items; renamed, a peer's typing ahead of it moves it as it should.
it("follows a kept caret's ids, so it resolves after the rename", () => {
  const { base, board, room } = earlyBoard();
  const text = note(board);
  // After "Room early" (the earlier tab's typing).
  const caret = Y.createRelativePositionFromTypeIndex(text, 10);
  const renamed = rename(board, base);
  renamePosition(caret, renamed, ASSIGNED);
  const peer = doc(PEER);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
  edit(peer, () => note(peer).insert(0, '> '));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(peer));
  expect(
    Y.createAbsolutePositionFromRelativePosition(caret, board)?.index
  ).toBe(12);
});

/* The merge at the open (review M2, re-check R1) as `ItemRoom.paintEarly`
 * runs it, with the late merge's WASM: sessions that edited beside one
 * another, or beside a newer copy, are written anew under this tab's id, and
 * the rename then changes no outcome. A key both set keeps Yjs's pick. */

beforeAll(() => {
  // Node cannot fetch the packaged wasm URL; the glue takes the bytes.
  initSync({
    module: readFileSync(
      new URL('./lateMerge/generated/late_merge_bg.wasm', import.meta.url)
    ),
  });
});

/** A copy with a square and a text. */
function copyRoom() {
  const room = doc(ROOM);
  room.transact(() => {
    const square = new Y.Map<unknown>();
    square.set('xywh', '[0]');
    room.getMap('blocks').set('square', square);
    room.getMap('blocks').set('text', new Y.Text('ab'));
  });
  return room;
}
const square = (d: Y.Doc) => d.getMap('blocks').get('square') as Y.Map<unknown>;
const text = (d: Y.Doc) => d.getMap('blocks').get('text') as Y.Text;

/** A session painted from `painted` (a copy, then the rows of the temporary
 * ids `earlier`) that set the square (each of `values` in turn) and typed
 * `letter` at one place; its late rows. */
function earlySession(
  client: number,
  painted: Uint8Array[],
  values: string[],
  letter: string,
  earlier: number[] = []
) {
  const tab = doc(client);
  for (const update of painted) Y.applyUpdate(tab, update);
  const state = stateOf(tab);
  for (const value of values) edit(tab, () => square(tab).set('xywh', value));
  edit(tab, () => text(tab).insert(1, letter));
  return {
    session: { client, earlier, state } satisfies EarlySession,
    update: Y.encodeStateAsUpdate(tab),
  };
}

/** Paints `sessions` over `copy` as this tab (`OPEN`), merging the offending
 * ones anew, then renames the rest to `to`: the board as painted and after,
 * and Yjs's pick for the square (the copy and every row together). */
async function paintAndRename(
  copy: Uint8Array,
  sessions: ReturnType<typeof earlySession>[],
  to: number
) {
  const board = doc(OPEN);
  Y.applyUpdate(board, copy);
  const history = new Set(board.store.clients.keys());
  const update = Y.mergeUpdates(sessions.map(({ update }) => update));
  const all = stateOf(board);
  for (const [client, clock] of Y.parseUpdateMeta(update).to)
    all.set(client, Math.max(clock, all.get(client) ?? 0));
  const { chain, offending } = earlyChain(
    all,
    sessions.map(({ session }) => session)
  );
  if (!offending.length) throw new Error('nothing to write anew');
  const scratch = doc(OPEN);
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(board));
  Y.applyUpdate(scratch, update);
  const before = Y.encodeStateAsUpdate(scratch);
  const pick = square(scratch).get('xywh');
  const inputs = mergeInputs(scratch, offending);
  if (!inputs) throw new Error('the rest depends on them');
  // `all` itself is left as it was.
  const untouched = Y.encodeStateAsUpdate(scratch).join() === before.join();
  const reply = await mergeRequest({
    author: board.clientID,
    current: Y.encodeStateAsUpdate(inputs.rest).slice().buffer,
    old: inputs.old.slice().buffer,
  });
  if ('error' in reply) throw new Error(reply.error);
  Y.applyUpdate(board, Y.encodeStateAsUpdate(inputs.rest), 'restore');
  applyMerged(board, new Uint8Array(reply.merged), 'restore', true);
  const painted = board.getMap('blocks').toJSON();
  const base = { history, painted: stateOf(board) };
  renameClients(board, [...chain, OPEN], to, base);
  return { board, chain, offending, painted, pick, untouched };
}
const OPEN = 9999;

/** The room and the board once each took the other's state; how often the
 * room holds each early letter, and its square. */
function afterJoin(room: Y.Doc, board: Y.Doc) {
  Y.applyUpdate(room, Y.encodeStateAsUpdate(board));
  Y.applyUpdate(board, Y.encodeStateAsUpdate(room));
  const typed = [...text(room).toString()];
  return {
    board: json(board),
    letters: ['E', 'O'].map(
      (letter) => typed.filter((each) => each === letter).length
    ),
    room: json(room),
    square: square(room).get('xywh'),
  };
}

// Yjs's pick: at one origin, the higher client id's write.
for (const [early, other, to, picked] of [
  [2000, 3000, 4000, '[B]'],
  [3000, 2000, 1000, '[A]'],
  [2000, 3000, 2500, '[B]'],
] as const)
  it(`writes anew one of two tabs early at once (ids ${early}, ${other}, then ${to}), the square at the value Yjs picked`, async () => {
    const room = copyRoom();
    const copy = Y.encodeStateAsUpdate(room);
    const one = earlySession(early, [copy], ['[A]'], 'E');
    const two = earlySession(other, [copy], ['[B0]', '[B]'], 'O');
    const { board, painted, pick, untouched } = await paintAndRename(
      copy,
      [one, two],
      to
    );
    expect(untouched).toBe(true);
    expect(json(board)).toEqual(painted);
    const after = afterJoin(room, board);
    expect(after.room).toEqual(after.board);
    expect(after.letters).toEqual([1, 1]);
    expect(pick).toBe(picked);
    expect(after.square).toBe(picked);
  });

for (const [early, other, to, picked] of [
  [2000, 3000, 4000, '[other]'],
  [3000, 2000, 1000, '[early]'],
  [2000, 3000, 2500, '[other]'],
] as const)
  it(`writes anew a session that painted an older copy (ids ${early}, ${other}, then ${to}), the room's edit there once`, async () => {
    const room = copyRoom();
    const older = Y.encodeStateAsUpdate(room);
    const tab = earlySession(early, [older], ['[early0]', '[early]'], 'E');
    const joined = doc(other);
    Y.applyUpdate(joined, older);
    edit(joined, () => square(joined).set('xywh', '[other]'));
    edit(joined, () => text(joined).insert(1, 'O'));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(joined));
    const { board, painted, pick, untouched } = await paintAndRename(
      Y.encodeStateAsUpdate(room),
      [tab],
      to
    );
    expect(untouched).toBe(true);
    expect(json(board)).toEqual(painted);
    const after = afterJoin(room, board);
    expect(after.room).toEqual(after.board);
    expect(after.letters).toEqual([1, 1]);
    expect(pick).toBe(picked);
    expect(after.square).toBe(picked);
  });

/* Two offending sessions whose first writes of the square followed different
 * values (re-check 2, R3): one painted the older copy, the other the room's
 * newer write. Every order of the three ids. */
const ORDERS = [
  [2000, 3000, 4000],
  [2000, 4000, 3000],
  [3000, 2000, 4000],
  [3000, 4000, 2000],
  [4000, 2000, 3000],
  [4000, 3000, 2000],
];

/** The room after `writer` moved the square on `older` and kept the copy. */
function movedBy(room: Y.Doc, older: Uint8Array, writer: number) {
  const joined = doc(writer);
  Y.applyUpdate(joined, older);
  edit(joined, () => square(joined).set('xywh', '[R]'));
  Y.applyUpdate(room, Y.encodeStateAsUpdate(joined));
  return Y.encodeStateAsUpdate(room);
}

for (const [joined, first, second] of ORDERS)
  it(`keeps Yjs's pick when a tab painted another's rows over a newer copy (joined ${joined}, then ${first}, ${second})`, async () => {
    // A joined tab stays open; F1 opens early from the copy and moves the
    // square; the joined tab moves it and keeps the copy; F2 opens early
    // from that copy and F1's rows and moves it again.
    const room = copyRoom();
    const older = Y.encodeStateAsUpdate(room);
    const one = earlySession(first, [older], ['[F1]'], 'E');
    const newer = movedBy(room, older, joined);
    const two = earlySession(second, [newer, one.update], ['[F2]'], 'O', [
      first,
    ]);
    const out = await paintAndRename(newer, [one, two], 7000);
    expect(new Set(out.offending)).toEqual(new Set([first, second]));
    expect(out.pick).toBe('[F2]');
    expect(out.painted.square).toEqual({ xywh: '[F2]' });
    expect(json(out.board)).toEqual(out.painted);
    const after = afterJoin(room, out.board);
    expect(after.room).toEqual(after.board);
    expect(after.letters).toEqual([1, 1]);
    expect(after.square).toBe('[F2]');
  });

for (const [joined, first, second] of ORDERS)
  it(`keeps Yjs's pick when two tabs painted different copies beside a third (joined ${joined}, then ${first}, ${second})`, async () => {
    const room = copyRoom();
    const older = Y.encodeStateAsUpdate(room);
    const one = earlySession(first, [older], ['[F1]'], 'E');
    const newer = movedBy(room, older, joined);
    // Stored first, never touches the square: the chain.
    const chain = earlySession(1500, [newer], [], 'c');
    const two = earlySession(second, [newer], ['[F2]'], 'O');
    const out = await paintAndRename(newer, [chain, one, two], 7000);
    expect(out.chain).toEqual([1500]);
    expect(new Set(out.offending)).toEqual(new Set([first, second]));
    // F1 beside the room's write at the copy's: the higher id's.
    const picked = first > joined ? '[F1]' : '[F2]';
    expect(out.pick).toBe(picked);
    expect(out.painted.square).toEqual({ xywh: picked });
    expect(json(out.board)).toEqual(out.painted);
    const after = afterJoin(room, out.board);
    expect(after.room).toEqual(after.board);
    expect(after.letters).toEqual([1, 1]);
    expect(after.square).toBe(picked);
  });
