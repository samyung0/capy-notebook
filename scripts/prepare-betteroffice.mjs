import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officeRoot = path.join(root, 'vendor', 'betteroffice');
const engines = ['build:docx-wasm', 'build:xlsx-wasm', 'build:pptx-wasm'];

if (!existsSync(path.join(officeRoot, 'package.json'))) {
  console.error(
    'BetterOffice is not checked out. Run `git submodule update --init vendor/betteroffice`.'
  );
  process.exit(1);
}

// The fork builder fingerprints sources and generated output. Checking only
// whether a JS file exists would keep stale WASM after a submodule update.
run('bun', ['install', '--frozen-lockfile']);
run('bun', ['run', '--filter', '@betteroffice/docx-react', 'build:css']);
for (const engine of engines) run('bun', ['run', engine]);
run('bun', ['scripts/build-office-checkpoint.ts']);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: officeRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`${command} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
