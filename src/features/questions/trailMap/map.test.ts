import { describe, expect, it } from 'vitest';
import { buildTrailMap, DENSITY, densityOf, measure, STEP } from './map';

const svg = (map: ReturnType<typeof buildTrailMap>, before: number) =>
  [...map.under, ...map.over].filter((p) => p.b < before).map((p) => p.svg);

describe('trail map', () => {
  it('draws the same map for a topic, a different one for another, and keeps it when questions are added', () => {
    const a = buildTrailMap('topic-a', 34, 'START');
    expect(
      svg(buildTrailMap('topic-a', 34, 'START'), Number.POSITIVE_INFINITY)
    ).toEqual(svg(a, Number.POSITIVE_INFINITY));
    expect(
      svg(buildTrailMap('topic-b', 34, 'START'), Number.POSITIVE_INFINITY)
    ).not.toEqual(svg(a, Number.POSITIVE_INFINITY));
    // Only the last stretch before the old summit may change.
    const cut = 70 + 33 * STEP - 400;
    expect(svg(buildTrailMap('topic-a', 40, 'START'), cut)).toEqual(
      svg(a, cut)
    );
  });

  it('never puts dense biomes side by side, three sparse in a row, or more than three between dense ones', () => {
    for (let k = 0; k < 200; k++) {
      const kinds = buildTrailMap(`topic-${k}`, 60, '').segments.map(
        (s) => DENSITY[s.biome]
      );
      kinds.forEach((kind, i) => {
        if (i > 0)
          expect(kind === 'dense' && kinds[i - 1] === 'dense').toBe(false);
        if (i > 1)
          expect(kinds.slice(i - 2, i + 1).every((k2) => k2 === 'sparse')).toBe(
            false
          );
        if (i > 2)
          expect(kinds.slice(i - 3, i + 1).some((k2) => k2 === 'dense')).toBe(
            true
          );
      });
    }
  });

  it('keeps the busiest desktop view under 80 elements', () => {
    for (let k = 0; k < 40; k++) {
      const xs = buildTrailMap(`topic-${k}`, 60, '').placed;
      for (let a = 0; a < 70 + 60 * STEP; a += 30)
        expect(
          xs.filter((x) => x >= a && x < a + 780).length
        ).toBeLessThanOrEqual(80);
    }
  });

  it('labels every biome by its measured visual weight', () => {
    const weights = measure(30);
    for (const [biome, weight] of Object.entries(weights))
      expect([biome, densityOf(weight)]).toEqual([
        biome,
        DENSITY[biome as keyof typeof DENSITY],
      ]);
  });
});
