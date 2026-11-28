import type {
  CompactDisplayPage,
  DisplayPage,
} from '@betteroffice/docx/layout/render';

/** Pages pack in idle slices of at most this long, or of the idle time left
 * if that is shorter; without requestIdleCallback (Safari) a slice runs this
 * long after the one before. */
const PACK_SLICE_MS = 8;
const PACK_WAIT_MS = 250;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** fflate, loaded once pages are packed, so the open loads nothing for it. */
let fflate: typeof import('fflate') | undefined;
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

/** Loads fflate, then packs `pages` at idle time, a slice at a time, until
 * every page is packed or the returned function stops it. */
export function packDocxPages(pages: readonly DocxPage[]) {
  const queue = [...pages];
  const later = (run: (deadline?: IdleDeadline) => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
    else setTimeout(run, PACK_WAIT_MS);
  };
  const slice = (deadline?: IdleDeadline) => {
    const end =
      performance.now() +
      Math.min(PACK_SLICE_MS, deadline?.timeRemaining() ?? PACK_SLICE_MS);
    while (queue.length > 0 && performance.now() < end) queue.shift()!.pack();
    if (queue.length > 0) later(slice);
    else scratch = new Uint8Array(0);
  };
  void import('fflate').then((module) => {
    fflate = module;
    if (queue.length > 0) later(slice);
  });
  return () => {
    queue.length = 0;
  };
}
