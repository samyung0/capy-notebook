// Composition of stored DOCX states (JSON bytes per component; the rest is
// Yjs structure: item headers, origins, map keys, Any tags).
// Usage: node compose.mjs state.bin...
import { readFile } from 'node:fs/promises';
import { load, weigh } from './weigh.mjs';

for (const path of process.argv.slice(2)) {
  const state = new Uint8Array(await readFile(path));
  const w = weigh(load(state));
  const key = (k) => w.embedKeys[`pilcrow.${k}`] ?? 0;
  const marks = Object.values(w.formatBytes).reduce((a, b) => a + b, 0);
  const imageSrc = w.embedKeys['image.src'] ?? 0;
  const embedAll = Object.values(w.embedKeys).reduce((a, b) => a + b, 0);
  const row = {
    file: path.split(/[\\/]/).pop(),
    state: state.length,
    text: w.text,
    runBoundaries: key('_originalRunBoundaries'),
    defaultTextFormatting: key('defaultTextFormatting'),
    runMarks: marks,
    fontFamilyMarks: w.formatBytes.fontFamily ?? 0,
    imageSrc,
    otherEmbedKeys: embedAll - key('_originalRunBoundaries') - key('defaultTextFormatting') - imageSrc,
  };
  row.structure = row.state - row.text - row.runBoundaries - row.defaultTextFormatting - row.runMarks - row.imageSrc - row.otherEmbedKeys;
  console.log(JSON.stringify(row));
}
