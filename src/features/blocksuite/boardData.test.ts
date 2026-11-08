import { describe, expect, it } from 'vitest';
import { filledSlices } from './boardData';

describe('filledSlices', () => {
  it('fills each slice clockwise from its line to the next, past 360 at the end', () => {
    expect(
      filledSlices({
        fills: [
          { fill: '#1e96eb', from: 250 },
          { fill: '#f6c343', from: 0 },
        ],
        spokes: [120, 0, 250],
      })
    ).toEqual([
      { fill: '#f6c343', from: 0, to: 120 },
      { fill: '#1e96eb', from: 250, to: 360 },
    ]);
  });

  it('fills the whole round from a single line', () => {
    expect(
      filledSlices({ fills: [{ fill: '#1e96eb', from: 90 }], spokes: [90] })
    ).toEqual([{ fill: '#1e96eb', from: 90, to: 450 }]);
  });

  it('draws no fills for a pie saved before it had any', () => {
    expect(filledSlices({ spokes: [0, 120] })).toEqual([]);
  });
});
