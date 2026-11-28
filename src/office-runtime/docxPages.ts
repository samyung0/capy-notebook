import type {
  CompactDisplayPage,
  DisplayPage,
} from '@betteroffice/docx/layout/render';
import { deflateSync, inflateSync } from 'fflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ES2024, past this project's lib. */
type Transferring = { transfer?: (length: number) => ArrayBuffer };

/** A page as the viewer worker sends it: its box and its JSON as UTF-8, whose
 * buffer the message transfers instead of copying the page's objects. */
export type SentDocxPage = {
  height: number;
  json: Uint8Array;
  pageIndex: number;
  width: number;
};

export function sentDocxPage(page: DisplayPage): SentDocxPage {
  const { height, pageIndex, width } = page;
  return {
    height,
    json: encoder.encode(JSON.stringify(page)),
    pageIndex,
    width,
  };
}

/** A page View keeps (Q864 A): its JSON, deflated at idle time to about a
 * sixth (the objects are near the JSON's size), and decoded afresh when the
 * page is drawn, printed, copied or read. */
export class DocxPage implements CompactDisplayPage {
  readonly height: number;
  readonly pageIndex: number;
  readonly width: number;
  /** Its JSON is deflated. */
  packed = false;
  private bytes: Uint8Array;

  constructor({ height, json, pageIndex, width }: SentDocxPage) {
    this.height = height;
    this.pageIndex = pageIndex;
    this.width = width;
    this.bytes = json;
  }

  decode(): DisplayPage {
    const json = this.packed ? inflateSync(this.bytes) : this.bytes;
    return JSON.parse(decoder.decode(json)) as DisplayPage;
  }

  /** Deflates the JSON, fastest level: 2-3 ms for a page of 230 KB. */
  pack() {
    if (this.packed) return;
    const json = this.bytes;
    this.bytes = deflateSync(json, { level: 1 });
    this.packed = true;
    // The JSON's memory goes now, not at the next full collection (ES2024's
    // ArrayBuffer transfer detaches it).
    (json.buffer as unknown as Transferring).transfer?.(0);
  }
}
