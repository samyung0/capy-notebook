import { describe, expect, it } from 'vitest';
import {
  audioStartMs,
  formatClock,
  normalizeCitationRegions,
} from './citationRegions';

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

describe('audio citations', () => {
  it('start at their first sentence, which no page box mistakes', () => {
    const regions = [
      {
        bbox: null,
        end_ms: 64_980,
        page: 0,
        space: 'audio-ms',
        speaker: 1,
        start_ms: 61_200,
      },
      {
        bbox: null,
        end_ms: 70_000,
        page: 0,
        space: 'audio-ms',
        start_ms: 65_000,
      },
    ];
    expect(audioStartMs(regions)).toBe(61_200);
    expect(normalizeCitationRegions(regions)).toEqual([]);
    expect(
      audioStartMs([
        { bbox: [1, 2, 3, 4], page: 1, space: 'page-1000-topleft' },
      ])
    ).toBeUndefined();
  });

  it('show their time as m:ss or h:mm:ss', () => {
    expect(formatClock(61_200)).toBe('1:01');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});
