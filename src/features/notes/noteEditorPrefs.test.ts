import { describe, expect, it } from 'vitest';

import {
  enabledKey,
  useNoteEditorPrefs,
  WIDGET_GROUPS,
  type WidgetGroupId,
} from './noteEditorPrefs';

describe('note editor command preferences', () => {
  it('returns enabled groups in canonical UI order', () => {
    const enabled = Object.fromEntries(
      WIDGET_GROUPS.map(({ id }) => [
        id,
        id === 'fileOperations' || id === 'blockElements',
      ])
    ) as Record<WidgetGroupId, boolean>;

    expect(enabledKey(enabled)).toBe('fileOperations,blockElements');
  });

  it('keeps every toolbar group represented', () => {
    expect(new Set(WIDGET_GROUPS.map(({ id }) => id))).toEqual(
      new Set([
        'history',
        'fileOperations',
        'general',
        'fontStyles',
        'textDecorations',
        'inlineElements',
        'blockDecorations',
        'blockElements',
        'indentation',
      ])
    );
  });

  it('hides indentation by default', () => {
    const indentation = WIDGET_GROUPS.find(({ id }) => id === 'indentation');

    expect(indentation?.defaultEnabled).toBe(false);
    expect(
      WIDGET_GROUPS.filter(({ defaultEnabled }) => defaultEnabled === false)
    ).toHaveLength(1);
    expect(useNoteEditorPrefs.getState().enabled.indentation).toBe(false);
  });
});
