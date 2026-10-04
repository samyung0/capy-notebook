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
  /** Edits saved after the capture, landed on seed(exported), with their effects against the export. */
  rebaseOffice(
    bytes: Uint8Array,
    captured: OfficeCheckpoint,
    latest: OfficeCheckpoint,
    exported: Uint8Array
  ): Promise<{
    state: Uint8Array;
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
  /** Pending XLSX effects read off the checkpoint's overrides against the base. */
  xlsxPendingEffects(
    bytes: Uint8Array,
    checkpoint: OfficeCheckpoint
  ): Promise<NetEffect[]>;
}

/** A call the Office engine refused, trapped on or did not finish in time.
 * `transient`: it timed out or lost its worker, so the same call may pass. */
export class OfficeEngineError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.transient = transient;
  }
}

export const CALL_TIMEOUT_MS = 120_000;
// A trap leaves wasm-bindgen objects poisoned, and the engine's dispose() or
// free() in `finally` then throws one of these plain errors in place of the
// WebAssembly.RuntimeError, so they count as traps too.
const BROKEN_OBJECT =
  /attempted to take ownership of Rust value while it was borrowed|recursive use of an object detected|null pointer passed to rust/;

interface Call {
  args: unknown[];
  method: string;
  queuedAt: number;
  reject(error: Error): void;
  resolve(value: unknown): void;
  startedAt?: number;
  timer?: NodeJS.Timeout;
}

// One interval of engine calls for the collab_health line: time queued
// behind other calls, time running in the worker, the longest queue and
// timeouts.
let waits: number[] = [];
let runs: number[] = [];
let busyMs = 0;
let queueMax = 0;
let timeouts = 0;
const quantile = (values: number[], p: number) =>
  values.length
    ? Math.round(
        [...values].sort((a, b) => a - b)[
          Math.min(values.length - 1, Math.ceil(p * values.length) - 1)
        ]
      )
    : 0;
/** This interval's engine queue summary; the next interval starts empty. */
export function takeOfficeStats() {
  const now = performance.now();
  // A call still running counts its time so far in this interval.
  const running = active?.startedAt === undefined ? 0 : now - active.startedAt;
  const summary = {
    busy_ms: Math.round(busyMs + running),
    calls: runs.length,
    queue_max: queueMax,
    run_max_ms: Math.round(runs.length ? Math.max(...runs) : 0),
    run_p95_ms: quantile(runs, 0.95),
    timeouts,
    wait_max_ms: Math.round(waits.length ? Math.max(...waits) : 0),
    wait_p95_ms: quantile(waits, 0.95),
  };
  if (active?.startedAt !== undefined) active.startedAt = now;
  waits = [];
  runs = [];
  busyMs = 0;
  queueMax = queue.length;
  timeouts = 0;
  return summary;
}

// One worker keeps synchronous WASM parsing/export off the WebSocket event loop,
// rather than loading a WASM runtime for each keystroke or each active room.
// Calls queue here with one in flight, so each timeout counts only its own
// work. A WebAssembly trap or a timeout fails that call and replaces the
// worker; engine refusals are ordinary results and keep it.
let worker: Worker | undefined;
let active: Call | undefined;
const queue: Call[] = [];
const runtimeURL = new URL(
  '../../vendor/betteroffice/shared/office-checkpoint.mjs',
  import.meta.url
).href;
let documentRoots:
  | Promise<Readonly<Record<OfficeFormat, readonly string[]>>>
  | undefined;

/**
 * The top-level Yjs roots each engine's state may hold, Capy's contributor
 * map included (the bundle's OFFICE_DOCUMENT_ROOTS). Importing the bundle
 * here loads no WASM; engines initialize on first use, in the worker.
 */
export function officeDocumentRoots() {
  documentRoots ??= import(runtimeURL).then(
    (runtime: {
      OFFICE_DOCUMENT_ROOTS: Readonly<Record<OfficeFormat, readonly string[]>>;
    }) => runtime.OFFICE_DOCUMENT_ROOTS,
    (error: unknown) => {
      // A failed import is retried by the next call, not cached.
      documentRoots = undefined;
      throw error;
    }
  );
  return documentRoots;
}

function startWorker() {
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
    finish()?.reject(new OfficeEngineError(error.message, true));
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
  if (call?.startedAt !== undefined) {
    const ran = performance.now() - call.startedAt;
    busyMs += ran;
    runs.push(ran);
  }
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
  call.startedAt = performance.now();
  waits.push(call.startedAt - call.queuedAt);
  worker ??= startWorker();
  worker.ref();
  call.timer = setTimeout(() => {
    if (active !== call) return;
    timeouts += 1;
    finish();
    call.reject(new OfficeEngineError(`Office ${call.method} timed out`, true));
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
    queue.push({ args, method, queuedAt: performance.now(), reject, resolve });
    next();
    // Calls waiting behind the one in flight.
    queueMax = Math.max(queueMax, queue.length);
  }) as ReturnType<Runtime[K]>;
}

export async function closeOfficeRuntime() {
  await worker?.terminate();
}
