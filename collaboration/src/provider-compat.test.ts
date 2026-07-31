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
  it('converges writes and rejects commenter document updates', async () => {
    const server = new Server({
      address: '127.0.0.1',
      async onAuthenticate({ connectionConfig, token }) {
        if (token !== 'write' && token !== 'comment') throw new Error('denied');
        connectionConfig.readOnly = token === 'comment';
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

    const commenterDocument = new Y.Doc();
    const commenter = new HocuspocusProvider({
      document: commenterDocument,
      name: 'material:test:schema:1',
      token: 'comment',
      url: server.webSocketURL,
    });
    await synced(commenter);
    expect(commenterDocument.getText('probe').toString()).toBe('writer');

    commenterDocument.getText('probe').insert(6, '-commenter');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(writerDocument.getText('probe').toString()).toBe('writer');

    commenter.destroy();
    writer.destroy();
  });
});
