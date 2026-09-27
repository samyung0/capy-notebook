import { createContext, useContext } from 'react';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { m } from '@/i18n';
import { chartKey, validChartData, validScatterData } from '../answer';
import type {
  ChartProps,
  PointProps,
  ScatterProps,
  SeriesProps,
} from '../schema';
import { CiteFooter, elements } from './Cite';

/**
 * SVG charts drawn from the model's numbers, themed through --chart-1..6.
 * Marks follow the data-viz rules: thin bars with rounded ends and a surface
 * gap, 2px lines with ringed markers, a legend whenever there are two or more
 * series, a native tooltip per mark, and the values as a table for inspection.
 */

const W = 320;
const H = 190;
const COLORS = 6;

export const InvalidChartContext = createContext<ReadonlySet<string>>(
  new Set()
);

const color = (index: number) => `var(--chart-${(index % COLORS) + 1})`;

const format = (value: number) =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Four clean ticks spanning [lo, hi], always including zero. */
function scale(values: number[]) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * power).find((k) => k >= raw) ?? raw;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step || step;
  if (
    !(Number.isFinite(step) && Number.isFinite(max) && Number.isFinite(min))
  ) {
    return { max: 1, min: 0, ticks: [0, 1] };
  }
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) ticks.push(tick);
  return { max, min, ticks };
}

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-secondary">
      {names.map((name, index) => (
        <span
          className="inline-flex items-center gap-1"
          key={`${index}-${name}`}
        >
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: color(index) }}
          />
          {name}
        </span>
      ))}
    </div>
  );
}

function Values({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer text-fg-muted">
        {m.chat_chart_values()}
      </summary>
      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                className="border-divider border-b px-1 py-0.5 text-left font-semibold"
                key={index}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td
                  className="px-1 py-0.5 tabular-nums first:font-semibold"
                  key={cellIndex}
                >
                  {typeof cell === 'number' ? format(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Frame({
  title,
  unit,
  illustrative,
  passages,
  legend,
  values,
  children,
}: {
  title: string;
  unit?: string;
  illustrative?: boolean;
  passages?: number[];
  legend: string[];
  values: { columns: string[]; rows: (string | number)[][] };
  children?: React.ReactNode;
}) {
  return (
    <figure className="my-3 rounded-card border border-line px-3 py-2.5">
      <figcaption className="mb-1.5">
        <p className="font-semibold text-xs">{title}</p>
        {unit ? <p className="text-[11px] text-fg-muted">{unit}</p> : null}
      </figcaption>
      {children}
      <Legend names={legend} />
      <Values columns={values.columns} rows={values.rows} />
      <CiteFooter
        note={
          illustrative
            ? m.chat_chart_illustrative()
            : passages?.length
              ? undefined
              : m.chat_chart_unsourced()
        }
        passages={passages}
      />
    </figure>
  );
}

function Axes({
  ticks,
  y,
  left,
  right,
}: {
  ticks: number[];
  y: (value: number) => number;
  left: number;
  right: number;
}) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            className={tick === 0 ? 'stroke-line' : 'stroke-divider'}
            x1={left}
            x2={right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            className="fill-fg-muted text-[9px]"
            textAnchor="end"
            x={left - 4}
            y={y(tick) + 3}
          >
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

export function Chart({
  props,
  statementId,
}: {
  props: ChartProps;
  statementId?: string;
}) {
  const invalid = useContext(InvalidChartContext);
  if (invalid.has(chartKey(props, statementId)) || !validChartData(props))
    return null;
  return (
    <CategoryChart
      authored={false}
      data={{
        ...props,
        labels: props.labels ?? [],
        series: elements<SeriesProps>(props.series).map((node) => ({
          name: node.props.name,
          values: node.props.values,
        })),
      }}
      frame={Frame}
    />
  );
}

export function ScatterChart({
  props,
  statementId,
}: {
  props: ScatterProps;
  statementId?: string;
}) {
  const invalid = useContext(InvalidChartContext);
  if (invalid.has(chartKey(props, statementId)) || !validScatterData(props))
    return null;
  const points = elements<PointProps>(props.points).map((node) => ({
    label: node.props.label,
    x: node.props.x,
    y: node.props.y,
  }));
  const left = 40;
  const right = W - 12;
  const top = 8;
  const bottom = H - 26;
  const xs = scale(points.map((p) => p.x));
  const ys = scale(points.map((p) => p.y));
  const x = (value: number) =>
    left + ((value - xs.min) / (xs.max - xs.min)) * (right - left);
  const y = (value: number) =>
    bottom - ((value - ys.min) / (ys.max - ys.min)) * (bottom - top);
  return (
    <Frame
      illustrative={props.illustrative}
      legend={[]}
      passages={props.passages}
      title={props.title}
      unit={props.unit}
      values={{
        columns: ['', props.xLabel, props.yLabel],
        rows: points.map((p, index) => [
          p.label ?? String(index + 1),
          p.x,
          p.y,
        ]),
      }}
    >
      <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
        <Axes left={left} right={right} ticks={ys.ticks} y={y} />
        {xs.ticks.map((tick) => (
          <text
            className="fill-fg-muted text-[9px]"
            key={tick}
            textAnchor="middle"
            x={x(tick)}
            y={bottom + 12}
          >
            {format(tick)}
          </text>
        ))}
        <text
          className="fill-fg-muted text-[9px]"
          textAnchor="end"
          x={right}
          y={H - 2}
        >
          {props.xLabel}
        </text>
        <text className="fill-fg-muted text-[9px]" x={left} y={top - 1}>
          {props.yLabel}
        </text>
        {points.map((p, index) => (
          <circle
            className="stroke-surface"
            cx={x(p.x)}
            cy={y(p.y)}
            fill={color(0)}
            key={index}
            r={4}
            strokeWidth={2}
          >
            <title>{`${p.label ? `${p.label}: ` : ''}${format(p.x)}, ${format(p.y)}`}</title>
          </circle>
        ))}
      </svg>
    </Frame>
  );
}
