// Today's pending effects after one structural edit, through the real engine and the
// officeBaseline + compareBaselines code (copied verbatim from office-checkpoint.ts).
// Usage: node structural_effects.mjs <glue.js> <wasm> <file.xlsx> '<op json>'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [gluePath, wasmPath, xlsxPath, opJson] = process.argv.slice(2);
const glue = await import(pathToFileURL(gluePath).href);
await glue.default({ module_or_path: await readFile(wasmPath) });
const bytes = new Uint8Array(await readFile(xlsxPath));
const doc = glue.XlsxDocument.openCollaborative(bytes, 4242);
const baseline = entriesOf(doc);
const result = JSON.parse(doc.applyOpsJson(JSON.stringify({ ops: [JSON.parse(opJson)] })));
const current = entriesOf(doc);
const effects = compareBaselines(baseline, current);
const byOp = {};
for (const e of effects) byOp[`${e.kind}:${e.operation}`] = (byOp[`${e.kind}:${e.operation}`] ?? 0) + 1;
const jsonbText = (v) => (v === null ? 'null' : Array.isArray(v) ? `[${v.map(jsonbText).join(', ')}]` : typeof v === 'object' ? `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`).join(', ')}}` : JSON.stringify(v));
console.log(JSON.stringify({ file: xlsxPath.split(/[\\/]/).pop(), op: JSON.parse(opJson), applied: result.applied, effects: effects.length, byOp, effectsJsonbBytes: Buffer.byteLength(jsonbText(effects)), netTokens: effectTokens(effects) }));
doc.free();

function entriesOf(doc) {
  const projection = JSON.parse(doc.checkpointProjectionJson());
  return xlsxEntries(projection).map(({ asset, ...entry }) => ({ ...entry, value: entry.kind === 'visual' ? hash(Buffer.from(entry.value)) : entry.value, ...(asset ? { imageSHA256: asset.sha256 } : {}) }));
}
// --- verbatim from shared/office-checkpoint.ts and collaboration/src/sourceDocuments.ts ---
function hash(b) { return createHash('sha256').update(b).digest('hex'); }
function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return Object.fromEntries([...item].sort(([a], [b]) => String(a).localeCompare(String(b))));
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
}
function visual(id, label, value, position = '') { return { id, kind: 'visual', label, value: canonical(value), position }; }
function xlsxEntries(projection) {
  const entries = [];
  projection.sheets.forEach(({ cells, images, id, name, ...layout }, index) => {
    entries.push({ id, kind: 'text', label: `Sheet ${name}`, value: name, position: String(index) });
    entries.push(visual(`${id}:layout`, `${name} layout`, layout));
    if (Array.isArray(layout.hyperlinks)) for (const [linkIndex, link] of layout.hyperlinks.entries()) entries.push({ id: `${id}:link:${linkIndex}`, kind: 'text', label: `${name}, hyperlink`, value: canonical(link), position: '' });
    for (const cell of cells) {
      const value = cell.formula !== null ? `=${cell.formula}` : cell.value.kind === 'empty' ? '' : canonical(cell.value);
      if (value) entries.push({ id: cell.id, kind: 'text', label: `${name}!${cell.address}`, value, position: `${id}:${cell.address}` });
      entries.push(visual(`${cell.id}:format`, `${name}!${cell.address} formatting`, cell.format));
    }
  });
  for (const item of projection.definedNames) entries.push({ id: `name:${item.local_sheet}:${item.name}`, kind: 'text', label: `Defined name ${item.name}`, value: item.formula, position: '' });
  return entries;
}
function compareBaselines(from, to) {
  const before = new Map(from.map((entry) => [entry.id, entry]));
  const after = new Map(to.map((entry) => [entry.id, entry]));
  const effects = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(id), next = after.get(id);
    if (old && next && old.value === next.value && old.position === next.position) continue;
    const entry = next ?? old;
    const effect = { id, kind: entry.kind, operation: !old ? 'add' : !next ? 'remove' : old.value === next.value ? 'move' : 'replace', label: entry.label };
    if (entry.kind === 'text') { if (old) effect.before = old.value; if (next) effect.after = next.value; }
    effects.push(effect);
  }
  return effects;
}
function effectTokens(effects) {
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  return effects.reduce((sum, effect) => {
    const text = `${effect.before ?? ''}${effect.after ?? ''}${effect.caption ?? ''}`;
    const cjk = [...text].filter((c) => CJK.test(c)).length;
    return sum + Math.ceil((text.length - cjk) / 4) + cjk + (effect.kind === 'text' ? 0 : 1);
  }, 0);
}
