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

// Windows briefly locks freshly written folders (virus scanning), failing a
// rename with EPERM/EACCES/EBUSY; retry for up to 5s as graceful-fs does.
function rename(from: string, to: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      const locked = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!locked || Date.now() > deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
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
  // Runs the CLI script with this node: on Windows .bin/paraglide-js is a
  // .CMD shim that execFileSync cannot start.
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/@inlang/paraglide-js/bin/run.js'),
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
    rename(outdir, previous);
  } catch (error) {
    // First compile: nothing to move aside.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  rename(temporary, outdir);
  rmSync(previous, { force: true, recursive: true });
}
