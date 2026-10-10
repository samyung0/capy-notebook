import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import {
  buildTrailMap,
  MAP_HEIGHT,
  type Piece,
  STEP,
  templateDefs,
} from './map';
import { catmull, lastOf, n, type Pt, polyD, Rng, wobble } from './sketch';
import './trailMap.css';
import { useVisibleRange } from './useVisibleRange';

/** Map units to CSS pixels. */
const SCALE = 0.92;
/** The sky above the birds is empty, so the drawing starts a little lower. */
const TOP = 14;
/** Pieces this far outside the view are drawn too, so scrolling never shows a gap. */
const MARGIN = 120;
/** Questions past the next one drawn in full ink (at least); the rest stays faint. */
const AHEAD = 6;

/**
 * One topic's walk on the /qb landing: answered stops filled, the trail solid
 * up to the next question, and the map faint past a few questions ahead. Each
 * stop opens its question (mouse only: Continue is the keyboard path).
 * Only pieces near the visible stretch are rendered; the stretch is tracked in
 * whole question-widths, so scrolling re-renders once per question passed.
 */
export function TrailMap({
  topicId,
  questionIds,
  answeredPositions,
  lastAnsweredPosition,
  nextQuestionId,
  onOpen,
}: {
  topicId: string;
  questionIds: string[];
  answeredPositions: number[];
  lastAnsweredPosition: number;
  nextQuestionId: string;
  onOpen: (questionId: string) => void;
}) {
  const total = questionIds.length;
  const nextPosition = questionIds.indexOf(nextQuestionId) + 1;
  const startLabel = m.question_ui_map_start();
  const map = useMemo(
    () => buildTrailMap(topicId, total, startLabel),
    [topicId, total, startLabel]
  );
  const clip = useId().replace(/:/g, '');
  const scrollRef = useRef<HTMLDivElement>(null);
  const next = map.stops[nextPosition - 1];
  // Full ink up to a few questions past the next one or the last attempted
  // one, whichever is later, so going back to an earlier question pulls it back.
  const inkedTo = Math.max(nextPosition, lastAnsweredPosition) + AHEAD;
  const reveal =
    inkedTo >= total ? map.width : map.stops[inkedTo - 1][0] + STEP / 2;
  // Open on the next question, a third of the way in, then follow scrolling.
  const range = useVisibleRange(scrollRef, {
    focus: next[0],
    margin: MARGIN,
    scale: SCALE,
    step: STEP,
  });

  const art = useMemo(() => trailArt(topicId, map.trail), [topicId, map]);
  const done = useMemo(() => {
    const at = map.trail.reduce(
      (best, p, i) => (dist(p, next) < dist(map.trail[best], next) ? i : best),
      0
    );
    return polyD(
      wobble(
        [...map.trail.slice(0, at + 1), next],
        new Rng(`${topicId}|done`),
        0.5
      )
    );
  }, [topicId, map, next]);

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
      stops: map.stops.flatMap((at, i) =>
        at[0] >= lo &&
        at[0] <= hi &&
        keep({ a: at[0] - 10, b: at[0] + 10, svg: '' })
          ? [i]
          : []
      ),
      under: html(map.under, keep),
    });
    return { fog: layer((p) => p.b > reveal), ink: layer((p) => p.a < reveal) };
  }, [map, range, reveal]);

  const answered = new Set(answeredPositions);
  const visible = [...layers.ink.stops, ...layers.fog.stops];
  const width = map.width * SCALE;

  return (
    <div
      aria-hidden
      className="scroll-fade-x -mx-4 overflow-x-auto overflow-y-hidden [scrollbar-width:none] sm:-mx-6 [&::-webkit-scrollbar]:hidden"
      ref={scrollRef}
    >
      <div className="relative" style={{ width }}>
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
                height={MAP_HEIGHT + 80}
                width={reveal + 20}
                x={-20}
                y={-40}
              />
            </clipPath>
            <clipPath id={`${clip}-fog`}>
              <rect
                height={MAP_HEIGHT + 80}
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
              {art}
              {/* Answered stops sit in their layer, so faint ones fade too. */}
              {layers[key].stops.map((i) => (
                <g key={i}>
                  <circle
                    className={answered.has(i + 1) ? 'tm-stop-done' : 'tm-stop'}
                    cx={n(map.stops[i][0])}
                    cy={n(map.stops[i][1])}
                    r={6}
                  />
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
              <g dangerouslySetInnerHTML={{ __html: layers[key].over }} />
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
          {/* Not answered yet, so hollow like the stops ahead. */}
          <circle className="tm-stop" cx={next[0]} cy={next[1]} r={6} />
        </svg>
        <span
          className="t-meta absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 font-bold text-surface"
          style={{ left: next[0] * SCALE, top: (next[1] - TOP) * SCALE - 42 }}
        >
          {m.question_ui_map_next({ position: nextPosition })}
        </span>
        {visible.map((i) => {
          const label = m.question_ui_map_stop({ position: i + 1 });
          const button = (
            <TooltipTrigger
              aria-label={label}
              className="absolute size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full hover:bg-fg/10"
              onClick={() => onOpen(questionIds[i])}
              style={{
                left: map.stops[i][0] * SCALE,
                top: (map.stops[i][1] - TOP) * SCALE,
              }}
              tabIndex={-1}
            />
          );
          // The next stop already carries its tag.
          return (
            <Tooltip key={i}>
              {button}
              {i + 1 !== nextPosition && (
                <TooltipContent>{label}</TooltipContent>
              )}
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/** The walked footpath: faint edges either side and the dashed line, drawn under both layers. */
function trailArt(topicId: string, trail: Pt[]) {
  const rng = new Rng(`${topicId}|trail-art`);
  const edges = [-1, 1].map((side) => {
    const edge: Pt[] = [];
    for (let i = 0; i < trail.length; i += 2) {
      const a = trail[Math.max(i - 1, 0)];
      const b = trail[Math.min(i + 1, trail.length - 1)];
      const len = dist(a, b) || 1;
      edge.push([
        trail[i][0] - ((b[1] - a[1]) / len) * 8 * side,
        trail[i][1] + ((b[0] - a[0]) / len) * 8 * side,
      ]);
    }
    return polyD(wobble(edge, rng, 0.6));
  });
  const dashed = polyD(wobble(trail, rng, 0.5));
  return (
    <>
      {edges.map((d) => (
        <path className="tm-path-edge" d={d} key={d.slice(0, 24)} />
      ))}
      <path className="tm-trail-rest" d={dashed} />
    </>
  );
}

/** Drawing units per CSS pixel, so strokes, dot and flag keep one size however wide the trail runs. */
const MINI_UNIT = 176 / 150;
/** The narrowest trail, in drawing units: 150px. */
const MINI_MIN = 176;

/** The trail's line across a drawing this wide: a wave every 72 units or so, of seeded heights, ending before the flag. */
function miniLine(width: number, rng: Rng): Pt[] {
  const end = width - 26;
  const count = Math.max(2, Math.round((end - 4) / 36));
  return catmull(
    Array.from({ length: count + 1 }, (_, i): Pt => {
      const x = 4 + ((end - 4) * i) / count;
      if (i === 0) return [x, 14];
      if (i === count) return [x, 12];
      return [x, i % 2 ? rng.uniform(7, 10) : rng.uniform(14, 17)];
    }),
    8
  );
}

/**
 * A short trail for the other started topics and workspaces: solid up to the
 * share done, a dot, a small flag. It fills its box (150px at least), drawing
 * more waves rather than stretching them.
 */
export function MiniTrail({
  topicId,
  answered,
  total,
}: {
  topicId: string;
  answered: number;
  total: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(MINI_MIN);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(
        Math.max(
          MINI_MIN,
          Math.round(el.getBoundingClientRect().width * MINI_UNIT)
        )
      );
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  const { done, rest, at } = useMemo(() => {
    const rng = new Rng(`${topicId}|mini`);
    const [head, tail, point] = splitAt(
      miniLine(width, new Rng(`${topicId}|mini-line`)),
      answered / total
    );
    return {
      at: point,
      done: polyD(wobble(head, rng, 0.6)),
      rest: polyD(wobble(tail, rng, 0.6)),
    };
  }, [topicId, answered, total, width]);
  return (
    <svg
      aria-hidden
      className="trail-mini block h-6 w-full min-w-[150px] overflow-visible"
      ref={ref}
      viewBox={`0 0 ${width} 24`}
    >
      <path className="tm-trail-rest" d={rest} />
      <path className="tm-trail-done" d={done} />
      <circle className="tm-you-dot" cx={n(at[0])} cy={n(at[1])} r={4} />
      <g transform={`translate(${width - MINI_MIN} 0)`}>
        <path className="tm-mini-ground" d="M156 20 164 20" />
        <path className="tm-mini-pole" d="M160 20 160 1" />
        <path
          className="tm-flag"
          d="M160.6 1C165 -0.5 168 2.5 172 1.5L169 5 172 8.5C168 9.5 165 6.5 160.6 8Z"
        />
      </g>
    </svg>
  );
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Split a polyline at a share of its length: [before, after, the point]. */
function splitAt(pts: Pt[], share: number): [Pt[], Pt[], Pt] {
  let left =
    share * pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i], p), 0);
  for (let i = 1; i < pts.length; i++) {
    const len = dist(pts[i - 1], pts[i]);
    if (len >= left) {
      const t = len ? left / len : 0;
      const p: Pt = [
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ];
      return [[...pts.slice(0, i), p], [p, ...pts.slice(i)], p];
    }
    left -= len;
  }
  const end = lastOf(pts);
  return [pts, [end, end], end];
}
