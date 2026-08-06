import {
  type ProviderConstructorProps,
  registerProviderType,
  type UnifiedProvider,
} from '@platejs/yjs';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import * as Y from 'yjs';
import type { Material } from '@/api/types';
import {
  createMaterialDocumentWithMetrics,
  type MaterialValue,
} from '@/features/materials/document';
import * as db from './db';

interface MockCollaborationOptions {
  initialValue: MaterialValue;
  materialId: string;
  name: string;
  onStateless?: (event: { payload: string }) => void;
}

interface MockRoom {
  document: Y.Doc;
  providers: Set<MockCollaborationProvider>;
  version: number;
}

const rooms = new Map<string, MockRoom>();

function createRoom(name: string, initialValue: MaterialValue): MockRoom {
  const document = new Y.Doc({ gc: true, guid: name });
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(initialValue));
  const room: MockRoom = { document, providers: new Set(), version: 0 };
  document.on('update', (update, origin) => {
    for (const provider of room.providers) {
      if (provider !== origin) provider.receive(update);
    }
  });
  return room;
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
  private room?: MockRoom;

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
    const room =
      rooms.get(this.options.name) ??
      createRoom(this.options.name, this.options.initialValue);
    rooms.set(this.options.name, room);
    this.room = room;
    room.providers.add(this);
    this.document.on('update', this.sendUpdate);
    Y.applyUpdate(this.document, Y.encodeStateAsUpdate(room.document), this);
    this.isConnected = true;
    this.isSynced = true;
    this.onConnect?.();
    this.onSyncChange?.(true);
  };

  disconnect = () => {
    if (!this.isConnected) return;
    this.document.off('update', this.sendUpdate);
    this.room?.providers.delete(this);
    this.room = undefined;
    this.isConnected = false;
    this.isSynced = false;
    this.onSyncChange?.(false);
    this.onDisconnect?.();
  };

  destroy = () => this.disconnect();

  receive(update: Uint8Array) {
    Y.applyUpdate(this.document, update, this);
  }

  private readonly sendUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.room) return;
    Y.applyUpdate(this.room.document, update, this);
  };

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
      const root = yTextToSlateElement(
        this.room.document.get('content', Y.XmlText)
      );
      const { document, metrics } = createMaterialDocumentWithMetrics(
        root.children as MaterialValue
      );
      const material = db.materials.find(
        (candidate) => candidate.id === this.options.materialId
      );
      const contentBytes = new TextEncoder().encode(
        JSON.stringify(document)
      ).byteLength;
      if (material) {
        material.content = document as Material['content'];
        material.contentBytes = contentBytes;
        material.maxDepth = metrics.maxDepth;
        material.nodeCount = metrics.nodeCount;
        material.updatedAt = new Date().toISOString();
      }
      this.room.version += 1;
      this.options.onStateless?.({
        payload: JSON.stringify({
          checkpointIds: [event.id],
          limitCode: null,
          materialId: this.options.materialId,
          metrics: { contentBytes, ...metrics },
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

export function registerMockCollaborationProvider() {
  registerProviderType('mock', MockCollaborationProvider);
}
