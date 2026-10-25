import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cleanupClerkActor } from './accounts';
import { verify } from './evidence';
import {
  api,
  fileRow,
  fixture,
  invite,
  noProviderCalls,
  object,
  sha256,
  string,
  upload,
} from './files';
import {
  apiNote,
  blobRefs,
  contentText,
  insertNoteMedia,
  materialAssets,
  materialRow,
  noisePng,
  notesWorkspace,
} from './note';
import { arrayField, verifyOutboxDelivery } from './providers';
import { type Actor, expect, test, type UatRun } from './runtime';

// An owner with content deletes their account
// (openwiki/authorization-permissions-lifecycles.md, "Account deletion and
// ownership" and "Logical deletion and the blob reaper"). Through the 30-day
// grace the rows stay but every member gets the non-disclosing 404; the real
// Clerk deletion's user.deleted webhook purges at once, the reaper takes the
// objects only the owner held, and a member's standalone copy of the note keeps
// its asset over the shared object and its charge (human/, 2026-10-11 clones).
// Store-only DOCX and Auto process edits off: no provider call.

const account = async (actor: Actor) =>
  object(object(await api(actor, '/api/me')).account);

async function listed(actor: Actor, workspaceId: string) {
  const rows = (await api(actor, '/api/workspaces')) as unknown[];
  return rows.some((row) => object(row).id === workspaceId);
}

/**
 * A user's charge as reconciliation recounts it (`storageRecountSQL`,
 * server/internal/store/storage.go) and as the counter holds it (folded bytes
 * plus pending deltas).
 */
async function storage(run: UatRun, userId: string) {
  const [row] = await run.query(
    `SELECT COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id=%s),0)
      + COALESCE((SELECT sum(storage_bytes) FROM source_documents WHERE user_id=%s),0)
      + COALESCE((SELECT sum(size_bytes) FROM editor_assets WHERE user_id=%s AND status='ready'),0)
      + COALESCE((SELECT sum(size_bytes) FROM materials WHERE owner_user_id=%s),0) AS recount,
    COALESCE((SELECT sum(COALESCE(reserved_size,declared_size)) FROM upload_sessions
      WHERE user_id=%s AND status='pending' AND expires_at>now()),0) AS recount_reserved,
    (SELECT s.used_bytes+COALESCE((SELECT sum(d.delta_bytes) FROM user_storage_deltas d WHERE d.user_id=s.user_id),0)
      FROM user_storage s WHERE s.user_id=%s) AS used,
    (SELECT reserved_bytes FROM user_storage WHERE user_id=%s) AS reserved`,
    Array.from({ length: 7 }, () => userId)
  );
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)])
  );
}

/**
 * Where each object stands: its database references (`refs`, null once none
 * is left), a queued deletion not yet due (`delayed`: upload paths wait a day
 * so a late PUT is collected, the documented `not_before`) and whether B2
 * still holds a current version (`live`).
 */
async function objects(run: UatRun, keys: string[]) {
  const rows = await run.query<{
    key: string;
    refs: number | null;
    delayed: boolean | null;
  }>(
    `SELECT k.key,b.ref_count AS refs,p.not_before>now() AS delayed
    FROM unnest(%s::text[]) AS k(key)
    LEFT JOIN blobs b ON b.object_path=k.key
    LEFT JOIN pending_blob_deletions p ON p.object_path=k.key ORDER BY k.key`,
    [keys]
  );
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      live: (
        await verify<{ latest: boolean; deleteMarker: boolean }[]>({
          key: row.key,
          operation: 'versions',
        })
      ).some((version) => version.latest && !version.deleteMarker),
    }))
  );
}

test('account deletion: an owner with an Office file, a note image, a member and a cloned note deletes the account; members get 404 through the grace, the Clerk deletion purges the content and reaps the owner-only objects, and the clone keeps its object and charge', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const { owner } = run;
  const workspaceId = await notesWorkspace(run, 'deletion');
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const body = `Deletion ${marker}`;
  const fileId = await upload(
    run,
    workspaceId,
    'lesson.docx',
    await fixture('lesson.docx', marker),
    true
  );
  const noteId = await apiNote(run, workspaceId, body);
  const png = noisePng(320, 240);
  const image = await insertNoteMedia(
    run,
    owner,
    workspaceId,
    noteId,
    body,
    'img',
    { buffer: png, mimeType: 'image/png', name: 'marsh.png' }
  );
  const member = await run.createActor('member');
  const cloner = await run.createActor('cloner');
  await invite(run, workspaceId, member, 'editor');
  // Members of any role copy items out of a workspace; link viewers do not.
  await invite(run, workspaceId, cloner, 'viewer');

  // 1. Before: both members read the owner's items and get room tokens.
  const noteToken = `/api/materials/${noteId}/collaboration-token`;
  const fileToken = `/api/files/${fileId}/collaboration-token`;
  const reads = [
    `/api/workspaces/${workspaceId}`,
    `/api/workspaces/${workspaceId}/members`,
    `/api/materials/${noteId}`,
    `/api/files/${fileId}`,
    `/api/files/${fileId}/links`,
    `/api/editor-assets/${image.id}/resolve`,
  ];
  for (const [actor, access] of [
    [member, 'write'],
    [cloner, 'read'],
  ] as const) {
    for (const path of reads) await api(actor, path);
    for (const path of [noteToken, fileToken])
      expect(
        object(await api(actor, path, 'POST', undefined, 201)).access
      ).toBe(access);
    assert(await listed(actor, workspaceId));
  }

  // 2. The cloner's standalone copy: its own asset row over the same object.
  const clone = string(
    object(
      await api(
        cloner,
        `/api/materials/${noteId}/clone`,
        'POST',
        { title: `UAT ${run.id.slice(0, 16)} kept note` },
        201
      )
    ).id
  );
  const cloneRow = await materialRow(run, clone);
  expect(cloneRow).toMatchObject({
    owner_user_id: cloner.id,
    workspace_id: null,
  });
  const copies = await materialAssets(run, clone);
  expect(copies).toHaveLength(1);
  const [copy] = copies;
  expect(copy).toMatchObject({
    object_path: image.object_path,
    status: 'ready',
    trashed: false,
    user_id: cloner.id,
  });
  assert.notEqual(copy.id, image.id);
  assert((await contentText(run, clone)).includes(copy.id));
  expect(await blobRefs(run, image.object_path)).toBe(2);
  const kept = Number((await account(cloner)).storageUsedBytes);
  expect(kept).toBe(Number(cloneRow.size_bytes) + Number(copy.size_bytes));
  await noProviderCalls(run, workspaceId);

  // Every object the owner holds, recorded before the purge deletes its rows.
  const keys = (
    await run.query<{ key: string | null }>(
      `SELECT blob_path AS key FROM files WHERE user_id=%s
      UNION SELECT thumbnail_key FROM files WHERE user_id=%s
      UNION SELECT base_blob_path FROM source_documents WHERE user_id=%s
      UNION SELECT object_path FROM upload_sessions WHERE user_id=%s
      UNION SELECT final_path FROM upload_sessions WHERE user_id=%s
      UNION SELECT object_path FROM editor_assets WHERE user_id=%s`,
      Array.from({ length: 6 }, () => owner.id)
    )
  )
    .map((row) => row.key)
    .filter((key): key is string => Boolean(key));
  for (const key of keys)
    await run.record('blob', key, { ownerId: owner.id, workspaceId });
  expect(keys).toEqual(
    expect.arrayContaining([
      string((await fileRow(run, fileId)).blob_path),
      image.object_path,
    ])
  );
  const ownerOnly = keys.filter((key) => key !== image.object_path);

  // 3. Deletion requested: the owner's content stays, dormant, for the grace.
  await owner.page.goto(run.env.appUrl);
  const preflight = object(await api(owner, '/api/account/deletion'));
  expect(preflight.canDelete).toBe(true);
  expect(
    arrayField(preflight, 'workspacesToDestroy').map(
      (entry) => object(entry).id
    )
  ).toContain(workspaceId);
  const requested = object(
    await api(owner, '/api/account/deletion', 'POST', {
      confirmEmail: owner.email,
      lifecycleGeneration: preflight.lifecycleGeneration,
    })
  );
  expect(requested.state).toBe('deletion_pending');
  expect(
    await run.query(
      `SELECT (SELECT deleted_at IS NULL FROM users WHERE id=%s) AS live,
      (SELECT count(*)::int FROM files WHERE id=%s) AS files,
      (SELECT count(*)::int FROM materials WHERE id=%s) AS notes,
      (SELECT count(*)::int FROM editor_assets WHERE id=%s) AS images,
      (SELECT count(*)::int FROM workspace_members WHERE workspace_id=%s AND user_id IN (%s,%s)) AS members`,
      [owner.id, fileId, noteId, image.id, workspaceId, member.id, cloner.id]
    )
  ).toEqual([{ files: 1, images: 1, live: true, members: 2, notes: 1 }]);

  // 4. Grace: each owner item, room token, note write and copy answers the
  // non-disclosing 404, as after a removal (membership.spec.ts). Soft, so one
  // run names every path that answers otherwise.
  const refused: [Actor, string, string, unknown?][] = [];
  for (const actor of [member, cloner]) {
    for (const path of reads) refused.push([actor, 'GET', path]);
    for (const path of [noteToken, fileToken])
      refused.push([actor, 'POST', path]);
  }
  refused.push(
    [member, 'PATCH', `/api/materials/${noteId}/metadata`, { title: marker }],
    [cloner, 'POST', `/api/materials/${noteId}/clone`, { title: marker }]
  );
  for (const [actor, method, path, payload] of refused)
    expect
      .soft(
        (await actor.request(path, method, payload)).status,
        `${method} ${path}`
      )
      .toBe(404);
  for (const actor of [member, cloner]) {
    assert(!(await listed(actor, workspaceId)));
    expect((await account(actor)).state).toBe('active');
  }
  await api(cloner, `/api/materials/${clone}`);
  // The deletion notice is sent before the purge removes its outbox row.
  await verifyOutboxDelivery(
    run,
    owner.id,
    owner.email,
    'account-deletion-requested'
  );

  // 5. The real Clerk deletion: its user.deleted webhook purges at once.
  await cleanupClerkActor(run.env, owner.id, run.id, owner.email);
  await run.poll(
    'Clerk deletion webhook and application purge',
    () =>
      run.query(
        'SELECT deleted_at,identity_deleted_at FROM users WHERE id=%s',
        [owner.id]
      ),
    (rows) =>
      rows.length === 1 &&
      Boolean(rows[0].deleted_at) &&
      Boolean(rows[0].identity_deleted_at),
    180_000
  );
  await run.poll(
    'Clerk user.deleted receipt',
    () =>
      run.query<{ error: string | null }>(
        "SELECT error FROM webhook_events WHERE source='clerk' AND user_id=%s AND event_type='user.deleted' AND processed_at IS NOT NULL ORDER BY processed_at LIMIT 1",
        [owner.id]
      ),
    (rows) => rows.length === 1 && rows[0].error === null,
    120_000
  );
  expect(
    await run.query(
      `SELECT (SELECT count(*)::int FROM workspaces WHERE user_id=%s) AS workspaces,
      (SELECT count(*)::int FROM workspace_members WHERE workspace_id=%s) AS members,
      (SELECT count(*)::int FROM files WHERE user_id=%s) AS files,
      (SELECT count(*)::int FROM source_documents WHERE user_id=%s) AS sources,
      (SELECT count(*)::int FROM materials WHERE owner_user_id=%s) AS materials,
      (SELECT count(*)::int FROM editor_assets WHERE user_id=%s) AS assets,
      (SELECT count(*)::int FROM upload_sessions WHERE user_id=%s) AS uploads`,
      [owner.id, workspaceId, ...Array.from({ length: 5 }, () => owner.id)]
    )
  ).toEqual([
    {
      assets: 0,
      files: 0,
      materials: 0,
      members: 0,
      sources: 0,
      uploads: 0,
      workspaces: 0,
    },
  ]);
  expect(await storage(run, owner.id)).toEqual({
    recount: 0,
    recount_reserved: 0,
    reserved: 0,
    used: 0,
  });

  // 6. The objects only the owner held are reaped (or wait out their
  // not_before); the shared one stays with the clone.
  const reaped = await run.poll(
    'the owner-only objects reaped',
    () => objects(run, ownerOnly),
    (rows) =>
      rows.length === ownerOnly.length &&
      rows.every((row) => row.refs === null && (!row.live || row.delayed)),
    240_000
  );
  expect(await blobRefs(run, image.object_path)).toBe(1);
  expect(
    await run.query(
      'SELECT object_path FROM pending_blob_deletions WHERE object_path=%s',
      [image.object_path]
    )
  ).toEqual([]);
  expect((await run.blob(image.object_path)).sha256).toBe(
    sha256(image.uploaded)
  );

  // 7. The clone holder keeps the copy, its image and its charge.
  expect(
    (await materialAssets(run, clone)).map((row) => [
      row.id,
      row.status,
      row.trashed,
    ])
  ).toEqual([[copy.id, 'ready', false]]);
  const read = object(await api(cloner, `/api/materials/${clone}`));
  assert(JSON.stringify(read.content).includes(copy.id));
  expect(
    object(await api(cloner, `/api/editor-assets/${copy.id}/resolve`)).sizeBytes
  ).toBe(image.uploaded.length);
  expect(
    object(
      await api(
        cloner,
        `/api/materials/${clone}/collaboration-token`,
        'POST',
        undefined,
        201
      )
    ).access
  ).toBe('write');
  expect(Number((await account(cloner)).storageUsedBytes)).toBe(kept);
  expect((await account(member)).state).toBe('active');
  await run.attach(`${workspaceId}-account-deletion`, {
    clone,
    cloneAssetId: copy.id,
    clonerId: cloner.id,
    fileId,
    imageAssetId: image.id,
    kept,
    memberId: member.id,
    noteId,
    ownerId: owner.id,
    reaped,
    shared: image.object_path,
  });
});
