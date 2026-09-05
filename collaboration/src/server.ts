import { randomUUID } from 'node:crypto';
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
import { broadcastCheckpointPersisted } from './checkpointReceipt.js';
import { loadConfig } from './config.js';
import {
  assertUpdatePreservesContributors,
  attachDocumentContributorTracker,
  clearDocumentContributors,
} from './contributors.js';
import {
  drainIsDurable,
  evictMaterialRoomEpoch,
  parseRoomEvictionMode,
  RoomEvictionCoordinator,
  type RoomEvictionMode,
  RoomEvictionState,
  shouldCloseUserConnections,
  shouldPreserveMaterialConnections,
} from './eviction.js';
import {
  FailedStoreRetryRunner,
  type FailedStoreSnapshot,
} from './failedStoreRetry.js';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
} from './limits.js';
import { captureError, initErrorReporting, log } from './observability.js';
import { materialIdFromRoom, YjsDocumentStore } from './persistence.js';
import { ProjectionService } from './projection.js';
import {
  executeServiceCommand,
  handleServiceCommandRequest,
  observeServiceCommandStore,
  ServiceCommandCompletions,
} from './serviceCommand.js';
import { handlePermanentStoreFailure } from './storeFailure.js';
import {
  inboundYjsUpdate,
  yjsUpdateContainsChanges,
} from './yjsUpdateMessage.js';

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
const serviceCommandCompletions = new ServiceCommandCompletions();
const failedStores = new Map<string, FailedStoreSnapshot>();
const activeStores = new Map<string, Set<Promise<void>>>();
const storeFailureGenerations = new Map<string, number>();
const roomEvictions = new RoomEvictionState();
// Clients ask for a durability receipt with a stateless message instead of
// writing a marker into the Y.Doc, so acknowledging a save costs no Yjs update
// and leaves nothing behind in the persisted document.
const pendingCheckpoints = new Map<string, Set<string>>();
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
const USER_EVICTION_CHANNEL = 'evo:collaboration:user-evict';
const EVICTION_DELIVERED_CHANNEL = 'evo:collaboration:eviction-delivered';
const INSTANCE_TTL_MS = 30_000;
const EVICTION_TIMEOUT_MS = 15_000;
const localEvictions = new RoomEvictionCoordinator(10 * 60_000);
let authenticationFailures = 0;
let storeFailures = 0;

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
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

function evictLocalRoom(
  room: string,
  notification: boolean | string = false,
  operationId?: string,
  mode: RoomEvictionMode = 'discard'
) {
  return localEvictions.run(room, operationId, async () => {
    let unloaded = false;
    const initialFailureGeneration = storeFailureGenerations.get(room) ?? 0;
    if (mode === 'discard') roomEvictions.reject(room);
    roomEvictions.begin(room, mode);
    try {
      if (mode === 'discard') failedStores.delete(room);
      const document = server.hocuspocus.documents.get(room);
      if (document) {
        if (notification) {
          document.broadcastStateless(
            typeof notification === 'string'
              ? notification
              : JSON.stringify({ room, type: 'compaction-evict' })
          );
        }
        server.hocuspocus.closeConnections(room);
      }
      server.hocuspocus.flushPendingStores();
      await waitForStores(room);
      if (
        mode === 'drain' &&
        !drainIsDurable(
          initialFailureGeneration,
          storeFailureGenerations.get(room) ?? 0,
          failedStores.has(room)
        )
      ) {
        throw new Error(
          'collaboration document could not be persisted before eviction'
        );
      }
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
      unloaded = true;
    } finally {
      roomEvictions.end(room, mode);
      if (unloaded) {
        roomEvictions.accept(room);
        storeFailureGenerations.delete(room);
      }
    }
  });
}

function persistLocalRoom(room: string, operationId?: string) {
  return localEvictions.run(room, operationId, async () => {
    const initialFailureGeneration = storeFailureGenerations.get(room) ?? 0;
    // Restoration widens access. Keep the live room and its connections in
    // place, flush anything already pending, then let later edits continue on
    // the normal debounce cycle.
    server.hocuspocus.flushPendingStores();
    await waitForStores(room);
    if (
      !drainIsDurable(
        initialFailureGeneration,
        storeFailureGenerations.get(room) ?? 0,
        failedStores.has(room)
      )
    ) {
      throw new Error(
        'collaboration document could not be persisted during restoration'
      );
    }
  });
}

async function publishRoomEviction(
  room: string,
  payload: string,
  stage: string
) {
  try {
    await redis.publish('evo:collaboration:evict', payload);
  } catch (error) {
    storeFailures += 1;
    captureError(error, { room, stage });
    console.warn(
      'collaboration eviction publish failed:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * A room being discarded must not accept traffic or admit new connections until
 * it has been unloaded, otherwise a reconnecting client resyncs the very state
 * that is being thrown away.
 */
function assertRoomAvailable(room: string, allowStoreDrain = false) {
  if (roomEvictions.blocks(room, allowStoreDrain)) {
    throw new Error('collaboration room is being reset');
  }
}

function rejectionPayload(
  room: string,
  error: MaterialDocumentLimitError,
  evictionId?: string
) {
  return JSON.stringify({
    code: error.code,
    limits: MATERIAL_DOCUMENT_LIMITS,
    materialId: materialIdFromRoom(room),
    metrics: error.metrics,
    ...(evictionId ? { evictionId } : {}),
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
  document:
    | { broadcastStateless: (payload: string) => void }
    | null
    | undefined,
  error: MaterialDocumentLimitError
) {
  if (roomEvictions.isRejected(room)) return;
  roomEvictions.reject(room);
  const evictionId = randomUUID();
  const payload = rejectionPayload(room, error, evictionId);
  document?.broadcastStateless(payload);
  // `evictLocalRoom` waits for in-flight stores, and the caller is one of them,
  // so the eviction has to run outside the failing store.
  setTimeout(() => {
    void (async () => {
      const publication = publishRoomEviction(
        room,
        payload,
        'rejection_eviction_publish'
      );
      try {
        await evictLocalRoom(room, false, evictionId);
      } finally {
        await publication;
      }
    })().catch((evictionError) => {
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

function handleRejectedStore(
  room: string,
  error: unknown,
  document?: { broadcastStateless: (payload: string) => void } | null,
  clearFailedStore: () => void = () => {
    failedStores.delete(room);
  }
) {
  return handlePermanentStoreFailure(error, {
    clearFailedStore,
    rejectAuthorization: () => rejectAuthorizationRoom(room),
    rejectInvalidDocument: () => rejectInvalidDocumentRoom(room),
    rejectLimit: (limitError) => rejectRoom(room, document, limitError),
  });
}

// An update can race membership/account changes after the connection was
// admitted. The store rejects it transactionally; unloading the room then
// removes that rejected update from memory before an authorized client reloads.
function rejectAuthorizationRoom(room: string) {
  if (roomEvictions.isRejected(room)) return;
  roomEvictions.reject(room);
  const evictionId = randomUUID();
  const payload = JSON.stringify({
    evictionId,
    room,
    type: 'authorization-revoked',
  });
  setTimeout(() => {
    void (async () => {
      const publication = publishRoomEviction(
        room,
        payload,
        'authorization_eviction_publish'
      );
      try {
        await evictLocalRoom(room, payload, evictionId);
      } finally {
        await publication;
      }
    })().catch((evictionError) => {
      storeFailures += 1;
      captureError(evictionError, { room, stage: 'authorization_eviction' });
    });
  }, 0);
}

// A structurally invalid in-memory snapshot cannot be retried into durability.
// Discard it and reload the last valid SQL-backed Yjs state instead of leaving
// the room live and permanently unsavable.
function rejectInvalidDocumentRoom(room: string) {
  if (roomEvictions.isRejected(room)) return;
  roomEvictions.reject(room);
  const evictionId = randomUUID();
  const payload = JSON.stringify({
    evictionId,
    materialId: materialIdFromRoom(room),
    room,
    type: 'compaction-evict',
  });
  setTimeout(() => {
    void (async () => {
      const publication = publishRoomEviction(
        room,
        payload,
        'invalid_document_eviction_publish'
      );
      try {
        await evictLocalRoom(room, payload, evictionId);
      } finally {
        await publication;
      }
    })().catch((evictionError) => {
      storeFailures += 1;
      captureError(evictionError, {
        room,
        stage: 'invalid_document_eviction',
      });
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
    const context = connection.context as CollaborationContext | undefined;
    if (!context || context.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error('collaboration token expired');
    }
    const yjsUpdate = inboundYjsUpdate(update);
    if (!yjsUpdate) return;
    if (context.access === 'comment') {
      if (yjsUpdateContainsChanges(document, yjsUpdate)) {
        throw new Error('comment-only connection sent a document update');
      }
      return;
    }
    try {
      assertUpdatePreservesContributors(document, yjsUpdate);
      const shrinkOnly = context.access === 'shrink';
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
  async connected({ connection, context }) {
    const delay = Math.max(0, context.expiresAt * 1000 - Date.now());
    const timer = setTimeout(() => {
      connection.close({
        code: 4401,
        reason: 'collaboration token expired',
      } as CloseEvent);
    }, delay);
    connection.onClose(() => clearTimeout(timer));
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
      await store.assertConnectionAccess(
        documentName,
        claims.sub,
        claims.access
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
    attachDocumentContributorTracker(document, INSTANCE_ID);
    await store.load(documentName, document);
  },
  async onStateless({ connection, document, payload }) {
    const context = connection.context as CollaborationContext | undefined;
    if (!context || context.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error('collaboration token expired');
    }
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
    await observeServiceCommandStore(
      serviceCommandCompletions,
      lastContext?.serviceCommandId,
      async () => {
        const finish = beginStore(documentName);
        const snapshot = new Y.Doc({ gc: true });
        Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(document));
        // Claimed before the store reads the document, so the committed state is
        // guaranteed to contain everything these receipts were asked about.
        const claimed = [...(pendingCheckpoints.get(documentName) ?? [])];
        try {
          let stored: Awaited<ReturnType<YjsDocumentStore['store']>>;
          try {
            assertRoomAvailable(documentName, true);
            stored = await store.store(documentName, snapshot);
          } catch (error) {
            storeFailures += 1;
            storeFailureGenerations.set(
              documentName,
              (storeFailureGenerations.get(documentName) ?? 0) + 1
            );
            if (
              !handleRejectedStore(documentName, error, document) &&
              !roomEvictions.isDiscarding(documentName)
            ) {
              failedStores.set(documentName, {
                checkpointIds: claimed,
                state: Y.encodeStateAsUpdate(snapshot),
              });
            }
            throw error;
          }

          failedStores.delete(documentName);
          clearDocumentContributors(document, stored.contributors);
          const pending = pendingCheckpoints.get(documentName);
          const materialId = materialIdFromRoom(documentName);
          broadcastCheckpointPersisted(
            document,
            pending,
            claimed,
            materialId,
            stored
          );
          if (pending?.size === 0) pendingCheckpoints.delete(documentName);

          // The binary state is durable before projection begins. A projection-only
          // failure must not put the same snapshot into failedStores, otherwise the
          // retry path stores it again and advances stored_version without a new
          // document change.
          const projection = projections.projectAndRecord(
            materialId,
            stored.version,
            stored.content,
            lastContext?.serviceCommandId
              ? 'service_command_projection'
              : 'document_projection'
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
          if (lastContext?.serviceCommandId) {
            await projection;
          } else {
            void projection.catch(() => undefined);
          }
        } finally {
          snapshot.destroy();
          finish();
        }
      }
    );
  },
  async onTokenSync({ connection, documentName, token }) {
    assertRoomAvailable(documentName);
    if (await isRoomEvicting(documentName)) {
      throw new Error('collaboration room is being compacted');
    }
    const claims = verifyCollaborationToken(token, config.secret, documentName);
    await store.assertConnectionAccess(documentName, claims.sub, claims.access);
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
    await handleServiceCommandRequest(
      request,
      response,
      config.secret,
      (command) =>
        executeServiceCommand(command, {
          assertRoomAvailable,
          commandConnectionAccess: (room, actorUserId) =>
            store.commandConnectionAccess(room, actorUserId),
          completions: serviceCommandCompletions,
          hocuspocus: instance,
          isRoomEvicting,
        })
    );
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

const failedStoreRetries = new FailedStoreRetryRunner(
  failedStores,
  async (room, failed, clearIfCurrent) => {
    const finish = beginStore(room);
    const document = new Y.Doc({ gc: true });
    try {
      if (
        roomEvictions.isDiscarding(room) ||
        roomEvictions.isDraining(room) ||
        roomEvictions.isRejected(room)
      )
        return;
      Y.applyUpdate(document, failed.state);
      const stored = await store.store(room, document);
      clearIfCurrent();
      const live = server.hocuspocus.documents.get(room);
      if (live) {
        clearDocumentContributors(live, stored.contributors);
        const pending = pendingCheckpoints.get(room);
        broadcastCheckpointPersisted(
          live,
          pending,
          failed.checkpointIds,
          materialIdFromRoom(room),
          stored
        );
        if (pending?.size === 0) pendingCheckpoints.delete(room);
      }
      void projections
        .projectAndRecord(
          materialIdFromRoom(room),
          stored.version,
          stored.content,
          'failed_store_projection'
        )
        .catch(() => undefined);
    } catch (error) {
      storeFailures += 1;
      handleRejectedStore(
        room,
        error,
        server.hocuspocus.documents.get(room),
        clearIfCurrent
      );
    } finally {
      document.destroy();
      finish();
    }
  }
);

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
    await evictLocalRoom(event.room, true, event.requestID, 'drain');
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

async function handleUserEviction(raw: string) {
  let event: { evictionId?: string; mode?: unknown; userId?: string };
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event.userId) return;
  let ok = true;
  try {
    if (shouldCloseUserConnections(event.mode)) {
      for (const document of server.hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) {
          const context = connection.context as
            | CollaborationContext
            | undefined;
          if (context?.userId !== event.userId) continue;
          connection.close({
            code: 4403,
            reason: 'account access changed',
          } as CloseEvent);
        }
      }
    }
  } catch (error) {
    ok = false;
    captureError(error, { stage: 'user_eviction' });
  }
  if (event.evictionId) {
    await redis.publish(
      EVICTION_DELIVERED_CHANNEL,
      JSON.stringify({
        evictionId: event.evictionId,
        instanceId: INSTANCE_ID,
        ok,
      })
    );
  }
}

const retryTimer = setInterval(() => void failedStoreRetries.run(), 5000);
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
    const compacted = await withDistributedEviction(candidate.room, async () =>
      store.compact(candidate.room)
    );
    if (compacted === false) continue;
    if (compacted) {
      const evictionId = randomUUID();
      await redis.publish(
        'evo:collaboration:evict',
        JSON.stringify({
          evictionId,
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

async function waitForDistributedRoomTransition(room: string) {
  const deadline = Date.now() + EVICTION_TIMEOUT_MS * 4;
  while (await isRoomEvicting(room)) {
    if (Date.now() >= deadline) {
      throw new Error('collaboration room transition did not finish');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function deliverMaterialEviction(event: {
  evictionId?: string;
  materialId: string;
  mode?: unknown;
  raw: string;
  room: string;
  type?: unknown;
}) {
  const mode = parseRoomEvictionMode(event.mode);
  const preserveConnections = shouldPreserveMaterialConnections(
    event.type,
    event.mode
  );
  await evictMaterialRoomEpoch({
    currentRoom: () => store.currentRoom(event.materialId),
    evict: (room) =>
      preserveConnections
        ? persistLocalRoom(
            room,
            event.evictionId ? `${event.evictionId}:${room}` : undefined
          )
        : evictLocalRoom(
            room,
            event.raw,
            event.evictionId ? `${event.evictionId}:${room}` : undefined,
            mode
          ),
    initialRoom: event.room,
    waitForTransition: waitForDistributedRoomTransition,
  });
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
  USER_EVICTION_CHANNEL,
  EVICTION_REQUEST_CHANNEL,
  EVICTION_ACK_CHANNEL
);
subscriber.on('message', (channel: string, raw: string) => {
  if (channel === EVICTION_REQUEST_CHANNEL) {
    void handleEvictionRequest(raw).catch((error) => {
      storeFailures += 1;
      captureError(error, { stage: 'eviction_ack_publish' });
    });
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
  if (channel === USER_EVICTION_CHANNEL) {
    void handleUserEviction(raw).catch((error) => {
      storeFailures += 1;
      captureError(error, { stage: 'user_eviction_ack_publish' });
    });
    return;
  }
  try {
    const event = JSON.parse(raw) as {
      evictionId?: string;
      materialId?: string;
      mode?: unknown;
      room?: string;
      type?: string;
    };
    const room = event.room;
    if (!room) return;
    if (channel === 'evo:collaboration:evict') {
      const roomMaterialId = materialIdFromRoom(room);
      if (event.materialId && event.materialId !== roomMaterialId) return;
      const delivery =
        event.type === 'compaction-complete'
          ? evictLocalRoom(room, raw, event.evictionId)
          : deliverMaterialEviction({
              evictionId: event.evictionId,
              materialId: roomMaterialId,
              mode: event.mode,
              raw,
              room,
              type: event.type,
            });
      void delivery
        .then(async () => {
          if (event.evictionId) {
            await redis.publish(
              EVICTION_DELIVERED_CHANNEL,
              JSON.stringify({
                evictionId: event.evictionId,
                instanceId: INSTANCE_ID,
                ok: true,
              })
            );
          }
        })
        .catch(async (error) => {
          storeFailures += 1;
          captureError(error, { room, stage: 'event_eviction' });
          if (event.evictionId) {
            try {
              await redis.publish(
                EVICTION_DELIVERED_CHANNEL,
                JSON.stringify({
                  evictionId: event.evictionId,
                  instanceId: INSTANCE_ID,
                  ok: false,
                })
              );
            } catch (ackError) {
              captureError(ackError, {
                room,
                stage: 'event_eviction_negative_ack',
              });
            }
          }
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
