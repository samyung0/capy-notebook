// PPTX seed composition: what pptx:meta.packageJson holds, what the other roots
// hold, and the state once packageJson and/or media leave Yjs.
// Usage: node pptx_meta.mjs deck.pptx... > out.jsonl
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { office, Y } from '../storage/lib.mjs';

const len = (v) => Buffer.byteLength(JSON.stringify(v) ?? '');
const gz = (b) => gzipSync(b, { level: 6 }).length;

function payloadByKey(doc) {
  // Payload bytes per root and per map key (shapes/slides), per content class (stories).
  const out = {};
  const add = (k, n) => (out[k] = (out[k] ?? 0) + n);
  const seen = new Set();
  const walk = (type, root, depth) => {
    const items = [];
    for (let it = type._start; it; it = it.right) items.push(it);
    for (const last of type._map.values()) for (let it = last; it; it = it.left) items.push(it);
    for (const item of items) {
      if (seen.has(item) || item.deleted) continue;
      seen.add(item);
      const c = item.content;
      const name = c.constructor.name;
      let n = 0;
      let kind = name;
      if (name === 'ContentString') n = Buffer.byteLength(c.str);
      else if (name === 'ContentFormat') { n = Buffer.byteLength(c.key) + len(c.value); kind = `format:${c.key}`; }
      else if (name === 'ContentEmbed') n = len(c.embed);
      else if (name === 'ContentAny') n = c.arr.reduce((s, v) => s + (v instanceof Uint8Array ? v.length : len(v)), 0);
      else if (name === 'ContentBinary') n = c.content.length;
      const key = item.parentSub != null ? (depth >= 1 ? `.${item.parentSub}` : '.<entry>') : '';
      add(`${root}${depth >= 1 && item.parentSub != null ? key : ''}\t${kind}`, n);
      add(`${root}\t_items`, 1);
      add(`${root}\t_keybytes`, item.parentSub ? Buffer.byteLength(item.parentSub) : 0);
      if (name === 'ContentType') walk(c.type, root, depth + 1);
    }
  };
  for (const [name, type] of doc.share) walk(type, name, 0);
  return out;
}

function rootEncodedSizes(state) {
  // Encoded size attributable to each root: state minus state-with-root-cleared.
  const total = state.length;
  const sizes = {};
  const probe = new Y.Doc();
  Y.applyUpdate(probe, state);
  for (const name of [...probe.share.keys()]) {
    const d = new Y.Doc();
    Y.applyUpdate(d, state);
    const t = d.share.get(name);
    d.transact(() => {
      if (t instanceof Y.Map || t._map.size) for (const k of [...t._map.keys()]) d.getMap(name).delete(k);
      else if (t._length) d.getArray(name).delete(0, t._length);
    });
    sizes[name] = total - Y.encodeStateAsUpdate(d).length;
    d.destroy();
  }
  probe.destroy();
  return sizes;
}

for (const path of process.argv.slice(2)) {
  const bytes = new Uint8Array(await readFile(path));
  const seed = await office.seedOffice('pptx', bytes);
  const state = seed.state;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const meta = doc.getMap('pptx:meta');
  const pj = meta.get('packageJson');
  const media = meta.get('media') ?? [];
  const pkg = JSON.parse(Buffer.from(pj).toString('utf8'));
  const top = Object.fromEntries(Object.entries(pkg).map(([k, v]) => [k, len(v)]));
  // Slides inside packageJson: the parsed shape trees again.
  const slideFields = {};
  for (const s of pkg.slides) for (const [k, v] of Object.entries(s)) slideFields[k] = (slideFields[k] ?? 0) + len(v);
  const layoutFields = {};
  for (const s of pkg.layouts) for (const [k, v] of Object.entries(s)) layoutFields[k] = (layoutFields[k] ?? 0) + len(v);
  const masterFields = {};
  for (const s of pkg.masters) for (const [k, v] of Object.entries(s)) masterFields[k] = (masterFields[k] ?? 0) + len(v);
  const mediaBytes = media.reduce((s, e) => s + e[2].length, 0);

  const without = (keys) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, state);
    d.transact(() => { for (const k of keys) d.getMap('pptx:meta').delete(k); });
    const u = Y.encodeStateAsUpdate(d);
    d.destroy();
    return u;
  };
  const noMedia = without(['media']);
  const noPkg = without(['packageJson']);
  const neither = without(['media', 'packageJson']);
  const row = {
    file: path.split(/[\\/]/).pop(),
    source: bytes.length,
    slides: pkg.slides.length,
    layouts: pkg.layouts.length,
    masters: pkg.masters.length,
    themes: pkg.themes.length,
    charts: pkg.charts.length,
    mediaParts: media.length,
    state: state.length,
    packageJson: pj.length,
    packageJsonGzip: gz(Buffer.from(pj)),
    packageTop: top,
    slideFields,
    layoutFields,
    masterFields,
    mediaBytes,
    stateWithoutMedia: noMedia.length,
    stateWithoutPackageJson: noPkg.length,
    stateWithoutBoth: neither.length,
    stateWithoutBothGzip: gz(Buffer.from(neither)),
    rootEncoded: rootEncodedSizes(neither),
    payload: payloadByKey(doc),
  };
  console.log(JSON.stringify(row));
  doc.destroy();
}
