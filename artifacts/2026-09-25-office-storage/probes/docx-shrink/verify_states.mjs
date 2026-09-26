// Export and baseline the prototype's native seeds with today's headless
// runtime (unchanged TypeScript export path and serializer), against the
// export of today's seed. Usage: node verify_states.mjs file.docx
import { readFile } from 'node:fs/promises';
import { office } from './weigh.mjs';
import { checkpoint, DETERMINISM, baselineBytes } from '../storage/lib.mjs';
import { unzip, compareParts, count } from './zip.mjs';

const perChar = (xml) => {
  const out = [];
  for (const p of xml.split(/<w:p[ >]/).slice(1)) {
    for (const run of p.matchAll(/<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const rpr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run[1])?.[1] ?? '').replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '');
      for (const t of run[1].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)) for (const ch of t[1]) out.push(`${ch}\u0000${rpr}`);
    }
    out.push('\u0001');
  }
  return out;
};

const path = process.argv[2];
const name = path.split(/[\\/]/).pop().replace(/\.docx$/, '');
const bytes = new Uint8Array(await readFile(path));
const determinism = DETERMINISM('job-verify');
const states = {};
for (const mode of ['today', 'boundaries', 'both']) states[mode] = new Uint8Array(await readFile(`states/${name}.${mode}.bin`));
const ref = unzip(await office.exportOffice(bytes, checkpoint('docx', bytes, states.today), determinism));
const refXml = ref.get('word/document.xml').toString();
const refChars = perChar(refXml);
const result = { file: name };
for (const [mode, state] of Object.entries(states)) {
  const row = { state: state.length };
  try {
    const parts = unzip(await office.exportOffice(bytes, checkpoint('docx', bytes, state), determinism));
    const diff = compareParts(ref, parts);
    const xml = parts.get('word/document.xml').toString();
    const chars = perChar(xml);
    let mismatches = 0;
    for (let i = 0; i < Math.max(chars.length, refChars.length); i++) if (chars[i] !== refChars[i]) mismatches++;
    row.export = {
      partsSame: diff.same,
      partsChanged: diff.changed.map((c) => c.name),
      oneSided: [...diff.onlyA, ...diff.onlyB],
      runs: [count(refXml, 'w:r'), count(xml, 'w:r')],
      rPrChange: [count(refXml, 'w:rPrChange'), count(xml, 'w:rPrChange')],
      drawings: [count(refXml, 'w:drawing'), count(xml, 'w:drawing')],
      charFormatMismatches: mismatches,
    };
  } catch (error) {
    row.export = { error: String(error.message ?? error) };
  }
  try {
    row.baseline = baselineBytes(await office.officeBaseline(bytes, checkpoint('docx', bytes, state)), 'docx');
  } catch (error) {
    row.baseline = { error: String(error.message ?? error) };
  }
  result[mode] = row;
}
console.log(JSON.stringify(result));
