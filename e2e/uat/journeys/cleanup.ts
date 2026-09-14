import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClerkClient } from '@clerk/backend';
import { cleanupClerkActor } from './accounts';
import { loadEnvironment } from './environment';
import {
  type Manifest,
  poll,
  readManifest,
  runDirectory,
  sanitize,
  verify,
  writeManifest,
} from './evidence';
import { verifyClerkInstance, verifyRelease } from './preflight';
import {
  arrayField,
  cleanupStripeCustomer,
  cleanupStripeTestClock,
  expireStripeCheckout,
  object,
  readSentryEvent,
  readSentryEvents,
  stringField,
  stripeRequest,
} from './providers';

const query = <T>(sql: string, params: unknown[] = []) =>
  verify<T[]>({ operation: 'query', params, sql });

export function validateCleanupTarget(
  manifest: Manifest,
  env: ReturnType<typeof loadEnvironment>
) {
  if (
    manifest.appUrl !== env.appUrl ||
    manifest.bucket !== env.b2Bucket ||
    manifest.revision !== env.expectedRevision
  ) {
    throw new Error('Cleanup configuration must match the recorded UAT run');
  }
  const prefix = `uat-${manifest.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}-`;
  for (const resource of manifest.resources.filter(
    (entry) => entry.kind === 'actor-email' || entry.kind === 'actor'
  )) {
    const email =
      resource.kind === 'actor-email' ? resource.id : resource.details.email;
    if (
      typeof email !== 'string' ||
      !email.startsWith(prefix) ||
      !email.endsWith(`+clerk_test@${env.actorEmailDomain}`)
    )
      throw new Error('Cleanup actor email does not belong to this run');
    if (
      resource.kind === 'actor' &&
      (!/^user_[a-zA-Z0-9]+$/.test(resource.id) ||
        !manifest.resources.some(
          (entry) => entry.kind === 'actor-email' && entry.id === email
        ))
    )
      throw new Error('Cleanup actor has no exact registration intent');
  }
}

export async function cleanupRun(id: string) {
  const directory = runDirectory(id);
  // No provider writes are possible before preflight creates the manifest.
  if (!existsSync(path.join(directory, 'manifest.json'))) return;
  const env = loadEnvironment();
  const manifest = readManifest(id);
  validateCleanupTarget(manifest, env);
  const failed: string[] = [];
  const retained: unknown[] = [];
  let canPurgeActors = true;
  const record = (
    kind: string,
    resourceId: string,
    details: Record<string, unknown> = {}
  ) => {
    const existing = manifest.resources.find(
      (resource) => resource.kind === kind && resource.id === resourceId
    );
    if (existing) Object.assign(existing.details, details);
    else
      manifest.resources.push({
        createdAt: new Date().toISOString(),
        details,
        id: resourceId,
        kind,
      });
    writeManifest(manifest);
  };
  const step = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      // SDK errors may carry credentials. Exact resource IDs remain in the manifest.
      failed.push(label);
    }
  };
  const recover = async (label: string, action: () => Promise<unknown>) => {
    const previousFailures = failed.length;
    await step(label, action);
    if (failed.length !== previousFailures) canPurgeActors = false;
  };
  const resources = (kind: string) =>
    manifest.resources.filter((entry) => entry.kind === kind);
  try {
    await verifyClerkInstance(env);
    const clerk = createClerkClient({ secretKey: env.clerkSecretKey });
    // Recover a signup that committed remotely before its local ID was recorded.
    for (const intent of resources('actor-email')) {
      await recover(`Recover Clerk registration ${intent.id}`, async () => {
        const users = await clerk.users.getUserList({
          emailAddress: [intent.id],
          limit: 2,
        });
        if (users.totalCount > 1)
          throw new Error('Ambiguous exact signup email');
        for (const user of users.data) {
          if (
            user.createdAt < Date.parse(manifest.startedAt) - 5000 ||
            (user.privateMetadata.capyUatRunId &&
              user.privateMetadata.capyUatRunId !== id)
          )
            throw new Error('Registration ownership mismatch');
          if (
            !user.emailAddresses.some(
              (email) => email.emailAddress === intent.id
            )
          )
            throw new Error('Registration email mismatch');
          if (user.privateMetadata.capyUatRunId !== id)
            await clerk.users.updateUserMetadata(user.id, {
              privateMetadata: { capyUatRunId: id },
            });
          record('actor', user.id, { email: intent.id });
        }
      });
    }
    const actorIds = resources('actor').map((actor) => actor.id);
    const sourceHashes = [
      ...new Set(
        resources('blob')
          .map((resource) => resource.details.sourceSha256)
          .filter(
            (value): value is string =>
              typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
          )
      ),
    ];
    if (sourceHashes.length)
      await recover(
        'Capture caches retained for the exact run sources',
        async () => {
          const caches = await query<{ object_path: string; kind: string }>(
            'SELECT object_path,kind FROM artifact_cache WHERE source_sha256=ANY(%s::text[])',
            [sourceHashes]
          );
          for (const cache of caches)
            record('blob', cache.object_path, {
              cache: true,
              kind: cache.kind,
            });
        }
      );
    if (actorIds.length) {
      await recover(
        'Capture owned storage and worker traces before account purge',
        async () => {
          const keys = await query<{ key: string }>(
            `
          SELECT blob_path AS key FROM files WHERE user_id=ANY(%s::text[])
          UNION SELECT parsed_blob_path FROM files WHERE user_id=ANY(%s::text[])
          UNION SELECT caption_blob_path FROM files WHERE user_id=ANY(%s::text[])
          UNION SELECT base_blob_path FROM source_documents WHERE user_id=ANY(%s::text[])
          UNION SELECT source_blob_path FROM source_refresh_candidates WHERE user_id=ANY(%s::text[])
          UNION SELECT object_path FROM upload_sessions WHERE user_id=ANY(%s::text[])
          UNION SELECT final_path FROM upload_sessions WHERE user_id=ANY(%s::text[])
          UNION SELECT object_path FROM editor_assets WHERE user_id=ANY(%s::text[])
          UNION SELECT a.caption_blob_path FROM image_caption_associations a JOIN files f ON f.id=a.file_id WHERE f.user_id=ANY(%s::text[])`,
            Array.from({ length: 9 }, () => actorIds)
          );
          for (const row of keys) if (row.key) record('blob', row.key);
          const attempts = await query<{ trace_id: string; job_id: string }>(
            "SELECT a.trace_id,a.job_id FROM ingest_job_attempts a JOIN jobs j ON j.id=a.job_id JOIN files f ON f.id=j.payload->>'fileId' WHERE f.user_id=ANY(%s::text[])",
            [actorIds]
          );
          for (const attempt of attempts)
            record('trace', attempt.trace_id, { jobId: attempt.job_id });
          const emails = await query<{
            provider_message_id: string;
            template: string;
            user_id: string;
          }>(
            'SELECT provider_message_id,template,user_id FROM email_outbox WHERE user_id=ANY(%s::text[]) AND provider_message_id IS NOT NULL',
            [actorIds]
          );
          for (const email of emails)
            record('resend-email', email.provider_message_id, {
              template: email.template,
              userId: email.user_id,
            });
        }
      );
      await recover(
        'Recover application Stripe customer and Checkout records',
        async () => {
          const account = await stripeRequest(env, '/v1/account');
          if (account.id !== env.stripeAccountId)
            throw new Error('Stripe account mismatch');
          const reservations = await query<{ id: string; status: string }>(
            'SELECT id,status FROM stripe_checkout_sessions WHERE user_id=ANY(%s::text[])',
            [actorIds]
          );
          for (const reservation of reservations)
            record('stripe-reservation', reservation.id, {
              status: reservation.status,
            });
          if (
            reservations.some(
              (reservation) => reservation.status === 'creating'
            )
          )
            throw new Error(
              'Checkout provider binding is still being recovered'
            );
          const customers = await query<{ id: string; user_id: string }>(
            'SELECT stripe_customer_id AS id,id AS user_id FROM users WHERE id=ANY(%s::text[]) AND stripe_customer_id IS NOT NULL UNION SELECT customer_id,user_id FROM stripe_checkout_sessions WHERE user_id=ANY(%s::text[]) AND customer_id IS NOT NULL',
            [actorIds, actorIds]
          );
          for (const row of customers) {
            let customer: Record<string, unknown>;
            try {
              customer = await stripeRequest(
                env,
                `/v1/customers/${encodeURIComponent(row.id)}`
              );
            } catch (error) {
              if (
                error instanceof Error &&
                'status' in error &&
                error.status === 404
              )
                continue;
              throw error;
            }
            if (customer.deleted === true) continue;
            const metadata = object(customer.metadata);
            if (
              customer.livemode !== false ||
              metadata.user_id !== row.user_id ||
              (metadata.capyUatRunId && metadata.capyUatRunId !== id)
            )
              throw new Error('Stripe customer ownership mismatch');
            record('stripe-customer', row.id, { userId: row.user_id });
            if (metadata.capyUatRunId !== id)
              await stripeRequest(
                env,
                `/v1/customers/${encodeURIComponent(row.id)}`,
                'POST',
                { 'metadata[capyUatRunId]': id },
                `${id}-${row.id}-claim`
              );
          }
          const checkouts = await query<{ id: string; user_id: string }>(
            'SELECT provider_session_id AS id,user_id FROM stripe_checkout_sessions WHERE user_id=ANY(%s::text[]) AND provider_session_id IS NOT NULL',
            [actorIds]
          );
          for (const row of checkouts)
            record('stripe-checkout', row.id, { userId: row.user_id });
        }
      );
    }
    // An uncertain clock creation can be recovered by its exact recorded name.
    for (const intent of resources('stripe-clock-intent')) {
      await recover(`Recover Stripe clock ${intent.id}`, async () => {
        if (intent.id !== `capy-uat-${id}`)
          throw new Error('Clock intent mismatch');
        const account = await stripeRequest(env, '/v1/account');
        if (account.id !== env.stripeAccountId)
          throw new Error('Stripe account mismatch');
        let cursor = '';
        for (let page = 0; page < 100; page++) {
          const result = await stripeRequest(
            env,
            `/v1/test_helpers/test_clocks?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`
          );
          const clocks = arrayField(result, 'data').map(object);
          for (const clock of clocks)
            if (clock.name === intent.id && clock.livemode === false)
              record('stripe-clock', stringField(clock, 'id'));
          if (result.has_more !== true) return;
          cursor = stringField(clocks.at(-1), 'id');
        }
        throw new Error('Clock lookup exceeded bounded pages');
      });
    }
    for (const resource of resources('stripe-checkout'))
      await step(`Expire Stripe Checkout ${resource.id}`, () =>
        expireStripeCheckout(
          env,
          resource.id,
          id,
          stringField(resource.details, 'userId')
        )
      );
    for (const resource of resources('stripe-customer'))
      await step(`Delete Stripe customer ${resource.id}`, () =>
        cleanupStripeCustomer(
          env,
          resource.id,
          id,
          stringField(resource.details, 'userId')
        )
      );
    for (const resource of resources('stripe-clock'))
      await step(`Delete Stripe clock ${resource.id}`, () =>
        cleanupStripeTestClock(env, resource.id, id)
      );
    // Purge must not erase the source rows of a failed recovery read.
    if (!canPurgeActors)
      failed.push(
        'Clerk deletion deferred until recovery inventory can be durably saved'
      );
    for (const actor of canPurgeActors ? resources('actor') : [])
      await step(`Delete Clerk actor ${actor.id}`, () =>
        cleanupClerkActor(
          env,
          actor.id,
          id,
          stringField(actor.details, 'email')
        )
      );
    if (canPurgeActors && actorIds.length)
      await step(
        'Verify account purge and released storage reservations',
        async () => {
          await poll(
            'Account content purged by Clerk webhook',
            () =>
              query<{ remaining: string }>(
                `
        SELECT (SELECT count(*) FROM users WHERE id=ANY(%s::text[]) AND (deleted_at IS NULL OR name<>'' OR email IS NOT NULL OR avatar_url IS NOT NULL))
          + (SELECT count(*) FROM workspaces WHERE user_id=ANY(%s::text[]))
          + (SELECT count(*) FROM materials WHERE owner_user_id=ANY(%s::text[]))
          + (SELECT count(*) FROM upload_sessions WHERE user_id=ANY(%s::text[]))
          + (SELECT count(*) FROM source_documents WHERE user_id=ANY(%s::text[]))
          + (SELECT count(*) FROM email_outbox WHERE user_id=ANY(%s::text[]))
          + (SELECT count(*) FROM user_storage WHERE user_id=ANY(%s::text[]) AND reserved_bytes<>0) AS remaining`,
                Array.from({ length: 7 }, () => actorIds)
              ),
            (rows) => rows.length === 1 && Number(rows[0].remaining) === 0,
            180_000
          );
          retained.push({
            action:
              'No manual deletion required. Investigate only unsanitized PII or remaining product content.',
            actorIds,
            kind: 'account-ledgers',
            reason:
              'Scrubbed account tombstones and pseudonymous billing, usage, webhook and audit records follow product retention.',
          });
        }
      );
    const keys = resources('blob').map((resource) => resource.id);
    if (keys.length) {
      await step('Drain due blob deletion jobs', () =>
        poll(
          'Due blob deletions drained',
          () =>
            query<{ object_path: string }>(
              'SELECT object_path FROM pending_blob_deletions WHERE object_path=ANY(%s::text[]) AND not_before<=now()',
              [keys]
            ),
          (rows) => rows.length === 0,
          120_000
        )
      );
      for (const key of keys)
        await step(`Verify B2 object ${key}`, async () => {
          const refs = await query<{
            ref_count: number;
            kind: string | null;
            last_used_at: string | null;
            not_before: string | null;
          }>(
            'SELECT b.ref_count,a.kind,a.last_used_at,p.not_before FROM (SELECT %s::text AS key) k LEFT JOIN blobs b ON b.object_path=k.key LEFT JOIN artifact_cache a ON a.object_path=k.key LEFT JOIN pending_blob_deletions p ON p.object_path=k.key',
            [key]
          );
          const versions = await verify<
            Array<{
              id: string;
              latest: boolean;
              deleteMarker: boolean;
              modified: string;
            }>
          >({ key, operation: 'versions' });
          const current = versions.find(
            (version) => version.latest && !version.deleteMarker
          );
          const ref = refs[0];
          if (
            current &&
            !(ref.ref_count > 0) &&
            !(ref.not_before && Date.parse(ref.not_before) > Date.now())
          )
            throw new Error('Unreferenced live B2 object remains');
          if (versions.length)
            retained.push({
              action:
                'Re-run cleanup after not_before for delayed uploads. Inspect cache/refcounts before any manual deletion; hidden versions expire under the bucket lifecycle policy.',
              key,
              kind: 'b2',
              reason: current
                ? ref.kind
                  ? 'Platform cache retains this object until its configured unused TTL expires.'
                  : ref.ref_count > 0
                    ? 'A live shared reference still owns this object.'
                    : 'Deletion is scheduled after the recorded late-upload deadline.'
                : 'Only hidden versions/delete markers remain under the B2 lifecycle policy.',
              references: ref,
              versions,
            });
        });
    }
    const traceIds = [
      ...new Set(
        [...resources('trace'), ...resources('sentry-expected')].map(
          (resource) => resource.id
        )
      ),
    ];
    if (traceIds.length || actorIds.length)
      await step(
        'Verify correlated Sentry errors and expected failure delivery',
        async () => {
          const expected = new Set(
            resources('sentry-expected').map((resource) => resource.id)
          );
          // Allow the final requests' asynchronous error delivery before the negative check.
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          const readEvents = async () => {
            const found = new Map<string, Record<string, unknown>>();
            const scopes = [{ actorIds, traceIds: [] as string[] }];
            for (let offset = 0; offset < traceIds.length; offset += 30)
              scopes.push({
                actorIds: [],
                traceIds: traceIds.slice(offset, offset + 30),
              });
            for (const scope of scopes)
              if (scope.traceIds.length || scope.actorIds.length) {
                for (const event of await readSentryEvents(env, {
                  ...scope,
                  start: manifest.startedAt,
                }))
                  found.set(`${event.project}:${event.id}`, event);
              }
            return [...found.values()];
          };
          const events = await poll(
            'Expected Sentry failure received',
            readEvents,
            (rows) =>
              [...expected].every((trace) =>
                rows.some((event) => event.trace_id === trace)
              ),
            expected.size ? 90_000 : 1
          );
          for (const event of events) {
            if (!expected.has(String(event.trace_id)))
              throw new Error('Unexpected correlated Sentry error');
            const details = await readSentryEvent(env, event);
            const exceptions = arrayField(details, 'entries')
              .map(object)
              .filter((entry) => entry.type === 'exception')
              .flatMap((entry) => arrayField(entry.data, 'values'))
              .map(object);
            if (
              exceptions.length !== 1 ||
              exceptions[0].type !== 'TerminalError' ||
              exceptions[0].value !== 'delimited table exceeds the cell limit'
            )
              throw new Error(
                'Unexpected error on the intentional failure trace'
              );
          }
          retained.push({
            action:
              'No deletion required; scope investigations to these exact event/trace IDs.',
            events,
            kind: 'sentry',
            reason:
              'Expected terminal ingest errors remain in monitoring history.',
          });
        }
      );
    await step('Verify release remained unchanged during the run', () =>
      verifyRelease(env)
    );
  } catch {
    failed.push(
      'Cleanup preflight failed; verify the exact UAT instance and manifest before rerunning'
    );
  } finally {
    retained.push(
      ...resources('resend-email').map((resource) => ({
        ...resource,
        action:
          'Remove recipient mailbox copies manually if desired; provider records follow provider retention.',
        reason:
          'Delivered synthetic email remains in provider history and the controlled recipient mailbox.',
      }))
    );
    retained.push(
      ...resources('stripe-invoice').map((resource) => ({
        ...resource,
        action: 'No deletion required; never use live keys for this suite.',
        reason: 'Sandbox invoices/payment records remain as provider history.',
      }))
    );
    manifest.cleanup = {
      failed,
      finishedAt: new Date().toISOString(),
      retained: sanitize(retained) as unknown[],
    };
    writeManifest(manifest);
    writeFileSync(
      path.join(directory, 'cleanup.json'),
      JSON.stringify(manifest.cleanup, null, 2),
      { mode: 0o600 }
    );
    writeFileSync(
      path.join(directory, 'cleanup.md'),
      `# UAT cleanup ${id}\n\n${failed.length ? 'FAILED: rerun cleanup after resolving the actions below.' : 'Completed. Expected retained resources are listed below.'}\n\n${failed.map((failure) => `- ${failure}`).join('\n')}\n\nRun \`pnpm e2e:uat:cleanup --run-id ${id}\` with the same UAT configuration and manifest. Do not delete shared cache objects or database ledgers directly.\n\n\`\`\`json\n${JSON.stringify(sanitize(retained), null, 2)}\n\`\`\`\n`,
      { mode: 0o600 }
    );
  }
  if (failed.length)
    throw new Error(
      `UAT cleanup failed: ${failed.join('; ')}. See ${directory}/cleanup.md`
    );
}

export default async function cleanup() {
  if (!process.env.UAT_RUN_ID)
    throw new Error('UAT_RUN_ID is required for cleanup');
  await cleanupRun(process.env.UAT_RUN_ID);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--run-id')
    throw new Error('Usage: pnpm e2e:uat:cleanup --run-id ID');
  await cleanupRun(args[1]);
}
