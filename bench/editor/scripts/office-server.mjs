/**
 * pnpm bench:office's web server, the same on Linux and Windows (cmd.exe has
 * no `{ a & b; }`): one build into <outDir>, staged into <stageDir> as the
 * Office Worker stores it (workers/office/stage.mjs: WASM and fonts as
 * brotli-11 `.br`, whose sizes the spec reports), then the Office runtime's
 * preview on <port> + 1 and the app's on <port>, both from <outDir>.
 * Playwright waits for the app's URL and stops the process; both previews
 * run in it. With PERF_OFFICE_TLS_KEY and PERF_OFFICE_TLS_CERT (PEM files)
 * both answer over HTTPS (playwright.office.config.ts).
 *
 * Usage, from the repository root:
 * node office-server.mjs <outDir> <port> <stageDir>
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { preview } from 'vite';

const [outDir, port, stageDir] = process.argv.slice(2);
if (!(outDir && port && stageDir))
  throw new Error('Usage: office-server.mjs <outDir> <port> <stageDir>');
const { PERF_OFFICE_TLS_CERT: cert, PERF_OFFICE_TLS_KEY: key } = process.env;
const https =
  cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

// MSW needs the development mode; the config's NODE_ENV=production keeps
// React and the bundle production. The heap flag is the one `pnpm build` uses.
const build = spawnSync(
  process.execPath,
  [
    '--max-old-space-size=8192',
    'node_modules/vite/bin/vite.js',
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

for (const on of [Number(port) + 1, Number(port)])
  await preview({
    build: { outDir },
    mode: 'development',
    preview: { host: '127.0.0.1', https, port: on, strictPort: true },
  });
