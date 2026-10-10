import {
  type CSSProperties,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import {
  n,
  type Pt,
  polyD,
  Rng,
  wobble,
} from '@/features/questions/trailMap/sketch';
import '@/features/questions/trailMap/trailMap.css';
import { useVisibleRange } from '@/features/questions/trailMap/useVisibleRange';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  buildRailMap,
  MAP_HEIGHT,
  type Piece,
  STEP,
  templateDefs,
} from './map';
import './railMap.css';

/** Map units to CSS pixels. */
const SCALE = 0.92;
/** The sky above the birds is empty, so the drawing starts a little lower. */
const TOP = 10;
/** Pieces this far outside the view are drawn too, so scrolling never shows a gap. */
const MARGIN = 120;
/** Items past the next one (or the last touched) drawn in full ink; the rest stays faint. */
const AHEAD = 6;
/** A short workspace's map widens in steps of this many map units to fill its panel. */
const WIDTH_STEP = 240;

export interface RailMapItem {
  /** Index into chapters; null when unfiled. */
  chapter: number | null;
  id: string;
  state: 'started' | 'done' | undefined;
  title: string;
}

/**
 * One workspace's progress as a railway line: its tracked items in reading
 * order as stops, a station at each chapter start, done stops filled, started
 * ones half filled, the line solid up to the next item and the map faint a
 * few items further on. Each stop opens its item (mouse only: Continue is the
 * keyboard path). Only pieces near the visible stretch are rendered.
 */
export function RailMap({
  workspaceId,
  chapters,
  items,
  color,
  onOpen,
}: {
  workspaceId: string;
  chapters: string[];
  items: RailMapItem[];
  /** The workspace cover's colour; the theme's link colour without one. */
  color?: string;
  onOpen: (itemId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [minWidth, setMinWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setMinWidth(Math.ceil(el.clientWidth / SCALE / WIDTH_STEP) * WIDTH_STEP);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  const layout = items.map((it) => it.chapter);
  const layoutKey = layout.join(',');
  // The map depends on the chapter layout, not each item's state.
  const map = useMemo(
    () => buildRailMap(workspaceId, chapters, layout, minWidth),
    [workspaceId, chapters.join('\n'), layoutKey, minWidth]
  );

  const nextIndex = Math.max(
    0,
    items.findIndex((it) => it.state !== 'done')
  );
  const lastTouched = items.reduce((last, it, i) => (it.state ? i : last), -1);
  const next = map.stops[nextIndex];
  const inkedTo = Math.max(nextIndex, lastTouched) + AHEAD;
  const reveal =
    inkedTo >= items.length ? map.width : map.stops[inkedTo][0] + STEP / 2;
  const range = useVisibleRange(scrollRef, {
    focus: next[0],
    margin: MARGIN,
    scale: SCALE,
    step: STEP,
  });
  const clip = useId().replace(/:/g, '');

  const done = useMemo(() => {
    const at = map.trail.reduce(
      (best, p, i) => (dist(p, next) < dist(map.trail[best], next) ? i : best),
      0
    );
    return polyD(
      wobble(
        [...map.trail.slice(0, at + 1), next],
        new Rng(`${workspaceId}|done`),
        0.5
      )
    );
  }, [workspaceId, map, next]);
  const rest = useMemo(
    () => polyD(wobble(map.trail, new Rng(`${workspaceId}|line`), 0.5)),
    [workspaceId, map]
  );

  // Full ink holds pieces that start before the cut-off, the faint copy those that end after it.
  const layers = useMemo(() => {
    const lo = range[0] * STEP;
    const hi = range[1] * STEP;
    const html = (pieces: Piece[], keep: (p: Piece) => boolean) =>
      pieces
        .filter((p) => p.b >= lo && p.a <= hi && keep(p))
        .map((p) => p.svg)
        .join('');
    const layer = (keep: (p: Piece) => boolean) => ({
      over: html(map.over, keep),
      stops: map.stops.flatMap(([x], i) =>
        x >= lo && x <= hi && keep({ a: x - 10, b: x + 10, svg: '' }) ? [i] : []
      ),
      under: html(map.under, keep),
    });
    return { fog: layer((p) => p.b > reveal), ink: layer((p) => p.a < reveal) };
  }, [map, range, reveal]);

  const visible = [...layers.ink.stops, ...layers.fog.stops];
  const width = map.width * SCALE;
  const tag = m.learning_map_next({ title: items[nextIndex].title });
  // Over a station the tag rises above its roof, so the chapter name stays readable.
  const tagHalf = (tag.length * 7 + 18) / SCALE / 2;
  const lift = map.stations.some(
    ({ a, b }) => a < next[0] + tagHalf && next[0] - tagHalf < b
  )
    ? 84
    : 46;

  return (
    <div
      aria-hidden
      className="scroll-fade-x -mx-4 overflow-x-auto overflow-y-hidden [scrollbar-width:none] sm:-mx-6 lg:-mx-10 xl:-mx-16 [&::-webkit-scrollbar]:hidden"
      ref={scrollRef}
    >
      <div
        className={cn('rail-map relative', color && 'rail-colour')}
        style={{ '--cover-ink': color, width } as CSSProperties}
      >
        <svg
          className="trail-map block"
          height={(MAP_HEIGHT - TOP) * SCALE}
          viewBox={`0 ${TOP} ${map.width} ${MAP_HEIGHT - TOP}`}
          width={width}
        >
          <defs dangerouslySetInnerHTML={{ __html: templateDefs() }} />
          <defs>
            <clipPath id={`${clip}-ink`}>
              <rect
                height={MAP_HEIGHT + 40}
                width={reveal + 20}
                x={-20}
                y={-40}
              />
            </clipPath>
            <clipPath id={`${clip}-fog`}>
              <rect
                height={MAP_HEIGHT + 40}
                width={map.width - reveal + 20}
                x={reveal}
                y={-40}
              />
            </clipPath>
          </defs>
          {(['fog', 'ink'] as const).map((key) => (
            <g
              className={key === 'fog' ? 'tm-fog' : undefined}
              clipPath={`url(#${clip}-${key})`}
              key={key}
            >
              <g dangerouslySetInnerHTML={{ __html: layers[key].under }} />
              <g dangerouslySetInnerHTML={{ __html: layers[key].over }} />
              {/* The line and stops go over the scenery, so buildings may come close. */}
              <path className="tm-trail-rest" d={rest} />
              {layers[key].stops.map((i) => (
                <g key={i}>
                  {i !== nextIndex && (
                    <Stop at={map.stops[i]} state={items[i].state} />
                  )}
                  <text
                    className="tm-num"
                    textAnchor="middle"
                    x={n(map.stops[i][0])}
                    y={n(map.stops[i][1] + 21)}
                  >
                    {i + 1}
                  </text>
                </g>
              ))}
            </g>
          ))}
          <path className="tm-trail-done" d={done} />
          <circle
            className="tm-stop-done"
            cx={map.trail[0][0]}
            cy={map.trail[0][1]}
            r={5}
          />
          <circle className="tm-you-ring" cx={next[0]} cy={next[1]} r={11} />
          <Stop at={next} state={items[nextIndex].state} />
        </svg>
        <span
          className="t-meta absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 font-bold text-surface"
          style={{
            left: next[0] * SCALE,
            top: (next[1] - TOP - lift) * SCALE,
          }}
        >
          {tag}
        </span>
        {visible.map((i) => (
          <Tooltip key={i}>
            <TooltipTrigger
              aria-label={items[i].title}
              className="absolute size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full hover:bg-fg/10"
              onClick={() => onOpen(items[i].id)}
              style={{
                left: map.stops[i][0] * SCALE,
                top: (map.stops[i][1] - TOP) * SCALE,
              }}
              tabIndex={-1}
            />
            {/* The next stop already carries its tag. */}
            {i !== nextIndex && (
              <TooltipContent>{items[i].title}</TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

/** Done filled, started half filled, untouched hollow. */
function Stop({ at: [x, y], state }: { at: Pt; state: RailMapItem['state'] }) {
  return (
    <>
      <circle
        className={state === 'done' ? 'tm-stop-done' : 'tm-stop'}
        cx={n(x)}
        cy={n(y)}
        r={6}
      />
      {state === 'started' && (
        <path
          className="tm-half"
          d={`M${n(x)} ${n(y - 4.8)} A4.8 4.8 0 0 0 ${n(x)} ${n(y + 4.8)}Z`}
        />
      )}
    </>
  );
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
