// What the DOCX seed keeps for charts / AlternateContent / w:pict / w:object,
// and what an unedited export still contains.
import { readFile, writeFile } from 'node:fs/promises';
import { office, Y, formatOf, checkpoint, DETERMINISM } from './lib.mjs';
const path = process.argv[2];
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice('docx', bytes);
const doc = new Y.Doc();
Y.applyUpdate(doc, seed.state);
const kinds = {};
function walk(type) {
  const items = [];
  for (let it = type._start; it; it = it.right) items.push(it);
  for (const last of type._map.values()) items.push(last);
  for (const it of items) {
    const c = it.content;
    if (c.constructor.name === 'ContentType' && c.type instanceof Y.Map) {
      const kind = c.type.get('_kind');
      if (kind && kind !== 'pilcrow') {
        const json = JSON.stringify(c.type.toJSON());
        kinds[kind] ??= { n: 0, bytes: 0, keys: new Set() };
        kinds[kind].n++;
        kinds[kind].bytes += Buffer.byteLength(json);
        for (const k of c.type.keys()) kinds[kind].keys.add(k);
        if (kind === 'chart') kinds[kind].chartJson = (kinds[kind].chartJson ?? 0) + Buffer.byteLength(c.type.get('chartJson') ?? '');
      }
    }
    if (c.constructor.name === 'ContentEmbed') {
      const kind = c.embed?._kind ?? c.embed?.kind ?? 'embed';
      kinds[kind] ??= { n: 0, bytes: 0, keys: new Set() };
      kinds[kind].n++;
      kinds[kind].bytes += Buffer.byteLength(JSON.stringify(c.embed));
    }
    if (c.constructor.name === 'ContentType') walk(c.type);
  }
}
for (const [, t] of doc.share) walk(t);
for (const k of Object.keys(kinds)) kinds[k].keys = [...kinds[k].keys].join(',');
console.log(JSON.stringify({ file: path.split('/').pop(), state: seed.state.length, embeds: kinds }, null, 1));
const entries = await office.officeBaseline(bytes, seed);
console.log('baseline object entries:', JSON.stringify(entries.filter((e) => e.id.includes(':object:') || e.kind === 'image').map((e) => ({ id: e.id, kind: e.kind, label: e.label }))));
const out = await office.exportOffice(bytes, seed, DETERMINISM('job-opaque'));
await writeFile(`exports/${path.split('/').pop()}.unedited.docx`, out);
console.log('exported', out.length);
