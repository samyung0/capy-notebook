/**
 * Reads a film off the main thread: a video film becomes an MP4 file for the
 * page's <video>; a drawn film becomes ManimGX take messages, posted a chunk
 * at a time so the player starts before the whole film is read. An image
 * track's frames are decoded with WebCodecs, a chunk at a time.
 */
import { compress, init } from '@bokuweb/zstd-wasm';
import { Film, type FilmMeta } from './cmv';
import { muxMp4, nalUnits } from './mp4';
import { TakeWriter } from './take';

export type FilmRequest = { url: string };

export type FilmReply =
  | { meta: FilmMeta; type: 'meta' }
  | { mp4: ArrayBuffer; type: 'video' }
  | { bytes: ArrayBuffer; done: boolean; type: 'take' }
  | { message: string; type: 'error' };

/** zstd level of the take's arrays: ManimGX's writer uses 3; 1 is as small
 * on the example films, and faster. */
const LEVEL = 1;

const post = (reply: FilmReply, transfer: Transferable[] = []) =>
  self.postMessage(reply, { transfer });

/** A run of Annex-B units decoded to RGBA frames, in order. */
async function decode(
  units: Uint8Array[],
  width: number,
  height: number
): Promise<Uint8Array[]> {
  const sps =
    units[0] && nalUnits(units[0]).find((n) => ((n[0] ?? 0) & 31) === 7);
  if (!sps) throw new Error('an image track has no parameter sets');
  const hex = (x: number | undefined) => (x ?? 0).toString(16).padStart(2, '0');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2D canvas in this worker');
  const frames: Uint8Array[] = [];
  let failure: unknown;
  const decoder = new VideoDecoder({
    error: (error) => {
      failure = error;
    },
    output: (frame) => {
      context.drawImage(frame, 0, 0, width, height);
      frame.close();
      frames.push(
        new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
      );
    },
  });
  decoder.configure({
    codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
  });
  units.forEach((data, i) => {
    decoder.decode(
      new EncodedVideoChunk({
        data,
        timestamp: i,
        type: i === 0 ? 'key' : 'delta',
      })
    );
  });
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  return frames;
}

async function drawn(film: Film) {
  // the browser build finds its wasm next to itself (vite.config.ts keeps
  // it out of the dependency pre-bundle)
  await init();
  let shown = new Map<number, { first: number; rgba: Uint8Array[] }>();
  const writer = new TakeWriter(
    film.meta,
    (bytes) => compress(bytes, LEVEL),
    (track, index) => {
      const frames = shown.get(track);
      const frame = frames?.rgba[index - frames.first];
      if (!frame) throw new Error(`image track ${track} has no frame ${index}`);
      return frame;
    }
  );
  for (let c = 0; c < film.chunks.length; c++) {
    shown = new Map();
    for (const segment of film.segments(c)) {
      const track = film.meta.tracks[segment.track];
      if (!track) throw new Error(`the film has no track ${segment.track}`);
      const rgba = await decode(segment.colour, track.width, track.height);
      if (segment.alpha.length) {
        // the alpha track is grey: its red channel is the alpha
        const alpha = await decode(segment.alpha, track.width, track.height);
        rgba.forEach((frame, i) => {
          const a = alpha[i];
          if (a)
            for (let p = 3; p < frame.length; p += 4)
              frame[p] = a[p - 3] ?? 255;
        });
      }
      shown.set(segment.track, { first: segment.first, rgba });
    }
    writer.startChunk(c);
    film.chunk(c, writer);
    const bytes = writer.drain();
    post(
      {
        bytes: bytes.buffer as ArrayBuffer,
        done: c === film.chunks.length - 1,
        type: 'take',
      },
      [bytes.buffer as ArrayBuffer]
    );
  }
}

function video(film: Film) {
  const units = film.chunks.flatMap((_, c) =>
    film.segments(c).flatMap((s) => s.colour)
  );
  const mp4 = muxMp4(units, film.meta.width, film.meta.height, film.meta.fps);
  post({ mp4: mp4.buffer as ArrayBuffer, type: 'video' }, [
    mp4.buffer as ArrayBuffer,
  ]);
}

self.addEventListener('message', async (event: MessageEvent<FilmRequest>) => {
  try {
    const response = await fetch(event.data.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const film = new Film(new Uint8Array(await response.arrayBuffer()));
    post({ meta: film.meta, type: 'meta' });
    if (film.meta.form === 'video') video(film);
    else await drawn(film);
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      type: 'error',
    });
  }
});
