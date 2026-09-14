import { createClerkClient } from '@clerk/backend';
import { expect } from '@playwright/test';
import { cleanupClerkActor, savedTokenStatus } from './accounts';
import {
  arrayField,
  object,
  stringField,
  verifyOutboxDelivery,
} from './providers';
import { test } from './runtime';

test('registration, durable profile, deletion grace and identity webhook purge', async ({
  run,
}) => {
  const actor = run.owner;
  const client = createClerkClient({ secretKey: run.env.clerkSecretKey });
  const user = await client.users.getUser(actor.id);
  expect(user.privateMetadata.capyUatRunId).toBe(run.id);
  expect(
    user.emailAddresses.some(
      (email) =>
        email.emailAddress === actor.email &&
        email.verification?.status === 'verified'
    )
  ).toBe(true);
  const createdReceipts = await run.poll(
    'Clerk user.created receipt',
    () =>
      run.query<{ id: string; error: string | null }>(
        "SELECT id,error FROM webhook_events WHERE source='clerk' AND user_id=%s AND event_type='user.created' AND processed_at IS NOT NULL ORDER BY processed_at LIMIT 1",
        [actor.id]
      ),
    (rows) => rows.length === 1 && rows[0].error === null,
    120_000
  );
  const name = `UAT ${run.id.slice(0, 16)}`;
  expect((await actor.request('/api/me', 'PATCH', { name })).status).toBe(200);
  expect(
    (
      await run.query<{ name: string }>('SELECT name FROM users WHERE id=%s', [
        actor.id,
      ])
    )[0].name
  ).toBe(name);

  const created = await actor.request('/api/workspaces', 'POST', {
    color: 'graphite',
    name: `Deletion ${run.id}`,
  });
  expect(created.status).toBe(201);
  const workspaceId = stringField(created.body, 'id');
  await run.record('workspace', workspaceId, { ownerId: actor.id });
  const preflight = await actor.request('/api/account/deletion');
  expect(preflight.status).toBe(200);
  const deletion = object(preflight.body);
  expect(deletion.canDelete).toBe(true);
  expect(deletion.graceDays).toBe(30);
  expect(
    arrayField(deletion, 'workspacesToDestroy').map((entry) => object(entry).id)
  ).toContain(workspaceId);
  if (typeof deletion.lifecycleGeneration !== 'number')
    throw new Error('Deletion preflight omitted its generation');
  const token = await actor.page.evaluate(async () => {
    const clerk = (
      window as unknown as {
        Clerk: { session: { getToken(): Promise<string | null> } };
      }
    ).Clerk;
    return clerk.session.getToken();
  });
  if (!token) throw new Error('No active token before deletion');
  const requested = await actor.request('/api/account/deletion', 'POST', {
    confirmEmail: actor.email,
    lifecycleGeneration: deletion.lifecycleGeneration,
  });
  expect(requested.status).toBe(200);
  expect(object(requested.body).state).toBe('deletion_pending');
  const grace = await run.query<{
    grace_seconds: number;
    deleted_at: string | null;
  }>(
    'SELECT extract(epoch FROM (purge_after-deletion_requested_at))::double precision AS grace_seconds,deleted_at FROM users WHERE id=%s',
    [actor.id]
  );
  // Go computes purge_after before PostgreSQL records deletion_requested_at.
  expect(grace[0].grace_seconds).toBeCloseTo(30 * 86_400, 0);
  expect(grace[0].deleted_at).toBeNull();
  expect(
    (await run.query('SELECT id FROM workspaces WHERE id=%s', [workspaceId]))
      .length
  ).toBe(1);
  const denied = await savedTokenStatus(
    actor.context.request,
    new URL('/api/me', run.env.apiUrl).toString(),
    token
  );
  expect([401, 403]).toContain(denied);
  await run.poll(
    'all Clerk sessions revoked',
    async () =>
      (
        await client.sessions.getSessionList({
          limit: 1,
          status: 'active',
          userId: actor.id,
        })
      ).totalCount,
    (count) => count === 0,
    60_000
  );
  // Read the outbox before account purge deliberately removes local notification history.
  await verifyOutboxDelivery(
    run,
    actor.id,
    actor.email,
    'account-deletion-requested'
  );
  await cleanupClerkActor(run.env, actor.id, run.id, actor.email);
  const tombstones = await run.poll(
    'Clerk deletion webhook and application purge',
    () =>
      run.query<{
        name: string;
        email: string | null;
        avatar_url: string | null;
        deleted_at: string | null;
        identity_deleted_at: string | null;
      }>(
        'SELECT name,email,avatar_url,deleted_at,identity_deleted_at FROM users WHERE id=%s',
        [actor.id]
      ),
    (rows) =>
      rows.length === 1 &&
      Boolean(rows[0].deleted_at) &&
      Boolean(rows[0].identity_deleted_at),
    180_000
  );
  expect(tombstones[0]).toMatchObject({
    avatar_url: null,
    email: null,
    name: '',
  });
  expect(
    await run.query('SELECT id FROM workspaces WHERE user_id=%s', [actor.id])
  ).toEqual([]);
  expect(
    await run.query('SELECT id FROM email_outbox WHERE user_id=%s', [actor.id])
  ).toEqual([]);
  const deletedReceipts = await run.poll(
    'Clerk user.deleted receipt',
    () =>
      run.query<{ id: string; error: string | null }>(
        "SELECT id,error FROM webhook_events WHERE source='clerk' AND user_id=%s AND event_type='user.deleted' AND processed_at IS NOT NULL ORDER BY processed_at LIMIT 1",
        [actor.id]
      ),
    (rows) => rows.length === 1 && rows[0].error === null,
    120_000
  );
  await run.attach('account-lifecycle', {
    actorId: actor.id,
    createdReceiptId: createdReceipts[0].id,
    deletedReceiptId: deletedReceipts[0].id,
    graceDays: 30,
    identityWebhookPurged: true,
    naturalGraceExpiry: 'not simulated',
    retained: 'scrubbed user tombstone and permitted ledgers',
    workspaceId,
  });
});
