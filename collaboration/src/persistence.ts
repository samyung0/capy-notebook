import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import type { Pool, PoolClient } from 'pg';
import * as Y from 'yjs';

const CONTENT_ROOT = 'content';
const CHECKPOINT_MAP = 'evo:checkpoints';
const ROOM_PATTERN = /^material:([A-Za-z0-9_-]+):schema:(\d+)$/;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_DEPTH = 16;
const MAX_DOCUMENT_NODES = 10_000;

export class MaterialDocumentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialDocumentLimitError';
  }
}

export interface StoredDocument {
  checkpointIds: string[];
  content: { schemaVersion: 1; value: unknown[] };
  state: Uint8Array;
  version: number;
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

function assertMaterialLimits(value: unknown[]) {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, value })
  );
  if (encoded.byteLength > MAX_DOCUMENT_BYTES) {
    throw new MaterialDocumentLimitError(
      'invalid material document: document size'
    );
  }
  let nodeCount = 0;
  let maxDepth = 0;
  const visit = (node: unknown, depth: number) => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > MAX_DOCUMENT_NODES || depth > MAX_DOCUMENT_DEPTH) {
      throw new MaterialDocumentLimitError(
        'invalid material document: document complexity limit exceeded'
      );
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child, depth + 1);
    }
  };
  for (const node of value) visit(node, 0);
}

async function lockMaterial(client: PoolClient, materialId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    materialId,
  ]);
}

function applyStoredState(document: Y.Doc, state: Buffer | Uint8Array) {
  if (state.byteLength > 0) Y.applyUpdate(document, new Uint8Array(state));
}

function plateValue(document: Y.Doc): unknown[] {
  const root = yTextToSlateElement(document.get(CONTENT_ROOT, Y.XmlText)) as {
    children?: unknown[];
  };
  return Array.isArray(root.children) ? root.children : [];
}

function checkpoints(document: Y.Doc): string[] {
  return [...document.getMap(CHECKPOINT_MAP).keys()].filter(
    (key) => typeof key === 'string' && key.length <= 128
  );
}

export class YjsDocumentStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  validateUpdate(current: Y.Doc, update: Uint8Array) {
    const candidate = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
      Y.applyUpdate(candidate, update);
      assertMaterialLimits(plateValue(candidate));
    } finally {
      candidate.destroy();
    }
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
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async store(room: string, current: Y.Doc): Promise<StoredDocument> {
    const materialId = materialIdFromRoom(room);
    const roomSchema = roomSchemaFromRoom(room);
    const client = await this.pool.connect();
    const merged = new Y.Doc({ gc: true });
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
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
      assertMaterialLimits(value);
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
      return {
        checkpointIds: checkpoints(merged),
        content: { schemaVersion: 1, value },
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

  async recordProjectionError(materialId: string, message: string) {
    await this.pool.query(
      `UPDATE material_yjs_documents
       SET projection_error=$2 WHERE material_id=$1`,
      [materialId, message.slice(0, 2000)]
    );
  }
}
