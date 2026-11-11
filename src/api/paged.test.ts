import { expect, it } from 'vitest';
import { pagedRows } from './paged';

it('reads the loaded pages as one list, a row that moved between fetches once', () => {
  expect(
    pagedRows({
      pageParams: ['', 'next'],
      pages: [
        { items: [{ id: 'a' }, { id: 'b' }] },
        { items: [{ id: 'b' }, { id: 'c' }] },
      ],
    }).map(({ id }) => id)
  ).toEqual(['a', 'b', 'c']);
});
