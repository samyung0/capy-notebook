import { describe, expect, it } from 'vitest';
import { parseSettingsSearch, settingsTab } from './settingsSearch';

describe('settings search', () => {
  it('keeps known tabs and defaults unknown values to general', () => {
    expect(parseSettingsSearch({ tab: 'llm' })).toEqual({ tab: 'llm' });
    expect(parseSettingsSearch({ tab: 'subscription' })).toEqual({
      tab: 'subscription',
    });
    expect(parseSettingsSearch({ tab: 'general' })).toEqual({ tab: 'general' });
    expect(parseSettingsSearch({ tab: 'nope' })).toEqual({});
    expect(parseSettingsSearch({})).toEqual({});
    expect(settingsTab({})).toBe('general');
    expect(settingsTab({ tab: 'llm' })).toBe('llm');
  });
});
