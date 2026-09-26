// Side check: does an edit to a paragraph's indent/spacing reach the export
// when the paragraph carries _originalFormatting (direct pPr in the source)?
// Sets indentLeft and spaceAfter on the first pilcrow of each kind directly
// in the stored state, exports with today's runtime and inspects w:ind/w:spacing.
import { readFile } from 'node:fs/promises';
import { office, Y, load } from './weigh.mjs';
import { checkpoint, DETERMINISM } from '../storage/lib.mjs';
import { unzip } from './zip.mjs';

const path = process.argv[2];
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice('docx', bytes);
const doc = load(seed.state);
const body = doc.getMap('stories').get('body');
const found = { withOriginal: null, withoutOriginal: null };
for (const op of body.toDelta()) {
  if (typeof op.insert === 'string' || !(op.insert instanceof Y.Map)) continue;
  const map = op.insert;
  if (map.get('_kind') !== 'pilcrow') continue;
  const key = map.has('_originalFormatting') ? 'withOriginal' : 'withoutOriginal';
  if (!found[key]) found[key] = map;
}
const results = {};
for (const [kind, map] of Object.entries(found)) {
  if (!map) continue;
  const paraId = map.get('paraId');
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    map.set('indentLeft', 1234);
    map.set('spaceAfter', 777);
  });
  const state = Y.encodeStateAsUpdate(doc);
  const xml = unzip(await office.exportOffice(bytes, checkpoint('docx', bytes, state), DETERMINISM('job-para'))).get('word/document.xml').toString();
  const at = xml.indexOf(`w14:paraId="${paraId}"`);
  const paragraph = at >= 0 ? xml.slice(at, xml.indexOf('</w:p>', at)) : '';
  results[kind] = {
    paraId,
    original: map.get('_originalFormatting') ?? null,
    exportedInd: /<w:ind [^>]*>/.exec(paragraph)?.[0] ?? null,
    exportedSpacing: /<w:spacing [^>]*>/.exec(paragraph)?.[0] ?? null,
    indentReached: paragraph.includes('1234'),
    spacingReached: paragraph.includes("777"),
    pPr: /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? null,
  };
  void before;
}
console.log(JSON.stringify({ file: path.split(/[\\/]/).pop(), ...results }, null, 1));
