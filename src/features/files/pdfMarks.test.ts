import { describe, expect, it } from 'vitest';
import {
  applyChange,
  clampShift,
  eraseAlong,
  hitMark,
  type Mark,
  markBox,
  mergeLines,
  newMarkId,
  normalizeMark,
  resizeMark,
  simplify,
  straighten,
  topHit,
} from './pdfMarks';

const PAGE = { height: 1000, width: 773 };
const MARK_ID = /^ann_[0-9a-f]{20}$/;
const mark = (kind: Mark['kind'], fields: Partial<Mark>): Mark => ({
  color: '#d94848',
  comment: '',
  id: newMarkId(),
  kind,
  page: 1,
  rects: [],
  size: 0,
  strokes: [],
  text: '',
  width: 0,
  ...fields,
});
const line = (from: number, to: number, y: number, step = 10) =>
  Array.from({ length: (to - from) / step + 1 }, (_, i) => ({
    x: from + i * step,
    y,
  }));

describe('pdf marks', () => {
  it('makes IDs the server takes', () => {
    expect(newMarkId()).toMatch(MARK_ID);
  });

  it('hits ink and outlines, not the empty box', () => {
    const pen = mark('pen', { strokes: [line(100, 300, 200)], width: 3 });
    expect(hitMark(pen, { x: 200, y: 203 }, 2)).toBe(true);
    expect(hitMark(pen, { x: 200, y: 220 }, 2)).toBe(false);
    const rect = mark('rectangle', {
      rects: [{ height: 100, width: 200, x: 100, y: 100 }],
      width: 3,
    });
    expect(hitMark(rect, { x: 101, y: 150 }, 2)).toBe(true);
    expect(hitMark(rect, { x: 200, y: 150 }, 2)).toBe(false);
    const ellipse = mark('ellipse', {
      rects: [{ height: 100, width: 200, x: 100, y: 100 }],
      width: 3,
    });
    expect(hitMark(ellipse, { x: 200, y: 100 }, 2)).toBe(true);
    expect(hitMark(ellipse, { x: 200, y: 150 }, 2)).toBe(false);
    expect(topHit([pen, rect], { x: 150, y: 200 }, 2)).toBe(rect);
  });

  it('pads a stroke box by half its width', () => {
    const pen = mark('pen', { strokes: [line(100, 200, 50)], width: 4 });
    expect(markBox(pen)).toEqual({ height: 4, width: 104, x: 98, y: 48 });
  });

  it('keeps a moved selection on the page', () => {
    const pen = mark('pen', { strokes: [line(700, 760, 50)], width: 3 });
    expect(clampShift([pen], 40, -80, PAGE)).toEqual([13, -50]);
  });

  it('scales ink evenly from the far corner and stretches shapes', () => {
    // The handle sits on the frame, half the 3-unit stroke outside the ink.
    const pen = mark('pen', {
      strokes: [
        [
          { x: 100, y: 100 },
          { x: 200, y: 150 },
        ],
      ],
      width: 3,
    });
    const scaled = resizeMark(pen, 'se', { x: 301.5, y: 201.5 }, PAGE);
    expect(scaled.strokes[0]).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 200 },
    ]);
    const rect = mark('rectangle', {
      rects: [{ height: 50, width: 100, x: 100, y: 100 }],
      width: 3,
    });
    expect(resizeMark(rect, 'nw', { x: 48.5, y: 18.5 }, PAGE).rects[0]).toEqual(
      {
        height: 130,
        width: 150,
        x: 50,
        y: 20,
      }
    );
  });

  it('leaves a mark as it was when its handle has not moved', () => {
    const rect = mark('ellipse', {
      rects: [{ height: 50, width: 100, x: 100, y: 100 }],
      width: 5.5,
    });
    const box = markBox(rect);
    expect(
      resizeMark(
        rect,
        'se',
        { x: box.x + box.width, y: box.y + box.height },
        PAGE
      )
    ).toEqual(rect);
  });

  it('grows a level line from its corner', () => {
    const pen = mark('pen', {
      strokes: [
        [
          { x: 100, y: 200 },
          { x: 300, y: 200 },
        ],
      ],
      width: 4,
    });
    expect(resizeMark(pen, 'se', { x: 402, y: 202 }, PAGE).strokes[0]).toEqual([
      { x: 100, y: 200 },
      { x: 400, y: 200 },
    ]);
  });

  it('puts every corner and point on the hundredth, inside the bound', () => {
    const shape = mark('rectangle', {
      rects: [{ height: 3.333, width: 5, x: 999.996, y: 10.004 }],
      strokes: [],
      width: 3,
    });
    expect(normalizeMark(shape).rects[0]).toEqual({
      height: 3.34,
      width: 0.01,
      x: 999.99,
      y: 10,
    });
    const pen = mark('pen', {
      strokes: [
        [
          { x: -1, y: 1000.4 },
          { x: 12.345, y: 6.789 },
        ],
      ],
      width: 3,
    });
    expect(normalizeMark(pen).strokes[0]).toEqual([
      { x: 0, y: 1000 },
      { x: 12.35, y: 6.79 },
    ]);
  });

  it('cuts a pen stroke where the eraser crosses it and removes other marks whole', () => {
    const pen = mark('pen', {
      strokes: [
        [
          { x: 100, y: 200 },
          { x: 300, y: 200 },
        ],
      ],
      width: 3,
    });
    const rect = mark('rectangle', {
      rects: [{ height: 40, width: 40, x: 190, y: 400 }],
      width: 3,
    });
    const cut = eraseAlong(
      [pen, rect],
      { x: 200, y: 150 },
      { x: 200, y: 250 },
      10
    );
    const pieces = cut.get(pen.id)?.strokes ?? [];
    expect(pieces).toHaveLength(2);
    expect(pieces[0].at(-1)?.x).toBeLessThan(190);
    expect(pieces[1][0].x).toBeGreaterThan(210);
    expect(cut.has(rect.id)).toBe(false);
    expect(
      eraseAlong([rect], { x: 190, y: 380 }, { x: 190, y: 460 }, 10).get(
        rect.id
      )
    ).toBeNull();
  });

  it('snaps a nearly level marker stroke straight', () => {
    const wobbly = line(100, 300, 200).map((p, i) => ({
      ...p,
      y: p.y + (i % 2) * 3,
    }));
    expect(straighten(wobbly)).toHaveLength(2);
    const slanted = line(100, 300, 0).map((p) => ({ ...p, y: p.x }));
    expect(straighten(slanted)).toHaveLength(slanted.length);
  });

  it('drops samples on a straight run', () => {
    expect(simplify(line(0, 500, 10, 1), 0.25)).toEqual([
      { x: 0, y: 10 },
      { x: 500, y: 10 },
    ]);
  });

  it('merges a line’s text runs into one band', () => {
    expect(
      mergeLines([
        { height: 12, width: 50, x: 100, y: 100 },
        { height: 14, width: 40, x: 148, y: 99 },
        { height: 12, width: 80, x: 100, y: 120 },
      ])
    ).toEqual([
      { height: 14, width: 88, x: 100, y: 99 },
      { height: 12, width: 80, x: 100, y: 120 },
    ]);
  });

  it('applies a change: saves over, adds and removes', () => {
    const a = mark('note', {
      comment: 'a',
      rects: [{ height: 24, width: 24, x: 0, y: 0 }],
    });
    const b = { ...a, id: newMarkId() };
    const moved = { ...a, comment: 'moved' };
    const added = { ...a, id: newMarkId() };
    expect(
      applyChange(
        [a, b],
        new Map([
          [a.id, moved],
          [b.id, null],
          [added.id, added],
        ])
      )
    ).toEqual([moved, added]);
  });
});
