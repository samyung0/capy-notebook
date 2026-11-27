import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { CannotShow } from '@/features/materials/CannotShow';
import { m } from '@/i18n';
import type { FilmMeta } from './cmv';
import { DrawnPlayer } from './drawnPlayer';
import { hasWebGpu, loadEngine } from './engine';
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
 * the browser's <video>, a drawn film on ManimGX's own player. The file
 * viewer centres it at most 48rem wide; `embedded` (a note's film block, a
 * canvas card) fills its container's width at the film's proportions, with
 * no frame (Epo 2026-11-27); `contain` (a canvas card) fits it inside its
 * container's box instead. */
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
  // a drawn film's take, kept until its player is up
  const takes = useRef<Uint8Array[]>([]);
  const player = useRef<DrawnPlayer | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./film.worker.ts', import.meta.url), {
      type: 'module',
    });
    let src: string | undefined;
    let meta: FilmMeta | undefined;
    takes.current = [];
    setState({ phase: 'loading' });
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
        if (player.current) player.current.feed(bytes);
        else takes.current.push(bytes);
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
  useEffect(() => {
    if (!drawn) return;
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
            resumeAt.get(url) ?? 0,
            () => setState({ phase: 'failed' })
          );
        } catch {
          setState({ phase: 'failed' });
          return;
        }
        for (const bytes of takes.current.splice(0)) player.current.feed(bytes);
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
  }, [drawn, url]);

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
  const film = (
    <div
      aria-label={name}
      className="relative bg-black outline-none"
      ref={box}
      role={state.phase === 'drawn' ? 'application' : undefined}
      style={{
        aspectRatio: `${width} / ${height}`,
        width:
          embedded && !contain
            ? '100%'
            : `min(100cqw, ${width / height} * 100cqh${embedded ? '' : ', 48rem'})`,
      }}
      tabIndex={state.phase === 'drawn' ? 0 : undefined}
    >
      {state.phase === 'video' ? (
        <video
          className="absolute inset-0 size-full"
          controls
          onError={() => setState({ phase: 'failed' })}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = resumeAt.get(url) ?? 0;
          }}
          ref={(element) => {
            if (!element) return;
            return () => {
              resumeAt.set(url, element.currentTime);
            };
          }}
          src={state.src}
        />
      ) : (
        <canvas
          className="absolute inset-0 size-full touch-pan-y"
          ref={canvas}
        />
      )}
    </div>
  );
  if (embedded && !contain) return film;
  if (embedded)
    return (
      <div className="grid size-full place-items-center [container-type:size]">
        {film}
      </div>
    );
  return (
    // the film at its proportions, at most 48rem wide (both players go full
    // screen); a phone gives it the whole width
    <div className="grid h-full min-h-0 place-items-center [container-type:size] sm:p-6">
      {film}
    </div>
  );
}
