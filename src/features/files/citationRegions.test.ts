import { describe, expect, it } from 'vitest';
import { normalizeCitationRegions } from './citationRegions';

describe('normalizeCitationRegions', () => {
  it('keeps valid page-1000 boxes and their source order', () => {
    expect(
      normalizeCitationRegions([
        {
          bbox: [100, 200, 350, 425],
          page: 3,
          space: 'page-1000-topleft',
        },
      ])
    ).toEqual([
      {
        bottom: 425,
        left: 100,
        page: 3,
        right: 350,
        sourceIndex: 0,
        top: 200,
      },
    ]);
  });

  it('clamps page coordinates and rejects unsafe boxes', () => {
    expect(
      normalizeCitationRegions([
        {
          bbox: [-20, 50, 1100, 500],
          page: 1,
          space: 'page-1000-topleft',
        },
        { bbox: [1, 2, 3], page: 1, space: 'page-1000-topleft' },
        { bbox: [20, 20, 10, 30], page: 1, space: 'page-1000-topleft' },
        { bbox: [10, 10, 20, 20], page: 0, space: 'page-1000-topleft' },
        { bbox: [10, 10, 20, 20], page: 1, space: 'pixels' },
      ])
    ).toEqual([
      {
        bottom: 500,
        left: 0,
        page: 1,
        right: 1000,
        sourceIndex: 0,
        top: 50,
      },
    ]);
  });
});
