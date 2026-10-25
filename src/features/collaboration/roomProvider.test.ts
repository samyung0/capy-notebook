import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSourceProvider } from '@/features/files/sourceProvider';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import { draftsVersion, readDrafts, recordDrafts } from '@/lib/editDrafts';
import { resetAllowance, tabAllowance } from './allowance';
import { isHeld } from './held';
import { NoteSeat } from './noteSeat';
import { PIECE_BYTES } from './pieces';
import {
  CLIENT_PROTOCOL,
  closedPayload,
  decodeFrame,
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
import {
  EMBED_CLOSED_REASON,
  OLDEST_CLOSED_REASON,
  RoomProvider,
  UPDATE_TOO_LARGE_REASON,
} from './roomProvider';
import { CollabSocket } from './socket';

vi.mock('@/api/auth', () => ({ USE_MSW: false }));

/** An in-page WebSocket the test plays the server through. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Message[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(bytes: Uint8Array) {
    this.sent.push(...decodeFrame(bytes));
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

it('joins with its token, syncs both ways and counts unacknowledged updates', async () => {
  const { document, events, join, provider, socket } = await joined();
  const reader = new Reader(join.payload);
  expect(reader.varString()).toBe('material:m1:schema:1');
  expect(reader.varString()).toBe(token('token-1'));
  // The version gate: the build's client protocol follows the token, then
  // the client id the document took from it (Q213) and the stored version
  // it holds (none: a new document).
  expect(reader.varUint()).toBe(CLIENT_PROTOCOL);
  expect(reader.varUint()).toBe(clientIdOf('token-1'));
  expect(reader.varUint()).toBe(0);
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

it('presents its previous token for 70 s of client id refusals, then asks for fresh ids', async () => {
  // r2 S2: a live channel holds the ids, as a dropped socket's does until
  // the server closes it (60 s); past that, two sessions presented one token.
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const asked: (string | undefined)[] = [];
    const { join, provider, socket } = await joined({
      token: async (previous) => {
        asked.push(previous);
        return token('t1');
      },
    });
    const refuse = async (channel: number, after: number) => {
      vi.setSystemTime(Date.now() + after);
      socket.deliver(
        message(channel, MessageKind.Refused, text('collaboration-client-id'))
      );
      provider.disconnect();
      provider.connect();
      await flush();
      return socket.take(MessageKind.Join)[0];
    };
    const second = await refuse(join.channel, 0);
    const third = await refuse(second.channel, 69_000);
    expect(asked).toEqual([undefined, token('t1'), token('t1')]);
    await refuse(third.channel, 1000);
    expect(asked.at(-1)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
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

// In-place collection (Epo 2026-10-23): a tab acknowledges each store's
// version, but never above the version its oldest unsent edit was made at,
// so no collection passes what that edit names.
it('acknowledges stored versions, never above its oldest unsent edit', async () => {
  const { document, join, provider, socket } = await synced();
  const channel = join.channel;
  // Its step 2 is in flight, made at version 0.
  socket.deliver(stored(channel, 5));
  expect(acks(socket)).toEqual([0]);
  socket.deliver(ack(channel, 1), stored(channel, 6));
  expect(acks(socket)).toEqual([6]);
  // An edit made at 6, unacknowledged when 7 is stored.
  document.getText('content').insert(0, 'a');
  socket.deliver(stored(channel, 7));
  expect(acks(socket)).toEqual([6]);
  socket.deliver(ack(channel, 1), stored(channel, 8));
  expect(acks(socket)).toEqual([8]);
  // Held for a resend: the channel ends with an edit in flight, and the
  // next JOIN names the version it was made at.
  document.getText('content').insert(0, 'b');
  socket.deliver(stored(channel, 9));
  expect(acks(socket)).toEqual([8]);
  provider.disconnect();
  document.getText('content').insert(0, 'c');
  expect(provider.reportedVersion).toBe(8);
  provider.connect();
  await flush();
  const [rejoin] = socket.take(MessageKind.Join);
  expect(joinVersion(rejoin)).toBe(8);
  provider.destroy();
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
  const { join, provider, socket } = await joined({ unsentFrom: 3 });
  expect(joinVersion(join)).toBe(3);
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
    ),
    stored(join.channel, 9)
  );
  expect(acks(socket)).toEqual([3]);
  socket.deliver(ack(join.channel, 1), stored(join.channel, 10));
  expect(acks(socket)).toEqual([10]);
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
  // Its stored version (none: new), then its note's channel.
  expect(reader.varUint()).toBe(0);
  expect(reader.varUint()).toBe(noteJoin.channel);
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
  expect(second.payload.at(-1)).toBe(noteAgain.channel);
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

/** The SYNC frames `sent` applied to `server` in order: their kinds, the
 * largest piece, and after how many something was pending. */
function applyPieces(server: Y.Doc, sent: Message[]) {
  const kinds = new Set<number>();
  let largest = 0;
  let pending = 0;
  for (const { payload } of sent) {
    const sync = readSync(payload);
    kinds.add(sync.kind);
    largest = Math.max(largest, sync.body.byteLength);
    Y.applyUpdate(server, sync.body);
    if (server.store.pendingStructs) pending += 1;
  }
  return { kinds: [...kinds], pending, small: largest <= PIECE_BYTES };
}

it('sends an update over 2 MiB in ordered pieces and holds the tab back until the last is acknowledged', async () => {
  const { document, join, provider, server, socket } = await syncedRoom();
  const long = 'x'.repeat(5 * 1024 * 1024);
  document.getText('content').insert(0, long);
  const pieces = socket.take(MessageKind.Sync);
  expect(pieces.length).toBeGreaterThan(2);
  expect(applyPieces(server, pieces)).toEqual({
    kinds: [SyncKind.Update],
    pending: 0,
    small: true,
  });
  expect(server.getText('content').toString()).toBe(long);
  expect(isHeld()).toBe(true);
  expect(provider.unsyncedChanges).toBe(pieces.length);
  // Each piece is acknowledged on its own; the hold ends with the last.
  socket.deliver(
    message(
      join.channel,
      MessageKind.Ack,
      new Writer().varUint(pieces.length - 1).done()
    )
  );
  expect(isHeld()).toBe(true);
  socket.deliver(
    message(join.channel, MessageKind.Ack, new Writer().varUint(1).done())
  );
  expect(isHeld()).toBe(false);
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
  const [step1, ...pieces] = socket.take(MessageKind.Sync);
  expect(readSync(step1.payload).kind).toBe(SyncKind.Step1);
  expect(pieces.length).toBeGreaterThan(2);
  expect(applyPieces(server, pieces)).toEqual({
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
 * and a frame sent after them (a checkpoint request) waits behind them.
 */
it('paces pieces under the allowance and keeps later frames behind them', async () => {
  const { document, join, provider, socket } = await syncedRoom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  resetAllowance();
  document.getText('content').insert(0, 'z'.repeat(10 * 1024 * 1024));
  provider.sendStateless('{"type":"checkpoint-request"}');
  const now = socket.sent.length;
  expect(now).toBeGreaterThan(0);
  expect(socket.take(MessageKind.Stateless)).toEqual([]);
  // At 2 MiB a second the rest goes within about 1.5 s, the request last.
  await vi.advanceTimersByTimeAsync(3000);
  expect(socket.sent.length).toBeGreaterThan(now);
  expect(socket.sent.at(-1)?.kind).toBe(MessageKind.Stateless);
  const sent = socket.take(MessageKind.Sync).length + now;
  socket.deliver(
    message(join.channel, MessageKind.Ack, new Writer().varUint(sent).done())
  );
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
