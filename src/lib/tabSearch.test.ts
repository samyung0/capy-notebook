import { describe, expect, it } from 'vitest';
import {
  parseBillingSearch,
  parseFilesSearch,
  parseSettingsSearch,
} from './tabSearch';

describe('tab search', () => {
  it('keeps known tabs and drops anything else', () => {
    expect(parseSettingsSearch({ tab: 'llm' })).toEqual({ tab: 'llm' });
    expect(parseSettingsSearch({ tab: 'subscription' })).toEqual({});
    expect(parseBillingSearch({ tab: 'subscription' })).toEqual({
      tab: 'subscription',
    });
    expect(parseBillingSearch({})).toEqual({});
    expect(parseFilesSearch({ tab: 'blocks' })).toEqual({ tab: 'blocks' });
    expect(parseFilesSearch({ tab: 'llm' })).toEqual({});
  });
});
