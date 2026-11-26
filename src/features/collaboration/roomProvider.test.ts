import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSourceProvider } from '@/features/files/sourceProvider';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import { draftsVersion, readDrafts, recordDrafts } from '@/lib/editDrafts';
import { resetAllowance, tabAllowance } from './allowance';
import { onHeartbeat } from './heartbeat';
import { isHeld } from './held';
import { NoteSeat } from './noteSeat';
import { PIECE_BYTES } from './pieces';
import {
  CLIENT_PROTOCOL,
  closedPayload,
  decodeFrame,
  HEARTBEAT,
  HEARTBEAT_MS,
  type Message,
  MessageKind,
  message,
  Reader,
  readSync,
  SyncKind,
  syncMessage,
  text,
  Writer,
} from './protocol';
import { onRenamed } from './renameClient';
import {
  EMBED_CLOSED_REASON,
  GROUP_BUSY_RETRY_MS,
  type HeldEdits,
  OLDEST_CLOSED_REASON,
  RoomProvider,
  UPDATE_TOO_LARGE_REASON,
} from './roomProvider';
import { CollabSocket } from './socket';

vi.mock('@/api/auth', () => ({ USE_MSW: false }));

// The tab's heartbeat clock (`heartbeat.ts`, a worker), ticked by the test.
const heartbeat = vi.hoisted(() => new Set<() => void>());
vi.mock('./heartbeat', () => ({
  onHeartbeat: (onBeat: () => void) => {
    heartbeat.add(onBeat);
    return () => heartbeat.delete(onBeat);
  },
}));
const tickHeartbeat = () => {
  for (const onBeat of [...heartbeat]) onBeat();
};

/** An in-page WebSocket the test plays the server through. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Message[] = [];
  /** Text frames sent: the heartbeats. */
  texts: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: Uint8Array | string) {
    if (typeof data === 'string') this.texts.push(data);
    else this.sent.push(...decodeFrame(data));
  }
  close(code = 1005) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(...messages: Uint8Array[]) {
    const writer = new Writer();
    for (const part of messages) writer.raw(part);
    this.onmessage?.({ data: writer.done().buffer });
  }
  take(kind: number) {
    const found = this.sent.filter((sent) => sent.kind === kind);
    this.sent = this.sent.filter((sent) => sent.kind !== kind);
    return found;
  }
}

// The drafts worker, run in this process (as in editDrafts.test.ts).
class InProcessWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: DraftReply }) => void) | null = null;
  store = import('@/lib/draftStore');
  postMessage(message: DraftMessage) {
    const copy = structuredClone(message);
    void this.store.then(({ handleDraftMessage }) =>
      handleDraftMessage(copy, (answer) =>
        this.onmessage?.({ data: structuredClone(answer) })
      )
    );
  }
  terminate() {}
}

let url = 0;
beforeEach(() => {
  resetAllowance();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('Worker', InProcessWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The client id a test token offers: one per token name. */
const clientIdOf = (name: string) =>
  ([...name].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) %
    0xff_ff_ff_f0) +
  1;

const PADDING = /[=]+$/;
const RUST_HEARTBEAT_MS = /pub const HEARTBEAT_MS: u64 = ([\d_]+);/;

/** A token as the API mints one, as far as the client reads it: its claims
 * offer a client id (Q213) and, for a DOCX session, its layout worker's
 * (Q219). */
function token(
  name: string,
  clientId = clientIdOf(name),
  workerClientId?: number
) {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(PADDING, '');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ clientId, sub: name, workerClientId })}.sig`;
}

async function joined(
  options: Partial<ConstructorParameters<typeof RoomProvider>[0]> = {}
) {
  const document = new Y.Doc();
  const events = {
    closed: vi.fn(),
    failed: vi.fn(),
    stateless: vi.fn(),
    synced: vi.fn(),
    unsynced: vi.fn(),
  };
  const provider = new RoomProvider({
    document,
    name: 'material:m1:schema:1',
    onAuthenticationFailed: events.failed,
    onClose: events.closed,
    onStateless: events.stateless,
    onSynced: events.synced,
    onUnsyncedChanges: events.unsynced,
    token: async () => token('token-1'),
    url: `wss://collab.test/${url++}`,
    ...options,
  });
  provider.connect();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await flush();
  const [join] = socket.take(MessageKind.Join);
  return { document, events, join, provider, socket };
}

// Q327: while an editor holds stored steps the room never accepted, its JOIN
// waits for the draft send to take them; with nothing held it joins at once.
it('opens no socket while the before-join promise holds, joins once it settles, and at once without one (Q327, Q360)', async () => {
  let release = () => {};
  let held: Promise<void> | undefined = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked = vi.fn(async () => token('token-1'));
  const document = new Y.Doc();
  const provider = new RoomProvider({
    beforeJoin: () => held,
    document,
    name: 'material:m1:schema:1',
    token: asked,
    url: `wss://collab.test/${url++}`,
  });
  const sockets = FakeSocket.instances.length;
  provider.connect();
  await flush();
  expect(FakeSocket.instances).toHaveLength(sockets);
  expect(asked).not.toHaveBeenCalled();
  release();
  await flush();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
  // Nothing held: a rejoin waits for nothing.
  held = undefined;
  provider.disconnect();
  provider.connect();
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
  provider.destroy();
});

// Hidden typing (Q237): the server's vector reaches the editor before this
// client's step 2 reply, so the watch is armed before anything syncs.
it("hands the server's step 1 vector over before replying to it", async () => {
  const seen: { replies: number; vector: Uint8Array }[] = [];
  const { join, socket } = await joined({
    onStep1: (vector) =>
      seen.push({
        replies: socket.sent.filter((sent) => sent.kind === MessageKind.Sync)
          .length,
        vector,
      }),
  });
  const server = new Y.Doc();
  server.getText('content').insert(0, 'hello');
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  // Only this client's own step 1 went before it.
  expect(seen).toEqual([{ replies: 1, vector: Y.encodeStateVector(server) }]);
  expect(
    socket.take(MessageKind.Sync).map((sent) => readSync(sent.payload).kind)
  ).toEqual([SyncKind.Step1, SyncKind.Step2]);
  // Merge view review r1 V-M5 (Q409): once synced, a step 1 (the room's
  // answer to an update it could not place) is answered but arms nothing.
  socket.deliver(
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(server))
    ),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  expect(seen).toHaveLength(1);
  expect(
    socket.take(MessageKind.Sync).map((sent) => readSync(sent.payload).kind)
  ).toEqual([SyncKind.Step2]);
});

it('joins with its token, syncs both ways and counts unacknowledged updates', async () => {
  const { document, events, join, provider, socket } = await joined();
  const reader = new Reader(join.payload);
  expect(reader.varString()).toBe('material:m1:schema:1');
  expect(reader.varString()).toBe(token('token-1'));
  // The version gate: the build's client protocol follows the token, then
  // the client id the document took from it (Q213) and the stored version
  // it holds (none: a new document), no note channel (0) and the editing
  // session's id (Q472).
  expect(reader.varUint()).toBe(CLIENT_PROTOCOL);
  expect(reader.varUint()).toBe(clientIdOf('token-1'));
  expect(reader.varUint()).toBe(0);
  expect(reader.varUint()).toBe(0);
  expect(reader.varBytes()).toHaveLength(16);
  expect(reader.done).toBe(true);
  expect(document.clientID).toBe(clientIdOf('token-1'));
  const channel = join.channel;

  // The server admits the channel and asks for what it lacks.
  const server = new Y.Doc();
  server.getText('content').insert(0, 'hello');
  socket.deliver(
    message(channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  expect(provider.isAuthenticated).toBe(true);
  const syncs = socket
    .take(MessageKind.Sync)
    .map((sent) => readSync(sent.payload));
  expect(syncs.map((sync) => sync.kind)).toEqual([
    SyncKind.Step1,
    SyncKind.Step2,
  ]);
  // The step 2 reply waits for its ACK like an update.
  expect(provider.unsyncedChanges).toBe(1);

  socket.deliver(
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(server, syncs[0].body))
    )
  );
  expect(document.getText('content').toString()).toBe('hello');
  expect(events.synced).toHaveBeenCalledWith({ state: true });
  // Applying the server's state sends nothing back.
  expect(socket.take(MessageKind.Sync)).toEqual([]);

  document.getText('content').insert(5, '!');
  document.getText('content').insert(6, '?');
  const updates = socket.take(MessageKind.Sync);
  expect(updates.map((sent) => readSync(sent.payload).kind)).toEqual([
    SyncKind.Update,
    SyncKind.Update,
  ]);
  expect(provider.hasUnsyncedChanges).toBe(true);
  socket.deliver(
    message(channel, MessageKind.Ack, new Writer().varUint(3).done())
  );
  expect(provider.unsyncedChanges).toBe(0);
  expect(events.unsynced).toHaveBeenLastCalledWith({ number: 0 });

  socket.deliver(message(channel, MessageKind.Stateless, text('{"type":"x"}')));
  expect(events.stateless).toHaveBeenCalledWith({ payload: '{"type":"x"}' });
});

// Q451 (review L4, Q443/Q444): an update the room answers late on a joined
// channel ends that channel and tells the editor once, which then goes the
// late way. Fails if a mid-session refusal is dropped or told twice.
it('lets a hidden page sleep only when it asked to, with nothing unsent', async () => {
  expect((await joined()).provider.mayHide()).toBe(false);
  let unsent = true;
  const { provider } = await joined({
    sleepsHidden: true,
    unsent: () => unsent,
  });
  expect(provider.mayHide()).toBe(false);
  unsent = false;
  expect(provider.mayHide()).toBe(true);
});

it('reports a late answer on a joined channel once and ends the channel', async () => {
  const { document, events, join, provider, socket } = await joined();
  const server = new Y.Doc();
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  expect(provider.isAuthenticated).toBe(true);
  document.getText('content').insert(0, 'typed');
  socket.deliver(
    message(join.channel, MessageKind.Refused, text('collaboration-late')),
    message(join.channel, MessageKind.Refused, text('collaboration-late'))
  );
  expect(events.failed).toHaveBeenCalledTimes(1);
  expect(events.failed).toHaveBeenCalledWith({ reason: 'collaboration-late' });
  expect(provider.isAuthenticated).toBe(false);
});

it('reports a refusal with its reason and rejoins on the same socket', async () => {
  const { events, join, provider, socket } = await joined();
  socket.deliver(
    message(join.channel, MessageKind.Refused, text('collaboration-read-only'))
  );
  expect(events.failed).toHaveBeenCalledWith({
    reason: 'collaboration-read-only',
  });
  expect(provider.isAuthenticated).toBe(false);
  provider.disconnect();
  provider.connect();
  await flush();
  const [again] = socket.take(MessageKind.Join);
  expect(again.channel).not.toBe(join.channel);
  expect(FakeSocket.instances).toHaveLength(1);
});

/** Q213: the document writes under the id the server assigned. Until a
 * writable JOINED it takes each JOIN's token id (a refused join, a read
 * channel); from then on it keeps that id for life, naming it in every JOIN
 * whatever the token offers, so the server binds the same id and the Undo
 * stack survives. */
it('takes the token client ids until the document writes under them, then keeps them', async () => {
  const tokens = [
    token('first', clientIdOf('first'), 11),
    token('second', clientIdOf('second'), 22),
    token('third', clientIdOf('third'), 33),
    token('again', clientIdOf('second'), 44),
    token('fourth', clientIdOf('fourth'), 55),
  ];
  const { document, join, provider, socket } = await joined({
    token: async () => tokens.shift()!,
  });
  const declared = (payload: Uint8Array) => {
    const reader = new Reader(payload);
    reader.varString();
    reader.varString();
    reader.varUint();
    return reader.varUint();
  };
  expect(declared(join.payload)).toBe(clientIdOf('first'));
  expect(provider.awareness.clientID).toBe(clientIdOf('first'));
  // What follows a rename hears each id taken (an open label editor's Undo).
  const taken: number[] = [];
  onRenamed(document, (_renamed, to) => taken.push(to));
  // A refused join binds nothing: the next token's id is taken.
  socket.deliver(
    message(join.channel, MessageKind.Refused, text('collaboration-client-id'))
  );
  provider.disconnect();
  provider.connect();
  await flush();
  const [second] = socket.take(MessageKind.Join);
  expect(declared(second.payload)).toBe(clientIdOf('second'));
  expect(document.clientID).toBe(clientIdOf('second'));
  expect(taken).toEqual([clientIdOf('second')]);
  expect(provider.workerClientId).toBe(22);
  socket.deliver(message(second.channel, MessageKind.Joined, Uint8Array.of(1)));
  document.getText('content').insert(0, 'typed');
  // Bound: a reconnect names the kept id with a fresh token, and a refusal
  // of a token offering that id again leaves it kept too.
  for (let round = 0; round < 3; round++) {
    socket.deliver(
      message(
        provider.seatChannel!,
        MessageKind.Refused,
        text('collaboration-client-id')
      )
    );
    provider.disconnect();
    provider.connect();
    await flush();
    const [again] = socket.take(MessageKind.Join);
    expect(declared(again.payload)).toBe(clientIdOf('second'));
    socket.deliver(
      message(again.channel, MessageKind.Joined, Uint8Array.of(1))
    );
  }
  expect(document.clientID).toBe(clientIdOf('second'));
  expect(provider.awareness.clientID).toBe(clientIdOf('second'));
  // The DOCX layout worker's id (Q219) is kept with the document's.
  expect(provider.workerClientId).toBe(22);
});

it('presents its previous token and keeps the ids it offers again, written or not', async () => {
  // Q236: Go offers a reconnect its previous ids again, so an Office editor
  // holding them (its replica and DOCX layout worker) needs no reload.
  const id = clientIdOf('first');
  const asked: (string | undefined)[] = [];
  const { document, join, provider, socket } = await joined({
    token: async (previous) => {
      asked.push(previous);
      return asked.length === 1
        ? token('first', id, 11)
        : token('again', id, 11);
    },
  });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  provider.disconnect();
  provider.connect();
  await flush();
  const [again] = socket.take(MessageKind.Join);
  expect(asked).toEqual([undefined, token('first', id, 11)]);
  const reader = new Reader(again.payload);
  reader.varString();
  reader.varString();
  reader.varUint();
  expect(reader.varUint()).toBe(id);
  expect(document.clientID).toBe(id);
  expect(provider.workerClientId).toBe(11);
});

it('drops its previous token at the first client id refusal and takes the fresh id', async () => {
  // Q475: under Q472 a reconnect of this session takes over its own channel,
  // so a `collaboration-client-id` refusal means another session holds the
  // ids. A document that never wrote takes the fresh token's id.
  const asked: (string | undefined)[] = [];
  const tokens = ['t1', 't1', 't2'];
  const { document, provider, socket } = await joined({
    token: async (previous) => {
      asked.push(previous);
      return token(tokens[asked.length - 1]);
    },
  });
  // A reconnect presents the previous token.
  provider.disconnect();
  provider.connect();
  await flush();
  const [second] = socket.take(MessageKind.Join);
  expect(asked).toEqual([undefined, token('t1')]);
  socket.deliver(
    message(
      second.channel,
      MessageKind.Refused,
      text('collaboration-client-id')
    )
  );
  provider.disconnect();
  provider.connect();
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
  expect(asked).toEqual([undefined, token('t1'), undefined]);
  expect(document.clientID).toBe(clientIdOf('t2'));
});

it('says on Leave whether the tab still holds unsent edits, naming its session', async () => {
  // Q236: only a clean Leave lets the room expire the session's ids; it ends
  // the session it names (in-place collection).
  let drafts = false;
  for (const [edit, stored, unsent] of [
    [false, false, 0],
    [false, true, 1],
    [true, false, 1],
  ] as const) {
    drafts = stored;
    const { document, join, provider, socket } = await joined({
      unsent: () => drafts,
    });
    socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
    // Unacknowledged.
    if (edit) document.getText('content').insert(0, 'typed');
    provider.disconnect();
    const [leave] = socket.take(MessageKind.Leave);
    const reader = new Reader(leave.payload);
    expect(reader.byte()).toBe(unsent);
    expect(reader.varUint()).toBe(document.clientID);
    expect(reader.done).toBe(true);
  }
});

/** The JOIN's stored version (after the room, token, protocol and id). */
function joinVersion(join: Message) {
  const reader = new Reader(join.payload);
  reader.varString();
  reader.varString();
  reader.varUint();
  reader.varUint();
  return reader.varUint();
}

/** The JOIN's note channel (0: none) and editing session id (Q472), after
 * its room, token, protocol, id and version. */
function joinTail(join: Message) {
  const reader = new Reader(join.payload);
  reader.varString();
  reader.varString();
  for (let field = 0; field < 3; field++) reader.varUint();
  return { note: reader.varUint(), session: [...reader.varBytes()] };
}

// Q472: one editing session names one random id on every JOIN, its rejoin
// after a socket drop too, so the server hands the rejoin its own stale
// channel; another provider (another session) names its own.
it('names one editing session id on every JOIN, and another provider its own', async () => {
  vi.useFakeTimers();
  const options = {
    name: 'material:m1:schema:1',
    token: async () => token('t'),
    url: `wss://collab.test/${url++}`,
  };
  const provider = new RoomProvider({ ...options, document: new Y.Doc() });
  provider.connect();
  const first = FakeSocket.instances.at(-1) as FakeSocket;
  first.open();
  await vi.advanceTimersByTimeAsync(0);
  const [join] = first.take(MessageKind.Join);
  first.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  first.close();
  await vi.advanceTimersByTimeAsync(2000);
  const second = FakeSocket.instances.at(-1) as FakeSocket;
  second.open();
  await vi.advanceTimersByTimeAsync(0);
  const [rejoin] = second.take(MessageKind.Join);
  expect(joinTail(join).session).toHaveLength(16);
  expect(joinTail(rejoin).session).toEqual(joinTail(join).session);
  const other = new RoomProvider({ ...options, document: new Y.Doc() });
  other.connect();
  await vi.advanceTimersByTimeAsync(0);
  const [another] = second.take(MessageKind.Join);
  expect(joinTail(another).session).not.toEqual(joinTail(join).session);
  provider.destroy();
  other.destroy();
});

/** The `ack` versions the provider sent since the last call. */
function acks(socket: FakeSocket) {
  return socket
    .take(MessageKind.Stateless)
    .map((sent) => JSON.parse(new Reader(sent.payload).varString()))
    .filter((event) => event.type === 'ack')
    .map((event) => event.version as number);
}

const stored = (channel: number, version: number) =>
  message(
    channel,
    MessageKind.Stateless,
    text(JSON.stringify({ type: 'stored', version }))
  );

/** Joined and synced with the server's document, its step 2 acknowledged. */
async function synced(
  options: Partial<ConstructorParameters<typeof RoomProvider>[0]> = {}
) {
  const opened = await joined(options);
  const { join, socket } = opened;
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(new Y.Doc()))
    ),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(new Y.Doc()))
    )
  );
  socket.take(MessageKind.Sync);
  return opened;
}

const ack = (channel: number, count: number) =>
  message(channel, MessageKind.Ack, new Writer().varUint(count).done());

// In-place collection (Epo 2026-10-23; review r1 H1 and H2, Editor
// 2026-10-26): a tab acknowledges the version it may report whenever that
// changes, never above the version its oldest unsent edit was made at. An
// edit stays unsent until the second store's notice after its ACK (the
// channel's first notice answers its step 1): the first may be a store that
// began before the edit arrived. Fails with an edit taken as stored at its
// ACK or at the first notice.
it('acknowledges stored versions, never above its oldest unsent edit', async () => {
  const { document, join, socket } = await synced();
  const channel = join.channel;
  // The answer's notice, and the ACK of its step 2.
  socket.deliver(stored(channel, 5), ack(channel, 1));
  expect(acks(socket)).toEqual([5]);
  // An edit made at 5, admitted while store 6 ran: 6 may lack it.
  document.getText('content').insert(0, 'a');
  socket.deliver(ack(channel, 1), stored(channel, 6));
  expect(acks(socket)).toEqual([]);
  expect(socket.take(MessageKind.Stateless)).toEqual([]);
  socket.deliver(stored(channel, 7));
  expect(acks(socket)).toEqual([7]);
});

// Review r1 H1: admission is not durable. A tab whose admitted edit no
// second store's notice covered when its channel ended (the server
// crashed, the socket dropped) names that edit's version again, and its
// step 2 resends the edit. Fails if the ACK or one notice cleared it.
it('keeps an admitted edit unsent through a drop until a second store covers it', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  document.getText('content').insert(0, 'a');
  socket.deliver(ack(channel, 1), stored(channel, 6));
  expect(provider.reportedVersion).toBe(5);
  socket.close();
  await flush();
  // The next JOIN names this, and the next step 2 carries the edit.
  expect(provider.reportedVersion).toBe(5);
  provider.destroy();
});

// Review r1 H2: a new document's empty step 2 carries no edit, so a brief
// open with no edit acknowledges its answer's version, never 0. Fails if
// the empty step 2 holds the tab back.
it("acknowledges its answer's version after an empty step 2", async () => {
  const { join, provider, socket } = await synced();
  socket.deliver(stored(join.channel, 5));
  expect(acks(socket)).toEqual([5]);
  expect(provider.reportedVersion).toBe(5);
});

// Review r2 N1: a mark whose edits the room already holds (an empty step 2)
// clears by the rule above, once a second store's notice came after that
// step 2's ACK, not at the next edit. Fails if the mark stays until an
// edit, or clears before a store covers it.
it('clears a mark an empty step 2 answered once a second store covers it', async () => {
  const { join, provider, socket } = await joined({ unsentFrom: 3 });
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(new Y.Doc()))
    ),
    ack(join.channel, 1),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(new Y.Doc()))
    ),
    stored(join.channel, 9),
    stored(join.channel, 10)
  );
  expect(provider.reportedVersion).toBe(3);
  socket.deliver(stored(join.channel, 11));
  expect(provider.reportedVersion).toBe(11);
});

// Review r1 M2: drafts marked while the channel is open (a late merge)
// hold the tab back only until the update carrying them is stored, by the
// rule above; and a Leave while they are marked says unsent (review r1
// N3). Fails if the mark stays until a step 2, or the Leave says clean.
it('carries a mark made while connected on its next update, and leaves unsent while marked', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 9), ack(channel, 1));
  expect(acks(socket)).toEqual([9]);
  provider.unsentFrom(4);
  expect(acks(socket)).toEqual([4]);
  document.getText('content').insert(0, 'merged');
  socket.deliver(ack(channel, 1), stored(channel, 10), stored(channel, 11));
  expect(acks(socket)).toEqual([11]);
  provider.unsentFrom(4);
  socket.take(MessageKind.Stateless);
  provider.disconnect();
  const [leave] = socket.take(MessageKind.Leave);
  expect(new Reader(leave.payload).byte()).toBe(1);
});

// Review r1 L8: a document holding edits made before its first `stored`
// (version 0) reports 1, as a row from before versions does, never 0.
it('reports 1 for edits made before any stored version', async () => {
  const { join } = await joined({ unsentFrom: 0 });
  expect(joinVersion(join)).toBe(1);
});

it('acknowledges nothing before it synced', async () => {
  const { join, socket } = await joined();
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    stored(join.channel, 4)
  );
  expect(acks(socket)).toEqual([]);
});

it('joins with its stored drafts version and reports it until the room took them', async () => {
  // L10 (late-merge review): rows applied before the JOIN are not new.
  const { document, join, provider, socket } = await joined({
    unsentFrom: 3,
  });
  expect(joinVersion(join)).toBe(3);
  // The restored rows, applied before the room joined.
  document.getText('content').insert(0, 'restored');
  // Its step 2 is admitted before the room's answer (an open that waited):
  // the answer's notice (9) is no store's.
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(new Y.Doc()))
    ),
    ack(join.channel, 1),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(new Y.Doc()))
    ),
    stored(join.channel, 9),
    stored(join.channel, 10)
  );
  expect(acks(socket)).toEqual([]);
  socket.deliver(stored(join.channel, 11));
  expect(acks(socket)).toEqual([11]);
  // A held draft send's steps go in later: made at 4.
  provider.unsentFrom(4);
  expect(provider.reportedVersion).toBe(4);
});

it('joins restored rows stored before versions at 1, never as new', async () => {
  // L10 (Editor 2026-10-26): a row without a version is older than any
  // collection, so the JOIN names 1, not 0 (a new tab's).
  const rows = [{}, { version: 7 }];
  const { join } = await joined({ unsentFrom: draftsVersion(rows) });
  expect(joinVersion(join)).toBe(1);
});

it('keeps taking token ids while its joins are read-only', async () => {
  const tokens = [token('read-1'), token('read-2')];
  const { document, join, provider, socket } = await joined({
    token: async () => tokens.shift()!,
  });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(0)));
  expect(document.clientID).toBe(clientIdOf('read-1'));
  provider.disconnect();
  provider.connect();
  await flush();
  socket.take(MessageKind.Join);
  expect(document.clientID).toBe(clientIdOf('read-2'));
});

it('takes the token id though it wrote before its first join', async () => {
  // Epo 2026-10-24: the earlier edit stays under the id Yjs drew, which the
  // room refuses as it is (`client_id`) and never binds.
  const document = new Y.Doc();
  const drawn = document.clientID;
  document.getText('content').insert(0, 'early');
  const provider = new RoomProvider({
    document,
    name: 'material:m1:schema:1',
    token: async () => token('token-1'),
    url: `wss://collab.test/${url++}`,
  });
  provider.connect();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await flush();
  const [join] = socket.take(MessageKind.Join);
  const reader = new Reader(join.payload);
  reader.varString();
  reader.varString();
  reader.varUint();
  expect(reader.varUint()).toBe(clientIdOf('token-1'));
  expect(document.clientID).toBe(clientIdOf('token-1'));
  expect(Y.getState(document.store, drawn)).toBe(5);
});

it('keeps the id a read channel wrote under once its token turned writable', async () => {
  // Q226 M1: a refresh made the read channel writable and it wrote; the
  // room stored its id, so a reconnect names that id.
  const tokens = [token('read-1'), token('write-2')];
  const { document, join, provider, socket } = await joined({
    token: async () => tokens.shift()!,
  });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(0)));
  document.getText('content').insert(0, 'typed');
  provider.disconnect();
  provider.connect();
  await flush();
  const [again] = socket.take(MessageKind.Join);
  const reader = new Reader(again.payload);
  reader.varString();
  reader.varString();
  reader.varUint();
  expect(reader.varUint()).toBe(clientIdOf('read-1'));
  expect(document.clientID).toBe(clientIdOf('read-1'));
});

it('stops explicitly when its document left the bound id', async () => {
  // Q226 L3: every change under another id would be refused.
  const { document, join, socket } = await joined();
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  socket.take(MessageKind.Sync);
  document.clientID += 1;
  expect(() => document.getText('content').insert(0, 'typed')).toThrow(
    'left its assigned client id'
  );
  expect(socket.take(MessageKind.Sync)).toHaveLength(0);
});

it('reports a closed room while the socket stays open for others', async () => {
  const { events, join, provider, socket } = await joined();
  const other = new RoomProvider({
    document: new Y.Doc(),
    name: 'material:m2:schema:1',
    token: async () => token('token-2'),
    url: socket.url,
  });
  other.connect();
  await flush();
  // One socket per URL: the second room joins on it.
  expect(FakeSocket.instances).toHaveLength(1);
  const [second] = socket.take(MessageKind.Join);
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(second.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(join.channel, MessageKind.Closed, closedPayload(4401, 'expired'))
  );
  expect(events.closed).toHaveBeenCalledWith({ code: 4401, reason: 'expired' });
  expect(provider.isAuthenticated).toBe(false);
  expect(provider.socketStatus).toBe('connected');
  expect(other.isAuthenticated).toBe(true);
});

it('reports an open slowed by the open budget, not as a stateless message', async () => {
  const onSlowed = vi.fn();
  const { events, join, socket } = await joined({ onSlowed });
  const slowed = text('{"type":"open-slowed"}');
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(join.channel, MessageKind.Stateless, slowed)
  );
  expect(onSlowed).toHaveBeenCalledWith(true);
  expect(events.stateless).not.toHaveBeenCalled();
  // Closed as the user's oldest while slowed, it parks and its slowed line
  // goes (rate-limit review r6 N-4).
  socket.deliver(
    message(
      join.channel,
      MessageKind.Closed,
      closedPayload(0, OLDEST_CLOSED_REASON)
    )
  );
  expect(onSlowed).toHaveBeenLastCalledWith(false);
  expect(onSlowed).toHaveBeenCalledTimes(2);
});

/** Embedded quizzes and sets join inside their note's channel (Epo
 * 2026-10-20): only while the note is joined, naming its channel, ended
 * with it and joined again with it; closed as the note's oldest embed, one
 * joins again once near the screen. */
it('joins an embed inside its note, ending and joining again with it', async () => {
  const { join: noteJoin, provider: note, socket } = await joined();
  const seat = new NoteSeat();
  seat.attach(note);
  const closed = vi.fn();
  const embed = new RoomProvider({
    document: new Y.Doc(),
    name: 'material:set:schema:1',
    onClose: closed,
    parent: seat,
    token: async () => token('embed-token'),
    url: socket.url,
  });
  embed.connect();
  await flush();
  // The note has not joined yet: the embed waits for it.
  expect(socket.take(MessageKind.Join)).toEqual([]);
  socket.deliver(
    message(noteJoin.channel, MessageKind.Joined, Uint8Array.of(1))
  );
  await flush();
  const [first] = socket.take(MessageKind.Join);
  const reader = new Reader(first.payload);
  expect([reader.varString(), reader.varString(), reader.varUint()]).toEqual([
    'material:set:schema:1',
    token('embed-token'),
    CLIENT_PROTOCOL,
  ]);
  expect(reader.varUint()).toBe(clientIdOf('embed-token'));
  // Its stored version (none: new), its note's channel, then its own
  // editing session's id, not its note's (Q472).
  expect(reader.varUint()).toBe(0);
  expect(reader.varUint()).toBe(noteJoin.channel);
  expect(reader.varBytes()).toHaveLength(16);
  expect(joinTail(first).session).not.toEqual(joinTail(noteJoin).session);
  socket.deliver(message(first.channel, MessageKind.Joined, Uint8Array.of(1)));
  expect(embed.isAuthenticated).toBe(true);

  // The note's room closes: the embed ends with it, reporting no close, and
  // joins again once the note has.
  note.disconnect();
  expect(embed.isAuthenticated).toBe(false);
  expect(closed).not.toHaveBeenCalled();
  note.connect();
  await flush();
  const [noteAgain] = socket.take(MessageKind.Join);
  socket.deliver(
    message(noteAgain.channel, MessageKind.Joined, Uint8Array.of(1))
  );
  await flush();
  const [second] = socket.take(MessageKind.Join);
  expect(joinTail(second).note).toBe(noteAgain.channel);
  socket.deliver(
    message(second.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      second.channel,
      MessageKind.Closed,
      closedPayload(0, EMBED_CLOSED_REASON)
    )
  );
  await flush();
  // Closed as the note's oldest embed: it waits until near the screen.
  expect(socket.take(MessageKind.Join)).toEqual([]);
  embed.wake();
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
});

it('answers a token request in band', async () => {
  let current = token('token-1');
  const { join, socket } = await joined({ token: async () => current });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  current = token('token-2');
  socket.deliver(message(join.channel, MessageKind.TokenRequest));
  await flush();
  const [answer] = socket.take(MessageKind.Token);
  expect(new Reader(answer.payload).varString()).toBe(token('token-2'));
});

it('applies remote awareness and sends back only its own re-asserted state', async () => {
  const { document, join, provider, socket } = await joined();
  provider.awareness.setLocalStateField('user', { name: 'A' });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  expect(socket.take(MessageKind.Awareness)).toHaveLength(1);
  const peer = new Awareness(new Y.Doc());
  peer.setLocalStateField('user', { name: 'B' });
  socket.deliver(
    message(
      join.channel,
      MessageKind.Awareness,
      encodeAwarenessUpdate(peer, [peer.clientID])
    )
  );
  expect(provider.awareness.getStates().get(peer.clientID)).toEqual({
    user: { name: 'B' },
  });
  expect(socket.take(MessageKind.Awareness)).toEqual([]);
  provider.awareness.setLocalStateField('user', { name: 'A2' });
  expect(socket.take(MessageKind.Awareness)).toHaveLength(1);
  expect(document.clientID).toBe(provider.awareness.clientID);
});

// A drop of any kind, the server's close of a silent socket (1001, Epo
// 2026-10-20) too, rejoins the same way.
it.each([1005, 1001])(
  'ends the room when the socket drops (%i) and rejoins once it reopens',
  async (code) => {
    vi.useFakeTimers();
    const document = new Y.Doc();
    const onClose = vi.fn();
    const provider = new RoomProvider({
      document,
      name: 'material:m1:schema:1',
      onClose,
      token: async () => token('t'),
      url: `wss://collab.test/${url++}`,
    });
    provider.connect();
    const first = FakeSocket.instances.at(-1) as FakeSocket;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    const [join] = first.take(MessageKind.Join);
    first.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
    first.close(code);
    expect(onClose).toHaveBeenCalled();
    expect(provider.isConnected).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const second = FakeSocket.instances.at(-1) as FakeSocket;
    expect(second).not.toBe(first);
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.take(MessageKind.Join)).toHaveLength(1);
  }
);

it('in a timeout holds its edits, then joins again on the same socket and resyncs them, its drafts kept', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const document = new Y.Doc();
  const key = 'u_1:material:timeout';
  const onStateless = vi.fn();
  const provider: RoomProvider = new RoomProvider({
    document,
    name: 'material:m1:schema:1',
    onStateless,
    token: async () => token('t'),
    url: `wss://collab.test/${url++}`,
  });
  recordDrafts({
    doc: document,
    ignore: (origin) => origin === provider,
    key,
    limitBytes: 1024 * 1024,
    lineage: 'material:m1:schema:1',
  });
  const server = new Y.Doc();
  server.getText('content').insert(0, 'shared ');
  /** Joins on `socket` and syncs with the server's document: the channel. */
  const sync = async (socket: FakeSocket) => {
    await vi.advanceTimersByTimeAsync(0);
    const [join] = socket.take(MessageKind.Join);
    socket.deliver(
      message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
      message(
        join.channel,
        MessageKind.Sync,
        syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
      )
    );
    for (const sent of socket.take(MessageKind.Sync)) {
      const { body, kind } = readSync(sent.payload);
      if (kind === SyncKind.Step2) Y.applyUpdate(server, body);
      else
        socket.deliver(
          message(
            join.channel,
            MessageKind.Sync,
            syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(server, body))
          )
        );
    }
    return join.channel;
  };
  provider.connect();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  const channel = await sync(socket);
  expect(provider.isSynced).toBe(true);
  socket.take(MessageKind.Awareness);

  // An edit goes out, and the server puts the user in a timeout before
  // applying it: the room pauses and the tab holds back.
  document.getText('content').insert(7, 'typed');
  expect(socket.take(MessageKind.Sync)).toHaveLength(1);
  socket.deliver(
    message(
      channel,
      MessageKind.Stateless,
      text(JSON.stringify({ remainingMs: 3000, type: 'update-timeout' }))
    )
  );
  expect(onStateless).not.toHaveBeenCalled();
  expect(provider.isSynced).toBe(false);
  expect(isHeld()).toBe(true);
  // Nothing goes meanwhile; an edit stays in the document.
  document.getText('content').insert(12, '!');
  provider.sendStateless('{"type":"checkpoint-request"}');
  expect(socket.sent).toEqual([]);

  // When it ends, the same channel joins again on the same socket, and its
  // step 2 carries both edits the server never applied.
  await vi.advanceTimersByTimeAsync(3000);
  expect(isHeld()).toBe(false);
  expect(await sync(socket)).toBe(channel);
  expect(server.getText('content').toString()).toBe('shared typed!');
  expect(provider.isSynced).toBe(true);
  expect(FakeSocket.instances).toHaveLength(1);
  // No receipt covered them: their rows stay on this device.
  const rows = await readDrafts(key);
  expect(rows.filter((row) => row.kind === 'update').length).toBeGreaterThan(0);
  provider.destroy();
});

/** A joined room whose server state is empty, synced both ways. */
async function syncedRoom(
  options: Partial<ConstructorParameters<typeof RoomProvider>[0]> = {}
) {
  const room = await joined(options);
  const server = new Y.Doc();
  room.socket.deliver(
    message(room.join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      room.join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  room.socket.take(MessageKind.Sync);
  // Its step 2 reply, acknowledged.
  room.socket.deliver(
    message(room.join.channel, MessageKind.Ack, new Writer().varUint(1).done())
  );
  return { ...room, server };
}

/** The SYNC frames `sent` applied to `server` in order: whether they are the
 * pieces of one group in order, the kinds they were cut from, the largest
 * piece, and after how many something was pending. */
function applyPieces(server: Y.Doc, sent: Message[]) {
  const kinds = new Set<number>();
  let grouped = true;
  let largest = 0;
  let pending = 0;
  for (const [at, { payload }] of sent.entries()) {
    const sync = readSync(payload);
    const reader = new Reader(sync.body);
    const [kind, index, count] = [
      reader.varUint(),
      reader.varUint(),
      reader.varUint(),
    ];
    const piece = sync.body.subarray(reader.at);
    grouped &&=
      sync.kind === SyncKind.Piece && index === at && count === sent.length;
    kinds.add(kind);
    largest = Math.max(largest, piece.byteLength);
    Y.applyUpdate(server, piece);
    if (server.store.pendingStructs) pending += 1;
  }
  return {
    grouped,
    kinds: [...kinds],
    pending,
    small: largest <= PIECE_BYTES,
  };
}

/** A group's pieces as the room takes them: its first alone, then the rest
 * once the room holds the first (its ACK, round 4, finding 5). Everything
 * sent before the group must be acknowledged already. */
function heldGroup(socket: FakeSocket, channel: number) {
  const first = socket.take(MessageKind.Sync);
  socket.deliver(ack(channel, 1));
  return [...first, ...socket.take(MessageKind.Sync)];
}

// Round 4, finding 5: a group's first piece goes alone and the rest only
// once the room holds it (its ACK), so a busy answer costs one piece, not
// the burst; the tab is held back until the room acknowledges the rest.
// Fails with every piece sent at once.
it('sends an update over 2 MiB as one group of ordered pieces, the rest once the room holds the first', async () => {
  const { document, join, provider, server, socket } = await syncedRoom();
  const long = 'x'.repeat(5 * 1024 * 1024);
  document.getText('content').insert(0, long);
  const [first, ...none] = socket.take(MessageKind.Sync);
  expect(none).toEqual([]);
  const count = provider.unsyncedChanges;
  expect(count).toBeGreaterThan(2);
  expect(isHeld()).toBe(true);
  socket.deliver(ack(join.channel, 1));
  const pieces = [first, ...socket.take(MessageKind.Sync)];
  expect(pieces).toHaveLength(count);
  expect(applyPieces(server, pieces)).toEqual({
    grouped: true,
    kinds: [SyncKind.Update],
    pending: 0,
    small: true,
  });
  expect(server.getText('content').toString()).toBe(long);
  expect(isHeld()).toBe(true);
  expect(provider.unsyncedChanges).toBe(count - 1);
  // The room admits the group after its last piece and acknowledges the
  // rest at once.
  socket.deliver(ack(join.channel, count - 1));
  expect(isHeld()).toBe(false);
  expect(provider.unsyncedChanges).toBe(0);
});

// A group goes as PIECE messages after a plain update, is in flight until
// the room acknowledged all of its pieces (an earlier update's ACK, its first
// piece's, and one short of the group keep it so), then admitted, and unsent
// until a second store's notice after that ACK (review r1 H1), as a single
// update is. Fails with the pieces sent as plain updates (d8fb10933), or if
// an ACK short of the group releases the tab or counts it admitted.
it('counts a group in flight until the room acknowledges all of it, then admitted', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  document.getText('content').insert(0, 'a');
  document.getText('content').insert(1, 'b'.repeat(5 * 1024 * 1024));
  const [single, first, ...none] = socket.take(MessageKind.Sync);
  expect(none).toEqual([]);
  const server = new Y.Doc();
  const update = readSync(single.payload);
  expect(update.kind).toBe(SyncKind.Update);
  Y.applyUpdate(server, update.body);
  const group = provider.unsyncedChanges - 1;
  expect(group).toBeGreaterThan(2);
  // The single update's ACK and a store that may lack both.
  socket.deliver(ack(channel, 1), stored(channel, 6), stored(channel, 7));
  expect(provider.unsyncedChanges).toBe(group);
  expect(isHeld()).toBe(true);
  expect(provider.reportedVersion).toBe(5);
  // The room holds the first piece: the rest goes.
  socket.deliver(ack(channel, 1));
  const pieces = [first, ...socket.take(MessageKind.Sync)];
  expect(pieces).toHaveLength(group);
  expect(applyPieces(server, pieces)).toMatchObject({
    grouped: true,
    kinds: [SyncKind.Update],
    pending: 0,
  });
  socket.deliver(ack(channel, group - 2));
  expect(isHeld()).toBe(true);
  expect(provider.reportedVersion).toBe(5);
  socket.deliver(ack(channel, 1));
  expect(provider.unsyncedChanges).toBe(0);
  expect(isHeld()).toBe(false);
  // Admitted at 7: unsent until a second store after it.
  socket.deliver(stored(channel, 8));
  expect(provider.reportedVersion).toBe(5);
  socket.deliver(stored(channel, 9));
  expect(provider.reportedVersion).toBe(9);
});

// A writer gone mid-group (the socket dropped before the room acknowledged
// it) leaves nothing in the room; its next step 2 carries the whole edit
// again, as a group of its own. Fails if the drop forgets the group's edit.
it('resends a group cut short by a dropped socket in its next step 2', async () => {
  const { document, join, provider, socket } = await synced();
  socket.deliver(stored(join.channel, 5), ack(join.channel, 1));
  const long = 'c'.repeat(3 * 1024 * 1024);
  document.getText('content').insert(0, long);
  // Its first piece, alone until the room holds it.
  expect(socket.take(MessageKind.Sync)).toHaveLength(1);
  vi.useFakeTimers();
  socket.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(isHeld()).toBe(false);
  expect(provider.reportedVersion).toBe(5);
  const again = FakeSocket.instances.at(-1) as FakeSocket;
  expect(again).not.toBe(socket);
  again.open();
  await vi.advanceTimersByTimeAsync(0);
  const [join2] = again.take(MessageKind.Join);
  const server = new Y.Doc();
  again.deliver(
    message(join2.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join2.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  const [, first] = again.take(MessageKind.Sync);
  again.deliver(ack(join2.channel, 1));
  const pieces = [first, ...again.take(MessageKind.Sync)];
  expect(applyPieces(server, pieces)).toMatchObject({
    grouped: true,
    kinds: [SyncKind.Step2],
  });
  expect(server.getText('content').toString()).toBe(long);
  expect(provider.unsyncedChanges).toBe(pieces.length - 1);
  provider.destroy();
});

// Epo 2026-11-24 ("Add jitter"): a dropped socket opens again at a random
// time up to 1 s (`reconnectDelay`), then up to 2 s after another failure.
it('opens a dropped socket again after the jittered wait, which grows', async () => {
  const { provider, socket } = await joined();
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
  socket.close();
  await vi.advanceTimersByTimeAsync(998);
  expect(FakeSocket.instances.at(-1)).toBe(socket);
  await vi.advanceTimersByTimeAsync(1);
  const again = FakeSocket.instances.at(-1) as FakeSocket;
  expect(again).not.toBe(socket);
  again.close();
  await vi.advanceTimersByTimeAsync(1997);
  expect(FakeSocket.instances.at(-1)).toBe(again);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeSocket.instances.at(-1)).not.toBe(again);
  random.mockRestore();
  provider.destroy();
});

// Epo 2026-11-24 ("Add jitter"): back online, the socket's backoff starts
// over, so it opens within the first attempt's random 0–1 s, neither at once
// (a network back for a whole school would bring every tab together) nor
// after the longer wait its failures had grown to.
it('opens within the first random wait once the browser is back online', async () => {
  const page = new EventTarget();
  vi.stubGlobal('window', page);
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
  const socket = CollabSocket.create(
    `wss://collab.test/${url++}`,
    () => () => {}
  );
  const handler = {
    onMessage() {},
    onResume() {},
    onSleep() {},
    onSocketClose() {},
    onSocketOpen() {},
  };
  const last = () => FakeSocket.instances.at(-1) as FakeSocket;
  socket.attach(handler);
  for (const wait of [999, 1998]) {
    last().close();
    await vi.advanceTimersByTimeAsync(wait);
  }
  // A third failure: its wait would be up to 4 s.
  const dropped = last();
  dropped.close();
  page.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(998);
  expect(last()).toBe(dropped);
  await vi.advanceTimersByTimeAsync(1);
  expect(last()).not.toBe(dropped);
  socket.detach(handler);
  random.mockRestore();
});

// Review of 43fae032a round 2, finding 5: a group the room dropped as late
// (an uplink too slow for one piece within its slack) is not sent again on
// the same channel, where it would be late again with no end: its ACK
// admits none of it, the room's step 1 and later edits send nothing, and
// it stays one unsynced change (no receipt asked for, not saved) until the
// next join, whose step 2 carries all of it. Fails if the drop is answered
// with a resend, or the dropped edit counts as admitted.
it('holds a group dropped as late until the next join, unsynced meanwhile', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  const long = 'd'.repeat(3 * 1024 * 1024);
  document.getText('content').insert(0, long);
  const pieces = heldGroup(socket, channel);
  expect(pieces.length).toBeGreaterThan(1);
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(dropped)),
    ack(channel, pieces.length - 1)
  );
  expect(provider.unsyncedChanges).toBe(1);
  expect(isHeld()).toBe(false);
  socket.deliver(
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(new Y.Doc()))
    )
  );
  document.getText('content').insert(0, 'e');
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  socket.deliver(stored(channel, 6), stored(channel, 7));
  expect(provider.reportedVersion).toBe(5);
  expect(provider.unsyncedChanges).toBe(1);
  // The next join sends it all.
  vi.useFakeTimers();
  socket.close();
  await vi.advanceTimersByTimeAsync(2000);
  const again = FakeSocket.instances.at(-1) as FakeSocket;
  again.open();
  await vi.advanceTimersByTimeAsync(0);
  const [join2] = again.take(MessageKind.Join);
  const server = new Y.Doc();
  again.deliver(
    message(join2.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join2.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  const [, first] = again.take(MessageKind.Sync);
  again.deliver(ack(join2.channel, 1));
  const resent = [first, ...again.take(MessageKind.Sync)];
  expect(applyPieces(server, resent)).toMatchObject({
    grouped: true,
    kinds: [SyncKind.Step2],
  });
  expect(server.getText('content').toString()).toBe(`e${long}`);
  provider.destroy();
});

// Epo 2026-11-23: a group that found another of the user's unfinished
// (`group-busy`) is held as a late one, unsynced, having sent only its first
// piece (round 4, finding 5), and the same channel joins again 10 s later,
// silently: its step 2 carries the group and the edits made meanwhile. Fails
// if the busy group is never sent again, or counts as admitted.
it('joins again 10 s after a busy group, its step 2 carrying it', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  const long = 'f'.repeat(3 * 1024 * 1024);
  document.getText('content').insert(0, long);
  expect(socket.take(MessageKind.Sync)).toHaveLength(1);
  vi.useFakeTimers();
  const busy = JSON.stringify({ room: 'r', type: 'group-busy' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(busy)),
    ack(channel, 1)
  );
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  expect(provider.unsyncedChanges).toBe(1);
  document.getText('content').insert(0, 'g');
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  await vi.advanceTimersByTimeAsync(GROUP_BUSY_RETRY_MS - 100);
  expect(socket.take(MessageKind.Join)).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  const [rejoin] = socket.take(MessageKind.Join);
  expect(rejoin.channel).toBe(channel);
  const server = new Y.Doc();
  socket.deliver(
    message(channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  const [, first] = socket.take(MessageKind.Sync);
  socket.deliver(ack(channel, 1));
  const resent = [first, ...socket.take(MessageKind.Sync)];
  expect(applyPieces(server, resent)).toMatchObject({
    grouped: true,
    kinds: [SyncKind.Step2],
  });
  expect(server.getText('content').toString()).toBe(`g${long}`);
  expect(provider.unsyncedChanges).toBe(resent.length - 1);
  provider.destroy();
});

// Round 3, finding 1 (Epo 2026-11-23): a late drop hands the editor a Retry
// for its save strip and retries nothing on a timer; Retry joins the same
// channel again at once, whose step 2 carries the held edits, and the strip
// goes once it joined. Fails if a late drop leaves the channel with no way
// to sync, or rejoins by itself.
it('hands a late drop its Retry, which joins again now, and no timer does', async () => {
  const onHeld = vi.fn();
  const { document, join, provider, socket } = await synced({ onHeld });
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  const long = 'h'.repeat(3 * 1024 * 1024);
  document.getText('content').insert(0, long);
  const pieces = heldGroup(socket, channel);
  vi.useFakeTimers();
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(dropped)),
    ack(channel, pieces.length - 1)
  );
  expect(onHeld).toHaveBeenCalledTimes(1);
  const { retry, retrying } = onHeld.mock.calls[0][0] as HeldEdits;
  expect(retrying).toBe(false);
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(socket.take(MessageKind.Join)).toEqual([]);
  expect(provider.unsyncedChanges).toBe(1);
  retry();
  await vi.advanceTimersByTimeAsync(0);
  const [rejoin] = socket.take(MessageKind.Join);
  expect(rejoin.channel).toBe(channel);
  const server = new Y.Doc();
  socket.deliver(
    message(channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  expect(onHeld).toHaveBeenLastCalledWith(null);
  const [, first] = socket.take(MessageKind.Sync);
  socket.deliver(ack(channel, 1));
  applyPieces(server, [first, ...socket.take(MessageKind.Sync)]);
  expect(server.getText('content').toString()).toBe(long);
  provider.destroy();
});

// Round 5, finding 3: a late drop while the user is in a timeout raises no
// strip, whose Retry would join nothing then; the join after the timeout
// carries the held edits. Fails with the strip raised in the timeout.
it('raises no strip for a late drop in a timeout, whose join after carries the edits', async () => {
  const onHeld = vi.fn();
  const { document, join, provider, socket } = await synced({ onHeld });
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  const long = 'p'.repeat(3 * 1024 * 1024);
  document.getText('content').insert(0, long);
  const pieces = heldGroup(socket, channel);
  vi.useFakeTimers();
  const timeout = JSON.stringify({ remainingMs: 3000, type: 'update-timeout' });
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(timeout)),
    message(channel, MessageKind.Stateless, text(dropped)),
    ack(channel, pieces.length - 1)
  );
  expect(onHeld).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  const [rejoin] = socket.take(MessageKind.Join);
  expect(rejoin.channel).toBe(channel);
  const server = new Y.Doc();
  socket.deliver(
    message(channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  const [, first] = socket.take(MessageKind.Sync);
  socket.deliver(ack(channel, 1));
  applyPieces(server, [first, ...socket.take(MessageKind.Sync)]);
  expect(server.getText('content').toString()).toBe(long);
  expect(onHeld).not.toHaveBeenCalled();
  provider.destroy();
});

// Round 4, finding 4: a second Retry while the first's join is pending does
// nothing, and the strip hears the join pending (its Retry disabled). Fails
// with a JOIN for each click.
it('joins once for two Retries while the first is pending', async () => {
  const onHeld = vi.fn();
  const { document, join, provider, socket } = await synced({ onHeld });
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  document.getText('content').insert(0, 'r'.repeat(3 * 1024 * 1024));
  const pieces = heldGroup(socket, channel);
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(dropped)),
    ack(channel, pieces.length - 1)
  );
  const { retry } = onHeld.mock.calls[0][0] as HeldEdits;
  retry();
  expect(onHeld).toHaveBeenLastCalledWith({ retry, retrying: true });
  retry();
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
  provider.destroy();
});

// Epo 2026-11-23: a provider its owner lets go (refused for good, read-only,
// gone, a Discard) clears the strip, so the editor shows what its refusal
// says instead. Fails with the unsynced strip left over the refusal's.
it('clears the held strip when its owner lets the room go', async () => {
  const onHeld = vi.fn();
  const { document, join, provider, socket } = await synced({ onHeld });
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  document.getText('content').insert(0, 'g'.repeat(3 * 1024 * 1024));
  const pieces = heldGroup(socket, channel);
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(
    message(channel, MessageKind.Stateless, text(dropped)),
    ack(channel, pieces.length - 1)
  );
  expect(onHeld).toHaveBeenCalledTimes(1);
  provider.disconnect();
  expect(onHeld).toHaveBeenLastCalledWith(null);
  provider.destroy();
  expect(onHeld).toHaveBeenCalledTimes(2);
});

// Round 3, finding 2: a group dropped as late has its pieces still waiting
// for the allowance dropped, so they neither upload for nothing nor hold the
// socket's other frames (a busy group's rest never went: it waits for its
// first piece's ACK, round 4). Fails if the waiting pieces still go out
// after the notice.
it("drops a late group's waiting pieces from the socket", async () => {
  const { document, join, socket } = await synced();
  const channel = join.channel;
  socket.deliver(stored(channel, 5), ack(channel, 1));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  resetAllowance();
  // 20 MiB: the 8 MiB burst lets the first pieces go, the rest wait.
  document.getText('content').insert(0, 'i'.repeat(20 * 1024 * 1024));
  expect(heldGroup(socket, channel).length).toBeGreaterThan(1);
  expect(isHeld()).toBe(true);
  const dropped = JSON.stringify({ room: 'r', type: 'group-dropped' });
  socket.deliver(message(channel, MessageKind.Stateless, text(dropped)));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  expect(isHeld()).toBe(false);
});

// Round 3, finding 4: one group of pieces at a time on a socket, as the
// room holds one unfinished group per user: a second room's group waits
// (one unsynced change, nothing sent) until the first room's group is
// acknowledged, then goes whole with the edits made meanwhile. Fails if
// two rooms' groups go back to back, which the room answers busy.
it("sends a second room's group only after the first room's ACK", async () => {
  const shared = `wss://collab.test/${url++}`;
  const first = await synced({ url: shared });
  const second = await synced({ url: shared });
  expect(second.socket).toBe(first.socket);
  const socket = first.socket;
  const long = 'j'.repeat(3 * 1024 * 1024);
  first.document.getText('content').insert(0, long);
  const [head, ...none] = socket.take(MessageKind.Sync);
  expect(none).toEqual([]);
  expect(head.channel).toBe(first.join.channel);
  // Its own step 2 reply is still unacknowledged.
  const before = second.provider.unsyncedChanges;
  second.document.getText('content').insert(0, long);
  second.document.getText('content').insert(0, 'k');
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  expect(second.provider.unsyncedChanges).toBe(before + 1);
  // The first room's own step 2 reply and its group's first piece: the
  // rest goes, still the first room's alone.
  socket.deliver(ack(first.join.channel, 2));
  const rest = socket.take(MessageKind.Sync);
  expect(rest.length).toBeGreaterThan(0);
  expect(rest.every((sent) => sent.channel === first.join.channel)).toBe(true);
  socket.deliver(ack(first.join.channel, rest.length));
  const [next, ...waiting] = socket.take(MessageKind.Sync);
  expect(waiting).toEqual([]);
  expect(next.channel).toBe(second.join.channel);
  socket.deliver(ack(second.join.channel, 2));
  const later = [next, ...socket.take(MessageKind.Sync)];
  expect(later.every((sent) => sent.channel === second.join.channel)).toBe(
    true
  );
  const server = new Y.Doc();
  expect(applyPieces(server, later)).toMatchObject({
    grouped: true,
    kinds: [SyncKind.Update],
  });
  expect(server.getText('content').toString()).toBe(`k${long}`);
  expect(second.provider.unsyncedChanges).toBe(before + later.length - 2);
  first.provider.destroy();
  second.provider.destroy();
});

it('answers a resync with its step 2 in pieces', async () => {
  const { document, join, provider, socket } = await joined();
  // Offline edits restored before the join: the step 2 carries them.
  document.getText('content').insert(0, 'y'.repeat(5 * 1024 * 1024));
  const server = new Y.Doc();
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(server))
    )
  );
  const [step1, first, ...none] = socket.take(MessageKind.Sync);
  expect(readSync(step1.payload).kind).toBe(SyncKind.Step1);
  expect(none).toEqual([]);
  socket.deliver(ack(join.channel, 1));
  const pieces = [first, ...socket.take(MessageKind.Sync)];
  expect(pieces.length).toBeGreaterThan(2);
  expect(applyPieces(server, pieces)).toEqual({
    grouped: true,
    kinds: [SyncKind.Step2],
    pending: 0,
    small: true,
  });
  expect(server.getText('content').length).toBe(5 * 1024 * 1024);
  expect(isHeld()).toBe(true);
  provider.destroy();
  expect(isHeld()).toBe(false);
});

/**
 * Past the user's 8 MiB burst, pieces wait for the allowance (2 MiB a
 * second) instead of timing the user out, the tab holding back meanwhile,
 * and a frame sent after them (a checkpoint request) waits behind them, and
 * behind the rest that waits for the first piece's ACK (round 4, finding 5).
 */
it('paces pieces under the allowance and keeps later frames behind them', async () => {
  const { document, join, provider, socket } = await syncedRoom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  resetAllowance();
  document.getText('content').insert(0, 'z'.repeat(10 * 1024 * 1024));
  provider.sendStateless('{"type":"checkpoint-request"}');
  expect(socket.take(MessageKind.Sync)).toHaveLength(1);
  expect(socket.take(MessageKind.Stateless)).toEqual([]);
  socket.deliver(ack(join.channel, 1));
  const now = socket.sent.length;
  expect(now).toBeGreaterThan(0);
  expect(socket.take(MessageKind.Stateless)).toEqual([]);
  // At 2 MiB a second the rest goes within about 1.5 s, the request last.
  await vi.advanceTimersByTimeAsync(3000);
  expect(socket.sent.length).toBeGreaterThan(now);
  expect(socket.sent.at(-1)?.kind).toBe(MessageKind.Stateless);
  const rest = socket.take(MessageKind.Sync).length;
  socket.deliver(ack(join.channel, rest));
  expect(isHeld()).toBe(false);
});

/** A user holds at most 22 joined documents (Epo 2026-10-19): a room the
 * server closed as its user's oldest joins again once the user comes back to
 * it (the tab shows again, or an edit here), not at once, which would close
 * their next oldest. */
it('waits after closing as the user’s oldest until the tab shows again or an edit', async () => {
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  vi.stubGlobal('document', page);
  const showing = async (state: string) => {
    page.visibilityState = state;
    page.dispatchEvent(new Event('visibilitychange'));
    await flush();
    return socket.take(MessageKind.Join);
  };
  const { document, events, join, socket } = await syncedRoom();
  const oldest = closedPayload(0, OLDEST_CLOSED_REASON);
  socket.deliver(message(join.channel, MessageKind.Closed, oldest));
  expect(events.closed).not.toHaveBeenCalled();
  await flush();
  expect(socket.take(MessageKind.Join)).toEqual([]);
  expect(await showing('hidden')).toEqual([]);
  const [again] = await showing('visible');
  expect(again).toBeDefined();

  socket.deliver(message(again.channel, MessageKind.Closed, oldest));
  await flush();
  expect(socket.take(MessageKind.Join)).toEqual([]);
  // An update applied to the document (a restored draft) is no edit here.
  const restored = new Y.Doc();
  restored.getText('other').insert(0, 'draft');
  Y.applyUpdate(document, Y.encodeStateAsUpdate(restored), 'restore');
  await flush();
  expect(socket.take(MessageKind.Join)).toEqual([]);
  document.getText('content').insert(0, 'back');
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
});

/** A JOIN costs the server one message of the user's allowance and none of
 * its bytes (rate-limit review r4 N-b): the tab reserves it like the rest. */
it('reserves one message of the allowance for each JOIN', async () => {
  const reserve = vi.spyOn(tabAllowance, 'reserve');
  await joined();
  expect(reserve).toHaveBeenCalledWith(0);
  reserve.mockRestore();
});

/** An update holding a piece over the server's cap (a struct that cannot be
 * cut) never goes: the room stops and closes once instead of looping on
 * timeouts (rate-limit review r3 S8). */
it('stops instead of sending a piece over the server’s cap', async () => {
  const { document, events, socket } = await syncedRoom();
  document.getMap('m').set('blob', new Uint8Array(9 * 1024 * 1024));
  expect(socket.take(MessageKind.Sync)).toEqual([]);
  expect(events.closed).toHaveBeenCalledWith({
    code: 0,
    reason: UPDATE_TOO_LARGE_REASON,
  });
  socket.close();
  FakeSocket.instances.at(-1)?.open();
  await flush();
  expect(
    FakeSocket.instances.flatMap((ws) => ws.take(MessageKind.Join))
  ).toEqual([]);
});

// useSourceSession tells a peer's update from a local edit by
// `origin === provider`: the source provider is the origin of what it applies.
it('applies a peer update with the source provider as its origin', async () => {
  const document = new Y.Doc();
  const origins: unknown[] = [];
  document.on('update', (_update: Uint8Array, origin: unknown) =>
    origins.push(origin)
  );
  const provider = createSourceProvider({
    document,
    name: 'source:f1:epoch:1',
    token: async () => token('t'),
    url: `wss://collab.test/${url++}`,
  });
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await flush();
  const [join] = socket.take(MessageKind.Join);
  const peer = new Y.Doc();
  peer.getText('source').insert(0, 'from a peer');
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(
      join.channel,
      MessageKind.Sync,
      syncMessage(SyncKind.Update, Y.encodeStateAsUpdate(peer))
    )
  );
  expect(document.getText('source').toString()).toBe('from a peer');
  expect(origins).toEqual([provider]);
  // A remote update sends nothing back and leaves nothing unsynced.
  expect(
    socket.take(MessageKind.Sync).map((sent) => readSync(sent.payload).kind)
  ).toEqual([SyncKind.Step1]);
  expect(provider.hasUnsyncedChanges).toBe(false);
  provider.destroy();
});

it('holds joins past the eight the server authenticates at once', async () => {
  const address = `wss://collab.test/${url++}`;
  const rooms = Array.from(
    { length: 10 },
    (_, i) =>
      new RoomProvider({
        document: new Y.Doc(),
        name: `material:m${i}:schema:1`,
        token: async () => token(`token-${i}`),
        url: address,
      })
  );
  for (const room of rooms) room.connect();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await flush();
  // A ninth pending JOIN would close the whole socket (socket.rs).
  const first = socket.take(MessageKind.Join);
  expect(first).toHaveLength(8);
  socket.deliver(
    message(first[0].channel, MessageKind.Joined, Uint8Array.of(1))
  );
  socket.deliver(
    message(
      first[1].channel,
      MessageKind.Refused,
      text('collaboration-forbidden')
    )
  );
  const next = socket.take(MessageKind.Join);
  expect(next).toHaveLength(2);
  expect(new Reader(next[1].payload).varString()).toBe('material:m9:schema:1');
});

// A JOIN during a timeout is answered with the notice instead of JOINED
// (Epo 2026-10-19): each such channel keeps its place among the eight and
// joins again from it when the timeout ends.
it('joins again from its own place after a JOIN answered with a timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const address = `wss://collab.test/${url++}`;
  const rooms = Array.from(
    { length: 8 },
    (_, i) =>
      new RoomProvider({
        document: new Y.Doc(),
        name: `material:t${i}:schema:1`,
        token: async () => token(`token-${i}`),
        url: address,
      })
  );
  for (const room of rooms) room.connect();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  const first = socket.take(MessageKind.Join);
  expect(first).toHaveLength(8);
  const notice = text(
    JSON.stringify({ remainingMs: 1000, type: 'update-timeout' })
  );
  socket.deliver(
    ...first.map((join) => message(join.channel, MessageKind.Stateless, notice))
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(socket.take(MessageKind.Join).map((join) => join.channel)).toEqual(
    first.map((join) => join.channel)
  );
  for (const room of rooms) room.destroy();
});

it('lets the room that joins use the socket its token warmed', async () => {
  const address = `wss://collab.test/${url++}`;
  CollabSocket.warm(address);
  const { join } = await joined({ url: address });
  expect(FakeSocket.instances).toHaveLength(1);
  expect(join).toBeDefined();
});

it('closes a warmed socket no room joined once its hold and the idle delay pass', () => {
  vi.useFakeTimers();
  const address = `wss://collab.test/${url++}`;
  CollabSocket.warm(address);
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  expect(socket.url).toBe(address);
  socket.open();
  // Held 8 s for the room, then the idle close's 5 s.
  vi.advanceTimersByTime(13_000 - 1);
  expect(socket.readyState).toBe(1);
  vi.advanceTimersByTime(1);
  expect(socket.readyState).toBe(3);
});

it('speaks the collaboration server’s client protocol', () => {
  const rust = readFileSync(
    new URL(
      '../../../collaboration-rs/crates/server/src/protocol.rs',
      import.meta.url
    ),
    'utf8'
  );
  expect(rust).toContain(
    `pub const CLIENT_PROTOCOL: u32 = ${CLIENT_PROTOCOL};`
  );
  expect(rust).toContain(`pub const HEARTBEAT: &str = "${HEARTBEAT}";`);
  const every = RUST_HEARTBEAT_MS.exec(rust)?.[1];
  expect(Number(every?.replaceAll('_', ''))).toBe(HEARTBEAT_MS);
});

// The tab's heartbeat (protocol 41): a long frame to the tab holds back the
// server's pings, so an open socket sends `HEARTBEAT` on each of the tab's
// heartbeats (the clock it is given, the tab's in the app), straight on the
// socket, and none before it opens or once it closed. Fails without the
// heartbeat, or if it outlives its socket.
it('sends the heartbeat on each tick while its socket is open, and none once closed', () => {
  const socket = CollabSocket.create(`wss://collab.test/${url++}`, onHeartbeat);
  const room = {
    onMessage() {},
    onResume() {},
    onSleep() {},
    onSocketClose() {},
    onSocketOpen() {},
  };
  socket.attach(room);
  const ws = FakeSocket.instances.at(-1) as FakeSocket;
  tickHeartbeat();
  expect(ws.texts).toEqual([]);
  ws.open();
  tickHeartbeat();
  tickHeartbeat();
  expect(ws.texts).toEqual([HEARTBEAT, HEARTBEAT]);
  ws.close();
  tickHeartbeat();
  expect(ws.texts).toEqual([HEARTBEAT, HEARTBEAT]);
  socket.detach(room);
});

/** The room's presence (Epo 2026-10-20) reaches `onPresence`, never the
 * stateless handler, and goes empty when the channel ends. */
it('hands the room’s presence to onPresence and clears it when the channel ends', async () => {
  const onPresence = vi.fn();
  const { events, join, socket } = await joined({ onPresence });
  const presence = text(
    JSON.stringify({
      connections: [
        {
          avatar: null,
          clients: [7],
          name: 'Bob',
          person: 2,
        },
      ],
      type: 'room-presence',
    })
  );
  socket.deliver(
    message(join.channel, MessageKind.Joined, Uint8Array.of(1)),
    message(join.channel, MessageKind.Stateless, presence)
  );
  expect(onPresence).toHaveBeenCalledWith([
    expect.objectContaining({ clients: [7], name: 'Bob', person: 2 }),
  ]);
  expect(events.stateless).not.toHaveBeenCalled();
  socket.deliver(
    message(join.channel, MessageKind.Closed, closedPayload(4401, 'expired'))
  );
  expect(onPresence).toHaveBeenLastCalledWith([]);
});

/** Idle 60 minutes (Epo 2026-10-20), the page closes its collaboration
 * socket: the room's channel ends with no close or drop reported, nothing
 * reconnects until input, and then it joins again. */
it('ends its channel quietly when the page sleeps and joins again on wake', async () => {
  const onDisconnect = vi.fn();
  const { events, join, provider, socket } = await joined({ onDisconnect });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  const shared = CollabSocket.for(socket.url);
  shared.sleep();
  expect(socket.readyState).toBe(3);
  expect(provider.isAuthenticated).toBe(false);
  expect(events.closed).not.toHaveBeenCalled();
  expect(onDisconnect).not.toHaveBeenCalled();
  expect(FakeSocket.instances).toHaveLength(1);
  shared.wake();
  const next = FakeSocket.instances.at(-1) as FakeSocket;
  expect(next).not.toBe(socket);
  next.open();
  await flush();
  expect(next.take(MessageKind.Join)).toHaveLength(1);
});

// Q549: an update landing in what this document holds deleted is collected
// before Yjs's update event reports it, so an Office engine takes the frame.
it('hands a room update over as it arrived', async () => {
  const frames: Uint8Array[] = [];
  const { document, join, socket } = await joined({
    onFrame: (update) => frames.push(update),
  });
  const peer = new Y.Doc();
  const text = new Y.Text();
  peer.getMap('stories').set('story', text);
  text.insert(0, 'hello');
  const seed = Y.encodeStateAsUpdate(peer);
  socket.deliver(
    message(join.channel, MessageKind.Sync, syncMessage(SyncKind.Update, seed))
  );
  document.getMap('stories').delete('story');
  text.insert(5, ' PEER');
  const typed = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(document));
  const reported: Uint8Array[] = [];
  document.on('update', (update) => reported.push(update));
  frames.length = 0;
  socket.deliver(
    message(join.channel, MessageKind.Sync, syncMessage(SyncKind.Update, typed))
  );
  const strings = (update: Uint8Array) =>
    Y.decodeUpdate(update)
      .structs.map((struct) =>
        struct instanceof Y.Item && struct.content instanceof Y.ContentString
          ? struct.content.str
          : ''
      )
      .join('');
  expect(frames.map(strings)).toEqual([' PEER']);
  expect(reported.map(strings)).toEqual(['']);
});
