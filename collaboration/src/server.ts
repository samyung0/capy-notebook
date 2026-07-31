import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server } from '@hocuspocus/server';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Redis as IORedis } from 'ioredis';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  assertAllowedOrigin,
  claimsContext,
  type CollaborationContext,
  verifyCollaborationToken,
} from './auth.js';
import { loadConfig } from './config.js';
import {
  applyCollaborationCommand,
  isCollaborationCommand,
} from './commands.js';
import { materialIdFromRoom, YjsDocumentStore } from './persistence.js';
import { ProjectionService } from './projection.js';

const config = loadConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  statement_timeout: 15_000,
});
const redis = new IORedis(config.redisUrl, {
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});
const subscriber = new IORedis(config.redisUrl, {
  enableReadyCheck: true,
  maxRetriesPerRequest: null,
});
const store = new YjsDocumentStore(pool);
const projections = new ProjectionService(store, config.apiUrl, config.secret);
const failedStores = new Map<string, Uint8Array>();
let authenticationFailures = 0;
let storeFailures = 0;

function secretMatches(value: string | undefined) {
  if (!value) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(config.secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('command body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = new Server<CollaborationContext>({
  address: config.host,
  debounce: config.debounceMs,
  extensions: [
    new RedisExtension({
      awaitInitialSyncTimeout: 1000,
      redis,
    }),
  ],
  maxDebounce: config.maxDebounceMs,
  maxPendingDocuments: 8,
  maxUnauthenticatedQueueMessages: 64,
  maxUnauthenticatedQueueSize: 512 * 1024,
  quiet: true,
  stopOnSignals: false,
  unloadImmediately: false,
  websocketOptions: { maxPayload: config.maxPayloadBytes },
  yDocOptions: { gc: true, gcFilter: () => true },
  async onAuthenticate({ connectionConfig, documentName, request, token }) {
    try {
      assertAllowedOrigin(request, config.allowedOrigins);
      const claims = verifyCollaborationToken(
        token,
        config.secret,
        documentName
      );
      connectionConfig.readOnly = claims.access === 'comment';
      return claimsContext(claims);
    } catch (error) {
      authenticationFailures += 1;
      console.warn(
        'collaboration authentication rejected:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  },
  async onTokenSync({ connection, documentName, token }) {
    const claims = verifyCollaborationToken(token, config.secret, documentName);
    connection.context = claimsContext(claims);
    connection.readOnly = claims.access === 'comment';
  },
  async onLoadDocument({ document, documentName }) {
    await store.load(documentName, document);
  },
  async onStoreDocument({ document, documentName, lastContext }) {
    try {
      const stored = await store.store(documentName, document);
      failedStores.delete(documentName);
      const materialId = materialIdFromRoom(documentName);
      document.broadcastStateless(
        JSON.stringify({
          checkpointIds: stored.checkpointIds,
          materialId,
          type: 'checkpoint-persisted',
          yjsVersion: stored.version,
        })
      );
      const projection = projections.project(
        materialId,
        stored.version,
        stored.content,
        stored.checkpointIds
      );
      void projection
        .then(() => {
          document.broadcastStateless(
            JSON.stringify({
              materialId,
              type: 'projection-updated',
              yjsVersion: stored.version,
            })
          );
        })
        .catch(() => undefined);
      if (lastContext?.serviceCommand) {
        await projection;
      } else {
        void projection.catch(async (error) => {
          await store.recordProjectionError(
            materialId,
            error instanceof Error ? error.message : String(error)
          );
        });
      }
    } catch (error) {
      storeFailures += 1;
      failedStores.set(documentName, Y.encodeStateAsUpdate(document));
      throw error;
    }
  },
});

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  const instance = server.hocuspocus;
  if (request.url === '/internal/commands' && request.method === 'POST') {
    if (
      !secretMatches(
        Array.isArray(request.headers['x-collaboration-secret'])
          ? request.headers['x-collaboration-secret'][0]
          : request.headers['x-collaboration-secret']
      )
    ) {
      jsonResponse(response, 401, { message: 'invalid service secret' });
      return;
    }
    let connection:
      | Awaited<ReturnType<typeof instance.openDirectConnection>>
      | undefined;
    try {
      const command = await readJsonBody(request);
      if (!isCollaborationCommand(command)) {
        jsonResponse(response, 400, {
          message: 'invalid collaboration command',
        });
        return;
      }
      const room = `material:${command.materialId}:schema:1`;
      connection = await instance.openDirectConnection(room, {
        access: 'write',
        serviceCommand: true,
        tokenId: 'service-command',
        userId: 'collaboration-service',
      });
      await connection.transact((document) =>
        applyCollaborationCommand(document, command)
      );
      await connection.disconnect({ unloadImmediately: true });
      connection = undefined;
      jsonResponse(response, 200, { status: 'applied' });
    } catch (error) {
      if (connection) await connection.disconnect().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const conflict =
        message.includes('concurrently') ||
        message.includes('no longer exists');
      jsonResponse(response, conflict ? 409 : 503, { message });
    }
    return;
  }
  if (request.url === '/healthz' || request.url === '/readyz') {
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      jsonResponse(response, 200, { status: 'ok' });
    } catch {
      jsonResponse(response, 503, { status: 'unavailable' });
    }
    return;
  }
  if (request.url === '/metrics') {
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4',
    });
    response.end(
      [
        `evo_collaboration_active_rooms ${instance.getDocumentsCount()}`,
        `evo_collaboration_connections ${instance.getConnectionsCount()}`,
        `evo_collaboration_authentication_failures_total ${authenticationFailures}`,
        `evo_collaboration_store_failures_total ${storeFailures}`,
        `evo_collaboration_failed_store_queue ${failedStores.size}`,
        `evo_collaboration_process_rss_bytes ${process.memoryUsage().rss}`,
        '',
      ].join('\n')
    );
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found');
}

// Hocuspocus 4.4's wrapper writes its default response after onRequest even
// when the hook has already ended it. Own the plain HTTP listener while
// retaining Hocuspocus's WebSocket upgrade listener.
server.httpServer.removeAllListeners('request');
server.httpServer.on('request', (request, response) => {
  void handleHttpRequest(request, response).catch((error) => {
    if (!response.headersSent) {
      jsonResponse(response, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  });
});

async function retryFailedStores() {
  for (const [room, state] of failedStores) {
    const document = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(document, state);
      const stored = await store.store(room, document);
      failedStores.delete(room);
      const materialId = materialIdFromRoom(room);
      void projections.project(
        materialId,
        stored.version,
        stored.content,
        stored.checkpointIds
      );
    } catch {
      storeFailures += 1;
    } finally {
      document.destroy();
    }
  }
}

const retryTimer = setInterval(() => void retryFailedStores(), 5000);
retryTimer.unref();

await subscriber.subscribe(
  'evo:collaboration:comments',
  'evo:collaboration:evict'
);
subscriber.on('message', (channel: string, raw: string) => {
  try {
    const event = JSON.parse(raw) as {
      materialId?: string;
      room?: string;
      type?: string;
    };
    const room =
      event.room ??
      (event.materialId ? `material:${event.materialId}:schema:1` : undefined);
    if (!room) return;
    if (channel === 'evo:collaboration:evict') {
      server.hocuspocus.closeConnections(room);
      return;
    }
    server.hocuspocus.documents
      .get(room)
      ?.broadcastStateless(
        JSON.stringify({ ...event, type: 'comments-invalidated' })
      );
  } catch {
    // Invalid pub/sub messages are ignored instead of reaching clients.
  }
});

projections.start();
await server.listen(config.port);
console.info(`collaboration service listening on ${server.webSocketURL}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}; flushing collaboration documents`);
  clearInterval(retryTimer);
  projections.stop();
  server.hocuspocus.flushPendingStores();
  await server.destroy();
  await Promise.allSettled([subscriber.quit(), redis.quit(), pool.end()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
