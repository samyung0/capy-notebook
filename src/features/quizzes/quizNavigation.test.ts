import { describe, expect, it } from 'vitest';
import { parseQuizEditSearch, quizEditSearch } from './quizNavigation';

describe('quiz edit return navigation', () => {
  it.each([
    '/materials/qz_1?mode=edit',
    '/materials/qz_1',
    '/workspaces/ws_1?material=qz_1&mode=edit',
  ])('returns %s to an explicit preview', (href) => {
    const { returnTo } = quizEditSearch(href, true);
    const url = new URL(returnTo!, 'https://capy.invalid');
    expect(url.searchParams.get('mode')).toBe('view');
    expect(url.pathname).toBe(href.split('?')[0]);
    if (href.startsWith('/workspaces/')) {
      expect(url.searchParams.get('material')).toBe('qz_1');
    }
  });

  it('preserves the parent note edit mode and location', () => {
    const href = '/workspaces/ws_1?material=note_1&mode=edit#note';
    expect(quizEditSearch(href)).toEqual({ returnTo: href });
    expect(quizEditSearch('/create')).toEqual({ returnTo: '/create' });
  });

  it.each([
    undefined,
    'https://evil.test/create',
    '//evil.test/create',
    '/\\evil.test/create',
    '/\nevil.test/create',
    '/quizzes/qz_1/edit',
    '/materials/../quizzes/qz_1/edit',
  ])('rejects external or recursive destination %s', (returnTo) => {
    expect(parseQuizEditSearch({ returnTo })).toEqual({});
  });
});
