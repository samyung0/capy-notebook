import { useEffect, useRef, useState } from 'react';
import type { ViewableFile } from '@/api/types';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { m } from '@/i18n';
import type { FilmMeta } from './cmv';
import { DrawnPlayer } from './drawnPlayer';
import { hasWebGpu, loadEngine } from './engine';
import type { FilmReply, FilmRequest } from './film.worker';

type State =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'no-webgpu' }
  | { meta: FilmMeta; phase: 'video'; src: string }
  | { meta: FilmMeta; phase: 'drawn' };

/** A CMV film (a ManimGX scene the user exported, cmv.ts): a video film in
 * the browser's <video>, a drawn film on ManimGX's own player. */
export default function FilmView({
  file,
  onRetry,
}: {
  file: ViewableFile;
  onRetry: () => void;
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
      } else if (reply.type === 'take') {
        const bytes = new Uint8Array(reply.bytes);
        if (player.current) player.current.feed(bytes);
        else takes.current.push(bytes);
      } else setState({ phase: 'failed' });
    });
    worker.addEventListener('error', () => setState({ phase: 'failed' }));
    worker.postMessage({ url: file.url } satisfies FilmRequest);
    return () => {
      worker.terminate();
      if (src) URL.revokeObjectURL(src);
    };
  }, [file.url]);

  const drawn = state.phase === 'drawn';
  useEffect(() => {
    if (!drawn) return;
    let cancelled = false;
    loadEngine().then(
      (engine) => {
        if (cancelled || !(box.current && canvas.current)) return;
        try {
          player.current = new DrawnPlayer(
            engine,
            box.current,
            canvas.current,
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
      player.current?.destroy();
      player.current = null;
    };
  }, [drawn]);

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
  return (
    // the film at its proportions, as large as the pane holds
    <div className="grid h-full min-h-0 place-items-center [container-type:size]">
      <div
        aria-label={file.name}
        className="relative bg-black outline-none"
        ref={box}
        role={state.phase === 'drawn' ? 'application' : undefined}
        style={{
          aspectRatio: `${width} / ${height}`,
          width: `min(100cqw, ${width / height} * 100cqh)`,
        }}
        tabIndex={state.phase === 'drawn' ? 0 : undefined}
      >
        {state.phase === 'video' ? (
          <video
            className="absolute inset-0 size-full"
            controls
            onError={() => setState({ phase: 'failed' })}
            src={state.src}
          />
        ) : (
          <canvas
            className="absolute inset-0 size-full touch-pan-y"
            ref={canvas}
          />
        )}
      </div>
    </div>
  );
}
