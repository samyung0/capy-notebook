// The Rust headless editor keeps links, mentions and inline equations inline
// (Epo, 2026-10-07); the Node server's flattens them until the cutover. For
// the corpus, the oracle's headless editors answer isInline the same way:
//   node inline-oracle.mjs <collaboration/src> patch|restore
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const [src, action] = process.argv.slice(2);
const FILES = ['children.ts', 'commands.ts', 'editCommands.ts'];
const ANCHOR = '  const baseEditor = createEditor();\n';
const INLINE =
  "  baseEditor.isInline = (element) =>\n    ['a', 'mention', 'inline_equation'].includes(\n      (element as { type?: string }).type ?? ''\n    );\n";

for (const name of FILES) {
  const path = join(src, name);
  const kept = `${path}.corpus-orig`;
  if (action === 'restore') {
    if (existsSync(kept)) {
      copyFileSync(kept, path);
      rmSync(kept);
    }
    continue;
  }
  const source = readFileSync(path, 'utf8');
  if (source.split(ANCHOR).length !== 2) {
    throw new Error(`${name}: expected one headless editor`);
  }
  copyFileSync(path, kept);
  writeFileSync(path, source.replace(ANCHOR, ANCHOR + INLINE));
}
