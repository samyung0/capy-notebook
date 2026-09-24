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
});
