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
  dirty: boolean;
  document: Y.Doc;
  name: string;
  participants: Set<Participant>;
  target: { kind: 'material'; id: string } | { kind: 'source'; id: string };
  version: number;
}

export const rooms = new Map<string, Room>();
// Encoded checkpoints outlive a room, like the other in-memory mock records.
const checkpoints = new Map<string, { state: Uint8Array; version: number }>();
const REMOTE = 'mock-room';

function createRoom(name: string, target: Room['target']): Room {
  const document = new Y.Doc({ gc: true, guid: name });
  const checkpoint = checkpoints.get(name);
  if (checkpoint) Y.applyUpdate(document, checkpoint.state);
  const room: Room = {
    dirty: false,
    document,
    name,
    participants: new Set(),
    target,
    version: checkpoint?.version ?? 0,
  };
  document.on('update', (update: Uint8Array, origin: unknown) => {
    room.dirty = true;
    for (const participant of room.participants) {
      if (participant !== origin)
        Y.applyUpdate(participant.document, update, participant.origin);
    }
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

export function sourceRoom(fileId: string, epoch: number, text: string): Room {
  const name = sourceRoomName(fileId, epoch);
  const existing = rooms.get(name);
  if (existing) return existing;
  const room = createRoom(name, { id: fileId, kind: 'source' });
  if (!checkpoints.has(name)) room.document.getText('source').insert(0, text);
  room.dirty = false;
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
  const metrics =
    room.target.kind === 'material' ? persistMaterial(room) : undefined;
  if (room.target.kind === 'source' && room.dirty) {
    db.fileLinks[room.target.id] = {
      ...db.fileLinks[room.target.id],
      url: db.textUrl(room.document.getText('source').toString()),
    };
  }
  if (room.dirty) room.version += 1;
  rememberCheckpoint(room);
  room.dirty = false;
  return metrics;
}

function rememberCheckpoint(room: Room) {
  checkpoints.set(room.name, {
    state: Y.encodeStateAsUpdate(room.document),
    version: room.version,
  });
}

export function sourceRoomState(room: Room): string {
  const bytes = Y.encodeStateAsUpdate(room.document);
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
      if (changed) checkpointRoom(room);
      else rememberCheckpoint(room);
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
  }

  connect = () => {
    if (this.isConnected) return;
    const room = materialRoom(this.options.name, this.options.initialValue);
    this.room = room;
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
    if (!this.isConnected) return;
    this.leave?.();
    this.leave = undefined;
    this.room = undefined;
    this.isConnected = false;
    this.isSynced = false;
    this.onSyncChange?.(false);
    this.onDisconnect?.();
  };

  destroy = () => this.disconnect();

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
 * writes the text back to the file's mock link so View shows the edit. */
class MockSourceProvider implements SourceProvider {
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
    queueMicrotask(() => this.config.onStateless?.({ payload: receipt }));
  }

  disconnect() {
    this.isAuthenticated = false;
    this.leave();
    this.config.onDisconnect?.();
  }

  destroy() {
    if (this.isAuthenticated) this.disconnect();
  }
}

export function registerMockCollaborationProvider() {
  registerProviderType('mock', MockCollaborationProvider);
  registerMockSourceProvider((config) => new MockSourceProvider(config));
}
