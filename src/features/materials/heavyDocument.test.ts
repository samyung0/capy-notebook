import { describe, expect, it } from 'vitest';
import { MATERIAL_DOCUMENT_LIMITS, MATERIAL_RENDER_WARNING } from '@/lib/const';
import { heavyMaterial } from './heavyDocument';

const light = { nodeCount: 10, sizeBytes: 4096 };

describe('heavyMaterial', () => {
  it('opens an ordinary document without an interstitial', () => {
    expect(heavyMaterial(light)).toBeNull();
  });

  it('opens without an interstitial when the weight is unknown', () => {
    expect(heavyMaterial(null)).toBeNull();
    expect(heavyMaterial(undefined)).toBeNull();
  });

  it('warns once the document is larger than this browser is comfortable with', () => {
    expect(
      heavyMaterial({
        ...light,
        sizeBytes: MATERIAL_RENDER_WARNING.contentBytes + 1,
      })
    ).toMatchObject({ reason: 'size' });
    expect(
      heavyMaterial({
        ...light,
        nodeCount: MATERIAL_RENDER_WARNING.nodeCount + 1,
      })
    ).toMatchObject({ reason: 'nodes' });
  });

  // The durability caps gate writes on the server; a document that exceeded
  // them (an operator import, a bypassed account, a limit lowered afterwards)
  // must still be reachable, just behind a warning.
  it('warns rather than refuses when the document is past the write caps', () => {
    expect(
      heavyMaterial({
        nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes * 2,
        sizeBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes * 2,
      })
    ).toMatchObject({ reason: 'size' });
  });

  it('keeps the render thresholds below the write caps', () => {
    expect(MATERIAL_RENDER_WARNING.contentBytes).toBeLessThan(
      MATERIAL_DOCUMENT_LIMITS.maxContentBytes
    );
    expect(MATERIAL_RENDER_WARNING.nodeCount).toBeLessThan(
      MATERIAL_DOCUMENT_LIMITS.maxNodes
    );
  });
});
