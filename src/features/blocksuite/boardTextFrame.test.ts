import { describe, expect, it } from 'vitest';
import { TEXT_SIZE_MAX } from './boardData';
import { draggedSize, frameCornerAt } from './boardTextFrame';

describe('text frame', () => {
  const box = { h: 18, w: 40, x: 100, y: 100 };

  it("finds a corner 6px out from the text's box", () => {
    expect(frameCornerAt(box, [94, 94])).toBe(0);
    expect(frameCornerAt(box, [146, 124])).toBe(2);
  });

  it('sizes text by how far the corner went from its middle', () => {
    expect(draggedSize(15, [0, 0], [10, 0], [20, 0])).toBe(30);
    expect(draggedSize(15, [0, 0], [10, 0], [1000, 0])).toBe(TEXT_SIZE_MAX);
  });
});
