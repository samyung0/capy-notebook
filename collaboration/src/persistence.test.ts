import { slateNodesToInsertDelta } from '@slate-yjs/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { accessRecheck } from './accessRecheck.js';
import {
  attachDocumentContributorTracker,
  documentContributors,
  roomSnapshot,
} from './contributors.js';
import { MaterialDocumentValidationError } from './materialDocument.js';
import {
  CollaborationAuthorizationError,
  CollaborationReadOnlyError,
  roomSaveQueue,
  updateFitsRoom,
  YjsDocumentStore,
} from './persistence.js';

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    actor_deleted_at: null,
    actor_deletion_requested_at: null,
    actor_frozen: false,
    actor_suspended_at: null,
    material_owner_id: 'u_owner',
    material_privacy: 'private',
    member_role: 'editor',
    owner_deleted_at: null,
    owner_deletion_requested_at: null,
    owner_frozen: false,
    owner_full: false,
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

describe('authored content revision preconditions', () => {
  it.each(['revision', 'projection', 'live', 'current'] as const)(
    'checks %s at the durable write',
    async (scenario) => {
      const block = {
        children: [{ text: 'original' }],
        id: 'block_1',
        type: 'p',
      };
      const document = new Y.Doc();
      document
        .get('content', Y.XmlText)
        .applyDelta(slateNodesToInsertDelta([block]));
      const state = Buffer.from(Y.encodeStateAsUpdate(document));
      const live = new Y.Doc();
      Y.applyUpdate(live, state);
      if (scenario === 'live') {
        const { applyCollaborationCommand } = await import('./commands.js');
        applyCollaborationCommand(live, {
          actorUserId: 'u_owner',
          expectedBlock: block,
          materialId: 'mat_1',
          replacementBlock: { ...block, children: [{ text: 'concurrent' }] },
          room: 'material:mat_1:schema:1',
          type: 'replace-block',
        });
      }
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT revision'))
          return {
            rowCount: 1,
            rows: [{ revision: scenario === 'revision' ? '2' : '1' }],
          };
        if (sql.includes('FROM material_yjs_documents'))
          return {
            rowCount: 1,
            rows: [
              {
                projected_version: '1',
                room_schema: 1,
                state,
                stored_version: scenario === 'projection' ? '2' : '1',
              },
            ],
          };
        if (sql.includes('SELECT content FROM materials'))
          return {
            rowCount: 1,
            rows: [{ content: { schemaVersion: 1, value: [block] } }],
          };
        if (sql.includes('FROM users u'))
          return {
            rowCount: 1,
            rows: [
              {
                deleted_at: null,
                deletion_requested_at: null,
                id: 'u_owner',
                suspended_at: null,
              },
            ],
          };
        if (sql.includes('SELECT owner_user_id, workspace_id, kind'))
          return {
            rowCount: 1,
            rows: [
              { kind: 'note', owner_user_id: 'u_owner', workspace_id: null },
            ],
          };
        return {
          rowCount: 1,
          rows: [liveRow({ material_owner_id: 'u_owner', workspace_id: null })],
        };
      });
      const client = { query, release: vi.fn() };
      const store = new YjsDocumentStore({
        connect: vi.fn().mockResolvedValue(client),
      } as unknown as Pool);
      const command = {
        actorUserId: 'u_owner',
        expectedBlock: block,
        expectedRevision: 1,
        materialId: 'mat_1',
        replacementBlock: { ...block, children: [{ text: 'saved' }] },
        room: 'material:mat_1:schema:1',
        type: 'replace-block' as const,
      };
      try {
        const result = store.replaceMaterialContent(
          command,
          Y.encodeStateAsUpdate(live)
        );
        if (scenario === 'current') {
          await expect(result).resolves.toMatchObject({ version: 2 });
          expect(query).toHaveBeenCalledWith('COMMIT');
        } else {
          await expect(result).rejects.toThrow('concurrently');
          expect(query).toHaveBeenCalledWith('ROLLBACK');
          expect(
            query.mock.calls.some(([sql]) =>
              sql.startsWith('UPDATE material_yjs_documents')
            )
          ).toBe(false);
        }
        expect(
          query.mock.calls.some(
            ([sql]) =>
              sql.includes('SELECT revision') && sql.endsWith('FOR UPDATE')
          )
        ).toBe(true);
      } finally {
        document.destroy();
        live.destroy();
      }
    }
  );
});

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
        'read'
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

  it('limits editors to read access when the storage owner is suspended', async () => {
    const store = documentStore(liveRow({ owner_suspended_at: new Date() }));
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'read'
      )
    ).resolves.toBeUndefined();
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'write'
      )
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it.each([
    ['the storage owner is frozen', { owner_frozen: true }],
    ['the editor is frozen', { actor_frozen: true }],
    ['the storage owner is at its limit', { owner_full: true }],
  ])('makes the room read-only when %s', async (_, readOnly) => {
    const store = documentStore(liveRow(readOnly));
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'write'
      )
    ).rejects.toBeInstanceOf(CollaborationReadOnlyError);
    await expect(
      store.assertConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor',
        'read'
      )
    ).resolves.toBeUndefined();
  });

  it('refuses an open writer within 5 s of its account freezing', async () => {
    let now = 0;
    const recheck = accessRecheck(5000, () => now);
    const row = liveRow();
    const store = documentStore(row);
    const connection = {};
    const update = () =>
      recheck(connection, () =>
        store.assertConnectionAccess(
          'material:mat_1:schema:1',
          'u_editor',
          'write'
        )
      );
    await update();
    row.actor_frozen = true;
    // Inside the interval the update is still admitted, and the store saves
    // it: frozen is enforced at admission only.
    now = 4999;
    await expect(update()).resolves.toBeUndefined();
    now = 5000;
    await expect(update()).rejects.toBeInstanceOf(CollaborationReadOnlyError);
  });

  it('opens service commands with the current write direction', async () => {
    await expect(
      documentStore(liveRow()).commandConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor'
      )
    ).resolves.toBe('write');
    await expect(
      documentStore(liveRow({ owner_frozen: true })).commandConnectionAccess(
        'material:mat_1:schema:1',
        'u_editor'
      )
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(
      documentStore(liveRow({ member_role: 'viewer' })).commandConnectionAccess(
        'material:mat_1:schema:1',
        'u_viewer'
      )
    ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it.each([
    ['', {}],
    [
      ' and saves updates admitted before their writer froze',
      { actor_frozen: true },
    ],
  ])(
    'locks workspace sharing state before the final store authorization%s',
    async (_, writer) => {
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
                {
                  kind: 'note',
                  owner_user_id: 'u_owner',
                  workspace_id: 'ws_1',
                },
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
                  suspended_at: null,
                },
                {
                  deleted_at: null,
                  deletion_requested_at: null,
                  id: 'u_owner',
                  suspended_at: null,
                },
              ],
            };
          }
          if (
            sql.includes(
              'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
            )
          ) {
            return {
              rowCount: 1,
              rows: [
                {
                  kind: 'note',
                  owner_user_id: 'u_owner',
                  workspace_id: 'ws_1',
                },
              ],
            };
          }
          if (sql.includes('JOIN users owner')) {
            expect(grantLocked).toBe(true);
            return { rowCount: 1, rows: [liveRow(writer)] };
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
        const stored = await store.store(
          'material:mat_1:schema:1',
          roomSnapshot(document)
        );
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
    }
  );

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
                suspended_at: null,
              },
            ],
          };
        }
        if (
          sql.includes(
            'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
          )
        ) {
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
        store.store('material:mat_1:schema:1', roomSnapshot(document))
      ).resolves.toMatchObject({ version: 1 });
    } finally {
      document.destroy();
    }

    const accounts = statements.findIndex(
      (sql) => sql.includes('FROM users u') && sql.includes('FOR SHARE OF u')
    );
    const material = statements.findIndex((sql) =>
      sql.includes(
        'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
      )
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
                suspended_at: null,
              },
            ],
          };
        }
        if (
          sql.includes(
            'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
          )
        ) {
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
        store.store('material:mat_1:schema:1', roomSnapshot(document))
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

  // The gateway merges the edit's books into the stored record and hands the
  // authority the result; the credit must land in the same transaction as the
  // content, so an edit that commits can never be uncredited.
  it('writes provenance beside the content, and only when the edit carries it', async () => {
    async function editWith(provenance?: unknown) {
      const durable = new Y.Doc({ gc: true });
      durable
        .get('content', Y.XmlText)
        .applyDelta(
          slateNodesToInsertDelta([
            { children: [{ text: 'first' }], id: 'block_1', type: 'p' },
          ] as never)
        );
      const state = Buffer.from(Y.encodeStateAsUpdate(durable));
      durable.destroy();
      const statements: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          statements.push(sql);
          if (sql.includes('FROM agent_operations WHERE id=$1')) {
            return { rowCount: 0, rows: [] };
          }
          if (
            sql.includes(
              'SELECT owner_user_id, workspace_id, kind FROM materials'
            ) ||
            sql.includes(
              'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
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
              rowCount: 2,
              rows: ['u_editor', 'u_owner'].map((id) => ({
                deleted_at: null,
                deletion_requested_at: null,
                id,
                suspended_at: null,
              })),
            };
          }
          if (sql.includes('JOIN users owner')) {
            return { rowCount: 1, rows: [liveRow({ workspace_id: null })] };
          }
          if (sql.includes('SELECT state, room_schema, stored_version')) {
            return {
              rowCount: 1,
              rows: [{ room_schema: 1, state, stored_version: '3' }],
            };
          }
          if (sql.includes('SELECT title, kind, workspace_id FROM materials')) {
            return {
              rowCount: 1,
              rows: [{ kind: 'note', title: 'Note', workspace_id: null }],
            };
          }
          return { rowCount: 1, rows: [] };
        }),
        release: vi.fn(),
      };
      const store = new YjsDocumentStore({
        connect: vi.fn().mockResolvedValue(client),
      } as unknown as Pool);
      await expect(
        store.applyMaterialEdit({
          actorUserId: 'u_editor',
          commands: [
            {
              afterBlockId: 'block_1',
              blocks: [
                { children: [{ text: 'second' }], id: 'block_2', type: 'p' },
              ],
              type: 'insert_block',
            },
          ],
          operation: { id: 'op_1', requestHash: 'hash_1' },
          provenance,
          room: 'material:mat_1:schema:1',
        })
      ).resolves.toMatchObject({ version: 4 });
      return { client, statements };
    }

    const credited = await editWith({
      books: [{ excerptIds: ['e_1'], id: 'ahss', title: 'AHSS' }],
      license: 'CC BY-SA 4.0',
    });
    expect(credited.client.query).toHaveBeenCalledWith(
      'UPDATE materials SET provenance=$2 WHERE id=$1',
      [
        'mat_1',
        JSON.stringify({
          books: [{ excerptIds: ['e_1'], id: 'ahss', title: 'AHSS' }],
          license: 'CC BY-SA 4.0',
        }),
      ]
    );
    const content = credited.statements.findIndex((sql) =>
      sql.includes('UPDATE material_yjs_documents')
    );
    const provenance = credited.statements.findIndex((sql) =>
      sql.includes('UPDATE materials SET provenance')
    );
    expect(content).toBeGreaterThan(credited.statements.indexOf('BEGIN'));
    expect(provenance).toBeGreaterThan(content);
    expect(credited.statements.indexOf('COMMIT')).toBeGreaterThan(provenance);
    expect(credited.statements).not.toContain('ROLLBACK');

    const uncredited = await editWith();
    expect(
      uncredited.statements.some((sql) =>
        sql.includes('UPDATE materials SET provenance')
      )
    ).toBe(false);
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
              suspended_at: null,
            })),
          };
        }
        if (
          sql.includes(
            'FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE'
          )
        ) {
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
        store.store('material:mat_1:schema:1', roomSnapshot(document))
      ).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    } finally {
      document.destroy();
    }
    expect(checkedActors).toContain('u_revoked');
  });
});

describe('source room saves and size', () => {
  function saves() {
    const runs: {
      document: { name: string };
      finish: (error?: Error) => void;
    }[] = [];
    const persist = roomSaveQueue(
      (document: { name: string }) =>
        new Promise<void>((resolve, reject) => {
          runs.push({
            document,
            finish: (error) => (error ? reject(error) : resolve()),
          });
        })
    );
    return { persist, runs };
  }

  it('runs one save per room and shares the queued save with its failure', async () => {
    const { persist, runs } = saves();
    const room = { name: 'source:f:epoch:1' };
    const running = persist(room);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const queued = persist(room);
    expect(persist(room)).toBe(queued);
    runs[0].finish();
    await running;
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1].finish(new Error('engine failed'));
    await expect(queued).rejects.toThrow('engine failed');
  });

  it('chains a reloaded document behind the old one instead of sharing its save', async () => {
    const { persist, runs } = saves();
    const old = { name: 'source:f:epoch:1' };
    const reloaded = { name: 'source:f:epoch:1' };
    const running = persist(old);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const queuedOld = persist(old);
    const queuedNew = persist(reloaded);
    expect(queuedNew).not.toBe(queuedOld);
    runs[0].finish();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1].finish();
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    runs[2].finish();
    await Promise.all([running, queuedOld, queuedNew]);
    expect(runs.map((run) => run.document)).toEqual([old, old, reloaded]);
    expect(runs[2].document).toBe(reloaded);
  });

  it('measures a room exactly only when its size estimate crosses the cap', () => {
    const document = new Y.Doc();
    const sizes = new WeakMap<Y.Doc, number>();
    document.on('update', (update: Uint8Array) =>
      sizes.set(document, (sizes.get(document) ?? 0) + update.byteLength)
    );
    const text = document.getText('source');
    for (let index = 0; index < 50; index++) text.insert(0, 'x'.repeat(20));
    text.delete(0, text.length);
    const estimate = sizes.get(document) ?? 0;
    const exact = Y.encodeStateAsUpdate(document).byteLength;
    expect(exact).toBeLessThan(estimate);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    const edit = (value: string) => {
      const known = Y.encodeStateVector(peer);
      peer.getText('source').insert(0, value);
      return Y.encodeStateAsUpdate(peer, known);
    };
    const small = edit('y');

    expect(
      updateFitsRoom(sizes, document, small, estimate + small.byteLength)
    ).toBe(true);
    expect(sizes.get(document)).toBe(estimate);
    // The estimate crosses the cap, but GC left the room far smaller.
    expect(updateFitsRoom(sizes, document, small, estimate)).toBe(true);
    expect(sizes.get(document)).toBe(exact);
    expect(
      updateFitsRoom(sizes, document, edit('z'.repeat(estimate)), estimate)
    ).toBe(false);
    document.destroy();
    peer.destroy();
  });
});
