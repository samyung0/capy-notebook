import { HocuspocusProvider } from '@hocuspocus/provider';
import { Server } from '@hocuspocus/server';
import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { accessRecheck, writerRecheck } from './accessRecheck.js';
import { CollaborationReadOnlyError } from './persistence.js';
import { inboundYjsUpdate } from './yjsUpdateMessage.js';

test('a connection is revalidated at most once per interval, and a refusal is not remembered', async () => {
  let now = 0;
  const recheck = accessRecheck(5000, () => now);
  const connection = {};
  const check = vi.fn(async () => undefined);
  await recheck(connection, check);
  now = 4999;
  await recheck(connection, check);
  expect(check).toHaveBeenCalledTimes(1);
  await recheck({}, check);
  expect(check).toHaveBeenCalledTimes(2);
  now = 5000;
  const refused = vi.fn(async () => {
    throw new Error('revoked');
  });
  await expect(recheck(connection, refused)).rejects.toThrow('revoked');
  now = 5001;
  await expect(recheck(connection, refused)).rejects.toThrow('revoked');
  expect(refused).toHaveBeenCalledTimes(2);
});

test('a writer that froze is closed with room-read-only while its co-editor stays connected', async () => {
  const frozen = new Set<string>();
  const recheck = writerRecheck(0);
  const server = new Server({
    address: '127.0.0.1',
    async beforeHandleMessage({ connection, documentName, update }) {
      if (!inboundYjsUpdate(update)) return;
      const { userId } = connection.context as { userId: string };
      await recheck(connection, documentName, async () => {
        if (frozen.has(userId)) throw new CollaborationReadOnlyError('frozen');
      });
    },
    async onAuthenticate({ token }) {
      if (frozen.has(token)) throw new CollaborationReadOnlyError('frozen');
      return { userId: token };
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  const name = 'material:m:schema:1';
  const open = (userId: string, onStateless = (_: string) => {}) => {
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({
      document,
      name,
      onStateless: ({ payload }) => onStateless(payload),
      token: userId,
      url: server.webSocketURL,
    });
    return { document, provider };
  };
  const statelessFor = new Map<string, string[]>();
  const heard = (userId: string) => (payload: string) =>
    statelessFor.set(userId, [...(statelessFor.get(userId) ?? []), payload]);
  const alice = open('alice', heard('alice'));
  const bob = open('bob', heard('bob'));
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done(); waited += 20) {
      if (waited > 5000) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await until(() => alice.provider.isSynced && bob.provider.isSynced);
    frozen.add('bob');
    bob.document.getText('t').insert(0, 'late');
    await until(() => (statelessFor.get('bob') ?? []).length > 0);
    expect(JSON.parse(statelessFor.get('bob')![0])).toEqual({
      room: name,
      type: 'room-read-only',
    });
    alice.document.getText('t').insert(0, 'alice');
    const live = () => server.hocuspocus.documents.get(name);
    await until(() => live()?.getText('t').toString() === 'alice');
    expect(statelessFor.get('alice')).toBeUndefined();
    expect(live()?.getConnectionsCount()).toBe(1);
  } finally {
    alice.provider.destroy();
    bob.provider.destroy();
    await server.destroy();
  }
});

test('an owner reaching its storage limit closes every writer in its room with room-read-only', async () => {
  // Both writers share the storage owner, so the recheck refuses each of them.
  let ownerFull = false;
  const recheck = writerRecheck(0);
  const server = new Server({
    address: '127.0.0.1',
    async beforeHandleMessage({ connection, documentName, update }) {
      if (!inboundYjsUpdate(update)) return;
      await recheck(connection, documentName, async () => {
        if (ownerFull) throw new CollaborationReadOnlyError('owner full');
      });
    },
    async onAuthenticate({ token }) {
      return { userId: token };
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  const name = 'material:m:schema:1';
  const heard = new Map<string, string[]>();
  const open = (userId: string) => {
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({
      document,
      name,
      onStateless: ({ payload }) =>
        heard.set(userId, [...(heard.get(userId) ?? []), payload]),
      token: userId,
      url: server.webSocketURL,
    });
    return { document, provider };
  };
  const alice = open('alice');
  const bob = open('bob');
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done(); waited += 20) {
      if (waited > 5000) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await until(() => alice.provider.isSynced && bob.provider.isSynced);
    ownerFull = true;
    alice.document.getText('t').insert(0, 'a');
    bob.document.getText('t').insert(0, 'b');
    await until(() => heard.has('alice') && heard.has('bob'));
    for (const userId of ['alice', 'bob'])
      expect(JSON.parse(heard.get(userId)![0])).toEqual({
        room: name,
        type: 'room-read-only',
      });
    await until(
      () =>
        (server.hocuspocus.documents.get(name)?.getConnectionsCount() ?? 0) ===
        0
    );
  } finally {
    alice.provider.destroy();
    bob.provider.destroy();
    await server.destroy();
  }
});
