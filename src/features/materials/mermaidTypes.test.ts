import { expect, it } from 'vitest';
import { MERMAID_SOURCES } from '../../../e2e/fixtures/mermaid-sources';
import { MERMAID_TYPES } from './mermaidTypes';

// Epo 2026-10-23: the worker draws only the types the geometry check covers
// (mermaid-geometry.spec.ts draws one source per type).
it('allows exactly the types the geometry check draws', () => {
  expect(Object.keys(MERMAID_TYPES).sort()).toEqual(
    Object.keys(MERMAID_SOURCES).sort()
  );
});
