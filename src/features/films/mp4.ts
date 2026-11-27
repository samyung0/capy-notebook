/**
 * A video film as an MP4 file the browser's own <video> plays: its H.264
 * units (Annex-B, every frame, no B-frames) moved as they are into one track,
 * the parameter sets into its avcC and each unit length-prefixed. Nothing is
 * decoded or encoded.
 */

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** An Annex-B unit's NAL payloads, without their start codes. */
export function nalUnits(unit: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < unit.length) {
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1) {
      if (start >= 0) {
        // a 4-byte start code leaves a zero on the payload before it
        let end = i;
        if (end > start && unit[end - 1] === 0) end--;
        out.push(unit.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < unit.length) out.push(unit.subarray(start));
  return out;
}

class Boxes {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }

  u8(...xs: number[]) {
    this.bytes(Uint8Array.from(xs));
  }

  u16(...xs: number[]) {
    const b = new Uint8Array(2 * xs.length);
    const v = new DataView(b.buffer);
    xs.forEach((x, i) => {
      v.setUint16(2 * i, x);
    });
    this.bytes(b);
  }

  u32(...xs: number[]) {
    this.words(xs);
  }

  /** u32s from an array (a long one would overflow a spread). */
  words(xs: readonly number[]) {
    const b = new Uint8Array(4 * xs.length);
    const v = new DataView(b.buffer);
    xs.forEach((x, i) => {
      v.setUint32(4 * i, x >>> 0);
    });
    this.bytes(b);
  }

  ascii(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }

  /** A box: its size and type, then what `fill` writes. */
  box(type: string, fill: (b: Boxes) => void) {
    const inner = new Boxes();
    fill(inner);
    this.u32(8 + inner.length);
    this.ascii(type);
    for (const part of inner.parts) this.bytes(part);
  }

  /** A full box: a box with a version and flags. */
  full(type: string, version: number, flags: number, fill: (b: Boxes) => void) {
    this.box(type, (b) => {
      b.u32((version << 24) | flags);
      fill(b);
    });
  }

  join(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

const MATRIX = [0x1_00_00, 0, 0, 0, 0x1_00_00, 0, 0, 0, 0x40_00_00_00];

/** The MP4 of `units` (one per frame, in order) at `fps`. */
export function muxMp4(
  units: Uint8Array[],
  width: number,
  height: number,
  fps: number
): Uint8Array {
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  const samples: Uint8Array[] = [];
  const sync: number[] = [];
  units.forEach((unit, index) => {
    const kept: Uint8Array[] = [];
    let key = false;
    for (const nal of nalUnits(unit)) {
      const type = (nal[0] ?? 0) & 31;
      if (type === NAL_SPS) sps ??= nal;
      else if (type === NAL_PPS) pps ??= nal;
      else if (type !== NAL_AUD) {
        if (type === NAL_IDR) key = true;
        kept.push(nal);
      }
    }
    const sample = new Boxes();
    for (const nal of kept) {
      sample.u32(nal.length);
      sample.bytes(nal);
    }
    samples.push(sample.join());
    if (key) sync.push(index + 1);
  });
  if (!(sps && pps)) throw new Error('the film has no H.264 parameter sets');
  const avcSps = sps;
  const avcPps = pps;

  const timescale = Math.round(fps * 1000);
  const delta = 1000;
  const duration = samples.length * delta;
  const mdatSize = 8 + samples.reduce((n, s) => n + s.length, 0);

  const ftyp = new Boxes();
  ftyp.box('ftyp', (b) => {
    b.ascii('isom');
    b.u32(0x2_00);
    b.ascii('isomiso2avc1mp41');
  });

  const moov = (mdatData: number) => {
    const out = new Boxes();
    out.box('moov', (m) => {
      m.full('mvhd', 0, 0, (b) => {
        b.u32(0, 0, timescale, duration, 0x1_00_00);
        b.u16(0x1_00, 0);
        b.u32(0, 0, ...MATRIX, 0, 0, 0, 0, 0, 0, 2);
      });
      m.box('trak', (t) => {
        t.full('tkhd', 0, 3, (b) => {
          b.u32(0, 0, 1, 0, duration, 0, 0);
          b.u16(0, 0, 0, 0);
          b.u32(...MATRIX, width * 0x1_00_00, height * 0x1_00_00);
        });
        t.box('mdia', (md) => {
          md.full('mdhd', 0, 0, (b) => {
            b.u32(0, 0, timescale, duration);
            b.u16(0x55_c4, 0); // und
          });
          md.full('hdlr', 0, 0, (b) => {
            b.u32(0);
            b.ascii('vide');
            b.u32(0, 0, 0);
            b.ascii('VideoHandler');
            b.u8(0);
          });
          md.box('minf', (mi) => {
            mi.full('vmhd', 0, 1, (b) => b.u16(0, 0, 0, 0));
            mi.box('dinf', (d) =>
              d.full('dref', 0, 0, (b) => {
                b.u32(1);
                b.full('url ', 0, 1, () => undefined);
              })
            );
            mi.box('stbl', (s) => {
              s.full('stsd', 0, 0, (b) => {
                b.u32(1);
                b.box('avc1', (a) => {
                  a.u8(0, 0, 0, 0, 0, 0);
                  a.u16(1); // data reference
                  a.u32(0, 0, 0, 0);
                  a.u16(width, height);
                  a.u32(0x48_00_00, 0x48_00_00, 0);
                  a.u16(1);
                  a.bytes(new Uint8Array(32)); // compressor name
                  a.u16(0x18, 0xff_ff);
                  a.box('avcC', (c) => {
                    c.u8(1, avcSps[1] ?? 0, avcSps[2] ?? 0, avcSps[3] ?? 0);
                    c.u8(0xff, 0xe1); // 4-byte lengths; one SPS
                    c.u16(avcSps.length);
                    c.bytes(avcSps);
                    c.u8(1);
                    c.u16(avcPps.length);
                    c.bytes(avcPps);
                    // high profiles: 4:2:0, 8 bits, no SPS extensions
                    if ((avcSps[1] ?? 0) >= 100) c.u8(0xfc | 1, 0xf8, 0xf8, 0);
                  });
                });
              });
              s.full('stts', 0, 0, (b) => b.u32(1, samples.length, delta));
              s.full('stss', 0, 0, (b) => {
                b.u32(sync.length);
                b.words(sync);
              });
              s.full('stsc', 0, 0, (b) => b.u32(1, 1, samples.length, 1));
              s.full('stsz', 0, 0, (b) => {
                b.u32(0, samples.length);
                b.words(samples.map((x) => x.length));
              });
              s.full('stco', 0, 0, (b) => b.u32(1, mdatData));
            });
          });
        });
      });
    });
    return out.join();
  };

  // the samples follow the header boxes in one chunk
  const header = ftyp.join();
  const sized = moov(0);
  const movie = moov(header.length + sized.length + 8);
  const out = new Boxes();
  out.bytes(header);
  out.bytes(movie);
  out.u32(mdatSize);
  out.ascii('mdat');
  for (const s of samples) out.bytes(s);
  return out.join();
}
