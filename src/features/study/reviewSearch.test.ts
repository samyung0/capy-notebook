import { expect, it } from 'vitest';
import { historyParams, parseHistorySearch } from './reviewSearch';

it('keeps known kinds from the URL for History', () => {
  const search = parseHistorySearch({ kind: 'revision,flashcards,essay' });
  expect(search).toEqual({ kind: 'revision,flashcards' });
  expect(historyParams(search).kinds).toEqual(['revision', 'flashcards']);
});

it('keeps known statuses from the URL for History', () => {
  const search = parseHistorySearch({ status: 'open,stuck' });
  expect(search).toEqual({ status: 'open' });
  expect(historyParams(search).statuses).toEqual(['open']);
});
