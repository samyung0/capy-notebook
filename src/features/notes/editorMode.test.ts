import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import { isEditorCommandAllowed, noteEditorStatusLabel } from './editorMode';

describe('editor asset permissions', () => {
  it('gates asset commands without blocking document commands', () => {
    expect(isEditorCommandAllowed({ widget: 'media' }, true)).toBe(true);
    expect(isEditorCommandAllowed({ widget: 'media' }, false)).toBe(false);
    expect(isEditorCommandAllowed({ widget: 'table' }, false)).toBe(true);
  });
});

describe('noteEditorStatusLabel', () => {
  it('formats collaboration status', () => {
    expect(noteEditorStatusLabel(null)).toBeNull();
    expect(noteEditorStatusLabel({ saveState: 'saved' })).toBe(
      m.editor_status_saved()
    );
    expect(noteEditorStatusLabel({ saveState: 'connecting' })).toBe(
      m.editor_connecting()
    );
    expect(noteEditorStatusLabel({ saveState: 'synced' })).toBe(
      m.editor_status_synced()
    );
    expect(noteEditorStatusLabel({ saveState: 'offline' })).toBe(
      m.editor_status_offline()
    );
    expect(noteEditorStatusLabel({ saveState: 'error' })).toBe(
      m.editor_status_unavailable()
    );
  });
});
