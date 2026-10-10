import { describe, expect, it } from 'vitest';
import {
  BIOMES,
  buildRailMap,
  DENSITY,
  densityOf,
  measure,
  STEP,
  wrapName,
} from './map';

const svg = (map: ReturnType<typeof buildRailMap>, before: number) =>
  [...map.under, ...map.over].filter((p) => p.b < before).map((p) => p.svg);
const chapters = ['Cells', 'Membranes', 'Genetics'];
const items = (count: number) =>
  Array.from({ length: count }, (_, i) => Math.min(2, Math.floor(i / 8)));

describe('rail map', () => {
  it('draws the same map for a workspace, a different one for another, and keeps it when items are added', () => {
    const a = buildRailMap('ws-a', chapters, items(20));
    const all = Number.POSITIVE_INFINITY;
    expect(svg(buildRailMap('ws-a', chapters, items(20)), all)).toEqual(
      svg(a, all)
    );
    expect(svg(buildRailMap('ws-b', chapters, items(20)), all)).not.toEqual(
      svg(a, all)
    );
    // Only the stretch near the old terminus may change.
    const cut = (a.stops.at(-1)?.[0] ?? 0) - 300;
    expect(svg(buildRailMap('ws-a', chapters, items(26)), cut)).toEqual(
      svg(a, cut)
    );
  });

  it('keeps dense biomes apart and never borders a city on open country', () => {
    for (let k = 0; k < 200; k++) {
      const { segments } = buildRailMap(`ws-${k}`, chapters, items(60));
      segments.forEach(({ biome }, i) => {
        if (i === 0) return;
        const prev = segments[i - 1].biome;
        expect(DENSITY[biome] === 'dense' && DENSITY[prev] === 'dense').toBe(
          false
        );
        const [u0, u1] = [BIOMES[prev].urban, BIOMES[biome].urban];
        if (u0 !== null && u1 !== null)
          expect(Math.abs(u0 - u1)).toBeLessThanOrEqual(1);
      });
    }
  });

  it('fills a panel wider than a short workspace and stays under 120 elements per desktop view', () => {
    expect(buildRailMap('ws-short', [], [null, null], 1400).width).toBe(1400);
    for (let k = 0; k < 20; k++) {
      const { placed, width } = buildRailMap(`ws-${k}`, chapters, items(40));
      for (let a = 0; a < width; a += 30)
        expect(
          placed.filter((x) => x >= a && x < a + 780).length
        ).toBeLessThanOrEqual(120);
    }
  });

  it('wraps station names on two lines and cuts longer ones with an ellipsis', () => {
    expect(wrapName('Membranes & transport')).toEqual([
      'Membranes &',
      'transport',
    ]);
    expect(
      wrapName('The modern world: revolutions, empires and the industrial age')
    ).toEqual(['The modern world:', 'revolutions…']);
    expect(STEP).toBe(60);
  });

  it('labels every biome by its measured visual weight', () => {
    const weights = measure();
    for (const [biome, weight] of Object.entries(weights))
      expect([biome, densityOf(weight), Math.round(weight)]).toEqual([
        biome,
        DENSITY[biome as keyof typeof DENSITY],
        Math.round(weight),
      ]);
  });
});
