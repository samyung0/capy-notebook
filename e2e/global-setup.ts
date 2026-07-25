import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(root, 'deploy', 'docker-compose.e2e.yml');
const seedFile = path.join(root, 'e2e', 'fixtures', 'seed.sql');
const apiUrl = process.env.E2E_API_URL!;
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

async function waitForHealth(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${apiUrl}/healthz`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`API at ${apiUrl} did not become healthy`);
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
    ['test', './internal/store', './internal/httpapi', '-count=1'],
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

export default async function globalSetup() {
  if (process.env.E2E_SKIP_COMPOSE === 'true') {
    await waitForHealth();
    applySeed();
    runBackendAccessTests();
    return;
  }

  console.log('[e2e] starting docker compose…');
  compose(['up', '--build', '-d']);
  await waitForHealth();
  console.log('[e2e] applying seed…');
  applySeed();
  console.log('[e2e] running backend access tests…');
  runBackendAccessTests();
  console.log('[e2e] ready');
}
