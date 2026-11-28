// @vitest-environment node
import { readFileSync } from 'node:fs';
import { compress, init } from '@bokuweb/zstd-wasm';
import { decompress } from 'fzstd';
import { beforeAll, describe, expect, it } from 'vitest';
import { Film } from './cmv';
import { muxMp4 } from './mp4';
import { codeValues, planes, TakeWriter } from './take';

// A 96×64, 10 fps circle drawn in 0.9 s, exported by cmv-manimgx in each form
// (the server's check reads the same files).
const fixture = (form: string) =>
  new Film(
    new Uint8Array(readFileSync(`server/internal/cmvfile/testdata/${form}.cmv`))
  );

/** A take's messages: [op, fields]. */
function messages(take: Uint8Array): [number, DataView][] {
  const view = new DataView(take.buffer, take.byteOffset, take.byteLength);
  const out: [number, DataView][] = [];
  for (let at = 0; at < take.length; ) {
    const n = view.getUint32(at, true);
    out.push([
      take[at + 4] ?? -1,
      new DataView(take.buffer, take.byteOffset + at + 5, n - 1),
    ]);
    at += 4 + n;
  }
  return out;
}

beforeAll(() => init());

describe('CMV films', () => {
  it('reads a video film as one keyframe-led segment per chunk', () => {
    const film = fixture('video');
    expect(film.meta).toMatchObject({
      form: 'video',
      frames: 9,
      height: 64,
      width: 96,
    });
    const [segment] = film.segments(0);
    expect(segment?.colour).toHaveLength(9);
    // an IDR slice in the first access unit
    expect(segment?.colour[0]).toContain(0x65);
  });

  it('writes a drawn film as a take of uploads and frames for the whole film', () => {
    const film = fixture('drawn');
    const writer = new TakeWriter(film.meta, (bytes) => compress(bytes, 1));
    const parts: Uint8Array[] = [writer.drain()];
    film.chunks.forEach((_, c) => {
      writer.startChunk(c);
      film.chunk(c, writer);
      parts.push(writer.drain());
    });
    const take = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      take.set(p, at);
      at += p.length;
    }
    const ops = messages(take);
    const [start] = ops;
    expect(start?.[0]).toBe(14);
    expect(start?.[1].getUint32(0, true)).toBe(1); // take version
    expect(start?.[1].getUint32(4, true)).toBe(96);
    expect(ops.at(-1)?.[0]).toBe(12); // END
    const frames = ops
      .filter(([op]) => op === 8)
      .reduce((n, [, f]) => n + f.getUint32(0, true), 0);
    expect(frames).toBe(film.meta.frames);
    // every array decompresses to whole elements
    for (const [op, f] of ops.filter(([o]) => o === 11)) {
      expect(op).toBe(11);
      const blob = new Uint8Array(
        f.buffer,
        f.byteOffset + 22,
        f.getUint32(18, true)
      );
      expect(decompress(blob).length % 4).toBe(0);
    }
  });

  it('codes an unchanged array against its base as zeros', () => {
    const kind = { float: true, id: 6, lanes: 4, width: 4 } as const;
    const points = new Uint8Array(
      Float32Array.of(1, -2, 0.5, 3, 4, 5, -6, 7).buffer
    );
    expect([...codeValues(kind, points, points)].every((b) => b === 0)).toBe(
      true
    );
    // lane by lane, then byte by byte
    expect([...planes(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), 1, 4)]).toEqual([
      1, 5, 2, 6, 3, 7, 4, 8,
    ]);
  });

  it('moves a video film into an MP4 with every frame and its keyframe', () => {
    const film = fixture('video');
    const mp4 = muxMp4(film.segments(0)[0]?.colour ?? [], 96, 64, 10);
    const view = new DataView(mp4.buffer);
    const top: string[] = [];
    for (let at = 0; at < mp4.length; at += view.getUint32(at))
      top.push(new TextDecoder().decode(mp4.subarray(at + 4, at + 8)));
    expect(top).toEqual(['ftyp', 'moov', 'mdat']);
    const text = new TextDecoder('latin1').decode(mp4);
    const stsz = text.indexOf('stsz');
    expect(view.getUint32(stsz + 12)).toBe(9); // samples
    const stss = text.indexOf('stss');
    expect(view.getUint32(stss + 12)).toBe(1); // sync samples: the first
    expect(view.getUint32(stss + 8)).toBe(1);
  });

  it("muxes a video film's sound as an AAC track that starts with the picture", () => {
    const film = fixture('video-sound');
    const units = film.chunks.flatMap((_, c) =>
      film.segments(c).flatMap((s) => s.colour)
    );
    const { fps, height, width } = film.meta;
    const mp4 = muxMp4(units, width, height, fps, film.sound());
    const view = new DataView(mp4.buffer);
    const text = new TextDecoder('latin1').decode(mp4);
    expect(text.split('trak').length - 1).toBe(2);
    expect(text).toContain('mp4a');
    // the edit list starts the sound past the encoder's 1024 priming samples
    const elst = text.indexOf('elst');
    expect(view.getUint32(elst + 16)).toBe(1024);
    // every ADTS frame is a sample: 1024 samples each, at 48 kHz, ~28 s
    const audio = text.lastIndexOf('stts');
    const frames = view.getUint32(audio + 12);
    expect(view.getUint32(audio + 16)).toBe(1024);
    expect((frames * 1024) / 48_000).toBeCloseTo(film.meta.frames / fps, 0);
  });
});
