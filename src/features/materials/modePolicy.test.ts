import { describe, expect, it } from 'vitest';
import { materialModePolicy, resolveMaterialMode } from './modePolicy';

describe('materialModePolicy', () => {
  it('limits viewers to view mode', () => {
    expect(materialModePolicy({ canEdit: false })).toEqual({
      defaultMode: 'view',
      modes: ['view'],
    });
  });

  it('allows editors to edit and view, defaulting to view', () => {
    expect(materialModePolicy({ canEdit: true })).toEqual({
      defaultMode: 'view',
      modes: ['edit', 'view'],
    });
  });

  it('falls back to view when the requested mode is no longer allowed', () => {
    const viewer = materialModePolicy({ canEdit: false });
    expect(resolveMaterialMode('edit', viewer)).toBe('view');
  });
});
