import { describe, expect, it } from 'vitest';
import { routePaths } from './router';
import { parseCostSearch, parseUserSearch } from './search-params';

describe('ops router', () => {
  it('registers every required route', () => {
    expect(routePaths).toEqual([
      '/',
      '/health',
      '/users',
      '/users/$userId',
      '/costs',
      '/registry',
    ]);
  });

  it('parses user search from the URL', () => {
    expect(parseUserSearch({ q: 'person@example.com' })).toEqual({
      q: 'person@example.com',
    });
    expect(parseUserSearch({ q: 42 })).toEqual({ q: '' });
  });

  it('parses and normalizes cost search parameters', () => {
    expect(
      parseCostSearch({
        from: '2026-08-01',
        groupBy: 'provider',
        to: '2026-08-24',
      })
    ).toEqual({
      from: '2026-08-01',
      groupBy: 'provider',
      to: '2026-08-24',
    });
    expect(
      parseCostSearch({
        from: '2026-08-24',
        groupBy: 'invalid',
        to: '2026-08-01',
      })
    ).toEqual({
      from: '2026-08-01',
      groupBy: 'day',
      to: '2026-08-24',
    });
  });
});
