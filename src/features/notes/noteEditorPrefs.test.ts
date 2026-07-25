import { describe, expect, it } from 'vitest';

import {
  enabledKey,
  WIDGET_GROUPS,
  type WidgetGroupId,
} from './noteEditorPrefs';

describe('note editor command preferences', () => {
  it('returns enabled groups in canonical UI order', () => {
    const enabled = Object.fromEntries(
      WIDGET_GROUPS.map(({ id }) => [id, id === 'table' || id === 'media'])
    ) as Record<WidgetGroupId, boolean>;

    expect(enabledKey(enabled)).toBe('table,media');
  });

  it('keeps every optional command group represented', () => {
    expect(new Set(WIDGET_GROUPS.map(({ id }) => id))).toEqual(
      new Set([
        'table',
        'callout',
        'columns',
        'math',
        'media',
        'toc',
        'fontStyles',
        'quiz',
        'flashcards',
        'mermaid',
      ])
    );
  });
});
