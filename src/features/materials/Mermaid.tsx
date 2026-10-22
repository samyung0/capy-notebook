import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MERMAID_SOURCE_MAX } from './document';
import type { DrawReply, DrawRequest } from './mermaid.worker';
import type { Drawn } from './mermaidDraw';
import {
  MERMAID_EDGES_MAX,
  type MermaidFailure,
  MermaidLimitError,
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

/** A render still running after this long stops with "too large to draw on
 * this device" (Epo 2026-10-22). */
export const MERMAID_RENDER_LIMIT_MS = 30_000;

/** A block never shows a diagram smaller than this and scrolls instead
 * (Epo 2026-10-22). */
const MIN_SCALE = 0.5;

/** A queued render whose diagram changed again before its turn. */
export const SUPERSEDED = new Error('superseded mermaid render');

/** A type the worker's shim does not draw exactly yet: the page draws it,
 * only on a "Draw diagram" click (Epo 2026-10-22). */
export const PAGE_ONLY = new Error('mermaid type drawn on the page');

// ------------------------------------------------------------------ cache

interface Entry {
  promise: Promise<Drawn>;
  settled: boolean;
  /** Whether each caller waiting on it still wants it (none: always). */
  wants: ((() => boolean) | undefined)[];
}

// ponytail: an entry count, not bytes; a near-limit SVG is ~3 MB, so bound
// by size if typing in huge diagrams shows up in memory.
const CACHE_SIZE = 24;
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

function remember(key: string, entry: Entry) {
  cache.set(key, entry);
  const settle = () => {
    entry.settled = true;
    for (const [old, held] of cache) {
      if (cache.size <= CACHE_SIZE) break;
      if (held.settled) cache.delete(old);
    }
  };
  entry.promise.then(settle, (error: unknown) => {
    // Nobody wanted it: the next caller draws it again.
    if (error === SUPERSEDED && cache.get(key) === entry) cache.delete(key);
    settle();
  });
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

/** One draw in the worker, stopped (the worker with it) at the time limit. */
function inWorker(request: Omit<DrawRequest, 'faces' | 'id'>): Promise<Drawn> {
  return new Promise((resolve, reject) => {
    try {
      worker ??= new Worker(new URL('./mermaid.worker.ts', import.meta.url), {
        name: 'mermaid',
        type: 'module',
      });
    } catch {
      // No module workers here: the page draws on a click.
      reject(PAGE_ONLY);
      return;
    }
    const current = worker;
    const id = ++jobs;
    const stop = () => {
      clearTimeout(timer);
      current.terminate();
      if (worker === current) worker = null;
    };
    const timer = setTimeout(() => {
      stop();
      reject(new MermaidLimitError('tooLarge'));
    }, MERMAID_RENDER_LIMIT_MS);
    current.onmessage = ({ data }: MessageEvent<DrawReply>) => {
      if (data.id !== id) return;
      clearTimeout(timer);
      if ('page' in data) reject(PAGE_ONLY);
      else if ('error' in data) reject(new Error(data.error));
      else resolve(data);
    };
    // A worker that cannot start (no 2D OffscreenCanvas before Safari 16.4)
    // or broke: the page draws on a click.
    current.onerror = (event) => {
      event.preventDefault();
      stop();
      reject(PAGE_ONLY);
    };
    current.postMessage({
      ...request,
      faces: genericFaces(),
      id,
    } satisfies DrawRequest);
  });
}

/** mermaid's own sanitizer setup for a drawn diagram (foreignObject HTML
 * labels), with our forbid lists; the SVG keeps its own stylesheet. */
const DRAWN_SVG = {
  ADD_ATTR: ['dominant-baseline'],
  ADD_TAGS: ['foreignobject'],
  FORBID_ATTR: MERMAID_SECURITY.dompurifyConfig.FORBID_ATTR,
  FORBID_TAGS: MERMAID_SECURITY.dompurifyConfig.FORBID_TAGS.filter(
    (tag) => tag !== 'style'
  ),
  HTML_INTEGRATION_POINTS: { foreignobject: true },
};

/** A drawn diagram made safe for the page: sanitized with the page's own
 * DOMPurify (mermaid's pass in the worker lets everything through, since
 * DOMPurify needs a real DOM), then its links opened in a new tab. */
async function forPage(drawn: Drawn): Promise<Drawn> {
  const { default: DOMPurify } = await import('dompurify');
  return {
    background: drawn.background,
    svg: withSafeLinks(DOMPurify.sanitize(drawn.svg, DRAWN_SVG)),
  };
}

/**
 * Draws one diagram in a theme in the worker, one at a time, or takes it
 * from the cache. A queued render that no caller wants when its turn comes
 * is skipped (rejects with SUPERSEDED): a newer source is queued behind it.
 * A running one finishes into the cache. `width` is the box a gantt chart
 * spans.
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
    const promise = Promise.reject(new MermaidLimitError('tooLong'));
    return remember(key, { promise, settled: false, wants });
  }
  const promise = queue.then(async () => {
    if (!wants.some((want) => !want || want())) throw SUPERSEDED;
    return forPage(await inWorker({ code, theme: resolved, width }));
  });
  queue = promise.catch(() => undefined);
  return remember(key, { promise, settled: false, wants });
}

let pageQueue: Promise<unknown> = Promise.resolve();
let pageDraws = 0;

/** Draws a diagram on the page, as mermaid did before the worker: for a type
 * the shim does not draw exactly yet, after a click, or for an export. The
 * result replaces the type's PAGE_ONLY in the cache. */
export function drawOnPage(
  code: string,
  theme: MermaidTheme | undefined,
  width: number
): Promise<Drawn> {
  const resolved = mermaidTheme(theme);
  const promise = pageQueue.then(async () => {
    const { drawMermaid } = await import('./mermaidDraw');
    // Same text styles as the display box, so measured labels fit when shown.
    const host = document.createElement('div');
    host.className = MERMAID_TEXT_CLASS;
    Object.assign(host.style, {
      height: '0',
      left: '0',
      overflow: 'hidden',
      position: 'fixed',
      top: '0',
      visibility: 'hidden',
      width: `${width}px`,
    });
    document.body.append(host);
    try {
      return forPage(
        await drawMermaid(code, resolved, host, {
          id: `mmp-${++pageDraws}`,
          width,
        })
      );
    } finally {
      host.remove();
    }
  });
  pageQueue = promise.catch(() => undefined);
  return remember(cacheKey(code, resolved, width), {
    promise,
    settled: false,
    wants: [],
  });
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
  // The type draws on the page: a "Draw diagram" button until clicked, then
  // drawn there for this box's later sources too.
  const [pageOnly, setPageOnly] = useState(false);
  const [pageAllowed, setPageAllowed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { near } = useNearScreen(boxRef);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  // Whether a draw was asked for already: later changes wait for `delay`.
  const started = useRef(false);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const draw = () => {
      const width = boxRef.current?.clientWidth || window.innerWidth;
      renderMermaid(code, theme, { wanted: () => !cancelled, width })
        .catch((e: unknown) =>
          e === PAGE_ONLY && pageAllowed
            ? drawOnPage(code, theme, width)
            : Promise.reject(e)
        )
        .then((next) => {
          if (cancelled) return;
          setResult(next);
          setError(null);
          setPageOnly(false);
          onErrorRef.current?.(null);
          onDrawnRef.current?.(true);
        })
        .catch((e: unknown) => {
          if (cancelled || e === SUPERSEDED) return;
          if (e === PAGE_ONLY) {
            setPageOnly(true);
            setResult(null);
            onDrawnRef.current?.(false);
            return;
          }
          setPageOnly(false);
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
  }, [code, theme, delay, near, pageAllowed]);

  let body: ReactNode;
  if (error != null && !onError) {
    body = <MermaidError code={code} failure={error} />;
  } else if (pageOnly) {
    body = (
      <div className="grid h-40 place-items-center">
        <Button
          onClick={() => setPageAllowed(true)}
          size="sm"
          variant="outline"
        >
          {m.mermaid_draw()}
        </Button>
      </div>
    );
  } else if (result) {
    const viewBox = VIEW_BOX.exec(result.svg);
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
          MERMAID_TEXT_CLASS
        )}
        // eslint-disable-next-line react/no-danger -- sanitized again on this page (forPage)
        dangerouslySetInnerHTML={{ __html: result.svg }}
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

const MERMAID_TEXT_CLASS = 'font-normal leading-normal';

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
