import type {
  CompactDisplayPage,
  DisplayPage,
} from '@betteroffice/docx/layout/render';

/** Idle work runs in slices of at most this long, or of the idle time left
 * if that is shorter; without requestIdleCallback (Safari) a slice runs this
 * long after the one before. */
const SLICE_MS = 8;
const SLICE_WAIT_MS = 250;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** fflate's two calls, loaded once pages are packed, so the open loads
 * nothing for it (destructured, so the build keeps fflate's chunk as small
 * as the other importers need). */
let fflate:
  | Pick<typeof import('fflate'), 'deflateSync' | 'inflateSync'>
  | undefined;
/** The buffer each page's JSON is written into before it is deflated, grown
 * as a page needs and dropped after the last page of a packing. */
let scratch = new Uint8Array(0);

/** A page View keeps (Q864 A): the page as the worker sent it until it is
 * packed, then its JSON deflated (about a fifth of the page's objects),
 * decoded afresh whenever the page is drawn, printed, copied or read. */
export class DocxPage implements CompactDisplayPage {
  readonly height: number;
  readonly pageIndex: number;
  readonly width: number;
  private page: DisplayPage | null;
  private bytes = new Uint8Array(0);

  constructor(page: DisplayPage) {
    this.height = page.height;
    this.pageIndex = page.pageIndex;
    this.width = page.width;
    this.page = page;
  }

  get packed() {
    return this.page === null;
  }

  decode(): DisplayPage {
    // A page is packed only once fflate is in.
    return (
      this.page ??
      (JSON.parse(
        decoder.decode(fflate!.inflateSync(this.bytes))
      ) as DisplayPage)
    );
  }

  /** Deflates the page's JSON at the fastest level (2-3 ms for a page of
   * 230 KB) and lets the page go. */
  pack() {
    if (!this.page) return;
    const json = JSON.stringify(this.page);
    // UTF-8 takes at most three bytes per UTF-16 unit.
    if (scratch.length < json.length * 3)
      scratch = new Uint8Array(json.length * 3);
    const { written } = encoder.encodeInto(json, scratch);
    this.bytes = fflate!.deflateSync(scratch.subarray(0, written), {
      level: 1,
    });
    this.page = null;
  }
}

/** Runs `step` on each of `items` in order at idle time, a slice at a time,
 * then `done`, unless the returned function stops it first. */
export function idleSlices<T>(
  items: readonly T[],
  step: (item: T) => void,
  done: () => void
) {
  let next = 0;
  let stopped = false;
  const later = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(slice);
    else setTimeout(slice, SLICE_WAIT_MS);
  };
  const slice = (deadline?: IdleDeadline) => {
    if (stopped) return;
    const end =
      performance.now() +
      Math.min(SLICE_MS, deadline?.timeRemaining() ?? SLICE_MS);
    while (next < items.length && performance.now() < end) step(items[next++]);
    if (next < items.length) later();
    else done();
  };
  later();
  return () => {
    stopped = true;
  };
}

/** Loads fflate, then packs `pages` at idle time until every page is packed
 * or the returned function stops it; the scratch buffer goes after either. */
export function packDocxPages(pages: readonly DocxPage[]) {
  let stopped = false;
  let stop = () => {};
  const drop = () => {
    scratch = new Uint8Array(0);
  };
  void import('fflate').then(({ deflateSync, inflateSync }) => {
    fflate = { deflateSync, inflateSync };
    if (!stopped) stop = idleSlices(pages, (page) => page.pack(), drop);
  });
  return () => {
    stopped = true;
    stop();
    drop();
  };
}
