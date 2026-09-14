import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvironment, type UatEnvironment } from './environment';
import { runDirectory, verify, writeManifest } from './evidence';
import { readSentryEvents, verifyStripeSandbox } from './providers';

export async function verifyClerkInstance(env: UatEnvironment) {
  const response = await fetch('https://api.clerk.com/v1/domains', {
    headers: { Authorization: `Bearer ${env.clerkSecretKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Clerk instance verification failed (${response.status})`);
  const result = (await response.json()) as {
    data?: Array<{
      name: string;
      is_satellite: boolean;
      frontend_api_url: string;
    }>;
  };
  const primary = result.data?.filter(
    (domain) => domain.is_satellite === false
  );
  if (
    primary?.length !== 1 ||
    primary[0].name !== 'uat.capynotebook.com' ||
    primary[0].frontend_api_url !== 'https://clerk.uat.capynotebook.com'
  ) {
    throw new Error('Clerk key does not identify the isolated UAT instance');
  }
  const encoded = env.clerkPublishableKey.replace(/^pk_(test|live)_/, '');
  if (
    Buffer.from(encoded, 'base64').toString() !== 'clerk.uat.capynotebook.com$'
  ) {
    throw new Error(
      'Clerk publishable and secret keys do not select the UAT frontend'
    );
  }
}

export async function verifyRelease(env: UatEnvironment) {
  const [app, office, api, collaboration] = await Promise.all([
    fetch(`${env.appUrl}/?uat_release=${env.expectedRevision}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }),
    fetch(
      `https://uat-office.capynotebook.com/office-runtime.html?uat_release=${env.expectedRevision}`,
      { redirect: 'error', signal: AbortSignal.timeout(30_000) }
    ),
    fetch(`${env.apiUrl}/healthz`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }),
    fetch(`${env.collabUrl.replace('wss:', 'https:')}/healthz`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }),
  ]);
  if (!app.ok || !office.ok || !api.ok || !collaboration.ok)
    throw new Error(
      'UAT application, Office, gateway and collaboration must all be healthy'
    );
  for (const response of [app, office]) {
    const meta =
      (await response.text()).match(
        /<meta\b[^>]*\bname=["']capy-release["'][^>]*>/
      )?.[0] ?? '';
    if (
      meta.match(/\bcontent=["']([a-f0-9]{40})["']/)?.[1] !==
      env.expectedRevision
    )
      throw new Error(
        'UAT application or Office revision differs from EXPECTED_REVISION'
      );
  }
  if (
    [api, collaboration].some(
      (response) =>
        response.headers.get('x-capy-release') !== env.expectedRevision
    )
  )
    throw new Error(
      'UAT gateway or collaboration revision differs from EXPECTED_REVISION'
    );
}

export async function verifyDatabase(env: UatEnvironment) {
  const roles = await verify<
    Array<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      writes: boolean;
    }>
  >({
    operation: 'query',
    sql: "SELECT rolsuper,rolcreaterole,rolcreatedb,has_table_privilege(current_user,'users','INSERT,UPDATE,DELETE') AS writes FROM pg_roles WHERE rolname=current_user",
  });
  if (roles.length !== 1 || Object.values(roles[0]).some(Boolean))
    throw new Error('UAT database verifier must have read-only privileges');
  const migrations = await verify<Array<{ filename: string }>>({
    operation: 'query',
    sql: 'SELECT filename FROM schema_migrations',
  });
  if (
    !migrations.some(
      (row) => row.filename === '0016_native_office_citations.sql'
    )
  )
    throw new Error('UAT native Office migration 0016 is required');
  const columns = await verify<Array<{ column_name: string }>>({
    operation: 'query',
    sql: "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='files' AND column_name='preview_blob_path'",
  });
  if (columns.length)
    throw new Error('UAT database still has the retired Office preview schema');
  return {
    database: env.databaseName,
    migrations: migrations.map((row) => row.filename),
  };
}

export default async function preflight() {
  const env = loadEnvironment();
  const id = process.env.UAT_RUN_ID;
  if (!id) throw new Error('UAT_RUN_ID must be set by the journey config');
  if (existsSync(path.join(runDirectory(id), 'manifest.json')))
    throw new Error(
      'UAT_RUN_ID already has a manifest; clean it up and use a new run ID'
    );
  writeManifest({
    appUrl: env.appUrl,
    bucket: env.b2Bucket,
    id,
    resources: [],
    revision: env.expectedRevision,
    startedAt: new Date().toISOString(),
    version: 1,
  });
  await verifyClerkInstance(env);
  const checks = await Promise.allSettled([
    verifyRelease(env),
    verifyDatabase(env),
    verify<unknown>({ operation: 'storage-identity' }),
    verifyStripeSandbox(env),
    readSentryEvents(env, {
      actorIds: [],
      start: new Date(Date.now() - 60_000).toISOString(),
      traceIds: ['0'.repeat(32)],
    }),
  ]);
  const failures = checks.flatMap((check) =>
    check.status === 'rejected'
      ? [
          check.reason instanceof Error
            ? check.reason.message
            : 'UAT preflight failed',
        ]
      : []
  );
  if (failures.length) throw new Error(failures.join('\n'));
  // The required fixture index is checked before any signup or provider mutation.
  const basic = path.resolve('e2e/fixtures/files/basic');
  for (const name of [
    'lesson.docx',
    'grades.xlsx',
    'lesson.pptx',
    'notes.txt',
    'digital.pdf',
    'delimiter-limit.csv',
  ]) {
    if (!readFileSync(path.join(basic, name)).length)
      throw new Error(`Required UAT fixture is empty: ${name}`);
  }
}
