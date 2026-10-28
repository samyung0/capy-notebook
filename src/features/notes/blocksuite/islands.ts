import type { MaterialRefKind } from '@/features/materials/document';

/* React inside the BlockSuite note (boundary 4: shared pieces are islands,
 * not copies). A `capy:material-ref` block's view owns a DOM element and
 * publishes it here with the block's props; the note's React tree portals
 * the app's embed into it (`MaterialRefIslands` in BlockSuiteNote.tsx), so
 * the embed keeps the app's providers (queries, the note's seat) and one
 * React root serves every block. */

export interface MaterialRefIsland {
  element: HTMLElement;
  /** The block id. */
  id: string;
  materialId: string;
  refKind: MaterialRefKind;
  /** Removes the block (its last question or card went). */
  remove: () => void;
}

export class BlockIslands {
  private readonly islands = new Map<string, MaterialRefIsland>();
  private snapshot: MaterialRefIsland[] = [];
  private readonly listeners = new Set<() => void>();

  /** Adds or updates a block's island; a repeat of the same props is a
   * no-op. */
  set(island: MaterialRefIsland) {
    const current = this.islands.get(island.id);
    if (
      current &&
      current.element === island.element &&
      current.materialId === island.materialId &&
      current.refKind === island.refKind
    )
      return;
    this.islands.set(island.id, island);
    this.changed();
  }

  /** Drops the block's island, unless another view of it took the id. */
  delete(id: string, element: HTMLElement) {
    if (this.islands.get(id)?.element !== element) return;
    this.islands.delete(id);
    this.changed();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  private changed() {
    this.snapshot = [...this.islands.values()];
    for (const listener of this.listeners) listener();
  }
}
