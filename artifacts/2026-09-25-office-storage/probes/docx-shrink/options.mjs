// Size of the seeded DOCX state under each candidate change, simulated by
// rebuilding the stories in Yjs with the change applied. A control rebuild
// (no change) calibrates the JS rebuild against the engine's own seed.
// Usage: node options.mjs file.docx [--export]  -> one JSON line
import { readFile } from 'node:fs/promises';
import { office, Y, load, weigh, rebuild, json } from './weigh.mjs';

const path = process.argv[2];
const bytes = new Uint8Array(await readFile(path));
// --state file: weigh a stored state (for example the prototype's seed) instead of seeding.
const stateArg = process.argv.indexOf('--state');
const seed = stateArg > 0
  ? { state: new Uint8Array(await readFile(process.argv[stateArg + 1])) }
  : await office.seedOffice('docx', bytes);
const doc = load(seed.state);

// Needs-cache predicate for the "keep boundaries only when they carry data
// that has no story unit" option.
const needsCache = (b) =>
  (b.propertyChanges?.length ?? 0) > 0 || (b.noteMarks?.length ?? 0) > 0 || b.text === '' || (b.breaks?.length ?? 0) > 0;

const pilcrow = (fn) => (op) => {
  if (op.embed && op.insert._kind === 'pilcrow') op.insert = fn({ ...op.insert });
  return op;
};
const images = (fn) => (op) => {
  if (op.embed && op.insert._kind === 'image') op.insert = fn({ ...op.insert });
  return op;
};
const compose = (...fns) => (op) => fns.reduce((o, f) => (o ? f(o) : o), op);

const dropBoundaries = pilcrow((p) => (delete p._originalRunBoundaries, p));
const onlyNeededBoundaries = pilcrow((p) => {
  const b = p._originalRunBoundaries;
  if (b && !b.some(needsCache)) delete p._originalRunBoundaries;
  else if (b)
    p._originalRunBoundaries = b.map(({ formatting, ...rest }) => (rest.text === '' ? { ...rest, formatting } : rest));
  return p;
});
const dropDefaults = pilcrow((p) => (delete p.defaultTextFormatting, p));
// Marks the bridge can refill from the paragraph defaults (apply_run_defaults):
// fontFamily and fontSize equal to defaultTextFormatting.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let paragraphDefaults = [];
const trimMarks = (op) => {
  if (op.embed || !op.attributes) return op;
  return op; // resolved per paragraph below
};
const imageRef = images((p) => {
  if (typeof p.src === 'string' && p.src.startsWith('data:')) p.src = `media:word/media/image${Math.random().toString(36).slice(2, 6)}.png`;
  return p;
});
const imageBinary = images((p) => {
  const m = typeof p.src === 'string' && /^data:([^;]+);base64,(.*)$/.exec(p.src);
  if (m) {
    p.src = new Uint8Array(Buffer.from(m[2], 'base64'));
    p.srcMime = m[1];
  }
  return p;
});

// Trim run marks that equal the paragraph's defaults: needs paragraph context,
// so walk each story's delta and look ahead to its pilcrow.
function trimRunMarks(docIn) {
  const out = new Y.Doc({ gc: true });
  out.clientID = 1;
  const stories = out.getMap('stories');
  out.transact(() => {
    for (const [id, story] of docIn.getMap('stories')) {
      const text = new Y.Text();
      stories.set(id, text);
      const delta = story.toDelta();
      let index = 0;
      let pending = [];
      const flush = (defaults) => {
        for (const op of pending) {
          const attrs = { ...(op.attributes ?? {}) };
          if (defaults?.fontFamily && same(attrs.fontFamily, defaults.fontFamily)) delete attrs.fontFamily;
          if (defaults?.fontSize != null && attrs.fontSize?.size === defaults.fontSize && (attrs.fontSize.sizeCs ?? attrs.fontSize.size) === (defaults.fontSizeCs ?? defaults.fontSize))
            delete attrs.fontSize;
          if (attrs.characterSpacing && defaults?.kerning != null && same(attrs.characterSpacing, { kerning: defaults.kerning })) delete attrs.characterSpacing;
          text.insert(index, op.insert, attrs);
          index += op.insert.length;
        }
        pending = [];
      };
      for (const raw of delta) {
        if (typeof raw.insert === 'string') {
          pending.push(raw);
          continue;
        }
        const obj = raw.insert.toJSON();
        flush(obj._kind === 'pilcrow' ? obj.defaultTextFormatting : undefined);
        const map = new Y.Map();
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
        text.insertEmbed(index, map, raw.attributes ?? {});
        index += 1;
      }
      flush(undefined);
    }
  });
  return out;
}

const size = (u) => u.length;
const variants = {
  engineSeed: seed.state,
  control: rebuild(doc),
  noBoundaries: rebuild(doc, dropBoundaries),
  neededBoundaries: rebuild(doc, onlyNeededBoundaries),
  noDefaults: rebuild(doc, dropDefaults),
  neededBoundariesNoDefaults: rebuild(doc, compose(onlyNeededBoundaries, dropDefaults)),
  imageRef: rebuild(doc, imageRef),
  imageBinary: rebuild(doc, imageBinary),
  neededBoundariesImageRef: rebuild(doc, compose(onlyNeededBoundaries, imageRef)),
};
const trimmed = trimRunMarks(doc);
variants.trimMarks = Y.encodeStateAsUpdate(trimmed);
variants.trimMarksNeededBoundaries = rebuild(load(variants.trimMarks), onlyNeededBoundaries);
variants.trimMarksNoDefaults = rebuild(load(variants.trimMarks), dropDefaults);
const both = load(rebuild(doc, compose(onlyNeededBoundaries, imageRef)));
variants.neededBoundariesImageRefV2 = Y.encodeStateAsUpdateV2(both);
variants.controlV2 = Y.encodeStateAsUpdateV2(load(variants.control));

const w = weigh(doc);
const row = {
  file: path.split(/[\\/]/).pop(),
  source: bytes.length,
  sizes: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, size(v)])),
  weights: {
    text: w.text,
    textItems: w.textItems,
    formatStarts: w.formatStarts,
    formatBytes: w.formatBytes,
    embeds: w.embeds,
    topEmbedKeys: Object.fromEntries(Object.entries(w.embedKeys).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    boundary: w.boundary,
  },
};
console.log(json(row));
