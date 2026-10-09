import {
  type ProviderConstructorProps,
  registerProviderType,
  type UnifiedProvider,
} from '@platejs/yjs';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import {
  type Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import type { Material } from '@/api/types';
import {
  registerMockSourceProvider,
  type SourceProvider,
  type SourceProviderConfig,
  sourceDocOptions,
} from '@/features/files/sourceProvider';
import {
  createMaterialDocumentWithMetrics,
  type MaterialValue,
} from '@/features/materials/document';
import * as db from './db';

/** In-page stand-in for the collaboration sidecar. A room is one Y.Doc that
 * every participant (the app's editor, the source editor, chaos peers) merges
 * into; document and awareness updates fan out to the other participants. */

/** `origin` tags inbound updates the way Hocuspocus tags them with the
 * provider, so consumers can tell remote transactions from their own. */
interface Participant {
  awareness?: Awareness;
  document: Y.Doc;
  origin: object;
}

export interface Room {
  checkpointFailed?: boolean;
  dirty: boolean;
  document: Y.Doc;
  format?: 'text' | 'docx' | 'xlsx' | 'pptx';
  name: string;
  participants: Set<Participant>;
  /** Updates since the last checkpoint, which appends them. */
  pending: Uint8Array[];
  retired?: boolean;
  target: { kind: 'material'; id: string } | { kind: 'source'; id: string };
  version: number;
}

export const rooms = new Map<string, Room>();
// Encoded checkpoints outlive a room, like the other in-memory mock records.
// A checkpoint appends the room's updates since the last one instead of
// re-encoding the document: on a near-limit note that encode cost ~40ms of
// main thread per save at CPU x4, inside the save cycle the editor bench
// budgets, for work the real service does server-side.
interface Checkpoint {
  updates: Uint8Array[];
  version: number;
}
const checkpoints = new Map<string, Checkpoint>();

function checkpointState(checkpoint: Checkpoint): Uint8Array {
  if (checkpoint.updates.length !== 1)
    checkpoint.updates = [Y.mergeUpdates(checkpoint.updates)];
  return checkpoint.updates[0];
}
const REMOTE = 'mock-room';

/** The quiz and flashcard blocks whose materialId an update wrote, as the
 * service reads them (collaboration/src/children.ts childWrites). */
function writtenBlocks(document: Y.Doc, update: Uint8Array) {
  const blocks = new Set<Y.XmlText>();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item && struct.content instanceof Y.ContentAny))
      continue;
    let item: unknown;
    try {
      item = Y.getItem(document.store, struct.id);
    } catch {
      continue;
    }
    if (
      item instanceof Y.Item &&
      !item.deleted &&
      item.parentSub === 'materialId' &&
      item.parent instanceof Y.XmlText
    )
      blocks.add(item.parent);
  }
  return blocks;
}

/** The collaboration service's children pass (collaboration/src/children.ts)
 * for quiz and flashcard blocks a writer's update wrote: a block naming
 * another note's set gets the note's copy, a set already in another block gets
 * its own copy, an unknown one goes. Mock assets all belong to every note, so
 * images need nothing. */
function mockChildrenPass(room: Room, update: Uint8Array) {
  const note = db.materials.find((x) => x.id === room.target.id);
  const written = writtenBlocks(room.document, update);
  if (!(note && written.size)) return;
  const root = room.document.get('content', Y.XmlText);
  const ops = root.toDelta() as Array<{ insert: unknown }>;
  const refOf = (block: unknown) => {
    if (!(block instanceof Y.XmlText)) return '';
    const { materialId, type } = block.getAttributes() as Record<
      string,
      unknown
    >;
    return type === 'material_ref' && typeof materialId === 'string'
      ? materialId
      : '';
  };
  // Sets the blocks the update did not write already hold.
  const kept = new Set(
    ops
      .filter((op) => !written.has(op.insert as Y.XmlText))
      .map((op) => refOf(op.insert))
  );
  const changes: Array<() => void> = [];
  let index = 0;
  for (const op of ops) {
    const block = op.insert;
    const at = index;
    index += typeof block === 'string' ? block.length : 1;
    const materialId = refOf(block);
    if (!(materialId && written.has(block as Y.XmlText))) continue;
    const own =
      db.materials.find((x) => x.id === materialId)?.parentMaterialId ===
      note.id;
    if (own && !kept.has(materialId)) {
      kept.add(materialId);
      continue;
    }
    const copy = db.copyEmbeddedInto(note, materialId);
    if (copy) kept.add(copy);
    changes.push(() =>
      copy
        ? (block as Y.XmlText).setAttribute('materialId', copy)
        : root.delete(at, 1)
    );
  }
  if (!changes.length) return;
  room.document.transact(() => {
    for (const change of changes.reverse()) change();
  }, REMOTE);
}

function createRoom(
  name: string,
  target: Room['target'],
  docOptions?: ReturnType<typeof sourceDocOptions>
): Room {
  const document = new Y.Doc({ gc: true, guid: name, ...docOptions });
  let checkpoint = checkpoints.get(name);
  if (
    !checkpoint &&
    target.id.startsWith('mock-scenario-') &&
    typeof sessionStorage !== 'undefined'
  ) {
    const saved = sessionStorage.getItem(`capy.scenario.room.${name}`);
    if (saved) {
      const parsed = JSON.parse(saved) as { state: number[]; version: number };
      checkpoint = {
        updates: [new Uint8Array(parsed.state)],
        version: parsed.version,
      };
      checkpoints.set(name, checkpoint);
    }
  }
  if (checkpoint) Y.applyUpdate(document, checkpointState(checkpoint));
  const room: Room = {
    dirty: false,
    document,
    name,
    participants: new Set(),
    pending: [],
    target,
    version: checkpoint?.version ?? 0,
  };
  document.on('update', (update: Uint8Array, origin: unknown) => {
    room.dirty = true;
    room.pending.push(update);
    for (const participant of room.participants) {
      if (participant !== origin)
        Y.applyUpdate(participant.document, update, participant.origin);
    }
    if (
      target.kind === 'material' &&
      room.participants.has(origin as Participant)
    )
      setTimeout(() => mockChildrenPass(room, update));
  });
  rooms.set(name, room);
  return room;
}

function materialRoom(name: string, initialValue: MaterialValue): Room {
  const existing = rooms.get(name);
  if (existing) return existing;
  const materialId = name.split(':')[1] ?? '';
  const room = createRoom(name, { id: materialId, kind: 'material' });
  if (!checkpoints.has(name)) {
    room.document
      .get('content', Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(initialValue));
    room.dirty = false;
  }
  return room;
}

/** Source rooms use the sidecar's `source:<fileId>:epoch:<n>` name and hold
 * the file text in `Y.Text('source')`, like the sidecar seeds them. */
export function sourceRoomName(fileId: string, epoch: number) {
  return `source:${fileId}:epoch:${epoch}`;
}

export function sourceRoom(
  fileId: string,
  epoch: number,
  text: string,
  state?: Uint8Array,
  format: Room['format'] = 'text'
): Room {
  const name = sourceRoomName(fileId, epoch);
  const existing = rooms.get(name);
  if (existing) return existing;
  const room = createRoom(
    name,
    { id: fileId, kind: 'source' },
    sourceDocOptions(format)
  );
  room.format = format;
  if (!checkpoints.has(name)) {
    if (state) Y.applyUpdate(room.document, state);
    else room.document.getText('source').insert(0, text);
  }
  room.dirty = false;
  if (fileId.startsWith('mock-scenario-')) rememberCheckpoint(room);
  return room;
}

function persistMaterial(room: Room) {
  const root = yTextToSlateElement(room.document.get('content', Y.XmlText));
  const { document, metrics } = createMaterialDocumentWithMetrics(
    root.children as MaterialValue
  );
  const contentBytes = new TextEncoder().encode(
    JSON.stringify(document)
  ).byteLength;
  const material = db.materials.find((row) => row.id === room.target.id);
  if (material && room.dirty) {
    material.content = document as Material['content'];
    material.contentBytes = contentBytes;
    material.maxDepth = metrics.maxDepth;
    material.nodeCount = metrics.nodeCount;
    material.updatedAt = new Date().toISOString();
  }
  // Keep mounted editors on Yjs; the next detail read refreshes the projection.
  if (room.dirty) {
    void queryClient.invalidateQueries({
      queryKey: qk.material(room.target.id),
      refetchType: 'none',
    });
  }
  return { contentBytes, ...metrics };
}

/** Every writer uses the same mock persistence path, including headless peers
 * and the last participant leaving before its editor's debounce fires. */
export function checkpointRoom(room: Room) {
  if (room.retired) return;
  const metrics =
    room.target.kind === 'material' ? persistMaterial(room) : undefined;
  if (room.dirty) room.version += 1;
  rememberCheckpoint(room);
  room.dirty = false;
  return metrics;
}

function rememberCheckpoint(room: Room) {
  checkpoints.set(room.name, {
    updates: [...(checkpoints.get(room.name)?.updates ?? []), ...room.pending],
    version: room.version,
  });
  room.pending = [];
  if (
    room.target.id.startsWith('mock-scenario-') &&
    typeof sessionStorage !== 'undefined'
  ) {
    sessionStorage.setItem(
      `capy.scenario.room.${room.name}`,
      JSON.stringify({
        state: [...Y.encodeStateAsUpdate(room.document)],
        version: room.version,
      })
    );
  }
}

export function sourceRoomState(room: Room): string {
  return base64(Y.encodeStateAsUpdate(room.document));
}

/** A source's last saved state, as the server's lock-free viewer read
 * (`source-session?view=true`) returns it: the latest epoch's checkpoint once
 * a save landed, null while the published bytes are current. Saving does not
 * publish: the file's link keeps its bytes. */
export function savedSourceState(fileId: string): string | null {
  let latest: { checkpoint: Checkpoint; epoch: number } | null = null;
  for (const [name, checkpoint] of checkpoints) {
    const match = /^source:(.+):epoch:(\d+)$/.exec(name);
    const epoch = Number(match?.[2]);
    if (match?.[1] === fileId && (!latest || epoch > latest.epoch))
      latest = { checkpoint, epoch };
  }
  return latest && latest.checkpoint.version > 0
    ? base64(checkpointState(latest.checkpoint))
    : null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

/** Joins the participant to the room: merges both ways, then relays document
 * and awareness updates until the returned leave function runs. The room is
 * dropped with its last participant. */
export function join(room: Room, participant: Participant) {
  if (rooms.get(room.name) !== room) {
    throw new Error(`Mock room ${room.name} is no longer active`);
  }
  const forward = (update: Uint8Array, origin: unknown) => {
    if (origin !== participant.origin)
      Y.applyUpdate(room.document, update, participant);
  };
  Y.applyUpdate(
    room.document,
    Y.encodeStateAsUpdate(participant.document),
    participant
  );
  Y.applyUpdate(
    participant.document,
    Y.encodeStateAsUpdate(room.document),
    participant.origin
  );
  participant.document.on('update', forward);

  const awareness = participant.awareness;
  const relay = (
    {
      added,
      removed,
      updated,
    }: { added: number[]; removed: number[]; updated: number[] },
    origin: unknown
  ) => {
    if (origin === REMOTE || !awareness) return;
    const update = encodeAwarenessUpdate(awareness, [
      ...added,
      ...updated,
      ...removed,
    ]);
    for (const other of room.participants) {
      if (other !== participant && other.awareness)
        applyAwarenessUpdate(other.awareness, update, REMOTE);
    }
  };
  if (awareness) {
    awareness.on('update', relay);
    // Existing presence, so a late joiner sees cursors already in the room.
    for (const other of room.participants) {
      if (other.awareness && other !== participant) {
        applyAwarenessUpdate(
          awareness,
          encodeAwarenessUpdate(other.awareness, [
            ...other.awareness.getStates().keys(),
          ]),
          REMOTE
        );
      }
    }
  }
  room.participants.add(participant);
  return () => {
    if (!room.participants.delete(participant)) return;
    participant.document.off('update', forward);
    if (awareness) {
      awareness.off('update', relay);
      // Like Hocuspocus on disconnect: the others forget this client, and this
      // client forgets the others but keeps its own state.
      for (const other of room.participants) {
        if (other.awareness)
          removeAwarenessStates(other.awareness, [awareness.clientID], REMOTE);
      }
      removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter(
          (client) => client !== awareness.clientID
        ),
        REMOTE
      );
    }
    if (room.participants.size === 0) {
      const changed = room.dirty;
      if (
        !room.retired &&
        !room.checkpointFailed &&
        !failedSourceSaves.has(room.target.id)
      ) {
        if (changed) checkpointRoom(room);
        else rememberCheckpoint(room);
      }
      rooms.delete(room.name);
      room.document.destroy();
      if (changed && room.target.kind === 'material') {
        void queryClient.invalidateQueries({
          queryKey: qk.material(room.target.id),
        });
      }
    }
  };
}

// The collaboration service as the browser reaches it: not while offline,
// nor while a journey marks it unreachable (kept across a reload, so a
// reopened editor can wait for it).
const UNREACHABLE = 'capy.mock.collaboration.unreachable';
const REACHABILITY = 'capy:mock-collaboration-reachability';
// Unit tests run without a window: always reachable there.
const browser = typeof window !== 'undefined';
// The Office bench's co-editor case edits a source room as a second peer
// (bench/editor/scripts/runtime.office.ts); only in its load-test build.
if (browser && import.meta.env.VITE_LOAD_TEST_SEED === 'true')
  (window as Window & { __capyMockRooms?: typeof rooms }).__capyMockRooms =
    rooms;
function reachable() {
  return (
    !browser ||
    (navigator.onLine && sessionStorage.getItem(UNREACHABLE) !== 'true')
  );
}
export function setCollaborationReachable(value: boolean) {
  if (value) sessionStorage.removeItem(UNREACHABLE);
  else sessionStorage.setItem(UNREACHABLE, 'true');
  window.dispatchEvent(new Event(REACHABILITY));
}

// A note's current room schema, as the service's material_yjs_documents
// row names it (1 until a room moves).
const SCHEMA = 'capy.scenario.schema.';
export function mockMaterialRoom(materialId: string) {
  const schema = browser
    ? Number(sessionStorage.getItem(`${SCHEMA}${materialId}`) ?? 1)
    : 1;
  return `material:${materialId}:schema:${schema}`;
}

/**
 * The service moved a note's room to its next schema while a client was
 * away: a discard of unsaved room state keeps the saved state (`keepState`),
 * a compaction reseeds it from the projection with fresh identities.
 */
export function moveMockMaterialRoom(materialId: string, keepState: boolean) {
  const old = mockMaterialRoom(materialId);
  const schema = Number(old.split(':').at(-1)) + 1;
  const next = `material:${materialId}:schema:${schema}`;
  sessionStorage.setItem(`${SCHEMA}${materialId}`, String(schema));
  const live = rooms.get(old);
  if (live) {
    if (live.dirty) checkpointRoom(live);
    if (!live.participants.size) {
      rooms.delete(old);
      live.document.destroy();
    }
    live.retired = true;
  }
  const saved = checkpoints.get(old);
  if (keepState && saved) {
    checkpoints.set(next, {
      updates: [...saved.updates],
      version: saved.version,
    });
    const stored = sessionStorage.getItem(`capy.scenario.room.${old}`);
    if (stored) sessionStorage.setItem(`capy.scenario.room.${next}`, stored);
  }
}

interface MockCollaborationOptions {
  initialValue: MaterialValue;
  materialId: string;
  name: string;
  onStateless?: (event: { payload: string }) => void;
}

class MockCollaborationProvider implements UnifiedProvider {
  readonly awareness: UnifiedProvider['awareness'];
  readonly document: Y.Doc;
  readonly provider = {
    sendStateless: (payload: string) => this.handleStateless(payload),
  };
  readonly type = 'mock';
  isConnected = false;
  isSynced = false;

  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly onSyncChange?: (isSynced: boolean) => void;
  private readonly options: MockCollaborationOptions;
  private room?: Room;
  private leave?: () => void;
  // Connected unless disconnected on purpose: a lost service reconnects.
  private wanted = false;
  private readonly onReachability = () => {
    if (!reachable()) this.drop();
    else if (this.wanted) this.connect();
  };

  constructor({
    awareness,
    doc,
    onConnect,
    onDisconnect,
    onError,
    onSyncChange,
    options,
  }: ProviderConstructorProps<MockCollaborationOptions>) {
    if (!(awareness && doc)) {
      throw new Error('The mock collaboration provider requires a Y.Doc');
    }
    this.awareness = awareness;
    this.document = doc;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onError = onError;
    this.onSyncChange = onSyncChange;
    this.options = options;
    if (browser)
      for (const type of ['online', 'offline', REACHABILITY])
        window.addEventListener(type, this.onReachability);
  }

  connect = () => {
    this.wanted = true;
    if (this.isConnected || !reachable()) return;
    // The room moved while this editor was away: its token request names the
    // new room, and the editor remounts onto it (NoteEditorCore's token()).
    if (this.options.name !== mockMaterialRoom(this.options.materialId)) {
      void queryClient.invalidateQueries({
        queryKey: ['material', this.options.materialId, 'collaboration-token'],
      });
      return;
    }
    const room = materialRoom(this.options.name, this.options.initialValue);
    this.room = room;
    materialProviders.add(this);
    this.leave = join(room, {
      awareness: this.awareness,
      document: this.document,
      origin: this,
    });
    this.isConnected = true;
    this.isSynced = true;
    this.onConnect?.();
    this.onSyncChange?.(true);
  };

  disconnect = () => {
    this.wanted = false;
    this.drop();
  };

  private drop() {
    if (!this.isConnected) return;
    materialProviders.delete(this);
    this.leave?.();
    this.leave = undefined;
    this.room = undefined;
    this.isConnected = false;
    this.isSynced = false;
    this.onSyncChange?.(false);
    this.onDisconnect?.();
  }

  destroy = () => {
    if (browser)
      for (const type of ['online', 'offline', REACHABILITY])
        window.removeEventListener(type, this.onReachability);
    this.disconnect();
  };

  announceReadOnly() {
    // The service refused this writer's pending update: nothing after the
    // last checkpoint reaches the durable room.
    if (this.room) this.room.retired = true;
    this.options.onStateless?.({
      payload: JSON.stringify({
        room: this.options.name,
        type: 'room-read-only',
      }),
    });
  }

  private handleStateless(payload: string) {
    if (!this.room) return;
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type !== 'checkpoint-request' || typeof event.id !== 'string') {
      return;
    }
    try {
      const metrics = checkpointRoom(this.room);
      this.options.onStateless?.({
        payload: JSON.stringify({
          checkpointIds: [event.id],
          limitCode: null,
          materialId: this.options.materialId,
          metrics,
          type: 'checkpoint-persisted',
          yjsVersion: this.room.version,
        }),
      });
      this.options.onStateless?.({
        payload: JSON.stringify({
          materialId: this.options.materialId,
          type: 'projection-updated',
          yjsVersion: this.room.version,
        }),
      });
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Source editing counterpart: the session handler seeded the room, so
 * connecting is a merge plus a `synced` on the next microtask. A checkpoint
 * saves without publishing; View reads it through the viewer's session. */
class MockSourceProvider implements SourceProvider {
  // The in-page room applies updates synchronously.
  readonly hasUnsyncedChanges = false;
  isAuthenticated = true;
  private readonly config: SourceProviderConfig;
  private readonly leave: () => void;
  private readonly room: Room;

  constructor(config: SourceProviderConfig) {
    const room = rooms.get(config.name);
    if (room?.target.kind !== 'source') {
      throw new Error(`Unknown mock source room ${config.name}`);
    }
    this.config = config;
    this.room = room;
    this.leave = join(room, { document: config.document, origin: this });
    sourceProviders.add(this);
    queueMicrotask(() => config.onSynced?.({ state: true }));
  }

  sendStateless(payload: string) {
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type !== 'checkpoint-request' || typeof event.id !== 'string')
      return;
    const fileId = this.room.target.id;
    if (refusedSourceSaves.delete(fileId)) {
      // Refused for good: the room goes back to its last checkpoint (it is
      // never saved again) and the client keeps its edits for recovery.
      this.room.retired = true;
      const refusal = JSON.stringify({
        checkpointIds: [event.id],
        epoch: Number(this.config.name.split(':')[3]),
        fileId,
        recoverable: false,
        type: 'source-checkpoint-failed',
      });
      queueMicrotask(() => this.config.onStateless?.({ payload: refusal }));
      return;
    }
    if (failedSourceSaves.delete(fileId)) {
      this.room.checkpointFailed = true;
      const receipt = JSON.stringify({
        checkpointIds: [event.id],
        epoch: Number(this.config.name.split(':')[3]),
        fileId,
        recoverable: true,
        type: 'source-checkpoint-failed',
      });
      queueMicrotask(() => this.config.onStateless?.({ payload: receipt }));
      return;
    }
    this.room.checkpointFailed = false;
    checkpointRoom(this.room);
    const epoch = Number(this.config.name.split(':')[3]);
    const receipt = JSON.stringify({
      checkpoint: this.room.version,
      checkpointIds: [event.id],
      epoch,
      fileId,
      type: 'checkpoint-persisted',
    });
    // A round trip, so the receipt lands after the request returns.
    const send = () => this.config.onStateless?.({ payload: receipt });
    if (heldSaveReceipts) heldSaveReceipts.push(send);
    else queueMicrotask(send);
  }

  // The in-page room never closes a connection by itself.
  connect() {}

  disconnect() {
    sourceProviders.delete(this);
    this.isAuthenticated = false;
    this.leave();
    this.config.onDisconnect?.();
  }

  destroy() {
    if (this.isAuthenticated) this.disconnect();
  }

  announceReadOnly() {
    // As for a note: the refused update never reaches the durable room.
    this.room.retired = true;
    this.config.onStateless?.({
      payload: JSON.stringify({
        room: this.config.name,
        type: 'room-read-only',
      }),
    });
  }

  announceEpoch(fileId: string, newEpoch: number) {
    if (this.room.target.id !== fileId) return;
    this.room.retired = true;
    this.config.onStateless?.({
      payload: JSON.stringify({
        fileId,
        newEpoch,
        type: 'source-epoch-changed',
      }),
    });
  }
}

const sourceProviders = new Set<MockSourceProvider>();
const materialProviders = new Set<MockCollaborationProvider>();
/** The collaboration service's refusal once the account freezes: every open
 * room turns read-only for its writer. */
export function announceReadOnly() {
  for (const provider of [...materialProviders, ...sourceProviders])
    provider.announceReadOnly();
}
const failedSourceSaves = new Set<string>();
export function failNextSourceSave(fileId: string) {
  failedSourceSaves.add(fileId);
}
const refusedSourceSaves = new Set<string>();
export function refuseNextSourceSave(fileId: string) {
  refusedSourceSaves.add(fileId);
}
// Save receipts held back, as a room whose store is busy (a peer's save
// running) sends them late; null when receipts go at once.
let heldSaveReceipts: (() => void)[] | null = null;
export function holdSourceSaveReceipts(hold: boolean) {
  if (hold) {
    heldSaveReceipts ??= [];
    return;
  }
  const held = heldSaveReceipts ?? [];
  heldSaveReceipts = null;
  for (const send of held) send();
}
export function announceSourceEpoch(fileId: string, epoch: number) {
  for (const provider of [...sourceProviders])
    provider.announceEpoch(fileId, epoch);
}
export function resetScenarioRooms() {
  failedSourceSaves.clear();
  refusedSourceSaves.clear();
  holdSourceSaveReceipts(false);
  for (const [name, room] of rooms) {
    if (!room.target.id.startsWith('mock-scenario-')) continue;
    if (room.participants.size)
      throw new Error('Close the scenario editor before resetting its room');
    room.document.destroy();
    rooms.delete(name);
  }
  for (const name of checkpoints.keys()) {
    if (name.includes(':mock-scenario-')) checkpoints.delete(name);
  }
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith('capy.scenario.room.') || key.startsWith(SCHEMA))
      sessionStorage.removeItem(key);
  sessionStorage.removeItem(UNREACHABLE);
}

export function registerMockCollaborationProvider() {
  registerProviderType('mock', MockCollaborationProvider);
  registerMockSourceProvider((config) => new MockSourceProvider(config));
}
