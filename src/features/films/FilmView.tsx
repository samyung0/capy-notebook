import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { CannotShow } from '@/features/materials/CannotShow';
import { m } from '@/i18n';
import type { FilmMeta } from './cmv';
import { type Chapter, type FilmControl, videoControl } from './control';
import { DrawnPlayer } from './drawnPlayer';
import { hasWebGpu, loadEngine } from './engine';
import { type FilmFit, FilmPlayer } from './FilmPlayer';
import type { FilmReply, FilmRequest } from './film.worker';

/** Where each film was when its player let go (a film block scrolled away),
 * by link: it opens there again, paused. */
const resumeAt = new Map<string, number>();

type State =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'no-webgpu' }
  | { meta: FilmMeta; phase: 'video'; src: string }
  | { meta: FilmMeta; phase: 'drawn' };

/** A CMV film (a ManimGX scene the user exported, cmv.ts): a video film in
 * the browser's <video>, a drawn film on ManimGX's player, both under Capy's
 * own controls (FilmPlayer). The file viewer centres it at most 48rem wide;
 * `embedded` (a note's film block, a canvas card) fills its container's width
 * at the film's proportions, with no frame (Epo 2026-11-27); `contain` (a
 * canvas card) fits it inside its container's box instead. */
export default function FilmView({
  contain = false,
  embedded = false,
  name,
  onRetry,
  url,
}: {
  contain?: boolean;
  embedded?: boolean;
  name: string;
  onRetry: () => void;
  url: string;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // a drawn film's take, kept for its life: a film that rests (its player
  // and engine gone) wakes from it without converting the film again
  const takes = useRef<Uint8Array[]>([]);
  const player = useRef<DrawnPlayer | null>(null);
  // its last picture while it rests and until it is drawn again
  const [poster, setPoster] = useState<string | null>(null);
  const [resting, setResting] = useState(false);
  // a play asked for while it rested (or before its player was up)
  const wantPlay = useRef(false);
  const rate = useRef(1);
  // FilmPlayer's play-or-pause, for a click on the film
  const toggle = useRef<(() => void) | null>(null);
  // the drawn player's poses and hover changed: FilmPlayer draws again
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./film.worker.ts', import.meta.url), {
      type: 'module',
    });
    let src: string | undefined;
    let meta: FilmMeta | undefined;
    takes.current = [];
    setState({ phase: 'loading' });
    setPoster(null);
    setResting(false);
    worker.addEventListener('message', (event: MessageEvent<FilmReply>) => {
      const reply = event.data;
      if (reply.type === 'meta') {
        meta = reply.meta;
        if (reply.meta.form !== 'drawn') return;
        if (hasWebGpu()) setState({ meta: reply.meta, phase: 'drawn' });
        else {
          worker.terminate();
          setState({ phase: 'no-webgpu' });
        }
      } else if (reply.type === 'video' && meta) {
        src = URL.createObjectURL(new Blob([reply.mp4], { type: 'video/mp4' }));
        setState({ meta, phase: 'video', src });
        worker.terminate();
      } else if (reply.type === 'take') {
        const bytes = new Uint8Array(reply.bytes);
        takes.current.push(bytes);
        player.current?.feed(bytes);
        // Its last: the worker's decoded arrays (hundreds of MB on a 3D
        // film) are let go now, not when the film is.
        if (reply.done) worker.terminate();
      } else setState({ phase: 'failed' });
    });
    worker.addEventListener('error', () => setState({ phase: 'failed' }));
    worker.postMessage({ url } satisfies FilmRequest);
    return () => {
      worker.terminate();
      if (src) URL.revokeObjectURL(src);
    };
  }, [url]);

  const drawn = state.phase === 'drawn';
  const filmWidth = drawn ? state.meta.width : 0;
  useEffect(() => {
    if (!drawn || resting) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    loadEngine().then(
      (loaded) => {
        release = loaded.release;
        if (cancelled || !(box.current && canvas.current)) {
          release();
          return;
        }
        try {
          player.current = new DrawnPlayer(
            loaded.engine,
            box.current,
            canvas.current,
            filmWidth,
            resumeAt.get(url) ?? 0,
            {
              onChange: changed,
              onDrawn: () => setPoster(null),
              onError: () => setState({ phase: 'failed' }),
              onRest: () => {
                // a WebGPU canvas reads back the picture it last showed
                setPoster(canvas.current?.toDataURL() ?? null);
                setResting(true);
              },
              onToggle: () => toggle.current?.(),
            }
          );
          player.current.rate = rate.current;
        } catch {
          setState({ phase: 'failed' });
          return;
        }
        for (const bytes of takes.current) player.current.feed(bytes);
        if (wantPlay.current) toggle.current?.();
        wantPlay.current = false;
        changed();
      },
      () => {
        if (!cancelled) setState({ phase: 'failed' });
      }
    );
    return () => {
      cancelled = true;
      if (player.current) resumeAt.set(url, player.current.destroy());
      player.current = null;
      release?.();
    };
  }, [drawn, filmWidth, resting, url]);

  // a drawn film's controls: its player, or while that isn't up (loading, or
  // resting) where it will be
  const meta = drawn ? state.meta : null;
  const drawnControl = useMemo((): FilmControl | null => {
    if (!meta) return null;
    const wake = () => setResting(false);
    return {
      get duration() {
        return meta.frames / meta.fps;
      },
      pause: () => player.current?.pause(),
      play: () => {
        if (player.current) player.current.play();
        else {
          wantPlay.current = true;
          wake();
        }
      },
      get playing() {
        return player.current?.playing ?? false;
      },
      get rate() {
        return rate.current;
      },
      set rate(r) {
        rate.current = r;
        if (player.current) player.current.rate = r;
      },
      get time() {
        return player.current?.time ?? resumeAt.get(url) ?? 0;
      },
      set time(t) {
        if (player.current) player.current.time = t;
        else {
          resumeAt.set(url, t);
          wake();
        }
      },
    };
  }, [meta, url]);
  const videoFilm = useMemo(() => video && videoControl(video), [video]);

  if (embedded && state.phase === 'failed')
    return <CannotShow label={m.film_cannot_show()} />;
  if (embedded && state.phase === 'no-webgpu')
    return <CannotShow label={m.files_film_webgpu_title()} />;
  if (embedded && state.phase === 'loading')
    return <Skeleton className="aspect-video w-full rounded-none" />;
  if (state.phase === 'failed') return <FileError onRetry={onRetry} />;
  if (state.phase === 'no-webgpu')
    return (
      <FileError
        message={m.files_film_webgpu_body()}
        title={m.files_film_webgpu_title()}
      />
    );
  if (state.phase === 'loading') return <FileLoading />;
  const { height, width } = state.meta;
  const fit: FilmFit = embedded ? (contain ? 'contain' : 'width') : 'viewer';
  const drawnFilm = state.phase === 'drawn' ? player.current : null;
  const control = state.phase === 'video' ? videoFilm : drawnControl;
  const surface =
    state.phase === 'video' ? (
      <video
        className="absolute inset-0 size-full"
        onClick={() => toggle.current?.()}
        onError={() => setState({ phase: 'failed' })}
        onLoadedMetadata={(event) => {
          event.currentTarget.currentTime = resumeAt.get(url) ?? 0;
          changed(); // its duration
        }}
        onSeeked={changed}
        ref={(element) => {
          setVideo(element);
          if (!element) return;
          return () => {
            resumeAt.set(url, element.currentTime);
          };
        }}
        src={state.src}
      />
    ) : (
      <div className="absolute inset-0" ref={box}>
        <canvas
          className="absolute inset-0 size-full touch-pan-y"
          ref={canvas}
        />
        {poster && (
          <img
            alt=""
            className="absolute inset-0 size-full cursor-pointer"
            onPointerDown={(event) => {
              if (!resting || event.button !== 0) return;
              wantPlay.current = true;
              setResting(false);
            }}
            src={poster}
          />
        )}
      </div>
    );
  const film = (
    <FilmPlayer
      aspect={width / height}
      captions={rows(state.meta.captions)}
      chapters={rows(state.meta.slides)}
      control={control ?? STILL}
      drawn={drawnFilm}
      fit={fit}
      name={name}
      toggleRef={toggle}
    >
      {surface}
    </FilmPlayer>
  );
  if (fit === 'width') return film;
  if (fit === 'contain')
    return (
      <div className="grid size-full place-items-center [container-type:size]">
        {film}
      </div>
    );
  return (
    // the film at its proportions, at most 48rem wide, at the top so what
    // shows under it (a task) moves nothing; a phone gives it the whole width
    <div className="grid h-full min-h-0 content-start justify-items-center [container-type:size] sm:p-6">
      {film}
    </div>
  );
}

/** A header's [start, end, text] rows as slides or captions. */
const rows = (list: [number, number, string][] = []): Chapter[] =>
  list.map(([start, end, title]) => ({ end, start, title }));

/** A video film's controls before its <video> is up. */
const STILL: FilmControl = {
  duration: 0,
  pause: () => undefined,
  play: () => undefined,
  playing: false,
  rate: 1,
  time: 0,
};
