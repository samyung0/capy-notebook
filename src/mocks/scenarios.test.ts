import { describe, expect, it } from 'vitest';
import {
  getMockScenarioHandlers,
  humaCodedError,
  mockScenarioOptions,
} from './scenarios';

describe('mock error scenarios', () => {
  it('keeps scenario identifiers unique and maps network scenarios to handlers', () => {
    const ids = mockScenarioOptions.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(getMockScenarioHandlers('none')).toEqual([]);
    expect(getMockScenarioHandlers('offline')).toEqual([]);
    for (const id of ids) {
      if (id === 'none' || id === 'offline') continue;
      expect(getMockScenarioHandlers(id).length).toBeGreaterThan(0);
    }
  });

  it('builds the Huma coded envelope consumed by the API client', () => {
    expect(
      humaCodedError('storage_quota_exceeded', 'Storage is full.', {
        limitBytes: 10,
        usedBytes: 10,
      })
    ).toEqual({
      detail: 'Storage is full.',
      errors: [
        {
          message: 'storage_quota_exceeded',
          value: { limitBytes: 10, usedBytes: 10 },
        },
      ],
      status: 403,
      title: 'Forbidden',
    });
  });
});
