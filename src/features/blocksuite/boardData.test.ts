import { describe, expect, it } from 'vitest';
import { barSlots, filledSlices, setsBar } from './boardData';

describe('filledSlices', () => {
  it('fills each slice clockwise from its line to the next, past 360 at the end', () => {
    expect(
      filledSlices([
        { angle: 120, id: 'b' },
        { angle: 250, fill: '#1e96eb', id: 'c' },
        { angle: 0, fill: '#f6c343', id: 'a' },
      ])
    ).toEqual([
      { fill: '#f6c343', from: 0, to: 120 },
      { fill: '#1e96eb', from: 250, to: 360 },
    ]);
  });

  it('fills the whole round from a single line', () => {
    expect(filledSlices([{ angle: 90, fill: '#1e96eb', id: 'a' }])).toEqual([
      { fill: '#1e96eb', from: 90, to: 450 },
    ]);
  });
});

describe('barSlots and setsBar', () => {
  it('lays a chart merged past the cap out with a place per bar and none free', () => {
    // Under the cap: a free place after the last bar starts the next.
    expect(barSlots(23)).toBe(24);
    expect(setsBar(23, 23)).toBe(true);
    // At the cap and past it (two adds merged, Epo 2026-11-22): every bar has
    // its place, and none is free.
    expect(barSlots(24)).toBe(24);
    expect(setsBar(24, 24)).toBe(false);
    expect(barSlots(25)).toBe(25);
    expect(setsBar(24, 25)).toBe(true);
    expect(setsBar(25, 25)).toBe(false);
  });
});
