import { describe, expect, it } from 'vitest';
import { filterBankRows } from './bank';

describe('bank progress', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({
    answerTypes: id === 'b' ? ['mcq', 'short'] : ['short'],
    id,
  }));

  it('filters by status and answer type together', () => {
    const marks = { a: 1, b: 0.5, c: 0 };
    const ids = (types: string[], statuses: string[]) =>
      filterBankRows(rows, types, statuses, marks).map((row) => row.id);
    expect(ids([], ['correct'])).toEqual(['a']);
    expect(ids([], ['wrong', 'partial'])).toEqual(['b', 'c']);
    expect(ids([], ['notDone'])).toEqual(['d']);
    expect(ids(['mcq'], [])).toEqual(['b']);
    expect(ids(['short'], ['correct', 'notDone'])).toEqual(['a', 'd']);
  });
});
