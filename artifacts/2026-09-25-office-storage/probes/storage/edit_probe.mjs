// Editing growth: engine edits -> room doc -> storeSnapshot -> effects, then a
// refresh candidate and publication. One JSON line per step on stdout.
// Usage: node edit_probe.mjs <file> <mode> <steps comma list> [--no-publish] [--save-every N]
// modes: replace-distinct | replace-typing | yjs-typing | cell-distinct | cell-repeat | ai-distinct
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('exports', { recursive: true });
import { randomInt } from 'node:crypto';
import {
  office, Y, sha, formatOf, baselineBytes, effectsBytes, checkpoint, DETERMINISM,
  timed, storeSnapshot, newRoom, connectionOrigin, findAll,
} from './lib.mjs';

const [path, mode, stepsArg] = process.argv.slice(2);
const steps = stepsArg.split(',').map(Number);
const publish = !process.argv.includes('--no-publish');
const saveEveryArg = process.argv.indexOf('--save-every');
const saveEvery = saveEveryArg > 0 ? Number(process.argv[saveEveryArg + 1]) : 0;
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const S = bytes.length;
const file = path.split(/[\\/]/).pop();
const out = (row) => console.log(JSON.stringify({ file, format, mode: mode + (process.argv.includes('--pin-room-client') ? '+pinned' : ''), ...row }));

// ---- first Edit open: seed + indexed baseline (SourceDocumentStore.load)
const seed = await office.seedOffice(format, bytes);
const indexed = await office.officeBaseline(bytes, seed);
const BASE = baselineBytes(indexed, format);
let stored = seed.state; // source_documents.state
let effects = []; // source_documents.pending_effects
const room = newRoom(stored);
const pinClient = process.argv.includes('--pin-room-client');
const roomClient = room.clientID;
const pin = () => { if (pinClient) room.clientID = roomClient; };
const shadow = new Y.Doc({ gc: false }); // same updates without GC
Y.applyUpdate(shadow, stored);
const pure = new Y.Doc(); // same updates, gc:true, no contributor markers
Y.applyUpdate(pure, stored);
const charged = (state, fx) => S + state.length + BASE + effectsBytes(fx);
out({ step: 0, edits: 0, source: S, state: stored.length, baseline: BASE, effects: 2, effectCount: 0, charged: charged(stored, []), stateNoGC: stored.length });

// ---- targets
const WORDS = ['river', 'signal', 'garden', 'copper', 'lantern', 'harbor', 'meadow', 'silver', 'canyon', 'orchard'];
const TYPED = 'The quick brown fox jumps over the lazy dog while students take careful notes. ';
let editable = await office.inspectOffice(bytes, seed);
const texts = new Map(editable.map((e) => [e.id, e.value]));
let paragraphs = [];
let cells = [];
if (format !== 'xlsx') {
  // replace_text refuses text with line breaks; keep single-line paragraphs.
  paragraphs = editable.filter((e) => e.value.split(' ').length >= 3 && !/[\n\v\r]/.test(e.value)).map((e) => e.id);
} else {
  // Existing non-formula cells, numeric columns first, row by row.
  const order = ['E', 'F', 'H', 'I', 'A', 'B', 'J', 'C', 'D'];
  const byAddr = editable
    .filter((e) => e.value !== '' && !e.value.startsWith('=') && /!([A-Z]+)(\d+)$/.test(e.label))
    .map((e) => {
      const [, col, row] = /!([A-Z]+)(\d+)$/.exec(e.label);
      return { e, col, row: Number(row) };
    })
    .filter((x) => x.row > 1);
  byAddr.sort((a, b) => a.row - b.row || order.indexOf(a.col) - order.indexOf(b.col));
  cells = byAddr.map((x) => ({ sheet: x.e.label.split('!')[0], cell: `${x.col}${x.row}`, id: x.e.id }));
}
const typingTarget = paragraphs.length
  ? paragraphs.reduce((best, id) => (texts.get(id).length > texts.get(best).length ? id : best), paragraphs[Math.floor(paragraphs.length / 2)])
  : null;
let typedCount = 0;
let editIndex = 0;
const cellValues = new Map();

function nextCommand(kind) {
  const i = editIndex++;
  if (kind === 'replace-distinct' || kind === 'ai-distinct') {
    const id = paragraphs[i % paragraphs.length];
    const current = texts.get(id);
    const words = current.split(' ');
    const at = Math.floor(words.length / 2) + Math.floor(i / paragraphs.length);
    words[at % words.length] = WORDS[i % WORDS.length];
    const text = words.join(' ');
    texts.set(id, text);
    return { type: 'replace_text', targetId: id, expectedText: current, text };
  }
  if (kind === 'replace-typing') {
    const current = texts.get(typingTarget);
    const text = current + TYPED[typedCount++ % TYPED.length];
    texts.set(typingTarget, text);
    return { type: 'replace_text', targetId: typingTarget, expectedText: current, text };
  }
  if (kind === 'cell-distinct' || kind === 'cell-repeat') {
    const target = kind === 'cell-repeat' ? cells[0] : cells[i % cells.length];
    const key = `${target.sheet}!${target.cell}`;
    const current = cellValues.get(key) ?? editable.find((e) => e.id === target.id).value;
    const numeric = current !== '' && !Number.isNaN(Number(current));
    const value = numeric ? String(Math.round((Number(current) + 1) * 1e4) / 1e4) : `${current.split(" ")[0]} ${WORDS[i % WORDS.length]}`;
    cellValues.set(key, value);
    return { type: 'set_cell', sheet: target.sheet, cell: target.cell, expectedValue: current, value };
  }
  throw new Error(`unknown mode ${kind}`);
}

// Apply engine commands as one client update arriving on a connection.
async function engineEdit(commands) {
  const live = Y.encodeStateAsUpdate(room);
  const applied = await office.applyOfficeCommands(bytes, checkpoint(format, bytes, live), commands);
  Y.applyUpdate(room, applied.state, connectionOrigin());
  pin();
  Y.applyUpdate(shadow, applied.state);
  Y.applyUpdate(pure, applied.state);
}

// Browser-like typing: a separate replica with a Yrs-sized client id inserts one
// character per transaction at the paragraph end; each update reaches the room.
let browser;
let typingPos;
async function yjsKeystroke() {
  if (!browser) {
    browser = new Y.Doc();
    browser.clientID = randomInt(1, 0xffffffff); // src/office-runtime/main.tsx:151 (uint32)
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(room));
    const [loc] = await office.locateOfficeTargets(bytes, checkpoint(format, bytes, Y.encodeStateAsUpdate(room)), [typingTarget]);
    browser._story = browser.getMap(loc.path[0]).get(loc.path[1]);
    typingPos = loc.range[1];
    browser.on('update', (update) => {
      Y.applyUpdate(room, update, connectionOrigin());
      pin();
      Y.applyUpdate(shadow, update);
      Y.applyUpdate(pure, update);
    });
  }
  browser._story.insert(typingPos++, TYPED[typedCount++ % TYPED.length]);
}

// XLSX schema 7 cell payload as written by editCellJson (see diff_probe).
function cellPayload(value) {
  const n = Number(value);
  if (value !== '' && !Number.isNaN(n))
    return JSON.stringify({ value: { kind: 'number', value: 0 }, formula: null }).replace('"value":0', `"value":${Number.isInteger(n) ? n.toFixed(1) : String(n)}`);
  return JSON.stringify({ value: { kind: 'text', value }, formula: null });
}
let cellReplica;
async function yjsCellCommit(kind) {
  if (!cellReplica) {
    cellReplica = new Y.Doc();
    cellReplica.clientID = randomInt(1, 0xffffffff);
    Y.applyUpdate(cellReplica, Y.encodeStateAsUpdate(room));
    cellReplica.on('update', (update) => {
      Y.applyUpdate(room, update, connectionOrigin());
      pin();
      Y.applyUpdate(shadow, update);
      Y.applyUpdate(pure, update);
    });
  }
  const command = nextCommand(kind === 'yjs-cell-repeat' ? 'cell-repeat' : 'cell-distinct');
  const target = cells.find((c) => c.sheet === command.sheet && c.cell === command.cell);
  const marker = target.id.indexOf(':[');
  const sheetId = target.id.slice(0, marker);
  cellReplica.getMap('xlsx:sheets').get(sheetId).get('contents').set(target.id.slice(marker + 1), cellPayload(command.value));
}

async function save() {
  stored = storeSnapshot(room, stored);
  const [current, ms] = await timed(() => office.officeBaseline(bytes, checkpoint(format, bytes, stored)));
  effects = office.compareBaselines(indexed, current);
  if (mode.startsWith('yjs-cell')) {
    const byId = new Map(current.map((e) => [e.id, e.value]));
    typingOk = [...cellValues.entries()].slice(-50).every(([key, v]) => {
      const c = cells.find((x) => `${x.sheet}!${x.cell}` === key);
      const got = byId.get(c.id);
      const ok = got !== undefined && (got === v || JSON.parse(got).value == v || JSON.parse(got).value === v);
      if (!ok && process.env.DEBUG_CELLS) console.error("cell mismatch", key, JSON.stringify(v), got);
      return ok;
    });
  }
  if (mode === 'yjs-typing') {
    const entry = current.find((e) => e.id === typingTarget);
    const typed = Array.from({ length: typedCount }, (_, k) => TYPED[k % TYPED.length]).join('');
    typingOk = !!entry && entry.value.endsWith(typed);
  }
  return ms;
}

let typingOk;
let done = 0;
let lastSaveMs = 0;
let clients = 0;
for (const step of steps) {
  const t0 = performance.now();
  const n = step - done;
  if (mode === 'yjs-cell-distinct' || mode === 'yjs-cell-repeat') {
    for (let k = 0; k < n; k++) {
      await yjsCellCommit(mode);
      if (saveEvery && (done + k + 1) % saveEvery === 0 && done + k + 1 < step) await save();
    }
    clients = 1;
  } else if (mode === 'yjs-typing') {
    for (let k = 0; k < n; k++) {
      await yjsKeystroke();
      if (saveEvery && (done + k + 1) % saveEvery === 0 && done + k + 1 < step) await save();
    }
    clients = 1;
  } else if (mode === 'ai-distinct') {
    for (let k = 0; k < n; k++) await engineEdit([nextCommand(mode)]);
    clients += n;
  } else {
    // One engine session per step: one client, n commands (chunked to bound memory).
    const chunk = 2000;
    for (let k = 0; k < n; k += chunk) {
      await engineEdit(Array.from({ length: Math.min(chunk, n - k) }, () => nextCommand(mode)));
      clients++;
    }
  }
  const tEdit = Math.round(performance.now() - t0);
  lastSaveMs = await save();
  done = step;
  out({
    step, edits: done, clients, state: stored.length, baseline: BASE, effects: effectsBytes(effects),
    effectCount: effects.length, typingOk, charged: charged(stored, effects), multiplier: +(charged(stored, effects) / S).toFixed(3),
    stateNoGC: Y.encodeStateAsUpdate(shadow).length, stateNoMarkers: Y.encodeStateAsUpdate(pure).length, ms: { edit: tEdit, saveBaseline: lastSaveMs },
  });
}

// ---- GC evidence: decode the stored state; count tombstones.
{
  const decoded = Y.decodeUpdate(stored);
  let deletedItems = 0, gcStructs = 0, deletedLen = 0;
  for (const s of decoded.structs) {
    if (s.constructor.name === 'GC') gcStructs++;
    else if (s.content?.constructor.name === 'ContentDeleted') { deletedItems++; deletedLen += s.length; }
  }
  const dsRanges = [...decoded.ds.clients.values()].reduce((a, r) => a + r.length, 0);
  const clientsInState = new Set(decoded.structs.map((s) => s.id.client)).size;
  const typedSample = TYPED.slice(0, 12);
  out({ step: 'gc', structs: decoded.structs.length, tombstoneItems: deletedItems, tombstoneUnits: deletedLen, gcStructs, deleteSetRanges: dsRanges, clientsInState, typedSampleHits: findAll(Buffer.from(stored), typedSample).length });
}

if (!publish) process.exit(0);

// ---- refresh candidate (RequestSourceRefresh + exportCandidate + Finalize)
const captured = stored;
const docRow = stored.length + BASE + effectsBytes(effects);
const [B, tExport] = await timed(() => office.exportOffice(bytes, checkpoint(format, bytes, captured), DETERMINISM('job-probe')));
await writeFile(`exports/${file}.${mode}.${format}`, B);
const [seedB, tSeedB] = await timed(() => office.seedOffice(format, B));
const [baselineB, tBaseB] = await timed(() => office.officeBaseline(B, seedB));
const BASEB = baselineBytes(baselineB, format);
const candidate = captured.length + B.length + seedB.state.length + BASEB;
const peak = S + docRow + candidate;
// Sanity: the export carries the edits (net effects of seed(B) vs indexed A are the same text).
out({
  step: 'candidate', exported: B.length, exportRatio: +(B.length / S).toFixed(3), capturedState: captured.length,
  seedB: seedB.state.length, baselineB: BASEB, candidateRow: candidate, sourceDocRow: docRow, peak,
  peakMultiplier: +(peak / S).toFixed(3), ms: { export: tExport, seed: tSeedB, baseline: tBaseB },
});
// Publication with no newer checkpoint: state := candidate seed, baseline := candidate baseline.
const after = B.length + seedB.state.length + BASEB + 2;
out({ step: 'published', files: B.length, state: seedB.state.length, baseline: BASEB, effects: 2, charged: after, multiplierVsOriginal: +(after / S).toFixed(3), multiplierVsExport: +(after / B.length).toFixed(3) });

// Publication with 10 edits saved after capture: rebaseOffice.
{
  const extraMode = mode === 'yjs-typing' ? 'replace-typing' : mode === 'ai-distinct' ? 'replace-distinct' : mode.startsWith('yjs-cell') ? mode.slice(4) : mode;
  for (const e of await office.inspectOffice(bytes, checkpoint(format, bytes, stored))) texts.set(e.id, e.value);
  await engineEdit(Array.from({ length: 10 }, () => nextCommand(extraMode)));
  await save();
  const latest = stored;
  const [rebased, tRebase] = await timed(() =>
    office.rebaseOffice(bytes, checkpoint(format, bytes, captured), checkpoint(format, bytes, latest), B)
  );
  const rb = baselineBytes(rebased.baseline, format);
  const fx = effectsBytes(rebased.effects);
  out({
    step: 'published-rebased', files: B.length, latestState: latest.length, rebasedState: rebased.state.length,
    seedB: seedB.state.length, baseline: rb, effects: fx, effectCount: rebased.effects.length,
    charged: B.length + rebased.state.length + rb + fx, ms: { rebase: tRebase },
  });
}
