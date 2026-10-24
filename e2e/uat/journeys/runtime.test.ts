import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { request } from '@playwright/test';
import * as Y from 'yjs';
import { actorEmailPrefix, savedTokenStatus } from './accounts';
import {
  cleanupRun,
  validateCleanupTarget,
  validateRegistrationOwnership,
} from './cleanup';
import { loadEnvironment, type UatEnvironment } from './environment';
import {
  type Manifest,
  poll,
  readManifest,
  runDirectory,
  sanitize,
  writeEvidence,
  writeManifest,
} from './evidence';
import { settledSpend } from './files';
import { refresh, replaySaved, savedExport, savedUpdates } from './office';
import { REFUSAL_PREFIX, republication } from './officeRefusal';
import { cleanupStripeCustomer } from './providers';
import type { UatRun } from './runtime';

test('settled ingest spend waits for an uncertain attempt to reach its receipt deadline', async () => {
  let openCalls = 1;
  const recorded: string[] = [];
  const run = {
    attach: async () => {},
    poll: async <T>(
      _label: string,
      read: () => Promise<T>,
      accept: (value: T) => boolean
    ) => {
      assert.equal(accept(await read()), false);
      openCalls = 0;
      const settled = await read();
      assert.equal(accept(settled), true);
      return settled;
    },
    query: async () => [
      {
        calls: 3,
        id: 'session_fixture',
        open_calls: openCalls,
        receipts: 2,
        settled_at: '2026-09-28T00:00:00Z',
        status: 'settled',
      },
    ],
    record: async (_kind: string, id: string) => {
      recorded.push(id);
    },
  } as unknown as UatRun;
  await settledSpend(run, 'file_fixture');
  assert.deepEqual(recorded, ['session_fixture']);
  openCalls = 1;
  await assert.rejects(
    settledSpend(run, 'file_fixture', true),
    assert.AssertionError
  );
});

test('saved export accepts an untouched store-only source but keeps checkpoint hash checks', async () => {
  const bytes = Buffer.from('The original stored source.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const row = {
    base_blob_path: 'sources/untouched',
    base_source_sha256: '',
    checkpoint: 0,
    format: 'text',
    rows: [] as string[],
    state: null as string | null,
  };
  const run = {
    blob: async () => ({ bodyBase64: bytes.toString('base64'), sha256: hash }),
    query: async () => [row],
  } as unknown as UatRun;
  assert.deepEqual((await savedExport(run, 'file_fixture')).bytes, bytes);
  row.checkpoint = 1;
  await assert.rejects(
    savedExport(run, 'file_fixture'),
    /missing its source hash/
  );
  row.checkpoint = 0;
  row.state = 'AA==';
  await assert.rejects(
    savedExport(run, 'file_fixture'),
    /missing its source hash/
  );
  // A delta save's row with no state is saved editing state too.
  row.state = null;
  row.rows = ['AA=='];
  await assert.rejects(
    savedExport(run, 'file_fixture'),
    /missing its source hash/
  );
  row.rows = [];
  row.base_source_sha256 = hash;
  assert.deepEqual((await savedExport(run, 'file_fixture')).bytes, bytes);
  row.base_source_sha256 = '0'.repeat(64);
  await assert.rejects(savedExport(run, 'file_fixture'), assert.AssertionError);
});

const base64 = (update: Uint8Array) => Buffer.from(update).toString('base64');

/** A room's stores: each appends the update since its durable state
 * (`stored`, none while nothing is stored). */
function delta(room: Y.Doc, stored?: Uint8Array) {
  let durable = stored;
  return {
    fold: () => {
      durable = Y.encodeStateVector(room);
      return base64(Y.encodeStateAsUpdate(room));
    },
    store: () => {
      const row = Y.encodeStateAsUpdate(room, durable);
      durable = Y.encodeStateVector(room);
      return base64(row);
    },
  };
}

test('saved text is the state and its epoch rows replayed in order, as the server loads them', async () => {
  const base = Buffer.from('Wetland survey notes.\n');
  const row = {
    base_blob_path: 'sources/text',
    base_source_sha256: createHash('sha256').update(base).digest('hex'),
    checkpoint: 2,
    format: 'text',
    rows: [] as string[],
    state: null as string | null,
  };
  const run = {
    blob: async () => ({ bodyBase64: base.toString('base64') }),
    query: async () => [row],
  } as unknown as UatRun;
  // The room: seed(base) under client 0 (text_seed), edited by two peers.
  const seed = new Y.Doc();
  seed.clientID = 0;
  seed.getText('source').insert(0, base.toString());
  const room = new Y.Doc();
  Y.applyUpdate(room, Y.encodeStateAsUpdate(seed));
  const peer = new Y.Doc();
  const fromPeer = (edit: (text: Y.Text) => void) => {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room, Y.encodeStateVector(peer)));
    const vector = Y.encodeStateVector(peer);
    edit(peer.getText('source'));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(peer, vector));
  };
  const text = room.getText('source');
  const { fold, store } = delta(room);
  // A NULL state: the first row holds the seed.
  text.insert(text.length, 'The launch code is CEDAR-42.\n');
  const first = store();
  fromPeer((peerText) => {
    peerText.delete(0, 'Wetland'.length);
    peerText.insert(0, 'Marsh');
  });
  row.rows = [first, store()];
  assert.equal(
    (await savedExport(run, 'file_fixture')).text,
    'Marsh survey notes.\nThe launch code is CEDAR-42.\n'
  );
  // A folded state with two rows after it.
  row.state = fold();
  text.insert(text.length, 'Collaborator confirmed July.\n');
  const third = store();
  fromPeer((peerText) => peerText.insert(peerText.length - 1, ' (twice)'));
  const fourth = store();
  row.rows = [third, fourth];
  const saved = await savedExport(run, 'file_fixture');
  assert.equal(saved.text, text.toString());
  assert.equal(
    saved.text,
    'Marsh survey notes.\nThe launch code is CEDAR-42.\nCollaborator confirmed July. (twice)\n'
  );
  // A row whose predecessor is missing does not load.
  row.rows = [fourth];
  await assert.rejects(savedExport(run, 'file_fixture'), /missing/);
});

test('a saved Office state replays seed(base), the change over it and its epoch rows', () => {
  // seed(base) as the engine makes it, then the room's documents without
  // formatting cleanup.
  const seed = new Y.Doc();
  seed.clientID = 0;
  seed.getText('body').insert(0, 'Wetland survey at 42 sites.');
  const seedState = Y.encodeStateAsUpdate(seed);
  const room = new Y.Doc({ meta: { formattingCleanup: false } });
  Y.applyUpdate(room, seedState);
  const body = room.getText('body');
  body.format(0, 'Wetland'.length, { bold: true });
  body.insert(body.length, ' Owner sentence: CEDAR-42.');
  // The stored state: the change over the seed, with the whole delete set.
  const state = base64(Y.encodeStateAsUpdate(room, Y.encodeStateVector(seed)));
  const { store } = delta(room, Y.encodeStateVector(room));
  body.delete(0, 'Wetland '.length);
  const first = store();
  body.insert(body.length, ' Collaborator confirmed July.');
  const row = { rows: [first, store()], state };
  const saved = replaySaved([seedState, ...savedUpdates(row)]);
  try {
    assert.equal(
      saved.getText('body').toString(),
      'survey at 42 sites. Owner sentence: CEDAR-42. Collaborator confirmed July.'
    );
    assert.deepEqual(saved.getText('body').toDelta(), body.toDelta());
    assert.deepEqual(Y.encodeStateVector(saved), Y.encodeStateVector(room));
  } finally {
    saved.destroy();
  }
  // The change and rows refer to the seed's content.
  assert.throws(() => replaySaved(savedUpdates(row)), /missing from the seed/);
});

test('Office publication stops on a terminal pipeline job while the old file stays ready', async () => {
  const recorded: string[] = [];
  const run = {
    attach: async () => {},
    owner: {
      request: async () => ({ body: { jobId: 'job_refresh' }, status: 202 }),
    },
    poll: <T>(
      label: string,
      read: () => Promise<T>,
      accept: (value: T) => boolean
    ) => poll(label, read, accept, 1),
    query: async (sql: string) => {
      if (sql.includes('FROM source_documents'))
        return [
          {
            base_blob_path: 'sources/original',
            checkpoint: 10,
            indexed_checkpoint: 0,
          },
        ];
      if (sql.includes('FROM files')) return [{ revision: 1, status: 'ready' }];
      if (sql.includes('FROM jobs'))
        return [
          { error: null, id: 'job_refresh', status: 'done' },
          {
            error: 'source publication gateway returned 503',
            id: 'job_ingest',
            status: 'failed',
          },
        ];
      return [];
    },
    record: async (_kind: string, id: string) => {
      recorded.push(id);
    },
  } as unknown as UatRun;
  await assert.rejects(
    refresh(run, 'file_fixture'),
    /source refresh file_fixture failed in job_ingest: source publication gateway returned 503/
  );
  assert(recorded.includes('job_ingest'));
});

test('the republication wait fails on any failed refresh and needs a second automatic refresh recording the refusal', async () => {
  const fake = (
    failed: string[],
    automatic = 'true',
    refusal:
      | string
      | null = `${REFUSAL_PREFIX} a field result's child would not export in its field`
  ) =>
    ({
      poll: <T>(
        label: string,
        read: () => Promise<T>,
        accept: (value: T) => boolean
      ) => poll(label, read, accept, 1),
      query: async (sql: string) => {
        if (sql.includes('GROUP BY'))
          return [
            { automatic: 'true', checkpoint: 10, refusal: null },
            { automatic, checkpoint: 12, refusal },
          ];
        if (sql.includes('FROM jobs'))
          return ['job_held', 'job_other', 'job_fresh'].map((id) => ({
            error: failed.includes(id) ? 'failed' : null,
            id,
            status: failed.includes(id) ? 'failed' : 'done',
          }));
        if (sql.includes('FROM source_documents'))
          return [{ indexed_checkpoint: 12, refresh_error: null }];
        if (sql.includes('FROM files'))
          return [
            { blob_path: 'sources/new', revision: 3, source_sha256: 'c' },
          ];
        return [];
      },
      record: async () => {},
    }) as unknown as UatRun;
  const before = { revision: 2, source_sha256: 'b' };
  const published = await republication(fake([]), 'file_fixture', 12, before);
  assert.equal(published.revision, 3);
  await assert.rejects(
    republication(fake(['job_other']), 'file_fixture', 12, before),
    /source refresh file_fixture failed in job_other/
  );
  await assert.rejects(
    republication(fake([], 'false'), 'file_fixture', 12, before)
  );
  await assert.rejects(
    republication(fake([], 'true', null), 'file_fixture', 12, before)
  );
});

test('recorded cleanup ownership tolerates clock skew but never an identity mismatch', () => {
  const email = 'journeys+uat-owned+clerk_test@example.test';
  const manifest: Manifest = {
    appUrl: 'https://uat-app.capynotebook.com',
    bucket: 'capy-uat',
    id: 'owned-run',
    resources: [
      {
        createdAt: '2026-09-27T08:27:27.772Z',
        details: { email },
        id: 'user_owned',
        kind: 'actor',
      },
    ],
    revision: 'a'.repeat(40),
    startedAt: '2026-09-27T08:27:27.772Z',
    version: 1,
  };
  const user = {
    createdAt: Date.parse('2026-09-27T08:27:18.723Z'),
    emailAddresses: [{ emailAddress: email }],
    id: 'user_owned',
    privateMetadata: { capyUatRunId: manifest.id },
  };
  validateRegistrationOwnership(manifest, email, user);
  for (const patch of [
    { id: 'user_other' },
    { emailAddresses: [{ emailAddress: 'other@example.test' }] },
    { privateMetadata: {} },
    { privateMetadata: { capyUatRunId: 'another-run' } },
  ]) {
    assert.throws(
      () =>
        validateRegistrationOwnership(manifest, email, { ...user, ...patch }),
      /mismatch/
    );
  }
  const unrecorded = { ...manifest, resources: [] };
  assert.throws(
    () => validateRegistrationOwnership(unrecorded, email, user),
    /ownership mismatch/
  );
  validateRegistrationOwnership(unrecorded, email, {
    ...user,
    createdAt: Date.parse(manifest.startedAt),
    privateMetadata: {},
  });
});

test('actor emails stay within a 64-character local part and differ per lane', () => {
  const office = actorEmailPrefix('38756112360-12-office');
  const app = actorEmailPrefix('38756112360-12-app');
  assert.notEqual(office, app);
  // The longest label in use plus the random suffix and the test subaddress.
  assert.ok(`${office}rich-pptx-editor-12345678+clerk_test`.length <= 64);
});

test('cleanup requires the original target and exact run-owned registration intent', () => {
  const id = randomUUID();
  const email = `${actorEmailPrefix(id)}owner-12345678+clerk_test@example.test`;
  const manifest: Manifest = {
    appUrl: 'https://uat-app.capynotebook.com',
    bucket: 'capy-uat',
    id,
    resources: [
      {
        createdAt: new Date().toISOString(),
        details: {},
        id: email,
        kind: 'actor-email',
      },
      {
        createdAt: new Date().toISOString(),
        details: { email },
        id: 'user_fixture',
        kind: 'actor',
      },
    ],
    revision: 'a'.repeat(40),
    startedAt: new Date().toISOString(),
    version: 1,
  };
  const env = {
    actorEmailDomain: 'example.test',
    appUrl: manifest.appUrl,
    b2Bucket: manifest.bucket,
    expectedRevision: manifest.revision,
  } as UatEnvironment;
  validateCleanupTarget(manifest, env);
  assert.throws(() =>
    validateCleanupTarget(manifest, { ...env, b2Bucket: 'capy-production' })
  );
  assert.throws(() =>
    validateCleanupTarget(
      { ...manifest, resources: manifest.resources.slice(1) },
      env
    )
  );
  assert.throws(() =>
    validateCleanupTarget(
      {
        ...manifest,
        resources: [
          { ...manifest.resources[1], details: { email: 'real@example.test' } },
        ],
      },
      env
    )
  );
  try {
    writeManifest(manifest);
    assert.equal(readManifest(id).id, id);
    const evidence = writeEvidence(id, 'saved-content', {
      checkpoint: 2,
      token: 'private',
    });
    assert(
      evidence.startsWith(path.join(runDirectory(id), 'evidence') + path.sep)
    );
    assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), {
      checkpoint: 2,
    });
    assert.notEqual(writeEvidence(id, 'saved-content', {}), evidence);
    writeFileSync(
      path.join(runDirectory(id), 'manifest.json'),
      JSON.stringify({
        ...manifest,
        resources: [{ id: 'user_fake', kind: 'actor' }],
      })
    );
    assert.throws(() => readManifest(id));
    assert.throws(() => runDirectory('../another-run'));
  } finally {
    rmSync(runDirectory(id), { force: true, recursive: true });
  }
});

test('saved-token transport errors omit the runtime-issued credential', async () => {
  const context = await request.newContext({ timeout: 1000 });
  try {
    await assert.rejects(
      savedTokenStatus(
        context,
        'http://127.0.0.1:1/unreachable',
        'SYNTHETIC_UAT_CREDENTIAL'
      ),
      (error: unknown) => {
        assert(error instanceof Error);
        // Only a fixed transport kind may follow the stage name.
        assert.equal(
          error.message,
          'Saved-token authorization probe failed [ECONNREFUSED]; browser/provider details are omitted to keep credentials out of artifacts'
        );
        assert(!String(error.stack).includes('SYNTHETIC_UAT_CREDENTIAL'));
        assert(!('cause' in error));
        return true;
      }
    );
  } finally {
    await context.dispose();
  }
});

test('Stripe customer cleanup expires, voids and deletes only the exact run-owned customer', async () => {
  const env = {
    stripeAccountId: 'acct_fixture',
    stripeSecretKey: 'sk_test_fixture',
  } as UatEnvironment;
  const own = (id: string) => ({ customer: 'cus_run', id, livemode: false });
  const lists: Record<string, unknown[]> = {
    '/v1/checkout/sessions open': [own('cs_open')],
    '/v1/invoices draft': [own('in_draft')],
    '/v1/invoices open': [own('in_retrying')],
    '/v1/invoices uncollectible': [own('in_gave_up')],
    '/v1/subscriptions all': [],
  };
  const writes: string[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/account')
      return Response.json({ id: 'acct_fixture' });
    if (url.pathname === '/v1/customers/cus_run' && method === 'GET')
      return Response.json({
        id: 'cus_run',
        livemode: false,
        metadata: { capyUatRunId: 'run-fixture', user_id: 'user_fixture' },
      });
    const list = lists[`${url.pathname} ${url.searchParams.get('status')}`];
    if (method === 'GET' && list) {
      assert.equal(url.searchParams.get('customer'), 'cus_run');
      return Response.json({ data: list, has_more: false });
    }
    assert.notEqual(method, 'GET', `Unexpected read ${url.pathname}`);
    writes.push(`${method} ${url.pathname}`);
    return Response.json({});
  };
  try {
    await cleanupStripeCustomer(env, 'cus_run', 'run-fixture', 'user_fixture');
    assert.deepEqual(writes, [
      'POST /v1/checkout/sessions/cs_open/expire',
      'DELETE /v1/invoices/in_draft',
      'POST /v1/invoices/in_retrying/void',
      'POST /v1/invoices/in_gave_up/void',
      'DELETE /v1/customers/cus_run',
    ]);
    // Another customer's object in a scoped page stops cleanup before it voids
    // or deletes anything.
    lists['/v1/invoices draft'] = [{ ...own('in_other'), customer: 'cus_x' }];
    writes.length = 0;
    await assert.rejects(
      cleanupStripeCustomer(env, 'cus_run', 'run-fixture', 'user_fixture'),
      /ownership mismatch/
    );
    assert.deepEqual(writes, ['POST /v1/checkout/sessions/cs_open/expire']);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test('artifacts redact authentication credentials but retain exact resource IDs', () => {
  assert.deepEqual(
    sanitize({
      actorId: 'user_fixture',
      nested: {
        amount: 42,
        authorization: 'Bearer secret',
        value: 'https://b2.example/file?X-Amz-Signature=secret',
      },
      token: 'clerk-ticket',
      values: ['sk_test_fake', 'file_fixture'],
    }),
    {
      actorId: 'user_fixture',
      nested: { amount: 42, value: '[redacted]' },
      values: ['[redacted]', 'file_fixture'],
    }
  );
});

test('failed pre-purge inventory preserves accounts and a resumable failure report', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uat-cleanup-check-'));
  const id = randomUUID();
  const email = `${actorEmailPrefix(id)}owner-12345678+clerk_test@example.test`;
  const revision = 'a'.repeat(40);
  // Exercise the real cleanup orchestrator with a failed verifier process.
  // No application/provider is contacted; every fetch below is intercepted.
  writeFileSync(
    path.join(directory, 'uv'),
    `#!/usr/bin/env node
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const request=JSON.parse(input);
 if(request.sql.includes('SELECT blob_path AS key FROM files')) {
  process.stderr.write('UAT verifier failed (OfflineInventoryFailure)');process.exit(1);
 }
 process.stdout.write('[]');
});
`,
    { mode: 0o700 }
  );
  const environment: Record<string, string> = {
    B2_APP_KEY: 'fixture',
    B2_BUCKET: 'capy-uat',
    B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    B2_KEY_ID: 'fixture',
    B2_REGION: 'us-west-004',
    CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.uat.capynotebook.com$').toString('base64')}`,
    CLERK_SECRET_KEY: 'sk_test_fixture',
    EXPECTED_REVISION: revision,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    STRIPE_PRICE_PRO: 'price_fixture',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    UAT_ACTOR_EMAIL_DOMAIN: 'example.test',
    UAT_API_URL: 'https://uat-api.capynotebook.com',
    UAT_APP_URL: 'https://uat-app.capynotebook.com',
    UAT_CLERK_TEST_MODE: 'true',
    UAT_COLLAB_URL: 'wss://uat-collab.capynotebook.com',
    UAT_DATABASE_NAME: 'capy',
    UAT_DATABASE_URL: 'postgres://capy_uat_verifier:fixture@127.0.0.1/capy',
    UAT_INBOX_TOKEN: 'fixture',
    UAT_SENTRY_ORG: 'fixture',
    UAT_SENTRY_PROJECTS: 'fixture',
    UAT_SENTRY_TOKEN: 'fixture',
    UAT_SENTRY_URL: 'https://sentry.io',
    UAT_STRIPE_ACCOUNT_ID: 'acct_fixture',
    UAT_TARGET_AUTHORIZED: 'true',
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  const fetchBefore = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(url.pathname);
    if (url.pathname === '/v1/domains')
      return Response.json({
        data: [
          {
            frontend_api_url: 'https://clerk.uat.capynotebook.com',
            is_satellite: false,
            name: 'uat.capynotebook.com',
          },
        ],
      });
    if (url.pathname === '/v1/users') return Response.json([]);
    if (url.pathname === '/v1/users/count')
      return Response.json({ object: 'total_count', total_count: 0 });
    if (url.pathname === '/v1/account')
      return Response.json({ id: 'acct_fixture' });
    if (url.hostname === 'sentry.io') return Response.json({ data: [] });
    if (url.pathname === '/healthz')
      return Response.json(
        { status: 'ok' },
        { headers: { 'X-Capy-Release': revision } }
      );
    if (
      url.hostname === 'uat-app.capynotebook.com' ||
      url.hostname === 'uat-office.capynotebook.com'
    )
      return new Response(`<meta name="capy-release" content="${revision}">`);
    throw new Error(`Unexpected offline request path ${url.pathname}`);
  };
  try {
    Object.assign(process.env, environment);
    assert.equal(loadEnvironment().appUrl, 'https://uat-app.capynotebook.com');
    for (const appUrl of [
      'https://uat.capynotebook.com',
      'https://app.capynotebook.com',
      'https://app.uat.capynotebook.com',
      'https://uat-app.capynotebook.com/another-path',
    ]) {
      process.env.UAT_APP_URL = appUrl;
      assert.throws(() => loadEnvironment(), /UAT_APP_URL must select/);
    }
    process.env.UAT_APP_URL = environment.UAT_APP_URL;
    writeManifest({
      appUrl: environment.UAT_APP_URL,
      bucket: environment.B2_BUCKET,
      id,
      resources: [
        {
          createdAt: new Date().toISOString(),
          details: {},
          id: email,
          kind: 'actor-email',
        },
        {
          createdAt: new Date().toISOString(),
          details: { email },
          id: 'user_fixture',
          kind: 'actor',
        },
      ],
      revision,
      startedAt: new Date().toISOString(),
      version: 1,
    });
    await assert.rejects(cleanupRun(id), /UAT cleanup failed/);
    const result = readManifest(id);
    assert(
      result.cleanup?.failed.includes(
        'Capture owned storage and worker traces before account purge'
      ),
      JSON.stringify({
        cleanup: result.cleanup,
        nodeEnv: process.env.NODE_ENV,
        paths,
      })
    );
    assert(
      result.cleanup?.failed.some((failure) =>
        failure.startsWith('Clerk deletion deferred')
      )
    );
    assert(!paths.includes('/v1/users/user_fixture'));
    assert(
      readFileSync(path.join(runDirectory(id), 'cleanup.md'), 'utf8').includes(
        'Clerk deletion deferred'
      )
    );
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { force: true, recursive: true });
    rmSync(runDirectory(id), { force: true, recursive: true });
  }
});
