import type { OfficePosition } from './officeProtocol';
import type { OfficeViewPosition } from './useOfficeRuntime';

/** An Office swap's views by generation: the one on screen and the one
 * building beside it. */
export interface OfficeViews {
  next: number | null;
  shown: number;
}

/**
 * The reader's place across an Office swap (FileViewer's `OfficeSwap`, Epo
 * 2026-10-22): each view's frame position calls, and the place an at-once
 * swap carries until the next view settles. Plain functions over the views
 * so the orderings of a hidden tab's read against a settle's can be tested.
 */
export function officeSwapPlaces(
  views: () => OfficeViews,
  setViews: (next: OfficeViews) => void
) {
  const positions = new Map<number, OfficeViewPosition>();
  let carried: OfficePosition | null = null;
  const read = (generation: number) =>
    positions.get(generation)?.read() ?? Promise.resolve(null);
  return {
    /** The tab hid during a build: it swaps at once and the reader's place
     * goes with it, unless the build settled meanwhile (review r2 L2). */
    async hidden(building: number) {
      const place = await read(views().shown);
      if (views().next !== building) return;
      carried = place;
      setViews({ next: null, shown: building });
    },
    positions,
    /** A view was replaced on a newer epoch; `atOnce` (a hidden tab, a
     * phone) swaps without a build beside it. */
    async replaced(generation: number, atOnce: boolean) {
      const { next, shown } = views();
      // The view building was itself replaced: the next one builds instead.
      if (next === generation) {
        setViews({ next: generation + 1, shown });
        return;
      }
      if (shown !== generation || next !== null) return;
      if (!atOnce) {
        setViews({ next: generation + 1, shown });
        return;
      }
      const place = await read(generation);
      if (views().shown !== generation) return;
      carried = place;
      setViews({ next: null, shown: generation + 1 });
    },
    /** A view answered (painted, or the server's answer). */
    async settled(generation: number) {
      const { next, shown } = views();
      if (next === generation) {
        // The next view opens where the reader was, then takes the screen.
        const position = await read(shown);
        if (position) await positions.get(generation)?.show(position);
        // Shown: a hidden tab's place that swapped meanwhile goes too, in
        // either order (review r3 L1).
        carried = null;
        if (views().next !== generation) return;
        setViews({ next: null, shown: generation });
      } else if (shown === generation && carried) {
        void positions.get(generation)?.show(carried);
        carried = null;
      }
    },
  };
}
