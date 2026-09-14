import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { savedTokenStatus } from './accounts';
import { cleanupRun, validateCleanupTarget } from './cleanup';
import type { UatEnvironment } from './environment';
import {
  type Manifest,
  readManifest,
  runDirectory,
  sanitize,
  writeEvidence,
  writeManifest,
} from './evidence';

test('cleanup requires the original target and exact run-owned registration intent', () => {
  const id = randomUUID();
  const email = `uat-${id.replaceAll('-', '').slice(0, 20)}-owner-12345678+clerk_test@example.test`;
  const manifest: Manifest = {
    appUrl: 'https://uat.capynotebook.com',
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
 if(request.sql.includes('UNION SELECT source_blob_path')) {
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
    UAT_APP_URL: 'https://uat.capynotebook.com',
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
    if (url.pathname === '/v1/users')
      return Response.json({ data: [], total_count: 0 });
    if (url.pathname === '/v1/account')
      return Response.json({ id: 'acct_fixture' });
    if (url.hostname === 'sentry.io') return Response.json({ data: [] });
    if (url.pathname === '/healthz')
      return Response.json(
        { status: 'ok' },
        { headers: { 'X-Capy-Release': revision } }
      );
    if (
      url.hostname === 'uat.capynotebook.com' ||
      url.hostname === 'uat-office.capynotebook.com'
    )
      return new Response(`<meta name="capy-release" content="${revision}">`);
    throw new Error(`Unexpected offline request path ${url.pathname}`);
  };
  try {
    Object.assign(process.env, environment);
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
      )
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
