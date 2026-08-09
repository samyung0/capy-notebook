import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(root, 'deploy', 'docker-compose.e2e.yml');
const seedFile = path.join(root, 'e2e', 'fixtures', 'seed.sql');
const apiUrl = process.env.E2E_API_URL!;
const collaborationUrl = `http://127.0.0.1:${process.env.E2E_COLLABORATION_PORT}`;
const secret = process.env.E2E_AUTH_SECRET!;
const composeProject = process.env.E2E_COMPOSE_PROJECT!;

function compose(args: string[]) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', composeFile, '-p', composeProject, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, E2E_AUTH_SECRET: secret },
      shell: process.platform === 'win32',
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function waitForHealth(url = apiUrl, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`service at ${url} did not become healthy`);
}

function applySeed() {
  const sql = readFileSync(seedFile, 'utf8');
  // Pipe SQL into psql inside the db container.
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composeFile,
      '-p',
      composeProject,
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'evo',
      '-d',
      'evo',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, E2E_AUTH_SECRET: secret },
      input: sql,
      shell: process.platform === 'win32',
    }
  );
  if (result.status !== 0) {
    throw new Error(`seed failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function runBackendAccessTests() {
  const result = spawnSync(
    'go',
    // -p 1 because both packages reapply the migration on start-up, and
    // concurrent DDL on one database deadlocks.
    ['test', '-p', '1', './internal/store', './internal/httpapi', '-count=1'],
    {
      cwd: path.join(root, 'server'),
      encoding: 'utf8',
      env: {
        ...process.env,
        REQUIRE_INTEGRATION_DB: 'true',
        TEST_DATABASE_URL: `postgres://evo:evo@127.0.0.1:${process.env.E2E_DB_PORT}/evo?sslmode=disable`,
      },
      shell: process.platform === 'win32',
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `backend access tests failed:\n${result.stdout}\n${result.stderr}`
    );
  }
}

function shutDownCompose() {
  if (process.env.E2E_KEEP_STACK === 'true') return;
  console.error('[e2e] shutting down docker compose…');
  try {
    compose(['down', '-v', '--remove-orphans']);
  } catch (cleanupErr) {
    console.error('[e2e] cleanup failed:', cleanupErr);
  }
}

export default async function globalSetup() {
  if (process.env.E2E_SKIP_COMPOSE === 'true') {
    await Promise.all([waitForHealth(), waitForHealth(collaborationUrl)]);
    applySeed();
    runBackendAccessTests();
    return;
  }

  console.log('[e2e] starting docker compose…');
  try {
    compose(['up', '--build', '-d']);
    await Promise.all([waitForHealth(), waitForHealth(collaborationUrl)]);
    console.log('[e2e] applying seed…');
    applySeed();
    console.log('[e2e] running backend access tests…');
    runBackendAccessTests();
    console.log('[e2e] ready');
  } catch (err) {
    // Playwright skips globalTeardown when setup throws, so tear down here.
    shutDownCompose();
    throw err;
  }
}
