// Type-checks the drawing board (tsconfig.board.json). The board imports
// vendored BlockSuite as .ts sources, so tsc checks them too, and upstream's
// sources have errors in this setup (deps their package.json doesn't declare,
// tag-map augmentations in files nothing imports). Errors under
// vendor/blocksuite/ are counted and ignored; any other error, or a tsc
// failure, fails.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json')
  ),
  'bin/tsc'
);
const run = spawnSync(
  process.execPath,
  [tsc, '-p', 'tsconfig.board.json', '--noEmit', '--pretty', 'false'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);
if (run.error) {
  throw run.error;
}

// One diagnostic per unindented line; indented lines continue the one above.
const diagnostics = [];
for (const line of run.stdout.split('\n')) {
  if (/^\s/.test(line) && diagnostics.length > 0) {
    diagnostics[diagnostics.length - 1] += `\n${line}`;
  } else if (line.trim()) {
    diagnostics.push(line);
  }
}
const ours = diagnostics.filter((d) => !d.startsWith('vendor/blocksuite/'));
const vendored = diagnostics.length - ours.length;

if (ours.length > 0) {
  process.stdout.write(`${ours.join('\n')}\n`);
}
if (run.stderr) {
  process.stderr.write(run.stderr);
}
process.stdout.write(
  `typecheck:board: ${ours.length} error(s), ${vendored} in vendor/blocksuite/ ignored\n`
);
// tsc exits non-zero on any error, so a failure with nothing parsed (a crash,
// a bad config printed elsewhere) fails too.
const failed =
  ours.length > 0 ||
  run.signal ||
  (run.status !== 0 && diagnostics.length === 0);
process.exit(failed ? 1 : 0);
