import { describe, expect, it } from 'vitest';
import { parseQuizEditSearch } from './quizNavigation';

describe('quiz edit return navigation', () => {
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
