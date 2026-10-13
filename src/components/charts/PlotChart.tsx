import type { ComponentType } from 'react';
import type { PlotBlock } from '@/features/questions/types';
import {
  type ChartFrameProps,
  color,
  format,
  QuestionChartFrame,
} from './CategoryChart';

export type PlotData = Omit<PlotBlock, 'type'> & {
  illustrative?: boolean;
  passages?: number[];
};

const W = 320;
const H = 200;
const LEFT = 40;
const RIGHT = W - 10;
const TOP = 16;
const BOTTOM = H - 26;
/** A surface-coloured outline keeps a label readable where it crosses a line. */
const HALO = { paintOrder: 'stroke', strokeWidth: 3 } as const;

/** About five clean ticks (steps of 1, 2 or 5 times a power of ten) spanning
 * [lo, hi]. */
function axis(values: number[]) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    const pad = Math.abs(lo) / 2 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * power).find((k) => k >= raw) ?? raw;
  const min = Math.floor(lo / step) * step;
  const count = Math.round((Math.ceil(hi / step) * step - min) / step);
  const ticks = Array.from({ length: count + 1 }, (_, i) =>
    Number((min + i * step).toPrecision(12))
  );
  return { max: ticks.at(-1) ?? hi, min, ticks };
}

/**
 * Series over numeric x and y axes, in CategoryChart's visual language: 2px
 * lines (or ringed dots for a scatter) in --chart-1..4, dashed reference
 * lines, ringed labelled points, a legend for two or more series and, in the
 * chat frame, the points as a values table.
 */
export function PlotChart({
  data,
  frame: Frame = QuestionChartFrame,
}: {
  data: PlotData;
  frame?: ComponentType<ChartFrameProps>;
}) {
  const lines = data.lines ?? [];
  const marks = data.marks ?? [];
  const series = data.series.map((s) => ({
    ...s,
    points: [...s.points].sort((a, b) => a[0] - b[0]),
  }));
  // A scatter's outermost dots get 5% room so none sits on an axis.
  const padded = (values: number[]) => {
    if (data.kind !== 'scatter') return values;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return [...values, lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05];
  };
  const xs = axis(
    padded([
      ...series.flatMap((s) => s.points.map((p) => p[0])),
      ...lines.filter((l) => l.axis === 'x').map((l) => l.value),
      ...marks.map((mark) => mark.x),
    ])
  );
  const ys = axis(
    padded([
      ...series.flatMap((s) => s.points.map((p) => p[1])),
      ...lines.filter((l) => l.axis === 'y').map((l) => l.value),
      ...marks.map((mark) => mark.y),
    ])
  );
  const x = (value: number) =>
    LEFT + ((value - xs.min) / (xs.max - xs.min)) * (RIGHT - LEFT);
  const y = (value: number) =>
    BOTTOM - ((value - ys.min) / (ys.max - ys.min)) * (BOTTOM - TOP);
  const many = series.length > 1;
  return (
    <Frame
      illustrative={data.illustrative}
      legend={series.map((s) => s.name)}
      passages={data.passages}
      title={data.title}
      unit={data.unit}
      values={{
        columns: many
          ? ['', data.xTitle, data.yTitle]
          : [data.xTitle, data.yTitle],
        rows: series.flatMap((s) =>
          s.points.map(([px, py]) => (many ? [s.name, px, py] : [px, py]))
        ),
      }}
    >
      <svg
        aria-label={data.title}
        className="w-full"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        {ys.ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? 'stroke-line' : 'stroke-divider'}
              x1={LEFT}
              x2={RIGHT}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="fill-fg-muted text-[9px]"
              textAnchor="end"
              x={LEFT - 4}
              y={y(tick) + 3}
            >
              {format(tick)}
            </text>
          </g>
        ))}
        {xs.ticks.map((tick) => (
          <text
            className="fill-fg-muted text-[9px]"
            key={tick}
            textAnchor="middle"
            x={x(tick)}
            y={BOTTOM + 12}
          >
            {format(tick)}
          </text>
        ))}
        <text className="fill-fg-muted text-[9px]" x={LEFT} y={TOP - 6}>
          {data.yTitle}
        </text>
        <text
          className="fill-fg-muted text-[9px]"
          textAnchor="end"
          x={RIGHT}
          y={H - 2}
        >
          {data.xTitle}
        </text>
        {lines.map((line, index) => {
          const horizontal = line.axis === 'y';
          const at = horizontal ? y(line.value) : x(line.value);
          const nearRight = !horizontal && at > RIGHT - 60;
          return (
            <g key={index}>
              <line
                className="stroke-fg-muted"
                strokeDasharray="4 3"
                x1={horizontal ? LEFT : at}
                x2={horizontal ? RIGHT : at}
                y1={horizontal ? at : TOP}
                y2={horizontal ? at : BOTTOM}
              />
              {line.label ? (
                <text
                  className="fill-fg-secondary stroke-surface text-[9px]"
                  style={HALO}
                  textAnchor={horizontal || nearRight ? 'end' : 'start'}
                  x={horizontal ? RIGHT - 2 : at + (nearRight ? -3 : 3)}
                  y={horizontal ? at - 3 : TOP + 8}
                >
                  {line.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {series.map((s, index) =>
          data.kind === 'scatter' ? (
            <g key={index}>
              {s.points.map(([px, py], i) => (
                <circle
                  className="stroke-surface"
                  cx={x(px)}
                  cy={y(py)}
                  fill={color(index)}
                  key={i}
                  r={4}
                  strokeWidth={2}
                >
                  <title>{`${s.name}: ${format(px)}, ${format(py)}`}</title>
                </circle>
              ))}
            </g>
          ) : (
            <polyline
              fill="none"
              key={index}
              points={s.points.map(([px, py]) => `${x(px)},${y(py)}`).join(' ')}
              stroke={color(index)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            >
              <title>{s.name}</title>
            </polyline>
          )
        )}
        {marks.map((mark, index) => {
          const px = x(mark.x);
          const py = y(mark.y);
          const flip = px > RIGHT - 70;
          return (
            <g key={index}>
              <circle
                className="fill-fg stroke-surface"
                cx={px}
                cy={py}
                r={3.5}
                strokeWidth={1.5}
              >
                <title>{`${mark.label}: ${format(mark.x)}, ${format(mark.y)}`}</title>
              </circle>
              <text
                className="fill-fg stroke-surface text-[9px]"
                style={HALO}
                textAnchor={flip ? 'end' : 'start'}
                x={px + (flip ? -6 : 6)}
                y={py < TOP + 10 ? py + 12 : py - 6}
              >
                {mark.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}
