import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MERMAID_SOURCE_MAX } from './document';
import type { DrawReply, DrawRequest } from './mermaid.worker';
import type { Drawn } from './mermaidDraw';
import {
  MERMAID_EDGES_MAX,
  type MermaidFailure,
  type MermaidReason,
  MermaidReasonError,
  mermaidFailure,
} from './mermaidError';
import { MERMAID_SECURITY, withSafeLinks } from './mermaidSafety';
import {
  MERMAID_THEME_SWATCH,
  type MermaidTheme,
  mermaidTheme,
} from './mermaidThemes';

const VIEW_BOX = /<svg[^>]*\sviewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/;

/** How long typing settles before a live source redraws: a full render per
 * keystroke falls behind on a large diagram (REVIEW4 S2). */
export const MERMAID_TYPING_DELAY_MS = 250;

/** A render still running this long after the worker starts drawing stops
 * with "too large to draw on this device" (Epo 2026-10-22); a worker that has
 * not started drawing this long after the request says "Diagrams couldn't
 * load." (Epo 2026-10-23). */
export const MERMAID_RENDER_LIMIT_MS = 30_000;

/** A block never shows a diagram smaller than this and scrolls instead
 * (Epo 2026-10-22). */
const MIN_SCALE = 0.5;

/** A queued render whose diagram changed again before its turn. */
export const SUPERSEDED = new Error('superseded mermaid render');

// ------------------------------------------------------------------ cache

interface Entry {
  promise: Promise<Drawn>;
  settled: boolean;
  /** Characters it holds once settled: its SVG, or its source. */
  size: number;
  /** Whether each caller waiting on it still wants it (none: always). */
  wants: ((() => boolean) | undefined)[];
}

/** The cache keeps about this many characters of SVG (twice that in bytes):
 * a near-limit diagram is about 3.3 million (review L2). */
const CACHE_CHARS = 8_000_000;
/** Drawn diagrams by theme and source (and width for a gantt chart), shared
 * by blocks, the full-screen preview, View/Edit and exports. */
const cache = new Map<string, Entry>();

/** Mermaid's gantt detector, after front matter and directives. */
const GANTT = /^\s*gantt/;
const FRONT_MATTER = /^-{3}\s*[\n\r][\s\S]*?[\n\r]-{3}\s*[\n\r]+/;
const DIRECTIVES = /^(?:\s*%%.*(?:\r?\n|$))*/;

function cacheKey(code: string, theme: MermaidTheme, width: number) {
  const body = code
    .trimStart()
    .replace(FRONT_MATTER, '')
    .replace(DIRECTIVES, '');
  return `${theme}|${GANTT.test(body) ? width : ''}|${code}`;
}

/** Failures the next caller should draw again, all but those the source
 * causes (Epo 2026-10-23): nobody wanted it, the worker ran out of time,
 * could not start, or could not load. */
function retried(error: unknown) {
  return (
    error === SUPERSEDED ||
    (error instanceof MermaidReasonError && RETRIED.has(error.reason))
  );
}

const RETRIED: ReadonlySet<MermaidReason> = new Set([
  'noWorker',
  'notLoaded',
  'tooLarge',
]);

function remember(key: string, entry: Entry, code: string) {
  cache.set(key, entry);
  const settle = (size: number) => {
    entry.settled = true;
    entry.size = size;
    let total = 0;
    for (const held of cache.values()) total += held.size;
    // Oldest first, never the newest.
    for (const [old, held] of cache) {
      if (total <= CACHE_CHARS || held === entry) break;
      if (!held.settled) continue;
      cache.delete(old);
      total -= held.size;
    }
  };
  entry.promise.then(
    (drawn) => settle(drawn.svg.length),
    (error: unknown) => {
      if (retried(error) && cache.get(key) === entry) cache.delete(key);
      settle(code.length);
    }
  );
  return entry.promise;
}

function recall(key: string, wanted?: () => boolean) {
  const entry = cache.get(key);
  if (!entry) return;
  // Most recently used last, so the oldest go first.
  cache.delete(key);
  cache.set(key, entry);
  if (!entry.settled) entry.wants.push(wanted);
  return entry.promise;
}

// ----------------------------------------------------------------- worker

let worker: Worker | null = null;
let jobs = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Faces a generic family may be, per platform. */
const GENERIC_FACES: Record<string, string[]> = {
  monospace: [
    'Consolas',
    'Menlo',
    'Courier New',
    'Roboto Mono',
    'Droid Sans Mono',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Noto Sans Mono',
    'Courier',
  ],
  'sans-serif': [
    'Arial',
    'Helvetica',
    'Roboto',
    'Noto Sans',
    'DejaVu Sans',
    'Liberation Sans',
    'Helvetica Neue',
    'Segoe UI',
    'Ubuntu',
  ],
  serif: [
    'Times New Roman',
    'Times',
    'Noto Serif',
    'DejaVu Serif',
    'Liberation Serif',
    'Georgia',
  ],
};
const SAMPLE = 'Hamburgefonstiv 0123 WMwm';
let faces: Record<string, string> | undefined;

/** The face the page draws each generic family in, among GENERIC_FACES: a
 * worker has no font settings, so the shim measures in these by name. One
 * that matches none stays generic there (and may measure differently). */
function genericFaces() {
  if (faces) return faces;
  faces = {};
  const ctx =
    typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  if (!ctx) return faces;
  const sample = (font: string) => {
    ctx.font = `16px ${font}`;
    const metrics = ctx.measureText(SAMPLE);
    return `${metrics.width}|${metrics.fontBoundingBoxAscent}|${metrics.fontBoundingBoxDescent}`;
  };
  for (const [generic, names] of Object.entries(GENERIC_FACES)) {
    const wanted = sample(generic);
    // Installed: the same with either fallback.
    const face = names.find(
      (name) =>
        sample(`"${name}", serif`) === wanted &&
        sample(`"${name}", monospace`) === wanted
    );
    if (face) faces[generic] = face;
  }
  return faces;
}

/** The worker ends after this long without a draw (review L2); the next
 * diagram, or the next note's warm-up, starts it again. */
const WORKER_IDLE_MS = 60_000;
let idle: ReturnType<typeof setTimeout> | undefined;

function stopWorker(stopped: Worker) {
  stopped.terminate();
  if (worker === stopped) worker = null;
}

function restAfterIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (worker) stopWorker(worker);
  }, WORKER_IDLE_MS);
}

/** Whether this browser has what the worker's shim measures text with: a
 * 2D OffscreenCanvas (Safari before 16.4 has none). */
function canDraw() {
  try {
    return Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
  } catch {
    return false;
  }
}

/** The worker, started once (it loads mermaid as it starts); none where a
 * module worker cannot start or draw. */
function startWorker() {
  if (worker) return worker;
  if (!canDraw()) return null;
  let started: Worker;
  try {
    started = new Worker(new URL('./mermaid.worker.ts', import.meta.url), {
      name: 'mermaid',
      type: 'module',
    });
  } catch {
    return null;
  }
  // A worker that broke, warming or drawing: its script or mermaid did not
  // download, or an error escaped. The next draw starts a new one (Epo
  // 2026-10-23).
  started.onerror = (event) => {
    event.preventDefault();
    stopWorker(started);
    pending?.(new MermaidReasonError('notLoaded'));
  };
  worker = started;
  restAfterIdle();
  return started;
}

/** Rejects the draw running in the worker (one at a time). */
let pending: ((error: unknown) => void) | null = null;

/** Starts the worker, which loads mermaid, and the page's sanitizer, at
 * idle when a diagram mounts (Epo 2026-10-23): a diagram drawn when it
 * comes near the screen then waits on neither. */
export function warmMermaid() {
  if (!startWorker()) return;
  // A worker already up stays up for this note too (review r2 L3).
  if (!pending) restAfterIdle();
  genericFaces();
  import('dompurify').catch(() => undefined);
}

/** One draw in the worker. Loading (mermaid, the theme, its fonts) and
 * drawing each get MERMAID_RENDER_LIMIT_MS (review M1, r2 M1); at either
 * limit, or when a download fails, the worker stops and the next draw starts
 * a new one. */
function inWorker(
  request: Omit<DrawRequest, 'faces' | 'id' | 'screenWidth'>
): Promise<Drawn> {
  return new Promise((resolve, reject) => {
    const current = startWorker();
    if (!current) {
      reject(new MermaidReasonError('noWorker'));
      return;
    }
    clearTimeout(idle);
    const id = ++jobs;
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      pending = null;
      restAfterIdle();
      finish();
    };
    const stop = (reason: MermaidReason) => () => {
      stopWorker(current);
      settle(() => reject(new MermaidReasonError(reason)));
    };
    let timer = setTimeout(stop('notLoaded'), MERMAID_RENDER_LIMIT_MS);
    pending = (error) => settle(() => reject(error));
    current.onmessage = ({ data }: MessageEvent<DrawReply>) => {
      if (data.id !== id) return;
      if ('started' in data) {
        clearTimeout(timer);
        timer = setTimeout(stop('tooLarge'), MERMAID_RENDER_LIMIT_MS);
        return;
      }
      if ('notLoaded' in data) {
        stop('notLoaded')();
        return;
      }
      settle(() => {
        if ('unsupported' in data)
          reject(new MermaidReasonError('unsupported'));
        else if ('error' in data) reject(new Error(data.error));
        else resolve(data);
      });
    };
    current.postMessage({
      ...request,
      faces: genericFaces(),
      id,
      screenWidth: globalThis.screen?.availWidth ?? 0,
    } satisfies DrawRequest);
  });
}

/** mermaid's own sanitizer setup for a drawn diagram (foreignObject HTML
 * labels), with our forbid lists and no form controls (review L6); the SVG
 * keeps its own stylesheet. */
const DRAWN_SVG = {
  ADD_ATTR: ['dominant-baseline'],
  ADD_TAGS: ['foreignobject'],
  FORBID_ATTR: MERMAID_SECURITY.dompurifyConfig.FORBID_ATTR,
  FORBID_TAGS: [
    ...MERMAID_SECURITY.dompurifyConfig.FORBID_TAGS.filter(
      (tag) => tag !== 'style'
    ),
    'button',
    'form',
    'select',
    'textarea',
  ],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true as const,
};

/** A drawn diagram made safe for the page: sanitized with the page's own
 * DOMPurify (mermaid's pass in the worker lets everything through, since
 * DOMPurify needs a real DOM), every `<style>` but mermaid's own root sheet
 * removed (one in a label or a nested `<svg>` would restyle the page or
 * `@import` from outside, review H1), then its links opened in a new tab. */
export async function forPage(drawn: Drawn): Promise<Drawn> {
  const { default: DOMPurify } = await import('dompurify');
  const fragment = DOMPurify.sanitize(drawn.svg, DRAWN_SVG);
  const root = fragment.firstElementChild;
  for (const style of fragment.querySelectorAll('style'))
    if (style.parentNode !== root) style.remove();
  const holder = document.createElement('div');
  holder.append(fragment);
  return { ...drawn, svg: withSafeLinks(holder.innerHTML) };
}

/**
 * Draws one diagram in a theme in the worker, one at a time, or takes it
 * from the cache. A queued render that no caller wants when its turn comes
 * is skipped (rejects with SUPERSEDED): a newer source is queued behind it.
 * A running one finishes into the cache (Epo 2026-10-23). `width` is the
 * box a gantt chart spans.
 */
export function renderMermaid(
  code: string,
  theme?: MermaidTheme,
  { wanted, width = 0 }: { wanted?: () => boolean; width?: number } = {}
): Promise<Drawn> {
  const resolved = mermaidTheme(theme);
  const key = cacheKey(code, resolved, width);
  const hit = recall(key, wanted);
  if (hit) return hit;
  const wants = [wanted];
  if (code.length > MERMAID_SOURCE_MAX) {
    const promise = Promise.reject(new MermaidReasonError('tooLong'));
    return remember(key, { promise, settled: false, size: 0, wants }, code);
  }
  const promise = queue.then(async () => {
    if (!wants.some((want) => !want || want())) throw SUPERSEDED;
    return forPage(await inWorker({ code, theme: resolved, width }));
  });
  queue = promise.catch(() => undefined);
  return remember(key, { promise, settled: false, size: 0, wants }, code);
}

/**
 * Renders a mermaid code block to inline SVG on its theme's background,
 * drawn once it comes near the screen. With `onError` the last good diagram
 * stays up and the parent shows the error; without it a failed parse shows
 * `MermaidError`. Without `svgHeight` a diagram never shows below MIN_SCALE:
 * the box scrolls instead.
 */
export function Mermaid({
  className,
  code,
  delay = 0,
  fill = false,
  theme,
  onDrawn,
  onError,
  svgHeight,
}: {
  /** Extra classes for the rendered diagram box. */
  className?: string;
  code: string;
  /** Stretch past the diagram's natural width to fill the box (a resized block). */
  fill?: boolean;
  theme?: MermaidTheme;
  /** Whether the current code drew; a failed one has nothing to preview. */
  onDrawn?: (drawn: boolean) => void;
  onError?: (failure: MermaidFailure | null) => void;
  /** CSS height for the SVG from its natural (viewBox) size. */
  svgHeight?: (width: number, height: number) => string;
  /** Typing settles this long before a changed source redraws (the first
   * draw is at once): a live source changes per keystroke. */
  delay?: number;
}) {
  const [result, setResult] = useState<Drawn | null>(null);
  const [error, setError] = useState<MermaidFailure | null>(null);
  // This copy's own ids: the cache hands one SVG to every box (review L1).
  const [ids] = useState(() => `mmi-${++copies}`);
  const svg = useMemo(() => result && ownIds(result.svg, ids), [result, ids]);
  const boxRef = useRef<HTMLDivElement>(null);
  const { near } = useNearScreen(boxRef);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  // Whether a draw was asked for already: later changes wait for `delay`.
  const started = useRef(false);

  // A diagram is on the page: the worker and mermaid load at idle, before
  // it comes near the screen (Epo 2026-10-23).
  useEffect(() => {
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(warmMermaid);
      return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(warmMermaid, 0);
    return () => clearTimeout(handle);
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const draw = () => {
      const width = boxRef.current?.clientWidth || window.innerWidth;
      renderMermaid(code, theme, { wanted: () => !cancelled, width })
        .then((next) => {
          if (cancelled) return;
          setResult(next);
          setError(null);
          onErrorRef.current?.(null);
          onDrawnRef.current?.(true);
        })
        .catch((e: unknown) => {
          if (cancelled || e === SUPERSEDED) return;
          const failure = mermaidFailure(e, code);
          setError(failure);
          onErrorRef.current?.(failure);
          onDrawnRef.current?.(false);
        });
    };
    const wait = started.current ? delay : 0;
    started.current = true;
    const timer = wait ? setTimeout(draw, wait) : undefined;
    if (!wait) draw();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, theme, delay, near]);

  let body: ReactNode;
  if (error != null && !onError) {
    body = <MermaidError code={code} failure={error} />;
  } else if (result && svg) {
    const viewBox = VIEW_BOX.exec(svg);
    const size = viewBox && [Number(viewBox[1]), Number(viewBox[2])];
    body = (
      <div
        className={cn(
          'mermaid-render justify-center-safe flex overflow-auto rounded-lg p-3',
          // Matches MediaFrame's MAX_HEIGHT; the SVG scales down to fit, to
          // MIN_SCALE at least, and the box scrolls past that.
          '[&>svg]:max-h-[min(70vh,48rem)]',
          !svgHeight &&
            'max-h-[calc(min(70vh,48rem)+1.5rem)] [&>svg]:min-h-(--svg-min-h) [&>svg]:min-w-(--svg-min-w)',
          // Mermaid caps the SVG at its natural width with an inline style.
          fill && '[&>svg]:max-w-none!',
          size && svgHeight && '[&>svg]:h-(--svg-height)',
          className,
          // HTML labels lay out as the worker measured them, not in the
          // surrounding text's weight and line height.
          'font-normal leading-normal'
        )}
        // eslint-disable-next-line react/no-danger -- sanitized on this page (forPage)
        dangerouslySetInnerHTML={{ __html: svg }}
        style={
          {
            '--svg-height':
              size && svgHeight ? svgHeight(size[0], size[1]) : undefined,
            '--svg-min-h': size ? `${size[1] * MIN_SCALE}px` : undefined,
            '--svg-min-w': size ? `${size[0] * MIN_SCALE}px` : undefined,
            background: result.background,
          } as CSSProperties
        }
      />
    );
  } else if (error == null) {
    body = (
      <div className="grid h-40 place-items-center text-fg-muted">
        <span className="text-xs">{m.mermaid_rendering()}</span>
      </div>
    );
  } else {
    // The parent shows the error and nothing has drawn yet: an empty box.
    body = <div className="h-40" />;
  }
  // One box for the block's whole life: the screen observer watches it.
  return <div ref={boxRef}>{body}</div>;
}

let copies = 0;
const ROOT_ID = /<svg[^>]*\sid="([\w-]+)"/;
const DEFINED_ID = /\sid="([^"]+)"/g;
/** Where an SVG refers to an id: its definition, `url(#…)`, `href="#…"`
 * (`xlink:href` too) and the root's aria lists. */
const ID_USE =
  /(\sid="|url\(#|href="#|aria-(?:labelledby|describedby)=")([^"')]+)/g;

/**
 * `svg` with every id it defines made this copy's own (`copy`): the cache
 * hands one SVG to every box (review L1), and a restarted worker counts some
 * ids from the start again (sankey gradients, sequence actors, review r2 L2).
 * The root id, which prefixes most ids and scopes the stylesheet, becomes
 * `copy` wherever it appears (`mmd-1` is not the start of `mmd-12`); every
 * other defined id gets `copy` as a prefix where it is defined and used.
 */
export function ownIds(svg: string, copy: string) {
  const root = ROOT_ID.exec(svg)?.[1];
  if (!root) return svg;
  const renamed = svg.replace(new RegExp(`${root}(?!\\d)`, 'g'), copy);
  const others = new Set<string>();
  for (const [, id] of renamed.matchAll(DEFINED_ID))
    if (id && !id.includes(copy)) others.add(id);
  if (!others.size) return renamed;
  const own = (id: string) => (others.has(id) ? `${copy}-${id}` : id);
  return renamed.replace(ID_USE, (_, at: string, ids: string) =>
    at.startsWith('aria')
      ? at + ids.split(' ').map(own).join(' ')
      : at + own(ids)
  );
}

/** A theme's panel with one node in its fill and border, for theme menus. */
export function MermaidSwatch({
  theme,
  className,
}: {
  theme: MermaidTheme;
  className?: string;
}) {
  const [panel, fill, border] = MERMAID_THEME_SWATCH[theme];
  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm ring-1 ring-fg/40',
        className
      )}
      style={{ background: panel }}
    >
      <span
        className="h-1.5 w-2.5 rounded-[2px] border"
        style={{ background: fill, borderColor: border }}
      />
    </span>
  );
}

/** The line mermaid blamed, or that the diagram could not be drawn at all. */
export function mermaidFailureMessage(failure: MermaidFailure) {
  switch (failure.reason) {
    case 'tooLong':
      return m.mermaid_too_long({ max: MERMAID_SOURCE_MAX.toLocaleString() });
    case 'edges':
      return m.mermaid_too_many_edges({ max: MERMAID_EDGES_MAX });
    case 'tooLarge':
      return m.mermaid_too_large();
    case 'unsupported':
      return m.mermaid_unsupported();
    case 'noWorker':
      return m.mermaid_no_worker();
    case 'notLoaded':
      return m.mermaid_not_loaded();
    default:
      return failure.line == null
        ? m.mermaid_failed()
        : m.mermaid_syntax_error({ line: failure.line });
  }
}

/** A diagram that cannot be drawn: the message, then its source with the
 * blamed line marked, the way the source editor marks it. */
export function MermaidError({
  code,
  failure,
}: {
  code: string;
  failure: MermaidFailure;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-semibold text-sm text-solid-error">
        {mermaidFailureMessage(failure)}
      </p>
      <pre className="overflow-x-auto font-mono text-[13px] leading-[22px] [font-variant-ligatures:none]">
        {code.split('\n').map((text, index) => {
          const bad = index + 1 === failure.line;
          return (
            // Lines never reorder; the index is the line number.
            <div className={cn('flex', bad && 'bg-tint-error')} key={index}>
              <span
                className={cn(
                  'w-11 shrink-0 select-none pr-3.5 text-right text-fg-muted',
                  bad && 'font-bold text-solid-error'
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  'pr-4',
                  bad &&
                    'underline decoration-solid-error decoration-wavy underline-offset-4'
                )}
              >
                {text || ' '}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
