import { HocuspocusProvider } from '@hocuspocus/provider';
import { type Connection, Server } from '@hocuspocus/server';
import { slateNodesToInsertDelta } from '@slate-yjs/core';
import type { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  endOfficeResync,
  MAX_UNPLACED_STEPS,
  officeUpdateViolation,
  placedUpdate,
  resyncOfficeConnection,
  resyncUnheld,
  sourceUpdateUnheld,
  UPDATE_UNHELD,
} from './officeRoots.js';
import { YjsDocumentStore } from './persistence.js';
import { inboundYjsSync, inboundYjsUpdate } from './yjsUpdateMessage.js';

// An instance died before persisting a client's last typing, and the room
// reloaded without it. The client's next keystroke, sent before its sync step
// 2, refers to text the room does not hold: it is dropped, not refused, and
// comes back with the connection's own first sync (its step 2 carries
// everything the room lacks), so nothing is lost and the connection stays up.
// The extra step 1 the resync sends is a safeguard this ordering never needs.
test('a keystroke ahead of the sync after a room reload is resynced, not refused', async () => {
  const seed = new Y.Doc();
  seed.clientID = 1;
  seed.getText('stories').insert(0, 'hello');
  const seedState = Y.encodeStateAsUpdate(seed);
  const client = new Y.Doc();
  Y.applyUpdate(client, seedState);
  client.getText('stories').insert(5, ' world'); // lost with the instance
  const verdicts: (string | null)[] = [];
  // The same wiring as server.ts: beforeHandleMessage and afterHandleMessage.
  const server = new Server({
    address: '127.0.0.1',
    async afterHandleMessage({ connection }) {
      endOfficeResync(connection);
    },
    async beforeHandleMessage({ connection, document, update }) {
      const yjsUpdate = inboundYjsUpdate(update);
      if (!yjsUpdate) return;
      const verdict = officeUpdateViolation(document, yjsUpdate, 'docx', [
        'stories',
      ]);
      verdicts.push(verdict);
      if (verdict === UPDATE_UNHELD) resyncOfficeConnection(connection);
      else if (verdict) throw new Error(verdict);
    },
    async onLoadDocument({ document }) {
      Y.applyUpdate(document, seedState);
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  let typed = false;
  const provider = new HocuspocusProvider({
    document: client,
    name: 'source:f:epoch:1',
    // Typed as the socket opens, so it reaches the room before any sync.
    onOpen: () => {
      if (typed) return;
      typed = true;
      client.getText('stories').insert(11, '!');
    },
    token: 'token',
    url: server.webSocketURL,
  });
  try {
    await vi.waitFor(
      () => {
        const room = server.hocuspocus.documents.get('source:f:epoch:1');
        expect(room?.getText('stories').toString()).toBe('hello world!');
        expect(provider.hasUnsyncedChanges).toBe(false);
      },
      { timeout: 10_000 }
    );
    expect(verdicts).toContain(UPDATE_UNHELD);
    expect(
      verdicts.every((verdict) => verdict === null || verdict === UPDATE_UNHELD)
    ).toBe(true);
    // Still the same authenticated connection: no close, no recovery.
    expect(provider.isAuthenticated).toBe(true);
    expect(
      server.hocuspocus.documents.get('source:f:epoch:1')?.getConnectionsCount()
    ).toBe(1);
  } finally {
    provider.destroy();
    await server.destroy();
  }
}, 20_000);

// A client that reconnects keeps typing before its sync step 2. A keystroke
// at a position the room holds still depends on the client's earlier typing
// (Yjs integrates a client's clocks in order): applied, it would stay pending
// and make the room unsavable, which resets it and discards every edit since
// the last checkpoint. It is resynced instead, and the room never holds
// pending content.
test('a keystroke past a dropped one is resynced, never left pending', async () => {
  const seed = new Y.Doc();
  seed.clientID = 1;
  seed.getText('stories').insert(0, 'hello');
  const seedState = Y.encodeStateAsUpdate(seed);
  const client = new Y.Doc();
  Y.applyUpdate(client, seedState);
  client.getText('stories').insert(5, ' world'); // never reached the room
  const verdicts: (string | null)[] = [];
  let pending = false;
  const server = new Server({
    address: '127.0.0.1',
    async afterHandleMessage({ connection, document }) {
      endOfficeResync(connection);
      if (document.store.pendingStructs || document.store.pendingDs)
        pending = true;
    },
    async beforeHandleMessage({ connection, document, update }) {
      const yjsUpdate = inboundYjsUpdate(update);
      if (!yjsUpdate) return;
      const verdict = officeUpdateViolation(document, yjsUpdate, 'docx', [
        'stories',
      ]);
      verdicts.push(verdict);
      if (verdict === UPDATE_UNHELD) resyncOfficeConnection(connection);
      else if (verdict) throw new Error(verdict);
    },
    async onLoadDocument({ document }) {
      Y.applyUpdate(document, seedState);
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  let typed = false;
  const provider = new HocuspocusProvider({
    document: client,
    name: 'source:f:epoch:1',
    // At the start, next to text the room holds.
    onOpen: () => {
      if (typed) return;
      typed = true;
      client.getText('stories').insert(0, '>');
    },
    token: 'token',
    url: server.webSocketURL,
  });
  try {
    await vi.waitFor(
      () => {
        const room = server.hocuspocus.documents.get('source:f:epoch:1');
        expect(room?.getText('stories').toString()).toBe('>hello world');
        expect(provider.hasUnsyncedChanges).toBe(false);
      },
      { timeout: 10_000 }
    );
    expect(verdicts).toContain(UPDATE_UNHELD);
    expect(pending).toBe(false);
    expect(provider.isAuthenticated).toBe(true);
  } finally {
    provider.destroy();
    await server.destroy();
  }
}, 20_000);

test('an update the room cannot integrate in order is unheld', () => {
  const room = new Y.Doc();
  room.clientID = 1;
  room.getText('stories').insert(0, 'hello');
  const client = new Y.Doc();
  client.clientID = 2;
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
  const delta = (edit: () => void) => {
    const before = Y.encodeStateVector(client);
    edit();
    return Y.encodeStateAsUpdate(client, before);
  };
  const verdict = (update: Uint8Array) =>
    officeUpdateViolation(room, update, 'docx', ['stories']);
  const typed = delta(() => client.getText('stories').insert(5, ' world'));
  // The room never got `typed`: a keystroke elsewhere skips its clocks, and
  // deleting part of it refers to nothing the room holds.
  expect(verdict(delta(() => client.getText('stories').insert(0, '>')))).toBe(
    UPDATE_UNHELD
  );
  expect(verdict(delta(() => client.getText('stories').delete(6, 2)))).toBe(
    UPDATE_UNHELD
  );
  // Once it arrives, the same kind of keystroke goes in.
  Y.applyUpdate(room, typed);
  expect(verdict(delta(() => client.getText('stories').insert(0, '<')))).toBe(
    UPDATE_UNHELD // still behind the '>' and the deletion
  );
  Y.applyUpdate(room, Y.encodeStateAsUpdate(client, Y.encodeStateVector(room)));
  expect(verdict(delta(() => client.getText('stories').insert(0, '!')))).toBe(
    null
  );
});

// A note room takes the same resync through validateUpdate, wired as in
// server.ts: the keystroke is refused before it is copied or integrated, and
// the client's step 2 brings both edits in.
test('a note keystroke past a dropped one is resynced, never left pending', async () => {
  const seed = new Y.Doc();
  seed
    .get('content', Y.XmlText)
    .applyDelta(
      slateNodesToInsertDelta([
        { children: [{ text: 'hello' }], type: 'p' },
      ] as never)
    );
  const seedState = Y.encodeStateAsUpdate(seed);
  const paragraph = (doc: Y.Doc) =>
    doc.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText;
  const client = new Y.Doc();
  Y.applyUpdate(client, seedState);
  paragraph(client).insert(5, ' world'); // never reached the room
  const store = new YjsDocumentStore({} as Pool);
  const verdicts: (string | undefined)[] = [];
  let pending = false;
  const server = new Server({
    address: '127.0.0.1',
    async afterHandleMessage({ connection, document }) {
      endOfficeResync(connection);
      if (document.store.pendingStructs || document.store.pendingDs)
        pending = true;
    },
    async beforeHandleMessage({ connection, document, update }) {
      const sync = inboundYjsSync(update);
      if (!sync) return;
      const verdict = store.validateUpdate(
        document.name,
        document,
        sync.update
      );
      verdicts.push(verdict);
      if (verdict === UPDATE_UNHELD)
        resyncUnheld(connection, sync.step2, 'note');
      else placedUpdate(connection);
    },
    async onLoadDocument({ document }) {
      Y.applyUpdate(document, seedState);
    },
    port: 0,
    quiet: true,
  });
  await server.listen();
  let typed = false;
  const provider = new HocuspocusProvider({
    document: client,
    name: 'material:note:schema:1',
    onOpen: () => {
      if (typed) return;
      typed = true;
      paragraph(client).insert(0, '>');
    },
    token: 'token',
    url: server.webSocketURL,
  });
  try {
    await vi.waitFor(
      () => {
        const room = server.hocuspocus.documents.get('material:note:schema:1');
        expect(room && paragraph(room).toString()).toBe('>hello world');
        expect(provider.hasUnsyncedChanges).toBe(false);
      },
      { timeout: 10_000 }
    );
    expect(verdicts).toContain(UPDATE_UNHELD);
    expect(pending).toBe(false);
    expect(provider.isAuthenticated).toBe(true);
  } finally {
    provider.destroy();
    await server.destroy();
  }
}, 20_000);

// A writer the handoff made read-only stays read-only through a resync.
test('a read-only connection is not resynced or made writable', () => {
  const connection = { readOnly: true, send: vi.fn() };
  resyncOfficeConnection(connection as unknown as Connection);
  endOfficeResync(connection as unknown as Connection);
  expect(connection.readOnly).toBe(true);
  expect(connection.send).not.toHaveBeenCalled();
});

// Text rooms have no root rule but the same ordering one.
test("a text update that skips its client's clocks is unheld", () => {
  const room = new Y.Doc();
  room.getText('source').insert(0, 'hello');
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
  client.getText('source').insert(5, '!'); // never reached the room
  const vector = Y.encodeStateVector(client);
  client.getText('source').insert(0, '>');
  expect(sourceUpdateUnheld(room, Y.encodeStateAsUpdate(client, vector))).toBe(
    true
  );
  expect(
    sourceUpdateUnheld(
      room,
      Y.encodeStateAsUpdate(client, Y.encodeStateVector(room))
    )
  ).toBe(false);
});

// A step 2 that cannot be placed means the client holds content out of
// order; resyncing it again would loop, so the connection closes instead.
test.each(['source', 'note'] as const)(
  '%s step 2 replies the room cannot place close the connection',
  (kind) => {
    const document = Object.assign(new Y.Doc(), { name: `${kind}:f:1` });
    const connection = {
      context: { userId: 'u_writer' },
      document,
      messageAddress: `${kind}:f:1`,
      readOnly: false,
      send: vi.fn(),
      socketId: 'socket-1',
    } as unknown as Connection;
    const lines: unknown[] = [];
    const record = (...args: unknown[]) => {
      lines.push(...args);
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(record);
    const infos = vi.spyOn(console, 'info').mockImplementation(record);
    // Keystrokes ahead of a sync resync without limit.
    for (let index = 0; index < 5; index += 1) {
      resyncUnheld(connection, false, kind);
      endOfficeResync(connection);
    }
    for (let index = 1; index < MAX_UNPLACED_STEPS; index += 1) {
      resyncUnheld(connection, true, kind);
      endOfficeResync(connection);
    }
    expect(MAX_UNPLACED_STEPS).toBe(2);
    expect(() => resyncUnheld(connection, true, kind)).toThrow(
      `${kind} sync step 2 cannot be placed in the room`
    );
    // One greppable line names the room, the writer and the socket.
    const line = lines
      .map(String)
      .find((entry) => entry.includes(`${kind}_step2_unplaced`));
    expect(line).toContain('u_writer');
    expect(line).toContain('socket-1');
    expect(line).toContain(`${kind}:f:1`);
    errors.mockRestore();
    infos.mockRestore();
    // A placed update starts the count over.
    placedUpdate(connection);
    expect(() => resyncUnheld(connection, true, kind)).not.toThrow();
  }
);
