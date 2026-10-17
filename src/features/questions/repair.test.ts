import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repairFigureBlock } from './repair';

/* The repairs of a live figure's merges (Epo 2026-10-17), on the fixtures the
 * collaboration server's `repair_figure` reads too
 * (collaboration-rs/crates/notes/tests/figure_map.rs). */
const cases = JSON.parse(
  readFileSync(
    new URL(
      '../../../server/internal/questions/testdata/repairs/figures.json',
      import.meta.url
    ),
    'utf8'
  )
) as { block: unknown; name: string; repaired: unknown }[];

describe('repairFigureBlock', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(repairFigureBlock(c.block)).toEqual(c.repaired);
  });

  it('returns a block needing no repair as the same object', () => {
    const valid = cases[0].block;
    expect(repairFigureBlock(valid)).toBe(valid);
  });
});
