import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import type { Pool, PoolClient } from 'pg';
import * as Y from 'yjs';

const CONTENT_ROOT = 'content';
const CHECKPOINT_MAP = 'evo:checkpoints';
const ROOM_PATTERN = /^material:([A-Za-z0-9_-]+):schema:1$/;

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

  async load(room: string, target: Y.Doc): Promise<void> {
    const materialId = materialIdFromRoom(room);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      let result = await client.query<{ state: Buffer }>(
        'SELECT state FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE',
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
           VALUES ($1,1,$2,1,1,now())
           ON CONFLICT (material_id) DO NOTHING`,
          [materialId, state]
        );
        result = await client.query<{ state: Buffer }>(
          'SELECT state FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE',
          [materialId]
        );
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
    const client = await this.pool.connect();
    const merged = new Y.Doc({ gc: true });
    try {
      await client.query('BEGIN');
      await lockMaterial(client, materialId);
      const existing = await client.query<{
        state: Buffer;
        stored_version: string;
      }>(
        `SELECT state, stored_version
         FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`,
        [materialId]
      );
      if (existing.rowCount) {
        applyStoredState(merged, existing.rows[0].state);
      }
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(current));
      const state = Y.encodeStateAsUpdate(merged);
      const version = existing.rowCount
        ? Number(existing.rows[0].stored_version) + 1
        : 1;
      await client.query(
        `INSERT INTO material_yjs_documents
         (material_id, room_schema, state, stored_version, projected_version)
         VALUES ($1,1,$2,$3,0)
         ON CONFLICT (material_id) DO UPDATE
         SET state=EXCLUDED.state,
             stored_version=EXCLUDED.stored_version,
             projection_error=NULL,
             updated_at=now()`,
        [materialId, Buffer.from(state), version]
      );
      await client.query('COMMIT');
      return {
        checkpointIds: checkpoints(merged),
        content: { schemaVersion: 1, value: plateValue(merged) },
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
