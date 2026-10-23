import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the late merge of the in-place GC (collaboration-rs/crates/late-merge)
// to WASM for the worker in src/features/collaboration/lateMerge, on the
// server's own yrs (the pinned fork's patched copy). Its glue and .wasm are
// gitignored. A fingerprint of every input skips the build when nothing
// changed, as the fork's scripts/wasm.ts does for the Office WASM; CI keeps
// the output in the same cache (.github/actions/cache-betteroffice).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.join(root, 'collaboration-rs', 'crates', 'late-merge');
const out = path.join(root, 'collaboration-rs', 'target', 'late-merge-wasm');
const dest = path.join(
  root,
  'src',
  'features',
  'collaboration',
  'lateMerge',
  'generated'
);
const stampPath = path.join(out, 'stamp.json');
const FILES = [
  'late_merge.js',
  'late_merge.d.ts',
  'late_merge_bg.wasm',
  'late_merge_bg.wasm.d.ts',
];
// What the emitted WASM depends on, besides the toolchain.
const INPUTS = [
  'collaboration-rs/Cargo.toml',
  'collaboration-rs/Cargo.lock',
  'collaboration-rs/crates/late-merge/Cargo.toml',
  'collaboration-rs/crates/late-merge/src',
  'vendor/betteroffice/third_party/yrs/Cargo.toml',
  'vendor/betteroffice/third_party/yrs/src',
  'scripts/build-late-merge.mjs',
];
const CODEGEN_ENV = [
  'RUSTFLAGS',
  'CARGO_ENCODED_RUSTFLAGS',
  'CARGO_BUILD_RUSTFLAGS',
  'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS',
];

function version(tool) {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(`${tool} is required to build the late merge's WASM`);
  return result.stdout.trim();
}

async function hashPath(hash, relative) {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(
    () => null
  );
  if (!entries) {
    hash.update(`${relative}\0`);
    hash.update(await readFile(absolute));
    return;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries)
    await hashPath(hash, path.posix.join(relative, entry.name));
}

async function fingerprint() {
  const hash = createHash('sha256');
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (rustc.status !== 0) throw new Error('rustc -vV failed');
  hash.update(rustc.stdout);
  hash.update(`${version('wasm-pack')}\0${version('wasm-opt')}\0`);
  const profileEnv = Object.keys(process.env)
    .filter((name) => name.startsWith('CARGO_PROFILE_'))
    .sort();
  for (const name of [...CODEGEN_ENV, ...profileEnv])
    hash.update(`${name}=${process.env[name] ?? ''}\0`);
  for (const input of INPUTS) await hashPath(hash, input);
  return hash.digest('hex');
}

async function digests(dir) {
  const hashes = {};
  for (const file of FILES) {
    const bytes = await readFile(path.join(dir, file)).catch(() => null);
    hashes[file] = bytes && createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}

const same = (left, right) =>
  !!left &&
  FILES.every((file) => left[file] !== null && left[file] === right[file]);

const key = await fingerprint();
const stamp = await readFile(stampPath, 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
const current = stamp?.key === key;
if (current && same(stamp.vendored, await digests(dest))) {
  process.stdout.write('[late-merge] up to date\n');
  process.exit(0);
}
if (current && same(stamp.source, await digests(out))) {
  process.stdout.write('[late-merge] vendoring the cached build\n');
} else {
  // A release profile without unwinding (WASM has none) or debug info:
  // `late-merge-wasm` in collaboration-rs/Cargo.toml. `--locked` rides with
  // the cargo pass-through.
  const build = spawnSync(
    'wasm-pack',
    [
      'build',
      crate,
      '--profile',
      'late-merge-wasm',
      '--target',
      'web',
      '--out-dir',
      out,
      '--out-name',
      'late_merge',
      '--locked',
    ],
    { stdio: 'inherit' }
  );
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
await mkdir(dest, { recursive: true });
for (const file of FILES)
  await copyFile(path.join(out, file), path.join(dest, file));
await writeFile(
  stampPath,
  JSON.stringify({
    key,
    source: await digests(out),
    vendored: await digests(dest),
  })
);
process.stdout.write('[late-merge] built\n');
