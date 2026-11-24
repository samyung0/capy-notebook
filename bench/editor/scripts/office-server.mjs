/**
 * pnpm bench:office's web server, the same on Linux and Windows (cmd.exe has
 * no `{ a & b; }`): the generated long DOCX and its room state (below), one
 * build into <outDir>, staged into <stageDir> as the
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { preview } from 'vite';

const [outDir, port, stageDir] = process.argv.slice(2);
if (!(outDir && port && stageDir))
  throw new Error('Usage: office-server.mjs <outDir> <port> <stageDir>');
const { PERF_OFFICE_TLS_CERT: cert, PERF_OFFICE_TLS_KEY: key } = process.env;
const https =
  cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

// The ~250-page DOCX (Q832 A: gen_long_docx.py at 96 sections, the Google gap
// round's long file) and its room state, seeded with the pinned engines
// as scripts/dev/seed-scenario-office.ts seeds the committed fixtures. The
// build picks both up from here (src/mocks/officeFixtures.ts). The generator
// needs Python 3.12 or later, which Windows names `python`.
const fixtures = 'bench/editor/.results/office-fixtures';
const longDocx = `${fixtures}/long-handbook-250.docx`;
mkdirSync(fixtures, { recursive: true });
const generate = spawnSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    'bench/editor/scripts/gen_long_docx.py',
    'e2e/fixtures/files/rich-content/exchange-plan.docx',
    longDocx,
    '96',
    'text',
  ],
  { stdio: 'inherit' }
);
if (generate.status !== 0) process.exit(generate.status ?? 1);
// office:prepare builds this Node bundle of the fork's engines.
const { seedOffice } = await import(
  pathToFileURL('vendor/betteroffice/shared/office-checkpoint.mjs').href
);
const seeded = await seedOffice('docx', new Uint8Array(readFileSync(longDocx)));
writeFileSync(`${fixtures}/long-handbook-250-checkpoint.bin`, seeded.state);

// Vite's production mode with the benches' switch VITE_BENCH_MSW, which the
// config's environment sets. The heap flag is the one `pnpm build` uses.
const build = spawnSync(
  process.execPath,
  [
    '--max-old-space-size=8192',
    'node_modules/vite/bin/vite.js',
    'build',
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
    preview: { host: '127.0.0.1', https, port: on, strictPort: true },
  });
