import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
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
import { RoomProvider } from './roomProvider';

/** An in-page WebSocket the test plays the server through. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Message[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(bytes: Uint8Array) {
    this.sent.push(...decodeFrame(bytes));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
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

let url = 0;
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
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
