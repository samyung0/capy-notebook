import { EdgelessClipboardConfig } from '@blocksuite/affine/blocks/surface';
import type { BlockSnapshot } from '@blocksuite/affine/store';
import { embedFits } from './boardLoad';

/** Copy, paste and Duplicate for one of the workspace canvas's own blocks: the block
 * again with these props at its new place (Epo 2026-11-09). BlockSuite skips a block
 * without one. Only the workspace canvas registers them. */
export function copiesOnCanvas(flavour: string, keys: readonly string[]) {
  const config = class extends EdgelessClipboardConfig {
    static override readonly key = flavour;

    override createBlock(snapshot: BlockSnapshot) {
      if (!this.surface) return null;
      const props = Object.fromEntries(
        ['xywh', 'rotate', ...keys].map((key) => [key, snapshot.props[key]])
      );
      // A clipboard any page can write: one the load check would refuse never lands.
      if (!embedFits(flavour, props)) return null;
      return this.crud.addBlock(flavour, props, this.surface.model.id);
    }
  };
  // BlockSuite's container makes a class's id from its name, and refuses a class
  // without one, as this returned class would be.
  Object.defineProperty(config, 'name', { value: `CapyClipboard:${flavour}` });
  return config;
}
