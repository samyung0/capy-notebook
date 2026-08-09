import type { MaterialRef } from '@/api/types';
import { MATERIAL_RENDER_WARNING } from '@/lib/const';

export type HeavyMaterialReason = 'nodes' | 'size';

export interface HeavyMaterial {
  nodeCount: number;
  reason: HeavyMaterialReason;
  sizeBytes: number;
}

/** How the reader chose to open a document the browser warned about. */
export type HeavyMaterialChoice = 'interactive' | 'readOnly';

type MaterialWeight = Pick<MaterialRef, 'nodeCount' | 'sizeBytes'>;

/**
 * Decides whether opening a document is worth an interstitial. Absent metadata
 * always opens: the list payload is the only cheap source of a document's
 * weight, and a missing entry must not turn into a gate the reader cannot pass.
 */
export function heavyMaterial(
  reference: MaterialWeight | null | undefined
): HeavyMaterial | null {
  if (!reference) return null;
  const { nodeCount, sizeBytes } = reference;
  if (sizeBytes > MATERIAL_RENDER_WARNING.contentBytes) {
    return { nodeCount, reason: 'size', sizeBytes };
  }
  if (nodeCount > MATERIAL_RENDER_WARNING.nodeCount) {
    return { nodeCount, reason: 'nodes', sizeBytes };
  }
  return null;
}
