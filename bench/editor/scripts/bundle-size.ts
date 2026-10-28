/**
 * The note editors' share of a production build: per lazy entry, the JS and
 * CSS it loads beyond what the app's main entry already loaded (its own
 * chunks and their static imports), raw and gzipped. BlockSuite's note
 * (`BlockSuiteNote.tsx`) against the Plate note editor (`NoteEditor.tsx`,
 * whose lazy BlockSuite import is not counted), for D8 and the cut's bundle
 * gate (todo-blocksuite-spike.md).
 *
 * Usage, after `pnpm exec vite build --manifest --outDir <dir>`:
 *   tsx bench/editor/scripts/bundle-size.ts <dir>
 * Prints JSON; with PERF_SNAPSHOT_DIR set, also writes `bundle-size.json`.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

interface Chunk {
  css?: string[];
  file: string;
  imports?: string[];
}

const ENTRIES = {
  blocksuiteNote: 'src/features/notes/blocksuite/BlockSuiteNote.tsx',
  plateNote: 'src/features/notes/NoteEditor.tsx',
};

const dir = process.argv[2];
if (!dir) throw new Error('usage: bundle-size.ts <vite build outDir>');
const manifest: Record<string, Chunk> = JSON.parse(
  readFileSync(path.join(dir, '.vite', 'manifest.json'), 'utf8')
);

/** Every file `key` loads statically, itself included. */
function closure(key: string, into = new Set<string>()) {
  const chunk = manifest[key];
  if (!chunk) throw new Error(`${key} is not in the build manifest`);
  if (into.has(chunk.file)) return into;
  into.add(chunk.file);
  for (const css of chunk.css ?? []) into.add(css);
  for (const imported of chunk.imports ?? []) closure(imported, into);
  return into;
}

const main = closure('index.html');

function weigh(files: string[]) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const bytes = readFileSync(path.join(dir, file));
    raw += bytes.byteLength;
    gzip += gzipSync(bytes).byteLength;
  }
  return { files: files.length, gzipKB: Math.round(gzip / 1024), rawKB: Math.round(raw / 1024) };
}

const report = Object.fromEntries(
  Object.entries(ENTRIES).map(([name, key]) => {
    const own = [...closure(key)].filter((file) => !main.has(file));
    return [
      name,
      {
        css: weigh(own.filter((file) => file.endsWith('.css'))),
        js: weigh(own.filter((file) => file.endsWith('.js'))),
      },
    ];
  })
);

const body = JSON.stringify(report, null, 2);
console.log(body);
if (process.env.PERF_SNAPSHOT_DIR) {
  await mkdir(process.env.PERF_SNAPSHOT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PERF_SNAPSHOT_DIR, 'bundle-size.json'), body);
}
