import { HocuspocusProvider } from '@hocuspocus/provider';
import { Server } from '@hocuspocus/server';
import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { armTokenExpiry, clearTokenExpiry } from './tokenExpiry.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
});

const TTL_SECONDS = 2;
const expiresAt = () => Math.floor(Date.now() / 1000) + TTL_SECONDS;

async function serve(refresh: boolean) {
  const synced: string[] = [];
  const server = new Server({
    address: '127.0.0.1',
    async connected({ connection }) {
      armTokenExpiry(connection, 1000);
      connection.onClose(() => clearTokenExpiry(connection));
    },
    async onAuthenticate() {
      return { expiresAt: expiresAt() };
    },
    async onTokenSync({ connection, token }) {
      if (!refresh) throw new Error('refused');
      synced.push(token);
      connection.context = { expiresAt: expiresAt() };
      armTokenExpiry(connection, 1000);
    },
    port: 0,
    quiet: true,
  });
  servers.push(server);
  await server.listen();
  return { server, synced };
}

function open(server: Server) {
  const document = new Y.Doc();
  let issued = 0;
  const closed: string[] = [];
  const provider = new HocuspocusProvider({
    document,
    name: 'material:token:schema:1',
    onClose: () => closed.push('close'),
    token: () => `token-${++issued}`,
    url: server.webSocketURL,
  });
  return { closed, document, provider };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('keeps a room open past token expiry by refreshing the token in band', async () => {
  const { server, synced } = await serve(true);
  const { closed, document, provider } = open(server);
  await wait(3500);
  document.getText('probe').insert(0, 'late edit');
  await wait(300);
  const room = server.hocuspocus.documents.get('material:token:schema:1');
  expect(room?.getText('probe').toString()).toBe('late edit');
  expect(synced.length).toBeGreaterThan(0);
  expect(closed).toEqual([]);
  provider.destroy();
}, 10_000);

it('closes the room at expiry when the refreshed token is refused', async () => {
  const { server } = await serve(false);
  const { closed, provider } = open(server);
  await wait(2500);
  expect(closed.length).toBeGreaterThan(0);
  expect(provider.isAuthenticated).toBe(false);
  provider.destroy();
}, 10_000);
