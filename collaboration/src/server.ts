import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server } from '@hocuspocus/server';
import { Redis as IORedis } from 'ioredis';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  assertAllowedOrigin,
  type CollaborationContext,
  claimsContext,
  verifyCollaborationToken,
} from './auth.js';
import {
  applyCollaborationCommand,
  isCollaborationCommand,
} from './commands.js';
import { loadConfig } from './config.js';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
} from './limits.js';
import { captureError, initErrorReporting, log } from './observability.js';
import { materialIdFromRoom, YjsDocumentStore } from './persistence.js';
import { ProjectionService } from './projection.js';

// Before any connection is accepted, so a failure during startup is reported
// rather than only appearing in container logs nobody is watching.
initErrorReporting();

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
const activeStores = new Map<string, Set<Promise<void>>>();
const evictingRooms = new Set<string>();
// Clients ask for a durability receipt with a stateless message instead of
// writing a marker into the Y.Doc, so acknowledging a save costs no Yjs update
// and leaves nothing behind in the persisted document.
const pendingCheckpoints = new Map<string, Set<string>>();
const rejectedRooms = new Set<string>();
const MAX_PENDING_CHECKPOINTS = 64;
const MAX_CHECKPOINT_ID_LENGTH = 128;
const evictionWaiters = new Map<
  string,
  {
    expected: Set<string>;
    received: Set<string>;
    resolve: (ok: boolean) => void;
    timer: NodeJS.Timeout;
  }
>();
const INSTANCE_ID = `${process.pid}-${randomUUID()}`;
const INSTANCE_REGISTRY_KEY = 'evo:collaboration:instances';
const EVICTION_KEY_PREFIX = 'evo:collaboration:evicting:';
const EVICTION_REQUEST_CHANNEL = 'evo:collaboration:evict-request';
const EVICTION_ACK_CHANNEL = 'evo:collaboration:evict-ack';
const INSTANCE_TTL_MS = 30_000;
const EVICTION_TIMEOUT_MS = 15_000;
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

function readVarUint(
  input: Uint8Array,
  offset: { value: number }
): number | null {
  let result = 0;
  let shift = 0;
  while (offset.value < input.length && shift < 35) {
    const byte = input[offset.value++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  return null;
}

function inboundYjsUpdate(message: Uint8Array): Uint8Array | null {
  const offset = { value: 0 };
  const documentNameLength = readVarUint(message, offset);
  if (
    documentNameLength === null ||
    documentNameLength > message.length - offset.value
  ) {
    return null;
  }
  offset.value += documentNameLength;
  const messageType = readVarUint(message, offset);
  if (messageType !== 0 && messageType !== 4) return null;
  // y-protocols/sync's messageYjsUpdate discriminator.
  if (readVarUint(message, offset) !== 2) return null;
  const updateLength = readVarUint(message, offset);
  if (updateLength === null || updateLength > message.length - offset.value) {
    return null;
  }
  return message.slice(offset.value, offset.value + updateLength);
}

function beginStore(documentName: string) {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stores = activeStores.get(documentName);
  if (!stores) {
    stores = new Set();
    activeStores.set(documentName, stores);
  }
  stores.add(pending);
  return () => {
    stores?.delete(pending);
    if (stores?.size === 0) activeStores.delete(documentName);
    finish();
  };
}

async function waitForStores(documentName: string) {
  while (activeStores.has(documentName)) {
    await Promise.all([...activeStores.get(documentName)!]);
  }
}

async function waitForConnections(documentName: string) {
  const deadline = Date.now() + EVICTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const document = server.hocuspocus.documents.get(documentName);
    if (!document || document.getConnectionsCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('collaboration eviction did not close all connections');
}

async function heartbeat() {
  await redis.hset(INSTANCE_REGISTRY_KEY, INSTANCE_ID, Date.now());
}

async function activeInstanceIds() {
  const entries = await redis.hgetall(INSTANCE_REGISTRY_KEY);
  const cutoff = Date.now() - INSTANCE_TTL_MS * 2;
  const active = new Set<string>([INSTANCE_ID]);
  const stale: string[] = [];
  for (const [instanceID, timestamp] of Object.entries(entries)) {
    if (Number(timestamp) >= cutoff) active.add(instanceID);
    else stale.push(instanceID);
  }
  if (stale.length > 0) await redis.hdel(INSTANCE_REGISTRY_KEY, ...stale);
  return active;
}

async function isRoomEvicting(room: string) {
  return (await redis.exists(`${EVICTION_KEY_PREFIX}${room}`)) === 1;
}

function recordEvictionAck(requestID: string, instanceID: string, ok: boolean) {
  const waiter = evictionWaiters.get(requestID);
  if (!waiter) return;
  if (!ok) {
    clearTimeout(waiter.timer);
    evictionWaiters.delete(requestID);
    waiter.resolve(false);
    return;
  }
  if (!waiter.expected.has(instanceID)) return;
  waiter.received.add(instanceID);
  if (waiter.received.size < waiter.expected.size) return;
  clearTimeout(waiter.timer);
  evictionWaiters.delete(requestID);
  waiter.resolve(true);
}

async function evictLocalRoom(room: string, notifyClients = false) {
  evictingRooms.add(room);
  try {
    failedStores.delete(room);
    const document = server.hocuspocus.documents.get(room);
    if (document) {
      if (notifyClients) {
        document.broadcastStateless(
          JSON.stringify({ room, type: 'compaction-evict' })
        );
      }
      server.hocuspocus.closeConnections(room);
    }
    server.hocuspocus.flushPendingStores();
    await waitForStores(room);
    if (document) {
      await waitForConnections(room);
      await server.hocuspocus.unloadDocument(document);
      const remaining = server.hocuspocus.documents.get(room);
      if (remaining) {
        await server.hocuspocus.unloadDocument(remaining);
      }
      if (server.hocuspocus.documents.get(room)) {
        throw new Error(
          'collaboration document remained loaded after eviction'
        );
      }
    }
    failedStores.delete(room);
  } finally {
    evictingRooms.delete(room);
    rejectedRooms.delete(room);
  }
}

/**
 * A room being discarded must not accept traffic or admit new connections until
 * it has been unloaded, otherwise a reconnecting client resyncs the very state
 * that is being thrown away.
 */
function assertRoomAvailable(room: string) {
  if (rejectedRooms.has(room) || evictingRooms.has(room)) {
    throw new Error('collaboration room is being reset');
  }
}

function rejectionPayload(room: string, error: MaterialDocumentLimitError) {
  return JSON.stringify({
    code: error.code,
    limits: MATERIAL_DOCUMENT_LIMITS,
    materialId: materialIdFromRoom(room),
    metrics: error.metrics,
    room,
    type: 'document-rejected',
  });
}

/**
 * Last resort for an over-limit document that slipped past `validateUpdate`.
 * Hocuspocus swallows `onStoreDocument` failures and keeps the room in memory,
 * so without this the room would stay live and silently unsavable forever.
 * Discarding it forces every client back onto the last durable state.
 */
function rejectRoom(
  room: string,
  document: { broadcastStateless: (payload: string) => void },
  error: MaterialDocumentLimitError
) {
  if (rejectedRooms.has(room)) return;
  rejectedRooms.add(room);
  const payload = rejectionPayload(room, error);
  document.broadcastStateless(payload);
  // `evictLocalRoom` waits for in-flight stores, and the caller is one of them,
  // so the eviction has to run outside the failing store.
  setTimeout(() => {
    void (async () => {
      await redis.publish('evo:collaboration:evict', payload);
      await evictLocalRoom(room);
    })().catch((evictionError) => {
      rejectedRooms.delete(room);
      storeFailures += 1;
      captureError(evictionError, { room, stage: 'rejection_eviction' });
      console.warn(
        'collaboration rejection eviction failed:',
        evictionError instanceof Error
          ? evictionError.message
          : String(evictionError)
      );
    });
  }, 0);
}

async function withDistributedEviction<T>(
  room: string,
  action: () => Promise<T>
) {
  const key = `${EVICTION_KEY_PREFIX}${room}`;
  const requestID = randomUUID();
  if (
    (await redis.set(key, requestID, 'PX', EVICTION_TIMEOUT_MS * 4, 'NX')) !==
    'OK'
  ) {
    return false;
  }
  let release = false;
  try {
    const expected = await activeInstanceIds();
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        evictionWaiters.delete(requestID);
        resolve(false);
      }, EVICTION_TIMEOUT_MS);
      evictionWaiters.set(requestID, {
        expected,
        received: new Set(),
        resolve,
        timer,
      });
    });
    await redis.publish(
      EVICTION_REQUEST_CHANNEL,
      JSON.stringify({ instanceID: INSTANCE_ID, requestID, room })
    );
    if (!(await result)) return false;
    const value = await action();
    release = true;
    return value;
  } finally {
    evictionWaiters.delete(requestID);
    if (release) await redis.del(key);
  }
}

const server = new Server<CollaborationContext>({
  address: config.host,
  async afterUnloadDocument({ documentName }) {
    pendingCheckpoints.delete(documentName);
    store.forgetRoom(documentName);
  },
  // Runs per inbound message, so it must stay free of I/O. Distributed eviction
  // always reaches this instance over Redis pub/sub and populates
  // `evictingRooms`, so the local set is authoritative here.
  async beforeHandleMessage({ connection, document, update }) {
    assertRoomAvailable(document.name);
    const yjsUpdate = inboundYjsUpdate(update);
    if (!yjsUpdate) return;
    try {
      const shrinkOnly =
        (connection.context as CollaborationContext | undefined)?.access ===
        'shrink';
      store.validateUpdate(document.name, document, yjsUpdate, { shrinkOnly });
    } catch (error) {
      // Throwing closes only this connection. Tell it why first so it can drop
      // its diverged Y.Doc instead of reconnecting and resending forever.
      if (error instanceof MaterialDocumentLimitError) {
        connection.sendStateless(rejectionPayload(document.name, error));
      }
      throw error;
    }
  },
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
  async onAuthenticate({ connectionConfig, documentName, request, token }) {
    try {
      assertAllowedOrigin(request, config.allowedOrigins);
      assertRoomAvailable(documentName);
      if (await isRoomEvicting(documentName)) {
        throw new Error('collaboration room is being compacted');
      }
      const claims = verifyCollaborationToken(
        token,
        config.secret,
        documentName
      );
      connectionConfig.readOnly = claims.access === 'comment';
      // shrink stays writable at the Hocuspocus layer; validateUpdate enforces
      // the shrinking-direction rule for over-quota accounts.
      return claimsContext(claims);
    } catch (error) {
      authenticationFailures += 1;
      // Expected and high volume (expired tokens, stale tabs); logged, not
      // reported, or the error stream is nothing but this.
      log('warn', 'authentication rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
  async onLoadDocument({ document, documentName }) {
    assertRoomAvailable(documentName);
    if (await isRoomEvicting(documentName)) {
      throw new Error('collaboration room is being compacted');
    }
    await store.load(documentName, document);
  },
  async onStateless({ connection, document, payload }) {
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type !== 'checkpoint-request' || connection.readOnly) return;
    const id = event.id;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_CHECKPOINT_ID_LENGTH
    ) {
      return;
    }
    let pending = pendingCheckpoints.get(document.name);
    if (!pending) {
      pending = new Set();
      pendingCheckpoints.set(document.name, pending);
    }
    if (pending.size >= MAX_PENDING_CHECKPOINTS) return;
    pending.add(id);
  },
  async onStoreDocument({ document, documentName, lastContext }) {
    const finish = beginStore(documentName);
    // Claimed before the store reads the document, so the committed state is
    // guaranteed to contain everything these receipts were asked about.
    const claimed = [...(pendingCheckpoints.get(documentName) ?? [])];
    try {
      assertRoomAvailable(documentName);
      const stored = await store.store(documentName, document);
      failedStores.delete(documentName);
      const pending = pendingCheckpoints.get(documentName);
      if (pending) {
        for (const id of claimed) pending.delete(id);
        if (pending.size === 0) pendingCheckpoints.delete(documentName);
      }
      const materialId = materialIdFromRoom(documentName);
      document.broadcastStateless(
        JSON.stringify({
          checkpointIds: claimed,
          limitCode: stored.limitCode,
          materialId,
          metrics: stored.metrics,
          type: 'checkpoint-persisted',
          yjsVersion: stored.version,
        })
      );
      const projection = projections.project(
        materialId,
        stored.version,
        stored.content
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
      if (error instanceof MaterialDocumentLimitError) {
        rejectRoom(documentName, document, error);
      } else if (!evictingRooms.has(documentName)) {
        failedStores.set(documentName, Y.encodeStateAsUpdate(document));
      }
      throw error;
    } finally {
      finish();
    }
  },
  async onTokenSync({ connection, documentName, token }) {
    if (await isRoomEvicting(documentName)) {
      throw new Error('collaboration room is being compacted');
    }
    const claims = verifyCollaborationToken(token, config.secret, documentName);
    connection.context = claimsContext(claims);
    connection.readOnly = claims.access === 'comment';
  },
  quiet: true,
  stopOnSignals: false,
  unloadImmediately: false,
  websocketOptions: { maxPayload: config.maxPayloadBytes },
  yDocOptions: { gc: true, gcFilter: () => true },
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
      const room = command.room;
      if (materialIdFromRoom(room) !== command.materialId) {
        throw new Error('collaboration command room does not match material');
      }
      assertRoomAvailable(room);
      if (await isRoomEvicting(room)) {
        throw new Error('collaboration room is being compacted');
      }
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
    const finish = beginStore(room);
    const document = new Y.Doc({ gc: true });
    try {
      if (evictingRooms.has(room) || rejectedRooms.has(room)) continue;
      Y.applyUpdate(document, state);
      const stored = await store.store(room, document);
      failedStores.delete(room);
      void projections.project(
        materialIdFromRoom(room),
        stored.version,
        stored.content
      );
    } catch {
      storeFailures += 1;
    } finally {
      document.destroy();
      finish();
    }
  }
}

async function handleEvictionRequest(raw: string) {
  let event: {
    instanceID?: string;
    requestID?: string;
    room?: string;
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event.requestID || !event.room) return;
  let ok = true;
  try {
    await evictLocalRoom(event.room, true);
  } catch (error) {
    ok = false;
    captureError(error, { room: event.room, stage: 'eviction' });
  }
  await redis.publish(
    EVICTION_ACK_CHANNEL,
    JSON.stringify({
      instanceID: INSTANCE_ID,
      ok,
      requestID: event.requestID,
      room: event.room,
    })
  );
}

const retryTimer = setInterval(() => void retryFailedStores(), 5000);
retryTimer.unref();

async function compactIdleDocuments() {
  const idleBefore = new Date(Date.now() - config.compactionIdleMs);
  const candidates = await store.compactionCandidates(
    idleBefore,
    config.compactionFloorBytes,
    config.compactionMultiplier,
    config.compactionMaxRooms
  );
  for (const candidate of candidates) {
    const active = server.hocuspocus.documents.get(candidate.room);
    if (active && active.getConnectionsCount() > 0) continue;
    const compacted = await withDistributedEviction(
      candidate.room,
      async () => {
        const value = await store.compact(candidate.room);
        if (value) {
          await redis.publish(
            'evo:collaboration:evict',
            JSON.stringify({
              materialId: value.materialId,
              newRoom: value.room,
              room: candidate.room,
              type: 'compaction-complete',
            })
          );
        }
        return value;
      }
    );
    if (compacted === false) continue;
    if (compacted) {
      await redis.publish(
        'evo:collaboration:evict',
        JSON.stringify({
          materialId: compacted.materialId,
          newRoom: compacted.room,
          room: candidate.room,
          type: 'compaction-complete',
        })
      );
      console.info(
        `compacted ${compacted.materialId}: ${candidate.stateBytes} -> ${compacted.stateBytes} bytes`
      );
    }
  }
}

const compactionTimer = setInterval(() => {
  void compactIdleDocuments().catch((error) => {
    storeFailures += 1;
    captureError(error, { stage: 'compaction' });
  });
}, config.compactionIntervalMs);
compactionTimer.unref();

await subscriber.subscribe(
  'evo:collaboration:comments',
  'evo:collaboration:evict',
  EVICTION_REQUEST_CHANNEL,
  EVICTION_ACK_CHANNEL
);
subscriber.on('message', (channel: string, raw: string) => {
  if (channel === EVICTION_REQUEST_CHANNEL) {
    void handleEvictionRequest(raw);
    return;
  }
  if (channel === EVICTION_ACK_CHANNEL) {
    try {
      const event = JSON.parse(raw) as {
        instanceID?: string;
        ok?: boolean;
        requestID?: string;
      };
      if (event.requestID && event.instanceID) {
        recordEvictionAck(event.requestID, event.instanceID, event.ok === true);
      }
    } catch {
      // Invalid eviction acknowledgements are ignored.
    }
    return;
  }
  try {
    const event = JSON.parse(raw) as {
      materialId?: string;
      room?: string;
      type?: string;
    };
    const room = event.room;
    if (!room) return;
    if (channel === 'evo:collaboration:evict') {
      server.hocuspocus.documents.get(room)?.broadcastStateless(raw);
      void evictLocalRoom(room).catch((error) => {
        storeFailures += 1;
        captureError(error, { room, stage: 'event_eviction' });
      });
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

void heartbeat();
const heartbeatTimer = setInterval(() => {
  void heartbeat().catch((error) => {
    log('warn', 'instance heartbeat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}, INSTANCE_TTL_MS / 2);
heartbeatTimer.unref();

projections.start();
await server.listen(config.port);
console.info(`collaboration service listening on ${server.webSocketURL}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}; flushing collaboration documents`);
  clearInterval(retryTimer);
  clearInterval(compactionTimer);
  clearInterval(heartbeatTimer);
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
