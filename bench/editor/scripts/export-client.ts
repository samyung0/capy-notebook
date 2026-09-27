import { runExportWorker } from '../../../src/features/notes/export/client';
import type { MaterialValue } from '../../../src/features/materials/document';
import { bioNotes } from '../../../src/mocks/noteContent/bio';
import { embeddedSeeds } from '../../../src/mocks/noteContent/helpers';

const fixture = bioNotes.find(note => note.id === 'mat_note_bio_feature_matrix')!;
const resolved = fixture.value.map(node => node.type === 'material_ref' ? embeddedSeeds.find(seed => seed.id === node.materialId)!.block : node);
const chart = { type: 'chart', block: { type: 'chart', title: 'Comparison', kind: 'bar', labels: ['A','B'], series: [{ name: 'One', values: [2,4] }, { name: 'Two', values: [3,1] }] }, children: [{ text: '' }] };
Reflect.set(window, 'exportClientProbe', async ({ format, count = 1, textLength = 120, fixture: useFixture = false, math = false, mounted = 0 }: { format: 'markdown' | 'docx'; count: number; textLength: number; fixture: boolean; math?: boolean; mounted?: number }) => {
  const value = (useFixture ? Array.from({ length: count }, () => [...resolved, chart]).flat() : Array.from({ length: count }, (_, i) => math ? { type: 'equation', texExpression: `x^{${i + 1}}+\\frac{1}{2}`, children: [{ text: '' }] } : ({ type: i % 20 ? 'p' : 'h2', children: [{ text: `Block ${i + 1}: ${'x'.repeat(textLength)}` }] }))) as MaterialValue;
  const mountedNote = document.createElement('div');
  for (let i = 0; i < mounted; i++) { const paragraph = document.createElement('p'); paragraph.textContent = `Mounted editor block ${i}: ${'text '.repeat(20)}`; mountedNote.append(paragraph); }
  document.body.append(mountedNote);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sourceBytes = new TextEncoder().encode(JSON.stringify(value)).length;
  let last = performance.now(), worstDelay = 0;
  const timer = setInterval(() => { const now = performance.now(); worstDelay = Math.max(worstDelay, now-last-16); last = now; }, 16);
  const started = performance.now();
  try {
    const result = await runExportWorker({ value, format, assetUrls: {}, noteUrl: location.href });
    const elapsed = performance.now() - started;
    Reflect.set(window, 'lastExport', result);
    await new Promise(resolve => setTimeout(resolve,32));
    return { elapsed, worstDelay, sourceBytes, topLevelNodes: value.length, outputBytes: result.blob.size, extension: result.extension };
  } finally { clearInterval(timer); mountedNote.remove(); }
});
