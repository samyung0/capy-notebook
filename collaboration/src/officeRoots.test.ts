import { HocuspocusProvider } from '@hocuspocus/provider';
import { type Connection, Server } from '@hocuspocus/server';
import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  endOfficeResync,
  OFFICE_UPDATE_UNHELD,
  officeUpdateViolation,
  resyncOfficeConnection,
} from './officeRoots.js';
import { inboundYjsUpdate } from './yjsUpdateMessage.js';

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
      if (verdict === OFFICE_UPDATE_UNHELD) resyncOfficeConnection(connection);
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
    expect(verdicts).toContain(OFFICE_UPDATE_UNHELD);
    expect(
      verdicts.every(
        (verdict) => verdict === null || verdict === OFFICE_UPDATE_UNHELD
      )
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

// A writer the handoff made read-only stays read-only through a resync.
test('a read-only connection is not resynced or made writable', () => {
  const connection = { readOnly: true, send: vi.fn() };
  resyncOfficeConnection(connection as unknown as Connection);
  endOfficeResync(connection as unknown as Connection);
  expect(connection.readOnly).toBe(true);
  expect(connection.send).not.toHaveBeenCalled();
});
