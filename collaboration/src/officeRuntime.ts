import { Worker } from 'node:worker_threads';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export type SourceFormat = OfficeFormat | 'text';
export interface OfficeCheckpoint {
  baseSha256: string;
  format: OfficeFormat;
  schemaVersion: 1;
  state: Uint8Array;
}
export interface OfficeObjectRef {
  format: OfficeFormat;
  id: string;
  kind: 'image';
  sheetId?: string;
  slideId?: string;
  storyId?: string;
}
export interface NetEffect {
  after?: string;
  assetRef?: OfficeObjectRef;
  before?: string;
  caption?: string;
  id: string;
  imageSHA256?: string;
  kind: 'text' | 'image' | 'visual';
  label: string;
  operation: 'add' | 'replace' | 'remove' | 'move';
}
/** One editable text entry: a DOCX or PPTX paragraph or an XLSX cell. */
export interface OfficeEntry {
  id: string;
  label: string;
  position: string;
  value: string;
}
export interface OfficeBaselineEntry extends OfficeEntry {
  assetRef?: OfficeObjectRef;
  imageSHA256?: string;
  kind: NetEffect['kind'];
}
/** Yrs location of an edited target; Capy derives item-run guards from it. */
export interface OfficeTarget {
  id: string;
  path: string[];
  range?: [number, number];
}
export interface OfficeCommandResult {
  inverse: unknown[];
  state: Uint8Array;
  targets: OfficeTarget[];
}
interface Runtime {
  /**
   * Apply content commands to a checkpoint with the native engine and return
   * the new state, the inverse commands in undo order and the post-edit target
   * locations. Engine refusals reject with a `<code>: message` string.
   */
  applyOfficeCommands(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint,
    commands: unknown[]
  ): Promise<OfficeCommandResult>;
  compare(
    bytes: Uint8Array,
    from: OfficeCheckpoint,
    to: OfficeCheckpoint
  ): Promise<NetEffect[]>;
  compareBaselines(
    from: OfficeBaselineEntry[],
    to: OfficeBaselineEntry[]
  ): Promise<NetEffect[]>;
  exportOffice(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint,
    determinism: { seed: string; now: string }
  ): Promise<Uint8Array>;
  /** Editable entries of a checkpoint (paragraphs, cells, shapes) without assets. */
  inspectOffice(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint
  ): Promise<OfficeEntry[]>;
  /** Current locations of stable target ids; a missing id rejects. */
  locateOfficeTargets(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint,
    ids: string[]
  ): Promise<OfficeTarget[]>;
  officeBaseline(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint
  ): Promise<OfficeBaselineEntry[]>;
  rebaseOffice(
    bytes: Uint8Array,
    captured: OfficeCheckpoint,
    latest: OfficeCheckpoint,
    exported: Uint8Array
  ): Promise<{
    state: Uint8Array;
    baseline: OfficeBaselineEntry[];
    effects: NetEffect[];
  }>;
  resolveAsset(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint,
    ref: OfficeObjectRef
  ): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }>;
  seedOffice(
    format: OfficeFormat,
    bytes: Uint8Array
  ): Promise<OfficeCheckpoint>;
}

/** A call the Office engine refused, trapped on or did not finish in time. */
export class OfficeEngineError extends Error {}

export const CALL_TIMEOUT_MS = 120_000;
// A trap leaves wasm-bindgen objects poisoned, and the engine's dispose() or
// free() in `finally` then throws one of these plain errors in place of the
// WebAssembly.RuntimeError, so they count as traps too.
const BROKEN_OBJECT =
  /attempted to take ownership of Rust value while it was borrowed|recursive use of an object detected|null pointer passed to rust/;

interface Call {
  args: unknown[];
  method: string;
  reject(error: Error): void;
  resolve(value: unknown): void;
  timer?: NodeJS.Timeout;
}

// One worker keeps synchronous WASM parsing/export off the WebSocket event loop,
// rather than loading a WASM runtime for each keystroke or each active room.
// Calls queue here with one in flight, so each timeout counts only its own
// work. A WebAssembly trap or a timeout fails that call and replaces the
// worker; engine refusals are ordinary results and keep it.
let worker: Worker | undefined;
let active: Call | undefined;
const queue: Call[] = [];

function startWorker() {
  const runtimeURL = new URL(
    '../../vendor/betteroffice/shared/office-checkpoint.mjs',
    import.meta.url
  ).href;
  const created = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const runtime = import(workerData);
    parentPort.on('message', async ({method, args}) => {
      try { parentPort.postMessage({value: await (await runtime)[method](...args)}); }
      catch (error) { parentPort.postMessage({error: String(error?.message || error), trap: error instanceof WebAssembly.RuntimeError}); }
    });
  `,
    { eval: true, workerData: runtimeURL }
  );
  created.on(
    'message',
    (message: { value?: unknown; error?: string; trap?: boolean }) => {
      if (worker !== created) return;
      const call = finish();
      if (message.error === undefined) call?.resolve(message.value);
      else {
        call?.reject(new OfficeEngineError(message.error));
        if (message.trap || BROKEN_OBJECT.test(message.error)) restart();
      }
      next();
    }
  );
  const died = (error: Error) => {
    if (worker !== created) return;
    worker = undefined;
    finish()?.reject(new OfficeEngineError(error.message));
    next();
  };
  created.on('error', died);
  created.on('exit', (code) =>
    died(new Error(`Office worker exited (${code})`))
  );
  return created;
}

function finish() {
  const call = active;
  active = undefined;
  clearTimeout(call?.timer);
  return call;
}

function restart() {
  const old = worker;
  worker = undefined;
  void old?.terminate();
}

function next() {
  if (active) return;
  const call = queue.shift();
  if (!call) {
    worker?.unref();
    return;
  }
  active = call;
  worker ??= startWorker();
  worker.ref();
  call.timer = setTimeout(() => {
    if (active !== call) return;
    finish();
    call.reject(new OfficeEngineError(`Office ${call.method} timed out`));
    restart();
    next();
  }, CALL_TIMEOUT_MS);
  worker.postMessage({ args: call.args, method: call.method });
}

export function runOffice<K extends keyof Runtime>(
  method: K,
  ...args: Parameters<Runtime[K]>
): ReturnType<Runtime[K]> {
  return new Promise((resolve, reject) => {
    queue.push({ args, method, reject, resolve });
    next();
  }) as ReturnType<Runtime[K]>;
}

export async function closeOfficeRuntime() {
  await worker?.terminate();
}
