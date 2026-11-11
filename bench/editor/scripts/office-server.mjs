/**
 * pnpm bench:office's web server, the same on Linux and Windows (cmd.exe has
 * no `{ a & b; }`): one build into <outDir>, staged into <stageDir> as the
 * Office Worker stores it (workers/office/stage.mjs: WASM and fonts as
 * brotli-11 `.br`, whose sizes the spec reports), then the Office runtime's
 * preview on <port> + 1 and the app's on <port>, both from <outDir>.
 * Playwright waits for the app's URL and stops the whole process tree; either
 * preview ending ends the other.
 *
 * Usage, from the repository root:
 * node office-server.mjs <outDir> <port> <stageDir>
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const [outDir, port, stageDir] = process.argv.slice(2);
if (!(outDir && port && stageDir))
  throw new Error('Usage: office-server.mjs <outDir> <port> <stageDir>');
const vite = 'node_modules/vite/bin/vite.js';

// MSW needs the development mode; the config's NODE_ENV=production keeps
// React and the bundle production. The heap flag is the one `pnpm build` uses.
const build = spawnSync(
  process.execPath,
  [
    '--max-old-space-size=8192',
    vite,
    'build',
    '--mode',
    'development',
    '--outDir',
    outDir,
    '--emptyOutDir',
  ],
  { stdio: 'inherit' }
);
if (build.status !== 0) process.exit(build.status ?? 1);
// stage.mjs takes a new directory only.
rmSync(stageDir, { force: true, recursive: true });
const stage = spawnSync(
  process.execPath,
  ['workers/office/stage.mjs', outDir, stageDir],
  { stdio: 'inherit' }
);
if (stage.status !== 0) process.exit(stage.status ?? 1);

const preview = (on) =>
  spawn(
    process.execPath,
    [
      vite,
      'preview',
      '--mode',
      'development',
      '--outDir',
      outDir,
      '--host',
      '127.0.0.1',
      '--port',
      String(on),
      '--strictPort',
    ],
    { stdio: 'inherit' }
  );
const servers = [preview(Number(port) + 1), preview(Number(port))];
for (const server of servers)
  server.on('exit', (code) => {
    for (const other of servers) other.kill();
    process.exit(code ?? 1);
  });
