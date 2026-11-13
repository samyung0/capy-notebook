import { expect, it, vi } from 'vitest';
import { scopedOpenLink } from './openLink';

// A canvas card's views are named under its id, so one card's drawing answer is
// never another's (Epo 2026-11-13).
it("names a card's view under the card's id", () => {
  const page = {
    close: vi.fn(),
    gone: vi.fn(),
    open: vi.fn(),
    opened: 'card-1~part-a',
  };
  const card = scopedOpenLink(page, 'card-1');
  expect(card?.opened).toBe('part-a');
  expect(scopedOpenLink(page, 'card-2')?.opened).toBeNull();
  card?.open('part-b');
  expect(page.open).toHaveBeenCalledWith('card-1~part-b');
  card?.close();
  expect(page.close).toHaveBeenCalledOnce();
});
