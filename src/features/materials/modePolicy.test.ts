import { describe, expect, it } from 'vitest';
import { materialModePolicy, resolveMaterialMode } from './modePolicy';

describe('materialModePolicy', () => {
  it('limits viewers to view mode', () => {
    expect(
      materialModePolicy('note', { canComment: false, canEdit: false })
    ).toEqual({
      defaultMode: 'view',
      modes: ['view'],
    });
    expect(
      materialModePolicy('quiz', { canComment: false, canEdit: false })
    ).toEqual({
      defaultMode: 'view',
      modes: ['view'],
    });
  });

  it('allows commenters to comment but not edit', () => {
    expect(
      materialModePolicy('note', { canComment: true, canEdit: false })
    ).toEqual({
      defaultMode: 'comment',
      modes: ['comment', 'view'],
    });
  });

  it('allows editors to edit, comment, and view', () => {
    expect(
      materialModePolicy('note', { canComment: true, canEdit: true })
    ).toEqual({
      defaultMode: 'edit',
      modes: ['edit', 'comment', 'view'],
    });
  });

  it('defaults editable quiz and flashcard materials to view mode', () => {
    const capabilities = { canComment: true, canEdit: true };
    expect(materialModePolicy('quiz', capabilities)).toEqual({
      defaultMode: 'view',
      modes: ['edit', 'comment', 'view'],
    });
    expect(materialModePolicy('flashcards', capabilities)).toEqual({
      defaultMode: 'view',
      modes: ['edit', 'comment', 'view'],
    });
  });

  it('treats canEdit as authoritative even when canComment is false', () => {
    expect(
      materialModePolicy('note', { canComment: false, canEdit: true }).modes
    ).toEqual(['edit', 'comment', 'view']);
  });

  it('falls back when a requested mode is no longer allowed', () => {
    const viewer = materialModePolicy('note', {
      canComment: false,
      canEdit: false,
    });
    expect(resolveMaterialMode('edit', viewer)).toBe('view');
  });
});
