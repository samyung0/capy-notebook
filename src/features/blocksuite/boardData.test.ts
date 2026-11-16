import { describe, expect, it } from 'vitest';
import {
  circleAt,
  ellipseHandles,
  filledSlices,
  pullEllipse,
} from './boardData';

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

describe('pullEllipse', () => {
  const circle = circleAt('e', [1, 1], 2);

  it('holds an ellipse by its right, top, left and bottom handles', () => {
    expect(ellipseHandles(circle)).toEqual([
      [3, 1],
      [1, 3],
      [-1, 1],
      [1, -1],
    ]);
  });

  it('sizes about its middle, staying upright and on the grid', () => {
    expect(pullEllipse(circle, 0, [4, 0])).toEqual({
      ...circle,
      radii: [3, 2],
    });
    expect(pullEllipse(circle, 3, [1, 0])).toEqual({
      ...circle,
      radii: [2, 1],
    });
  });

  it('keeps its shape when uniform', () => {
    expect(
      pullEllipse({ ...circle, radii: [2, 1] }, 2, [-3, 1], true).radii
    ).toEqual([4, 2]);
  });
});
