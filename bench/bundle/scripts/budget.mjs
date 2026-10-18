// The SPA bundle budget (Epo 2026-10-18): byte limits and never-in rules for
// a production client build, all read from bench/bundle/budget.json.
//
//   node bench/bundle/scripts/budget.mjs [dist]      (pnpm bench:bundle)
//
// Runs after `pnpm run build` (CI's frontend_check). It reads
// dist/.vite/manifest.json (each chunk's static imports and stylesheets) and
// dist/.vite/chunk-modules.json (each chunk's modules, vite.config.ts), sizes
// every file as brotli at quality 11, prints a table (also appended to
// $GITHUB_STEP_SUMMARY when set) and exits 1 when any check fails.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const ROUTE = /^src\/routes\/(\w+)\.tsx$/;
const root = path.resolve(import.meta.dirname, '../../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const budget = read(path.join(import.meta.dirname, '../budget.json'));
const manifest = read(path.join(dist, '.vite/manifest.json'));
const modules = read(path.join(dist, '.vite/chunk-modules.json'));

const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));
const sizes = new Map();
/** A built file's bytes, raw and as brotli 11. */
function size(file) {
  let found = sizes.get(file);
  if (!found) {
    const body = readFileSync(path.join(dist, file));
    found = {
      br: brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }).length,
      raw: body.length,
    };
    sizes.set(file, found);
  }
  return found;
}
const kb = (files) =>
  [...files].reduce((total, file) => total + size(file).br, 0) / 1024;

/** A chunk and the chunks it imports statically, transitively: what loads
 * with it (index.html's modulepreloads, Vite's preloads for a lazy route). */
function closure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const key of byFile.get(file)?.imports ?? [])
    closure(manifest[key].file, seen);
  return seen;
}
/** The chunk holding `module` (a path from the repository root). */
function holding(module) {
  const file = Object.keys(modules).find((chunk) =>
    modules[chunk].includes(module)
  );
  if (!file) throw new Error(`No chunk holds ${module}.`);
  return file;
}

const entry = closure(manifest['index.html'].file);
/** What `target` loads beyond the entry: index.html itself, or the chunk
 * holding a module and its static imports. */
const beyondEntry = (target) =>
  target === 'index.html'
    ? entry
    : new Set([...closure(holding(target))].filter((file) => !entry.has(file)));

const rows = [];
const check = (name, measured, limit, unit = 'KB') =>
  rows.push([
    name,
    unit ? `${measured.toFixed(1)} ${unit}` : String(measured),
    unit ? `${limit} ${unit}` : String(limit),
    measured <= limit ? 'ok' : 'OVER',
  ]);

check('entry JS', kb(entry), budget.entryJsKB);
check('entry JS files', entry.size, budget.entryJsFiles, '');
check(
  'entry CSS',
  kb(new Set([...entry].flatMap((file) => byFile.get(file).css ?? []))),
  budget.entryCssKB
);
check(
  'Office runtime JS',
  kb(closure(manifest['office-runtime.html'].file)),
  budget.officeRuntimeJsKB
);
const routes = [
  ...new Set(
    Object.values(modules)
      .flat()
      .filter((module) => ROUTE.test(module))
  ),
].sort();
for (const route of routes) {
  const name = ROUTE.exec(route)[1];
  check(
    `route ${name} beyond the entry`,
    kb(beyondEntry(route)),
    budget.routeJsKB[name] ?? budget.routeJsKB.default
  );
}
const chunks = Object.keys(modules);
check(
  'chunks under 1 KB',
  chunks.filter((file) => size(file).raw < 1024).length,
  budget.chunksUnder1KB,
  ''
);
check(
  'largest chunk',
  Math.max(...chunks.map((file) => size(file).br)) / 1024,
  budget.largestChunkKB
);
for (const [target, banned] of Object.entries(budget.never)) {
  const held = [...beyondEntry(target)].flatMap((file) => modules[file] ?? []);
  const found = banned.filter((prefix) =>
    held.some((module) => module.startsWith(prefix))
  );
  rows.push([
    `never in ${target}`,
    found.length ? found.join(', ') : 'none',
    banned.join(', '),
    found.length ? 'OVER' : 'ok',
  ]);
}

const table = [
  '| check | measured (brotli 11) | limit | result |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### SPA bundle budget\n\n${table}\n\nLimits: bench/bundle/budget.json.\n`
  );
const over = rows.filter((row) => row[3] === 'OVER');
if (over.length) {
  console.error(
    `Over budget: ${over.map((row) => row[0]).join('; ')}. Shrink the bundle, or move the limit in bench/bundle/budget.json in the same change.`
  );
  process.exit(1);
}
