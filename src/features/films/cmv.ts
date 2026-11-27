/**
 * Reads a CMV film: the file the cmv-manimgx exporter (https://github.com/samyung0/cmv-manim)
 * writes on the user's computer, played here without running its scene. The
 * format is described in its manimgx/src/cmv_manimgx/cmv.py; the server
 * checks its structure on upload (server/internal/cmvfile).
 *
 * A video film's chunks hold H.264 segments only (`segments`). A drawn film's
 * chunks also hold what ManimGX's engine was asked to draw, coded against the
 * chunk before: `chunk` decodes one and hands each upload and frame to a sink
 * (take.ts writes them as ManimGX's player reads them).
 */
import { decompress } from 'fzstd';
import { refine } from './surface';

export type FilmForm = 'drawn' | 'video';

export interface FilmTrack {
  alpha: boolean;
  height: number;
  width: number;
}

export interface FilmMeta {
  chunks: number;
  form: FilmForm;
  fps: number;
  frames: number;
  height: number;
  q?: Record<string, number>;
  scene?: string;
  tracks: FilmTrack[];
  width: number;
}

export interface FilmChunk {
  draw: number;
  first: number;
  frames: number;
  offset: number;
  video: number;
}

/** A run of H.264 access units (Annex-B), the first a keyframe. */
export interface FilmSegment {
  alpha: Uint8Array[];
  colour: Uint8Array[];
  first: number;
  track: number;
}

/** How an upload's array was coded: against `base` (an earlier upload's key)
 * as its difference, or as `base` with more after it (`tail`). */
export type Coding =
  | { base: number; mode: 'tail' | 'difference' }
  | { mode: 'alone' };

export interface Coded<T> {
  coding: Coding;
  data: T;
}

/** What a drawn chunk holds, in the order the engine was asked for it. */
export interface DrawSink {
  end(failed: boolean): void;
  environment(
    id: number,
    width: number,
    height: number,
    rgbe: Uint8Array
  ): void;
  frame(
    view: Uint8Array,
    records: Uint8Array,
    repeat: number,
    cameras: CameraView[]
  ): void;
  grow(key: number, points: Float64Array, closed: boolean): void;
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
  ): void;
  note(json: string): void;
  path(
    key: number,
    points: Coded<Float64Array>,
    subpaths: Coded<Uint32Array>,
    centroidArea: number[]
  ): void;
  points(key: number, vertices: Coded<Float32Array>): void;
  rows(key: number, rows: Coded<Float32Array>): void;
  sound(file: Uint8Array): void;
  texture(
    key: number,
    width: number,
    height: number,
    rgba: Coded<Uint8Array>
  ): void;
  /** An image track's frame `index` as the upload `key`'s texture. */
  video(key: number, track: number, index: number): void;
}

/** A camera's own view: its key, size, view and records. */
export type CameraView = [number, number, number, Uint8Array, Uint8Array];

const MAGIC = 'CMV0';
const INDEX_ENTRY = 24;
/** A record's bytes: 7 keys (u64), 2 int32s, then 68 float32s. */
export const RECORD_BYTES = 336;

const ALONE = 0;
const FIRST = 1;
const SECOND = 2;
const TAIL = 3;

const OP = {
  END: 13,
  ENVIRONMENT: 11,
  FRAME: 8,
  GRID: 4,
  GROW: 7,
  MESH: 3,
  NOTE: 9,
  PATH: 1,
  POINTS: 2,
  ROWS: 5,
  SOUND: 10,
  TEXTURE: 6,
  VIDEO_FRAME: 12,
} as const;

/** An int array: `n` rows of `lanes`, row-major. */
interface Ints {
  a: Float64Array;
  lanes: number;
  n: number;
}

class In {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  at = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new Error('the film ends early');
    this.at += 1;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  f32s(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.view.getFloat32(this.at, true));
      this.at += 4;
    }
    return out;
  }

  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new Error('the film ends early');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  string(): Uint8Array {
    return this.take(this.u32());
  }

  done(): boolean {
    return this.at >= this.bytes.length;
  }

  /** Stored lane by lane as int32; returned row-major. */
  ints(): Ints {
    const n = this.u32();
    const lanes = this.u8();
    const raw = this.take(4 * n * lanes).slice(); // aligned copy
    const src = new Int32Array(raw.buffer);
    const a = new Float64Array(n * lanes);
    for (let l = 0; l < lanes; l++)
      for (let i = 0; i < n; i++) a[i * lanes + l] = src[l * n + i] ?? 0;
    return { a, lanes, n };
  }
}

function cumsum({ a, lanes, n }: Ints, start?: Float64Array) {
  for (let l = 0; l < lanes; l++) {
    let s = start ? (start[l] ?? 0) : 0;
    for (let i = 0; i < n; i++) {
      s += a[i * lanes + l] ?? 0;
      a[i * lanes + l] = s;
    }
  }
}

/** Order-preserving integer → float32 bits (cmv.unordered). */
function unordered(o: number): number {
  return o < 0 ? (-(o + 1) | 0x80_00_00_00) >>> 0 : o >>> 0;
}

function scaled<T extends Float32Array | Float64Array>(
  q: Ints,
  step: number,
  Type: new (n: number) => T
): T {
  const out = new Type(q.a.length);
  for (let i = 0; i < q.a.length; i++) out[i] = (q.a[i] ?? 0) / step;
  return out;
}

function step(meta: FilmMeta, name: string): number {
  const value = meta.q?.[name];
  if (!value) throw new Error(`the film has no ${name} step`);
  return value;
}

/** The header and chunk index of a film. */
export function readFilm(bytes: Uint8Array): {
  body: number;
  chunks: FilmChunk[];
  meta: FilmMeta;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC)
    throw new Error('not a CMV film');
  const n = view.getUint32(4, true);
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + n))
  ) as FilmMeta;
  const chunks: FilmChunk[] = [];
  let at = 8 + n;
  for (let i = 0; i < meta.chunks; i++, at += INDEX_ENTRY) {
    chunks.push({
      draw: view.getUint32(at + 8, true),
      first: view.getUint32(at + 16, true),
      frames: view.getUint32(at + 20, true),
      offset: Number(view.getBigUint64(at, true)),
      video: view.getUint32(at + 12, true),
    });
  }
  return { body: at, chunks, meta };
}

/** A film's chunks, read in order. */
export class Film {
  readonly body: number;
  readonly chunks: FilmChunk[];
  readonly meta: FilmMeta;
  // decoded arrays by "key:role", the chunk each was written in, and its base:
  // only the current and previous chunk's are bases (cmv.forget)
  private readonly arrays = new Map<string, Ints>();
  private readonly written = new Map<string, number>();
  private current = 0;
  private view: Ints | null = null;
  private view2: Ints | null = null;
  private records: Ints | null = null;
  private records2: Ints | null = null;

  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const { body, chunks, meta } = readFilm(bytes);
    this.body = body;
    this.chunks = chunks;
    this.meta = meta;
  }

  /** Chunk c's H.264 segments. */
  segments(c: number): FilmSegment[] {
    const chunk = this.chunks[c];
    if (!chunk?.video) return [];
    const at = this.body + chunk.offset + chunk.draw;
    const inp = new In(this.bytes.subarray(at, at + chunk.video));
    const out: FilmSegment[] = [];
    for (let s = inp.u8(); s > 0; s--) {
      const track = inp.u32();
      const first = inp.u32();
      const n = inp.u32();
      const alpha = this.meta.tracks[track]?.alpha ?? false;
      const sizes = Array.from({ length: alpha ? 2 * n : n }, () => inp.u32());
      const units = sizes.map((k) => inp.take(k));
      out.push({
        alpha: units.slice(n),
        colour: units.slice(0, n),
        first,
        track,
      });
    }
    return out;
  }

  private array(
    inp: In,
    key: number,
    role: number,
    points: boolean
  ): { coding: Coding; q: Ints } {
    const coding = inp.u8();
    let base: number | undefined;
    let base2: number | undefined;
    if (coding !== ALONE) {
      base = inp.u32();
      if (coding === SECOND) base2 = inp.u32();
    }
    const r = inp.ints();
    const was =
      base === undefined ? undefined : this.arrays.get(`${base}:${role}`);
    const was2 =
      base2 === undefined ? undefined : this.arrays.get(`${base2}:${role}`);
    if (coding !== ALONE && !was) throw new Error('an array base is missing');
    let q = r;
    if (coding === ALONE) {
      if (points) cumsum(r);
    } else if (coding === FIRST && was) {
      for (let i = 0; i < r.a.length; i++) r.a[i] += was.a[i] ?? 0;
    } else if (coding === SECOND && was) {
      if (!was2) throw new Error('an array base is missing');
      for (let i = 0; i < r.a.length; i++)
        r.a[i] += 2 * (was.a[i] ?? 0) - (was2.a[i] ?? 0);
    } else if (coding === TAIL && was) {
      if (points) cumsum(r, was.a.subarray(was.a.length - was.lanes));
      const a = new Float64Array(was.a.length + r.a.length);
      a.set(was.a);
      a.set(r.a, was.a.length);
      q = { a, lanes: r.lanes, n: was.n + r.n };
    }
    const ref = `${key}:${role}`;
    this.arrays.set(ref, q);
    this.written.set(ref, this.current);
    return {
      coding:
        base === undefined
          ? { mode: 'alone' }
          : { base, mode: coding === TAIL ? 'tail' : 'difference' },
      q,
    };
  }

  private recordsArray(inp: In, base?: Ints | null, base2?: Ints | null) {
    const coding = inp.u8();
    let r = inp.ints();
    if (coding !== ALONE && !base) throw new Error('a records base is missing');
    if (coding === FIRST && base) {
      for (let i = 0; i < r.a.length; i++) r.a[i] += base.a[i] ?? 0;
    } else if (coding === SECOND && base) {
      if (!base2) throw new Error('a records base is missing');
      for (let i = 0; i < r.a.length; i++)
        r.a[i] += 2 * (base.a[i] ?? 0) - (base2.a[i] ?? 0);
    } else if (coding === TAIL && base) {
      const a = new Float64Array(base.a.length + r.a.length);
      a.set(base.a);
      a.set(r.a, base.a.length);
      r = { a, lanes: r.lanes, n: base.n + r.n };
    }
    const out = new Uint8Array(r.n * RECORD_BYTES);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < r.n; i++) {
      const row = i * r.lanes;
      const at = i * RECORD_BYTES;
      // keys below 2^53: as their low and high words
      for (let k = 0; k < 7; k++) {
        const key = r.a[row + k] ?? 0;
        dv.setUint32(at + 8 * k, key % 2 ** 32, true);
        dv.setUint32(at + 8 * k + 4, Math.floor(key / 2 ** 32), true);
      }
      dv.setInt32(at + 56, r.a[row + 7] ?? 0, true);
      dv.setInt32(at + 60, r.a[row + 8] ?? 0, true);
      for (let f = 0; f < 68; f++)
        dv.setUint32(at + 64 + 4 * f, unordered(r.a[row + 9 + f] ?? 0), true);
    }
    return { bytes: out, q: r };
  }

  /** Decode chunk c (chunks in order) into `sink`. */
  chunk(c: number, sink: DrawSink): void {
    const chunk = this.chunks[c];
    if (!chunk) throw new Error(`the film has no chunk ${c}`);
    this.current = c;
    for (const [ref, w] of this.written)
      if (w < c - 1) {
        this.arrays.delete(ref);
        this.written.delete(ref);
      }
    const start = this.body + chunk.offset;
    const inp = new In(
      chunk.draw
        ? decompress(this.bytes.subarray(start, start + chunk.draw))
        : new Uint8Array(0)
    );
    const meta = this.meta;
    while (!inp.done()) {
      const op = inp.u8();
      switch (op) {
        case OP.PATH: {
          const key = inp.u32();
          const centroidArea = inp.f32s(6);
          const p = this.array(inp, key, 0, true);
          const s = this.array(inp, key, 1, false);
          sink.path(
            key,
            {
              coding: p.coding,
              data: scaled(p.q, step(meta, 'geometry'), Float64Array),
            },
            { coding: s.coding, data: Uint32Array.from(s.q.a) },
            centroidArea
          );
          break;
        }
        case OP.GROW: {
          const key = inp.u32();
          const closed = inp.u8() !== 0;
          const r = inp.ints();
          cumsum(r);
          sink.grow(
            key,
            scaled(r, step(meta, 'geometry'), Float64Array),
            closed
          );
          break;
        }
        case OP.POINTS: {
          const key = inp.u32();
          const v = this.array(inp, key, 0, true);
          sink.points(key, {
            coding: v.coding,
            data: scaled(v.q, step(meta, 'points'), Float32Array),
          });
          break;
        }
        case OP.MESH: {
          const key = inp.u32();
          const outline = inp.u32();
          const block = inp.u32();
          const p = this.array(inp, key, 0, true);
          const uv = this.array(inp, key, 1, false);
          const nrm = this.array(inp, key, 2, false);
          const tri = this.array(inp, key, 3, false);
          sink.mesh(
            key,
            {
              normals: {
                coding: nrm.coding,
                data: scaled(nrm.q, step(meta, 'normals'), Float32Array),
              },
              points: {
                coding: p.coding,
                data: scaled(p.q, step(meta, 'surface'), Float32Array),
              },
              triangles: {
                coding: tri.coding,
                data: Uint32Array.from(tri.q.a),
              },
              uvs: {
                coding: uv.coding,
                data: scaled(uv.q, step(meta, 'uv'), Float32Array),
              },
            },
            outline,
            block
          );
          break;
        }
        case OP.GRID: {
          const key = inp.u32();
          const [u, v, first, end, steps] = [
            inp.u32(),
            inp.u32(),
            inp.u32(),
            inp.u32(),
            inp.u32(),
          ];
          const g = this.array(inp, key, 0, true);
          const uv = this.array(inp, key, 1, false);
          const mesh = refine(
            scaled(g.q, step(meta, 'surface'), Float64Array),
            scaled(uv.q, step(meta, 'uv'), Float64Array),
            u,
            v,
            steps,
            first,
            end
          );
          // the refined mesh replaces the one refined from the grid's base
          const coding = g.coding;
          sink.mesh(
            key,
            {
              normals: { coding, data: mesh.normals },
              points: { coding, data: mesh.points },
              triangles: { coding, data: mesh.triangles },
              uvs: { coding, data: mesh.uvs },
            },
            4 * steps + 1,
            mesh.block
          );
          break;
        }
        case OP.ROWS: {
          const key = inp.u32();
          const k = inp.u32();
          const r = this.array(inp, key, 0, false);
          const cells = scaled(r.q, step(meta, 'rows'), Float32Array);
          let rows = cells;
          if (k > 1) {
            rows = new Float32Array(cells.length * k);
            for (let i = 0; i < cells.length / 4; i++)
              for (let j = 0; j < k; j++)
                rows.set(cells.subarray(i * 4, i * 4 + 4), (i * k + j) * 4);
          }
          sink.rows(key, { coding: r.coding, data: rows });
          break;
        }
        case OP.TEXTURE: {
          const key = inp.u32();
          const width = inp.u32();
          const height = inp.u32();
          const px = this.array(inp, key, 0, false);
          sink.texture(key, width, height, {
            coding: px.coding,
            data: Uint8Array.from(px.q.a),
          });
          break;
        }
        case OP.VIDEO_FRAME: {
          const key = inp.u32();
          const track = inp.u32();
          sink.video(key, track, inp.u32());
          break;
        }
        case OP.ENVIRONMENT: {
          const id = inp.u32();
          const width = inp.u32();
          const height = inp.u32();
          sink.environment(id, width, height, inp.string());
          break;
        }
        case OP.FRAME: {
          const repeat = inp.u32();
          const coding = inp.u8();
          const r = inp.ints();
          if (coding !== ALONE && !this.view)
            throw new Error('a view base is missing');
          if (coding === FIRST && this.view) {
            for (let i = 0; i < r.a.length; i++) r.a[i] += this.view.a[i] ?? 0;
          } else if (coding === SECOND && this.view && this.view2) {
            for (let i = 0; i < r.a.length; i++)
              r.a[i] += 2 * (this.view.a[i] ?? 0) - (this.view2.a[i] ?? 0);
          }
          this.view2 = this.view;
          this.view = r;
          const view = new Uint32Array(r.a.length);
          for (let i = 0; i < r.a.length; i++) view[i] = unordered(r.a[i] ?? 0);
          const records = this.recordsArray(inp, this.records, this.records2);
          this.records2 = this.records;
          this.records = records.q;
          const cameras: CameraView[] = [];
          for (let k = inp.u32(); k > 0; k--) {
            const id = inp.u32();
            const width = inp.u32();
            const height = inp.u32();
            const cameraView = inp.string();
            cameras.push([
              id,
              width,
              height,
              cameraView,
              this.recordsArray(inp).bytes,
            ]);
          }
          sink.frame(
            new Uint8Array(view.buffer),
            records.bytes,
            repeat,
            cameras
          );
          break;
        }
        case OP.NOTE:
          sink.note(new TextDecoder().decode(inp.string()));
          break;
        case OP.SOUND:
          sink.sound(inp.string());
          break;
        case OP.END:
          sink.end(inp.u8() !== 0);
          break;
        default:
          throw new Error(`unknown op ${op} in chunk ${c}`);
      }
    }
  }
}
