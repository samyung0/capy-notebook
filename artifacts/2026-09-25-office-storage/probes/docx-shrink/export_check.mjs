// Does the current engine export the same package when the stored state
// (a) has no _originalRunBoundaries, (b) references source images by part
// path instead of carrying data URLs? Runs the real headless export on
// JS-rebuilt states and compares every part with the export of the engine's
// own seed. Usage: node export_check.mjs file.docx
import { readFile, writeFile } from 'node:fs/promises';
import { office, load, rebuild } from './weigh.mjs';
import { checkpoint, DETERMINISM, sha } from '../storage/lib.mjs';
import { unzip, compareParts, count } from './zip.mjs';

const path = process.argv[2];
const name = path.split(/[\\/]/).pop();
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice('docx', bytes);
const doc = load(seed.state);
const source = unzip(bytes);
const byBase64 = new Map();
for (const [part, data] of source) if (part.startsWith('word/media/')) byBase64.set(data.toString('base64'), part);

const variants = {
  control: rebuild(doc),
  noBoundaries: rebuild(doc, (op) => {
    if (op.embed && op.insert._kind === 'pilcrow') delete op.insert._originalRunBoundaries;
    return op;
  }),
  neededBoundaries: rebuild(doc, (op) => {
    if (op.embed && op.insert._kind === 'pilcrow' && op.insert._originalRunBoundaries) {
      const b = op.insert._originalRunBoundaries;
      const needs = (r) => (r.propertyChanges?.length ?? 0) > 0 || (r.noteMarks?.length ?? 0) > 0 || r.text === '' || (r.breaks?.length ?? 0) > 0;
      if (!b.some(needs)) delete op.insert._originalRunBoundaries;
      else op.insert._originalRunBoundaries = b.map(({ formatting, ...rest }) => (rest.text === '' ? { ...rest, formatting } : rest));
    }
    return op;
  }),
  imageRef: rebuild(doc, (op) => {
    if (op.embed && op.insert._kind === 'image' && typeof op.insert.src === 'string') {
      const b64 = op.insert.src.slice(op.insert.src.indexOf(',') + 1);
      const part = byBase64.get(b64);
      if (!part) throw new Error('image bytes not found in the package');
      op.insert.src = `media:${part}`;
    }
    return op;
  }),
};

const determinism = DETERMINISM('job-export-check');
const exportOf = (state) => office.exportOffice(bytes, checkpoint('docx', bytes, state), determinism);
const reference = unzip(await exportOf(seed.state));
const summary = { file: name, stateBytes: { engineSeed: seed.state.length } };
for (const [variant, state] of Object.entries(variants)) {
  summary.stateBytes[variant] = state.length;
  let exported;
  try {
    exported = await exportOf(state);
  } catch (error) {
    summary[variant] = { error: String(error.message ?? error) };
    continue;
  }
  const parts = unzip(exported);
  const diff = compareParts(reference, parts);
  const xmlA = reference.get('word/document.xml').toString();
  const xmlB = parts.get('word/document.xml').toString();
  summary[variant] = {
    exportBytes: exported.length,
    ...diff,
    documentXml: {
      runsA: count(xmlA, 'w:r'), runsB: count(xmlB, 'w:r'),
      rPrChangeA: count(xmlA, 'w:rPrChange'), rPrChangeB: count(xmlB, 'w:rPrChange'),
      textA: [...xmlA.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''),
      bytesA: xmlA.length, bytesB: xmlB.length,
    },
  };
  const textB = [...xmlB.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  summary[variant].documentXml.sameText = summary[variant].documentXml.textA === textB;
  delete summary[variant].documentXml.textA;
  if (diff.changed.length) await writeFile(`out-${name}.${variant}.document.xml`, xmlB);
}
await writeFile(`out-${name}.reference.document.xml`, reference.get('word/document.xml'));
console.log(JSON.stringify(summary, null, 1));
