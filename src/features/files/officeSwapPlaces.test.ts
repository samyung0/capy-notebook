import { describe, expect, it, vi } from 'vitest';
import type { OfficePosition } from './officeProtocol';
import { type OfficeViews, officeSwapPlaces } from './officeSwapPlaces';

const SLIDE_4: OfficePosition = { format: 'pptx', slide: 4 };
const SLIDE_5: OfficePosition = { format: 'pptx', slide: 5 };

/** A swap with view 0 on screen and view 1 building; view 0's reads answer
 * when the test says, in any order. */
function building() {
  let views: OfficeViews = { next: 1, shown: 0 };
  const places = officeSwapPlaces(
    () => views,
    (next) => {
      views = next;
    }
  );
  const reads: ((position: OfficePosition) => void)[] = [];
  places.positions.set(0, {
    read: () =>
      new Promise((resolve) => {
        reads.push(resolve);
      }),
    show: vi.fn(async () => null),
  });
  const show = vi.fn(async (position: OfficePosition) => position);
  places.positions.set(1, { read: async () => null, show });
  return { places, reads, show, views: () => views };
}

// A tab that hides while the build settles: whichever read answers first,
// the next view shows one place once and no stale place later (review r2 L2,
// r3 L1).
describe('a hidden tab during an Office build that settles', () => {
  it("drops the hidden tab's read that answers after the settle swapped", async () => {
    const { places, reads, show, views } = building();
    const hidden = places.hidden(1);
    const settled = places.settled(1);
    reads[1](SLIDE_5);
    await settled;
    reads[0](SLIDE_4);
    await hidden;
    expect(views()).toEqual({ next: null, shown: 1 });
    // A later answer of the live view (View and Edit) shows nothing more.
    await places.settled(1);
    expect(show.mock.calls).toEqual([[SLIDE_5]]);
  });

  it('clears the place the hidden tab carried when the settle answers last', async () => {
    const { places, reads, show, views } = building();
    const hidden = places.hidden(1);
    const settled = places.settled(1);
    reads[0](SLIDE_4);
    await hidden;
    expect(views()).toEqual({ next: null, shown: 1 });
    reads[1](SLIDE_5);
    await settled;
    await places.settled(1);
    expect(show.mock.calls).toEqual([[SLIDE_5]]);
  });
});
