// WASM timings of the XLSX paths the collaboration service runs, for one engine build.
// Usage: node wasm_probe.mjs <glue.js> <xlsx_wasm_bg.wasm> <file.xlsx> [state.bin] [--no-baseline]
//   seed:      openCollaborative + encodeStateAsUpdate (seedOffice)
//   open:      openCollaborative + applyUpdateJson(state) (every officeBaseline/export/inspect)
//   project:   checkpointProjectionJson + JSON.parse
//   entries:   office-checkpoint.ts xlsxEntries + officeBaseline hashing, copied verbatim
//   export:    saveBytesAt (exportOffice)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [gluePath, wasmPath, xlsxPath, statePath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const glue = await import(pathToFileURL(gluePath).href);
const wasmExports = await glue.default({ module_or_path: await readFile(wasmPath) });
const { XlsxDocument } = glue;
const bytes = new Uint8Array(await readFile(xlsxPath));
const now = () => performance.now();
const out = { file: xlsxPath.split(/[\\/]/).pop(), wasm: wasmPath.split(/[\\/]/).slice(-2).join('/') };

let t = now();
const seeded = XlsxDocument.openCollaborative(bytes, 1001);
const seed = seeded.encodeStateAsUpdate();
out.seedMs = Math.round(now() - t);
out.seedBytes = seed.length;
seeded.free();

const state = statePath ? new Uint8Array(await readFile(statePath)) : seed;
out.stateBytes = state.length;
t = now();
const doc = XlsxDocument.openCollaborative(bytes, 1002);
out.openCollaborativeMs = Math.round(now() - t);
doc.applyUpdateJson(state);
out.openPlusApplyMs = Math.round(now() - t);

if (!process.argv.includes('--no-baseline')) {
  t = now();
  const projection = JSON.parse(doc.checkpointProjectionJson());
  out.projectionMs = Math.round(now() - t);
  t = now();
  const entries = xlsxEntries(projection).map(({ asset, ...entry }) => ({
    ...entry,
    value: entry.kind === 'visual' ? hash(Buffer.from(entry.value)) : entry.value,
    ...(asset ? { imageSHA256: asset.sha256 } : {}),
  }));
  out.entriesMs = Math.round(now() - t);
  out.baselineBytes = Buffer.byteLength(JSON.stringify({ entries, format: 'xlsx', version: 1 }));
}
t = now();
const exported = doc.saveBytesAt(Date.parse('2000-01-01T00:00:00.000Z') / 86_400_000 + 25569);
out.exportMs = Math.round(now() - t);
out.exportBytes = exported.length;
out.exportSha = hash(exported).slice(0, 16);
doc.free();
out.wasmMemoryMB = Math.round(wasmExports.memory.buffer.byteLength / 1048576);
console.log(JSON.stringify(out));

// --- verbatim from shared/office-checkpoint.ts (dfa3f05e) ---
function hash(b) {
  return createHash('sha256').update(b).digest('hex');
}
function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Map)
      return Object.fromEntries([...item].sort(([a], [b]) => String(a).localeCompare(String(b))));
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
function visual(id, label, value, position = '') {
  return { id, kind: 'visual', label, value: canonical(value), position };
}
function xlsxEntries(projection) {
  const entries = [];
  projection.sheets.forEach(({ cells, images, id, name, ...layout }, index) => {
    entries.push({ id, kind: 'text', label: `Sheet ${name}`, value: name, position: String(index) });
    entries.push(visual(`${id}:layout`, `${name} layout`, layout));
    if (Array.isArray(layout.hyperlinks))
      for (const [linkIndex, link] of layout.hyperlinks.entries())
        entries.push({ id: `${id}:link:${linkIndex}`, kind: 'text', label: `${name}, hyperlink`, value: canonical(link), position: '' });
    for (const image of images) {
      const asset = { bytes: Uint8Array.from(image.bytes), sha256: hash(Uint8Array.from(image.bytes)) };
      entries.push({ id: `${id}:image:${image.id}`, kind: 'image', label: `${name}, image`, value: asset.sha256, position: canonical(image.anchor), asset });
    }
    for (const cell of cells) {
      const value = cell.formula !== null ? `=${cell.formula}` : cell.value.kind === 'empty' ? '' : canonical(cell.value);
      if (value) entries.push({ id: cell.id, kind: 'text', label: `${name}!${cell.address}`, value, position: `${id}:${cell.address}` });
      entries.push(visual(`${cell.id}:format`, `${name}!${cell.address} formatting`, cell.format));
    }
  });
  for (const item of projection.definedNames)
    entries.push({ id: `name:${item.local_sheet}:${item.name}`, kind: 'text', label: `Defined name ${item.name}`, value: item.formula, position: '' });
  return entries;
}
