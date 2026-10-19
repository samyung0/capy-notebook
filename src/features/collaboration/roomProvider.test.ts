import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSourceProvider } from '@/features/files/sourceProvider';
import type { DraftMessage, DraftReply } from '@/lib/draftStore';
import { readDrafts, recordDrafts } from '@/lib/editDrafts';
import { resetAllowance } from './allowance';
import { isHeld } from './held';
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
    token: async () => 'token-1',
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

it('joins with its token, syncs both ways and counts unacknowledged updates', async () => {
  const { document, events, join, provider, socket } = await joined();
  const reader = new Reader(join.payload);
  expect(reader.varString()).toBe('material:m1:schema:1');
  expect(reader.varString()).toBe('token-1');
  // The version gate: the build's client protocol follows the token.
  expect(reader.varUint()).toBe(CLIENT_PROTOCOL);
  expect(reader.done).toBe(true);
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

it('reports a closed room while the socket stays open for others', async () => {
  const { events, join, provider, socket } = await joined();
  const other = new RoomProvider({
    document: new Y.Doc(),
    name: 'material:m2:schema:1',
    token: async () => 'token-2',
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

it('answers a token request in band', async () => {
  let token = 'token-1';
  const { join, socket } = await joined({ token: async () => token });
  socket.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  token = 'token-2';
  socket.deliver(message(join.channel, MessageKind.TokenRequest));
  await flush();
  const [answer] = socket.take(MessageKind.Token);
  expect(new Reader(answer.payload).varString()).toBe('token-2');
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

it('ends the room when the socket drops and rejoins once it reopens', async () => {
  vi.useFakeTimers();
  const document = new Y.Doc();
  const onClose = vi.fn();
  const provider = new RoomProvider({
    document,
    name: 'material:m1:schema:1',
    onClose,
    token: async () => 't',
    url: `wss://collab.test/${url++}`,
  });
  provider.connect();
  const first = FakeSocket.instances.at(-1) as FakeSocket;
  first.open();
  await vi.advanceTimersByTimeAsync(0);
  const [join] = first.take(MessageKind.Join);
  first.deliver(message(join.channel, MessageKind.Joined, Uint8Array.of(1)));
  first.close();
  expect(onClose).toHaveBeenCalled();
  expect(provider.isConnected).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  const second = FakeSocket.instances.at(-1) as FakeSocket;
  expect(second).not.toBe(first);
  second.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(second.take(MessageKind.Join)).toHaveLength(1);
});

it('in a timeout holds its edits, then joins again on the same socket and resyncs them, its drafts kept', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const document = new Y.Doc();
  const key = 'u_1:material:timeout';
  const onStateless = vi.fn();
  const provider: RoomProvider = new RoomProvider({
    document,
    name: 'material:m1:schema:1',
    onStateless,
    token: async () => 't',
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
  document.getText('content').insert(0, 'back');
  await flush();
  expect(socket.take(MessageKind.Join)).toHaveLength(1);
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
    token: async () => 't',
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
        token: async () => `token-${i}`,
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
        token: async () => `token-${i}`,
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
