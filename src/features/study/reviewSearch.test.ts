import { expect, it } from 'vitest';
import { parseResultsSearch, resultParams } from './reviewSearch';

it('keeps known attempt kinds from the URL for All results', () => {
  const search = parseResultsSearch({ kind: 'flashcards,essay' });
  expect(search).toEqual({ kind: 'flashcards' });
  expect(resultParams(search).kinds).toEqual(['flashcards']);
});
