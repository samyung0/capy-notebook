/**
 * Writes a drawn film's chunks as a ManimGX take: the stream of messages its
 * player reads (`feed`). The format is ManimGX's (rust/engine/src/take.rs and
 * pack.rs, take version 1): each message its length (u32), its op (u8), then
 * its fields, little-endian. An upload's arrays go first as ARRAY messages
 * under their own keys, each coded against the array it replaces when the
 * film coded it so (its difference, or its base with more after it), and
 * compressed with zstd (`compress`): the player keeps every array it is sent.
 */
import type { CameraView, Coded, Coding, DrawSink, FilmMeta } from './cmv';

export const TAKE_VERSION = 1;

const OP = {
  ARRAY: 11,
  END: 12,
  ENVIRONMENT: 13,
  FRAME: 8,
  GROW: 6,
  MESH: 3,
  NOTE: 9,
  PATH: 1,
  POINTS: 2,
  ROWS: 4,
  SOUND: 10,
  START: 14,
  TEXTURE: 5,
} as const;

/** pack::Kind: its number, element width, lanes, and whether it holds floats. */
const KIND = {
  MeshNormals: { float: true, id: 2, lanes: 3, width: 4 },
  MeshPoints: { float: true, id: 0, lanes: 3, width: 4 },
  MeshTriangles: { float: false, id: 3, lanes: 1, width: 4 },
  MeshUvs: { float: true, id: 1, lanes: 2, width: 4 },
  PathPoints: { float: true, id: 4, lanes: 3, width: 8 },
  PathSubpaths: { float: false, id: 5, lanes: 4, width: 4 },
  Points: { float: true, id: 6, lanes: 4, width: 4 },
  Records: { float: false, id: 9, lanes: 84, width: 4 },
  Rows: { float: true, id: 7, lanes: 4, width: 4 },
  Texture: { float: false, id: 8, lanes: 4, width: 1 },
} as const;
type Kind = (typeof KIND)[keyof typeof KIND];

const ALONE = 0;
const FIRST = 1;
const TAIL = 3;
/** Versions in a chain before one stands alone (ManimGX's own writer allows
 * 32, but keeps whichever coding is smaller). The player decodes a chain when
 * a frame needs it: on the menger example, 4 instead of 32 cut its median seek
 * from 41 to 4 ms and its worst draw from 271 to 75 ms, for 20 MB of take
 * instead of 13. */
const DEPTH = 4;

/** An array the player was sent: its key, bytes and chain depth. */
interface Sent {
  bytes: Uint8Array;
  chunk: number;
  depth: number;
  key: number;
}

class Out {
  private buffer = new Uint8Array(1 << 16);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private room(n: number) {
    if (this.length + n <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(x: number) {
    this.room(1);
    this.buffer[this.length++] = x;
  }

  u32(x: number) {
    this.room(4);
    this.view.setUint32(this.length, x, true);
    this.length += 4;
  }

  /** A key below 2^53, as u64. */
  u64(x: number) {
    this.u32(x % 2 ** 32);
    this.u32(Math.floor(x / 2 ** 32));
  }

  f32(x: number) {
    this.room(4);
    this.view.setFloat32(this.length, x, true);
    this.length += 4;
  }

  f64(x: number) {
    this.room(8);
    this.view.setFloat64(this.length, x, true);
    this.length += 8;
  }

  raw(bytes: Uint8Array) {
    this.room(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  string(bytes: Uint8Array) {
    this.u32(bytes.length);
    this.raw(bytes);
  }

  setU32(at: number, x: number) {
    this.view.setUint32(at, x, true);
  }

  drain(): Uint8Array {
    const out = this.buffer.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

const TOP = 0x80_00_00_00;

/** Floats as the unsigned integers that order as they do (pack's `ordered`). */
function ordered32(x: number): number {
  return x & TOP ? ~x >>> 0 : (x | TOP) >>> 0;
}

function words(bytes: Uint8Array): Uint32Array {
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  return new Uint32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.length / 4
  );
}

/** The values the take carries for `data` (alone, or less `base`), as bytes. */
export function codeValues(
  kind: Kind,
  data: Uint8Array,
  base?: Uint8Array
): Uint8Array {
  if (kind.width === 1) {
    if (!base) return data;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++)
      out[i] = ((data[i] ?? 0) - (base[i] ?? 0)) & 0xff;
    return out;
  }
  const a = words(data);
  const b = base ? words(base) : undefined;
  const out = new Uint32Array(a.length);
  if (kind.width === 4) {
    for (let i = 0; i < a.length; i++) {
      const x = kind.float ? ordered32(a[i] ?? 0) : (a[i] ?? 0);
      const y = b ? (kind.float ? ordered32(b[i] ?? 0) : (b[i] ?? 0)) : 0;
      out[i] = (x - y) >>> 0;
    }
  } else {
    // 64-bit lanes as (low, high) words
    const ord = (w: Uint32Array, i: number): [number, number] => {
      const lo = w[i] ?? 0;
      const hi = w[i + 1] ?? 0;
      return hi & TOP ? [~lo >>> 0, ~hi >>> 0] : [lo, (hi | TOP) >>> 0];
    };
    for (let i = 0; i < a.length; i += 2) {
      const [alo, ahi] = ord(a, i);
      const [blo, bhi] = b ? ord(b, i) : [0, 0];
      out[i] = (alo - blo) >>> 0;
      out[i + 1] = (ahi - bhi - (alo < blo ? 1 : 0)) >>> 0;
    }
  }
  return new Uint8Array(out.buffer);
}

/** Elements lane by lane, then byte by byte (pack's `planes`). */
export function planes(
  bytes: Uint8Array,
  width: number,
  lanes: number
): Uint8Array {
  const n = bytes.length / width;
  const l = lanes > 1 && n % lanes === 0 ? lanes : 1;
  const per = n / l;
  const out = new Uint8Array(bytes.length);
  for (let lane = 0; lane < l; lane++)
    for (let b = 0; b < width; b++) {
      // byte b of lane `lane`'s elements, in item order
      let from = lane * width + b;
      const to = b * n + lane * per;
      for (let j = 0; j < per; j++, from += l * width)
        out[to + j] = bytes[from] as number;
    }
  return out;
}

function bytesOf(data: Float32Array | Float64Array | Uint32Array | Uint8Array) {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(data: Uint8Array, base: Uint8Array): boolean {
  if (base.length >= data.length) return false;
  for (let i = 0; i < base.length; i++) if (data[i] !== base[i]) return false;
  return true;
}

/** A take writer that is also the film reader's sink: feed it a chunk, then
 * `drain` its messages for the player. */
export class TakeWriter implements DrawSink {
  private readonly out = new Out();
  private nextKey = 1;
  private chunk = 0;
  // the arrays each upload was last sent with, by "upload:role": the bases of
  // the next chunk's (the film's own bases go back one chunk)
  private readonly uploads = new Map<string, Sent>();
  private readonly views = new Map<number, Sent>(); // a view's last records
  private readonly images = new Map<number, Sent>(); // a track's last frame
  private readonly tracks: FilmMeta['tracks'];
  private readonly compress: (bytes: Uint8Array) => Uint8Array;
  private readonly frameOf: (track: number, index: number) => Uint8Array;

  /** `compress` makes a zstd frame; `frameOf` answers an image track's
   * frame as RGBA (its chunk's segments decoded). */
  constructor(
    meta: FilmMeta,
    compress: (bytes: Uint8Array) => Uint8Array,
    frameOf: (track: number, index: number) => Uint8Array = () => {
      throw new Error('the film shows an image track it has not decoded');
    }
  ) {
    this.tracks = meta.tracks;
    this.compress = compress;
    this.frameOf = frameOf;
    const at = this.begin(OP.START);
    this.out.u32(TAKE_VERSION);
    this.out.u32(meta.width);
    this.out.u32(meta.height);
    this.out.f64(meta.fps);
    this.finish(at);
  }

  /** Chunk c begins: arrays older than the chunk before are bases no more. */
  startChunk(c: number) {
    this.chunk = c;
    for (const [ref, sent] of this.uploads)
      if (sent.chunk < c - 1) this.uploads.delete(ref);
  }

  drain(): Uint8Array {
    return this.out.drain();
  }

  private begin(op: number): number {
    const at = this.out.length;
    this.out.u32(0);
    this.out.u8(op);
    return at;
  }

  private finish(at: number) {
    this.out.setU32(at, this.out.length - at - 4);
  }

  /** Send an array, coded against `base` when that fits: its key. */
  private array(kind: Kind, data: Uint8Array, base?: Sent, tail = false): Sent {
    let mode = ALONE;
    let values: Uint8Array;
    const usable = base && base.depth < DEPTH ? base : undefined;
    if (usable && tail && startsWith(data, usable.bytes)) {
      mode = TAIL;
      values = codeValues(kind, data.subarray(usable.bytes.length));
    } else if (usable && !tail && usable.bytes.length === data.length) {
      mode = FIRST;
      values = codeValues(kind, data, usable.bytes);
    } else {
      values = codeValues(kind, data);
    }
    const blob = this.compress(planes(values, kind.width, kind.lanes));
    const key = this.nextKey++;
    const at = this.begin(OP.ARRAY);
    this.out.u64(key);
    this.out.u64(mode === ALONE ? 0 : (usable?.key ?? 0));
    this.out.u8(kind.id);
    this.out.u8(mode);
    this.out.string(blob);
    this.finish(at);
    return {
      bytes: data,
      chunk: this.chunk,
      depth: mode === ALONE ? 0 : (usable?.depth ?? 0) + 1,
      key,
    };
  }

  /** An upload's array in `role`, coded as the film coded it. */
  private uploadArray(
    upload: number,
    role: number,
    kind: Kind,
    coded: Coded<Float32Array | Float64Array | Uint32Array | Uint8Array>
  ): number {
    const coding: Coding = coded.coding;
    const base =
      coding.mode === 'alone'
        ? undefined
        : this.uploads.get(`${coding.base}:${role}`);
    const sent = this.array(
      kind,
      bytesOf(coded.data),
      base,
      coding.mode === 'tail'
    );
    this.uploads.set(`${upload}:${role}`, sent);
    return sent.key;
  }

  private upload(op: number, key: number, head: () => void, arrays: number[]) {
    const at = this.begin(op);
    this.out.u64(key);
    head();
    for (const k of arrays) this.out.u64(k);
    this.finish(at);
  }

  path(
    key: number,
    points: Coded<Float64Array>,
    subpaths: Coded<Uint32Array>,
    centroidArea: number[]
  ) {
    const arrays = [
      this.uploadArray(key, 0, KIND.PathPoints, points),
      this.uploadArray(key, 1, KIND.PathSubpaths, subpaths),
    ];
    this.upload(
      OP.PATH,
      key,
      () => {
        for (const x of centroidArea) this.out.f32(x);
      },
      arrays
    );
  }

  grow(key: number, points: Float64Array, closed: boolean) {
    const sent = this.array(KIND.PathPoints, bytesOf(points));
    this.upload(OP.GROW, key, () => this.out.u8(closed ? 1 : 0), [sent.key]);
  }

  points(key: number, vertices: Coded<Float32Array>) {
    const arrays = [this.uploadArray(key, 0, KIND.Points, vertices)];
    this.upload(OP.POINTS, key, () => undefined, arrays);
  }

  mesh(
    key: number,
    arrays: {
      normals: Coded<Float32Array>;
      points: Coded<Float32Array>;
      triangles: Coded<Uint32Array>;
      uvs: Coded<Float32Array>;
    },
    outline: number,
    block: number
  ) {
    const keys = [
      this.uploadArray(key, 0, KIND.MeshPoints, arrays.points),
      this.uploadArray(key, 1, KIND.MeshUvs, arrays.uvs),
      this.uploadArray(key, 2, KIND.MeshNormals, arrays.normals),
      this.uploadArray(key, 3, KIND.MeshTriangles, arrays.triangles),
    ];
    this.upload(
      OP.MESH,
      key,
      () => {
        this.out.u32(outline);
        this.out.u32(block);
      },
      keys
    );
  }

  rows(key: number, rows: Coded<Float32Array>) {
    const arrays = [this.uploadArray(key, 0, KIND.Rows, rows)];
    this.upload(OP.ROWS, key, () => undefined, arrays);
  }

  texture(key: number, width: number, height: number, rgba: Coded<Uint8Array>) {
    const arrays = [this.uploadArray(key, 0, KIND.Texture, rgba)];
    this.upload(
      OP.TEXTURE,
      key,
      () => {
        this.out.u32(width);
        this.out.u32(height);
      },
      arrays
    );
  }

  video(key: number, track: number, index: number) {
    // an image track's frame: its texture, coded against the track's last
    const size = this.tracks[track];
    if (!size) throw new Error(`the film has no track ${track}`);
    const { width, height } = size;
    const rgba = this.frameOf(track, index);
    const sent = this.array(KIND.Texture, rgba, this.images.get(track));
    this.images.set(track, sent);
    this.upload(
      OP.TEXTURE,
      key,
      () => {
        this.out.u32(width);
        this.out.u32(height);
      },
      [sent.key]
    );
  }

  environment(id: number, width: number, height: number, rgbe: Uint8Array) {
    const sent = this.array(KIND.Texture, rgbe);
    const at = this.begin(OP.ENVIRONMENT);
    this.out.u32(id);
    this.out.u32(width);
    this.out.u32(height);
    this.out.u64(sent.key);
    this.finish(at);
  }

  frame(
    view: Uint8Array,
    records: Uint8Array,
    repeat: number,
    cameras: CameraView[]
  ) {
    // each view's records coded against its records the frame before
    const recordsKey = (id: number, bytes: Uint8Array) => {
      const sent = this.array(KIND.Records, bytes, this.views.get(id));
      this.views.set(id, sent);
      return sent.key;
    };
    const main = recordsKey(0, records);
    const cameraKeys = cameras.map(([id, , , , r]) => recordsKey(id, r));
    const at = this.begin(OP.FRAME);
    this.out.u32(repeat);
    this.out.string(view);
    this.out.u64(main);
    this.out.u32(cameras.length);
    cameras.forEach(([id, width, height, cameraView], i) => {
      this.out.u64(id);
      this.out.u32(width);
      this.out.u32(height);
      this.out.string(cameraView);
      this.out.u64(cameraKeys[i] ?? 0);
    });
    this.finish(at);
  }

  note(json: string) {
    const at = this.begin(OP.NOTE);
    this.out.string(new TextEncoder().encode(json));
    this.finish(at);
  }

  sound(file: Uint8Array) {
    const at = this.begin(OP.SOUND);
    this.out.string(file);
    this.finish(at);
  }

  end(failed: boolean) {
    const at = this.begin(OP.END);
    this.out.u8(failed ? 1 : 0);
    this.finish(at);
  }
}
