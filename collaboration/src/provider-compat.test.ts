import { HocuspocusProvider } from '@hocuspocus/provider';
import { Server } from '@hocuspocus/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

const servers: Server[] = [];

function synced(provider: HocuspocusProvider) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('provider did not sync')),
      5000
    );
    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
});

describe('v3 provider and v4 server compatibility', () => {
  it('converges writes and rejects read-access document updates', async () => {
    const server = new Server({
      address: '127.0.0.1',
      async onAuthenticate({ connectionConfig, token }) {
        if (token !== 'write' && token !== 'read') throw new Error('denied');
        connectionConfig.readOnly = token === 'read';
      },
      port: 0,
      quiet: true,
    });
    servers.push(server);
    await server.listen();

    const writerDocument = new Y.Doc();
    const writer = new HocuspocusProvider({
      document: writerDocument,
      name: 'material:test:schema:1',
      token: 'write',
      url: server.webSocketURL,
    });
    await synced(writer);
    writerDocument.getText('probe').insert(0, 'writer');

    const readerDocument = new Y.Doc();
    const reader = new HocuspocusProvider({
      document: readerDocument,
      name: 'material:test:schema:1',
      token: 'read',
      url: server.webSocketURL,
    });
    await synced(reader);
    expect(readerDocument.getText('probe').toString()).toBe('writer');

    readerDocument.getText('probe').insert(6, '-reader');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(writerDocument.getText('probe').toString()).toBe('writer');

    reader.destroy();
    writer.destroy();
  });

  it('applies edits a client holds before a request it sends at synced', async () => {
    // A reopened editor applies its stored edits before connecting, and a
    // reconnecting one resends its checkpoint requests at `synced`; either
    // way a receipt counts as covering those edits. That holds because the
    // server answers a client's step 1 with its own step 1 first (the
    // client's step 2 carries the edits) and handles a connection's messages
    // in order. A request sent once authenticated comes before that step 2,
    // so a store answering it would miss the edits: the editors wait for
    // `synced`.
    const seen = new Map<string, string>();
    const server = new Server({
      address: '127.0.0.1',
      async onStateless({ document, payload }) {
        seen.set(payload, document.getText('probe').toString());
      },
      port: 0,
      quiet: true,
    });
    servers.push(server);
    await server.listen();
    const document = new Y.Doc();
    document.getText('probe').insert(0, 'restored');
    const provider = new HocuspocusProvider({
      document,
      name: 'material:offline:schema:1',
      onAuthenticated: () => provider.sendStateless('authenticated'),
      token: 'write',
      url: server.webSocketURL,
    });
    await new Promise<void>((resolve) =>
      provider.on('synced', () => {
        provider.sendStateless('synced');
        resolve();
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(Object.fromEntries(seen)).toEqual({
      authenticated: '',
      synced: 'restored',
    });
    provider.destroy();
  });
});
