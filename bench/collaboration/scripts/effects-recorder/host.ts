// The recorder's stand-in for Capy around the Office runtime frame: per peer
// one Yjs doc built as useSourceSession builds it, wired exactly as
// useOfficeRuntime.ts (runtime <-> doc) and roomProvider.ts (doc <-> server)
// wire it, plus a relay in place of the collaboration server. Every update
// the doc emits that roomProvider would send is recorded with the runtime's
// own bytes beside it. Driven by record.ts through `window.recorder`.
import * as Y from 'yjs';
import { OFFICE_PROTOCOL_VERSION } from '@/features/files/officeProtocol';
import { sourceDocOptions } from '@/features/files/sourceProvider';

type Format = 'docx' | 'pptx' | 'xlsx';
type Source = 'open' | 'edit' | 'flush' | 'host';
const EPOCH = 1;
const IFRAME = Symbol('source-iframe'); // SOURCE_IFRAME_ORIGIN
const t0 = performance.now();
const now = () => Math.round((performance.now() - t0) * 10) / 10;

const b64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

interface Wire {
  order: number;
  peer: string;
  seq: number;
  t: number;
  source: Source;
  step: number;
  bytes: string;
  raw: string | null;
}
interface Peer {
  name: string;
  frame: HTMLIFrameElement;
  doc: Y.Doc;
  provider: object; // the room provider's origin for server updates
  seq: number;
  rawSeq: number;
  pendingRaw: { bytes: Uint8Array; source: Source } | null;
  initialized: Promise<void>;
  ready: Promise<unknown>;
  collaborationReady: Promise<void>;
  menus: unknown;
  replies: Map<string, (bytes: Uint8Array) => void>;
  resolve: Record<string, (value?: unknown) => void>;
  loaded: boolean;
}

const peers: Peer[] = [];
const log = {
  updates: [] as Wire[],
  raws: [] as { peer: string; rawSeq: number; t: number; bytes: number; wire: number | null }[],
  steps: [] as { i: number; peer: string; t: number; action: string; detail: string }[],
  messages: [] as { peer: string; t: number; type: string; detail?: unknown }[],
};
let order = 0;
let held = false;
const queue: { from: Peer; bytes: Uint8Array }[] = [];

function post(peer: Peer, message: Record<string, unknown>, transfer: Transferable[] = []) {
  peer.frame.contentWindow!.postMessage(
    { ...message, version: OFFICE_PROTOCOL_VERSION },
    location.origin,
    transfer
  );
}

function deliver(from: Peer, bytes: Uint8Array) {
  for (const peer of peers) if (peer !== from) Y.applyUpdate(peer.doc, bytes, peer.provider);
}

function clientOf(bytes: Uint8Array): number | null {
  const { structs } = Y.decodeUpdate(bytes);
  return structs.length ? structs[0]!.id.client : null;
}

function makePeer(name: string, format: Format): Peer {
  const frame = document.createElement('iframe');
  frame.id = `peer-${name}`;
  frame.name = `peer-${name}`;
  // As Capy's frame (officeRuntimeConfig.ts).
  frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  const resolve: Peer['resolve'] = {};
  const promise = (key: string) => new Promise<unknown>((r) => (resolve[key] = r));
  const peer: Peer = {
    name,
    frame,
    doc: new Y.Doc(sourceDocOptions(format)),
    provider: { name: `provider-${name}` },
    seq: 0,
    rawSeq: 0,
    pendingRaw: null,
    initialized: promise('initialized') as Promise<void>,
    ready: promise('ready'),
    collaborationReady: promise('collaboration-ready') as Promise<void>,
    menus: null,
    replies: new Map(),
    resolve,
    loaded: false,
  };
  peer.doc.on('update', (update: Uint8Array, origin: unknown) => {
    // roomProvider.documentUpdate: all but the server's own go to the server.
    if (origin !== peer.provider) {
      const raw = origin === IFRAME ? peer.pendingRaw : null;
      const wire: Wire = {
        order: ++order,
        peer: name,
        seq: ++peer.seq,
        t: now(),
        source: raw?.source ?? 'host',
        step: log.steps.length - 1,
        bytes: b64(update),
        // A full replica state (open, flush) is not kept as raw: it is the whole doc.
        raw: raw && raw.source === 'edit' ? b64(raw.bytes) : null,
      };
      log.updates.push(wire);
      if (raw) log.raws[log.raws.length - 1]!.wire = wire.order;
      if (held) queue.push({ from: peer, bytes: update });
      else deliver(peer, update);
    }
    // useOfficeRuntime: all but the frame's own go to the frame (once loaded:
    // before that the initial update carries them).
    if (origin !== IFRAME && peer.loaded) {
      const bytes = update.slice().buffer;
      post(peer, { bytes, epoch: EPOCH, type: 'update' }, [bytes]);
    }
  });
  return peer;
}

function fromFrame(peer: Peer, bytes: ArrayBuffer, source: Source) {
  const update = new Uint8Array(bytes);
  peer.pendingRaw = { bytes: update, source };
  log.raws.push({ peer: peer.name, rawSeq: ++peer.rawSeq, t: now(), bytes: update.length, wire: null });
  Y.applyUpdate(peer.doc, update, IFRAME);
  peer.pendingRaw = null;
}

window.addEventListener('message', (event: MessageEvent) => {
  const peer = peers.find((p) => p.frame.contentWindow === event.source);
  if (!peer || event.origin !== location.origin) return;
  const message = event.data as { type: string; [key: string]: unknown };
  const brief =
    message.type === 'error' || message.type === 'notice' || message.type === 'mode' || message.type === 'dirty'
      ? (message.message ?? message.notice ?? message.mode ?? message.dirty)
      : undefined;
  if (message.type !== 'update' && message.type !== 'menus')
    log.messages.push({ peer: peer.name, t: now(), type: message.type, detail: brief });
  switch (message.type) {
    case 'initialized':
      peer.resolve.initialized?.();
      break;
    case 'ready':
      peer.resolve.ready?.(message.analysis);
      break;
    case 'menus':
      peer.menus = { menus: message.menus, actions: message.actions };
      break;
    case 'update':
      fromFrame(peer, message.bytes as ArrayBuffer, 'edit');
      break;
    case 'collaboration-ready': {
      // useOfficeRuntime: the replica's state in, then what it lacks out.
      const state = new Uint8Array(message.bytes as ArrayBuffer);
      fromFrame(peer, message.bytes as ArrayBuffer, 'open');
      const catchUp = Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVectorFromUpdate(state));
      const bytes = catchUp.slice().buffer;
      post(peer, { bytes, epoch: EPOCH, type: 'update' }, [bytes]);
      peer.resolve['collaboration-ready']?.();
      break;
    }
    case 'flushed':
    case 'exported': {
      const reply = peer.replies.get(message.id as string);
      peer.replies.delete(message.id as string);
      if (message.type === 'flushed') fromFrame(peer, message.bytes as ArrayBuffer, 'flush');
      reply?.(new Uint8Array(message.bytes as ArrayBuffer));
      break;
    }
  }
});

function ask(peer: Peer, type: 'flush' | 'export'): Promise<Uint8Array> {
  const id = `${type}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    peer.replies.set(id, resolve);
    setTimeout(() => reject(new Error(`${type} timed out for ${peer.name}`)), 60_000);
    post(peer, type === 'flush' ? { epoch: EPOCH, id, type } : { id, type });
  });
}

const byName = (name: string) => {
  const peer = peers.find((p) => p.name === name);
  if (!peer) throw new Error(`no peer ${name}`);
  return peer;
};

const recorder = {
  async start(options: {
    format: Format;
    fileName: string;
    file: string;
    seed: string;
    peers: string[];
    imageMaxBytes?: number;
  }) {
    const file = unb64(options.file);
    const seed = unb64(options.seed);
    for (const name of options.peers) {
      const peer = makePeer(name, options.format);
      // The server's sync step 2 (the room = seed at epoch start).
      Y.applyUpdate(peer.doc, seed, peer.provider);
      peers.push(peer);
      document.getElementById('peers')!.appendChild(peer.frame);
      peer.frame.src = `/office-runtime.html?parentOrigin=${encodeURIComponent(location.origin)}`;
    }
    for (const peer of peers) {
      await peer.initialized;
      post(peer, {
        compact: false,
        locale: 'en',
        narrow: false,
        style: 'classroom',
        theme: 'latte',
        type: 'set-appearance',
      });
      const bytes = file.slice().buffer;
      const initialUpdate = Y.encodeStateAsUpdate(peer.doc).slice().buffer;
      post(
        peer,
        {
          bytes,
          canEdit: true,
          collaboration: { epoch: EPOCH, initialUpdate },
          fileName: options.fileName,
          format: options.format,
          imageMaxBytes: options.imageMaxBytes ?? 10 * 1024 * 1024,
          mode: 'edit',
          revision: 1,
          type: 'load',
        },
        [bytes, initialUpdate]
      );
      peer.loaded = true;
      post(peer, { canEdit: true, type: 'set-capabilities' });
    }
    await Promise.all(peers.map((p) => Promise.all([p.ready, p.collaborationReady])));
    return { t: now() };
  },
  step(peer: string, action: string, detail = '') {
    log.steps.push({ i: log.steps.length, peer, t: now(), action, detail });
  },
  menu(peer: string, id: string, value?: string) {
    post(byName(peer), value === undefined ? { id, type: 'menu-command' } : { id, type: 'menu-command', value });
  },
  menuFile(peer: string, id: string, name: string, mimeType: string, data: string) {
    const bytes = unb64(data).slice().buffer;
    post(byName(peer), { bytes, id, mimeType, name, type: 'menu-file' }, [bytes]);
  },
  focusLeft(peer: string) {
    post(byName(peer), { type: 'focus-left' });
  },
  hold() {
    held = true;
  },
  release() {
    held = false;
    for (const { from, bytes } of queue.splice(0)) deliver(from, bytes);
  },
  async flush(peer: string) {
    return b64(await ask(byName(peer), 'flush'));
  },
  async exportFile(peer: string) {
    return b64(await ask(byName(peer), 'export'));
  },
  menus(peer: string) {
    return byName(peer).menus;
  },
  clientIds() {
    const ids: Record<string, number | null> = {};
    for (const peer of peers) {
      const own = log.updates.find((u) => u.peer === peer.name && u.source === 'edit');
      ids[peer.name] = own ? clientOf(unb64(own.bytes)) : null;
    }
    return ids;
  },
  hostState(peer: string) {
    return b64(Y.encodeStateAsUpdate(byName(peer).doc));
  },
  dump() {
    return { ...log, t: now(), clientIds: recorder.clientIds() };
  },
};

// The driver's view of it: drivers.ts declares `window.recorder`.
(window as unknown as { recorder: typeof recorder }).recorder = recorder;
