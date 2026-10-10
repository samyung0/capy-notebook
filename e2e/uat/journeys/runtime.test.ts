import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { savedTokenStatus } from './accounts';
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
import { refresh, savedExport } from './office';
import { REFUSAL_PREFIX, republication } from './officeRefusal';
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
  row.state = null;
  row.base_source_sha256 = hash;
  assert.deepEqual((await savedExport(run, 'file_fixture')).bytes, bytes);
  row.base_source_sha256 = '0'.repeat(64);
  await assert.rejects(savedExport(run, 'file_fixture'), assert.AssertionError);
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
  const email = 'uat-owned+clerk_test@example.test';
  const manifest: Manifest = {
    appUrl: 'https://app.uat.capynotebook.com',
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

test('cleanup requires the original target and exact run-owned registration intent', () => {
  const id = randomUUID();
  const email = `uat-${id.replaceAll('-', '').slice(0, 20)}-owner-12345678+clerk_test@example.test`;
  const manifest: Manifest = {
    appUrl: 'https://app.uat.capynotebook.com',
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
        assert.equal(
          error.message,
          'Saved-token authorization probe failed; browser/provider details are omitted to keep credentials out of artifacts'
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
  const email = `uat-${id.replaceAll('-', '').slice(0, 20)}-owner-12345678+clerk_test@example.test`;
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
    UAT_APP_URL: 'https://app.uat.capynotebook.com',
    UAT_CLERK_TEST_MODE: 'true',
    UAT_COLLAB_URL: 'wss://uat-collab.capynotebook.com',
    UAT_DATABASE_NAME: 'capy',
    UAT_DATABASE_URL: 'postgres://capy_uat_verifier:fixture@127.0.0.1/capy',
    UAT_RESEND_FROM: 'fixture@example.test',
    UAT_RESEND_READ_KEY: 'fixture',
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
      url.hostname === 'app.uat.capynotebook.com' ||
      url.hostname === 'uat-office.capynotebook.com'
    )
      return new Response(`<meta name="capy-release" content="${revision}">`);
    throw new Error(`Unexpected offline request path ${url.pathname}`);
  };
  try {
    Object.assign(process.env, environment);
    assert.equal(loadEnvironment().appUrl, 'https://app.uat.capynotebook.com');
    for (const appUrl of [
      'https://uat.capynotebook.com',
      'https://app.capynotebook.com',
      'https://app.uat.capynotebook.com/another-path',
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
