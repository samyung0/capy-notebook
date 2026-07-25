import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(root, 'deploy', 'docker-compose.e2e.yml');
const composeProject = process.env.E2E_COMPOSE_PROJECT!;

export default async function globalTeardown() {
  if (
    process.env.E2E_SKIP_COMPOSE === 'true' ||
    process.env.E2E_KEEP_STACK === 'true'
  ) {
    return;
  }
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composeFile,
      '-p',
      composeProject,
      'down',
      '-v',
      '--remove-orphans',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }
  );
  if (result.status !== 0) {
    throw new Error(`E2E cleanup failed:\n${result.stdout}\n${result.stderr}`);
  }
}
