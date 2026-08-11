import { describe, expect, it } from 'vitest';
import { getHiddenToolbarGroupIndexes } from './responsiveToolbar';

describe('responsive toolbar groups', () => {
  it('hides groups from right to left until they fit', () => {
    const hidden = getHiddenToolbarGroupIndexes(
      [{ width: 80 }, { width: 120 }, { width: 100 }, { width: 60 }],
      220
    );

    expect([...hidden]).toEqual([3, 2]);
  });

  it('stops hiding as soon as the rest fits', () => {
    const hidden = getHiddenToolbarGroupIndexes(
      [{ width: 80 }, { width: 40 }, { width: 100 }, { width: 60 }],
      100
    );

    expect([...hidden]).toEqual([3, 2, 1]);
  });

  it('hides every group when even one does not fit', () => {
    const hidden = getHiddenToolbarGroupIndexes(
      [{ width: 80 }, { width: 40 }],
      10
    );

    expect([...hidden]).toEqual([1, 0]);
  });

  it('does not hide anything when all groups fit', () => {
    expect(
      getHiddenToolbarGroupIndexes([{ width: 80 }, { width: 40 }], 120).size
    ).toBe(0);
  });
});
