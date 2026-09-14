/** Run with Bun; extracts native geometry without changing source files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  seedOffice, inspectOffice, exportOffice, applyOfficeCommands,
  locateOfficeTargets, rebaseOffice, type OfficeFormat, type OfficeCheckpoint,
} from '../../../vendor/betteroffice/shared/office-checkpoint';
import initDocx, { DocxViewDocument, range_rects_json } from '../../../vendor/betteroffice/packages/docx/src/wasm/generated/viewer/docx_view_wasm.js';
import type { DisplayList as DocxList } from '../../../vendor/betteroffice/packages/docx/src/layout/render/displayList';
import { displayPrimitiveRect } from '../../../vendor/betteroffice/packages/docx/src/layout/render/displayListGeometry';
import { XlsxDocument } from '../../../vendor/betteroffice/packages/xlsx/src/wasm/generated/xlsx_wasm.js';
import { cellRect, rangeRect } from '../../../vendor/betteroffice/packages/xlsx/src/hittest';
import type { MergedRange } from '../../../vendor/betteroffice/packages/xlsx/src/wasm/loader';
import type { DisplayList as XlsxList } from '../../../vendor/betteroffice/packages/xlsx/src/display-list/types';
import { PptxDocument, PptxRenderer } from '../../../vendor/betteroffice/packages/pptx/src/wasm/generated/pptx_wasm.js';
import type { DeckSnapshot, SlideDisplayList } from '../../../vendor/betteroffice/packages/pptx/src/types';

const root = path.resolve(import.meta.dir, '../../..');
const vendor = path.join(root, 'vendor/betteroffice');
const output = path.join(root, 'bench/parsers/reports/local/2026-09-14-native-citations/native');
const fixed = { seed: '0'.repeat(64), now: '2026-09-14T00:00:00.000Z' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inputs = process.argv.slice(2);
const browserOnly = inputs.includes('--browser');
if (browserOnly) inputs.splice(inputs.indexOf('--browser'), 1);
const cellEdit = inputs.includes('--cell-edit');
if (cellEdit) inputs.splice(inputs.indexOf('--cell-edit'), 1);
if (!inputs.length) inputs.push(...['docx', 'xlsx', 'pptx'].map(ext => path.join(vendor, `poc/fixtures/feature-rich.${ext}`)));
await mkdir(output, { recursive: true });
await initDocx({ module_or_path: await readFile(path.join(vendor, 'packages/docx/src/wasm/generated/viewer/docx_view_wasm_bg.wasm')) });

interface Cell { id: string; address: string; value: unknown; formula: string | null }
interface Sheet { id: string; name: string; cells: Cell[] }
interface Projection { sheets: Sheet[] }
function addressParts(address: string) {
  const match = /^([A-Z]+)([0-9]+)$/.exec(address);
  assert(match, address);
  const col = [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, col };
}
function docxGeometry(bytes: Uint8Array) {
  const doc = DocxViewDocument.open(bytes);
  try {
    const json = doc.displayListJson();
    const list: DocxList = JSON.parse(json);
    return { coordinateSpace: 'page-local-px', pages: list.pages.map(page => ({
      pageIndex: page.pageIndex, width: page.width, height: page.height,
      regions: [
        { scope: 'body', primitives: page.primitives },
        ...(page.header ? [{ scope: `header:${page.header.rId}`, primitives: page.header.primitives }] : []),
        ...(page.footer ? [{ scope: `footer:${page.footer.rId}`, primitives: page.footer.primitives }] : []),
        ...(page.noteAreas ?? []).map(note => ({ scope: `${note.kind}:${note.noteIds?.join(',')}`, primitives: note.primitives ?? [] })),
      ].map(region => ({ scope: region.scope, items: region.primitives.map(p => ({
        kind: p.kind, text: 'text' in p ? p.text : undefined,
        paraId: p.paraId, blockKey: p.blockKey, blockId: p.blockId,
        docStart: p.docStart, docEnd: p.docEnd, lineIndex: p.lineIndex,
        rect: displayPrimitiveRect(p),
        rangeRects: region.scope === 'body' && p.docStart !== undefined && p.docEnd !== undefined
          ? JSON.parse(range_rects_json(json, p.docStart, p.docEnd)) : undefined,
      })) })),
    })) };
  } finally { doc.free(); }
}
function xlsxGeometry(doc: XlsxDocument) {
  const projection: Projection = JSON.parse(doc.checkpointProjectionJson());
  const sheets = projection.sheets.map((sheet, sheetIndex) => {
    doc.setActiveSheet(sheetIndex);
    const frame: XlsxList = JSON.parse(doc.displayListJson(JSON.stringify({ x: 0, y: 0, width: 4096, height: 12000 })));
    const merged: { ranges: MergedRange[] } = JSON.parse(doc.mergedRangesJson(JSON.stringify({ sheet: sheetIndex, range: 'A1:XFD1048576' })));
    return { sheetIndex, id: sheet.id, name: sheet.name, width: frame.width, height: frame.height,
      mergedRanges: merged.ranges,
      cells: sheet.cells.map(cell => {
        const { row, col } = addressParts(cell.address);
        const cellData = JSON.parse(doc.cellJson(JSON.stringify({ sheet: sheetIndex, row, col })));
        const merge = merged.ranges.find(item => row >= item.start.row && row <= item.end.row && col >= item.start.col && col <= item.end.col);
        return { ...cell, row, col, cellData,
          rect: cellRect(frame.grid, row, col),
          mergedRect: merge ? rangeRect(frame.grid, { top: merge.start.row, left: merge.start.col, bottom: merge.end.row, right: merge.end.col }) : undefined,
          origin: JSON.parse(doc.cellPositionJson(JSON.stringify({ sheet: sheetIndex, row, col }))),
        };
      }), textCommands: frame.commands.filter(cmd => cmd.op === 'text'), charts: frame.charts,
    };
  });
  return { coordinateSpace: 'viewport-local-px', viewport: { x: 0, y: 0, width: 4096, height: 12000 }, sheets };
}
async function pptxGeometry(doc: PptxDocument) {
  const renderer = new PptxRenderer();
  try {
    for (const [suffix, bold, italic] of [['Regular', false, false], ['Bold', true, false], ['Italic', false, true], ['BoldItalic', true, true]] as const) {
      renderer.registerFont('Arial', bold, italic, await readFile(path.join(vendor, `packages/fonts/assets/LiberationSans-${suffix}.ttf`)));
    }
    const deck: DeckSnapshot = JSON.parse(doc.snapshotJson());
    return { coordinateSpace: 'slide-local-px', widthEmu: deck.widthEmu, heightEmu: deck.heightEmu,
      slides: deck.slides.map((slide, slideIndex) => ({ slideIndex, ...slide,
        displayList: JSON.parse(renderer.layoutSlideJson(doc, slideIndex)) as SlideDisplayList,
      })),
    };
  } finally { renderer.free(); }
}
async function geometry(bytes: Uint8Array, checkpoint: OfficeCheckpoint) {
  if (checkpoint.format === 'docx') return docxGeometry(bytes);
  if (checkpoint.format === 'xlsx') {
    const doc = XlsxDocument.openCollaborative(bytes, 928001);
    try { doc.applyUpdateJson(checkpoint.state); return xlsxGeometry(doc); } finally { doc.free(); }
  }
  const doc = PptxDocument.openCollaborativeFromUpdate(checkpoint.state, 928001, bytes);
  try { return await pptxGeometry(doc); } finally { doc.free(); }
}

for (const input of browserOnly ? [] : inputs) {
  const source = path.resolve(input);
  const format = path.extname(source).slice(1) as OfficeFormat;
  assert(['docx', 'xlsx', 'pptx'].includes(format));
  const id = `${path.basename(source, `.${format}`)}-${format}${cellEdit ? '-cell-edit' : ''}`;
  const result: Record<string, unknown> = { id, source, format, startedAt: new Date().toISOString() };
  try {
    const bytes = await readFile(source);
    result.sha256 = sha(bytes);
    const checkpoint = await seedOffice(format, bytes);
    const entries = await inspectOffice(bytes, checkpoint);
    result.entries = entries;
    result.geometry = await geometry(bytes, checkpoint);
    result.runtime = { docx: 'unmodified viewer WASM without registered fonts, same as current Capy viewer worker', pptx: 'editor renderer with Arial mapped to bundled Liberation Sans, same four font faces as Capy', xlsx: 'editor display list over collaborative checkpoint; full visible grid bounded to 4096x12000 px' };
    const again = await seedOffice(format, bytes);
    const repeat = await inspectOffice(bytes, again);
    assert.deepEqual(entries.map(e => e.id), repeat.map(e => e.id));
    const exported = await exportOffice(bytes, checkpoint, fixed);
    const reopened = await seedOffice(format, exported);
    const reopenedEntries = await inspectOffice(exported, reopened);
    const rebased = await rebaseOffice(bytes, checkpoint, checkpoint, exported);
    const rebasedEntries = await inspectOffice(exported, { ...reopened, state: rebased.state });
    result.identity = {
      repeatSeedStable: true, originalCount: entries.length,
      exportedSha256: sha(exported), reopenedEntries,
      exportReopenSameIdCount: entries.filter(entry => reopenedEntries.some(item => item.id === entry.id)).length,
      exportReopenSameIdAndTextCount: entries.filter(entry => reopenedEntries.some(item => item.id === entry.id && item.value === entry.value)).length,
      rebaseSameIdCount: entries.filter(entry => rebasedEntries.some(item => item.id === entry.id)).length,
      rebasedEntries,
    };
    result.exportedGeometry = await geometry(exported, reopened);
    let changedCheckpoint: OfficeCheckpoint | undefined;
    if (format === 'docx') {
      const body = entries.filter(entry => entry.id.startsWith('body:') && entry.value.trim());
      const [first, target] = body;
      assert(first && target, 'Two editable body paragraphs needed for the reflow check');
      const edit = await applyOfficeCommands(bytes, checkpoint, [{ type: 'replace_text', targetId: first.id, expectedText: first.value, text: first.value + ' Added surrounding text for native citation reflow. '.repeat(35) }]);
      const changed = { ...checkpoint, state: edit.state };
      changedCheckpoint = changed;
      const changedEntries = await inspectOffice(bytes, changed);
      assert.equal(changedEntries.find(entry => entry.id === target.id)?.value, target.value);
      const changedBytes = await exportOffice(bytes, changed, fixed);
      result.mutation = { kind: 'grow-earlier-paragraph', target, beforeLocation: await locateOfficeTargets(bytes, checkpoint, [target.id]), afterLocation: await locateOfficeTargets(bytes, changed, [target.id]), sameTargetAndText: true, entries: changedEntries, geometry: docxGeometry(changedBytes) };
    } else if (format === 'xlsx') {
      const doc = XlsxDocument.openCollaborative(bytes, 928002);
      try {
        doc.applyUpdateJson(checkpoint.state);
        const before: Projection = JSON.parse(doc.checkpointProjectionJson());
        const target = before.sheets[0].cells.find(cell => addressParts(cell.address).row > 0 && (!cellEdit || cell.formula === null));
        assert(target, 'Cell below first row needed');
        if (cellEdit) {
          const at = addressParts(target.address);
          const current: { input: string } = JSON.parse(doc.cellJson(JSON.stringify({ sheet: 0, ...at })));
          doc.editCellJson(JSON.stringify({ sheet: 0, ...at, input: `${current.input} citation probe` }));
        } else {
          doc.applyOpsJson(JSON.stringify({ ops: [{ type: 'insertRows', sheet: 0, at: 0, count: 2 }] }));
        }
        changedCheckpoint = { ...checkpoint, state: doc.encodeStateAsUpdate() };
        const after = xlsxGeometry(doc);
        const moved = after.sheets[0].cells.find(cell => cell.id === target.id);
        assert(moved, 'Stable target survived row insertion');
        assert.equal(moved.row, addressParts(target.address).row + (cellEdit ? 0 : 2));
        result.mutation = { kind: cellEdit ? 'edit-one-cell' : 'insert-two-rows-at-zero', target, moved, stableTarget: true, geometry: after };
      } finally { doc.free(); }
    } else {
      const doc = PptxDocument.openCollaborativeFromUpdate(checkpoint.state, 928003, bytes);
      try {
        const deck: DeckSnapshot = JSON.parse(doc.snapshotJson());
        const slide = deck.slides.find(item => item.shapes.some(shape => shape.textStories.length));
        assert(slide, 'Slide with ordinary text shape needed');
        const shape = slide.shapes.find(item => item.textStories.length)!;
        const x = shape.x + 914400, y = shape.y + 457200;
        const receipt = JSON.parse(doc.moveShapeJson(JSON.stringify({ slideId: slide.id, shapeId: shape.id, x, y })));
        changedCheckpoint = { ...checkpoint, state: doc.encodeStateAsUpdate() };
        const after = await pptxGeometry(doc);
        const moved = after.slides.find(item => item.id === slide.id)?.shapes.find(item => item.id === shape.id);
        assert(moved);
        assert.equal(moved.x, x); assert.equal(moved.y, y);
        assert.deepEqual(moved.textStories, shape.textStories);
        result.mutation = { kind: 'move-text-shape-one-inch-right-half-inch-down', target: { slideId: slide.id, shape }, moved, receipt, stableTargetAndText: true, geometry: after };
      } finally { doc.free(); }
    }
    assert(changedCheckpoint);
    const changedEntries = await inspectOffice(bytes, changedCheckpoint);
    const changedBytes = await exportOffice(bytes, changedCheckpoint, fixed);
    const changedReopened = await seedOffice(format, changedBytes);
    const changedReopenedEntries = await inspectOffice(changedBytes, changedReopened);
    const changedRebase = await rebaseOffice(bytes, changedCheckpoint, changedCheckpoint, changedBytes);
    const changedRebasedEntries = await inspectOffice(changedBytes, { ...changedReopened, state: changedRebase.state });
    const compareIdentities = (other: typeof changedEntries) => ({
      total: changedEntries.length,
      sameIdAndTextCount: changedEntries.filter(entry => other.some(item => item.id === entry.id && item.value === entry.value)).length,
      reusedIdDifferentText: changedEntries.flatMap(entry => {
        const match = other.find(item => item.id === entry.id);
        return match && match.value !== entry.value ? [{ id: entry.id, before: entry.value, after: match.value }] : [];
      }),
    });
    result.mutatedExport = {
      sha256: sha(changedBytes), reopenedIdentity: compareIdentities(changedReopenedEntries),
      rebasedIdentity: compareIdentities(changedRebasedEntries),
      reopenedEntries: changedReopenedEntries, rebasedEntries: changedRebasedEntries,
      reopenedGeometry: await geometry(changedBytes, changedReopened),
    };
    await writeFile(path.join(output, `${id}-mutated.${format}`), changedBytes);
    result.status = 'ok';
  } catch (error) {
    result.status = 'error'; result.error = String(error); result.stack = error instanceof Error ? error.stack : undefined;
  }
  await writeFile(path.join(output, `${id}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ id, status: result.status, error: result.error, output: path.join(output, `${id}.json`) }));
}

if (browserOnly) {
  const { createServer } = await import('vite');
  const { chromium } = await import('@playwright/test');
  const server = await createServer({
    configFile: false, root, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, entries: [] },
    resolve: { alias: [{ find: /^@betteroffice\/docx\/(.*)$/, replacement: `${vendor}/packages/docx/src/$1` }] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [{ name: 'native-citation-probe-page', configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        if (req.url !== '/native-citation-probe') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><body style="margin:0;background:white"></body></html>');
      });
    } }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/native-citation-probe`);
    const browserResult = await page.evaluate(async () => {
      const response = await fetch('/vendor/betteroffice/poc/fixtures/feature-rich.docx');
      const bytes = await response.arrayBuffer();
      const displayList = await new Promise<DocxList>((resolve, reject) => {
        const worker = new Worker('/src/office-runtime/DocxViewer.worker.ts', { type: 'module' });
        worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
        worker.onmessage = event => {
          worker.terminate();
          if (event.data.type === 'error') reject(new Error(event.data.message));
          else resolve(event.data.displayList);
        };
        worker.postMessage({ bytes, id: 1 }, [bytes]);
      });
      const backend = await import('/vendor/betteroffice/packages/docx/src/layout/render/canvasBackend.ts');
      const canvas = document.createElement('canvas');
      canvas.id = 'docx-proof'; document.body.append(canvas);
      await backend.rasterizeDisplayPageToBackBuffer(canvas, displayList.pages[0], {}, 1, 1);
      const ctx = canvas.getContext('2d')!;
      const title = displayList.pages[0].primitives.find(p => p.kind === 'text' && p.text === 'Browser document fixture');
      if (!title || title.kind !== 'text') throw new Error('Missing title primitive');
      ctx.font = title.font;
      return { displayList, browserFont: title.font, actualCanvasTextWidth: ctx.measureText(title.text).width, layoutWidth: title.width };
    });
    const bytes = await readFile(path.join(vendor, 'poc/fixtures/feature-rich.docx'));
    const document = DocxViewDocument.open(bytes);
    let headless: DocxList;
    try { headless = JSON.parse(document.displayListJson()); } finally { document.free(); }
    assert.deepEqual(browserResult.displayList, headless, 'Actual application worker must match headless viewer display list');
    await page.locator('#docx-proof').screenshot({ path: path.join(output, 'docx-actual-worker-page1.png') });
    const pptxProof = await page.evaluate(async () => {
      document.body.replaceChildren();
      const data = await (await fetch('/bench/parsers/reports/local/2026-09-14-native-citations/native/wetland-pptx.json')).json();
      const list = data.geometry.slides[0].displayList as SlideDisplayList;
      const renderer = await import('/vendor/betteroffice/packages/pptx/src/render/canvas.ts');
      const face = new FontFace('Arial', 'url(/vendor/betteroffice/packages/fonts/assets/LiberationSans-Regular.ttf)');
      await face.load(); document.fonts.add(face);
      const canvas = document.createElement('canvas'); canvas.id = 'pptx-proof'; document.body.append(canvas);
      renderer.sizeCanvasForSlide(canvas, list, 1, 1);
      const ctx = canvas.getContext('2d')!;
      await renderer.paintSlide(ctx, list, 1, 1);
      const box = list.primitives.find(p => p.kind === 'textBox' && p.lines.length > 0 && !p.transform?.rotationDeg);
      if (!box || box.kind !== 'textBox') throw new Error('Missing citation textbox');
      const rects = box.lines.map(line => ({ x: line.x, y: line.y, width: line.width, height: line.height }));
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.fillStyle = 'rgba(255, 196, 0, 0.32)';
      for (const rect of rects) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let changedPixels = 0;
      for (let i = 0; i < before.length; i += 4) if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changedPixels++;
      return { shapeId: box.shapeId, storyId: box.storyId, rects, changedPixels, width: canvas.width, height: canvas.height };
    });
    assert(pptxProof.changedPixels > 0, 'Native highlight must alter painted pixels');
    await page.locator('#pptx-proof').screenshot({ path: path.join(output, 'pptx-native-highlight.png') });
    await writeFile(path.join(output, 'browser-verification.json'), JSON.stringify({
      browser: browser.version(), actualWorkerEqualsHeadless: true,
      docx: { browserFont: browserResult.browserFont, actualCanvasTextWidth: browserResult.actualCanvasTextWidth, layoutWidth: browserResult.layoutWidth, pages: browserResult.displayList.pages.length },
      pptxProof, browserErrors: errors,
    }, null, 2));
    console.log(JSON.stringify({ actualWorkerEqualsHeadless: true, layoutWidth: browserResult.layoutWidth, actualCanvasTextWidth: browserResult.actualCanvasTextWidth, pptxHighlightChangedPixels: pptxProof.changedPixels, browserErrors: errors }));
  } finally { await browser.close(); await server.close(); }
}
