import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { getMaterialCollaborationToken } from '@/api/hooks';
import {
  RoomProvider,
  type RoomProviderConfig,
} from '@/features/collaboration/roomProvider';
import type { MaterialValue } from '@/features/materials/document';

/* A blocks-layout note's room (todo-blocksuite-spike.md, step 1 piece 3):
 * its Y.Doc joined through a room provider, as an item room joins
 * (itemRoom.ts). The editor is built only once the room synced, which is
 * after the provider adopted the token's client id (Q213): before that a
 * write would go under an id the room refuses (`unassigned`). */

export type BlocksProvider = Pick<RoomProvider, 'connect' | 'destroy'>;

export interface BlocksProviderConfig extends RoomProviderConfig {
  /** The room's seed under MSW: the material's stored content. */
  initialValue: MaterialValue;
  materialId: string;
}

let mockFactory: ((config: BlocksProviderConfig) => BlocksProvider) | null =
  null;

export function registerMockBlocksProvider(
  factory: (config: BlocksProviderConfig) => BlocksProvider
) {
  mockFactory = factory;
}

/** Under MSW the in-page room stands in for the collaboration server. */
function createBlocksProvider(config: BlocksProviderConfig): BlocksProvider {
  if (USE_MSW) {
    if (!mockFactory) throw new Error('Mock blocks provider is not registered');
    return mockFactory(config);
  }
  return new RoomProvider(config);
}

export type BlocksRoomState =
  | { status: 'connecting' }
  | { status: 'ready'; readonly: boolean }
  | { status: 'unavailable' };

export class BlocksRoom {
  readonly doc = new Y.Doc();
  /** The editor's selections (`selectionV2`) ride on the room's awareness
   * beside its other fields; a read channel shares none (AU:10). */
  readonly awareness = new Awareness(this.doc);
  private provider: BlocksProvider | null = null;
  private state: BlocksRoomState = { status: 'connecting' };
  private destroyed = false;
  private readonly listeners = new Set<() => void>();

  readonly materialId: string;
  private readonly initialValue: MaterialValue;

  constructor(materialId: string, initialValue: MaterialValue) {
    this.materialId = materialId;
    this.initialValue = initialValue;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.state;

  private set(state: BlocksRoomState) {
    if (this.destroyed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async start() {
    let first: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
    try {
      first = await getMaterialCollaborationToken(this.materialId);
    } catch {
      this.set({ status: 'unavailable' });
      return;
    }
    if (this.destroyed) return;
    const readonly = first.access !== 'write';
    let cached: string | null = first.token;
    let last: string | undefined;
    this.provider = createBlocksProvider({
      awareness: readonly ? null : this.awareness,
      document: this.doc,
      initialValue: this.initialValue,
      materialId: this.materialId,
      name: first.room,
      // Refused or closed for good: the note stays unavailable until it is
      // opened again (no retries in this step).
      onAuthenticationFailed: () => this.set({ status: 'unavailable' }),
      onSynced: ({ state }) => {
        if (state && this.state.status === 'connecting')
          this.set({ readonly, status: 'ready' });
      },
      token: async (previous) => {
        if (cached) {
          last = cached;
          cached = null;
          return last;
        }
        const fresh = await getMaterialCollaborationToken(this.materialId, {
          previousToken: previous ?? last,
        });
        last = fresh.token;
        return fresh.token;
      },
      url: first.url,
    });
    this.provider.connect();
  }

  destroy() {
    this.destroyed = true;
    this.listeners.clear();
    this.provider?.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
