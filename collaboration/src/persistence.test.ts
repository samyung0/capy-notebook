import { slateNodesToInsertDelta } from '@slate-yjs/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  attachDocumentContributorTracker,
  documentContributors,
} from './contributors.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import {
  CollaborationAuthorizationError,
  YjsDocumentStore,
} from './persistence.js';

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    actor_deleted_at: null,
    actor_deletion_requested_at: null,
    actor_suspended_at: null,
    material_owner_id: 'u_owner',
    material_privacy: 'private',
    member_role: 'editor',
    owner_deleted_at: null,
    owner_deletion_requested_at: null,
    owner_over_quota: false,
    owner_suspended_at: null,
    share_role: 'viewer',
    workspace_id: 'ws_1',
    workspace_owner_id: 'u_owner',
    workspace_privacy: 'private',
    ...overrides,
  };
}

function documentStore(row: ReturnType<typeof liveRow>) {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
  return new YjsDocumentStore({ query } as unknown as Pool);
}

describe('live collaboration authorization', () => {
  it('records projection errors only while that version remains unprojected', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const store = new YjsDocumentStore({ query } as unknown as Pool);

    await store.recordProjectionError('mat_1', 7, 'projection failed');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND projected_version < $2'),
      ['mat_1', 7, 'projection failed']
    );
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'AND stored_version >= $2'
    );
  });

  it('uses a paid-lapse boundary instead of any subscription row for quota access', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [liveRow()],
    });
    const store = new YjsDocumentStore({ query } as unknown as Pool);

    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'write'
      )
    ).resolves.toBeUndefined();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("paid_sub.plan_tier='pro'");
    expect(sql).toContain('expired_sub.current_period_end <= now()');
    expect(sql).toContain(
      "closed_sub.status NOT IN ('active','trialing','past_due')"
    );
    expect(sql).not.toContain('any_sub');
  });

  it('resolves the current durable room epoch for eviction delivery', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ room_schema: 4 }],
    });
    const store = new YjsDocumentStore({ query } as unknown as Pool);

    await expect(store.currentRoom('mat_1')).resolves.toBe(
      'material:mat_1:schema:4'
    );
  });

  it('rejects a durable document with an unknown top-level root', async () => {
    const invalid = new Y.Doc({ gc: true });
    invalid.getText('unmetered').insert(0, 'hidden growth');
    const state = Buffer.from(Y.encodeStateAsUpdate(invalid));
    invalid.destroy();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT state, room_schema')) {
          return { rowCount: 1, rows: [{ room_schema: 1, state }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const target = new Y.Doc({ gc: true });

    await expect(store.load('material:mat_1:schema:1', target)).rejects.toThrow(
      'unsupported collaboration document root: unmetered'
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');

    target.destroy();
  });

  it('rejects malformed durable contributor markers before admission', async () => {
    const invalid = new Y.Doc({ gc: true });
    invalid.getMap('__capy_pending_contributors').set('marker', {
      access: 'write',
      junk: 'not server-owned metadata',
      nonce: 'nonce-a',
      userId: 'u_editor',
    });
    const state = Buffer.from(Y.encodeStateAsUpdate(invalid));
    invalid.destroy();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT state, room_schema')) {
          return { rowCount: 1, rows: [{ room_schema: 1, state }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const target = new Y.Doc({ gc: true });

    await expect(store.load('material:mat_1:schema:1', target)).rejects.toThrow(
      'invalid collaboration contributor marker'
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');

    target.destroy();
  });

  it('accepts a current editor and rejects a removed member', async () => {
    await expect(
      documentStore(liveRow()).assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'write'
      )
    ).resolves.toBeUndefined();

    await expect(
      documentStore(liveRow({ member_role: '' })).assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'comment'
      )
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it('rejects locked actors and deletion-pending owners', async () => {
    await expect(
      documentStore(
        liveRow({ actor_suspended_at: new Date() })
      ).assertConnectionAccess('material:mat_1:schema:1', 'u_editor', 'write')
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(
      documentStore(
        liveRow({ owner_deletion_requested_at: new Date() })
      ).assertConnectionAccess('material:mat_1:schema:1', 'u_editor', 'write')
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it('downgrades an over-quota editor from write to shrink', async () => {
    const store = documentStore(liveRow({ owner_over_quota: true }));
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'write'
      )
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'shrink'
      )
    ).resolves.toBeUndefined();
  });

  it('opens service commands with the current write direction', async () => {
    await expect(
      documentStore(liveRow()).commandConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor'
      )
    ).resolves.toBe('write');
    await expect(
      documentStore(
        liveRow({ owner_over_quota: true })
      ).commandConnectionAccess('material:mat_1:schema:1', 'u_editor')
    ).resolves.toBe('shrink');
    await expect(
      documentStore(
        liveRow({ member_role: 'commenter' })
      ).commandConnectionAccess('material:mat_1:schema:1', 'u_commenter')
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it('locks workspace sharing state before the final store authorization', async () => {
    const statements: string[] = [];
    let grantLocked = false;
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (
          sql.includes(
            'SELECT owner_user_id, workspace_id, kind FROM materials'
          )
        ) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: 'ws_1' },
            ],
          };
        }
        if (sql.includes('SELECT id FROM workspaces')) {
          grantLocked = true;
          return { rowCount: 1, rows: [{ id: 'ws_1' }] };
        }
        if (sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')) {
          return {
            rowCount: 2,
            rows: [
              {
                deleted_at: null,
                deletion_requested_at: null,
                id: 'u_editor',
                over_quota: false,
                suspended_at: null,
              },
              {
                deleted_at: null,
                deletion_requested_at: null,
                id: 'u_owner',
                over_quota: false,
                suspended_at: null,
              },
            ],
          };
        }
        if (sql.includes('FROM materials WHERE id=$1 FOR SHARE')) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: 'ws_1' },
            ],
          };
        }
        if (sql.includes('JOIN users owner')) {
          expect(grantLocked).toBe(true);
          return { rowCount: 1, rows: [liveRow()] };
        }
        if (sql.includes('FROM material_yjs_documents')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'test', () => 'nonce');
    document.transact(
      () =>
        document
          .get('content', Y.XmlText)
          .applyDelta(
            slateNodesToInsertDelta([
              { children: [{ text: 'x' }], id: 'block_1', type: 'p' },
            ] as never)
          ),
      {
        connection: {
          context: {
            access: 'write',
            expiresAt: Number.MAX_SAFE_INTEGER,
            tokenId: 'token',
            userId: 'u_editor',
          },
        },
        source: 'connection',
      }
    );
    try {
      const stored = await store.store('material:mat_1:schema:1', document);
      expect(stored).toMatchObject({ version: 1 });
      const durable = new Y.Doc();
      try {
        Y.applyUpdate(durable, stored.state);
        expect(documentContributors(durable)).toEqual([]);
      } finally {
        durable.destroy();
      }
    } finally {
      document.destroy();
    }

    const grantLock = statements.findIndex((sql) =>
      sql.includes('SELECT id FROM workspaces')
    );
    const authorization = statements.findIndex((sql) =>
      sql.includes('JOIN users owner')
    );
    expect(grantLock).toBeGreaterThan(-1);
    expect(authorization).toBeGreaterThan(grantLock);
  });

  it('locks standalone accounts before the material row', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (
          sql.includes(
            'SELECT owner_user_id, workspace_id, kind FROM materials'
          )
        ) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: null },
            ],
          };
        }
        if (sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')) {
          return {
            rowCount: 1,
            rows: [
              {
                deleted_at: null,
                deletion_requested_at: null,
                id: 'u_owner',
                over_quota: false,
                suspended_at: null,
              },
            ],
          };
        }
        if (sql.includes('FROM materials WHERE id=$1 FOR SHARE')) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: null },
            ],
          };
        }
        if (sql.includes('FROM material_yjs_documents')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const document = new Y.Doc();
    document
      .get('content', Y.XmlText)
      .applyDelta(
        slateNodesToInsertDelta([
          { children: [{ text: 'x' }], id: 'block_1', type: 'p' },
        ] as never)
      );
    try {
      await expect(
        store.store('material:mat_1:schema:1', document)
      ).resolves.toMatchObject({ version: 1 });
    } finally {
      document.destroy();
    }

    const accounts = statements.findIndex(
      (sql) => sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')
    );
    const material = statements.findIndex((sql) =>
      sql.includes('FROM materials WHERE id=$1 FOR SHARE')
    );
    expect(accounts).toBeGreaterThan(-1);
    expect(material).toBeGreaterThan(accounts);
  });

  it('rejects malformed Plate content before inserting durable Yjs state', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (
          sql.includes(
            'SELECT owner_user_id, workspace_id, kind FROM materials'
          )
        ) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: null },
            ],
          };
        }
        if (sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')) {
          return {
            rowCount: 1,
            rows: [
              {
                deleted_at: null,
                deletion_requested_at: null,
                id: 'u_owner',
                over_quota: false,
                suspended_at: null,
              },
            ],
          };
        }
        if (sql.includes('FROM materials WHERE id=$1 FOR SHARE')) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: null },
            ],
          };
        }
        if (sql.includes('FROM material_yjs_documents')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const document = new Y.Doc();
    document.get('content', Y.XmlText).applyDelta(
      slateNodesToInsertDelta([
        {
          children: [{ children: [], text: 'invalid' }],
          id: 'block_1',
          type: 'p',
        },
      ] as never)
    );

    try {
      await expect(
        store.store('material:mat_1:schema:1', document)
      ).rejects.toBeInstanceOf(MaterialDocumentValidationError);
    } finally {
      document.destroy();
    }
    expect(
      statements.some((sql) =>
        sql.includes('INSERT INTO material_yjs_documents')
      )
    ).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rechecks every editor represented by one debounced snapshot', async () => {
    const checkedActors: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes(
            'SELECT owner_user_id, workspace_id, kind FROM materials'
          )
        ) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: 'ws_1' },
            ],
          };
        }
        if (sql.includes('SELECT id FROM workspaces')) {
          return { rowCount: 1, rows: [{ id: 'ws_1' }] };
        }
        if (sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')) {
          return {
            rowCount: 3,
            rows: ['u_authorized', 'u_owner', 'u_revoked'].map((id) => ({
              deleted_at: null,
              deletion_requested_at: null,
              id,
              over_quota: false,
              suspended_at: null,
            })),
          };
        }
        if (sql.includes('FROM materials WHERE id=$1 FOR SHARE')) {
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: 'ws_1' },
            ],
          };
        }
        if (sql.includes('JOIN users owner')) {
          const actor = String(params?.[1]);
          checkedActors.push(actor);
          return {
            rowCount: 1,
            rows: [
              liveRow({ member_role: actor === 'u_revoked' ? '' : 'editor' }),
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new YjsDocumentStore({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const document = new Y.Doc();
    attachDocumentContributorTracker(document, 'test', () => 'nonce');
    for (const userId of ['u_revoked', 'u_authorized']) {
      document.transact(
        () =>
          document.get('content', Y.XmlText).applyDelta(
            slateNodesToInsertDelta([
              {
                children: [{ text: userId }],
                id: `block-${userId}`,
                type: 'p',
              },
            ] as never)
          ),
        {
          connection: {
            context: {
              access: 'write',
              expiresAt: Number.MAX_SAFE_INTEGER,
              tokenId: `token-${userId}`,
              userId,
            },
          },
          source: 'connection',
        }
      );
    }
    try {
      await expect(
        store.store('material:mat_1:schema:1', document)
      ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    } finally {
      document.destroy();
    }
    expect(checkedActors).toContain('u_revoked');
  });
});
