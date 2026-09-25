// Media references through the patched headless runtime copy (baseline,
// resolveAsset, agent edit, export, rebase). Usage: node verify_refs.mjs file.docx
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkpoint, DETERMINISM, baselineBytes } from '../storage/lib.mjs';
import { unzip, compareParts } from './zip.mjs';

const office = await import('./bundle/office-checkpoint.mjs');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const path = process.argv[2];
const name = path.split(/[\\/]/).pop().replace(/\.docx$/, '');
const A = new Uint8Array(await readFile(path));
const today = new Uint8Array(await readFile(`states/${name}.today.bin`));
const refs = new Uint8Array(await readFile(`states/${name}.both.bin`));
const out = { file: name };

// 1. Baselines: image entries must carry the same SHA-256 as today.
const baseToday = await office.officeBaseline(A, checkpoint('docx', A, today));
const baseRefs = await office.officeBaseline(A, checkpoint('docx', A, refs));
const images = (entries) => entries.filter((e) => e.kind === 'image').map((e) => e.imageSHA256).sort();
out.baseline = {
  todayBytes: baselineBytes(baseToday, 'docx'),
  refsBytes: baselineBytes(baseRefs, 'docx'),
  imageEntries: [images(baseToday).length, images(baseRefs).length],
  sameImageHashes: JSON.stringify(images(baseToday)) === JSON.stringify(images(baseRefs)),
};

// 2. resolveAsset returns the package part's bytes.
const parts = unzip(A);
const imageEntry = baseRefs.find((e) => e.kind === 'image');
if (imageEntry) {
  const asset = await office.resolveAsset(A, checkpoint('docx', A, refs), imageEntry.assetRef);
  out.resolveAsset = {
    sha256Matches: asset.sha256 === imageEntry.imageSHA256,
    matchesAPart: [...parts].some(([p, b]) => p.startsWith('word/media/') && sha(b) === asset.sha256),
  };
}

// 3. An agent edit, export, then a rebase with that edit saved after the capture.
const editable = await office.inspectOffice(A, checkpoint('docx', A, refs));
const target = editable.find((e) => e.value.length > 20);
const edited = await office.applyOfficeCommands(A, checkpoint('docx', A, refs), [
  { type: 'replace_text', targetId: target.id, expectedText: target.value, text: `${target.value} (edited)` },
]);
const B = await office.exportOffice(A, checkpoint('docx', A, refs), DETERMINISM('job-refs'));
const Btoday = await office.exportOffice(A, checkpoint('docx', A, today), DETERMINISM('job-refs'));
out.export = { sameAsToday: Buffer.compare(Buffer.from(B), Buffer.from(Btoday)) === 0, ...compareParts(unzip(Btoday), unzip(B)) };
try {
  const rebased = await office.rebaseOffice(A, checkpoint('docx', A, refs), checkpoint('docx', A, edited.state), B);
  const C = await office.exportOffice(B, checkpoint('docx', B, rebased.state), DETERMINISM('job-refs-2'));
  const hasDataUrl = Buffer.from(rebased.state).includes(Buffer.from('data:image/'));
  out.rebase = {
    state: rebased.state.length,
    stateHasDataUrls: hasDataUrl,
    effects: rebased.effects.map((e) => `${e.kind}:${e.operation}`),
    exportAfterRebase: C.length,
    editSurvives: unzip(C).get('word/document.xml').toString().includes('(edited)'),
    mediaPartsKept: [...unzip(C).keys()].filter((p) => p.startsWith('word/media/')).length,
  };
} catch (error) {
  out.rebase = { error: String(error.message ?? error) };
}
console.log(JSON.stringify(out, null, 1));
