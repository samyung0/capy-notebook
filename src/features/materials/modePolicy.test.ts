import { describe, expect, it } from 'vitest';
import { materialModePolicy, resolveMaterialMode } from './modePolicy';

describe('materialModePolicy', () => {
  it('limits viewers to view mode', () => {
    expect(materialModePolicy('note', { canEdit: false })).toEqual({
      defaultMode: 'view',
      modes: ['view'],
    });
    expect(materialModePolicy('quiz', { canEdit: false })).toEqual({
      defaultMode: 'view',
      modes: ['view'],
    });
  });

  it('allows editors to edit, comment, and view', () => {
    expect(materialModePolicy('note', { canEdit: true })).toEqual({
      defaultMode: 'edit',
      modes: ['edit', 'comment', 'view'],
    });
  });

  it('defaults editable quiz and flashcard materials to view mode', () => {
    expect(materialModePolicy('quiz', { canEdit: true })).toEqual({
      defaultMode: 'view',
      modes: ['edit', 'comment', 'view'],
    });
    expect(materialModePolicy('flashcards', { canEdit: true })).toEqual({
      defaultMode: 'view',
      modes: ['edit', 'comment', 'view'],
    });
  });

  it('falls back when a requested mode is no longer allowed', () => {
    const viewer = materialModePolicy('note', { canEdit: false });
    expect(resolveMaterialMode('edit', viewer)).toBe('view');
    expect(resolveMaterialMode('comment', viewer)).toBe('view');
  });
});
