import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officeRoot = path.join(root, 'vendor', 'betteroffice');
const engines = [
  {
    build: 'build:docx-wasm',
    files: [
      'packages/docx/src/wasm/generated/edit/docx_edit.js',
      'packages/docx/src/wasm/generated/viewer/docx_view_wasm.js',
    ],
  },
  {
    build: 'build:xlsx-wasm',
    files: [
      'packages/xlsx/src/wasm/generated/xlsx_wasm.js',
      'packages/xlsx/src/wasm/generated/viewer/xlsx_view_wasm.js',
    ],
  },
  {
    build: 'build:pptx-wasm',
    files: [
      'packages/pptx/src/wasm/generated/pptx_wasm.js',
      'packages/pptx/src/wasm/generated/viewer/pptx_view_wasm.js',
    ],
  },
];

if (!existsSync(path.join(officeRoot, 'package.json'))) {
  console.error(
    'BetterOffice is not checked out. Run `git submodule update --init vendor/betteroffice`.'
  );
  process.exit(1);
}

const missing = engines.filter(({ files }) =>
  files.some((file) => !existsSync(path.join(officeRoot, file)))
);
if (missing.length === 0) process.exit(0);

run('bun', ['install', '--frozen-lockfile']);
for (const engine of missing) run('bun', ['run', engine.build]);

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
