// Compiles messages/ into e2e/.paraglide for specs to import as `m`
// (e2e/i18n/index.ts). Every Playwright config imports this so the runner
// compiles before it loads any spec; workers reuse the output. Runs that start
// while another is importing must not delete its files, so the output is
// rebuilt only when messages/ changed, in a temporary folder swapped in whole.
import { execFileSync } from 'node:child_process';
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const outdir = path.join(root, 'e2e/.paraglide');

function mtime(file: string) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function stale() {
  const sources = [
    path.join(root, 'project.inlang/settings.json'),
    ...readdirSync(path.join(root, 'messages')).map((name) =>
      path.join(root, 'messages', name)
    ),
  ];
  return (
    mtime(path.join(outdir, 'messages.js')) < Math.max(...sources.map(mtime))
  );
}

if (process.env.TEST_WORKER_INDEX === undefined && stale()) {
  const temporary = `${outdir}-${process.pid}`;
  execFileSync(
    path.join(root, 'node_modules/.bin/paraglide-js'),
    [
      'compile',
      '--project',
      path.join(root, 'project.inlang'),
      '--outdir',
      temporary,
      '--emit-ts-declarations',
      '--silent',
    ],
    { cwd: root, stdio: 'inherit' }
  );
  const previous = `${temporary}-old`;
  rmSync(previous, { force: true, recursive: true });
  try {
    renameSync(outdir, previous);
  } catch {
    // First compile: nothing to move aside.
  }
  renameSync(temporary, outdir);
  rmSync(previous, { force: true, recursive: true });
}
