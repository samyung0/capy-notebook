// Prints the wasm build key per module for a BetterOffice tree (no build):
// the same key scripts/wasm.ts writes into target/wasm-pack/<crate>.json, so
// generated wasm copied from another tree at the same pin can be checked
// before `build:*-wasm` reports it up to date.
//   bun wasm-keys.ts <betteroffice root> [stamp dir to compare]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2]!);
const stamps = process.argv[3] ? resolve(process.argv[3]) : join(root, 'target/wasm-pack');
const { sourcesFingerprint } = await import(join(root, 'scripts/wasm.ts'));
const modules: [string, string, string?, string[]?][] = [
  ['ooxml-opc', 'ooxml_opc', undefined, ['--locked', '--features', 'wasm']],
  ['docx-layout', 'docx_layout'],
  ['docx-view-wasm', 'docx_view_wasm', 'viewer-release'],
  ['docx-edit', 'docx_edit', undefined, ['--locked', '--features', 'wasm,tiff']],
  ['docx-parse', 'docx_parse', undefined, ['--locked', '--features', 'wasm,tiff']],
];
// xlsx/pptx module lists come from their own build scripts.
for (const script of ['build-xlsx-wasm.ts', 'build-pptx-wasm.ts']) {
  const text = readFileSync(join(root, 'scripts', script), 'utf8');
  for (const block of text.matchAll(/\{\s*crate:\s*'([^']+)',\s*name:\s*'([^']+)',[^}]*?\}/gs)) {
    const profile = /profile:\s*'([^']+)'/.exec(block[0])?.[1];
    const args = /cargoArgs:\s*\[([^\]]*)\]/.exec(block[0])?.[1];
    modules.push([block[1]!, block[2]!, profile, args ? [...args.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : undefined]);
  }
}
const sources = await sourcesFingerprint();
for (const [crate, name, profile, cargoArgs = []] of modules) {
  const key = createHash('sha256')
    .update(sources)
    .update(`\0${crate}\0${name}\0${profile ?? 'release'}\0${cargoArgs.join(' ')}`)
    .digest('hex');
  let recorded = '';
  try {
    recorded = JSON.parse(readFileSync(join(stamps, `${crate}.json`), 'utf8')).key;
  } catch {}
  console.log(`${crate} ${key === recorded ? 'MATCH' : 'differs'} ${key.slice(0, 12)} ${recorded.slice(0, 12)}`);
}
