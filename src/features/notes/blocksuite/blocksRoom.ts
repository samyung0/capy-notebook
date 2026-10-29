import { USE_MSW } from '@/api/auth';
import { type ItemProvider, ItemRoom } from '@/features/collaboration/itemRoom';
import { NoteSeat } from '@/features/collaboration/noteSeat';
import type { RoomProviderConfig } from '@/features/collaboration/roomProvider';
import type { MaterialValue } from '@/features/materials/document';

/* A blocks-layout note's room (todo-blocksuite-spike.md, step 1 piece 3):
 * an item room over the note's Y.Doc, whose lifecycle is layout-neutral
 * (it moves Yjs updates only). Offline it keeps editing with every local
 * update stored as a draft (editDrafts, PE:97), restores and syncs them at
 * the next open of the same room, and opens refused, other-lineage and
 * expired drafts read-only for copying (the merge view has no blocks
 * counterpart yet). The editor is built only once the room synced, which is
 * after the provider adopted the token's client id (Q213): before that a
 * write would go under an id the room refuses (`unassigned`). */

export interface BlocksProviderConfig extends RoomProviderConfig {
  /** The room's seed under MSW: the material's stored content. */
  initialValue: MaterialValue;
  materialId: string;
}

let mockFactory: ((config: BlocksProviderConfig) => ItemProvider) | null = null;

export function registerMockBlocksProvider(
  factory: (config: BlocksProviderConfig) => ItemProvider
) {
  mockFactory = factory;
}

export interface BlocksRoom {
  readonly materialId: string;
  readonly room: ItemRoom;
  /** The channel the note's embedded quizzes and sets join inside, as on
   * Plate (NoteEditorCore). MSW's rooms have none. */
  readonly seat: NoteSeat;
}

/** The note's room, not started. `onReplace`: it ended here for good
 * (refused, moved to a new lineage, recovery left), and a fresh one takes
 * its place. */
export function createBlocksRoom(
  materialId: string,
  initialValue: MaterialValue,
  { actorId, onReplace }: { actorId: string; onReplace: () => void }
): BlocksRoom {
  const seat = new NoteSeat();
  const room = new ItemRoom(materialId, {
    // The editor's selections (`selectionV2`) ride on the room's awareness.
    awareness: true,
    drafts: { actorId },
    leave: 'unstored',
    onReplace,
    // Under MSW the in-page room stands in for the collaboration server.
    provider: USE_MSW
      ? (config) => {
          if (!mockFactory)
            throw new Error('Mock blocks provider is not registered');
          return mockFactory({ ...config, initialValue, materialId });
        }
      : undefined,
    seat,
  });
  return { materialId, room, seat };
}
