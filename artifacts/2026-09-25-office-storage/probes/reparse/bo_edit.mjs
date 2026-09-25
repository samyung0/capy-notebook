// Produce the exact bytes a Capy Office refresh would parse: seed the upload
// into BetterOffice state, apply replace_text edits headlessly (the same
// runtime the collaboration service uses), then exportOffice.
// Usage: node bo_edit.mjs <in.docx> <outdir> <prefix>
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const runtime = await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs');
const Y = await import('file:///C:/WEB/capy-notebook/collaboration/node_modules/yjs/dist/yjs.mjs');

const [input, outdir, prefix] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(input));
const format = input.split('.').pop();
let t = Date.now();
const seed = await runtime.seedOffice(format, bytes);
console.log('seed ms', Date.now() - t, 'state bytes', seed.state.byteLength);
t = Date.now();
const entries = await runtime.inspectOffice(bytes, seed);
console.log('inspect ms', Date.now() - t, 'entries', entries.length);
const body = entries.filter((e) => e.value.length >= 250 && e.value.length <= 900 && !/^\d/.test(e.value));
console.log('body paragraphs 250-900 chars', body.length);

const filler = 'In practice, analysts revisit this idea whenever a new data set arrives, checking the assumptions again, comparing the summary statistics with earlier samples and writing down what changed and why it matters for the conclusion. ';

function scenario(name) {
  if (name === 'noedit') return [];
  if (name === 'small') {
    // One sentence rewritten in one paragraph at the middle of the book.
    const e = body[Math.floor(body.length * 0.5)];
    return [{ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value.replace(/\.\s*$/, '') + ', which a later revision of these notes clarified.' }];
  }
  if (name === 'section') {
    // About 5,000 estimated net tokens inside one section at 40%: 12 consecutive paragraphs each extended.
    const start = Math.floor(body.length * 0.4);
    return body.slice(start, start + 12).map((e) => ({ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value + ' ' + filler.repeat(5).trim() }));
  }
  if (name === 'scattered') {
    // 20 one-word fixes spread evenly through the book.
    const picks = Array.from({ length: 20 }, (_, i) => body[Math.floor(((i + 0.5) / 20) * body.length)]);
    return picks.map((e) => ({ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value.replace(/\bthe\b/, 'this') === e.value ? e.value + ' (revised)' : e.value.replace(/\bthe\b/, 'this') }));
  }
  throw new Error('unknown scenario ' + name);
}

const checkpoint = { baseSha256: seed.baseSha256, format, schemaVersion: 1, state: seed.state };
for (const name of ['noedit', 'small', 'section', 'scattered']) {
  const commands = scenario(name);
  let state = seed.state;
  if (commands.length) {
    t = Date.now();
    const applied = await runtime.applyOfficeCommands(bytes, checkpoint, commands);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seed.state);
    Y.applyUpdate(doc, applied.state);
    state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    console.log(name, 'apply ms', Date.now() - t);
  }
  const after = { ...checkpoint, state };
  const effects = commands.length ? await runtime.compare(bytes, checkpoint, after) : [];
  const netTokens = effects.reduce((s, e) => s + Math.ceil(((e.before ?? '') + (e.after ?? '') + (e.caption ?? '')).length / 4) + (e.kind === 'text' ? 0 : 1), 0);
  t = Date.now();
  const exported = await runtime.exportOffice(bytes, after, { now: '2000-01-01T00:00:00.000Z', seed: createHash('sha256').update('job-' + name).digest('hex') });
  const exportMs = Date.now() - t;
  const file = `${outdir}/${prefix}-${name}.${format}`;
  await writeFile(file, exported);
  console.log(JSON.stringify({ name, commands: commands.length, effects: effects.length, netTokens, exportMs, bytes: exported.byteLength, file }));
}
