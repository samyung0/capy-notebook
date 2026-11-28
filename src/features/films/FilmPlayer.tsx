import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Chapter, FilmControl } from './control';
import type { DrawnPlayer } from './drawnPlayer';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** The progress line and the bar under the film, px. */
const BAR = 54;
/** The slides list beside the film, with its gap, px. */
const SIDE = 280;
/** From this width the slides list sits beside the film. */
const WIDE = 860;
/** Up to this film width the bar is narrow: tighter buttons, full screen in ⋮. */
const NARROW = 520;
/** The file viewer's film is at most 48rem wide. */
const VIEWER_MAX = 768;

/** How the player takes its container: the file viewer's (centred, at most
 * 48rem wide), a note's film block (its full width) or a canvas card (fitted
 * inside its box). */
export type FilmFit = 'contain' | 'viewer' | 'width';

const clock = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The slide `t` is in: the last one past the film's end. */
const slideAt = (chapters: Chapter[], t: number) => {
  const i = chapters.findIndex((c) => t >= c.start && t < c.end);
  return i === -1 ? chapters.length - 1 : i;
};

/**
 * A film with Capy's controls under it (option D of the film controls mock,
 * Epo 2026-11-28): a thin progress line with a knob, play, speed, full screen
 * and ⋮ on the left; with slides (the scene's sections), the slide count,
 * back and Next on the right, the film stopping at each slide's end, and the
 * slides listed beside the film when there's room. The same for a drawn film
 * and a video film. On a drawn film, the objects its author tagged pulse
 * faintly while it is stopped, and Reset puts back what its viewer moved.
 */
export function FilmPlayer({
  aspect,
  captions,
  chapters,
  children,
  control,
  drawn,
  fit,
  name,
  toggleRef,
}: {
  aspect: number;
  captions: Chapter[];
  chapters: Chapter[];
  /** The film's own surface: its canvas or <video>. */
  children: ReactNode;
  control: FilmControl;
  drawn?: DrawnPlayer | null;
  fit: FilmFit;
  name: string;
  /** Set to the player's play-or-pause, for a click on a drawn film. */
  toggleRef?: RefObject<(() => void) | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const [space, setSpace] = useState<[number, number] | null>(null);
  const [full, setFull] = useState(false);
  const [listHidden, setListHidden] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  // the last Check of a target, until the film moves on
  const [verdict, setVerdict] = useState<{
    distance: number;
    hit: boolean;
    id: number;
  } | null>(null);
  // where a slide that plays stops: its end
  const stopAt = useRef<number | null>(null);
  const seeking = useRef<{ resume: boolean; slide: number } | null>(null);

  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentBoxSize[0];
      if (box) setSpace([box.inlineSize, box.blockSize]);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', change);
    window.addEventListener('resize', refresh);
    return () => {
      document.removeEventListener('fullscreenchange', change);
      window.removeEventListener('resize', refresh);
    };
  }, [refresh]);

  // while it plays (and once as it stops): the clock, and a slide's end
  useEffect(() => {
    let frame = 0;
    let was = false;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const { playing } = control;
      if (!(playing || was)) return;
      was = playing;
      const end = stopAt.current;
      if (playing && end !== null && control.time >= end - 0.001) {
        control.pause();
        control.time = end - 0.001;
        stopAt.current = null;
      }
      refresh();
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [control, refresh]);

  const steps = chapters.length > 1;
  const { duration, playing } = control;
  const time = control.time;
  const i = steps ? slideAt(chapters, time) : 0;
  const slide = chapters[i];
  const last = chapters.length - 1;
  const waiting =
    steps && !playing && i < last && !!slide && time >= slide.end - 0.01;

  const play = (from?: number) => {
    if (from !== undefined) control.time = from;
    const t = control.time;
    if (!steps && t >= duration - 0.02) control.time = 0;
    stopAt.current = steps
      ? (chapters[slideAt(chapters, t)]?.end ?? null)
      : null;
    control.play();
    refresh();
  };
  const go = (k: number) => {
    const c = chapters[k];
    if (c) play(c.start);
  };
  const toggle = () => {
    if (control.playing) {
      control.pause();
      refresh();
    } else if (waiting) go(i + 1);
    else play();
  };
  const prev = () =>
    go(!waiting && slide && time - slide.start < 1 && i > 0 ? i - 1 : i);
  const fullScreen = () => {
    if (document.fullscreenElement === root.current) document.exitFullscreen();
    else root.current?.requestFullscreen?.().catch(() => undefined);
  };
  if (toggleRef) toggleRef.current = toggle;

  const seekTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width)
    );
    const c = chapters[seeking.current?.slide ?? i];
    control.time =
      steps && c
        ? c.start + x * (c.end - c.start) * 0.999
        : x * duration * 0.999;
    refresh();
  };

  const [availW, availH] = full
    ? [window.innerWidth, window.innerHeight]
    : (space ?? [0, 0]);
  const canWide = steps && fit !== 'width' && availW >= WIDE;
  const wide = canWide && !listHidden;
  let filmW = availW - (wide ? SIDE : 0);
  if (fit !== 'width' || full) filmW = Math.min(filmW, (availH - BAR) * aspect);
  if (fit === 'viewer' && !full) filmW = Math.min(filmW, VIEWER_MAX);
  filmW = Math.max(0, Math.floor(filmW));
  const narrow = filmW <= NARROW;
  const x =
    steps && slide
      ? (time - slide.start) / Math.max(1e-6, slide.end - slide.start)
      : time / Math.max(1e-6, duration);
  const progress = `${Math.min(1, Math.max(0, x)) * 100}%`;

  const more: MenuItem[] = [
    ...(captions.length > 0
      ? [
          {
            checked: captionsOn,
            closeOnSelect: false,
            icon: 'closedCaption' as const,
            label: m.film_captions(),
            onClick: () => setCaptionsOn((on) => !on),
            switch: true,
          },
        ]
      : []),
    ...(narrow
      ? [
          {
            icon: 'maximize' as const,
            label: m.film_full_screen(),
            onClick: fullScreen,
          },
        ]
      : []),
    ...(drawn
      ? [
          {
            checked: !drawn.theme,
            heading: m.film_theme(),
            label: m.film_theme_film(),
            onClick: () => {
              drawn.theme = false;
              refresh();
            },
            separated: true,
          },
          {
            checked: drawn.theme,
            label: m.film_theme_paper(),
            onClick: () => {
              drawn.theme = true;
              refresh();
            },
          },
        ]
      : []),
    ...(steps
      ? [
          {
            icon: 'refresh' as const,
            label: m.film_replay_slide(),
            onClick: () => go(i),
            separated: true,
          },
        ]
      : []),
  ];
  const barButton = cn('h-9 px-3', narrow && 'px-2.25');
  const barIcon = cn('size-9 p-0 [&>svg]:size-5.5', narrow && 'size-8.5');

  const shown = drawn && !drawn.playing ? drawn.shown() : [];
  const cue = drawn && !drawn.playing && !drawn.touched && !drawn.grabbing;
  const caption = captionsOn
    ? captions.find((c) => time >= c.start && time < c.end)
    : undefined;
  // a tagged object with a target: asked for under the bar while stopped
  const task = shown.find((o) => o.target);
  const said = verdict && !playing && verdict.id === task?.id ? verdict : null;
  // tagged 3D objects that turn: X, Y and Z turn the first a quarter
  const turner = drawn?.is3d ? shown.find((o) => o.rotate) : undefined;

  return (
    <div
      className={cn(
        'flex min-w-0 text-fg',
        full && 'h-full w-full items-center justify-center bg-surface'
      )}
      ref={root}
      style={space || full ? undefined : { width: '100%' }}
    >
      <div
        className="flex min-w-0 flex-col"
        style={space || full ? { width: filmW } : { width: '100%' }}
      >
        <div
          aria-label={name}
          className="relative overflow-hidden bg-black outline-none"
          onKeyDown={(event) => {
            const key = event.key;
            if (key === ' ' || key === 'k') toggle();
            else if (key === 'ArrowRight' && steps) go(Math.min(last, i + 1));
            else if (key === 'ArrowRight')
              control.time = Math.min(duration, time + 5);
            else if (key === 'ArrowLeft' && steps) prev();
            else if (key === 'ArrowLeft') control.time = Math.max(0, time - 5);
            else return;
            event.preventDefault();
            refresh();
          }}
          role="application"
          style={{ aspectRatio: aspect }}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the film takes its keys (space, arrows) once focused
          tabIndex={0}
        >
          {children}
          {cue &&
            shown.map(({ box, id }) => (
              <span
                className="pointer-events-none absolute rounded-full border border-action-accent motion-safe:animate-[film-halo_3s_ease-in-out_infinite]"
                key={id}
                style={{
                  height: box[3] - box[1] + 16,
                  left: box[0] - 8,
                  top: box[1] - 8,
                  width: box[2] - box[0] + 16,
                }}
              />
            ))}
          {caption && (
            <span
              className={cn(
                'pointer-events-none absolute bottom-3.5 left-1/2 max-w-[86%] -translate-x-1/2 rounded-sm bg-black/72 px-2.5 py-1.25 text-center font-semibold text-[0.95rem] text-white leading-snug',
                narrow && 'bottom-2 text-[0.8rem]'
              )}
            >
              {caption.title}
            </span>
          )}
          <div className="absolute top-2.5 right-2.5 flex gap-1.5">
            {turner &&
              (['X', 'Y', 'Z'] as const).map((axis, k) => (
                <Button
                  aria-label={m.film_turn_axis({ axis })}
                  className={cn(
                    'h-7.5 px-2.5 text-[0.8rem]',
                    drawn?.theme
                      ? 'bg-black/8 text-fg hover:bg-black/14'
                      : 'bg-white/16 text-white hover:bg-white/24'
                  )}
                  key={axis}
                  onClick={() => {
                    drawn?.quarter(turner.id, k as 0 | 1 | 2);
                    refresh();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {axis}
                </Button>
              ))}
            {drawn?.moved && (
              <Button
                className="h-7.5 px-2.5 text-[0.8rem]"
                iconLeft="refresh"
                onClick={() => {
                  drawn.reset();
                  setVerdict(null);
                  refresh();
                }}
                size="sm"
                variant="surface"
              >
                {m.film_reset()}
              </Button>
            )}
          </div>
        </div>
        <div
          className="group relative -mb-1.5 h-4 cursor-pointer touch-none"
          onPointerCancel={() => {
            seeking.current = null;
            refresh();
          }}
          onPointerDown={(event) => {
            seeking.current = { resume: control.playing, slide: i };
            control.pause();
            event.currentTarget.setPointerCapture(event.pointerId);
            seekTo(event);
          }}
          onPointerMove={(event) => {
            if (seeking.current) seekTo(event);
          }}
          onPointerUp={() => {
            const resume = seeking.current?.resume;
            seeking.current = null;
            if (resume) play();
            else refresh();
          }}
        >
          <span className="absolute inset-x-0 top-1.5 h-0.75 bg-divider group-hover:top-1.25 group-hover:h-1.25" />
          <span
            className="absolute top-1.5 left-0 h-0.75 bg-action-accent group-hover:top-1.25 group-hover:h-1.25"
            style={{ width: progress }}
          />
          <span
            className="pointer-events-none absolute top-1.75 -mt-1.5 -ml-1.5 size-3 rounded-full bg-action-accent shadow-[0_0_0_2px_var(--color-surface)] transition-transform group-hover:scale-125"
            style={{ left: progress }}
          />
        </div>
        <div className="flex min-w-0 items-center gap-0.5 pt-2">
          <IconButton
            className={barIcon}
            icon={playing ? 'pause' : 'play'}
            label={playing ? m.film_pause() : m.film_play()}
            onClick={toggle}
            variant="ghost-hover"
          />
          <Menu
            align="start"
            items={RATES.map((rate) => ({
              checked: control.rate === rate,
              label: `${rate}×`,
              onClick: () => {
                control.rate = rate;
                refresh();
              },
            }))}
            side="top"
            trigger={
              <Button
                aria-label={m.film_speed()}
                className={barButton}
                variant="ghost-hover"
              >
                <span className="relative top-[1.5px]">{control.rate}×</span>
              </Button>
            }
          />
          {!narrow && (
            <IconButton
              className={barIcon}
              icon="maximize"
              label={m.film_full_screen()}
              onClick={fullScreen}
              variant="ghost-hover"
            />
          )}
          {more.length > 0 && (
            <Menu
              align="start"
              items={more}
              side="top"
              trigger={
                <IconButton
                  className={barIcon}
                  icon="moreHorizontal"
                  label={m.film_more()}
                  variant="ghost-hover"
                />
              }
            />
          )}
          <span className="flex-1" />
          {steps ? (
            <>
              {wide || canWide ? (
                <span className="relative top-[1.5px] whitespace-nowrap px-1.5 text-[0.85rem] text-fg-muted">
                  {m.film_slide_of({ count: chapters.length, n: i + 1 })}
                </span>
              ) : (
                <Menu
                  align="end"
                  items={chapters.map((c, k) => ({
                    checked: k === i,
                    label: `${k + 1}. ${c.title}`,
                    onClick: () => go(k),
                  }))}
                  side="top"
                  trigger={
                    <Button
                      aria-label={m.film_slides()}
                      className={barButton}
                      iconRight="chevronDown"
                      variant="ghost-hover"
                    >
                      <span className="relative top-[1.5px]">
                        {i + 1}/{chapters.length}
                      </span>
                    </Button>
                  }
                />
              )}
              {canWide && listHidden && (
                <IconButton
                  className={barIcon}
                  icon="list"
                  label={m.film_show_slides()}
                  onClick={() => setListHidden(false)}
                  variant="ghost-hover"
                />
              )}
              <IconButton
                className={barIcon}
                disabled={i === 0 && time < 0.05}
                icon="navigationBack"
                label={m.film_previous_slide()}
                onClick={prev}
                variant="ghost-hover"
              />
              <Button
                className={cn(
                  barButton,
                  waiting && 'ring-3 ring-tint-accent-1'
                )}
                disabled={i >= last}
                iconRight="navigationForward"
                onClick={() => go(i + 1)}
                variant="dark"
              >
                <span className="relative top-[1.5px]">{m.film_next()}</span>
              </Button>
            </>
          ) : (
            <span className="relative top-[1.5px] whitespace-nowrap px-1 text-[0.8rem] text-fg-muted">
              {clock(time)} / {clock(duration)}
            </span>
          )}
        </div>
        {task && (
          <div className="flex min-w-0 items-center gap-2.5 pt-3">
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                said?.hit && 'font-semibold text-tint-success-fg',
                said && !said.hit && 'font-semibold text-tint-warning-fg'
              )}
            >
              {said
                ? said.hit
                  ? m.film_correct()
                  : m.film_not_yet({ distance: said.distance.toFixed(1) })
                : task.label}
            </span>
            <Button
              onClick={() => {
                const result = drawn?.check(task.id);
                if (result) setVerdict({ ...result, id: task.id });
              }}
              size="sm"
              variant="outline"
            >
              {m.film_check()}
            </Button>
          </div>
        )}
      </div>
      {wide && (
        <aside className="ml-5 flex w-65 shrink-0 flex-col border-divider border-l">
          <div className="flex h-10 items-center justify-between pr-2 pl-4 font-bold">
            {m.film_slides()}
            <IconButton
              className={barIcon}
              icon="panelRight"
              label={m.film_hide_slides()}
              onClick={() => setListHidden(true)}
              variant="ghost-hover"
            />
          </div>
          {chapters.map((c, k) => (
            <button
              className={cn(
                'flex min-h-13 cursor-pointer items-baseline gap-2.5 px-4 text-left text-fg-muted hover:bg-surface-hover-bg',
                k === i &&
                  'bg-surface-hover-bg font-bold text-fg shadow-[inset_3px_0_0_var(--color-action-accent)]'
              )}
              key={`${c.start}`}
              onClick={() => go(k)}
              type="button"
            >
              <span className="w-4 shrink-0 pt-4 font-semibold">{k + 1}</span>
              <span className="py-4">{c.title}</span>
              <span className="ml-auto pt-4 text-[0.8rem]">
                {clock(c.end - c.start)}
              </span>
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}
