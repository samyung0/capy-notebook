import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Document, Server } from '@hocuspocus/server';
import { Redis as IORedis } from 'ioredis';
import { Pool } from 'pg';
import * as Y from 'yjs';
import { readOnlyRefusal, writerRecheck } from './accessRecheck.js';
import {
  assertAllowedOrigin,
  type CollaborationContext,
  claimsContext,
  MATERIAL_ROOM_PATTERN,
  SOURCE_ROOM_PATTERN,
  verifyCollaborationToken,
} from './auth.js';
import {
  broadcastCheckpointPersisted,
  nothingToStore,
  nothingToStoreReceipt,
  registerCheckpointRequest,
} from './checkpointReceipt.js';
import {
  adoptChildren,
  applyChildren,
  childWrites,
  keptIds,
  planChildren,
} from './children.js';
import { loadConfig } from './config.js';
import {
  assertUpdatePreservesContributors,
  attachDocumentContributorTracker,
  clearDocumentContributors,
  roomSnapshot,
} from './contributors.js';
import { EditError } from './editCommands.js';
import {
  discardMovesLineage,
  drainIsDurable,
  evictMaterialRoomEpoch,
  flushRoomStores,
  parseRoomEvictionMode,
  RoomEvictionCoordinator,
  type RoomEvictionMode,
  RoomEvictionState,
  shouldCloseUserConnections,
  shouldPreserveMaterialConnections,
  unloadRoom,
} from './eviction.js';
import {
  FailedStoreRetryRunner,
  type FailedStoreSnapshot,
  reportFailedStore,
} from './failedStoreRetry.js';
import { startHealthLog } from './health.js';
import { readInternalCommandJson } from './internalCommandRequest.js';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
} from './limits.js';
import { convertAgentMarkdown } from './markdown.js';
import {
  captureError,
  initErrorReporting,
  log,
  reportHttpError,
} from './observability.js';
import {
  endOfficeResync,
  officeUpdateViolation,
  placedUpdate,
  resyncUnheld,
  sourceUpdateUnheld,
  UPDATE_UNHELD,
} from './officeRoots.js';
import {
  closeOfficeRuntime,
  officeDocumentRoots,
  type SourceFormat,
  takeOfficeStats,
} from './officeRuntime.js';
import {
  CollaborationAuthorizationError,
  CollaborationNotFoundError,
  CollaborationReadOnlyError,
  materialIdFromRoom,
  roomSaveQueue,
  updateFitsRoom,
  YjsDocumentStore,
} from './persistence.js';
import { ProjectionService } from './projection.js';
import { scratchDoc } from './scratchDoc.js';
import {
  executeServiceCommand,
  handleServiceCommandRequest,
  observeServiceCommandStore,
  ServiceCommandCompletions,
} from './serviceCommand.js';
import { debounceSourceStores, persistsNow } from './sourceDebounce.js';
import {
  MAX_SOURCE_STATE_BYTES,
  SourceDocumentStore,
  SourceRequestError,
  sourceRoom,
} from './sourceDocuments.js';
import {
  OfficeEditingPausedError,
  SOURCE_HANDOFF_CHANNEL,
  SourceHandoff,
  type SourcePublish,
  SourcePublishingError,
} from './sourceHandoff.js';
import {
  handlePermanentStoreFailure,
  lostSourceAccess,
  pendingSourceSave,
  SlowSaveClock,
  SourceBackoffError,
  SourcePendingError,
  serviceSecretRejected,
  sourceSaveRefused,
} from './storeFailure.js';
import { armTokenExpiry, clearTokenExpiry } from './tokenExpiry.js';
import {
  inboundYjsSync,
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
// The per-minute collab_health line (observability-metering.md).
const health = startHealthLog(
  () => ({
    connections: server.hocuspocus.getConnectionsCount(),
    office: takeOfficeStats(),
    rooms: server.hocuspocus.documents.size,
  }),
  // Capacity runs log more often than the minute production uses.
  process.env.COLLAB_HEALTH_INTERVAL_MS
    ? Number(process.env.COLLAB_HEALTH_INTERVAL_MS)
    : undefined
);
const sources = new SourceDocumentStore(pool, config.apiUrl, config.secret);
// Source room size estimates from applied update bytes (updateFitsRoom).
const sourceSizes = new WeakMap<Y.Doc, number>();
// Each loaded source room's format, for the Office root check.
const sourceFormats = new WeakMap<Y.Doc, SourceFormat>();
// The engines' document roots, read once at boot: the message hook stays free
// of I/O, and a bundle that cannot load stops the service at start.
const officeRoots = await officeDocumentRoots();
// Office rooms the maintenance pause has flushed; cleared when it ends.
let pausedRooms = new WeakSet<Document>();
const projections = new ProjectionService(store, config.apiUrl, config.secret);
const serviceCommandCompletions = new ServiceCommandCompletions();
// One children pass at a time per material room, in update order (children.ts).
const childPasses = new Map<string, Promise<void>>();
const failedStores = new Map<string, FailedStoreSnapshot>();
// Office rooms whose last save waited on pending content: unsaved until a
// save succeeds. Rooms that reported pending content, once per load.
const pendingSources = new Set<string>();
const pendingReported = new WeakSet<Y.Doc>();
// When each source room's saves started failing (cleared by a success).
const slowSaves = new SlowSaveClock();
const activeStores = new Map<string, Set<Promise<void>>>();
const storeFailureGenerations = new Map<string, number>();
const roomEvictions = new RoomEvictionState();
// Clients ask for a durability receipt with a stateless message instead of
// writing a marker into the Y.Doc, so acknowledging a save costs no Yjs update
// and leaves nothing behind in the persisted document.
const pendingCheckpoints = new Map<string, Set<string>>();
// A writer's access is revalidated at most this often per connection; access
// and membership changes close its connection anyway (the eviction outbox),
// and every store or checkpoint rechecks each writer's role. Frozen and the
// storage limit are enforced only here and at authentication: a writer whose
// account or owner froze, or whose owner reached its limit, has its next
// update refused and only its connection closed (after `room-read-only`); the
// store saves what was already admitted. Co-editors keep writing until their
// own recheck refuses them (an owner at its limit refuses every writer).
const recheckWriterAccess = writerRecheck(5000);
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
const INSTANCE_REGISTRY_KEY = 'capy:collaboration:instances';
const EVICTION_KEY_PREFIX = 'capy:collaboration:evicting:';
const EVICTION_REQUEST_CHANNEL = 'capy:collaboration:evict-request';
const EVICTION_ACK_CHANNEL = 'capy:collaboration:evict-ack';
const USER_EVICTION_CHANNEL = 'capy:collaboration:user-evict';
const EVICTION_DELIVERED_CHANNEL = 'capy:collaboration:eviction-delivered';
const INSTANCE_TTL_MS = 30_000;
const EVICTION_TIMEOUT_MS = 15_000;
const localEvictions = new RoomEvictionCoordinator(10 * 60_000);
let authenticationFailures = 0;
let storeFailures = 0;

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
  error?: unknown
) {
  if (status >= 500 && error !== undefined) reportHttpError(response, error);
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

// Rooms whose discard threw unsaved state away and still owe their lineage
// move: a failed attempt leaves the room clean and unloaded, so its retry
// must not decide again from what is left.
const lineageDue = new Set<string>();

function evictLocalRoom(
  room: string,
  notification: boolean | string = false,
  operationId?: string,
  mode: RoomEvictionMode = 'discard',
  /** A store-time rejection started this discard: its snapshot is lost. */
  storeRejected = false
) {
  return localEvictions.run(room, operationId, async () => {
    let unloaded = false;
    const initialFailureGeneration = storeFailureGenerations.get(room) ?? 0;
    // Read before the discard clears the failed snapshot.
    if (
      mode === 'discard' &&
      discardMovesLineage({
        document: server.hocuspocus.documents.get(room),
        failedSnapshot: failedStores.has(room),
        storeRejected,
      })
    )
      lineageDue.add(room);
    const movesLineage = mode === 'discard' && lineageDue.has(room);
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
      await flushRoomStores(
        server.hocuspocus,
        room,
        waitForStores,
        EVICTION_TIMEOUT_MS
      );
      if (
        mode === 'drain' &&
        !drainIsDurable(
          initialFailureGeneration,
          storeFailureGenerations.get(room) ?? 0,
          failedStores.has(room) || pendingSources.has(room)
        )
      ) {
        throw new Error(
          'collaboration document could not be persisted before eviction'
        );
      }
      if (document) {
        await waitForConnections(room);
        await unloadRoom({
          close: () => server.hocuspocus.closeConnections(room),
          deadline: Date.now() + UNLOAD_RETRY_MS,
          flush: () =>
            flushRoomStores(
              server.hocuspocus,
              room,
              waitForStores,
              EVICTION_TIMEOUT_MS
            ),
          loaded: () => server.hocuspocus.documents.get(room),
          unload: (loaded) => server.hocuspocus.unloadDocument(loaded),
        });
      }
      // A save the unload loop flushed may have failed: a drain then keeps
      // the failed snapshot for its retry instead of clearing it below.
      if (
        mode === 'drain' &&
        !drainIsDurable(
          initialFailureGeneration,
          storeFailureGenerations.get(room) ?? 0,
          failedStores.has(room) || pendingSources.has(room)
        )
      )
        throw new Error(
          'collaboration document could not be persisted before eviction'
        );
      // Before the room is accepted again: a failure keeps it refused and
      // retries the discard, which then moves it (the room stays rejected).
      if (movesLineage) {
        await (SOURCE_ROOM_PATTERN.test(room)
          ? sources.resetEpoch(room)
          : store.resetLineage(room));
        lineageDue.delete(room);
      }
      failedStores.delete(room);
      pendingSources.delete(room);
      slowSaves.clear(room);
      unloaded = true;
    } finally {
      roomEvictions.end(room, mode);
      if (unloaded) {
        roomEvictions.accept(room);
        storeFailureGenerations.delete(room);
      } else if (mode === 'discard') retryDiscard(room);
    }
  });
}

// A rejected room refuses every message and login until a discard unloads
// it, so a discard that failed is always retried: the room never stays
// rejected with nothing pending to clear it.
const UNLOAD_RETRY_MS = 30_000;
const DISCARD_RETRY_MS = 5000;
const discardRetries = new Set<string>();
function retryDiscard(room: string) {
  if (discardRetries.has(room)) return;
  discardRetries.add(room);
  setTimeout(() => {
    discardRetries.delete(room);
    if (!roomEvictions.isRejected(room)) return;
    void evictLocalRoom(room).catch((error) => {
      captureError(error, { room, stage: 'discard_retry' });
    });
  }, DISCARD_RETRY_MS).unref();
}

function persistLocalRoom(room: string, operationId?: string) {
  return localEvictions.run(room, operationId, async () => {
    const initialFailureGeneration = storeFailureGenerations.get(room) ?? 0;
    // Restoration widens access. Keep the live room and its connections in
    // place, flush anything already pending, then let later edits continue on
    // the normal debounce cycle.
    await flushRoomStores(
      server.hocuspocus,
      room,
      waitForStores,
      EVICTION_TIMEOUT_MS
    );
    if (
      !drainIsDurable(
        initialFailureGeneration,
        storeFailureGenerations.get(room) ?? 0,
        failedStores.has(room) || pendingSources.has(room)
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
    await redis.publish('capy:collaboration:evict', payload);
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
        await evictLocalRoom(room, false, evictionId, 'discard', true);
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
        await evictLocalRoom(room, payload, evictionId, 'discard', true);
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
  // `document-rejected` makes each editor drop its copy and reload the last
  // valid state instead of reconnecting and resending the invalid one.
  const payload = JSON.stringify({
    code: 'invalid_document',
    evictionId,
    materialId: materialIdFromRoom(room),
    room,
    type: 'document-rejected',
  });
  setTimeout(() => {
    void (async () => {
      const publication = publishRoomEviction(
        room,
        payload,
        'invalid_document_eviction_publish'
      );
      try {
        await evictLocalRoom(room, payload, evictionId, 'discard', true);
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

// Sockets authenticating for a source room, by socket and room (one socket
// multiplexes rooms), from before the publication lock check until they
// connect or fail: a rebuild counts them as in the room. One that closed in
// between is dropped after a minute (the handoff forgets it after 30 s).
const sourceJoins = new Map<string, { done: () => void; since: number }>();
function startSourceJoin(socketId: string, room: string) {
  const now = Date.now();
  for (const [key, join] of sourceJoins)
    if (now - join.since > 60_000) sourceJoins.delete(key);
  sourceJoins.set(`${socketId}\u0000${room}`, {
    done: sourceHandoff.join(room, socketId),
    since: now,
  });
}
function endSourceJoin(socketId: string, room: string) {
  const key = `${socketId}\u0000${room}`;
  sourceJoins.get(key)?.done();
  sourceJoins.delete(key);
}

/**
 * Makes the children an update wrote the material's own (children.ts): asks
 * the API as actorUserId, repoints or drops the nodes through a direct
 * connection (stored like any edit), tells open editors which ids stayed (some
 * left the trash) and, when storage refused a copy, the sender. A room that
 * unloaded meanwhile is loaded for the pass.
 */
async function childrenPass(
  room: string,
  actorUserId: string,
  update: Uint8Array,
  notify?: (payload: string) => void
) {
  let connection: Awaited<
    ReturnType<typeof server.hocuspocus.openDirectConnection>
  > | null = null;
  const open = () =>
    server.hocuspocus.openDirectConnection(room, {
      access: 'write',
      expiresAt: Number.MAX_SAFE_INTEGER,
      tokenId: 'children-pass',
      userId: actorUserId,
    });
  try {
    let document = server.hocuspocus.documents.get(room);
    if (!document) {
      connection = await open();
      document = server.hocuspocus.documents.get(room);
    }
    const writes = document ? childWrites(document, update) : null;
    if (!(document && writes)) return;
    const plan = planChildren(document, writes);
    const answer = await adoptChildren(
      config.apiUrl,
      config.secret,
      materialIdFromRoom(room),
      actorUserId,
      plan
    );
    if (answer.storageRefused)
      notify?.(JSON.stringify({ reason: 'storage', type: 'children-refused' }));
    const moved =
      [...answer.assets].some(([from, to]) => from !== to) ||
      plan.blocks.some(
        (block) => answer.blocks.get(block.blockId) !== block.materialId
      );
    if (moved) {
      connection ??= await open();
      await connection.transact((live) => {
        applyChildren(live, answer);
      });
    }
    server.hocuspocus.documents
      .get(room)
      ?.broadcastStateless(
        JSON.stringify({ type: 'children-ready', ...keptIds(plan, answer) })
      );
  } finally {
    await connection?.disconnect({ unloadImmediately: true });
  }
}

function queueChildrenPass(
  room: string,
  actorUserId: string,
  update: Uint8Array,
  notify?: (payload: string) => void
) {
  const next = (childPasses.get(room) ?? Promise.resolve())
    .then(() => childrenPass(room, actorUserId, update, notify))
    .catch((error) => {
      captureError(error, { room, stage: 'children_pass' });
    });
  childPasses.set(room, next);
  void next.finally(() => {
    if (childPasses.get(room) === next) childPasses.delete(room);
  });
}

const server = new Server<CollaborationContext>({
  address: config.host,
  // A message dropped for a resync (resyncOfficeConnection) is behind us.
  async afterHandleMessage({ connection }) {
    endOfficeResync(connection);
  },
  async afterUnloadDocument({ documentName }) {
    pendingCheckpoints.delete(documentName);
    if (SOURCE_ROOM_PATTERN.test(documentName)) {
      sources.forget(documentName);
      // The last editor here left: a deferred publication can move editing
      // onto the published file if no other instance has the room open.
      sourceHandoff.scheduleRebuild(sourceRoom(documentName).fileId);
    } else store.forgetRoom(documentName);
  },
  // Runs per inbound message, so keep it cheap: the only I/O is the writer
  // access recheck, at most once per connection every 5 s. Distributed
  // eviction always reaches this instance over Redis pub/sub and populates
  // `evictingRooms`, so the local set is authoritative here.
  async beforeHandleMessage({ connection, document, update }) {
    health.message(update);
    assertRoomAvailable(document.name);
    const context = connection.context as CollaborationContext | undefined;
    if (!context || context.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error('collaboration token expired');
    }
    const sync = inboundYjsSync(update);
    if (!sync) return;
    const yjsUpdate = sync.update;
    if (context.access === 'read') {
      if (yjsUpdateContainsChanges(document, yjsUpdate)) {
        throw new Error('read-only connection sent a document update');
      }
      return;
    }
    try {
      if (pausedRooms.has(document)) {
        // A writer that slipped past the pause: it goes read-only (or to
        // recovery with unsent changes) and its update is refused.
        connection.sendStateless(
          JSON.stringify({
            ...sourceRoom(document.name),
            type: 'source-editing-paused',
          })
        );
        throw new OfficeEditingPausedError();
      }
      assertUpdatePreservesContributors(document, yjsUpdate);
      if (SOURCE_ROOM_PATTERN.test(document.name)) {
        await recheckWriterAccess(connection, document.name, () =>
          sources.assertConnectionAccess(
            document.name,
            context.userId,
            context.access
          )
        );
        // A reset may have begun while the check waited on the gateway.
        assertRoomAvailable(document.name);
        const format = sourceFormats.get(document);
        let refusal: string | null = null;
        if (
          !updateFitsRoom(
            sourceSizes,
            document,
            yjsUpdate,
            MAX_SOURCE_STATE_BYTES
          )
        )
          refusal = 'Source checkpoint exceeds byte limit';
        else if (format && format !== 'text')
          refusal = officeUpdateViolation(
            document,
            yjsUpdate,
            format,
            officeRoots[format]
          );
        else if (sourceUpdateUnheld(document, yjsUpdate))
          refusal = UPDATE_UNHELD;
        if (refusal === UPDATE_UNHELD) {
          resyncUnheld(connection, sync.step2, 'source');
          return;
        }
        placedUpdate(connection);
        if (refusal) {
          // Stateless and unrecoverable, so the client stops resending it.
          connection.sendStateless(
            JSON.stringify({
              type: 'source-checkpoint-failed',
              ...sourceRoom(document.name),
              checkpointIds: [],
              recoverable: false,
            })
          );
          throw new Error(refusal);
        }
        return;
      }
      await recheckWriterAccess(connection, document.name, () =>
        store.assertConnectionAccess(document.name, context.userId, 'write')
      );
      assertRoomAvailable(document.name);
      if (
        store.validateUpdate(document.name, document, yjsUpdate) ===
        UPDATE_UNHELD
      ) {
        resyncUnheld(connection, sync.step2, 'note');
        return;
      }
      placedUpdate(connection);
    } catch (error) {
      // Throwing closes only this connection. Tell it why first so it can drop
      // its diverged Y.Doc instead of reconnecting and resending forever.
      if (error instanceof MaterialDocumentLimitError) {
        connection.sendStateless(rejectionPayload(document.name, error));
      }
      throw error;
    }
  },
  async connected({ connection, documentName }) {
    endSourceJoin(connection.socketId, documentName);
    armTokenExpiry(connection);
    connection.onClose(() => clearTokenExpiry(connection));
  },
  debounce: config.debounceMs,
  // Broadcasts merge over 30 ms windows instead of one event-loop turn: N
  // sends per window rather than per update, at up to 30 ms added latency
  // (approved by Epo).
  flushDelay: 30,
  maxDebounce: config.maxDebounceMs,
  maxPendingDocuments: 8,
  // A writer typing through a slow login queues one message per keystroke;
  // 64 dropped the whole socket. The byte cap is the memory guard.
  maxUnauthenticatedQueueMessages: 1000,
  maxUnauthenticatedQueueSize: 512 * 1024,
  async onAuthenticate({
    connectionConfig,
    documentName,
    request,
    socketId,
    token,
  }) {
    if (SOURCE_ROOM_PATTERN.test(documentName))
      startSourceJoin(socketId, documentName);
    try {
      assertAllowedOrigin(request, config.allowedOrigins);
      assertRoomAvailable(documentName);
      if (await isRoomEvicting(documentName)) {
        // Source rooms take this lock only to publish (sourceHandoff.ts).
        throw SOURCE_ROOM_PATTERN.test(documentName)
          ? new SourcePublishingError()
          : new Error('collaboration room is being compacted');
      }
      const claims = verifyCollaborationToken(
        token,
        config.secret,
        documentName
      );
      const readOnly = claims.access === 'read';
      // The maintenance pause refuses writers; viewing keeps working. Once it
      // is over, a room paused earlier takes this writer's updates at once
      // instead of on the next pause poll.
      if (!readOnly && SOURCE_ROOM_PATTERN.test(documentName)) {
        if (await sources.editingPaused(documentName))
          throw new OfficeEditingPausedError();
        const loaded = server.hocuspocus.documents.get(documentName);
        if (loaded) {
          pausedRooms.delete(loaded);
          pauseChecked.delete(loaded);
        }
      }
      await (SOURCE_ROOM_PATTERN.test(documentName)
        ? sources
        : store
      ).assertConnectionAccess(documentName, claims.sub, claims.access);
      connectionConfig.readOnly = readOnly;
      // A reset that began during the checks above admits no one.
      assertRoomAvailable(documentName);
      return claimsContext(claims);
    } catch (error) {
      endSourceJoin(socketId, documentName);
      authenticationFailures += 1;
      // Expected and high volume (expired tokens, stale tabs); logged, not
      // reported, or the error stream is nothing but this.
      log('warn', 'authentication rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      // A writer whose room turned read-only learns why (its reason), so the
      // editor drops to view instead of retrying.
      if (
        readOnlyRefusal(error) &&
        !(error instanceof CollaborationReadOnlyError)
      )
        throw new CollaborationReadOnlyError('source access is read-only', {
          cause: error,
        });
      // The gateway's source access answer carries no reason: a missing or
      // trashed file and lost access get theirs, so the editor shows a panel
      // instead of retrying.
      if (error instanceof SourceRequestError && error.status === 404)
        throw new CollaborationNotFoundError(error.message, { cause: error });
      if (error instanceof SourceRequestError && error.status === 403)
        throw new CollaborationAuthorizationError(error.message, {
          cause: error,
        });
      throw error;
    }
  },
  // A writer's update that wrote child ids (a paste, undo, cut and paste,
  // replayed draft) gets a children pass; typing writes none and costs a
  // decode. Not awaited: the pass calls the API.
  async onChange({ connection, context, document, documentName, update }) {
    if (!MATERIAL_ROOM_PATTERN.test(documentName) || !connection) return;
    const actor = (context as CollaborationContext | undefined)?.userId;
    if (!actor || !childWrites(document, update)) return;
    queueChildrenPass(documentName, actor, update, (payload) => {
      try {
        connection.sendStateless(payload);
      } catch {
        // The sender left; nobody to tell.
      }
    });
  },
  async onLoadDocument({ document, documentName, context }) {
    assertRoomAvailable(documentName);
    if (await isRoomEvicting(documentName)) {
      throw new Error('collaboration room is being compacted');
    }
    attachDocumentContributorTracker(document, INSTANCE_ID);
    if (SOURCE_ROOM_PATTERN.test(documentName)) {
      document.on('update', (update: Uint8Array) =>
        sourceSizes.set(
          document,
          (sourceSizes.get(document) ?? 0) + update.byteLength
        )
      );
      const session = await sources.load(
        documentName,
        document,
        context.userId
      );
      sourceFormats.set(document, session.format);
    } else await store.load(documentName, document);
    assertRoomAvailable(documentName);
  },
  async onStateless({ connection, document, payload }) {
    const context = connection.context as CollaborationContext | undefined;
    if (!context || context.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error('collaboration token expired');
    }
    let event: {
      id?: unknown;
      type?: unknown;
      epoch?: unknown;
      checkpoint?: unknown;
      clean?: unknown;
      flush?: unknown;
    };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (
      event.type === 'source-handoff-ready' &&
      SOURCE_ROOM_PATTERN.test(document.name)
    ) {
      if (sourceHandoff.ready(document.name, connection.socketId, event))
        connection.readOnly = true;
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
    const source = SOURCE_ROOM_PATTERN.test(document.name);
    // A note room with nothing waiting to be saved answers at once; a store
    // runs only after a change (nothingToStore says when that matters).
    if (
      !source &&
      !activeStores.has(document.name) &&
      nothingToStore(
        server.hocuspocus,
        document,
        failedStores.has(document.name)
      )
    ) {
      connection.sendStateless(
        nothingToStoreReceipt(materialIdFromRoom(document.name), id)
      );
      return;
    }
    // A source room's idle receipts wait for its debounced store; a full set
    // is drained by saving now rather than dropping this request.
    if (
      !(await registerCheckpointRequest(
        pendingCheckpoints,
        document.name,
        id,
        MAX_PENDING_CHECKPOINTS,
        source ? () => persistSource(document) : undefined
      ))
    )
      return;
    // An explicit save (flush) persists at once. The idle request only
    // registers its receipt for the room's debounced store, as in a material
    // room, unless no store is waiting to carry it.
    if (
      source &&
      persistsNow(server.hocuspocus, document.name, event.flush === true)
    ) {
      // storeSource already reports the failure and sends the client receipt.
      // Hocuspocus does not await stateless callbacks.
      await persistSource(document).catch(() => undefined);
    }
  },
  async onStoreDocument({ document, documentName, lastContext }) {
    if (roomEvictions.isDiscarding(documentName)) return;
    if (SOURCE_ROOM_PATTERN.test(documentName)) {
      try {
        await persistSource(document);
      } catch (error) {
        if (!roomEvictions.isDiscarding(documentName)) throw error;
      }
      return;
    }
    await observeServiceCommandStore(
      serviceCommandCompletions,
      lastContext?.serviceCommandId,
      async () => {
        const snapshot = roomSnapshot(document);
        // Claimed before the store reads the document, so the committed state is
        // guaranteed to contain everything these receipts were asked about.
        const claimed = [...(pendingCheckpoints.get(documentName) ?? [])];
        // Registered right before the try that ends it (nothing above awaits),
        // so a throw reading the room cannot leave the store registered.
        const finish = beginStore(documentName);
        try {
          let stored: Awaited<ReturnType<YjsDocumentStore['store']>>;
          const started = performance.now();
          try {
            assertRoomAvailable(documentName, true);
            stored = await store.store(documentName, snapshot);
            health.material.record(performance.now() - started, true);
          } catch (error) {
            health.material.record(performance.now() - started, false);
            storeFailures += 1;
            storeFailureGenerations.set(
              documentName,
              (storeFailureGenerations.get(documentName) ?? 0) + 1
            );
            if (
              !handleRejectedStore(documentName, error, document) &&
              !roomEvictions.isDiscarding(documentName)
            ) {
              // Retried below; the editors keep their edits and show it.
              document.broadcastStateless(
                JSON.stringify({
                  materialId: materialIdFromRoom(documentName),
                  type: 'checkpoint-failed',
                })
              );
              const eventId = reportFailedStore(
                failedStores.get(documentName),
                error,
                documentName
              );
              failedStores.set(documentName, {
                checkpointIds: claimed,
                eventId,
                state: snapshot.state,
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
    await (SOURCE_ROOM_PATTERN.test(documentName)
      ? sources
      : store
    ).assertConnectionAccess(documentName, claims.sub, claims.access);
    assertRoomAvailable(documentName);
    connection.context = claimsContext(claims);
    connection.readOnly = claims.access === 'read';
    // It may have closed during the checks above; its timers are gone then.
    if (
      server.hocuspocus.documents.get(documentName)?.hasConnection(connection)
    )
      armTokenExpiry(connection);
  },
  quiet: true,
  stopOnSignals: false,
  unloadImmediately: false,
  websocketOptions: {
    maxPayload: Math.max(config.maxPayloadBytes, MAX_SOURCE_STATE_BYTES + 1024),
  },
  yDocOptions: { gc: true, gcFilter: () => true },
});

function sourceReceipt(
  document: Document,
  claimed: readonly string[],
  checkpoint: number
) {
  const pending = pendingCheckpoints.get(document.name);
  const checkpointIds = claimed.filter((id) => pending?.delete(id));
  const { fileId, epoch } = sourceRoom(document.name);
  document.broadcastStateless(
    JSON.stringify({
      checkpoint,
      checkpointIds,
      epoch,
      fileId,
      type: 'checkpoint-persisted',
      yjsVersion: checkpoint,
    })
  );
  if (!pending?.size) pendingCheckpoints.delete(document.name);
}

debounceSourceStores(
  server.hocuspocus,
  config.sourceDebounceMs,
  config.sourceMaxDebounceMs
);

const queueSourceSave = roomSaveQueue(storeSource);
function persistSource(document: Document) {
  // Register before queueing so eviction also waits for saves not yet started.
  const finish = beginStore(document.name);
  return queueSourceSave(document).finally(finish);
}

/** Every rejected service secret, loudly: a mismatch between this service
 * and the gateway stops every source save until it is fixed. */
function reportServiceSecret(error: unknown, room: string) {
  if (!serviceSecretRejected(error)) return;
  console.error(
    'collaboration service secret rejected by the gateway; source saves fail until it matches',
    { room }
  );
  captureError(error, { room, stage: 'service_secret_rejected' });
}

async function storeSource(document: Document) {
  const room = document.name;
  // Awaited handoff callers must fail if their queued save was discarded.
  assertRoomAvailable(room, true);
  const snapshot = roomSnapshot(document);
  const rawState = snapshot.state;
  const claimed = [...(pendingCheckpoints.get(room) ?? [])];
  const started = performance.now();
  try {
    // Pending content (an update that arrived ahead of one it depends on) is
    // not the engine refusing the state: an Office room waits as a transient
    // failure until the client's sync integrates it (refusing would reset the
    // room and discard every edit since the last checkpoint); a text room
    // saves it whole, as it always did. Either way it is reported once.
    const pending = pendingSourceSave(document, sourceFormats.get(document));
    if (pending !== 'none') {
      if (pendingReported.has(document))
        log('warn', 'source store found pending content', { room });
      else {
        pendingReported.add(document);
        captureError(new SourcePendingError(), {
          room,
          stage: 'source_store_pending',
        });
      }
    }
    if (pending === 'wait') {
      pendingSources.add(room);
      throw new SourcePendingError();
    }
    // A room in slow-failure backoff calls the engine again only when its
    // retry is due (the retry runner then saves through this same path).
    if (failedStoreRetries.waiting(room)) throw new SourceBackoffError();
    const saved = await sources.store(
      room,
      snapshot,
      failedStores.get(room)?.eventId
    );
    failedStores.delete(room);
    pendingSources.delete(room);
    slowSaves.clear(room);
    clearDocumentContributors(document, saved.contributors);
    sourceReceipt(document, claimed, saved.checkpoint);
    health.source.record(performance.now() - started, true);
  } catch (error) {
    health.source.record(performance.now() - started, false);
    storeFailures++;
    reportServiceSecret(error, room);
    storeFailureGenerations.set(
      room,
      (storeFailureGenerations.get(room) ?? 0) + 1
    );
    // A storage or frozen refusal drops every writer to view (their unsaved
    // edits are discarded). A failure that will always fail
    // (sourceSaveRefused), or failed saves of any cause (pending content
    // included) without a success for SLOW_SAVE_LIMIT_MS, discard the room:
    // it reopens at the last good save and the clients keep their edits in
    // recovery. Anything else is retried with backoff while the clients keep
    // editing.
    const readOnly = readOnlyRefusal(error);
    const previous = failedStores.get(room);
    const refused =
      !readOnly && (sourceSaveRefused(error) || slowSaves.failed(room));
    const recoverable = !(readOnly || refused);
    if (readOnly)
      log('warn', 'source store refused read-only', {
        error: error instanceof Error ? error.message : String(error),
        room,
      });
    document.broadcastStateless(
      JSON.stringify(
        readOnly
          ? { room, type: 'room-read-only' }
          : {
              type: 'source-checkpoint-failed',
              ...sourceRoom(room),
              checkpointIds: claimed,
              ...(lostSourceAccess(error) && { lostAccess: true }),
              recoverable,
            }
      )
    );
    if (refused) {
      reportFailedStore(undefined, error, room);
      failedStores.delete(room);
      slowSaves.clear(room);
      rejectAuthorizationRoom(room);
    } else if (error instanceof SourcePendingError) {
      // Reported above; the live room, not this snapshot, is what saves
      // once its pending content integrates (pendingSources keeps it unsaved).
    } else if (recoverable && !roomEvictions.isDiscarding(room)) {
      const eventId = reportFailedStore(previous, error, room);
      failedStores.set(room, {
        checkpointIds: claimed,
        eventId,
        state: rawState,
      });
    } else {
      if (!readOnly)
        log('warn', 'source store failed while the room is discarded', {
          error: error instanceof Error ? error.message : String(error),
          room,
        });
      failedStores.delete(room);
      rejectAuthorizationRoom(room);
    }
    throw error;
  }
}

const sourceHandoff = new SourceHandoff(
  INSTANCE_ID,
  redis,
  pool,
  server.hocuspocus,
  sources,
  activeInstanceIds,
  persistSource,
  config.uatPublicationHold,
  (error) => captureError(error, { stage: 'source_rebuild' }),
  (room) =>
    failedStores.has(room) ||
    pendingSources.has(room) ||
    (activeStores.get(room)?.size ?? 0) > 0
);

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  const instance = server.hocuspocus;
  if (
    request.method === 'POST' &&
    (request.url === '/internal/source-changes/resolve' ||
      request.url === '/internal/source-refresh/publish')
  ) {
    const got = Buffer.from(
      String(request.headers['x-collaboration-secret'] ?? '')
    );
    const expected = Buffer.from(config.secret);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      jsonResponse(response, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readInternalCommandJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { message: 'Invalid source request' });
      return;
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.fileId !== 'string' ||
      !Number.isSafeInteger(input.epoch) ||
      !Number.isSafeInteger(input.checkpoint)
    ) {
      jsonResponse(response, 400, { message: 'Invalid source checkpoint' });
      return;
    }
    try {
      if (request.url === '/internal/source-changes/resolve') {
        if (
          typeof input.workspaceId !== 'string' ||
          typeof input.userId !== 'string' ||
          typeof input.changeId !== 'string'
        )
          throw new SourceRequestError(400, 'Invalid source image request');
        jsonResponse(
          response,
          200,
          await sources.resolve(
            input as Parameters<SourceDocumentStore['resolve']>[0]
          )
        );
      } else {
        if (
          typeof input.jobId !== 'string' ||
          typeof input.leaseToken !== 'string' ||
          !Number.isSafeInteger(input.attemptId)
        )
          throw new SourceRequestError(400, 'Invalid source publication');
        jsonResponse(
          response,
          200,
          await sourceHandoff.publish(input as SourcePublish)
        );
      }
    } catch (error) {
      jsonResponse(
        response,
        error instanceof SourceRequestError ? error.status : 500,
        {
          message:
            error instanceof Error ? error.message : 'Source operation failed',
        },
        error
      );
    }
    return;
  }
  if (
    request.method === 'POST' &&
    request.url === '/internal/markdown/convert'
  ) {
    await handleMarkdownRequest(request, response);
    return;
  }
  if (
    request.method === 'POST' &&
    (request.url === '/internal/documents/inspect' ||
      request.url === '/internal/documents/edit' ||
      request.url === '/internal/documents/undo')
  ) {
    await handleDocumentRequest(request, response);
    return;
  }
  if (request.url === '/internal/commands' && request.method === 'POST') {
    await handleServiceCommandRequest(
      request,
      response,
      config.secret,
      async (command) => {
        if (command.expectedRevision !== undefined) {
          assertRoomAvailable(command.room);
          if (await isRoomEvicting(command.room))
            throw new Error('material changed concurrently');
          const live = server.hocuspocus.documents.get(command.room);
          const result = await store.replaceMaterialContent(
            command,
            live ? Y.encodeStateAsUpdate(live) : undefined
          );
          if (live) Y.applyUpdate(live, result.update, 'service-edit');
          await projections.projectAndRecord(
            command.materialId,
            result.version,
            result.content,
            'service_edit_projection'
          );
          live?.broadcastStateless(
            JSON.stringify({
              materialId: command.materialId,
              type: 'projection-updated',
              yjsVersion: result.version,
            })
          );
          return;
        }
        return executeServiceCommand(command, {
          assertRoomAvailable,
          commandConnectionAccess: (room, actorUserId) =>
            store.commandConnectionAccess(room, actorUserId),
          completions: serviceCommandCompletions,
          hocuspocus: instance,
          isRoomEvicting,
        });
      }
    );
    return;
  }
  if (request.url === '/healthz' || request.url === '/readyz') {
    response.setHeader('X-Capy-Release', process.env.RELEASE_SHA ?? '');
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
        `capy_collaboration_active_rooms ${instance.getDocumentsCount()}`,
        `capy_collaboration_connections ${instance.getConnectionsCount()}`,
        `capy_collaboration_authentication_failures_total ${authenticationFailures}`,
        `capy_collaboration_store_failures_total ${storeFailures}`,
        `capy_collaboration_failed_store_queue ${failedStores.size}`,
        `capy_collaboration_process_rss_bytes ${process.memoryUsage().rss}`,
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
    reportHttpError(response, error);
    if (!response.headersSent) {
      jsonResponse(
        response,
        500,
        {
          message: error instanceof Error ? error.message : String(error),
        },
        error
      );
    } else if (!response.writableEnded) {
      response.end();
    }
  });
});

/**
 * Direct AI document edits from the gateway. Materials commit through the
 * durable material path (isolated candidate, guards validated against the
 * durable pre-state); sources commit through the checkpoint CAS. Only the
 * committed delta is then fanned into the live room, so an uncommitted command
 * never reaches peers or a store snapshot.
 */
function serviceSecretOK(request: IncomingMessage): boolean {
  const header = request.headers['x-collaboration-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  return (
    !!provided &&
    Buffer.byteLength(provided) === Buffer.byteLength(config.secret) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(config.secret))
  );
}

/** Go sends an agent note's markdown here before storing it. */
async function handleMarkdownRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (!serviceSecretOK(request)) {
    jsonResponse(response, 401, { message: 'invalid service secret' });
    return;
  }
  let body: { markdown?: unknown };
  try {
    body = (await readInternalCommandJson(request)) as { markdown?: unknown };
  } catch {
    jsonResponse(response, 400, {
      code: 'invalid_input',
      message: 'invalid JSON',
    });
    return;
  }
  if (typeof body?.markdown !== 'string') {
    jsonResponse(response, 400, {
      code: 'invalid_input',
      message: 'markdown is required',
    });
    return;
  }
  let converted: Awaited<ReturnType<typeof convertAgentMarkdown>>;
  try {
    converted = await convertAgentMarkdown(body.markdown);
  } catch (error) {
    jsonResponse(response, 400, {
      code: 'invalid_input',
      message: (error as Error).message,
    });
    return;
  }
  jsonResponse(response, 200, converted);
}

async function handleDocumentRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (!serviceSecretOK(request)) {
    jsonResponse(response, 401, { message: 'invalid service secret' });
    return;
  }
  try {
    const body = (await readInternalCommandJson(request)) as DocumentRequest;
    if (
      !body ||
      typeof body.actorUserId !== 'string' ||
      !body.target ||
      (body.target.kind !== 'material' && body.target.kind !== 'source_file') ||
      typeof body.target.id !== 'string'
    ) {
      jsonResponse(response, 400, {
        code: 'invalid_input',
        message: 'invalid document request',
      });
      return;
    }
    if (request.url === '/internal/documents/inspect') {
      if (body.target.kind === 'material') {
        if (typeof body.room !== 'string')
          throw new EditError('invalid_input', 'room is required');
        jsonResponse(
          response,
          200,
          await store.inspectMaterialDocument(body.room)
        );
      } else {
        jsonResponse(
          response,
          200,
          await sources.inspect(body.target.id, body.actorUserId)
        );
      }
      return;
    }
    if (!body.operation || typeof body.operation.id !== 'string') {
      throw new EditError('invalid_input', 'operation identity is required');
    }
    const undo =
      request.url === '/internal/documents/undo'
        ? {
            guards: (body.guards ?? []) as never,
            inverse: (body.inverse ?? []) as never,
            undoOf: String(body.undoOf ?? ''),
          }
        : undefined;
    if (undo && !undo.undoOf)
      throw new EditError('invalid_input', 'undoOf is required');
    if (body.target.kind === 'material') {
      if (typeof body.room !== 'string')
        throw new EditError('invalid_input', 'room is required');
      assertRoomAvailable(body.room);
      if (await isRoomEvicting(body.room)) {
        throw new Error('collaboration room is being compacted');
      }
      const live = server.hocuspocus.documents.get(body.room);
      const result = await store.applyMaterialEdit({
        actorUserId: body.actorUserId,
        commands: (body.commands ?? []) as never,
        liveState: live ? Y.encodeStateAsUpdate(live) : undefined,
        operation: body.operation,
        provenance: body.provenance,
        room: body.room,
        undo,
      });
      if (result.update && live) {
        Y.applyUpdate(live, result.update, 'service-edit');
      }
      // An AI edit or its Undo can bring back a quiz or image the note had
      // trashed (restored) or one purged since (dropped).
      if (result.update)
        queueChildrenPass(body.room, body.actorUserId, result.update);
      if (result.version && result.content) {
        try {
          await projections.projectAndRecord(
            materialIdFromRoom(body.room),
            result.version,
            result.content,
            'service_edit_projection'
          );
          await store.markOperationProjected(result.receipt.operationId);
          if (result.receipt.effect)
            result.receipt.effect.projectionPending = false;
          live?.broadcastStateless(
            JSON.stringify({
              materialId: materialIdFromRoom(body.room),
              type: 'projection-updated',
              yjsVersion: result.version,
            })
          );
        } catch {
          // The Yjs change is durable; the lag scanner catches the projection up
          // and the receipt keeps reporting projectionPending until then.
        }
      }
      jsonResponse(response, 200, result.receipt);
      return;
    }
    const result = await sources.applyEdit({
      actorUserId: body.actorUserId,
      commands: (body.commands ?? []) as never,
      epoch: typeof body.epoch === 'number' ? body.epoch : undefined,
      fileId: body.target.id,
      liveState: (room) => {
        const open = server.hocuspocus.documents.get(room);
        return open ? Y.encodeStateAsUpdate(open) : undefined;
      },
      operation: { ...body.operation, actorUserId: body.actorUserId },
      undo,
    });
    const live = server.hocuspocus.documents.get(result.room);
    if (live) Y.applyUpdate(live, result.state, 'service-edit');
    jsonResponse(response, 200, result.receipt);
  } catch (error) {
    if (error instanceof EditError) {
      jsonResponse(response, 409, { code: error.code, message: error.message });
      return;
    }
    if (error instanceof CollaborationAuthorizationError) {
      jsonResponse(response, 403, {
        code: 'lifecycle_rejected',
        message: error.message,
      });
      return;
    }
    if (error instanceof MaterialDocumentLimitError) {
      jsonResponse(response, 422, {
        code: 'quota_rejected',
        message: error.message,
      });
      return;
    }
    if (error instanceof SourceRequestError) {
      jsonResponse(
        response,
        error.status,
        {
          code:
            error.status === 409
              ? 'stale_target'
              : error.status === 423
                ? 'office_editing_paused'
                : 'unavailable_target',
          message: error.message,
        },
        error
      );
      return;
    }
    console.error('document request failed', error);
    jsonResponse(
      response,
      503,
      {
        code: 'outcome_unknown',
        message: 'document edit failed',
      },
      error
    );
  }
}

interface DocumentRequest {
  actorUserId: string;
  commands?: unknown[];
  epoch?: number;
  guards?: unknown[];
  inverse?: unknown[];
  operation?: {
    callId?: string;
    conversationId?: string;
    id: string;
    messageId?: string;
    requestHash: string;
    toolVersion?: number;
  };
  provenance?: unknown;
  room?: string;
  target: { id: string; kind: 'material' | 'source_file' };
  undoOf?: string;
}

const failedStoreRetries = new FailedStoreRetryRunner(
  failedStores,
  async (room, failed, clearIfCurrent) => {
    if (
      roomEvictions.isDiscarding(room) ||
      roomEvictions.isDraining(room) ||
      roomEvictions.isRejected(room)
    )
      return;
    // A loaded room saves through its own store path (Hocuspocus's debouncer
    // and save mutex; a source room's save queue behind it), so the retry
    // never races its live save; that save holds everything the failed
    // snapshot did and reports the outcome as usual.
    const live = server.hocuspocus.documents.get(room);
    if (live) {
      await server.hocuspocus.storeDocumentHooks(
        live,
        {
          clientsCount: live.getConnectionsCount(),
          document: live,
          documentName: room,
          instance: server.hocuspocus,
          lastContext: {},
          lastTransactionOrigin: { source: 'local' },
        },
        true
      );
      return;
    }
    // A room that unloaded with a failed save (a drain whose last flush
    // failed) retries its failed snapshot here.
    const finish = beginStore(room);
    const document = scratchDoc();
    try {
      Y.applyUpdate(document, failed.state);
      const snapshot = roomSnapshot(document);
      if (SOURCE_ROOM_PATTERN.test(room)) {
        const stored = await sources.store(room, snapshot, failed.eventId);
        clearIfCurrent();
        const live = server.hocuspocus.documents.get(room);
        if (live) {
          clearDocumentContributors(live, stored.contributors);
          sourceReceipt(live, failed.checkpointIds, stored.checkpoint);
        }
        return;
      }
      const stored = await store.store(room, snapshot);
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
      if (SOURCE_ROOM_PATTERN.test(room)) {
        reportServiceSecret(error, room);
        // As in storeSource: a refusal for good tells the clients (read-only,
        // or reset to the last saved version) and discards the room.
        const readOnly = readOnlyRefusal(error);
        const refused =
          !readOnly && (sourceSaveRefused(error) || slowSaves.failed(room));
        if (readOnly || refused) {
          if (refused) reportFailedStore(failed, error, room);
          slowSaves.clear(room);
          server.hocuspocus.documents.get(room)?.broadcastStateless(
            JSON.stringify(
              readOnly
                ? { room, type: 'room-read-only' }
                : {
                    type: 'source-checkpoint-failed',
                    ...sourceRoom(room),
                    checkpointIds: failed.checkpointIds,
                    ...(lostSourceAccess(error) && { lostAccess: true }),
                    recoverable: false,
                  }
            )
          );
          clearIfCurrent();
          rejectAuthorizationRoom(room);
        } else reportFailedStore(failed, error, room);
        return;
      }
      if (
        !handleRejectedStore(
          room,
          error,
          server.hocuspocus.documents.get(room),
          clearIfCurrent
        )
      )
        reportFailedStore(failed, error, room);
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
        'capy:collaboration:evict',
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
  'capy:collaboration:comments',
  'capy:collaboration:evict',
  USER_EVICTION_CHANNEL,
  EVICTION_REQUEST_CHANNEL,
  EVICTION_ACK_CHANNEL,
  SOURCE_HANDOFF_CHANNEL
);
subscriber.on('message', (channel: string, raw: string) => {
  if (channel === SOURCE_HANDOFF_CHANNEL) {
    void sourceHandoff
      .handle(raw)
      .catch((error) => captureError(error, { stage: 'source_handoff' }));
    return;
  }
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
    if (channel === 'capy:collaboration:evict') {
      if (SOURCE_ROOM_PATTERN.test(room)) {
        void evictLocalRoom(
          room,
          raw,
          event.evictionId,
          parseRoomEvictionMode(event.mode)
        )
          .then(async () => {
            if (event.evictionId)
              await redis.publish(
                EVICTION_DELIVERED_CHANNEL,
                JSON.stringify({
                  evictionId: event.evictionId,
                  instanceId: INSTANCE_ID,
                  ok: true,
                })
              );
          })
          .catch((error) =>
            captureError(error, { room, stage: 'source_eviction' })
          );
        return;
      }
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

let schedulingSources = false;
const sourceRefreshTimer = setInterval(() => {
  if (schedulingSources) return;
  schedulingSources = true;
  void sources
    .scheduleRefreshes((input) => sourceHandoff.publish(input))
    .catch((error) => captureError(error, { stage: 'source_refresh' }))
    .finally(() => {
      schedulingSources = false;
    });
}, 5000);
sourceRefreshTimer.unref();

// Rebuilds a room-unload trigger missed (another instance still had the room,
// a restart): every minute, files with a pending rebuild, no refresh in flight
// and no refused rebuild, skipping one found in use for five minutes.
const rebuildBackoff = new Map<string, number>();
let sweepingRebuilds = false;
const rebuildTimer = setInterval(() => {
  if (sweepingRebuilds) return;
  sweepingRebuilds = true;
  void (async () => {
    const now = Date.now();
    for (const [fileId, until] of rebuildBackoff)
      if (until <= now) rebuildBackoff.delete(fileId);
    // Files waiting out a backoff are left out of the query, so they never
    // fill its batch.
    for (const fileId of await sources.pendingRebuilds([
      ...rebuildBackoff.keys(),
    ])) {
      try {
        if (!(await sourceHandoff.rebuild(fileId)))
          rebuildBackoff.set(fileId, now + 5 * 60_000);
      } catch (error) {
        rebuildBackoff.set(fileId, now + 10 * 60_000);
        captureError(error, { stage: 'source_rebuild' });
      }
    }
  })()
    .catch((error) => captureError(error, { stage: 'source_rebuild' }))
    .finally(() => {
      sweepingRebuilds = false;
    });
}, 60_000);
rebuildTimer.unref();

// The maintenance pause (office_editing_pause, set by operators) reaches this
// instance within 5 s: each loaded Office room flushes, persists and closes
// its writers once. A room that loads later, or is mid-publication, follows on
// a later tick. Authentication refuses new writers, and a paused room refuses
// updates from any writer that slipped through, until the row is gone.
let pauseChecked = new WeakSet<Document>();
const officePauseTimer = setInterval(() => {
  void (async () => {
    const { rows } = await pool.query<{ paused: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM office_editing_pause) AS paused'
    );
    if (!rows[0].paused) {
      pauseChecked = new WeakSet();
      pausedRooms = new WeakSet();
      return;
    }
    await Promise.all(
      [...server.hocuspocus.documents.values()]
        .filter(
          (document) =>
            SOURCE_ROOM_PATTERN.test(document.name) &&
            !pauseChecked.has(document) &&
            !sourceHandoff.busy(document.name)
        )
        .map(async (document) => {
          pauseChecked.add(document);
          if (!(await sources.editingPaused(document.name))) return;
          await sourceHandoff.pause(document);
          pausedRooms.add(document);
        })
    );
  })().catch((error) => captureError(error, { stage: 'office_pause' }));
}, 5000);
officePauseTimer.unref();

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
  clearInterval(sourceRefreshTimer);
  clearInterval(rebuildTimer);
  clearInterval(officePauseTimer);
  projections.stop();
  server.hocuspocus.flushPendingStores();
  await server.destroy();
  await closeOfficeRuntime();
  await Promise.allSettled([subscriber.quit(), redis.quit(), pool.end()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
