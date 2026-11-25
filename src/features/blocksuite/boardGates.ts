import { createElementsFromClipboardDataCommand } from '@blocksuite/affine/blocks/root';
import {
  autoArrangeElementsCommand,
  autoResizeElementsCommand,
  EdgelessCRUDIdentifier,
  type SurfaceBlockModel,
} from '@blocksuite/affine/blocks/surface';
import {
  createGroupCommand,
  createGroupFromSelectedCommand,
  ungroupCommand,
} from '@blocksuite/affine/gfx/group';
import { MindmapElementModel } from '@blocksuite/affine/model';
import type { BlockStdScope } from '@blocksuite/affine/std';
import {
  GfxControllerIdentifier,
  type GfxModel,
  InteractivityIdentifier,
} from '@blocksuite/affine/std/gfx';
import {
  elementsWritten,
  type Gesture,
  gateCommands,
  gateElementUpdates,
  gateNudges,
  gateSelectionWrites,
  gateToolbarWrites,
  longestIndex,
  writesOf,
} from './boardFull';

/** A gesture writing several elements on a full board goes only when a stub
 * for each value it writes fits under the cap (`refusesWrites`, Epo
 * 2026-11-25): a drag, a resize or a rotation of a selection, an arrow key's
 * nudge (heard on `board`), the element toolbar's changes, its alignment
 * menu, a reorder, a note's Scale or height, a mind map's Style or Layout, a
 * Lock or an Unlock of several (`boardWrites`, vendor/blocksuite local change
 * 82), an arrange or an ungroup; a mind map's node dragged off its map adds a
 * map, refused as an add, and one merged into another map counts that map.
 * A selection writes what is selected, what its groups hold, the whole of a
 * mind map it touches and the labels of the connectors hanging on it
 * (`writesOf`). Duplicate (the element toolbar's, ⌘D's) and a paste of
 * copied elements make their copies through one command, a group (a lock of
 * several makes one) through another: adds. Returns the stop. */
export function gateBoardWrites(board: EventTarget, std: BlockStdScope) {
  const { store } = std;
  const gfx = std.get(GfxControllerIdentifier);
  const connectorsOf = (id: string) =>
    (gfx.surface as SurfaceBlockModel | null)?.getConnectors(id) ?? [];
  const written = (models: GfxModel[], gesture: Gesture) =>
    writesOf(models, gesture, connectorsOf);
  gateSelectionWrites(store, std.get(InteractivityIdentifier), written);
  const ungateNudges = gateNudges(board, store, () => {
    const { editing, selectedElements } = gfx.selection;
    // A key on a mind map's node moves the selection, and nothing moves
    // with a locked element selected (`edgeless-keyboard.ts`'s `_move`).
    if (
      editing ||
      selectedElements.some(
        (element) =>
          element.group instanceof MindmapElementModel || element.isLocked()
      )
    )
      return null;
    return written(selectedElements, 'move');
  });
  gateElementUpdates(store, std.get(EdgelessCRUDIdentifier), (id) => {
    const elements = [...elementsWritten(gfx.selection.selectedElements)];
    return elements.some((element) => element.id === id) ? elements : null;
  });
  const longest = () => longestIndex(gfx.gfxElements);
  const ungateToolbar = gateToolbarWrites(store, written, longest);
  gateCommands(
    store,
    std.command,
    {
      adds: [
        createElementsFromClipboardDataCommand,
        createGroupCommand,
        createGroupFromSelectedCommand,
      ],
      places: [autoArrangeElementsCommand, autoResizeElementsCommand],
      ungroup: ungroupCommand,
    },
    () => written(gfx.selection.selectedElements, 'place'),
    longest
  );
  return () => {
    ungateNudges();
    ungateToolbar();
  };
}
