import { expect, it, vi } from 'vitest';
import { captureNotePosition, restoreNotePosition } from './roomSwap';

vi.stubGlobal('CSS', { escape: (value: string) => value });

/** A scroll box at y=100 holding 40px blocks a..e from y=100 - scrollTop. */
function box(scrollTop: number, ids = ['a', 'b', 'c', 'd', 'e']) {
  const area = {
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: (selector: string) =>
      blocks.find((block) => selector.includes(`"${block.dataset.blockId}"`)) ??
      null,
    querySelectorAll: () => blocks,
    scrollTop,
  };
  const blocks = ids.map((id, index) => ({
    dataset: { blockId: id },
    getBoundingClientRect: () => ({
      bottom: 100 + index * 40 + 40 - area.scrollTop,
      top: 100 + index * 40 - area.scrollTop,
    }),
  }));
  return area as unknown as HTMLElement;
}

it('puts the block at the top back at the same height in the next editor', () => {
  // 90px down: block c (80-120) shows from 10px above the top edge.
  const position = captureNotePosition({ editor: null, scrollArea: box(90) });
  expect(position).toMatchObject({ block: 'c', offset: -10, scrollTop: 90 });
  // The next editor holds two more blocks above it.
  const next = box(0, ['x', 'y', 'a', 'b', 'c', 'd', 'e']);
  restoreNotePosition({ editor: null, scrollArea: next }, position);
  expect(next.scrollTop).toBe(170);
  // A block that is gone keeps the scroll offset instead.
  const other = box(0, ['p', 'q']);
  restoreNotePosition({ editor: null, scrollArea: other }, position);
  expect(other.scrollTop).toBe(90);
});
