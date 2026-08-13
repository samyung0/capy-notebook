import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import {
  canCreateExternalEditorAssets,
  isEditorCommandAllowed,
  noteEditorStatusLabel,
} from './editorMode';

describe('comment mode plugin gates', () => {
  it('prevents document and asset mutations in comment mode', () => {
    expect(canCreateExternalEditorAssets('comment')).toBe(false);
    expect(isEditorCommandAllowed('comment', { widget: 'media' })).toBe(false);
    expect(isEditorCommandAllowed('comment', {})).toBe(false);
    expect(isEditorCommandAllowed('comment', { widget: 'table' })).toBe(false);
  });

  it('allows asset commands in edit mode', () => {
    expect(canCreateExternalEditorAssets('edit')).toBe(true);
    expect(isEditorCommandAllowed('edit', { widget: 'media' })).toBe(true);
  });

  it('blocks asset commands for content-only shared editors', () => {
    expect(canCreateExternalEditorAssets('edit', false)).toBe(false);
    expect(isEditorCommandAllowed('edit', { widget: 'media' }, false)).toBe(
      false
    );
    expect(isEditorCommandAllowed('edit', { widget: 'table' }, false)).toBe(
      true
    );
  });
});

describe('noteEditorStatusLabel', () => {
  it('formats collaboration status', () => {
    expect(noteEditorStatusLabel(null)).toBeNull();
    expect(noteEditorStatusLabel({ mode: 'edit', saveState: 'saved' })).toBe(
      m.editor_status_saved()
    );
    expect(
      noteEditorStatusLabel({ mode: 'comment', saveState: 'connecting' })
    ).toBe(m.editor_connecting());
    expect(noteEditorStatusLabel({ mode: 'edit', saveState: 'synced' })).toBe(
      m.editor_status_synced()
    );
    expect(noteEditorStatusLabel({ mode: 'edit', saveState: 'offline' })).toBe(
      m.editor_status_offline()
    );
    expect(noteEditorStatusLabel({ mode: 'edit', saveState: 'error' })).toBe(
      m.editor_status_unavailable()
    );
  });
});
