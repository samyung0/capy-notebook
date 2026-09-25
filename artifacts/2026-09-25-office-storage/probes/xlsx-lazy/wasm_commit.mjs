// One-cell commits through the editor API (editCellJson), as the browser does.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [gluePath, wasmPath, xlsxPath] = process.argv.slice(2);
const glue = await import(pathToFileURL(gluePath).href);
const wasm = await glue.default({ module_or_path: await readFile(wasmPath) });
const bytes = new Uint8Array(await readFile(xlsxPath));
const doc = glue.XlsxDocument.openCollaborative(bytes, 5151);
const times = [];
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  doc.editCellJson(JSON.stringify({ sheet: 0, row: 10 + i, col: 4, input: String(9000 + i) }));
  times.push(Math.round(performance.now() - t));
}
console.log(JSON.stringify({ file: xlsxPath.split(/[\/]/).pop(), wasm: wasmPath.split(/[\/]/).slice(-2)[0], commitMs: times, stateBytes: doc.encodeStateAsUpdate().length, wasmMemoryMB: Math.round(wasm.memory.buffer.byteLength / 1048576) }));
