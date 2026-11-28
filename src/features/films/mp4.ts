/**
 * A video film as an MP4 file the browser's own <video> plays: its H.264
 * units (Annex-B, every frame, no B-frames) moved as they are into one track,
 * the parameter sets into its avcC and each unit length-prefixed; its sound
 * (AAC in ADTS frames) into a second, each frame without its ADTS header.
 * Nothing is decoded or encoded.
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

/** AAC's sampling rates by their ADTS index. */
const AAC_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
  12_000, 11_025, 8000, 7350,
];

interface Aac {
  channels: number;
  /** AudioSpecificConfig: object type, rate index, channels. */
  config: [number, number];
  frames: Uint8Array[];
  rate: number;
}

/** ADTS frames as raw AAC frames and their stream's setup. */
export function adtsFrames(adts: Uint8Array): Aac {
  const frames: Uint8Array[] = [];
  let setup: Omit<Aac, 'frames'> | undefined;
  for (let at = 0; at + 7 <= adts.length; ) {
    const b = adts.subarray(at, at + 7);
    if (b[0] !== 0xff || ((b[1] ?? 0) & 0xf0) !== 0xf0)
      throw new Error('the sound is not ADTS');
    const header = (b[1] ?? 0) & 1 ? 7 : 9; // protection absent: no CRC
    const length =
      (((b[3] ?? 0) & 3) << 11) | ((b[4] ?? 0) << 3) | ((b[5] ?? 0) >> 5);
    if (length <= header) throw new Error('an ADTS frame is too short');
    if (!setup) {
      const type = ((b[2] ?? 0) >> 6) + 1;
      const index = ((b[2] ?? 0) >> 2) & 15;
      const channels = (((b[2] ?? 0) & 1) << 2) | ((b[3] ?? 0) >> 6);
      const rate = AAC_RATES[index];
      if (!rate) throw new Error('the sound has an unknown sampling rate');
      setup = {
        channels,
        config: [
          (type << 3) | (index >> 1),
          ((index & 1) << 7) | (channels << 3),
        ],
        rate,
      };
    }
    frames.push(adts.subarray(at + header, at + length));
    at += length;
  }
  if (!setup) throw new Error('the sound has no frames');
  return { ...setup, frames };
}

const MATRIX = [0x1_00_00, 0, 0, 0, 0x1_00_00, 0, 0, 0, 0x40_00_00_00];

/** The MP4 of `units` (one per frame, in order) at `fps`, with `sound`
 * (ADTS) if it has one. */
export function muxMp4(
  units: Uint8Array[],
  width: number,
  height: number,
  fps: number,
  sound?: Uint8Array
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
  const aac = sound ? adtsFrames(sound) : undefined;
  const videoBytes = samples.reduce((n, s) => n + s.length, 0);
  const audioBytes = aac?.frames.reduce((n, f) => n + f.length, 0) ?? 0;
  const mdatSize = 8 + videoBytes + audioBytes;
  // the movie's length, in its (the video's) timescale
  const length = aac
    ? Math.max(
        duration,
        Math.round((aac.frames.length * 1024 * timescale) / aac.rate)
      )
    : duration;

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
        b.u32(0, 0, timescale, length, 0x1_00_00);
        b.u16(0x1_00, 0);
        b.u32(0, 0, ...MATRIX, 0, 0, 0, 0, 0, 0, aac ? 3 : 2);
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
      if (aac) m.bytes(audioTrak(aac, length, mdatData + videoBytes));
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
  for (const f of aac?.frames ?? []) out.bytes(f);
  return out.join();
}

/** The sound's track, `length` long in the movie's timescale: its frames in
 * one chunk at `at`, 1024 samples each. */
function audioTrak(aac: Aac, length: number, at: number): Uint8Array {
  const { channels, config, frames, rate } = aac;
  const duration = frames.length * 1024;
  const out = new Boxes();
  out.box('trak', (t) => {
    t.full('tkhd', 0, 3, (b) => {
      b.u32(0, 0, 2, 0, length, 0, 0);
      b.u16(0, 1, 0x1_00, 0); // alternate group 1, full volume
      b.u32(...MATRIX, 0, 0);
    });
    t.box('mdia', (md) => {
      md.full('mdhd', 0, 0, (b) => {
        b.u32(0, 0, rate, duration);
        b.u16(0x55_c4, 0); // und
      });
      md.full('hdlr', 0, 0, (b) => {
        b.u32(0);
        b.ascii('soun');
        b.u32(0, 0, 0);
        b.ascii('SoundHandler');
        b.u8(0);
      });
      md.box('minf', (mi) => {
        mi.full('smhd', 0, 0, (b) => b.u16(0, 0));
        mi.box('dinf', (d) =>
          d.full('dref', 0, 0, (b) => {
            b.u32(1);
            b.full('url ', 0, 1, () => undefined);
          })
        );
        mi.box('stbl', (s) => {
          s.full('stsd', 0, 0, (b) => {
            b.u32(1);
            b.box('mp4a', (a) => {
              a.u8(0, 0, 0, 0, 0, 0);
              a.u16(1); // data reference
              a.u32(0, 0);
              a.u16(channels, 16, 0, 0);
              a.u32(rate * 0x1_00_00);
              a.full('esds', 0, 0, (e) => {
                // ES descriptor › decoder config (AAC, audio) › its
                // AudioSpecificConfig; then the sync-layer config
                e.u8(0x03, 25, 0, 2, 0);
                e.u8(0x04, 17, 0x40, 0x15, 0, 0, 0);
                e.u32(0, 0);
                e.u8(0x05, 2, ...config);
                e.u8(0x06, 1, 0x02);
              });
            });
          });
          s.full('stts', 0, 0, (b) => b.u32(1, frames.length, 1024));
          s.full('stsc', 0, 0, (b) => b.u32(1, 1, frames.length, 1));
          s.full('stsz', 0, 0, (b) => {
            b.u32(0, frames.length);
            b.words(frames.map((f) => f.length));
          });
          s.full('stco', 0, 0, (b) => b.u32(1, at));
        });
      });
    });
  });
  return out.join();
}
