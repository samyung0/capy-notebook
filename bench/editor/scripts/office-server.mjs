/**
 * pnpm bench:office's web server, the same on Linux and Windows (cmd.exe has
 * no `{ a & b; }`): one build into <outDir>, then the Office runtime's preview
 * on <port> + 1 and the app's on <port>. Playwright waits for the app's URL
 * and stops the whole process tree; either preview ending ends the other.
 *
 * Usage, from the repository root: node office-server.mjs <outDir> <port>
 */
import { spawn, spawnSync } from 'node:child_process';

const [outDir, port] = process.argv.slice(2);
if (!(outDir && port)) throw new Error('Usage: office-server.mjs <outDir> <port>');
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
