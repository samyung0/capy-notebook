import { EdgelessClipboardConfig } from '@blocksuite/affine/blocks/surface';
import type { BlockSnapshot } from '@blocksuite/affine/store';

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
      return this.crud.addBlock(flavour, props, this.surface.model.id);
    }
  };
  // BlockSuite's container keys a class by its name: one per flavour.
  Object.defineProperty(config, 'name', { value: `CapyClipboard:${flavour}` });
  return config;
}
