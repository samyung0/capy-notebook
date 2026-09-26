// What remains per slide once packageJson and media are gone (prototype states).
// Counts id strings, default-valued shape entries, and the encoded size after
// dropping those entries (a lower bound on what a leaner schema would save).
import { readFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';
for (const path of process.argv.slice(2)) {
  const state = await readFile(path);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const shapes = doc.getMap('pptx:shapes');
  const stories = doc.getMap('pptx:stories');
  const slides = doc.getMap('pptx:slides');
  let idBytes = 0, defaults = 0, shapeCount = 0, paraIds = 0, keyBytes = 0;
  const isDefault = (k, v) => (k === 'flipH' || k === 'flipV') ? v === false : k === 'rotationDeg' ? v === 0 : k === 'adjustValuesJson' ? v === '{}' : (k === 'children' || k === 'textStories') ? Array.isArray(v) && v.length === 0 : false;
  const drop = [];
  for (const [id, shape] of shapes) {
    shapeCount++;
    idBytes += 2 * Buffer.byteLength(id); // map key + "id" field
    for (const [k, v] of shape) {
      keyBytes += Buffer.byteLength(k);
      if (isDefault(k, v)) { defaults++; drop.push([shape, k]); }
      if (k === 'textStories' || k === 'children') for (const s of v) idBytes += Buffer.byteLength(s);
    }
  }
  for (const [, slide] of slides) for (const [k, v] of slide) if (k === 'shapes' && v.toArray) for (const s of v.toArray()) idBytes += Buffer.byteLength(s);
  for (const [id, text] of stories) {
    idBytes += Buffer.byteLength(id);
    for (const op of text.toDelta()) {
      if (op.insert && typeof op.insert === 'object' && op.insert.paraId) { idBytes += Buffer.byteLength(op.insert.paraId); paraIds++; }
    }
  }
  const text = [...stories.values()].reduce((n, t) => n + Buffer.byteLength(t.toString()), 0);
  doc.transact(() => { for (const [m, k] of drop) m.delete(k); });
  const withoutDefaults = Y.encodeStateAsUpdate(doc).length;
  console.log(JSON.stringify({ file: path.split(/[\/]/).pop(), state: state.length, slides: slides.size, shapes: shapeCount, stories: stories.size, paragraphs: paraIds, textBytes: text, idStringBytes: idBytes, shapeKeyBytes: keyBytes, defaultEntries: defaults, stateWithoutDefaultEntries: withoutDefaults }));
}
