// PPTX/XLSX variant of bo_edit.mjs: noedit, one edit, ten spread edits.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const runtime = await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs');
const Y = await import('file:///C:/WEB/capy-notebook/collaboration/node_modules/yjs/dist/yjs.mjs');
const [input, outdir, prefix] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(input));
const format = input.split('.').pop();
const seed = await runtime.seedOffice(format, bytes);
const entries = await runtime.inspectOffice(bytes, seed);
const texts = entries.filter((e) => e.value.length >= 12 && !e.value.startsWith('='));
console.log('entries', entries.length, 'text entries', texts.length);
function edit(e) {
  if (format === 'xlsx') {
    const [sheet, cell] = e.label.split('!');
    return { type: 'set_cell', sheet, cell, expectedValue: e.value, value: e.value + ' (revised)' };
  }
  return { type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value + ' (revised in class)' };
}
const scenarios = {
  noedit: [],
  one: [edit(texts[Math.floor(texts.length / 2)])],
  ten: Array.from({ length: 10 }, (_, i) => edit(texts[Math.floor(((i + 0.5) / 10) * texts.length)])),
};
const checkpoint = { baseSha256: seed.baseSha256, format, schemaVersion: 1, state: seed.state };
for (const [name, commands] of Object.entries(scenarios)) {
  let state = seed.state;
  if (commands.length) {
    const applied = await runtime.applyOfficeCommands(bytes, checkpoint, commands);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seed.state);
    Y.applyUpdate(doc, applied.state);
    state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
  }
  const after = { ...checkpoint, state };
  const effects = commands.length ? await runtime.compare(bytes, checkpoint, after) : [];
  const netTokens = effects.reduce((s, e) => s + Math.ceil(((e.before ?? '') + (e.after ?? '')).length / 4) + (e.kind === 'text' ? 0 : 1), 0);
  const t = Date.now();
  const exported = await runtime.exportOffice(bytes, after, { now: '2000-01-01T00:00:00.000Z', seed: createHash('sha256').update('job-' + name).digest('hex') });
  const file = `${outdir}/${prefix}-${name}.${format}`;
  await writeFile(file, exported);
  console.log(JSON.stringify({ name, commands: commands.length, effects: effects.length, netTokens, exportMs: Date.now() - t, bytes: exported.byteLength }));
}
