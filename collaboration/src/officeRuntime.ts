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

// One worker keeps synchronous WASM parsing/export off the WebSocket event loop.
// Operations are serialized by the worker, rather than loading a WASM runtime
// for each keystroke or each active room.
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();

function getWorker() {
  if (worker) return worker;
  const runtimeURL = new URL(
    '../../vendor/betteroffice/shared/office-checkpoint.mjs',
    import.meta.url
  ).href;
  const created = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const runtime = import(workerData);
    let queue = Promise.resolve();
    parentPort.on('message', ({id, method, args}) => {
      queue = queue.then(async () => {
        try { parentPort.postMessage({id, value: await (await runtime)[method](...args)}); }
        catch (error) { parentPort.postMessage({id, error: String(error?.message || error)}); }
      });
    });
  `,
    { eval: true, workerData: runtimeURL }
  );
  created.on(
    'message',
    (message: { id: number; value?: unknown; error?: string }) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
      if (!pending.size) created.unref();
    }
  );
  const fail = (error: Error) => {
    if (worker !== created) return;
    worker = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  created.on('error', fail);
  created.on('exit', (code) =>
    fail(new Error(`Office worker exited (${code})`))
  );
  worker = created;
  return created;
}

export function runOffice<K extends keyof Runtime>(
  method: K,
  ...args: Parameters<Runtime[K]>
): ReturnType<Runtime[K]> {
  const active = getWorker();
  active.ref();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
    active.postMessage({ args, id, method });
  }) as ReturnType<Runtime[K]>;
}

export async function closeOfficeRuntime() {
  await worker?.terminate();
}
