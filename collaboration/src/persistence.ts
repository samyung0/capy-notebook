import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import type { Pool, PoolClient } from 'pg';
import * as Y from 'yjs';
import type { CollaborationAccess } from './auth.js';
import {
  type DocumentContributor,
  documentContributors,
  removeDocumentContributors,
} from './contributors.js';
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
  actor_suspended_at: Date | null;
  material_owner_id: string;
  material_privacy: string;
  member_role: string;
  owner_deleted_at: Date | null;
  owner_deletion_requested_at: Date | null;
  owner_over_quota: boolean;
  owner_suspended_at: Date | null;
  share_role: string | null;
  workspace_id: string | null;
  workspace_owner_id: string | null;
  workspace_privacy: string | null;
};

type Queryable = Pick<Pool, 'query'>;

const roleRank: Record<string, number> = {
  commenter: 2,
  editor: 3,
  owner: 4,
  viewer: 1,
};

function paidLapseOverQuotaSQL(userAlias: 'owner' | 'u'): string {
  return `EXISTS(SELECT 1 FROM user_subscriptions paid_sub
        WHERE paid_sub.user_id=${userAlias}.id
          AND paid_sub.plan_tier='pro')
      AND NOT EXISTS(SELECT 1 FROM user_subscriptions live_sub
        WHERE live_sub.user_id=${userAlias}.id
          AND live_sub.plan_tier='pro'
          AND live_sub.status IN ('active','trialing','past_due')
          AND (live_sub.current_period_end IS NULL
            OR live_sub.current_period_end > now()))
      AND (EXISTS(SELECT 1 FROM user_subscriptions expired_sub
          WHERE expired_sub.user_id=${userAlias}.id
            AND expired_sub.plan_tier='pro'
            AND expired_sub.status IN ('active','trialing','past_due')
            AND expired_sub.current_period_end <= now())
        OR EXISTS(SELECT 1 FROM user_subscriptions closed_sub
          WHERE closed_sub.user_id=${userAlias}.id
            AND closed_sub.plan_tier='pro'
            AND closed_sub.status NOT IN ('active','trialing','past_due')))
      AND COALESCE(storage.used_bytes, 0)
        + COALESCE(storage.reserved_bytes, 0)
        + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas delta
          WHERE delta.user_id=${userAlias}.id), 0)
        > (SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier='free')`;
}

export class CollaborationAuthorizationError extends Error {}

function denyCollaboration(message: string): never {
  throw new CollaborationAuthorizationError(message);
}

async function liveCollaborationAccess(
  queryable: Queryable,
  materialId: string,
  actorUserId: string
): Promise<CollaborationAccess> {
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
      ${paidLapseOverQuotaSQL('owner')} AS owner_over_quota
     FROM materials m
     JOIN users owner ON owner.id=m.owner_user_id
     JOIN users actor ON actor.id=$2
     LEFT JOIN workspaces w ON w.id=m.workspace_id
     LEFT JOIN workspace_members wm
       ON wm.workspace_id=w.id AND wm.user_id=$2
     LEFT JOIN user_storage storage ON storage.user_id=owner.id
     WHERE m.id=$1`,
    [materialId, actorUserId]
  );
  if (result.rowCount === 0) denyCollaboration('material not found');
  const row = result.rows[0];
  if (row.owner_deleted_at || row.owner_deletion_requested_at) {
    denyCollaboration('material not found');
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
  if ((roleRank[effectiveRole] ?? 0) < roleRank.commenter) {
    denyCollaboration('material access was revoked');
  }
  let liveAccess: CollaborationAccess = 'comment';
  if ((roleRank[effectiveRole] ?? 0) >= roleRank.editor) {
    liveAccess = row.owner_suspended_at
      ? 'comment'
      : row.owner_over_quota
        ? 'shrink'
        : 'write';
  }
  return liveAccess;
}

async function assertLiveCollaborationAccess(
  queryable: Queryable,
  materialId: string,
  actorUserId: string,
  requested: CollaborationAccess
) {
  const liveAccess = await liveCollaborationAccess(
    queryable,
    materialId,
    actorUserId
  );
  const allowed =
    requested === 'comment' ||
    (requested === 'shrink' && liveAccess !== 'comment') ||
    (requested === 'write' && liveAccess === 'write');
  if (!allowed) denyCollaboration('collaboration access changed');
}

type LockedAccount = {
  deleted_at: Date | null;
  deletion_requested_at: Date | null;
  id: string;
  over_quota: boolean;
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
  }>('SELECT owner_user_id, workspace_id, kind FROM materials WHERE id=$1', [
    materialId,
  ]);
  if (placement.rowCount === 0) denyCollaboration('material not found');
  const expected = placement.rows[0];
  const workspaceId = expected.workspace_id;
  if (workspaceId) {
    const workspace = await client.query(
      'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',
      [workspaceId]
    );
    if (workspace.rowCount === 0) denyCollaboration('material not found');
  }

  const accountIds = [
    ...new Set([expected.owner_user_id, ...actorUserIds]),
  ].sort();
  const accounts = await client.query<LockedAccount>(
    `SELECT u.id, u.deleted_at, u.deletion_requested_at, u.suspended_at,
      ${paidLapseOverQuotaSQL('u')} AS over_quota
     FROM users u
     LEFT JOIN user_storage storage ON storage.user_id=u.id
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
     FROM materials WHERE id=$1 FOR SHARE`,
    [materialId]
  );
  if (material.rowCount === 0) denyCollaboration('material not found');
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

function plateValue(document: Y.Doc): unknown[] {
  assertMaterialDocumentRoots(document);
  const root = yTextToSlateElement(document.get(CONTENT_ROOT, Y.XmlText)) as {
    children?: unknown[];
  };
  return Array.isArray(root.children) ? root.children : [];
}

function measureState(state: Buffer | Uint8Array): MaterialDocumentMetrics {
  const document = new Y.Doc({ gc: true });
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
  validateUpdate(
    room: string,
    current: Y.Doc,
    update: Uint8Array,
    options?: { shrinkOnly?: boolean }
  ) {
    let validator = this.validators.get(room);
    if (!validator) {
      validator = new RoomValidator();
      this.validators.set(room, validator);
    }
    validator.pendingBytes += update.byteLength;
    assertMaterialDocumentRoots(current);
    const candidate = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
      Y.applyUpdate(candidate, update);
      assertMaterialDocumentRoots(candidate);
    } catch (error) {
      candidate.destroy();
      throw error;
    }
    if (!validator.shouldMeasure() && !options?.shrinkOnly) {
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
    // Billing over-quota rooms reuse the same shrink-only rule: growth in any
    // metric is rejected even when the document is still under the hard caps.
    if (
      options?.shrinkOnly &&
      !recoversMaterialLimits(metrics, validator.metrics)
    ) {
      throw new MaterialDocumentLimitError('document_size_exceeded', metrics);
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
  ): Promise<'shrink' | 'write'> {
    const access = await liveCollaborationAccess(
      this.pool,
      materialIdFromRoom(room),
      actorUserId
    );
    if (access === 'comment' || access === 'read') {
      denyCollaboration('material access was revoked');
    }
    return access;
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
        const bootstrap = new Y.Doc({ gc: true });
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

  async store(room: string, current: Y.Doc): Promise<StoredDocument> {
    assertMaterialDocumentRoots(current);
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const contributors = documentContributors(current);
    const accessByActor = new Map<string, CollaborationAccess>();
    for (const contributor of contributors) {
      const previous = accessByActor.get(contributor.userId);
      if (contributor.access === 'write' || previous === undefined) {
        accessByActor.set(contributor.userId, contributor.access);
      }
    }
    const client = await this.pool.connect();
    const merged = new Y.Doc({ gc: true });
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      const boundary = await lockCollaborationBoundary(client, materialId, [
        ...accessByActor.keys(),
      ]);
      for (const [actorUserId, actorAccess] of accessByActor) {
        await assertLiveCollaborationAccess(
          client,
          materialId,
          actorUserId,
          actorAccess
        );
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
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(current));
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
      if (
        lifecycle.over_quota &&
        existing.rowCount &&
        !recoversMaterialLimits(metrics, measureState(existing.rows[0].state))
      ) {
        throw new MaterialDocumentLimitError('document_size_exceeded', metrics);
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
    const compacted = new Y.Doc({ gc: true });
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
    const document = new Y.Doc({ gc: true });
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
