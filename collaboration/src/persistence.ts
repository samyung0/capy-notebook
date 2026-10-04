import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import type { Pool, PoolClient } from 'pg';
import * as Y from 'yjs';
import type { CollaborationAccess } from './auth.js';
import {
  applyCollaborationCommand,
  type CollaborationCommand,
} from './commands.js';
import {
  type DocumentContributor,
  documentContributors,
  type RoomSnapshot,
  removeDocumentContributors,
} from './contributors.js';
import {
  applyMaterialCommands,
  type DocumentCommand,
  EditError,
  type GuardTarget,
  type InspectedBlock,
  inspectMaterial,
  verifyMaterialGuards,
} from './editCommands.js';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
  type MaterialDocumentMetrics,
  type MaterialLimitCode,
  materialLimitCode,
  measureMaterialValue,
  recoversMaterialLimits,
} from './limits.js';
import { assertCanonicalMaterialValue } from './materialDocument.js';
import { inspectUpdate } from './officeRoots.js';
import { scratchDoc } from './scratchDoc.js';

const CONTENT_ROOT = 'content';
const CONTRIBUTORS_ROOT = '__capy_pending_contributors';
const ROOM_PATTERN = /^material:([A-Za-z0-9_-]+):schema:(\d+)$/;
// Measuring a document means cloning it and serializing it to Plate JSON, so
// doing it per inbound update costs O(document) per keystroke. Amortize it over
// a budget of applied update bytes, and fall back to measuring every update
// once the document is close enough to a limit that the budget could overshoot.
const VALIDATION_BUDGET_BYTES = 32 * 1024;
const VALIDATION_HEADROOM = 0.9;
const DEPTH_HEADROOM = 4;

/** Trusted operation identity forwarded by the gateway for one edit or Undo. */
/**
 * The two encodings of a committed edit: the delta the live room still lacks,
 * computed while the room's contributor markers are intact so the room keeps
 * them (its own store asserts each contributor's access), and the durable
 * state with those server-owned markers stripped, as the ordinary store does.
 */
export function durableCommit(merged: Y.Doc, liveState?: Uint8Array) {
  const update = liveState
    ? Y.encodeStateAsUpdate(merged, Y.encodeStateVectorFromUpdate(liveState))
    : null;
  if (liveState)
    removeDocumentContributors(merged, documentContributors(merged));
  const state = Y.encodeStateAsUpdate(merged);
  return { state, update: update ?? state };
}

/** Owner-charged inverse plus guards of one material edit; larger edits are not undoable and are refused. */
export const MAX_EDIT_INVERSE_BYTES = 256 * 1024;

export interface EditOperation {
  callId?: string;
  conversationId?: string;
  id: string;
  messageId?: string;
  requestHash: string;
  toolVersion?: number;
}

export interface MaterialEditInput {
  actorUserId: string;
  commands: DocumentCommand[];
  /** State vector of the live room document, to return only the missing delta. */
  /** Full state of the open live room, merged into the pre-state first. */
  liveState?: Uint8Array;
  operation: EditOperation;
  /** Merged attribution record the gateway computed; stored with the edit. */
  provenance?: unknown;
  room: string;
  undo?: {
    guards: GuardTarget[];
    inverse: DocumentCommand[];
    undoOf: string;
  };
}

/** Wire shape of store.AgentOperation as the gateway decodes it. */
export interface Receipt {
  callId?: string;
  effect?: Record<string, unknown>;
  kind: string;
  operationId: string;
  outcome: string;
  toolVersion: number;
  workspaceId?: string;
}

export interface MaterialEditResult {
  content?: { schemaVersion: 1; value: unknown[] };
  receipt: Receipt;
  /** Delta to apply to the live room, or null when the call was a replay. */
  update: Uint8Array | null;
  version?: number;
}

type ReceiptRow = {
  call_id: string | null;
  effect: Record<string, unknown> | null;
  id: string;
  kind: string;
  outcome: string;
  request_hash: string;
  tool_version: number;
  workspace_id: string | null;
};

function receiptFromRow(row: ReceiptRow): Receipt {
  return {
    callId: row.call_id ?? undefined,
    effect: row.effect ?? undefined,
    kind: row.kind,
    operationId: row.id,
    outcome: row.outcome,
    toolVersion: Number(row.tool_version),
    workspaceId: row.workspace_id ?? undefined,
  };
}

export interface StoredDocument {
  content: { schemaVersion: 1; value: unknown[] };
  contributors: DocumentContributor[];
  limitCode: MaterialLimitCode | null;
  metrics: MaterialDocumentMetrics;
  state: Uint8Array;
  version: number;
}

/**
 * Per-room accounting that decides when the expensive measurement is worth
 * running and remembers the last accepted metrics as the shrink baseline.
 */
class RoomValidator {
  metrics: MaterialDocumentMetrics | null = null;
  pendingBytes = 0;

  shouldMeasure(): boolean {
    if (!this.metrics) return true;
    if (this.pendingBytes >= VALIDATION_BUDGET_BYTES) return true;
    return (
      this.metrics.contentBytes + this.pendingBytes >
        MATERIAL_DOCUMENT_LIMITS.maxContentBytes * VALIDATION_HEADROOM ||
      this.metrics.nodeCount + this.pendingBytes >
        MATERIAL_DOCUMENT_LIMITS.maxNodes * VALIDATION_HEADROOM ||
      this.metrics.maxDepth >=
        MATERIAL_DOCUMENT_LIMITS.maxDepth - DEPTH_HEADROOM
    );
  }

  accept(metrics: MaterialDocumentMetrics) {
    this.metrics = metrics;
    this.pendingBytes = 0;
  }
}

export function materialIdFromRoom(room: string): string {
  const match = ROOM_PATTERN.exec(room);
  if (!match) throw new Error('invalid collaboration room');
  return match[1];
}

export function roomSchemaFromRoom(room: string): number {
  const match = ROOM_PATTERN.exec(room);
  if (!match) throw new Error('invalid collaboration room');
  const schema = Number(match[2]);
  if (!Number.isSafeInteger(schema) || schema < 1) {
    throw new Error('invalid collaboration room schema');
  }
  return schema;
}

async function lockMaterial(client: PoolClient, materialId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    materialId,
  ]);
}

type LiveAccessRow = {
  actor_deleted_at: Date | null;
  actor_deletion_requested_at: Date | null;
  actor_frozen: boolean;
  actor_suspended_at: Date | null;
  material_owner_id: string;
  material_privacy: string;
  member_role: string;
  owner_deleted_at: Date | null;
  owner_deletion_requested_at: Date | null;
  owner_frozen: boolean;
  owner_full: boolean;
  owner_suspended_at: Date | null;
  share_role: string | null;
  workspace_id: string | null;
  workspace_owner_id: string | null;
  workspace_privacy: string | null;
};

type Queryable = Pick<Pool, 'query'>;

const roleRank: Record<string, number> = {
  editor: 2,
  owner: 3,
  viewer: 1,
};

// Mirrors Go's over_quota_frozen (store.applyQuotaState): no live Pro period,
// the latest Pro period ended or closed at least 14 days ago, and stored plus
// reserved bytes over the Free limit. A frozen account is read-only on both
// sides: as the actor, and as the owner every collaborator writes into.
function frozenSQL(userAlias: string, storageAlias: string): string {
  return `NOT EXISTS(SELECT 1 FROM user_subscriptions live_sub
        WHERE live_sub.user_id=${userAlias}.id
          AND live_sub.plan_tier='pro'
          AND live_sub.status IN ('active','trialing','past_due')
          AND (live_sub.current_period_end IS NULL
            OR live_sub.current_period_end > now()))
      AND GREATEST(
        (SELECT max(expired_sub.current_period_end)
          FROM user_subscriptions expired_sub
          WHERE expired_sub.user_id=${userAlias}.id
            AND expired_sub.plan_tier='pro'
            AND expired_sub.status IN ('active','trialing','past_due')
            AND expired_sub.current_period_end <= now()),
        (SELECT max(LEAST(
            COALESCE(closed_sub.current_period_end, closed_sub.ended_at,
              closed_sub.canceled_at,
              to_timestamp(NULLIF(closed_sub.stripe_event_created, 0)),
              closed_sub.updated_at),
            COALESCE(closed_sub.ended_at, closed_sub.canceled_at,
              to_timestamp(NULLIF(closed_sub.stripe_event_created, 0)),
              closed_sub.updated_at)))
          FROM user_subscriptions closed_sub
          WHERE closed_sub.user_id=${userAlias}.id
            AND closed_sub.plan_tier='pro'
            AND closed_sub.status NOT IN ('active','trialing','past_due'))
      ) <= now() - interval '14 days'
      AND COALESCE(${storageAlias}.used_bytes, 0)
        + COALESCE(${storageAlias}.reserved_bytes, 0)
        + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas delta
          WHERE delta.user_id=${userAlias}.id), 0)
        > (SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier='free')`;
}

// Mirrors Go's StorageUsage.Full (store.unlockedStorageUsage): stored plus
// reserved bytes at or over the current plan's limit, which is Free once a paid
// period has lapsed, so grace counts. Everything an owner at its limit pays for
// is view-only for every collaborator.
function fullSQL(userAlias: string, storageAlias: string): string {
  return `COALESCE(${storageAlias}.used_bytes, 0)
        + COALESCE(${storageAlias}.reserved_bytes, 0)
        + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas delta
          WHERE delta.user_id=${userAlias}.id), 0)
        >= (SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier=CASE
          WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
            WHERE any_sub.user_id=${userAlias}.id) THEN ${userAlias}.plan_tier
          ELSE COALESCE((SELECT live.plan_tier FROM user_subscriptions live
            WHERE live.user_id=${userAlias}.id
              AND live.status IN ('active','trialing','past_due')
              AND (live.current_period_end IS NULL
                OR live.current_period_end > now())
            ORDER BY (live.plan_tier='pro') DESC,
              live.current_period_end DESC NULLS FIRST LIMIT 1), 'free')
          END)`;
}

/** Authentication refusal reasons the client acts on (see onAuthenticate): a
 * missing or trashed document shows the file-missing panel, lost access the
 * no-access panel. Any other refusal is retried with a fresh token. */
export const COLLABORATION_NOT_FOUND_REASON = 'collaboration-not-found';
export const COLLABORATION_FORBIDDEN_REASON = 'collaboration-forbidden';

export class CollaborationAuthorizationError extends Error {
  readonly reason: string = COLLABORATION_FORBIDDEN_REASON;
}

export class CollaborationNotFoundError extends CollaborationAuthorizationError {
  override readonly reason: string = COLLABORATION_NOT_FOUND_REASON;
}

export const COLLABORATION_READ_ONLY_REASON = 'collaboration-read-only';

/** A writer whose room turned read-only: the storage owner is suspended,
 * frozen or at its storage limit, or the writer's own account is frozen. The
 * editor drops to view. `reason` reaches the client when authentication
 * refuses it. */
export class CollaborationReadOnlyError extends CollaborationAuthorizationError {
  override readonly reason: string = COLLABORATION_READ_ONLY_REASON;
}

function denyCollaboration(message: string): never {
  throw new CollaborationAuthorizationError(message);
}

function denyMissingMaterial(): never {
  throw new CollaborationNotFoundError('material not found');
}

type LiveAccess = { frozen: boolean; full: boolean; suspended: boolean };

function accessOf(live: LiveAccess): CollaborationAccess {
  return live.suspended || live.frozen || live.full ? 'read' : 'write';
}

async function liveCollaborationAccess(
  queryable: Queryable,
  materialId: string,
  actorUserId: string
): Promise<LiveAccess> {
  const result = await queryable.query<LiveAccessRow>(
    `SELECT m.owner_user_id AS material_owner_id,
      m.privacy AS material_privacy, m.workspace_id,
      owner.deleted_at AS owner_deleted_at,
      owner.deletion_requested_at AS owner_deletion_requested_at,
      owner.suspended_at AS owner_suspended_at,
      actor.deleted_at AS actor_deleted_at,
      actor.deletion_requested_at AS actor_deletion_requested_at,
      actor.suspended_at AS actor_suspended_at,
      w.user_id AS workspace_owner_id, w.privacy AS workspace_privacy,
      w.share_role, COALESCE(wm.role, '') AS member_role,
      ${frozenSQL('owner', 'owner_storage')} AS owner_frozen,
      ${fullSQL('owner', 'owner_storage')} AS owner_full,
      ${frozenSQL('actor', 'actor_storage')} AS actor_frozen
     FROM materials m
     JOIN users owner ON owner.id=m.owner_user_id
     JOIN users actor ON actor.id=$2
     LEFT JOIN workspaces w ON w.id=m.workspace_id
     LEFT JOIN workspace_members wm
       ON wm.workspace_id=w.id AND wm.user_id=$2
     LEFT JOIN user_storage owner_storage ON owner_storage.user_id=owner.id
     LEFT JOIN user_storage actor_storage ON actor_storage.user_id=actor.id
     WHERE m.id=$1 AND m.trashed_at IS NULL`,
    [materialId, actorUserId]
  );
  if (result.rowCount === 0) denyMissingMaterial();
  const row = result.rows[0];
  if (row.owner_deleted_at || row.owner_deletion_requested_at) {
    denyMissingMaterial();
  }
  if (
    row.actor_deleted_at ||
    row.actor_deletion_requested_at ||
    row.actor_suspended_at
  ) {
    denyCollaboration('actor account is locked');
  }

  let effectiveRole = '';
  if (
    actorUserId === row.material_owner_id ||
    actorUserId === row.workspace_owner_id
  ) {
    effectiveRole = 'owner';
  } else {
    let sharedRole = '';
    if (
      row.workspace_id &&
      (row.workspace_privacy === 'link' || row.workspace_privacy === 'public')
    ) {
      sharedRole = row.share_role ?? 'viewer';
    } else if (
      !row.workspace_id &&
      (row.material_privacy === 'link' || row.material_privacy === 'public')
    ) {
      sharedRole = 'viewer';
    }
    effectiveRole =
      (roleRank[row.member_role] ?? 0) >= (roleRank[sharedRole] ?? 0)
        ? row.member_role
        : sharedRole;
  }
  // Viewers never hold a room; editors are narrowed to read by a suspended or
  // frozen owner, an owner at its storage limit, or their own frozen account.
  if ((roleRank[effectiveRole] ?? 0) < roleRank.editor) {
    denyCollaboration('material access was revoked');
  }
  return {
    frozen: row.owner_frozen || row.actor_frozen,
    full: row.owner_full,
    suspended: row.owner_suspended_at !== null,
  };
}

async function assertLiveCollaborationAccess(
  queryable: Queryable,
  materialId: string,
  actorUserId: string,
  requested: CollaborationAccess
) {
  const live = await liveCollaborationAccess(
    queryable,
    materialId,
    actorUserId
  );
  if (requested === 'write' && accessOf(live) !== 'write') {
    throw new CollaborationReadOnlyError('collaboration access changed');
  }
}

type LockedAccount = {
  deleted_at: Date | null;
  deletion_requested_at: Date | null;
  id: string;
  suspended_at: Date | null;
};

// Match Go's structural mutation order: workspace (when present), ordered
// accounts, then material. The advisory lock serializes Yjs stores only; it
// does not participate in SQL row-lock deadlock detection.
async function lockCollaborationBoundary(
  client: PoolClient,
  materialId: string,
  actorUserIds: readonly string[]
) {
  const placement = await client.query<{
    kind: string;
    owner_user_id: string;
    workspace_id: string | null;
  }>(
    'SELECT owner_user_id, workspace_id, kind FROM materials WHERE id=$1 AND trashed_at IS NULL',
    [materialId]
  );
  if (placement.rowCount === 0) denyMissingMaterial();
  const expected = placement.rows[0];
  const workspaceId = expected.workspace_id;
  if (workspaceId) {
    const workspace = await client.query(
      'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',
      [workspaceId]
    );
    if (workspace.rowCount === 0) denyMissingMaterial();
  }

  const accountIds = [
    ...new Set([expected.owner_user_id, ...actorUserIds]),
  ].sort();
  const accounts = await client.query<LockedAccount>(
    `SELECT u.id, u.deleted_at, u.deletion_requested_at, u.suspended_at
     FROM users u
     WHERE u.id=ANY($1::text[])
     ORDER BY u.id
     FOR SHARE OF u`,
    [accountIds]
  );
  if (accounts.rowCount !== accountIds.length) {
    denyCollaboration('collaboration account not found');
  }

  const material = await client.query<{
    kind: string;
    owner_user_id: string;
    workspace_id: string | null;
  }>(
    `SELECT owner_user_id, workspace_id, kind
     FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE`,
    [materialId]
  );
  if (material.rowCount === 0) denyMissingMaterial();
  const locked = material.rows[0];
  if (
    locked.owner_user_id !== expected.owner_user_id ||
    locked.workspace_id !== expected.workspace_id ||
    locked.kind !== expected.kind
  ) {
    denyCollaboration('material placement changed');
  }
  return {
    accounts: new Map(accounts.rows.map((account) => [account.id, account])),
    materialKind: expected.kind,
    ownerUserId: expected.owner_user_id,
  };
}

function applyStoredState(document: Y.Doc, state: Buffer | Uint8Array) {
  if (state.byteLength > 0) Y.applyUpdate(document, new Uint8Array(state));
}

export function assertMaterialDocumentRoots(document: Y.Doc) {
  for (const name of document.share.keys()) {
    if (name !== CONTENT_ROOT && name !== CONTRIBUTORS_ROOT) {
      throw new Error(`unsupported collaboration document root: ${name}`);
    }
  }
  type RootStructure = {
    _map: Map<string, unknown>;
    _start: unknown;
  };
  if (document.share.has(CONTENT_ROOT)) {
    const content = document.get(CONTENT_ROOT, Y.XmlText) as Y.XmlText &
      RootStructure;
    if (content._map.size > 0) {
      throw new Error('invalid collaboration content root');
    }
  }
  if (document.share.has(CONTRIBUTORS_ROOT)) {
    const contributors = document.getMap(CONTRIBUTORS_ROOT) as Y.Map<unknown> &
      RootStructure;
    if (contributors._start !== null) {
      throw new Error('invalid collaboration contributor root');
    }
  }
}

/**
 * Whether `update` keeps `current`'s roots as assertMaterialDocumentRoots
 * requires, read from the update's own structs instead of a merged copy of
 * the room: true or false, or null when it cannot tell (either side refers to
 * content not held yet), which leaves the answer to the merged copy.
 */
function updateKeepsMaterialRoots(current: Y.Doc, update: Uint8Array) {
  if (current.store.pendingStructs || current.store.pendingDs) return null;
  const { containers, unheld } = inspectUpdate(current, update);
  if (unheld) return null;
  // Content takes children only; contributors take map entries only.
  return containers.every(({ key, root }) =>
    root === CONTENT_ROOT
      ? key === null
      : root === CONTRIBUTORS_ROOT && key !== null
  );
}

function plateValue(document: Y.Doc): unknown[] {
  assertMaterialDocumentRoots(document);
  const root = yTextToSlateElement(document.get(CONTENT_ROOT, Y.XmlText)) as {
    children?: unknown[];
  };
  return Array.isArray(root.children) ? root.children : [];
}

function measureState(state: Buffer | Uint8Array): MaterialDocumentMetrics {
  const document = scratchDoc();
  try {
    applyStoredState(document, state);
    return measureMaterialValue(plateValue(document));
  } finally {
    document.destroy();
  }
}

export class YjsDocumentStore {
  private readonly pool: Pool;
  private readonly validators = new Map<string, RoomValidator>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Rejects an inbound update before it reaches the authoritative document.
   * Rejecting after the fact is not an option: Yjs has no notion of undoing a
   * peer's update, so the only remedy left would be discarding the whole room.
   */
  validateUpdate(room: string, current: Y.Doc, update: Uint8Array) {
    let validator = this.validators.get(room);
    if (!validator) {
      validator = new RoomValidator();
      this.validators.set(room, validator);
    }
    validator.pendingBytes += update.byteLength;
    assertMaterialDocumentRoots(current);
    const measure = validator.shouldMeasure();
    // The common case: no measurement due and the roots provably kept, so
    // the room is not copied for every keystroke.
    if (!measure && updateKeepsMaterialRoots(current, update)) return;
    const candidate = scratchDoc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
      Y.applyUpdate(candidate, update);
      assertMaterialDocumentRoots(candidate);
    } catch (error) {
      candidate.destroy();
      throw error;
    }
    if (!measure) {
      candidate.destroy();
      return;
    }
    // A document that loaded from PostgreSQL already over the limit still needs
    // a baseline, otherwise the edits that would bring it back under are the
    // ones we reject.
    if (!validator.metrics) {
      validator.metrics = measureMaterialValue(plateValue(current));
    }
    let metrics: MaterialDocumentMetrics;
    try {
      metrics = measureMaterialValue(plateValue(candidate));
    } finally {
      candidate.destroy();
    }
    const code = materialLimitCode(metrics);
    if (code && !recoversMaterialLimits(metrics, validator.metrics)) {
      throw new MaterialDocumentLimitError(code, metrics);
    }
    validator.accept(metrics);
  }

  forgetRoom(room: string) {
    this.validators.delete(room);
  }

  async assertConnectionAccess(
    room: string,
    actorUserId: string,
    requested: CollaborationAccess
  ) {
    await assertLiveCollaborationAccess(
      this.pool,
      materialIdFromRoom(room),
      actorUserId,
      requested
    );
  }

  async commandConnectionAccess(
    room: string,
    actorUserId: string
  ): Promise<'write'> {
    const live = await liveCollaborationAccess(
      this.pool,
      materialIdFromRoom(room),
      actorUserId
    );
    if (accessOf(live) === 'read') {
      throw new CollaborationReadOnlyError('material access is read-only');
    }
    return 'write';
  }

  async currentRoom(materialId: string): Promise<string | null> {
    const result = await this.pool.query<{ room_schema: number }>(
      'SELECT room_schema FROM material_yjs_documents WHERE material_id=$1',
      [materialId]
    );
    if (result.rowCount === 0) return null;
    const room = `material:${materialId}:schema:${result.rows[0].room_schema}`;
    materialIdFromRoom(room);
    return room;
  }

  async load(room: string, target: Y.Doc): Promise<void> {
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      let result = await client.query<{ state: Buffer; room_schema: number }>(
        'SELECT state, room_schema FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE',
        [materialId]
      );
      if (result.rowCount === 0) {
        // Bootstrapping a room for a trashed material must fail: its content is
        // retained, but nothing may open or edit it until it is restored.
        const material = await client.query<{ content: unknown }>(
          'SELECT content FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE',
          [materialId]
        );
        if (material.rowCount === 0) throw new Error('material not found');
        const envelope = material.rows[0].content as {
          schemaVersion?: unknown;
          value?: unknown;
        };
        if (envelope?.schemaVersion !== 1 || !Array.isArray(envelope.value)) {
          throw new Error('material content is not a valid Plate envelope');
        }
        const bootstrap = scratchDoc();
        bootstrap
          .get(CONTENT_ROOT, Y.XmlText)
          .applyDelta(slateNodesToInsertDelta(envelope.value as never));
        const state = Buffer.from(Y.encodeStateAsUpdate(bootstrap));
        bootstrap.destroy();
        await client.query(
          `INSERT INTO material_yjs_documents
           (material_id, room_schema, state, stored_version, projected_version, projected_at)
           VALUES ($1,$2,$3,1,1,now())
           ON CONFLICT (material_id) DO NOTHING`,
          [materialId, roomSchema, state]
        );
        result = await client.query<{ state: Buffer; room_schema: number }>(
          'SELECT state, room_schema FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE',
          [materialId]
        );
      }
      if (Number(result.rows[0].room_schema) !== roomSchema) {
        throw new Error('stale collaboration room schema');
      }
      applyStoredState(target, result.rows[0].state);
      assertMaterialDocumentRoots(target);
      documentContributors(target);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Stores a room read at one instant (roomSnapshot). The merge below checks
   * the roots too (plateValue). */
  async store(room: string, current: RoomSnapshot): Promise<StoredDocument> {
    const { contributors, state: currentState } = current;
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const actors = [...new Set(contributors.map(({ userId }) => userId))];
    const client = await this.pool.connect();
    const merged = scratchDoc();
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      const boundary = await lockCollaborationBoundary(
        client,
        materialId,
        actors
      );
      // Frozen is enforced at admission (authentication, read tokens and the
      // 5 s per-update recheck), so updates already admitted are saved even if
      // their writer froze since. A writer must still hold its role.
      for (const actorUserId of actors) {
        await liveCollaborationAccess(client, materialId, actorUserId);
      }
      const lifecycle = boundary.accounts.get(boundary.ownerUserId);
      if (!lifecycle) throw new Error('material owner not found');
      if (
        lifecycle.deleted_at ||
        lifecycle.deletion_requested_at ||
        lifecycle.suspended_at
      ) {
        denyCollaboration('material owner account is locked');
      }
      const existing = await client.query<{
        state: Buffer;
        room_schema: number;
        stored_version: string;
      }>(
        `SELECT state, room_schema, stored_version
         FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`,
        [materialId]
      );
      if (existing.rowCount) {
        if (Number(existing.rows[0].room_schema) !== roomSchema) {
          throw new Error('stale collaboration room schema');
        }
        applyStoredState(merged, existing.rows[0].state);
      }
      Y.applyUpdate(merged, currentState);
      const value = plateValue(merged);
      assertCanonicalMaterialValue(value, boundary.materialKind);
      const metrics = measureMaterialValue(value);
      const limitCode = materialLimitCode(metrics);
      if (limitCode) {
        const previous = existing.rowCount
          ? measureState(existing.rows[0].state)
          : null;
        if (!recoversMaterialLimits(metrics, previous)) {
          throw new MaterialDocumentLimitError(limitCode, metrics);
        }
      }
      removeDocumentContributors(merged, contributors);
      const state = Y.encodeStateAsUpdate(merged);
      const version = existing.rowCount
        ? Number(existing.rows[0].stored_version) + 1
        : 1;
      await client.query(
        `INSERT INTO material_yjs_documents
         (material_id, room_schema, state, stored_version, projected_version)
         VALUES ($1,$2,$3,$4,0)
         ON CONFLICT (material_id) DO UPDATE
         SET state=EXCLUDED.state,
             stored_version=EXCLUDED.stored_version,
             projection_error=NULL,
             updated_at=now()`,
        [materialId, roomSchema, Buffer.from(state), version]
      );
      await client.query('COMMIT');
      this.validators.get(room)?.accept(metrics);
      return {
        content: { schemaVersion: 1, value },
        contributors,
        limitCode,
        metrics,
        state,
        version,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      merged.destroy();
      client.release();
    }
  }

  /** Compare the loaded draft revision inside the transaction that commits its replacement. */
  async replaceMaterialContent(
    command: CollaborationCommand,
    liveState?: Uint8Array
  ) {
    const materialId = materialIdFromRoom(command.room);
    if (materialId !== command.materialId)
      throw new Error('command material does not match room');
    const roomSchema = roomSchemaFromRoom(command.room);
    const client = await this.pool.connect();
    const merged = scratchDoc();
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      const boundary = await lockCollaborationBoundary(client, materialId, [
        command.actorUserId,
      ]);
      await assertLiveCollaborationAccess(
        client,
        materialId,
        command.actorUserId,
        'write'
      );
      const material = await client.query<{ revision: string }>(
        'SELECT revision FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE',
        [materialId]
      );
      if (
        !material.rowCount ||
        Number(material.rows[0].revision) !== command.expectedRevision
      ) {
        throw new Error('material changed concurrently');
      }
      await this.bootstrapDurableState(client, materialId, roomSchema);
      const existing = await client.query<{
        state: Buffer;
        room_schema: number;
        stored_version: string;
        projected_version: string;
      }>(
        'SELECT state, room_schema, stored_version, projected_version FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE',
        [materialId]
      );
      const row = existing.rows[0];
      if (
        Number(row.room_schema) !== roomSchema ||
        row.stored_version !== row.projected_version
      ) {
        throw new Error('material changed concurrently');
      }
      applyStoredState(merged, row.state);
      if (liveState) Y.applyUpdate(merged, liveState);
      const previous = measureMaterialValue(plateValue(merged));
      applyCollaborationCommand(merged, command);
      const value = plateValue(merged);
      assertCanonicalMaterialValue(value, boundary.materialKind);
      const metrics = measureMaterialValue(value);
      const limitCode = materialLimitCode(metrics);
      if (limitCode && !recoversMaterialLimits(metrics, previous)) {
        throw new MaterialDocumentLimitError(limitCode, metrics);
      }
      const lifecycle = boundary.accounts.get(boundary.ownerUserId);
      if (
        !lifecycle ||
        lifecycle.deleted_at ||
        lifecycle.deletion_requested_at ||
        lifecycle.suspended_at
      ) {
        denyCollaboration('material owner account is locked');
      }
      const { state, update } = durableCommit(merged, liveState);
      const version = Number(row.stored_version) + 1;
      await client.query(
        'UPDATE material_yjs_documents SET state=$2, stored_version=$3, projection_error=NULL, updated_at=now() WHERE material_id=$1',
        [materialId, Buffer.from(state), version]
      );
      await client.query('COMMIT');
      return { content: { schemaVersion: 1 as const, value }, update, version };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      merged.destroy();
      client.release();
    }
  }

  /**
   * Apply a direct AI edit (or its Undo) to the durable Y.Doc under the
   * material lock and commit state, receipt and inverse in one transaction.
   *
   * Targets are validated against the durable pre-state merged with this
   * replica's live room, so both a change another replica committed and a
   * user's unsaved typing on the target refuse the whole call with
   * `stale_target`. The caller fans the committed delta out to the live
   * document.
   */
  async applyMaterialEdit(
    input: MaterialEditInput
  ): Promise<MaterialEditResult> {
    const materialId = materialIdFromRoom(input.room);
    const roomSchema = roomSchemaFromRoom(input.room);
    const client = await this.pool.connect();
    const merged = scratchDoc();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`agent-operation:${input.operation.id}`]
      );
      const replay = await client.query<ReceiptRow>(
        `SELECT id, kind, tool_version, request_hash, workspace_id, call_id, outcome, effect
         FROM agent_operations WHERE id=$1`,
        [input.operation.id]
      );
      if (replay.rowCount) {
        if (replay.rows[0].request_hash !== input.operation.requestHash) {
          throw new EditError(
            'invalid_input',
            'operation id already used with a different request'
          );
        }
        await client.query('COMMIT');
        return { receipt: receiptFromRow(replay.rows[0]), update: null };
      }
      await lockMaterial(client, materialId);
      const boundary = await lockCollaborationBoundary(client, materialId, [
        input.actorUserId,
      ]);
      await assertLiveCollaborationAccess(
        client,
        materialId,
        input.actorUserId,
        'write'
      );
      const lifecycle = boundary.accounts.get(boundary.ownerUserId);
      if (
        !lifecycle ||
        lifecycle.deleted_at ||
        lifecycle.deletion_requested_at ||
        lifecycle.suspended_at
      ) {
        denyCollaboration('material owner account is locked');
      }
      let existing = await client.query<{
        state: Buffer;
        room_schema: number;
        stored_version: string;
      }>(
        `SELECT state, room_schema, stored_version
         FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`,
        [materialId]
      );
      if (existing.rowCount === 0) {
        await this.bootstrapDurableState(client, materialId, roomSchema);
        existing = await client.query(
          `SELECT state, room_schema, stored_version
           FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`,
          [materialId]
        );
      }
      if (Number(existing.rows[0].room_schema) !== roomSchema) {
        throw new EditError(
          'stale_target',
          'the material was rebuilt since it was inspected'
        );
      }
      applyStoredState(merged, existing.rows[0].state);
      if (input.liveState) Y.applyUpdate(merged, input.liveState);
      const previous = measureMaterialValue(plateValue(merged));

      let commands = input.commands;
      if (input.undo) {
        verifyMaterialGuards(merged, input.undo.guards);
        commands = input.undo.inverse;
      }
      // Review state is per user and keyed by card id, so removing or
      // restoring a card through Undo needs no study bookkeeping here.
      const outcome = applyMaterialCommands(merged, commands);
      const value = plateValue(merged);
      assertCanonicalMaterialValue(value, boundary.materialKind);
      const metrics = measureMaterialValue(value);
      const limitCode = materialLimitCode(metrics);
      if (limitCode && !recoversMaterialLimits(metrics, previous)) {
        throw new MaterialDocumentLimitError(limitCode, metrics);
      }
      const { state, update } = durableCommit(merged, input.liveState);
      const version = Number(existing.rows[0].stored_version) + 1;
      await client.query(
        `UPDATE material_yjs_documents
         SET state=$2, stored_version=$3, projection_error=NULL, updated_at=now()
         WHERE material_id=$1`,
        [materialId, Buffer.from(state), version]
      );
      // The gateway merged this edit's books into the stored record; writing
      // it here keeps the credit and the content in one transaction.
      if (input.provenance) {
        await client.query('UPDATE materials SET provenance=$2 WHERE id=$1', [
          materialId,
          JSON.stringify(input.provenance),
        ]);
      }
      const material = await client.query<{
        title: string;
        kind: string;
        workspace_id: string | null;
      }>('SELECT title, kind, workspace_id FROM materials WHERE id=$1', [
        materialId,
      ]);
      const effect: Record<string, unknown> = {
        operation: input.undo ? 'edit_undone' : 'edited',
        operationId: input.operation.id,
        projectionPending: true,
        resource: {
          id: materialId,
          kind: 'material',
          materialKind: material.rows[0]?.kind ?? boundary.materialKind,
          title: material.rows[0]?.title ?? '',
          workspaceId: material.rows[0]?.workspace_id ?? '',
        },
        ...(input.undo
          ? {}
          : { undo: { operationId: input.operation.id, status: 'available' } }),
      };
      const kind = input.undo ? 'undo_edit' : 'edit_document';
      await client.query(
        `INSERT INTO agent_operations
         (id, kind, tool_version, request_hash, actor_user_id, workspace_id, conversation_id,
          message_id, call_id, outcome, effect)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),'succeeded',$10)`,
        [
          input.operation.id,
          kind,
          input.operation.toolVersion ?? 1,
          input.operation.requestHash,
          input.actorUserId,
          material.rows[0]?.workspace_id ?? '',
          input.operation.conversationId ?? '',
          input.operation.messageId ?? '',
          input.operation.callId ?? '',
          JSON.stringify(effect),
        ]
      );
      if (input.undo) {
        const consumed = await client.query(
          `UPDATE agent_edit_inverses
           SET undo_status='undone', undone_by=$2, inverse='[]'::jsonb, guards='[]'::jsonb,
               inverse_bytes=0, updated_at=now()
           WHERE operation_id=$1 AND undo_status='available'`,
          [input.undo.undoOf, input.operation.id]
        );
        if (consumed.rowCount === 0) {
          throw new EditError(
            'unavailable_target',
            'undo is no longer available for this edit'
          );
        }
      } else {
        const inverse = JSON.stringify({ commands: outcome.inverse });
        const guards = JSON.stringify(outcome.guards);
        const inverseBytes =
          Buffer.byteLength(inverse) + Buffer.byteLength(guards);
        if (inverseBytes > MAX_EDIT_INVERSE_BYTES)
          throw new MaterialDocumentLimitError(
            'undo_payload_exceeded',
            metrics
          );
        await client.query(
          `INSERT INTO agent_edit_inverses
           (operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id,
            incarnation, revision, inverse, guards, inverse_bytes)
           VALUES ($1,'material',$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10)`,
          [
            input.operation.id,
            materialId,
            input.actorUserId,
            boundary.ownerUserId,
            material.rows[0]?.workspace_id ?? '',
            roomSchema,
            version,
            inverse,
            guards,
            inverseBytes,
          ]
        );
      }
      await client.query('COMMIT');
      this.validators.get(input.room)?.accept(metrics);
      const receipt: Receipt = {
        callId: input.operation.callId,
        effect,
        kind,
        operationId: input.operation.id,
        outcome: 'succeeded',
        toolVersion: input.operation.toolVersion ?? 1,
        workspaceId: material.rows[0]?.workspace_id ?? undefined,
      };
      return {
        content: { schemaVersion: 1, value },
        receipt,
        update,
        version,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      merged.destroy();
      client.release();
    }
  }

  /** The receipt's effect stops reporting a pending projection. */
  async markOperationProjected(operationId: string) {
    await this.pool.query(
      `UPDATE agent_operations SET effect = effect || '{"projectionPending": false}'::jsonb
       WHERE id=$1 AND effect IS NOT NULL`,
      [operationId]
    );
  }

  /** Editable view of the durable material state (no room, no bootstrap write). */
  async inspectMaterialDocument(room: string): Promise<{
    blocks: InspectedBlock[];
    roomSchema: number;
  }> {
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const document = scratchDoc();
    try {
      const row = await this.pool.query<{
        state: Buffer;
        room_schema: number;
        stored_version: string;
      }>(
        'SELECT state, room_schema, stored_version FROM material_yjs_documents WHERE material_id=$1',
        [materialId]
      );
      if (row.rowCount) {
        if (Number(row.rows[0].room_schema) !== roomSchema) {
          throw new EditError(
            'stale_target',
            'the material was rebuilt since it was opened'
          );
        }
        applyStoredState(document, row.rows[0].state);
        return {
          blocks: inspectMaterial(document),
          roomSchema,
        };
      }
      const material = await this.pool.query<{ content: unknown }>(
        'SELECT content FROM materials WHERE id=$1 AND trashed_at IS NULL',
        [materialId]
      );
      if (material.rowCount === 0)
        throw new EditError('unavailable_target', 'material not found');
      const envelope = material.rows[0].content as { value?: unknown };
      if (!Array.isArray(envelope?.value)) {
        throw new EditError(
          'unavailable_target',
          'material content is not a valid Plate envelope'
        );
      }
      document
        .get(CONTENT_ROOT, Y.XmlText)
        .applyDelta(slateNodesToInsertDelta(envelope.value as never));
      return { blocks: inspectMaterial(document), roomSchema };
    } finally {
      document.destroy();
    }
  }

  /** The first-open bootstrap, shared with load(): seed the Y.Doc from the
   * projection under the material lock the caller already holds. */
  private async bootstrapDurableState(
    client: PoolClient,
    materialId: string,
    roomSchema: number
  ) {
    const material = await client.query<{ content: unknown }>(
      'SELECT content FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE',
      [materialId]
    );
    if (material.rowCount === 0) throw new Error('material not found');
    const envelope = material.rows[0].content as {
      schemaVersion?: unknown;
      value?: unknown;
    };
    if (envelope?.schemaVersion !== 1 || !Array.isArray(envelope.value)) {
      throw new Error('material content is not a valid Plate envelope');
    }
    const bootstrap = scratchDoc();
    bootstrap
      .get(CONTENT_ROOT, Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(envelope.value as never));
    const state = Buffer.from(Y.encodeStateAsUpdate(bootstrap));
    bootstrap.destroy();
    await client.query(
      `INSERT INTO material_yjs_documents
       (material_id, room_schema, state, stored_version, projected_version, projected_at)
       VALUES ($1,$2,$3,1,1,now())
       ON CONFLICT (material_id) DO NOTHING`,
      [materialId, roomSchema, state]
    );
  }

  async compactionCandidates(
    idleBefore: Date,
    floorBytes: number,
    multiplier: number,
    limit = 20
  ): Promise<Array<{ materialId: string; room: string; stateBytes: number }>> {
    const result = await this.pool.query<{
      material_id: string;
      room_schema: number;
      state_bytes: number;
    }>(
      `SELECT d.material_id, d.room_schema, octet_length(d.state)::int AS state_bytes
       FROM material_yjs_documents d
       JOIN materials m ON m.id=d.material_id
       WHERE d.updated_at < $1
         AND d.projected_version = d.stored_version
         AND octet_length(d.state) >= GREATEST($2, m.size_bytes * $3)
       ORDER BY d.updated_at
       LIMIT $4`,
      [idleBefore, floorBytes, multiplier, limit]
    );
    return result.rows.map((row) => ({
      materialId: row.material_id,
      room: `material:${row.material_id}:schema:${row.room_schema}`,
      stateBytes: row.state_bytes,
    }));
  }

  async compact(
    room: string
  ): Promise<{ materialId: string; room: string; stateBytes: number } | null> {
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const client = await this.pool.connect();
    const compacted = scratchDoc();
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      const row = await client.query<{
        room_schema: number;
        state: Buffer;
        stored_version: string;
        projected_version: string;
      }>(
        `SELECT room_schema, state, stored_version, projected_version
         FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`,
        [materialId]
      );
      if (
        row.rowCount === 0 ||
        Number(row.rows[0].room_schema) !== roomSchema ||
        row.rows[0].stored_version !== row.rows[0].projected_version
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const material = await client.query<{ content: unknown }>(
        'SELECT content FROM materials WHERE id=$1 FOR UPDATE',
        [materialId]
      );
      if (material.rowCount === 0) throw new Error('material not found');
      const envelope = material.rows[0].content as {
        schemaVersion?: unknown;
        value?: unknown;
      };
      if (envelope?.schemaVersion !== 1 || !Array.isArray(envelope.value)) {
        throw new Error('material content is not a valid Plate envelope');
      }
      compacted
        .get(CONTENT_ROOT, Y.XmlText)
        .applyDelta(slateNodesToInsertDelta(envelope.value as never));
      const state = Y.encodeStateAsUpdate(compacted);
      const nextVersion = Number(row.rows[0].stored_version) + 1;
      const nextSchema = roomSchema + 1;
      await client.query(
        `UPDATE material_yjs_documents
         SET room_schema=$2, state=$3, stored_version=$4, projected_version=$4,
             projection_error=NULL, updated_at=now(), projected_at=now()
         WHERE material_id=$1`,
        [materialId, nextSchema, Buffer.from(state), nextVersion]
      );
      // The rebuilt document has fresh item identities: guards of earlier AI
      // edits can no longer be checked, so their Undo is released.
      await client.query(
        `UPDATE agent_edit_inverses
         SET undo_status='unavailable', undo_reason='compacted', inverse='[]'::jsonb,
             guards='[]'::jsonb, inverse_bytes=0, updated_at=now()
         WHERE resource_kind='material' AND resource_id=$1 AND undo_status='available'`,
        [materialId]
      );
      await client.query('COMMIT');
      return {
        materialId,
        room: `material:${materialId}:schema:${nextSchema}`,
        stateBytes: state.byteLength,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      compacted.destroy();
      client.release();
    }
  }

  async pending(
    limit = 25
  ): Promise<
    Array<{ materialId: string; state: Uint8Array; version: number }>
  > {
    const result = await this.pool.query<{
      material_id: string;
      state: Buffer;
      stored_version: string;
    }>(
      `SELECT material_id, state, stored_version
       FROM material_yjs_documents
       WHERE projected_version < stored_version
       ORDER BY updated_at
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      materialId: row.material_id,
      state: new Uint8Array(row.state),
      version: Number(row.stored_version),
    }));
  }

  contentFromState(state: Uint8Array) {
    const document = scratchDoc();
    try {
      Y.applyUpdate(document, state);
      return { schemaVersion: 1 as const, value: plateValue(document) };
    } finally {
      document.destroy();
    }
  }

  async recordProjectionError(
    materialId: string,
    version: number,
    message: string
  ) {
    await this.pool.query(
      `UPDATE material_yjs_documents
       SET projection_error=$3
       WHERE material_id=$1
         AND projected_version < $2
         AND stored_version >= $2`,
      [materialId, version, message.slice(0, 2000)]
    );
  }
}

/**
 * One running and at most one queued save per room. A save snapshots its
 * document when it starts, so callers arriving while one is queued for the
 * same document share it and receive its failure. A reloaded room's new
 * document chains its own save instead of sharing the old one's snapshot.
 */
export function roomSaveQueue<D extends { name: string }>(
  save: (document: D) => Promise<void>
) {
  const rooms = new Map<
    string,
    { document: D; queued?: Promise<void>; tail: Promise<void> }
  >();
  return (document: D) => {
    const room = document.name;
    const saves = rooms.get(room);
    if (saves?.queued && saves.document === document) return saves.queued;
    const queued: Promise<void> = (saves?.tail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const current = rooms.get(room);
        if (current?.queued === queued) current.queued = undefined;
        return save(document);
      });
    rooms.set(room, { document, queued, tail: queued });
    void queued
      .catch(() => undefined)
      .then(() => {
        if (rooms.get(room)?.tail === queued) rooms.delete(room);
      });
    return queued;
  };
}

/**
 * Whether an update keeps the room within `cap` bytes. `sizes` holds an
 * estimate from the room's applied update bytes that over-counts content GC
 * removed, so only crossing the cap costs one exact measurement, which also
 * resets the estimate.
 */
export function updateFitsRoom(
  sizes: WeakMap<Y.Doc, number>,
  document: Y.Doc,
  update: Uint8Array,
  cap: number
) {
  if ((sizes.get(document) ?? 0) + update.byteLength <= cap) return true;
  const state = Y.encodeStateAsUpdate(document);
  sizes.set(document, state.byteLength);
  const candidate = scratchDoc();
  try {
    Y.applyUpdate(candidate, state);
    Y.applyUpdate(candidate, update);
    return Y.encodeStateAsUpdate(candidate).byteLength <= cap;
  } finally {
    candidate.destroy();
  }
}
