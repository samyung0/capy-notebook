import type {
  CompactDisplayPage,
  DisplayPage,
} from '@betteroffice/docx/layout/render';
import { deflateSync, inflateSync } from 'fflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** The buffer each page's JSON is written into before it is deflated, grown
 * as a page needs, so packing leaves no buffer per page behind. */
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
    return (
      this.page ??
      (JSON.parse(decoder.decode(inflateSync(this.bytes))) as DisplayPage)
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
    this.bytes = deflateSync(scratch.subarray(0, written), { level: 1 });
    this.page = null;
  }
}
